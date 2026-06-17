// strategy.js — SuiPump strategy "brain".
//
// Runs as a SECOND process inside the agent-runner service (started by start.sh
// alongside server.js). server.js stays byte-for-byte unchanged. This process
// holds NO wallet secret: it watches prices and decides; server.js signs.
//
// Pipeline:
//   indexer SSE /stream  ->  WAKE-UP only ("a trade happened on curve X")
//     ->  read curve's CURRENT reserve on-chain  ->  authoritative price
//       ->  evaluate orders (stop-loss + generic take-profit ladder)
//         ->  resolve sell amount from the invoker wallet's on-chain balance
//           ->  POST localhost /run-dag { workflow:"sell", ... }
//
// ORDER SOURCE (durable): the indexer's /orders store. The brain loads active
// orders on boot, refreshes them periodically (picks up new / cancelled ones),
// and PATCHes fired-rung / done state back so a restart resumes mid-ladder.
// Writes carry x-strategy-key when STRATEGY_API_KEY is set.
//
// Why price comes from on-chain, not the SSE event:
//   The indexer re-emits historical events on backfill/reconnect, so an event's
//   own reserve can be stale. The event is only a signal to re-check; the price
//   is always read live from the curve object.
//
// No npm dependencies: node builtins + global fetch only (Node 18+).

// ── Config (all env-overridable) ──────────────────────────────────────────────
const PORT              = parseInt(process.env.PORT ?? '3040', 10);
const RUNNER_URL        = process.env.RUNNER_URL      ?? `http://127.0.0.1:${PORT}`;
const BRIDGE_URL        = process.env.SUIPUMP_BRIDGE_URL ?? 'https://suipump-bridge.onrender.com';
const INDEXER_URL       = process.env.INDEXER_URL     ?? 'https://suipump-62s2.onrender.com';
const SUI_GRAPHQL_URL   = process.env.SUI_GRAPHQL_URL ?? 'https://graphql.testnet.sui.io/graphql';
const INVOKER_ADDRESS   = process.env.INVOKER_ADDRESS ?? '0x877af0fae3fa4f8ea936943b59bcd66104f67cf1895302e97761a28b3c3a5906';
const STRATEGY_API_KEY  = process.env.STRATEGY_API_KEY ?? '';
// Shared secret for the gated bridge/runner write endpoints. The brain calls
// bridge /sell and runner /run-dag server-to-server for autonomous fires, so it
// must present this header or those endpoints now 401. Lives in the brain's env
// only (same value as the bridge's and runner's AGENT_API_KEY).
const AGENT_API_KEY     = process.env.AGENT_API_KEY ?? '';
const ORDERS_REFRESH_MS = parseInt(process.env.STRATEGY_ORDERS_REFRESH_MS ?? '15000', 10);
const RECONNECT_MS      = parseInt(process.env.STRATEGY_RECONNECT_MS ?? '3000', 10);
const ERROR_COOLDOWN_MS = parseInt(process.env.STRATEGY_ERROR_COOLDOWN_MS ?? '60000', 10);
const DUST_WHOLE        = Number(process.env.STRATEGY_DUST_WHOLE ?? '0.000001');

const MIST_PER_SUI   = 1_000_000_000;
const TOKEN_DECIMALS = 6;
const VTOK           = 1_073_000_000; // virtual token reserve — same all versions

// ── Logging ───────────────────────────────────────────────────────────────────
const log = (...a) => console.log(`[brain]`, ...a);
const err = (...a) => console.error(`[brain]`, ...a);

process.on('unhandledRejection', (e) => err('unhandledRejection:', e?.message ?? e));
process.on('uncaughtException',  (e) => err('uncaughtException:',  e?.message ?? e));

// ── Per-package virtual SUI — ported from indexer/api.js getVirtuals ──────────
function getVSui(packageId) {
  if (!packageId) return 3500;
  if (packageId.startsWith('0x2154')) return 30000; // V4
  if (packageId.startsWith('0x785c')) return 10000; // V5
  if (packageId.startsWith('0x21d5')) return 10000; // V6
  if (packageId.startsWith('0xfb8f')) return 5000;  // V7
  if (packageId.startsWith('0x7196')) return 4369;  // V9
  return 3500;                                       // V8 / V8_1
}

// Spot price in SUI per whole token — constant-product, matches api.js + TokenPage.
function priceFromReserve(vSui, reserveMist) {
  const realSui = Number(reserveMist ?? 0) / MIST_PER_SUI;
  const k = vSui * VTOK;
  return k > 0 ? ((vSui + realSui) * (vSui + realSui)) / k : 0;
}

// ── Order state (keyed by id) ─────────────────────────────────────────────────
const ORDERS = new Map();

function normalizeRemote(R) {
  if (!R.curveId) throw new Error('missing curveId');
  const tp = (Array.isArray(R.takeProfit) ? R.takeProfit : []).map(r => ({
    multiple: r.multiple != null ? Number(r.multiple) : null,
    priceSui: r.priceSui != null ? Number(r.priceSui) : null,
    sellPct:  Number(r.sellPct ?? 100),
    _fired:   r.fired === true,
  })).sort((a, b) => (a.multiple ?? a.priceSui ?? Infinity) - (b.multiple ?? b.priceSui ?? Infinity));
  let sl = null;
  if (R.stopLoss && (R.stopLoss.multiple != null || R.stopLoss.priceSui != null)) {
    sl = {
      multiple: R.stopLoss.multiple != null ? Number(R.stopLoss.multiple) : null,
      priceSui: R.stopLoss.priceSui != null ? Number(R.stopLoss.priceSui) : null,
    };
  }
  if (!tp.length && !sl) throw new Error('no takeProfit rung or stopLoss');
  return {
    id: R.id,
    curveId: R.curveId,
    tokenType: R.tokenType ?? null,
    packageId: null,
    entryPriceSui: R.entryPriceSui != null ? Number(R.entryPriceSui) : null,
    minSuiOut: Number(R.minSuiOut ?? 0),
    takeProfit: tp,
    stopLoss: sl,
    lastPrice: null,
    done: false,
    _cooldownUntil: 0,
  };
}

// ── Indexer order-store client ────────────────────────────────────────────────
async function fetchActiveOrders() {
  const r = await fetch(`${INDEXER_URL}/orders?status=active`, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`orders ${r.status}`);
  return await r.json();
}

async function persistOrder(order) {
  const body = {
    entryPriceSui: order.entryPriceSui,
    takeProfit: order.takeProfit.map(r => ({ multiple: r.multiple, priceSui: r.priceSui, sellPct: r.sellPct, fired: r._fired })),
    status: order.done ? 'done' : 'active',
  };
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (STRATEGY_API_KEY) headers['x-strategy-key'] = STRATEGY_API_KEY;
    const r = await fetch(`${INDEXER_URL}/orders/${order.id}`, {
      method: 'PATCH', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) { const d = await r.json().catch(() => ({})); err(`${order.id}: persist ${r.status} ${d.error ?? ''}`); }
  } catch (e) { err(`${order.id}: persist error ${e.message}`); }
}

// persistParams — PATCH back the params object (and status) for the param-driven
// strategies (sniper, dca, …) so counters like sniper's `fired` survive a brain
// restart. persistOrder above only carries tpsl ladder state; this is its
// params analog. The indexer PATCH route accepts { params, status }.
async function persistParams(order) {
  const body = {
    params: (order.params && typeof order.params === 'object') ? order.params : {},
    status: order.done ? 'done' : 'active',
  };
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (STRATEGY_API_KEY) headers['x-strategy-key'] = STRATEGY_API_KEY;
    const r = await fetch(`${INDEXER_URL}/orders/${order.id}`, {
      method: 'PATCH', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) { const d = await r.json().catch(() => ({})); err(`${order.id}: persistParams ${r.status} ${d.error ?? ''}`); }
  } catch (e) { err(`${order.id}: persistParams error ${e.message}`); }
}

// recordFire — stamp the most recent on-chain fire (Nexus task/execution + the
// bridge settle digest) onto the order so the agent page can surface live proof
// of execution per strategy. Stored under params._lastFire (the PATCH route
// keeps params raw, so it survives). curveId lets the UI link the right curve.
async function recordFire(order, fire) {
  if (!order.params || typeof order.params !== 'object') order.params = {};
  order.params._lastFire = {
    at:          Date.now(),
    kind:        fire.kind ?? null,        // 'buy' | 'sell'
    curveId:     fire.curveId ?? null,
    nexusTask:   fire.nexusTask ?? null,   // scheduler task id
    nexusExec:   fire.nexusExec ?? null,   // DAG execution id (sells)
    nexusDigest: fire.nexusDigest ?? null, // on-chain Nexus emit digest
    settle:      fire.settle ?? null,      // bridge settle digest (the money path)
  };
  await persistParams(order);
}

// notifyBell — push a TP/SL fire to the indexer notification store so it surfaces
// in the user's notification bell as "TP triggered" / "SL triggered". Best-effort:
// a failed notify must never affect the trade. The trigger reason ('TP'|'SL') is
// only known here (the on-chain sell event can't distinguish them), which is why
// this is posted from the runner, not derived from chain.
async function notifyBell(payload) {
  try {
    await fetch(`${INDEXER_URL}/notify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ wallet: INVOKER_ADDRESS, ...payload }),
      signal: AbortSignal.timeout(6000),
    });
  } catch (e) { err(`notifyBell failed: ${e.message}`); }
}
// optionally arm a CHILD strategy on that curve, seeded at the real post-buy
// price. This is the generalized `then` composition: a parent buy chains into
// a child order the engine then tracks independently.
//
// The `then` block is shaped { <childType>: <spec> }. Today the only meaningful
// child for a buy-strategy is `tpsl` (an auto-exit on the position just bought),
// so that is what is implemented. The dispatch is structured so additional child
// types can be added without touching any caller. Returns the child id or null.
async function spawnChild(parentId, curveId, tokenType, entryPrice, then) {
  if (!then || typeof then !== 'object') return null;

  // ---- child: tpsl (auto take-profit / stop-loss on the bought position) ----
  if (then.tpsl) {
    const t = then.tpsl;
    const tp = Array.isArray(t.takeProfit) ? t.takeProfit : [];
    const sl = t.stopLoss ?? null;
    if (!tp.length && !sl) return null;   // nothing to arm

    const childId = `${parentId}_tp_${curveId.slice(2, 10)}`;
    const body = {
      id:            childId,
      curveId,
      tokenType,
      type:          'tpsl',
      entryPriceSui: (entryPrice != null && Number.isFinite(entryPrice) && entryPrice > 0) ? entryPrice : null,
      takeProfit:    tp,
      stopLoss:      sl,
    };
    try {
      const headers = { 'Content-Type': 'application/json' };
      if (STRATEGY_API_KEY) headers['x-strategy-key'] = STRATEGY_API_KEY;
      const r = await fetch(`${INDEXER_URL}/orders`, {
        method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(8000),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { err(`${parentId}: spawn child tpsl ${r.status} ${d.error ?? ''}`); return null; }
      return d.id ?? childId;
    } catch (e) { err(`${parentId}: spawn child tpsl error ${e.message}`); return null; }
  }

  // (future child types — e.g. then.dca — slot in here with the same contract)
  return null;
}

// armThen — shared helper: after a buy-strategy settles a buy on `curveId`, read
// the REAL post-buy price and arm whatever the parent's `then` block specifies.
// Used by sniper, dca, and copytrade so chaining is identical across all three.
async function armThen(parentId, curveId, then) {
  if (!then || typeof then !== 'object') return null;
  let entryPrice = null, childTokenType = null;
  try {
    const st = await getCurveState(curveId);
    childTokenType = st.tokenType ?? null;
    entryPrice = priceFromReserve(getVSui(st.packageId), st.reserveMist);
  } catch (e) {
    err(`${parentId}: could not read post-buy price for child (${e.message}); arming on observe`);
  }
  const childId = await spawnChild(parentId, curveId, childTokenType, entryPrice, then);
  if (childId) {
    log(`${parentId}: armed child ${childId} on ${curveId.slice(0, 10)}… entry=${entryPrice != null ? entryPrice.toExponential(3) : 'observe'} SUI`);
  }
  return childId;
}

// armThenAt — like armThen, but uses a SUPPLIED entry price and tokenType rather
// than reading the curve fresh. DCA uses this to arm the child (e.g. TP/SL) on
// the blended AVERAGE cost across all fills, so profit/loss is measured against
// what was actually paid — not a single fill or a fresh spot read.
async function armThenAt(parentId, curveId, tokenType, entryPrice, then) {
  if (!then || typeof then !== 'object') return null;
  const childId = await spawnChild(parentId, curveId, tokenType, entryPrice, then);
  if (childId) {
    log(`${parentId}: armed child ${childId} on ${curveId.slice(0, 10)}… entry(avg)=${entryPrice != null ? entryPrice.toExponential(3) : 'observe'} SUI`);
  }
  return childId;
}

async function syncOrders() {
  let remote;
  try { remote = await fetchActiveOrders(); }
  catch (e) { err('order sync failed:', e.message); return; }

  const seen = new Set();
  for (const R of remote) {
    seen.add(R.id);
    if (ORDERS.has(R.id)) continue; // keep live in-memory progress for tracked orders
    try {
      const type = HANDLERS[R.type] ? R.type : 'tpsl';
      const h = HANDLERS[type];
      const o = h.normalize(R);
      o.type = type;
      ORDERS.set(o.id, o);
      log(`loaded ${h.label} order ${h.summarize(o)}`);
      if (type === 'tpsl') schedule(o); // evaluate immediately (catches already-crossed targets)
    } catch (e) { err(`order ${R.id} skipped: ${e.message}`); }
  }
  for (const id of [...ORDERS.keys()]) {
    if (!seen.has(id)) { ORDERS.delete(id); firing.delete(id); log(`order ${id} removed (cancelled or completed)`); }
  }
}

// ── Serialized execution queue (one nexus sell at a time, globally) ───────────
const queue = [];
let running = false;
const firing = new Set();

function pump() {
  if (running) return;
  const job = queue.shift();
  if (!job) return;
  running = true;
  Promise.resolve().then(job)
    .catch((e) => err('job error:', e?.message ?? e))
    .finally(() => { running = false; pump(); });
}

function schedule(order, trigger) {
  if (order.done) return;
  if (firing.has(order.id)) return;
  // The order-wide cooldown gate suits single-curve strategies (tpsl/sniper/dca).
  // Wallet-followers (copytrade) legitimately fire on every target trade across
  // buys, sells, and multiple curves, so a single order-wide cooldown would let a
  // buy suppress a following sell. Those manage their own per-side/curve dedup
  // inside the handler, so skip the order-wide gate for them.
  const isWalletTrade = trigger?.kind === 'walletTrade';
  if (!isWalletTrade && Date.now() < (order._cooldownUntil ?? 0)) return;
  const h = HANDLERS[order.type] ?? HANDLERS.tpsl;
  firing.add(order.id);
  queue.push(async () => { try { await h.process(order, trigger); } finally { firing.delete(order.id); } });
  pump();
}

// ── On-chain reads (GraphQL, read-only, no key) ───────────────────────────────
async function gql(query, variables) {
  const r = await fetch(SUI_GRAPHQL_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) throw new Error(`graphql ${r.status}`);
  const d = await r.json();
  if (d.errors?.length) throw new Error(`graphql: ${d.errors[0].message}`);
  return d.data;
}

// Current curve state: package, tokenType, live reserve, graduated.
// Type repr: 0xPKG::bonding_curve::Curve<0xTPKG::module::TYPE>
async function getCurveState(curveId) {
  const data = await gql(
    `query($id: SuiAddress!) { object(address: $id) { asMoveObject { contents { type { repr } json } } } }`,
    { id: curveId },
  );
  const mo = data?.object?.asMoveObject?.contents;
  if (!mo) throw new Error('curve object not found');
  const repr = mo.type?.repr ?? '';
  const json = mo.json ?? {};
  const packageId = repr.split('::')[0] || null;
  const tm = repr.match(/Curve<(.+)>/);
  const tokenType = tm ? tm[1] : null;
  const reserveMist = Number(json.sui_reserve ?? json.suiReserve ?? 0);
  const graduated = json.graduated === true || json.graduated === 'true';
  return { packageId, tokenType, reserveMist, graduated };
}

async function getBalanceWhole(tokenType, addr = INVOKER_ADDRESS) {
  const data = await gql(
    `query($addr: SuiAddress!, $coinType: String!) { address(address: $addr) { balance(coinType: $coinType) { totalBalance } } }`,
    { addr, coinType: tokenType },
  );
  const atomic = data?.address?.balance?.totalBalance ?? '0';
  return Number(BigInt(atomic)) / 10 ** TOKEN_DECIMALS;
}

// ── Fire a sell via the proven runner path (server.js signs) ──────────────────
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Sui rejects a tx that referenced an object version another tx just bumped
// ("unavailable for consumption" / "needs to be rebuilt"). Happens when the
// price-moving trade and our sell touch the same curve/coins back to back.
// A fresh /run-dag rebuilds against current versions, so retry this class.
const STALE_OBJECT_RE = /unavailable for consumption|needs to be rebuilt|rejected as invalid by more than|not available for consumption|equivocat/i;

async function fireSell(curveId, tokenWhole, minSuiOut, sellAll = false) {
  // SELL = two layers, mirroring how buy already settles on these surfaces:
  //   1. EMIT the Nexus DAG request (/run-dag) — produces a real on-chain
  //      DAGExecution digest (the agentic-decision proof). This NEVER blocks the
  //      sell: if it errors, we log and still settle. The leader does not execute
  //      it (no leader executes any walk — proven on-chain), so it is emission
  //      only, by design.
  //   2. SETTLE via the bridge /sell — the proven path that actually moves the
  //      tokens (same bridge every working trade on SuiPump uses; the Nexus sell
  //      tool itself calls this exact endpoint). The bridge resolves
  //      tokenType/version/coins and signs with its own SUI_PRIVATE_KEY, so we
  //      pass only curve + amount.
  // Returns { ok, txDigest (settlement), nexusDigest, nexusExecutionId, ... }.
  //
  // WHOLE-BALANCE SELLS use tokenAmount:"all" — the bridge's proven path that
  // merges ALL of the wallet's coin objects for this type and sells the lot.
  // A floored exact integer (e.g. 1214301) fails to simulate when the balance is
  // spread across multiple coin objects (bought in several buys): the PTB can't
  // cleanly split that exact amount. "all" sidesteps coin-selection entirely and
  // is what every working manual/agent sell this project has used. Partial sells
  // (sellPct < 100) still pass a specific integer amount.
  const tokenAmount = sellAll ? 'all' : Math.floor(tokenWhole);
  // The Nexus /run-dag emit validates sell.tokenAmount > 0 and rejects "all"
  // (only the bridge settle path resolves "all" to the on-chain balance). The
  // emit is the agentic-decision PROOF, not the money path, so we always send it
  // a positive integer derived from the known balance. The bridge settle below
  // still uses `tokenAmount` ("all" for whole sells) so coin-selection stays
  // robust across multiple coin objects.
  const emitTokenAmount = Math.max(1, Math.floor(tokenWhole));

  // ── 1. Emit the Nexus DAG request (non-blocking) ───────────────────────────
  let nexusDigest = null, nexusExecutionId = null;
  try {
    const rr = await fetch(`${RUNNER_URL}/run-dag`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(AGENT_API_KEY ? { 'x-agent-key': AGENT_API_KEY } : {}) },
      body: JSON.stringify({ workflow: 'sell', sell: { curveId, tokenAmount: emitTokenAmount, minSuiOut: minSuiOut ?? 0 } }),
      signal: AbortSignal.timeout(190000),
    });
    const rd = await rr.json().catch(() => ({}));
    if (rr.ok && rd.ok) {
      nexusDigest      = rd.digest ?? null;
      nexusExecutionId = rd.executionId ?? null;
      log(`sell: Nexus DAG emitted execution=${nexusExecutionId} digest=${nexusDigest}`);
    } else {
      err(`sell: Nexus DAG emit returned ${rd.error ?? rr.status} (continuing to settle)`);
    }
  } catch (e) {
    err(`sell: Nexus DAG emit failed: ${e.message} (continuing to settle)`);
  }

  // ── 2. Settle the swap via the bridge (the path that moves tokens) ─────────
  // Whole tokens; the bridge converts to base units itself. 3-try retry for the
  // stale-object class (same as the buy/sell coin-version races).
  const body = { curveId, tokenAmount, minSuiOut: minSuiOut ?? 0 };
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const r = await fetch(`${BRIDGE_URL}/sell`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(AGENT_API_KEY ? { 'x-agent-key': AGENT_API_KEY } : {}) },
        body: JSON.stringify(body), signal: AbortSignal.timeout(190000),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || d.ok === false) throw new Error(d.error ?? `bridge ${r.status}`);
      log(`sell: settled via bridge digest=${d.txDigest} sui=${d.suiReceived}`);
      return { ok: true, ...d, nexusDigest, nexusExecutionId };
    } catch (e) {
      lastErr = e;
      if (attempt < 3 && STALE_OBJECT_RE.test(e.message ?? '')) {
        const wait = 2000 * attempt;
        err(`sell settle attempt ${attempt} hit a stale object version; rebuilding in ${wait}ms`);
        await sleep(wait);
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

// ── Fire any workflow as a Nexus scheduler TASK (server.js /schedule-task) ─────
// The /schedule-task analog of fireSell: emits a real, persistent, on-chain
// Nexus scheduler Task + RequestScheduledOccurrence for the given workflow,
// returning { taskId, detail:{digest, schedule_digest, ...} }. Used by the
// event-driven strategies (sniper/copytrade = queue, dca = periodic) so every
// strategy decision produces real Nexus DAG tx ids the same proven way the sell
// task did. Same 3-try stale-object retry as fireSell.
//   workflow : 'buy' | 'sell' | 'claim' | ...
//   payload  : the workflow's body slice, e.g. { buy:{curveId, amountSui} }
//   schedule : optional { generator, startOffsetMs, deadlineOffsetMs,
//                         firstStartMs, periodMs, maxIterations }
async function fireScheduleTask(workflow, payload, schedule) {
  const body = { workflow, ...payload };
  if (schedule && typeof schedule === 'object') body.schedule = schedule;
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const r = await fetch(`${RUNNER_URL}/schedule-task`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(AGENT_API_KEY ? { 'x-agent-key': AGENT_API_KEY } : {}) },
        body: JSON.stringify(body), signal: AbortSignal.timeout(190000),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.ok) throw new Error(d.error ?? `runner ${r.status}`);
      return d;
    } catch (e) {
      lastErr = e;
      if (attempt < 3 && STALE_OBJECT_RE.test(e.message ?? '')) {
        const wait = 2000 * attempt;
        err(`${workflow} schedule attempt ${attempt} hit a stale object version; rebuilding in ${wait}ms`);
        await sleep(wait);
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

// ── Settle a BUY through the bridge (the path that actually moves tokens) ──────
// The scheduler task (fireScheduleTask above) emits the on-chain agentic-decision
// PROOF, but on testnet no Talus leader consumes the occurrence, so the task
// alone never moves tokens. This is the sniper analog of fireSell's settle leg:
// it calls the bridge /buy — the same endpoint the site's wallet buys use, which
// signs with the bridge's own key and executes the swap now. Returns the
// settlement txDigest. 3-try retry for the stale-object coin-version race, same
// as fireSell. The task emit stays best-effort PROOF; this is the money path and
// must NEVER be gated behind the emit.
async function fireBridgeBuy(curveId, amountSui) {
  const body = { curveId, suiAmount: amountSui };
  // A snipe fires seconds after launch; the fresh curve's object version / coin
  // state can still be settling, so the first simulate may fail transiently
  // ("Failed to simulate transaction") even though a manual buy moments later
  // works. Retry on BOTH the stale-object class AND generic simulate failures,
  // with growing backoff, so the snipe waits the curve out the way a human
  // clicking a few seconds later does. Non-transient errors (bad params, slippage
  // abort) still surface after the attempts are spent.
  const RETRYABLE = /unavailable for consumption|needs to be rebuilt|rejected as invalid|not available for consumption|equivocat|failed to simulate|simulate\/execute failed|object version|not found|could not be resolved/i;
  const MAX = 5;
  let lastErr;
  for (let attempt = 1; attempt <= MAX; attempt++) {
    try {
      const r = await fetch(`${BRIDGE_URL}/buy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(AGENT_API_KEY ? { 'x-agent-key': AGENT_API_KEY } : {}) },
        body: JSON.stringify(body), signal: AbortSignal.timeout(190000),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || d.ok === false) throw new Error(d.error ?? `bridge ${r.status}`);
      return d.txDigest ?? null;
    } catch (e) {
      lastErr = e;
      if (attempt < MAX && RETRYABLE.test(e.message ?? '')) {
        const wait = 2500 * attempt;   // 2.5s, 5s, 7.5s, 10s — rides out fresh-curve settle
        err(`buy settle attempt ${attempt}/${MAX} not ready (${String(e.message).slice(0, 80)}); retrying in ${wait}ms`);
        await sleep(wait);
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

// ── Order evaluation ──────────────────────────────────────────────────────────
const slPriceOf   = (order)    => { const s = order.stopLoss; return s ? (s.priceSui ?? order.entryPriceSui * s.multiple) : null; };
const rungPriceOf = (order, r) => r.priceSui ?? order.entryPriceSui * r.multiple;

function nextAction(order) {
  const price = order.lastPrice;
  if (price == null || order.entryPriceSui == null) return null;
  const sl = slPriceOf(order);
  if (sl != null && price <= sl) return { kind: 'SL', sellPct: 100, rung: null };
  for (const r of order.takeProfit) {
    if (r._fired) continue;
    if (price >= rungPriceOf(order, r)) return { kind: 'TP', sellPct: r.sellPct, rung: r };
  }
  return null;
}

async function processOrder(order) {
  if (order.done) return;

  let st;
  try { st = await getCurveState(order.curveId); }
  catch (e) { err(`${order.id}: curve read failed: ${e.message}`); order._cooldownUntil = Date.now() + ERROR_COOLDOWN_MS; return; }

  if (st.graduated) { log(`${order.id}: curve graduated — closing order`); order.done = true; await persistOrder(order); return; }
  if (!order.tokenType) order.tokenType = st.tokenType;
  if (!order.packageId) order.packageId = st.packageId;
  if (!order.tokenType) { err(`${order.id}: curve has no tokenType yet`); order._cooldownUntil = Date.now() + ERROR_COOLDOWN_MS; return; }

  const price = priceFromReserve(getVSui(st.packageId), st.reserveMist);
  if (!(price > 0)) { err(`${order.id}: non-positive price (reserve ${st.reserveMist})`); return; }

  if (order.entryPriceSui == null) {
    order.entryPriceSui = price;
    log(`${order.id}: entry not provided — seeding from current price ${price.toExponential(4)} SUI`);
    await persistOrder(order);
  }
  order.lastPrice = price;

  const mult  = order.entryPriceSui > 0 ? price / order.entryPriceSui : 1;
  const nr    = order.takeProfit.find(r => !r._fired);
  const nrTxt = nr ? `${nr.multiple != null ? nr.multiple + 'x' : nr.priceSui + ' SUI'} -> ${nr.sellPct}%` : (order.stopLoss ? 'stop-loss only' : 'none');
  log(`${order.id}: tick ${price.toExponential(3)} SUI (${mult.toFixed(3)}x) | reserve ${(st.reserveMist / MIST_PER_SUI).toFixed(2)} SUI | next ${nrTxt}`);

  if (!nextAction(order)) return;

  let balWhole;
  try { balWhole = await getBalanceWhole(order.tokenType); }
  catch (e) { err(`${order.id}: balance read failed: ${e.message}`); order._cooldownUntil = Date.now() + ERROR_COOLDOWN_MS; return; }

  while (!order.done) {
    const action = nextAction(order);
    if (!action) break;

    if (!(balWhole > DUST_WHOLE)) {
      log(`${order.id}: ${action.kind} crossed but balance is dust (${balWhole}); marking consumed`);
      // Dust = nothing left to sell, so the order is genuinely done regardless of
      // which leg crossed (no position remains for an SL to protect).
      if (action.kind === 'SL') order.done = true;
      else { action.rung._fired = true; if (order.takeProfit.every(r => r._fired)) order.done = true; }
      await persistOrder(order);
      continue;
    }

    const isWholeSell = action.sellPct >= 100;
    const sellWhole = isWholeSell ? balWhole : balWhole * (action.sellPct / 100);
    if (!(sellWhole > DUST_WHOLE)) { if (action.rung) action.rung._fired = true; await persistOrder(order); continue; }

    log(`${order.id}: ${action.kind} fire — (${mult.toFixed(3)}x) selling ${action.sellPct}% of ${balWhole.toFixed(6)} = ${isWholeSell ? 'ALL' : sellWhole.toFixed(6)} tokens`);
    const balBefore = balWhole;
    let receipt;
    try {
      receipt = await fireSell(order.curveId, sellWhole, order.minSuiOut, isWholeSell);
    } catch (e) {
      err(`${order.id}: sell failed: ${e.message}`);
      order._cooldownUntil = Date.now() + ERROR_COOLDOWN_MS;
      return; // leave trigger unfired; retry after cooldown
    }

    // A returned digest is NOT proof the sell executed: the runner hands one back
    // even when the sell vertex aborts on-chain. Confirm by re-reading the on-chain
    // balance and requiring it actually dropped by ~sellWhole. If it didn't move,
    // the trigger stays unfired and the order retries on the next wake.
    // Poll up to ~25s: the Leader executes the sell walk asynchronously with a
    // ~15s deadline, so the on-chain balance can take longer than a few seconds to
    // actually drop. Too short a window would false-negative a slow-but-real sell.
    let balAfter = balBefore, moved = 0, confirmed = false;
    for (let i = 1; i <= 10; i++) {
      await sleep(2500);
      try { balAfter = await getBalanceWhole(order.tokenType); }
      catch (e) { err(`${order.id}: post-sell balance read failed (try ${i}): ${e.message}`); continue; }
      moved = balBefore - balAfter;
      if (moved >= sellWhole * 0.9) { confirmed = true; break; }
    }
    if (!confirmed) {
      err(`${order.id}: SELL NOT CONFIRMED — bridge returned digest ${receipt.txDigest ?? '?'} but on-chain balance moved ${moved.toFixed(6)} of ${sellWhole.toFixed(6)} expected (${balBefore.toFixed(6)} -> ${balAfter.toFixed(6)}); order stays active, will retry`);
      order._cooldownUntil = Date.now() + ERROR_COOLDOWN_MS;
      return; // do NOT mark fired/done — the sell did not move tokens
    }

    log(`${order.id}: SOLD ${moved.toFixed(6)} tokens CONFIRMED on-chain — balance ${balBefore.toFixed(6)} -> ${balAfter.toFixed(6)} | settle ${receipt.txDigest ?? '?'} | nexus ${receipt.nexusDigest ?? 'not-emitted'}`);

    balWhole = balAfter; // trust the verified on-chain balance, not an assumption
    if (action.kind === 'SL') {
      order.done = true;                       // SL always closes the whole position
    } else {
      action.rung._fired = true;
      // A TP rung firing only COMPLETES the order if nothing is left to protect:
      // either all TP rungs are done AND there is no stop-loss still arming, OR the
      // remaining balance is dust (TP effectively sold everything). A partial TP
      // (e.g. sell 50% at +10%) with a live SL must keep the order ALIVE so the SL
      // continues protecting the held remainder against falling below the stop.
      const allTpFired = order.takeProfit.every(r => r._fired);
      const nothingLeft = !(balWhole > DUST_WHOLE);
      if (allTpFired && (!order.stopLoss || nothingLeft)) order.done = true;
    }
    await persistOrder(order); // persist immediately so a restart resumes correctly
    await recordFire(order, { kind: 'sell', curveId: order.curveId, nexusExec: receipt.nexusExecutionId ?? null, nexusDigest: receipt.nexusDigest ?? null, settle: receipt.txDigest ?? null });
    // Surface the fire in the notification bell, labelled by WHY it fired
    // (TP vs SL) — only known here. tokens = confirmed on-chain amount moved.
    await notifyBell({
      type:    'tpsl',
      trigger: action.kind,                 // 'TP' | 'SL'
      curveId: order.curveId,
      tokens:  moved,
      digest:  receipt.txDigest ?? null,
    });
    if (order.done) break;
  }

  if (order.done) log(`${order.id}: COMPLETE`);
}

// ── SSE wake-up (never prices from the event) ─────────────────────────────────
function handleEvent(ev) {
  if (!ev || ev.type === 'connected') return;
  const isTrade  = ev.type === 'TokensPurchased' || ev.type === 'TokensBought' || ev.type === 'TokensSold';
  const isLaunch = ev.type === 'CurveCreated';
  // DIAGNOSTIC: surface any event whose type mentions sell/sold/trade but did NOT
  // classify as a trade above — catches a sell event with an unexpected type tail.
  if (!isTrade && !isLaunch && /sold|sell|trade|purchas|bought/i.test(String(ev.type ?? ''))) {
    log(`[unmatched-ev] type=${ev.type} curve=${String(ev.curveId ?? '∅').slice(0, 10)}… keys=${Object.keys(ev.data ?? {}).join(',')}`);
  }

  if (isTrade && ev.curveId) {
    const side = ev.type === 'TokensSold' ? 'sell' : 'buy';
    const trader = side === 'sell'
      ? (ev.data?.seller ?? null)
      : (ev.data?.buyer ?? null);
    // DIAGNOSTIC: log every trade event the brain sees, so a non-matching sell is
    // visible on the wire (type tail + buyer/seller fields). Remove once resolved.
    log(`[trade-ev] type=${ev.type} side=${side} curve=${String(ev.curveId).slice(0, 10)}… buyer=${ev.data?.buyer ?? '∅'} seller=${ev.data?.seller ?? '∅'}`);
    for (const order of ORDERS.values()) {
      if (order.done) continue;
      const w = HANDLERS[order.type]?.wakesOn;
      // Curve-scoped trade strategies (tpsl): only their own curve.
      if (w === 'trade' && order.curveId === ev.curveId) {
        schedule(order, { kind: 'trade', ev });
      }
      // Wallet-following strategies (copytrade): any curve, but only when the
      // trade was made BY the target wallet. The SSE event forwards the full
      // Move event (data: parsedJson), so buyer/seller are available here.
      if (w === 'walletTrade') {
        const target = String(order.params?.targetWallet ?? '').toLowerCase();
        // Self-copy guard: the agent executes mirror trades from INVOKER_ADDRESS,
        // which themselves emit buyer/seller events. If the target IS the agent
        // wallet, mirroring its own trades would feed back into an infinite loop
        // that drains the wallet. Never mirror the agent's own execution wallet.
        if (target && target === INVOKER_ADDRESS.toLowerCase()) continue;
        if (target && trader && String(trader).toLowerCase() === target) {
          schedule(order, { kind: 'walletTrade', ev, side, trader });
        }
      }
    }
    return;
  }

  // New launches wake snipers. copytrade (wakesOn 'walletTrade') is routed in A4
  // once the trade event carries the trader address; until then it stays inert.
  if (isLaunch && ev.curveId) {
    for (const order of ORDERS.values()) {
      if (!order.done && HANDLERS[order.type]?.wakesOn === 'launch') {
        schedule(order, { kind: 'launch', ev });
      }
    }
  }
}

async function streamSSE() {
  const url = `${INDEXER_URL}/stream`;
  while (true) {
    try {
      log(`connecting SSE -> ${url}`);
      const res = await fetch(url, { headers: { Accept: 'text/event-stream' } });
      if (!res.ok || !res.body) throw new Error(`SSE status ${res.status}`);
      log('SSE connected');
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const dataLine = frame.split('\n').find(l => l.startsWith('data:'));
          if (!dataLine) continue;
          const payload = dataLine.slice(5).trim();
          if (!payload) continue;
          try { handleEvent(JSON.parse(payload)); } catch {}
        }
      }
      err('SSE stream ended; reconnecting');
    } catch (e) {
      err('SSE error:', e?.message ?? e);
    }
    await new Promise(r => setTimeout(r, RECONNECT_MS));
  }
}

// ── Boot ──────────────────────────────────────────────────────────────────────
function summarizeOrder(o) {
  const tp = o.takeProfit.map(r => `${r.multiple != null ? r.multiple + 'x' : r.priceSui + ' SUI'}->${r.sellPct}%`).join(', ');
  const sl = o.stopLoss ? (o.stopLoss.multiple != null ? `${o.stopLoss.multiple}x` : `${o.stopLoss.priceSui} SUI`) : 'none';
  return `${o.id} curve ${o.curveId.slice(0, 10)}… entry ${o.entryPriceSui ?? 'observe'} | TP [${tp}] | SL ${sl}`;
}

// ── Strategy handler registry (dispatch by order.type) ────────────────────────
// tpsl is the proven take-profit/stop-loss ladder, wired verbatim to the
// existing normalizeRemote / processOrder / summarizeOrder. sniper, dca, and
// copytrade are SCAFFOLDS for A2/A3/A4: the store accepts them and the brain
// loads + routes their triggers, but their process() is inert until each is
// built. A handler is { label, wakesOn, normalize, process, summarize }.
function scaffoldNormalize(R) {
  const params = (R.params && typeof R.params === 'object') ? R.params : {};
  return {
    id: R.id,
    curveId: R.curveId ?? null,
    tokenType: R.tokenType ?? null,
    params,
    done: false,
    _cooldownUntil: 0,
    _warned: false,
    // Restore the set of curves this order has already sniped so a restart does
    // not re-buy a launch it already bought (sniper idempotency across reboots).
    _sniped: new Set(Array.isArray(params.snipedCurves) ? params.snipedCurves : []),
  };
}

function makeScaffold(type, milestone, wakesOn) {
  return {
    label: type,
    wakesOn,
    normalize: scaffoldNormalize,
    summarize: (o) => `${o.id} ${type} ${JSON.stringify(o.params)}${o.curveId ? ' curve ' + o.curveId.slice(0, 10) + '…' : ''} — pending ${milestone}`,
    process: async (order) => {
      if (!order._warned) {
        log(`${order.id}: ${type} not yet implemented (${milestone}); order is inert until then`);
        order._warned = true;
      }
    },
  };
}

// Per-order cooldown so an event-driven strategy emits at most one task per
// window (otherwise every SSE wake on a busy curve would fire a new task).
const FIRE_COOLDOWN_MS = parseInt(process.env.STRATEGY_FIRE_COOLDOWN_MS ?? '30000', 10);
function onCooldown(order) {
  const now = Date.now();
  if ((order._cooldownUntil ?? 0) > now) return true;
  order._cooldownUntil = now + FIRE_COOLDOWN_MS;
  return false;
}
const num2 = (v, d) => { const n = Number(v); return Number.isFinite(n) ? n : d; };

const HANDLERS = {
  tpsl: {
    label: 'TP/SL',
    wakesOn: 'trade',                 // a trade on order.curveId
    normalize: normalizeRemote,       // existing, unchanged
    process: processOrder,            // existing, unchanged
    summarize: summarizeOrder,        // existing, unchanged
  },

  // SNIPER — wakes on a CurveCreated event. Emits a buy task on the freshly
  // launched curve (from the wake event), amount from order.params.amountSui.
  // Optional params.filter (substring) lets an order snipe only matching curves;
  // absent = snipe every launch. One task per launch (cooldown-guarded).
  sniper: {
    label: 'sniper',
    wakesOn: 'launch',
    normalize: scaffoldNormalize,
    summarize: (o) => {
      const p = o.params ?? {};
      const bits = [];
      if (Array.isArray(p.creators) && p.creators.length) bits.push(`creators[${p.creators.length}]`);
      if (Array.isArray(p.symbols)  && p.symbols.length)  bits.push(`symbols[${p.symbols.join(',')}]`);
      if (p.nameIncludes)                                  bits.push(`name~"${p.nameIncludes}"`);
      const scope = bits.length ? `${bits.join(` ${p.match === 'any' ? 'OR' : 'AND'} `)}` : 'EVERY launch';
      const cap   = p.maxSnipes > 0 ? ` cap ${num2(p.fired, 0)}/${p.maxSnipes}` : '';
      return `${o.id} sniper buy ${num2(p.amountSui, 0.1)} SUI on ${scope}${cap}`;
    },
    process: async (order, trigger) => {
      const ev = trigger?.ev;
      const curveId = ev?.curveId;
      if (!curveId) return;

      const p = order.params ?? {};

      // ── Idempotency: claim this curve SYNCHRONOUSLY before any await. The
      // indexer can emit the same CurveCreated over SSE more than once (gRPC
      // stream + GraphQL backfill overlap), and two wakes can enter process()
      // back-to-back before the in-flight lock releases. A sniper must buy a
      // given launch AT MOST ONCE, so we claim the curveId here, synchronously,
      // and any duplicate that arrives bails instantly. (Persisted snipes are
      // also seeded into this set on load via normalize, below.)
      if (!order._sniped) order._sniped = new Set();
      if (order._sniped.has(curveId)) return;   // already fired for this curve

      // Cap reached? (defensive — sync also closes it; this stops an in-flight wake)
      if (p.maxSnipes > 0 && num2(p.fired, 0) >= p.maxSnipes) {
        order.done = true; await persistParams(order); return;
      }

      // ── Filter against the launch event. The indexer's pg_notify payload puts
      // the raw Move event under ev.data, so creator/name/symbol live there.
      const d        = ev.data ?? {};
      const creator  = typeof d.creator === 'string' ? d.creator.toLowerCase() : null;
      const name     = typeof d.name    === 'string' ? d.name.toLowerCase()    : '';
      const symbol   = typeof d.symbol  === 'string' ? d.symbol.toUpperCase()  : '';

      const hasCreators = Array.isArray(p.creators) && p.creators.length > 0;
      const hasSymbols  = Array.isArray(p.symbols)  && p.symbols.length  > 0;
      const hasName     = typeof p.nameIncludes === 'string' && p.nameIncludes.length > 0;
      const hasFilter   = hasCreators || hasSymbols || hasName;

      if (hasFilter) {
        const creatorHit = hasCreators ? (creator != null && p.creators.includes(creator)) : null;
        const symbolHit  = hasSymbols  ? p.symbols.includes(symbol)                          : null;
        const nameHit    = hasName     ? name.includes(p.nameIncludes)                       : null;
        const hits = [creatorHit, symbolHit, nameHit].filter(v => v !== null);
        const pass = p.match === 'any' ? hits.some(Boolean) : hits.every(Boolean);
        if (!pass) return;
      } else if (p.all !== true) {
        // No filters and not explicitly all → never fire (store guards this too).
        return;
      }

      // Claim the curve NOW (passed the filter, committed to firing). Done before
      // the await so a concurrent duplicate sees it claimed and bails above.
      order._sniped.add(curveId);

      if (onCooldown(order)) return;
      const amountSui = num2(p.amountSui, 0.1);
      log(`${order.id}: SNIPE launch ${curveId.slice(0, 10)}… (${symbol || name || 'unknown'}) buy ${amountSui} SUI`);
      try {
        // 1) EMIT the Nexus scheduler task — the on-chain agentic-decision PROOF.
        //    Best-effort: a leader may not consume it on testnet, so this never
        //    blocks settlement. We keep the task id/digest for the demo trail.
        let taskId = null, emitDigest = null;
        try {
          const r = await fireScheduleTask('buy', { buy: { curveId, amountSui } }, { generator: 'queue' });
          taskId = r.taskId ?? null;
          emitDigest = r.detail?.digest ?? null;
          log(`${order.id}: sniper task ${taskId} (emit digest ${emitDigest ?? '?'})`);
        } catch (e) {
          err(`${order.id}: sniper emit failed: ${e.message} (continuing to settle)`);
        }

        // 2) SETTLE the buy through the bridge — the path that actually moves
        //    tokens. THIS is what makes the snipe real; the task above is proof.
        const settleDigest = await fireBridgeBuy(curveId, amountSui);
        log(`${order.id}: sniper settled buy digest=${settleDigest}`);

        // COMPOSE: if this sniper carries a `then` block, arm the child strategy
        // (e.g. TP/SL) on the curve we just bought, seeded at the REAL post-buy
        // price. Shared with dca/copytrade via armThen so chaining is identical.
        if (p.then) await armThen(order.id, curveId, p.then);

        // Count the fire (settlement succeeded) and persist.
        p.fired = num2(p.fired, 0) + 1;
        p.snipedCurves = Array.from(order._sniped);
        order.params = p;
        if (p.maxSnipes > 0 && p.fired >= p.maxSnipes) order.done = true;
        await persistParams(order);
        await recordFire(order, { kind: 'buy', curveId, nexusTask: taskId, settle: settleDigest });
        log(`${order.id}: SNIPE COMPLETE ${curveId.slice(0, 10)}… task=${taskId ?? 'n/a'} settle=${settleDigest} fired=${p.fired}${p.maxSnipes > 0 ? `/${p.maxSnipes}` : ''}${order.done ? ' — cap reached, closing' : ''}`);
      } catch (e) {
        // Settlement failed — release the claim so a genuine retry can re-attempt
        // this curve (no tokens moved, so it must not count as a snipe).
        order._sniped.delete(curveId);
        err(`${order.id}: sniper settle failed: ${e.message}`);
      }
    },
  },

  // DCA / scale-in — brain-driven accumulation. Two trigger modes:
  //   • time: buy `suiPerBuy` every `intervalMs`, up to `buys` times.
  //   • dip:  buy `suiPerBuy` each time price drops `dropPct`% (×rung) from the
  //           entry price, up to `buys` rungs.
  // Each fire emits a Nexus task (the agentic-decision proof) AND settles the buy
  // through the bridge (the path that moves tokens), exactly like sniper. Every
  // fill updates a running average cost (params.avgPriceSui), persisted so the
  // panel can show it and a `then.tpsl` can target the blended basis. After the
  // FINAL buy, arms the `then` child (e.g. TP/SL) via the shared armThen.
  //
  // Wakes on the timer tick; dip mode also re-checks price each tick (poll-based —
  // dip-buying is not latency-critical the way sniping is).
  // params: { curveId, suiPerBuy, buys, done, intervalMs?, dropPct?, mode?,
  //           entryPriceSui?, avgPriceSui?, filledSui?, lastFireMs?, then? }
  dca: {
    label: 'dca',
    wakesOn: 'timer',
    normalize: scaffoldNormalize,
    summarize: (o) => {
      const p = o.params || {};
      const mode = p.mode === 'dip' ? `every -${num2(p.dropPct, 10)}%` : `every ${Math.round(num2(p.intervalMs, 86400000) / 1000)}s`;
      return `${o.id} dca buy ${num2(p.suiPerBuy, 0.1)} SUI ${mode} · ${num2(p.done, 0)}/${num2(p.buys, 1)} on ${(o.curveId ?? p.curveId ?? '').slice(0, 10)}…`;
    },
    process: async (order) => {
      const p = order.params || {};
      const curveId = order.curveId ?? p.curveId;
      if (!curveId) { if (!order._warned) { err(`${order.id}: dca needs curveId`); order._warned = true; } return; }

      const suiPerBuy = num2(p.suiPerBuy, 0);
      const buys      = Math.trunc(num2(p.buys, 0));
      const done      = Math.trunc(num2(p.done, 0));
      if (!(suiPerBuy > 0) || !(buys > 0)) { if (!order._warned) { err(`${order.id}: dca bad params`); order._warned = true; } return; }
      if (done >= buys) { order.done = true; return; }
      // The first buy (rung 0) may use a distinct anchor size; rungs use suiPerBuy.
      const thisBuySui = (done === 0 && num2(p.anchorSui, 0) > 0) ? num2(p.anchorSui, 0) : suiPerBuy;

      const isDip = p.mode === 'dip' || (p.dropPct != null && p.intervalMs == null);
      const now = Date.now();

      // Read live price up front (needed for dip gating AND avg-cost recording).
      let price = null, pkgId = null, tokenType = order.tokenType ?? null, graduated = false;
      try {
        const st = await getCurveState(curveId);
        pkgId = st.packageId; tokenType = st.tokenType ?? tokenType; graduated = st.graduated;
        price = priceFromReserve(getVSui(pkgId), st.reserveMist);
      } catch (e) {
        err(`${order.id}: dca price read failed (${e.message}); skipping this tick`);
        return;
      }
      if (graduated) { log(`${order.id}: dca curve graduated — closing`); order.done = true; await persistParams(order); return; }

      // ── Trigger gating ────────────────────────────────────────────────────
      // Minimum spacing between ANY two fires on this order, so a rung can never
      // fire in the settle-shadow of the previous buy (which transiently moves
      // the reserve/price and previously let a dip rung fire with no real dip).
      const MIN_FIRE_GAP_MS = parseInt(process.env.STRATEGY_DCA_MIN_GAP_MS ?? '20000', 10);
      const sinceLast = now - num2(p.lastFireMs, 0);
      if (done > 0 && sinceLast < MIN_FIRE_GAP_MS) return;   // too soon after last fill

      if (isDip) {
        // Rung 0 establishes entry; rungs 1+ require price to have fallen
        // dropPct% × rung BELOW the locked entry. Entry must be locked (set on the
        // anchor's settled fill) — if it isn't yet, do not evaluate a dip.
        const dropPct = num2(p.dropPct, 10) / 100;
        if (done === 0) {
          // anchor fires immediately (no drop required)
        } else {
          const entry = num2(p.entryPriceSui, 0);
          if (!(entry > 0)) return;                          // entry not locked yet — wait
          const targetRungPrice = entry * (1 - dropPct * done); // -10%, -20%, … from entry
          if (!(price <= targetRungPrice)) return;           // not dropped enough yet
          log(`${order.id}: dip rung ${done} eligible — price ${price.toExponential(3)} <= target ${targetRungPrice.toExponential(3)} (entry ${entry.toExponential(3)})`);
        }
      } else {
        // time mode: require intervalMs since last fire (first fire is immediate)
        const intervalMs = num2(p.intervalMs, 86400000);
        if (done > 0 && sinceLast < intervalMs) return;
      }

      // ── Fire one buy: Nexus proof task + bridge settle ─────────────────────
      if (onCooldown(order)) return;   // guard against double-fire within a tick window
      let taskId = null;
      try {
        const d = await fireScheduleTask("buy", { buy: { curveId, amountSui: thisBuySui } }, { generator: 'queue' });
        taskId = d?.taskId ?? null;
      } catch (e) {
        err(`${order.id}: dca emit failed: ${e.message} (continuing to settle)`);
      }

      let settleDigest;
      try {
        settleDigest = await fireBridgeBuy(curveId, thisBuySui);
      } catch (e) {
        err(`${order.id}: dca settle failed: ${e.message}`);
        return; // do not count a fill that didn't settle
      }

      // DRY-BUY GUARD: a real second buy must have a NEW on-chain digest. If the
      // bridge returns the SAME digest as the previous fill (the known dry/
      // duplicate-execution failure mode), or no digest at all on a rung buy, the
      // buy did NOT actually move tokens — do not count it, do not advance the
      // rung, and back off so a genuine retry can happen on a later tick.
      if (settleDigest && settleDigest === p._lastSettleDigest) {
        err(`${order.id}: dca dry buy — settle digest ${settleDigest.slice(0, 10)}… matches previous fill; NOT counting (no tokens moved)`);
        p.lastFireMs = now;          // space out the retry
        order.params = p;
        await persistParams(order);
        return;
      }
      if (!settleDigest && done > 0) {
        err(`${order.id}: dca rung ${done} returned no digest; NOT counting (treating as non-fill)`);
        p.lastFireMs = now;
        order.params = p;
        await persistParams(order);
        return;
      }

      // ── Record fill + update running average cost ──────────────────────────
      const prevFilled = num2(p.filledSui, 0);
      const prevAvg    = num2(p.avgPriceSui, 0);
      const newFilled  = prevFilled + thisBuySui;
      // Weighted average of price across SUI deployed (approx: weight by SUI in).
      p.avgPriceSui   = (prevFilled > 0 && prevAvg > 0)
        ? (prevAvg * prevFilled + price * thisBuySui) / newFilled
        : price;
      p.filledSui     = newFilled;
      p._lastSettleDigest = settleDigest ?? p._lastSettleDigest ?? null;
      if (done === 0) p.entryPriceSui = num2(p.entryPriceSui, price); // lock entry on first fill
      p.lastFireMs    = now;
      p.done          = done + 1;
      order.params    = p;
      if (p.done >= buys) order.done = true;
      await persistParams(order);
      await recordFire(order, { kind: 'buy', curveId, nexusTask: taskId, settle: settleDigest });

      log(`${order.id}: DCA buy ${p.done}/${buys} ${thisBuySui} SUI @ ${price.toExponential(3)} (avg ${p.avgPriceSui.toExponential(3)}) task=${taskId ?? 'n/a'} settle=${settleDigest}${order.done ? ' — complete' : ''}`);

      // ── COMPOSE: after the FINAL buy, arm the `then` child on the blended
      //    basis. We pass the average cost as the entry so a then.tpsl targets
      //    profit/loss relative to what was actually paid across all fills.
      if (order.done && p.then) {
        await armThenAt(order.id, curveId, tokenType, p.avgPriceSui, p.then);
      }
    },
  },

  // COPY-TRADE — follows a TARGET WALLET across any curve. wakesOn 'walletTrade':
  // handleEvent only schedules this when the trade's buyer/seller IS the target.
  //   • target BUYS curve C  -> agent buys `suiPerTrade` SUI of C (Nexus + bridge).
  //   • target SELLS curve C -> agent sells the SAME FRACTION of its own C balance
  //     that the target just sold of theirs (proportional mirror).
  // Proportional sell math: fraction = sold / (sold + target's remaining balance),
  // read on-chain right after their sell. The agent then sells fraction × (agent's
  // own balance of C). Uses the proven fireBridgeBuy / fireSell settle paths.
  // params: { targetWallet, suiPerTrade }
  copytrade: {
    label: 'copytrade',
    wakesOn: 'walletTrade',
    normalize: scaffoldNormalize,
    summarize: (o) => {
      const p = o.params || {};
      return `${o.id} copytrade ${num2(p.suiPerTrade, 0.1)} SUI/buy mirroring ${String(p.targetWallet ?? '?').slice(0, 10)}…`;
    },
    process: async (order, trigger) => {
      const p = order.params || {};
      const target = String(p.targetWallet ?? '').toLowerCase();
      const side   = trigger?.side;
      const ev     = trigger?.ev;
      const curveId = ev?.curveId;
      if (!target || !curveId || !side) return;
      // Per-(side+curve) dedup: a target's buy and a following sell are distinct
      // actions and must BOTH mirror, and trades on different curves are distinct
      // too — so the cooldown is keyed by side+curve, NOT order-wide. This still
      // catches a genuine duplicate (same side+curve fired twice in quick
      // succession — the duplicate-event issue seen in logs) without letting a
      // buy suppress a sell.
      const COPY_DEDUP_MS = parseInt(process.env.STRATEGY_COPY_DEDUP_MS ?? '15000', 10);
      const dedupKey = `${side}:${curveId}`;
      order._copyFired = order._copyFired || {};
      const lastFired = order._copyFired[dedupKey] ?? 0;
      if (Date.now() - lastFired < COPY_DEDUP_MS) {
        log(`${order.id}: copytrade dedup — ${dedupKey.slice(0, 16)}… fired ${Date.now() - lastFired}ms ago, skipping duplicate`);
        return;
      }
      order._copyFired[dedupKey] = Date.now();

      // Resolve tokenType for this curve (needed for balance reads + sell).
      let tokenType = null;
      try {
        const st = await getCurveState(curveId);
        tokenType = st.tokenType ?? null;
        if (st.graduated) { log(`${order.id}: copytrade skip — ${curveId.slice(0, 10)}… graduated`); return; }
      } catch (e) {
        err(`${order.id}: copytrade curve read failed (${e.message})`); return;
      }

      if (side === 'buy') {
        // Mirror the target's BUY with a fixed-size agent buy.
        const suiPerTrade = num2(p.suiPerTrade, 0);
        if (!(suiPerTrade > 0)) { if (!order._warned) { err(`${order.id}: copytrade needs suiPerTrade`); order._warned = true; } return; }
        log(`${order.id}: COPYTRADE target BUY -> agent buy ${suiPerTrade} SUI on ${curveId.slice(0, 10)}…`);
        let taskId = null;
        try {
          const d = await fireScheduleTask('buy', { buy: { curveId, amountSui: suiPerTrade } }, { generator: 'queue' });
          taskId = d?.taskId ?? null;
        } catch (e) { err(`${order.id}: copytrade buy emit failed: ${e.message} (continuing to settle)`); }
        try {
          const settle = await fireBridgeBuy(curveId, suiPerTrade);
          log(`${order.id}: copytrade BUY settled ${suiPerTrade} SUI on ${curveId.slice(0, 10)}… task=${taskId ?? 'n/a'} settle=${settle}`);
          await recordFire(order, { kind: 'buy', curveId, nexusTask: taskId, settle });
        } catch (e) { err(`${order.id}: copytrade buy settle failed: ${e.message}`); }
        return;
      }

      // side === 'sell': proportional mirror.
      // 1) the fraction the TARGET sold = sold / (sold + their remaining balance).
      const soldWhole = num2(ev?.data?.tokens_in, 0) / 1e6; // tokens_in = tokens sold (atomic, 6 decimals)
      if (!(soldWhole > 0)) { log(`${order.id}: copytrade sell — target sold amount unknown, skipping`); return; }
      let targetRemaining = 0;
      try { targetRemaining = await getBalanceWhole(tokenType, target); }
      catch (e) { err(`${order.id}: copytrade target balance read failed (${e.message})`); }
      const fraction = soldWhole / (soldWhole + targetRemaining);
      if (!(fraction > 0)) { log(`${order.id}: copytrade sell — computed zero fraction, skipping`); return; }

      // 2) agent sells the same fraction of ITS OWN balance of this curve.
      let agentBal = 0;
      try { agentBal = await getBalanceWhole(tokenType, INVOKER_ADDRESS); }
      catch (e) { err(`${order.id}: copytrade agent balance read failed (${e.message})`); return; }
      if (!(agentBal > 0)) { log(`${order.id}: copytrade sell — agent holds none of ${curveId.slice(0, 10)}…, nothing to mirror`); return; }

      const sellWhole = agentBal * fraction;
      const sellAll = fraction >= 0.999; // target dumped ~everything -> agent sells all (robust coin-merge path)
      log(`${order.id}: COPYTRADE target SELL ${(fraction * 100).toFixed(1)}% -> agent sell ${sellAll ? 'ALL' : sellWhole.toFixed(4)} of ${agentBal.toFixed(4)} on ${curveId.slice(0, 10)}…`);
      try {
        const receipt = await fireSell(curveId, sellWhole, 0, sellAll);
        log(`${order.id}: copytrade SELL settled on ${curveId.slice(0, 10)}… settle=${receipt?.txDigest ?? '?'} nexus=${receipt?.nexusDigest ?? '?'}`);
        await recordFire(order, { kind: 'sell', curveId, nexusExec: receipt?.nexusExecutionId ?? null, nexusDigest: receipt?.nexusDigest ?? null, settle: receipt?.txDigest ?? null });
      } catch (e) { err(`${order.id}: copytrade sell settle failed: ${e.message}`); }
    },
  },
};

// DCA tick — wakes timer-driven orders. A3 will honor each order's interval; for
// now this only routes them to their (inert) handler.
const DCA_TICK_MS = parseInt(process.env.STRATEGY_DCA_TICK_MS ?? '30000', 10);
function dcaTick() {
  for (const order of ORDERS.values()) {
    if (!order.done && HANDLERS[order.type]?.wakesOn === 'timer') schedule(order, { kind: 'timer' });
  }
}

async function main() {
  console.log('━'.repeat(52));
  console.log('  SUIPUMP STRATEGY BRAIN (multi-strategy dispatcher)');
  console.log('━'.repeat(52));
  log(`runner   : ${RUNNER_URL}`);
  log(`indexer  : ${INDEXER_URL}`);
  log(`graphql  : ${SUI_GRAPHQL_URL}`);
  log(`invoker  : ${INVOKER_ADDRESS}`);
  log(`orders   : indexer /orders store (refresh ${ORDERS_REFRESH_MS}ms)${STRATEGY_API_KEY ? ' [keyed]' : ''}`);
  log(`price    : read live from curve object (SSE = wake-up only)`);
  log(`strategies: ${Object.keys(HANDLERS).map(k => `${k}(live)`).join(', ')}`);

  await syncOrders();
  log(`tracking : ${ORDERS.size} active order(s)`);
  setInterval(() => { syncOrders().catch(e => err('sync error:', e?.message ?? e)); }, ORDERS_REFRESH_MS);
  setInterval(dcaTick, DCA_TICK_MS);

  streamSSE();
}

main();
