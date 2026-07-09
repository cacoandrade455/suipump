// strategy.js - SuiPump strategy "brain".
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

// -- Config (all env-overridable) ----------------------------------------------
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
// C2 DEMO MODE: when on, demo'd actions (buy/sell) are executed SOLELY through
// the Talus leader path - emit the Nexus walk with confirm:true, and if the
// leader settles it (EndState Ok/Empty, sender = a leader), skip the bridge
// settle so the leader is the one, provable executor. If the leader path does
// not confirm in time, we fall back to the bridge so a demo never hangs.
// Production (DEMO_MODE off) keeps the proven dual-path byte-for-byte.
const DEMO_MODE         = (process.env.DEMO_MODE ?? '') === '1';
const ORDERS_REFRESH_MS = parseInt(process.env.STRATEGY_ORDERS_REFRESH_MS ?? '15000', 10);
const RECONNECT_MS      = parseInt(process.env.STRATEGY_RECONNECT_MS ?? '3000', 10);
const ERROR_COOLDOWN_MS = parseInt(process.env.STRATEGY_ERROR_COOLDOWN_MS ?? '60000', 10);
const DUST_WHOLE        = Number(process.env.STRATEGY_DUST_WHOLE ?? '0.000001');

const MIST_PER_SUI   = 1_000_000_000;
const TOKEN_DECIMALS = 6;
const VTOK           = 1_073_000_000; // virtual token reserve - same all versions

// -- Logging -------------------------------------------------------------------
const log = (...a) => console.log(`[brain]`, ...a);
const err = (...a) => console.error(`[brain]`, ...a);

process.on('unhandledRejection', (e) => err('unhandledRejection:', e?.message ?? e));
process.on('uncaughtException',  (e) => err('uncaughtException:',  e?.message ?? e));

// -- Per-package virtual SUI - ported from indexer/api.js getVirtuals ----------
function getVSui(packageId) {
  if (!packageId) return 3500;
  if (packageId.startsWith('0x2154')) return 30000; // V4
  if (packageId.startsWith('0x785c')) return 9000;  // V5: contract VIRTUAL_SUI_RESERVE = 9_000
  if (packageId.startsWith('0x21d5')) return 9000;  // V6: contract VIRTUAL_SUI_RESERVE = 9_000
  if (packageId.startsWith('0xfb8f')) return 3500;  // V7: contract VIRTUAL_SUI_RESERVE = 3_500
  if (packageId.startsWith('0x7196')) return 4369;  // V9
  if (packageId.startsWith('0x2ded')) return 4369;  // V10: same shape as V9
  if (packageId.startsWith('0xc038')) return 4369;  // V11 (upgrade of V10 - defensive: curves type as V10)
  if (packageId.startsWith('0xf5a3')) return 4369;  // V12 (upgrade of V10 - defensive: curves type as V10)
  return 3500;                                       // V8 / V8_1
}

// Spot price in SUI per whole token - constant-product, matches api.js + TokenPage.
function priceFromReserve(vSui, reserveMist) {
  const realSui = Number(reserveMist ?? 0) / MIST_PER_SUI;
  const k = vSui * VTOK;
  return k > 0 ? ((vSui + realSui) * (vSui + realSui)) / k : 0;
}

// -- Order state (keyed by id) -------------------------------------------------
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
    // Owner attribution must SURVIVE normalization - recordFire/notifyBell
    // read order.wallet, and this rebuild is the only path orders take into
    // the brain (the third allowlist-drops-the-new-field bug of its kind).
    wallet: R.wallet ?? null,
    // params must SURVIVE too: the stored order carries sessionId (and _lastFire/
    // _lastError) in params, and the sell path reads order.params.sessionId to
    // route a session-bought position's exit through /session-sell (the SAME
    // session that custodies the parked tokens) instead of the shared agent
    // wallet. Dropping it here silently downgraded every session-bound tpsl to a
    // shared-wallet /sell that holds none of the parked tokens - the auto-armed
    // session exit (spawnChild sets sessionId at line ~307) never actually fired.
    params: (R.params && typeof R.params === 'object' && !Array.isArray(R.params)) ? R.params : {},
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

// -- Indexer order-store client ------------------------------------------------
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

// pruneParentEntered - when an AUTOPILOT TP/SL child fully closes (100% exit),
// remove its curve from the parent autopilot's `entered[]` so the panel stops
// showing a position that no longer exists. Child ids are `ord_<parent>_tp_<hex>`;
// we recover the parent id, GET it, drop this child's full curveId from
// params.entered, and PATCH the params back. Best-effort: a failure just leaves
// the (now-closed) position lingering in the list until the next prune - never
// throws, never blocks the sell flow.
async function pruneParentEntered(childOrder) {
  try {
    const m = typeof childOrder.id === 'string' && childOrder.id.match(/^(ord_\d+_[a-z0-9]+)_tp_[0-9a-f]+$/i);
    if (!m) return;                          // not an autopilot child
    const parentId = m[1];
    const curveId = childOrder.curveId;
    if (!curveId) return;

    // GET the parent order to read its current entered[]/spentSui.
    const gr = await fetch(`${INDEXER_URL}/orders/${parentId}`, { signal: AbortSignal.timeout(8000) });
    if (!gr.ok) return;                      // parent gone or store hiccup
    const parent = await gr.json().catch(() => null);
    if (!parent || parent.type !== 'autopilot') return;

    const params = parent.params || {};
    const entered = Array.isArray(params.entered) ? params.entered : [];
    if (!entered.includes(curveId)) return;  // already pruned

    const nextEntered = entered.filter((c) => c !== curveId);
    const nextParams = { ...params, entered: nextEntered };

    const headers = { 'Content-Type': 'application/json' };
    if (STRATEGY_API_KEY) headers['x-strategy-key'] = STRATEGY_API_KEY;
    const pr = await fetch(`${INDEXER_URL}/orders/${parentId}`, {
      method: 'PATCH', headers, body: JSON.stringify({ params: nextParams }), signal: AbortSignal.timeout(8000),
    });
    if (pr.ok) {
      log(`${childOrder.id}: position closed - pruned ${curveId.slice(0, 10)}\u2026 from autopilot ${parentId} entered[] (${nextEntered.length} open)`);
    } else {
      const d = await pr.json().catch(() => ({}));
      err(`${childOrder.id}: prune parent ${parentId} ${pr.status} ${d.error ?? ''}`);
    }
  } catch (e) { err(`${childOrder.id}: prune parent error ${e.message}`); }
}

// persistParams - PATCH back the params object (and status) for the param-driven
// strategies (sniper, dca, ...) so counters like sniper's `fired` survive a brain
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

// recordFire - stamp the most recent on-chain fire (Nexus task/execution + the
// bridge settle digest) onto the order so the agent page can surface live proof
// of execution per strategy. Stored under params._lastFire (the PATCH route
// keeps params raw, so it survives). curveId lets the UI link the right curve.
async function recordFire(order, fire) {
  if (!order.params || typeof order.params !== 'object') order.params = {};
  // A fire is leader-settled when the leader path returned the settlement (the
  // settle digest IS the leader's on-chain walk settlement, not a bridge tx).
  // The handler passes fire.leaderSettled + fire.leaderSender in that case.
  const leaderSettled = fire.leaderSettled === true;
  order.params._lastFire = {
    at:          Date.now(),
    kind:        fire.kind ?? null,        // 'buy' | 'sell'
    curveId:     fire.curveId ?? null,
    nexusTask:   fire.nexusTask ?? null,   // scheduler task id
    nexusExec:   fire.nexusExec ?? null,   // DAG execution id (sells)
    nexusDigest: fire.nexusDigest ?? null, // on-chain Nexus emit digest
    settle:      fire.settle ?? null,      // settlement digest (leader or bridge)
    settledVia:  fire.settle ? (leaderSettled ? 'leader' : 'bridge') : null,
    leaderSender: leaderSettled ? (fire.leaderSender ?? null) : null,
  };
  await persistParams(order);
  // Persist a row in the agent_actions history (autonomous fire). Best-effort:
  // a history-write failure must NEVER affect the fire or the order state.
  recordAgentAction({
    kind:                 fire.kind ?? order.type ?? 'buy',
    source:               'autonomous',
    curveId:              fire.curveId ?? order.curveId ?? null,
    tokenType:            order.tokenType ?? null,
    summary:              `${(fire.kind ?? order.type ?? 'fire')} via ${order.type ?? 'strategy'} (order ${order.id})`,
    executionId:          fire.nexusExec ?? null,
    nexusRequestDigest:   fire.nexusDigest ?? fire.nexusTask ?? null,
    settleDigest:         fire.settle ?? null,
    settledVia:           fire.settle ? (leaderSettled ? 'leader' : 'bridge') : null,
    leaderSender:         leaderSettled ? (fire.leaderSender ?? null) : null,
    status:               fire.settle ? 'settled' : 'pending',
    // Attribution: the USER who armed the strategy, not the runner. The
    // invoker is only the legacy fallback for orders armed before wallet
    // attribution existed (those rows are hidden by the per-user UI anyway).
    wallet:               order.wallet ?? INVOKER_ADDRESS,
  }).catch(() => {});
}

// classifyAbort - map a thrown fire error (bridge settle failure text) to a
// stable { code, reason } the UI can render on a strategy card. The agent_session
// abort codes are authoritative (see contracts-v10/sources/agent_session.move
// Errors block): 2 ESessionRevoked, 3 ESessionExpired, 4 ESpendCapExceeded,
// 5 EInsufficientEscrow, 11 EUniversalTradingDisabled. Match on the Move error
// NAME first (unambiguous), then the bare numeric code within an agent_session
// abort, mirroring bridge.js's `/(\b11\b|EUniversalTradingDisabled)/` approach.
// bridge.js already rewrites code 11 into a friendly sentence, so also match the
// legacy-token phrasing it emits. Anything unclassified returns a generic reason
// carrying a trimmed tail of the original message.
function classifyAbort(msg) {
  const text = String(msg ?? '');
  const inSession = /agent_session/.test(text);
  const has = (n) => new RegExp(`(^|\\D)${n}(\\D|$)`).test(text);
  if (/ESpendCapExceeded/.test(text) || (inSession && has(4))) {
    return { code: 4, reason: 'spend cap reached' };
  }
  if (/EInsufficientEscrow/.test(text) || (inSession && has(5))) {
    return { code: 5, reason: 'insufficient escrow' };
  }
  if (/EUniversalTradingDisabled/.test(text) || /legacy curve version/i.test(text)
      || (inSession && has(11))) {
    return { code: 11, reason: 'legacy token - universal trading not enabled' };
  }
  if (/ESessionRevoked/.test(text) || (inSession && has(2))) {
    return { code: 2, reason: 'session revoked' };
  }
  if (/ESessionExpired/.test(text) || (inSession && has(3))) {
    return { code: 3, reason: 'session expired' };
  }
  const tail = text.length > 80 ? `${text.slice(0, 77)}...` : text;
  return { code: null, reason: tail || 'fire failed' };
}

// recordError - stamp the reason a fire ABORTED onto the order so the agent page
// can surface it on the strategy card (the drained/capped-session silent-failure
// class: a DCA whose 2nd fire aborts on-chain used to vanish into a log line).
// Stored under params._lastError. Loud by design (console.warn - the mainnet
// "loud fallbacks" rule): a silent degradation must be visible in the runner
// log too, not only on the card.
//
// PARAMS-PRESERVING WRITE: the PATCH route REPLACES params wholesale, and the
// tpsl in-memory order (normalizeRemote) does NOT carry `params`, so calling
// persistParams on a tpsl order would blank its stored sessionId. We therefore
// GET the order's current stored params, merge _lastError, and PATCH just
// `{ params }` - the same read-merge-write pattern pruneParentEntered uses. Safe
// for every strategy type regardless of what the in-memory order holds.
async function recordError(order, kind, errMsg) {
  const { code, reason } = classifyAbort(errMsg);
  console.warn(`${order.id}: fire ABORTED (${kind}) - ${reason}${code != null ? ` [code ${code}]` : ''}: ${errMsg}`);
  try {
    const gr = await fetch(`${INDEXER_URL}/orders/${order.id}`, { signal: AbortSignal.timeout(8000) });
    if (!gr.ok) return;
    const cur = await gr.json().catch(() => null);
    const params = (cur && cur.params && typeof cur.params === 'object' && !Array.isArray(cur.params)) ? cur.params : {};
    const nextParams = { ...params, _lastError: { at: Date.now(), kind, reason, code } };
    const headers = { 'Content-Type': 'application/json' };
    if (STRATEGY_API_KEY) headers['x-strategy-key'] = STRATEGY_API_KEY;
    const pr = await fetch(`${INDEXER_URL}/orders/${order.id}`, {
      method: 'PATCH', headers, body: JSON.stringify({ params: nextParams }), signal: AbortSignal.timeout(8000),
    });
    if (!pr.ok) { const d = await pr.json().catch(() => ({})); err(`${order.id}: recordError ${pr.status} ${d.error ?? ''}`); }
    // Keep the in-memory copy consistent when the order carries params (dca/
    // copytrade/autopilot); harmless for tpsl (undefined -> object).
    if (order.params && typeof order.params === 'object') order.params._lastError = nextParams._lastError;
  } catch (e) { err(`${order.id}: recordError error ${e.message}`); }
}

// clearError - drop a stale _lastError after a SUCCESSFUL fire so a recovered
// order (escrow topped up, cap raised, session re-opened) stops showing an old
// abort. Same params-preserving read-merge-write as recordError. No-op when
// there is nothing stored to clear (avoids a needless PATCH every fire).
async function clearError(order) {
  try {
    const gr = await fetch(`${INDEXER_URL}/orders/${order.id}`, { signal: AbortSignal.timeout(8000) });
    if (!gr.ok) return;
    const cur = await gr.json().catch(() => null);
    const params = (cur && cur.params && typeof cur.params === 'object' && !Array.isArray(cur.params)) ? cur.params : {};
    if (!params._lastError) return; // nothing to clear
    const nextParams = { ...params };
    delete nextParams._lastError;
    const headers = { 'Content-Type': 'application/json' };
    if (STRATEGY_API_KEY) headers['x-strategy-key'] = STRATEGY_API_KEY;
    await fetch(`${INDEXER_URL}/orders/${order.id}`, {
      method: 'PATCH', headers, body: JSON.stringify({ params: nextParams }), signal: AbortSignal.timeout(8000),
    });
    if (order.params && typeof order.params === 'object') delete order.params._lastError;
  } catch (e) { err(`${order.id}: clearError error ${e.message}`); }
}

// recordAgentAction - POST a row to the indexer's agent_actions history. Used by
// recordFire (autonomous). Best-effort, never throws. Mirrors persistParams's
// key/guard handling (x-strategy-key when STRATEGY_API_KEY is set).
async function recordAgentAction(action) {
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (STRATEGY_API_KEY) headers['x-strategy-key'] = STRATEGY_API_KEY;
    await fetch(`${INDEXER_URL}/agent-actions`, {
      method: 'POST', headers, body: JSON.stringify(action), signal: AbortSignal.timeout(8000),
    });
  } catch (e) { err(`recordAgentAction error: ${e.message}`); }
}

// notifyBell - push a TP/SL fire to the indexer notification store so it surfaces
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
async function spawnChild(parentId, curveId, tokenType, entryPrice, then, parent = null) {
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
      // Children INHERIT the parent's owner and session: the auto-exit belongs
      // to the same user, and a session-bought position must exit through the
      // SAME session (custody consistency), not the shared agent wallet.
      wallet:        parent?.wallet ?? null,
      sessionId:     parent?.params?.sessionId ?? undefined,
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

  // (future child types - e.g. then.dca - slot in here with the same contract)
  return null;
}

// armThen - shared helper: after a buy-strategy settles a buy on `curveId`, read
// the REAL post-buy price and arm whatever the parent's `then` block specifies.
// Used by sniper, dca, and copytrade so chaining is identical across all three.
async function armThen(parentId, curveId, then, parent = null) {
  if (!then || typeof then !== 'object') return null;
  let entryPrice = null, childTokenType = null;
  try {
    const st = await getCurveState(curveId);
    childTokenType = st.tokenType ?? null;
    entryPrice = priceFromReserve(getVSui(st.packageId), st.reserveMist);
  } catch (e) {
    err(`${parentId}: could not read post-buy price for child (${e.message}); arming on observe`);
  }
  const childId = await spawnChild(parentId, curveId, childTokenType, entryPrice, then, parent);
  if (childId) {
    log(`${parentId}: armed child ${childId} on ${curveId.slice(0, 10)}... entry=${entryPrice != null ? entryPrice.toExponential(3) : 'observe'} SUI`);
  }
  return childId;
}

// armThenAt - like armThen, but uses a SUPPLIED entry price and tokenType rather
// than reading the curve fresh. DCA uses this to arm the child (e.g. TP/SL) on
// the blended AVERAGE cost across all fills, so profit/loss is measured against
// what was actually paid - not a single fill or a fresh spot read.
async function armThenAt(parentId, curveId, tokenType, entryPrice, then, parent = null) {
  if (!then || typeof then !== 'object') return null;
  const childId = await spawnChild(parentId, curveId, tokenType, entryPrice, then, parent);
  if (childId) {
    log(`${parentId}: armed child ${childId} on ${curveId.slice(0, 10)}... entry(avg)=${entryPrice != null ? entryPrice.toExponential(3) : 'observe'} SUI`);
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

// -- Serialized execution queue (one nexus sell at a time, globally) -----------
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

// -- On-chain reads (GraphQL, read-only, no key) -------------------------------
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

// getSessionParkedWhole - whole-token balance of a session's PARKED Coin<T>.
// A session-bought position lives INSIDE the session object as a dynamic object
// field (park_tokens keys it by TypeName), NOT at any address's coin balance, so
// getBalanceWhole (which reads an address) returns ~0 for it and the tpsl exit
// would false-trip its dust guard and never sell. This reads the parked coin
// straight from chain, matching the query shape verified against testnet
// (2026-07-08): object(address).dynamicFields.nodes[] where the parked node is a
// MoveObject whose contents.type.repr is 0x..2::coin::Coin<tokenType> and
// contents.json.balance is the atomic amount. The universal_trading marker rides
// as a separate bool field and is skipped by requiring ::coin::Coin< carrying
// our tokenType (matched on the inner tokenType substring, tolerant of address
// zero-padding). Returns whole tokens (0 when nothing is parked).
async function getSessionParkedWhole(sessionId, tokenType) {
  const want = String(tokenType).toLowerCase();
  const data = await gql(
    `query($id: SuiAddress!) { object(address: $id) { dynamicFields { nodes { value { __typename ... on MoveObject { contents { type { repr } json } } } } } }`,
    { id: sessionId },
  );
  const nodes = data?.object?.dynamicFields?.nodes ?? [];
  for (const n of nodes) {
    const c = n?.value?.contents;
    const repr = String(c?.type?.repr ?? '').toLowerCase();
    if (!repr.includes('::coin::coin<')) continue; // skip the bool universal_trading marker
    if (!repr.includes(want)) continue;            // different token type
    const bal = c?.json?.balance;
    if (bal == null) continue;
    return Number(BigInt(bal)) / 10 ** TOKEN_DECIMALS;
  }
  return 0;
}

// -- Fire a sell via the proven runner path (server.js signs) ------------------
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Sui rejects a tx that referenced an object version another tx just bumped
// ("unavailable for consumption" / "needs to be rebuilt"). Happens when the
// price-moving trade and our sell touch the same curve/coins back to back.
// A fresh /run-dag rebuilds against current versions, so retry this class.
const STALE_OBJECT_RE = /unavailable for consumption|needs to be rebuilt|rejected as invalid by more than|not available for consumption|equivocat/i;

async function fireSell(curveId, tokenWhole, minSuiOut, sellAll = false, sessionId = null) {
  // SELL = bridge settle, SOLE executor (see SINGLE-EXECUTOR RULE below).
  //   - session sells  -> /session-sell (spends the session's parked tokens)
  //   - non-session    -> /sell (agent wallet)
  // The bridge resolves tokenType/version/coins and signs; we pass only
  // curve + amount. Returns { ok, txDigest (settlement), nexusDigest,
  // nexusExecutionId, ... } - the nexus fields are null until the sell DAG
  // rebuild reintroduces Leader-executed sells.
  //
  // WHOLE-BALANCE SELLS use tokenAmount:"all" - the bridge's proven path that
  // merges ALL of the wallet's coin objects for this type and sells the lot.
  // A floored exact integer (e.g. 1214301) fails to simulate when the balance is
  // spread across multiple coin objects (bought in several buys): the PTB can't
  // cleanly split that exact amount. "all" sidesteps coin-selection entirely and
  // is what every working manual/agent sell this project has used. Partial sells
  // (sellPct < 100) still pass a specific integer amount.
  const tokenAmount = sellAll ? 'all' : Math.floor(tokenWhole);

  // -- SINGLE-EXECUTOR RULE: the bridge is the SOLE executor for ALL sells ----
  // (post 2026-07-03 DAG fix). Leaders now DO consume walks and occurrences,
  // and the Nexus tools execute through the SHARED agent wallet - emitting a
  // walk AND settling via the bridge produces TWO on-chain trades (the
  // C3yGhm.../2Xm4KGbi... AGNTSESH double-buy incident, 2026-07-04).
  // The old sell-walk emit here is REMOVED, not gated, because:
  //   - the sell DAG has NOT been rebuilt yet (on_chain vertices, walks stick
  //     Active forever), so a pending-walk guard would stall TP/SL sells
  //     indefinitely - and a sell that protects a position must NEVER stall;
  //   - the moment the sell DAG IS rebuilt, a fire-and-forget emit becomes a
  //     guaranteed double-sell through the shared wallet.
  // Leader-executed sells return with the sell DAG rebuild (queue item):
  // off_chain vertices + session-aware sell tool (/session-sell on sessionId,
  // TODO(nexus-session) Option B), Leader as sole executor with confirm.
  const nexusDigest = null, nexusExecutionId = null;

  // -- 2. Settle the swap via the bridge (the path that moves tokens) ---------
  // Whole tokens; the bridge converts to base units itself. 3-try retry for the
  // stale-object class (same as the buy/sell coin-version races).
  //
  // Session sells go to /session-sell, spending from the session's parked tokens
  // (Option A - interim until the Nexus sell tool routes /session-sell under the
  // Leader). The session holds its tokens as a single coin, so "all" is not
  // supported there: we pass a concrete integer amount. For a whole-balance
  // session sell, tokenWhole already carries the full known balance.
  // Session sells go to /session-sell, spending from the session's parked tokens
  // (Option A - interim until the Nexus sell tool routes /session-sell under the
  // Leader). For a WHOLE-position session sell, send sellAll:true - the bridge
  // resolves the exact parked balance on-chain at execution time (no plan/tick
  // drift, no leftover dust). Partial session sells pass a concrete whole-token
  // amount.
  // TODO(nexus-session): when sell.rs branches to /session-sell on a sessionId in
  // the walk, emit the sell with the sessionId so the Leader executes it (Option B).
  const endpoint = sessionId ? '/session-sell' : '/sell';
  const sessionTokenAmount = Math.max(0, Math.floor(tokenWhole));
  const body = sessionId
    ? (sellAll
        ? { sessionId, curveId, sellAll: true, minSuiOut: minSuiOut ?? 0 }
        : { sessionId, curveId, tokenAmount: sessionTokenAmount, minSuiOut: minSuiOut ?? 0 })
    : { curveId, tokenAmount, minSuiOut: minSuiOut ?? 0 };
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const r = await fetch(`${BRIDGE_URL}${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(AGENT_API_KEY ? { 'x-agent-key': AGENT_API_KEY } : {}) },
        body: JSON.stringify(body), signal: AbortSignal.timeout(190000),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || d.ok === false) throw new Error(d.error ?? `bridge ${r.status}`);
      log(`sell: settled via bridge${sessionId ? ' (session)' : ''} digest=${d.txDigest} sui=${d.suiReceived ?? '?'}`);
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

// -- Fire any workflow as a Nexus scheduler TASK (server.js /schedule-task) -----
// !! DO NOT CALL THIS FROM STRATEGY FIRE PATHS !! Since the 2026-07-03 DAG fix,
// Leaders CONSUME scheduler occurrences and execute them through the Nexus
// tools, which sign with the SHARED agent wallet. Emitting an occurrence for a
// fire that the runner also settles produces a second on-chain trade (the
// AGNTSESH double-buy incident). This wrapper remains ONLY for genuine
// scheduling features where the Leader is the sole, intended executor.
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

// -- C2 DEMO: buy via the Talus leader path (sole executor), bridge fallback ----
// Emits the buy walk with confirm:true. If a leader settles it (EndState Ok,
// sender = a leader), the leader path already executed the buy (the Nexus buy
// tool calls the same bridge endpoint) - we return the LEADER settlement digest
// as the proof and do NOT call the bridge directly. If the leader path does not
// confirm in time, we fall back to fireBridgeBuy so the demo always completes.
// Returns { settleDigest, leaderSettled, nexusExecutionId } shaped like the
// sniper/dca call sites expect (they read the digest).
async function fireNexusBuy(curveId, amountSui) {
  let walkDigest = null, walkExecutionId = null;
  try {
    const rr = await fetch(`${RUNNER_URL}/run-dag`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(AGENT_API_KEY ? { 'x-agent-key': AGENT_API_KEY } : {}) },
      body: JSON.stringify({ workflow: 'buy', buy: { curveId, amountSui }, confirm: true }),
      signal: AbortSignal.timeout(190000),
    });
    const rd = await rr.json().catch(() => ({}));
    walkDigest      = rd.digest ?? null;
    walkExecutionId = rd.executionId ?? null;
    if (rr.ok && rd.ok && (rd.endState === 'Ok' || rd.endState === 'Empty') && rd.settlementDigest) {
      log(`buy: DEMO leader-settled endState=${rd.endState} leader=${rd.leaderSender} digest=${rd.settlementDigest} (sole executor)`);
      return { settleDigest: rd.settlementDigest, leaderSettled: true, leaderSender: rd.leaderSender ?? null, nexusExecutionId: rd.executionId ?? null };
    }
    err(`buy: DEMO leader path did not confirm (endState=${rd.endState ?? rd.error ?? rr.status})`);
  } catch (e) {
    err(`buy: DEMO leader emit failed: ${e.message}`);
  }
  // SINGLE-EXECUTOR RULE: if a walk EXISTS but did not terminally settle in the
  // confirm window, the Leader can still execute it after we return - a bridge
  // buy now would double-buy (the C3yGhm.../2Xm4KGbi... incident class). Fail
  // this fire; the caller's cooldown/next tick retries.
  if (walkDigest || walkExecutionId) {
    throw new Error(`buy walk pending (execution ${walkExecutionId ?? '?'} digest ${walkDigest ?? '?'}) - refusing bridge settle to avoid a double-buy; will retry`);
  }
  // No walk was created (emit itself failed before an on-chain request
  // existed) - the proven bridge buy is safe and becomes the sole executor.
  const settleDigest = await fireBridgeBuyRaw(curveId, amountSui);
  return { settleDigest, leaderSettled: false, leaderSender: null, nexusExecutionId: null };
}

// -- Settle a BUY through the bridge (the path that actually moves tokens) ------
// The scheduler task (fireScheduleTask above) emits the on-chain agentic-decision
// PROOF, but on testnet no Talus leader consumes the occurrence, so the task
// alone never moves tokens. This is the sniper analog of fireSell's settle leg:
// it calls the bridge /buy - the same endpoint the site's wallet buys use, which
// signs with the bridge's own key and executes the swap now. Returns the
// settlement txDigest. 3-try retry for the stale-object coin-version race, same
// as fireSell. The task emit stays best-effort PROOF; this is the money path and
// must NEVER be gated behind the emit.
// Demo-aware buy dispatcher used by all call sites. Returns a settlement digest
// STRING in both modes (call sites read it directly). In DEMO_MODE it routes
// through the Talus leader path (fireNexusBuy) and returns the LEADER settlement
// digest when the leader settles; otherwise it returns the bridge digest. In
// production (DEMO_MODE off) it is the raw bridge buy, unchanged.
// Demo-aware buy dispatcher used by all call sites. Returns an OBJECT
// { settleDigest, leaderSettled, leaderSender, nexusExecutionId } so call sites
// can label the fire truthfully (leader vs bridge). In DEMO_MODE it routes
// through the Talus leader path (fireNexusBuy) and reports leaderSettled=true
// when the leader settles; otherwise it returns the bridge digest with
// leaderSettled=false. In production (DEMO_MODE off) it is the raw bridge buy.
async function fireBridgeBuy(curveId, amountSui, sessionId = null) {
  if (DEMO_MODE && !sessionId) {
    // Leader-executed path stays the agent-wallet flow. Session trades currently
    // settle via the bridge /session-buy endpoint (Option A - interim until the
    // Nexus buy tool learns to call /session-buy under the Leader).
    // TODO(nexus-session): when buy.rs branches to /session-buy on a sessionId in
    // the walk, route session buys through fireNexusBuy with the sessionId so the
    // Leader executes them through Nexus (Option B) instead of this direct call.
    return await fireNexusBuy(curveId, amountSui);
  }
  const settleDigest = await fireBridgeBuyRaw(curveId, amountSui, sessionId);
  return { settleDigest, leaderSettled: false, leaderSender: null, nexusExecutionId: null };
}

async function fireBridgeBuyRaw(curveId, amountSui, sessionId = null) {
  // When the order is bound to an agent session, spend the session's escrow via
  // /session-buy instead of the agent wallet via /buy. No privateKey is sent, so
  // the bridge signs with its own key (= the session_address the user authorized,
  // the agent wallet 0x877af0...). The on-chain spend_cap/expiry/revoke protect the
  // user's funds; key custody does not.
  const endpoint = sessionId ? '/session-buy' : '/buy';
  const body = sessionId
    ? { sessionId, curveId, suiAmount: amountSui }
    : { curveId, suiAmount: amountSui };
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
      const r = await fetch(`${BRIDGE_URL}${endpoint}`, {
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
        const wait = 2500 * attempt;   // 2.5s, 5s, 7.5s, 10s - rides out fresh-curve settle
        err(`buy settle attempt ${attempt}/${MAX} not ready (${String(e.message).slice(0, 80)}); retrying in ${wait}ms`);
        await sleep(wait);
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

// -- Order evaluation ----------------------------------------------------------
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

  if (st.graduated) { log(`${order.id}: curve graduated - closing order`); order.done = true; await persistOrder(order); return; }
  if (!order.tokenType) order.tokenType = st.tokenType;
  if (!order.packageId) order.packageId = st.packageId;
  if (!order.tokenType) { err(`${order.id}: curve has no tokenType yet`); order._cooldownUntil = Date.now() + ERROR_COOLDOWN_MS; return; }

  const price = priceFromReserve(getVSui(st.packageId), st.reserveMist);
  if (!(price > 0)) { err(`${order.id}: non-positive price (reserve ${st.reserveMist})`); return; }

  if (order.entryPriceSui == null) {
    order.entryPriceSui = price;
    log(`${order.id}: entry not provided - seeding from current price ${price.toExponential(4)} SUI`);
    await persistOrder(order);
  }
  order.lastPrice = price;

  const mult  = order.entryPriceSui > 0 ? price / order.entryPriceSui : 1;
  const nr    = order.takeProfit.find(r => !r._fired);
  const nrTxt = nr ? `${nr.multiple != null ? nr.multiple + 'x' : nr.priceSui + ' SUI'} -> ${nr.sellPct}%` : (order.stopLoss ? 'stop-loss only' : 'none');
  log(`${order.id}: tick ${price.toExponential(3)} SUI (${mult.toFixed(3)}x) | reserve ${(st.reserveMist / MIST_PER_SUI).toFixed(2)} SUI | next ${nrTxt}`);

  if (!nextAction(order)) return;

  // Session-bound positions are parked ON the session object, not at any wallet
  // address, so read the parked balance for those; non-session positions read the
  // agent wallet as before.
  const sessId = order.params?.sessionId ?? null;
  let balWhole;
  try { balWhole = sessId ? await getSessionParkedWhole(sessId, order.tokenType) : await getBalanceWhole(order.tokenType); }
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
      if (order.done) await pruneParentEntered(order); // autopilot: drop dust-closed position from parent entered[]
      continue;
    }

    const isWholeSell = action.sellPct >= 100;
    const sellWhole = isWholeSell ? balWhole : balWhole * (action.sellPct / 100);
    if (!(sellWhole > DUST_WHOLE)) { if (action.rung) action.rung._fired = true; await persistOrder(order); continue; }

    log(`${order.id}: ${action.kind} fire - (${mult.toFixed(3)}x) selling ${action.sellPct}% of ${balWhole.toFixed(6)} = ${isWholeSell ? 'ALL' : sellWhole.toFixed(6)} tokens`);
    const balBefore = balWhole;
    let receipt;
    try {
      receipt = await fireSell(order.curveId, sellWhole, order.minSuiOut, isWholeSell, order.params?.sessionId ?? null);
    } catch (e) {
      err(`${order.id}: sell failed: ${e.message}`);
      await recordError(order, 'sell', e.message); // surface WHY on the card
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
      try { balAfter = sessId ? await getSessionParkedWhole(sessId, order.tokenType) : await getBalanceWhole(order.tokenType); }
      catch (e) { err(`${order.id}: post-sell balance read failed (try ${i}): ${e.message}`); continue; }
      moved = balBefore - balAfter;
      if (moved >= sellWhole * 0.9) { confirmed = true; break; }
    }
    if (!confirmed) {
      err(`${order.id}: SELL NOT CONFIRMED - bridge returned digest ${receipt.txDigest ?? '?'} but on-chain balance moved ${moved.toFixed(6)} of ${sellWhole.toFixed(6)} expected (${balBefore.toFixed(6)} -> ${balAfter.toFixed(6)}); order stays active, will retry`);
      order._cooldownUntil = Date.now() + ERROR_COOLDOWN_MS;
      return; // do NOT mark fired/done - the sell did not move tokens
    }

    log(`${order.id}: SOLD ${moved.toFixed(6)} tokens CONFIRMED on-chain - balance ${balBefore.toFixed(6)} -> ${balAfter.toFixed(6)} | settle ${receipt.txDigest ?? '?'} | nexus ${receipt.nexusDigest ?? 'not-emitted'}`);

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
    if (order.done) await pruneParentEntered(order); // autopilot: drop fully-closed position from parent entered[]
    await recordFire(order, { kind: 'sell', curveId: order.curveId, nexusExec: receipt.nexusExecutionId ?? null, nexusDigest: receipt.nexusDigest ?? null, settle: receipt.txDigest ?? null, leaderSettled: receipt.leaderSettled === true, leaderSender: receipt.leaderSender ?? null });
    await clearError(order); // a confirmed sell clears any prior abort on the card
    // Surface the fire in the notification bell, labelled by WHY it fired
    // (TP vs SL) - only known here. tokens = confirmed on-chain amount moved.
    await notifyBell({
      // Bell is keyed by wallet: notify the ORDER OWNER, not the runner
      // (payload.wallet overrides notifyBell's invoker default via spread).
      wallet:  order.wallet ?? undefined,
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

// -- SSE wake-up (never prices from the event) ---------------------------------
function handleEvent(ev) {
  if (!ev || ev.type === 'connected') return;
  const isTrade  = ev.type === 'TokensPurchased' || ev.type === 'TokensBought' || ev.type === 'TokensSold';
  const isLaunch = ev.type === 'CurveCreated';
  // DIAGNOSTIC: surface any event whose type mentions sell/sold/trade but did NOT
  // classify as a trade above - catches a sell event with an unexpected type tail.
  if (!isTrade && !isLaunch && /sold|sell|trade|purchas|bought/i.test(String(ev.type ?? ''))) {
    log(`[unmatched-ev] type=${ev.type} curve=${String(ev.curveId ?? 'none').slice(0, 10)}... keys=${Object.keys(ev.data ?? {}).join(',')}`);
  }

  if (isTrade && ev.curveId) {
    const side = ev.type === 'TokensSold' ? 'sell' : 'buy';
    const trader = side === 'sell'
      ? (ev.data?.seller ?? null)
      : (ev.data?.buyer ?? null);
    // DIAGNOSTIC: log every trade event the brain sees, so a non-matching sell is
    // visible on the wire (type tail + buyer/seller fields). Remove once resolved.
    log(`[trade-ev] type=${ev.type} side=${side} curve=${String(ev.curveId).slice(0, 10)}... buyer=${ev.data?.buyer ?? 'none'} seller=${ev.data?.seller ?? 'none'}`);
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

// -- Boot ----------------------------------------------------------------------
function summarizeOrder(o) {
  const tp = o.takeProfit.map(r => `${r.multiple != null ? r.multiple + 'x' : r.priceSui + ' SUI'}->${r.sellPct}%`).join(', ');
  const sl = o.stopLoss ? (o.stopLoss.multiple != null ? `${o.stopLoss.multiple}x` : `${o.stopLoss.priceSui} SUI`) : 'none';
  return `${o.id} curve ${o.curveId.slice(0, 10)}... entry ${o.entryPriceSui ?? 'observe'} | TP [${tp}] | SL ${sl}`;
}

// -- Strategy handler registry (dispatch by order.type) ------------------------
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
    // Owner attribution must survive normalization (see normalizeRemote).
    wallet: R.wallet ?? null,
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
    summarize: (o) => `${o.id} ${type} ${JSON.stringify(o.params)}${o.curveId ? ' curve ' + o.curveId.slice(0, 10) + '...' : ''} - pending ${milestone}`,
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

  // SNIPER - wakes on a CurveCreated event. Emits a buy task on the freshly
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

      // -- Idempotency: claim this curve SYNCHRONOUSLY before any await. The
      // indexer can emit the same CurveCreated over SSE more than once (gRPC
      // stream + GraphQL backfill overlap), and two wakes can enter process()
      // back-to-back before the in-flight lock releases. A sniper must buy a
      // given launch AT MOST ONCE, so we claim the curveId here, synchronously,
      // and any duplicate that arrives bails instantly. (Persisted snipes are
      // also seeded into this set on load via normalize, below.)
      if (!order._sniped) order._sniped = new Set();
      if (order._sniped.has(curveId)) return;   // already fired for this curve

      // Cap reached? (defensive - sync also closes it; this stops an in-flight wake)
      if (p.maxSnipes > 0 && num2(p.fired, 0) >= p.maxSnipes) {
        order.done = true; await persistParams(order); return;
      }

      // -- Filter against the launch event. The indexer's pg_notify payload puts
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
        // No filters and not explicitly all -> never fire (store guards this too).
        return;
      }

      // Claim the curve NOW (passed the filter, committed to firing). Done before
      // the await so a concurrent duplicate sees it claimed and bails above.
      order._sniped.add(curveId);

      if (onCooldown(order)) return;
      const amountSui = num2(p.amountSui, 0.1);
      log(`${order.id}: SNIPE launch ${curveId.slice(0, 10)}... (${symbol || name || 'unknown'}) buy ${amountSui} SUI`);
      try {
        // SINGLE-EXECUTOR RULE: the old "proof" scheduler-task emit is GONE.
        // Leaders now consume occurrences (post 2026-07-03 DAG fix), so the
        // emit became a real second buy executed by the Leader through the
        // SHARED agent wallet ~15s after the settle below (double-spend +
        // custody violation for session orders). The settle digest IS the
        // fire's proof. taskId stays null for the recordFire shape.
        const taskId = null;

        // SETTLE the buy through the bridge - the path that actually moves
        // tokens. Sole executor for this fire.
        const buyResult = await fireBridgeBuy(curveId, amountSui, order.params?.sessionId ?? null);
        const settleDigest = buyResult.settleDigest;
        log(`${order.id}: sniper settled buy digest=${settleDigest} via=${buyResult.leaderSettled ? 'leader' : 'bridge'}`);

        // COMPOSE: if this sniper carries a `then` block, arm the child strategy
        // (e.g. TP/SL) on the curve we just bought, seeded at the REAL post-buy
        // price. Shared with dca/copytrade via armThen so chaining is identical.
        if (p.then) await armThen(order.id, curveId, p.then, order);

        // Count the fire (settlement succeeded) and persist.
        p.fired = num2(p.fired, 0) + 1;
        p.snipedCurves = Array.from(order._sniped);
        order.params = p;
        if (p.maxSnipes > 0 && p.fired >= p.maxSnipes) order.done = true;
        await persistParams(order);
        await recordFire(order, { kind: 'buy', curveId, nexusTask: taskId, nexusExec: buyResult.nexusExecutionId ?? null, settle: settleDigest, leaderSettled: buyResult.leaderSettled === true, leaderSender: buyResult.leaderSender ?? null });
        await clearError(order);
        log(`${order.id}: SNIPE COMPLETE ${curveId.slice(0, 10)}... task=${taskId ?? 'n/a'} settle=${settleDigest} fired=${p.fired}${p.maxSnipes > 0 ? `/${p.maxSnipes}` : ''}${order.done ? ' - cap reached, closing' : ''}`);
      } catch (e) {
        // Settlement failed - release the claim so a genuine retry can re-attempt
        // this curve (no tokens moved, so it must not count as a snipe).
        order._sniped.delete(curveId);
        err(`${order.id}: sniper settle failed: ${e.message}`);
        await recordError(order, 'buy', e.message); // surface WHY on the card
      }
    },
  },

  // DCA / scale-in - brain-driven accumulation. Two trigger modes:
  //   * time: buy `suiPerBuy` every `intervalMs`, up to `buys` times.
  //   * dip:  buy `suiPerBuy` each time price drops `dropPct`% (xrung) from the
  //           entry price, up to `buys` rungs.
  // Each fire emits a Nexus task (the agentic-decision proof) AND settles the buy
  // through the bridge (the path that moves tokens), exactly like sniper. Every
  // fill updates a running average cost (params.avgPriceSui), persisted so the
  // panel can show it and a `then.tpsl` can target the blended basis. After the
  // FINAL buy, arms the `then` child (e.g. TP/SL) via the shared armThen.
  //
  // Wakes on the timer tick; dip mode also re-checks price each tick (poll-based -
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
      return `${o.id} dca buy ${num2(p.suiPerBuy, 0.1)} SUI ${mode} . ${num2(p.done, 0)}/${num2(p.buys, 1)} on ${(o.curveId ?? p.curveId ?? '').slice(0, 10)}...`;
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
      if (graduated) { log(`${order.id}: dca curve graduated - closing`); order.done = true; await persistParams(order); return; }

      // -- Trigger gating ----------------------------------------------------
      // Minimum spacing between ANY two fires on this order, so a rung can never
      // fire in the settle-shadow of the previous buy (which transiently moves
      // the reserve/price and previously let a dip rung fire with no real dip).
      const MIN_FIRE_GAP_MS = parseInt(process.env.STRATEGY_DCA_MIN_GAP_MS ?? '20000', 10);
      const sinceLast = now - num2(p.lastFireMs, 0);
      if (done > 0 && sinceLast < MIN_FIRE_GAP_MS) return;   // too soon after last fill

      if (isDip) {
        // Rung 0 establishes entry; rungs 1+ require price to have fallen
        // dropPct% x rung BELOW the locked entry. Entry must be locked (set on the
        // anchor's settled fill) - if it isn't yet, do not evaluate a dip.
        const dropPct = num2(p.dropPct, 10) / 100;
        if (done === 0) {
          // anchor fires immediately (no drop required)
        } else {
          const entry = num2(p.entryPriceSui, 0);
          if (!(entry > 0)) return;                          // entry not locked yet - wait
          const targetRungPrice = entry * (1 - dropPct * done); // -10%, -20%, ... from entry
          if (!(price <= targetRungPrice)) return;           // not dropped enough yet
          log(`${order.id}: dip rung ${done} eligible - price ${price.toExponential(3)} <= target ${targetRungPrice.toExponential(3)} (entry ${entry.toExponential(3)})`);
        }
      } else {
        // time mode: require intervalMs since last fire (first fire is immediate)
        const intervalMs = num2(p.intervalMs, 86400000);
        if (done > 0 && sinceLast < intervalMs) return;
      }

      // -- Fire one buy: bridge settle, sole executor --------------------------
      if (onCooldown(order)) return;   // guard against double-fire within a tick window
      // SINGLE-EXECUTOR RULE: the old "proof" scheduler-task emit is GONE.
      // Leaders now consume occurrences (post 2026-07-03 DAG fix); the emit
      // here is what produced the AGNTSESH double-buy (session settle C3yGhm...
      // + Leader shared-wallet buy 2Xm4KGbi... ~15s later, 2026-07-04). The
      // settle digest below IS the fire's proof. taskId stays null for the
      // recordFire shape.
      const taskId = null;

      let settleDigest, dcaBuyResult;
      try {
        dcaBuyResult = await fireBridgeBuy(curveId, thisBuySui, order.params?.sessionId ?? null);
        settleDigest = dcaBuyResult.settleDigest;
      } catch (e) {
        err(`${order.id}: dca settle failed: ${e.message}`);
        // Surface WHY on the strategy card (drained/capped/legacy-token abort).
        // Space out the retry so a hard abort (cap reached) doesn't hot-loop.
        await recordError(order, 'buy', e.message);
        p.lastFireMs = now;
        order.params = p;
        await persistParams(order);
        return; // do not count a fill that didn't settle
      }

      // DRY-BUY GUARD: a real second buy must have a NEW on-chain digest. If the
      // bridge returns the SAME digest as the previous fill (the known dry/
      // duplicate-execution failure mode), or no digest at all on a rung buy, the
      // buy did NOT actually move tokens - do not count it, do not advance the
      // rung, and back off so a genuine retry can happen on a later tick.
      if (settleDigest && settleDigest === p._lastSettleDigest) {
        err(`${order.id}: dca dry buy - settle digest ${settleDigest.slice(0, 10)}... matches previous fill; NOT counting (no tokens moved)`);
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

      // -- Record fill + update running average cost --------------------------
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
      await recordFire(order, { kind: 'buy', curveId, nexusTask: taskId, nexusExec: dcaBuyResult.nexusExecutionId ?? null, settle: settleDigest, leaderSettled: dcaBuyResult.leaderSettled === true, leaderSender: dcaBuyResult.leaderSender ?? null });
      await clearError(order); // a real fill clears any prior abort on the card

      log(`${order.id}: DCA buy ${p.done}/${buys} ${thisBuySui} SUI @ ${price.toExponential(3)} (avg ${p.avgPriceSui.toExponential(3)}) task=${taskId ?? 'n/a'} settle=${settleDigest}${order.done ? ' - complete' : ''}`);

      // -- COMPOSE: after the FINAL buy, arm the `then` child on the blended
      //    basis. We pass the average cost as the entry so a then.tpsl targets
      //    profit/loss relative to what was actually paid across all fills.
      if (order.done && p.then) {
        await armThenAt(order.id, curveId, tokenType, p.avgPriceSui, p.then, order);
      }
    },
  },

  // COPY-TRADE - follows a TARGET WALLET across any curve. wakesOn 'walletTrade':
  // handleEvent only schedules this when the trade's buyer/seller IS the target.
  //   * target BUYS curve C  -> agent buys `suiPerTrade` SUI of C (Nexus + bridge).
  //   * target SELLS curve C -> agent sells the SAME FRACTION of its own C balance
  //     that the target just sold of theirs (proportional mirror).
  // Proportional sell math: fraction = sold / (sold + target's remaining balance),
  // read on-chain right after their sell. The agent then sells fraction x (agent's
  // own balance of C). Uses the proven fireBridgeBuy / fireSell settle paths.
  // params: { targetWallet, suiPerTrade }
  copytrade: {
    label: 'copytrade',
    wakesOn: 'walletTrade',
    normalize: scaffoldNormalize,
    summarize: (o) => {
      const p = o.params || {};
      return `${o.id} copytrade ${num2(p.suiPerTrade, 0.1)} SUI/buy mirroring ${String(p.targetWallet ?? '?').slice(0, 10)}...`;
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
      // too - so the cooldown is keyed by side+curve, NOT order-wide. This still
      // catches a genuine duplicate (same side+curve fired twice in quick
      // succession - the duplicate-event issue seen in logs) without letting a
      // buy suppress a sell.
      const COPY_DEDUP_MS = parseInt(process.env.STRATEGY_COPY_DEDUP_MS ?? '15000', 10);
      const dedupKey = `${side}:${curveId}`;
      order._copyFired = order._copyFired || {};
      const lastFired = order._copyFired[dedupKey] ?? 0;
      if (Date.now() - lastFired < COPY_DEDUP_MS) {
        log(`${order.id}: copytrade dedup - ${dedupKey.slice(0, 16)}... fired ${Date.now() - lastFired}ms ago, skipping duplicate`);
        return;
      }
      order._copyFired[dedupKey] = Date.now();

      // Resolve tokenType for this curve (needed for balance reads + sell).
      let tokenType = null;
      try {
        const st = await getCurveState(curveId);
        tokenType = st.tokenType ?? null;
        if (st.graduated) { log(`${order.id}: copytrade skip - ${curveId.slice(0, 10)}... graduated`); return; }
      } catch (e) {
        err(`${order.id}: copytrade curve read failed (${e.message})`); return;
      }

      if (side === 'buy') {
        // Mirror the target's BUY with a fixed-size agent buy.
        const suiPerTrade = num2(p.suiPerTrade, 0);
        if (!(suiPerTrade > 0)) { if (!order._warned) { err(`${order.id}: copytrade needs suiPerTrade`); order._warned = true; } return; }
        log(`${order.id}: COPYTRADE target BUY -> agent buy ${suiPerTrade} SUI on ${curveId.slice(0, 10)}...`);
        // SINGLE-EXECUTOR RULE: no scheduler-task emit (Leaders now consume
        // occurrences = second shared-wallet buy). Settle digest is the proof.
        const taskId = null;
        try {
          const cpBuy = await fireBridgeBuy(curveId, suiPerTrade, order.params?.sessionId ?? null);
          const settle = cpBuy.settleDigest;
          log(`${order.id}: copytrade BUY settled ${suiPerTrade} SUI on ${curveId.slice(0, 10)}... task=${taskId ?? 'n/a'} settle=${settle} via=${cpBuy.leaderSettled ? 'leader' : 'bridge'}`);
          await recordFire(order, { kind: 'buy', curveId, nexusTask: taskId, nexusExec: cpBuy.nexusExecutionId ?? null, settle, leaderSettled: cpBuy.leaderSettled === true, leaderSender: cpBuy.leaderSender ?? null });
          await clearError(order);
        } catch (e) { err(`${order.id}: copytrade buy settle failed: ${e.message}`); await recordError(order, 'buy', e.message); }
        return;
      }

      // side === 'sell': proportional mirror.
      // 1) the fraction the TARGET sold = sold / (sold + their remaining balance).
      const soldWhole = num2(ev?.data?.tokens_in, 0) / 1e6; // tokens_in = tokens sold (atomic, 6 decimals)
      if (!(soldWhole > 0)) { log(`${order.id}: copytrade sell - target sold amount unknown, skipping`); return; }
      let targetRemaining = 0;
      try { targetRemaining = await getBalanceWhole(tokenType, target); }
      catch (e) { err(`${order.id}: copytrade target balance read failed (${e.message})`); }
      const fraction = soldWhole / (soldWhole + targetRemaining);
      if (!(fraction > 0)) { log(`${order.id}: copytrade sell - computed zero fraction, skipping`); return; }

      // 2) agent sells the same fraction of ITS OWN balance of this curve.
      //    Session-bound copytrade positions are parked on the session; read
      //    there (not the shared agent wallet) so the mirror sells the real
      //    position and exits through the session that holds it.
      const cpSessId = order.params?.sessionId ?? null;
      let agentBal = 0;
      try { agentBal = cpSessId ? await getSessionParkedWhole(cpSessId, tokenType) : await getBalanceWhole(tokenType, INVOKER_ADDRESS); }
      catch (e) { err(`${order.id}: copytrade agent balance read failed (${e.message})`); return; }
      if (!(agentBal > 0)) { log(`${order.id}: copytrade sell - agent holds none of ${curveId.slice(0, 10)}..., nothing to mirror`); return; }

      const sellWhole = agentBal * fraction;
      const sellAll = fraction >= 0.999; // target dumped ~everything -> agent sells all (robust coin-merge path)
      log(`${order.id}: COPYTRADE target SELL ${(fraction * 100).toFixed(1)}% -> agent sell ${sellAll ? 'ALL' : sellWhole.toFixed(4)} of ${agentBal.toFixed(4)} on ${curveId.slice(0, 10)}...`);
      try {
        const receipt = await fireSell(curveId, sellWhole, 0, sellAll, order.params?.sessionId ?? null);
        log(`${order.id}: copytrade SELL settled on ${curveId.slice(0, 10)}... settle=${receipt?.txDigest ?? '?'} nexus=${receipt?.nexusDigest ?? '?'}`);
        await recordFire(order, { kind: 'sell', curveId, nexusExec: receipt?.nexusExecutionId ?? null, nexusDigest: receipt?.nexusDigest ?? null, settle: receipt?.txDigest ?? null, leaderSettled: receipt?.leaderSettled === true, leaderSender: receipt?.leaderSender ?? null });
        await clearError(order);
      } catch (e) { err(`${order.id}: copytrade sell settle failed: ${e.message}`); await recordError(order, 'sell', e.message); }
    },
  },

  // AUTOPILOT - the Analyzer-armed standing strategy ("a personal agent for every
  // user"). Where sniper fires on launch events and copytrade mirrors a wallet,
  // autopilot SCANS THE MARKET on the timer tick, scores candidates off the
  // indexer's existing /trending momentum engine, vetoes the dangerous ones with
  // deterministic on-chain signals (top-holder concentration + holder count +
  // graduation), and enters the best survivor each tick - strictly inside the
  // user's mandate (spend cap + per-entry size + max open positions). Each entry
  // optionally arms a TP/SL exit on the real fill price via the shared armThen.
  //
  // This is the decision-policy node: it turns /trending signals into INTENTS,
  // then settles them through the SAME path the proven strategies use (Nexus emit
  // = agentic proof, bridge = the money path). Execution never routes around Nexus.
  //
  // wakesOn 'timer' => dcaTick already schedules it every tick; runs 24/7 with the
  // dispatcher. The spend cap is enforced here off-chain today; the on-chain
  // AgentAuthority box will harden it later (same control surface).
  //
  // params: {
  //   spendCapSui, perEntrySui, minMomentum, maxConcentrationPct, maxOpenPositions,
  //   minHolders, scanTopN, cooldownMs, then?,
  //   // runtime, persisted: spentSui, entered[], fired, done, lastFireMs, _lastSettleDigest
  // }
  autopilot: {
    label: 'autopilot',
    wakesOn: 'timer',
    normalize: scaffoldNormalize,
    summarize: (o) => {
      const p = o.params || {};
      const spent = num2(p.spentSui, 0), cap = num2(p.spendCapSui, 0);
      const open = Array.isArray(p.entered) ? p.entered.length : 0;
      return `${o.id} autopilot ${num2(p.perEntrySui, 0.5)} SUI/entry . ${spent.toFixed(2)}/${cap} SUI deployed . ${open}/${num2(p.maxOpenPositions, 5)} open . momentum>${num2(p.minMomentum, 0)}`;
    },
    process: async (order) => {
      const p = order.params || {};

      // -- Mandate gate (off-chain cap; AgentAuthority hardens this later) ------
      const spendCapSui = num2(p.spendCapSui, 0);
      const perEntrySui = num2(p.perEntrySui, 0.5);
      const spentSui    = num2(p.spentSui, 0);
      if (!(spendCapSui > 0) || !(perEntrySui > 0)) {
        if (!order._warned) { err(`${order.id}: autopilot needs spendCapSui & perEntrySui`); order._warned = true; }
        return;
      }
      if (spentSui + perEntrySui > spendCapSui + 1e-9) {
        log(`${order.id}: autopilot spend cap reached (${spentSui.toFixed(2)}/${spendCapSui} SUI) - closing`);
        order.done = true; await persistParams(order); return;
      }

      // Per-order spacing so we never enter in the settle-shadow of the last buy.
      const cooldownMs = num2(p.cooldownMs, 60000);
      const now = Date.now();
      if (num2(p.lastFireMs, 0) > 0 && now - num2(p.lastFireMs, 0) < cooldownMs) return;

      const entered = Array.isArray(p.entered) ? p.entered : [];
      const maxOpen = Math.trunc(num2(p.maxOpenPositions, 5));
      if (maxOpen > 0 && entered.length >= maxOpen) return; // holding max; wait for exits

      // -- Scan: pull trending candidates --------------------------------------
      const scanTopN            = Math.trunc(num2(p.scanTopN, 10));
      const minMomentum         = num2(p.minMomentum, 0);
      const maxConcentrationPct = num2(p.maxConcentrationPct, 35);
      const minHolders          = Math.trunc(num2(p.minHolders, 3));

      let candidates;
      try {
        const r = await fetch(`${INDEXER_URL}/trending?limit=${scanTopN}`, { signal: AbortSignal.timeout(8000) });
        if (!r.ok) throw new Error(`trending ${r.status}`);
        candidates = await r.json();
      } catch (e) {
        err(`${order.id}: autopilot trending read failed (${e.message}); skipping tick`);
        return;
      }
      if (!Array.isArray(candidates) || !candidates.length) return;

      // Concentration veto: top NON-creator holder's LIQUID share of 1B total.
      // GET /token/:curveId/holders -> [{ address, balance, locked, liquid, isCreator }].
      // Mirrors AIAnalysis.jsx's concentration logic (liquid, non-creator, vs 1B).
      const TOTAL_SUPPLY_WHOLE = 1_000_000_000;
      const concentrationOf = async (curveId) => {
        try {
          const r = await fetch(`${INDEXER_URL}/token/${curveId}/holders`, { signal: AbortSignal.timeout(8000) });
          if (!r.ok) return null;
          const holders = await r.json();
          if (!Array.isArray(holders) || !holders.length) return null;
          let topLiquid = 0;
          for (const h of holders) {
            if (h.isCreator) continue;
            const liquid = Number(h.liquid ?? h.balance ?? 0);
            if (liquid > topLiquid) topLiquid = liquid;
          }
          return { pct: (topLiquid / TOTAL_SUPPLY_WHOLE) * 100, holderCount: holders.length };
        } catch { return null; }
      };

      // -- Decide: first survivor of the policy filter wins this tick ----------
      let pick = null;
      for (const c of candidates) {
        const curveId = c.curve_id ?? c.curveId;
        if (!curveId) continue;
        if (entered.includes(curveId)) continue;          // never re-enter
        if (c.graduated) continue;                         // can't curve-trade graduated
        const momentum = Number(c.momentum_score ?? 0);
        if (!(momentum > minMomentum)) continue;          // below the user's floor

        const conc = await concentrationOf(curveId);
        if (conc) {
          if (minHolders > 0 && conc.holderCount < minHolders) {
            log(`${order.id}: autopilot skip ${curveId.slice(0, 10)}... - only ${conc.holderCount} holders (< ${minHolders})`);
            continue;
          }
          if (conc.pct > maxConcentrationPct) {
            log(`${order.id}: autopilot skip ${curveId.slice(0, 10)}... - top holder ${conc.pct.toFixed(1)}% liquid (> ${maxConcentrationPct}%)`);
            continue;
          }
        }

        try {
          const st = await getCurveState(curveId);
          if (st.graduated) continue;
          pick = { curveId, momentum };
          break;
        } catch (e) {
          err(`${order.id}: autopilot curve read failed for ${curveId.slice(0, 10)}... (${e.message}); next candidate`);
          continue;
        }
      }

      if (!pick) return; // nothing cleared the policy this tick

      // -- Act: enter exactly like dca (bridge settle, sole executor) ----------
      if (onCooldown(order)) return;
      const { curveId } = pick;

      // SINGLE-EXECUTOR RULE: no scheduler-task emit (Leaders now consume
      // occurrences = second shared-wallet buy). Settle digest is the proof.
      const taskId = null;

      let settleDigest, buyResult;
      try {
        buyResult = await fireBridgeBuy(curveId, perEntrySui, order.params?.sessionId ?? null);
        settleDigest = buyResult.settleDigest;
      } catch (e) {
        err(`${order.id}: autopilot settle failed on ${curveId.slice(0, 10)}...: ${e.message}`);
        await recordError(order, 'buy', e.message); // surface WHY on the card
        return; // do not count an entry that didn't settle
      }

      // DRY-BUY GUARD: a real entry must produce a NEW on-chain digest.
      if (!settleDigest || settleDigest === p._lastSettleDigest) {
        err(`${order.id}: autopilot dry-buy (digest=${settleDigest ?? 'null'}) - not counting, backing off`);
        order._cooldownUntil = Date.now() + cooldownMs;
        return;
      }

      // Settled. Advance the mandate, record, optionally arm the exit.
      entered.push(curveId);
      p.entered           = entered;
      p.spentSui          = spentSui + perEntrySui;
      p.fired             = num2(p.fired, 0) + 1;
      p.lastFireMs        = Date.now();
      p._lastSettleDigest = settleDigest;
      order.params        = p;

      if (p.then) await armThen(order.id, curveId, p.then, order);

      if (p.spentSui + perEntrySui > spendCapSui + 1e-9) {
        order.done = true;
        log(`${order.id}: autopilot cap exhausted after entry - closing`);
      }

      await persistParams(order);
      await recordFire(order, { kind: 'buy', curveId, nexusTask: taskId, nexusExec: buyResult.nexusExecutionId ?? null, settle: settleDigest, leaderSettled: buyResult.leaderSettled === true, leaderSender: buyResult.leaderSender ?? null });
      await clearError(order);
      log(`${order.id}: AUTOPILOT ENTRY ${curveId.slice(0, 10)}... momentum=${pick.momentum.toFixed(1)} size=${perEntrySui} SUI task=${taskId ?? 'n/a'} settle=${settleDigest} via=${buyResult.leaderSettled ? 'leader' : 'bridge'} deployed=${p.spentSui.toFixed(2)}/${spendCapSui}${order.done ? ' - cap reached, closing' : ''}`);
    },
  },
};

// DCA tick - wakes timer-driven orders. A3 will honor each order's interval; for
// now this only routes them to their (inert) handler.
const DCA_TICK_MS = parseInt(process.env.STRATEGY_DCA_TICK_MS ?? '30000', 10);
function dcaTick() {
  for (const order of ORDERS.values()) {
    if (!order.done && HANDLERS[order.type]?.wakesOn === 'timer') schedule(order, { kind: 'timer' });
  }
}

async function main() {
  console.log('-'.repeat(52));
  console.log('  SUIPUMP STRATEGY BRAIN (multi-strategy dispatcher)');
  console.log('-'.repeat(52));
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
