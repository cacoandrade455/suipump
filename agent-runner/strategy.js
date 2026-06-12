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
const INDEXER_URL       = process.env.INDEXER_URL     ?? 'https://suipump-62s2.onrender.com';
const SUI_GRAPHQL_URL   = process.env.SUI_GRAPHQL_URL ?? 'https://graphql.testnet.sui.io/graphql';
const INVOKER_ADDRESS   = process.env.INVOKER_ADDRESS ?? '0x877af0fae3fa4f8ea936943b59bcd66104f67cf1895302e97761a28b3c3a5906';
const STRATEGY_API_KEY  = process.env.STRATEGY_API_KEY ?? '';
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
  if (packageId.startsWith('0x785c')) return  9000; // V5: contract VIRTUAL_SUI_RESERVE = 9_000
  if (packageId.startsWith('0x21d5')) return  9000; // V6: contract VIRTUAL_SUI_RESERVE = 9_000
  if (packageId.startsWith('0xfb8f')) return  3500; // V7: contract VIRTUAL_SUI_RESERVE = 3_500
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
  if (Date.now() < (order._cooldownUntil ?? 0)) return;
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

async function getBalanceWhole(tokenType) {
  const data = await gql(
    `query($addr: SuiAddress!, $coinType: String!) { address(address: $addr) { balance(coinType: $coinType) { totalBalance } } }`,
    { addr: INVOKER_ADDRESS, coinType: tokenType },
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

async function fireSell(curveId, tokenWhole, minSuiOut) {
  // tokenAmount MUST be a whole integer. The Nexus sell tool (xyz.suipump.sell@1)
  // parses this input as a u64; a fractional value like 17844905.728001 fails that
  // parse on the Leader, so the sell walk errors and never builds the on-chain sell
  // tx — the request tx still returns a digest, which is the "dry sell" we saw.
  // The buy tool takes whole SUI the same way, so whole tokens is the right unit.
  const body = { workflow: 'sell', sell: { curveId, tokenAmount: Math.floor(tokenWhole), minSuiOut: minSuiOut ?? 0 } };
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const r = await fetch(`${RUNNER_URL}/run-dag`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body), signal: AbortSignal.timeout(190000),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.ok) throw new Error(d.error ?? `runner ${r.status}`);
      return d;
    } catch (e) {
      lastErr = e;
      if (attempt < 3 && STALE_OBJECT_RE.test(e.message ?? '')) {
        const wait = 2000 * attempt;
        err(`sell attempt ${attempt} hit a stale object version; rebuilding in ${wait}ms`);
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
      if (action.kind === 'SL') order.done = true;
      else { action.rung._fired = true; if (order.takeProfit.every(r => r._fired)) order.done = true; }
      await persistOrder(order);
      continue;
    }

    const sellWhole = action.sellPct >= 100 ? balWhole : balWhole * (action.sellPct / 100);
    if (!(sellWhole > DUST_WHOLE)) { if (action.rung) action.rung._fired = true; await persistOrder(order); continue; }

    log(`${order.id}: ${action.kind} fire — (${mult.toFixed(3)}x) selling ${action.sellPct}% of ${balWhole.toFixed(6)} = ${sellWhole.toFixed(6)} tokens`);
    const balBefore = balWhole;
    let receipt;
    try {
      receipt = await fireSell(order.curveId, sellWhole, order.minSuiOut);
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
      err(`${order.id}: SELL NOT CONFIRMED — runner returned digest ${receipt.digest} but on-chain balance moved ${moved.toFixed(6)} of ${sellWhole.toFixed(6)} expected (${balBefore.toFixed(6)} -> ${balAfter.toFixed(6)}); order stays active, will retry`);
      order._cooldownUntil = Date.now() + ERROR_COOLDOWN_MS;
      return; // do NOT mark fired/done — the sell did not move tokens
    }

    log(`${order.id}: SOLD ${moved.toFixed(6)} tokens CONFIRMED on-chain — balance ${balBefore.toFixed(6)} -> ${balAfter.toFixed(6)} | digest ${receipt.digest} execId ${receipt.executionId}`);

    balWhole = balAfter; // trust the verified on-chain balance, not an assumption
    if (action.kind === 'SL') order.done = true;
    else { action.rung._fired = true; if (order.takeProfit.every(r => r._fired)) order.done = true; }
    await persistOrder(order); // persist immediately so a restart resumes correctly
    if (order.done) break;
  }

  if (order.done) log(`${order.id}: COMPLETE`);
}

// ── SSE wake-up (never prices from the event) ─────────────────────────────────
function handleEvent(ev) {
  if (!ev || ev.type === 'connected') return;
  const isTrade  = ev.type === 'TokensPurchased' || ev.type === 'TokensBought' || ev.type === 'TokensSold';
  const isLaunch = ev.type === 'CurveCreated';

  if (isTrade && ev.curveId) {
    for (const order of ORDERS.values()) {
      if (!order.done && HANDLERS[order.type]?.wakesOn === 'trade' && order.curveId === ev.curveId) {
        schedule(order, { kind: 'trade', ev });
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
  return {
    id: R.id,
    curveId: R.curveId ?? null,
    tokenType: R.tokenType ?? null,
    params: (R.params && typeof R.params === 'object') ? R.params : {},
    done: false,
    _cooldownUntil: 0,
    _warned: false,
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

const HANDLERS = {
  tpsl: {
    label: 'TP/SL',
    wakesOn: 'trade',                 // a trade on order.curveId
    normalize: normalizeRemote,       // existing, unchanged
    process: processOrder,            // existing, unchanged
    summarize: summarizeOrder,        // existing, unchanged
  },
  sniper:    makeScaffold('sniper',    'A2', 'launch'),       // a CurveCreated event
  dca:       makeScaffold('dca',       'A3', 'timer'),        // the DCA tick
  copytrade: makeScaffold('copytrade', 'A4', 'walletTrade'),  // a trade by target wallet
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
  log(`strategies: ${Object.keys(HANDLERS).map(k => k === 'tpsl' ? `${k}(live)` : `${k}(scaffold)`).join(', ')}`);

  await syncOrders();
  log(`tracking : ${ORDERS.size} active order(s)`);
  setInterval(() => { syncOrders().catch(e => err('sync error:', e?.message ?? e)); }, ORDERS_REFRESH_MS);
  setInterval(dcaTick, DCA_TICK_MS);

  streamSSE();
}

main();
