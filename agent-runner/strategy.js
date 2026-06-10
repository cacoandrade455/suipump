// strategy.js — SuiPump strategy "brain".
//
// Runs as a SECOND process inside the agent-runner service (started by start.sh
// alongside server.js). server.js stays byte-for-byte unchanged. This process
// holds NO secrets: it watches prices and decides; server.js still signs.
//
// Pipeline:
//   indexer SSE /stream  ->  price (constant-product, matches api.js exactly)
//     ->  evaluate active orders (stop-loss + generic take-profit ladder)
//       ->  resolve sell amount from the invoker wallet's ON-CHAIN balance
//         ->  POST localhost /run-dag { workflow:"sell", ... }  (server.js signs)
//
// Design notes:
//   - ALL sells are serialized through one global queue. The invoker wallet has
//     one gas coin; concurrent nexus executions would equivocate. One at a time.
//   - Take-profit "ladder" is fully generic: any number of rungs, any multiple
//     or absolute price, any sell-percent. A single TP is just a one-rung ladder.
//   - sellPct is percent of the REMAINING balance at fire time (read fresh from
//     chain), which is why 50/50/100 cleanly exits.
//   - No npm dependencies: node builtins + global fetch only (Node 18+).
//
// v1 order source: STRATEGY_ORDERS env (JSON array) or ./orders.json.
//   The Postgres order-store with live CRUD is the next file.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Config (all env-overridable) ──────────────────────────────────────────────
const PORT            = parseInt(process.env.PORT ?? '3040', 10);
const RUNNER_URL      = process.env.RUNNER_URL      ?? `http://127.0.0.1:${PORT}`;
const INDEXER_URL     = process.env.INDEXER_URL     ?? 'https://suipump-62s2.onrender.com';
const SUI_GRAPHQL_URL = process.env.SUI_GRAPHQL_URL ?? 'https://graphql.testnet.sui.io/graphql';
// Wallet the runner signs with (funds the gas vault). We READ its balance only.
const INVOKER_ADDRESS = process.env.INVOKER_ADDRESS ?? '0x877af0fae3fa4f8ea936943b59bcd66104f67cf1895302e97761a28b3c3a5906';
const RECONNECT_MS    = parseInt(process.env.STRATEGY_RECONNECT_MS ?? '3000', 10);
const ERROR_COOLDOWN_MS = parseInt(process.env.STRATEGY_ERROR_COOLDOWN_MS ?? '60000', 10);
const DUST_WHOLE      = Number(process.env.STRATEGY_DUST_WHOLE ?? '0.000001'); // skip dust sells

const MIST_PER_SUI   = 1_000_000_000;
const TOKEN_DECIMALS = 6;
const VTOK           = 1_073_000_000; // virtual token reserve — same all versions

// ── Logging ───────────────────────────────────────────────────────────────────
const log = (...a) => console.log(`[brain]`, ...a);
const err = (...a) => console.error(`[brain]`, ...a);

// Never let the brain take the process down. server.js (foreground) is unaffected
// regardless, but we keep this loop alive too.
process.on('unhandledRejection', (e) => err('unhandledRejection:', e?.message ?? e));
process.on('uncaughtException',  (e) => err('uncaughtException:',  e?.message ?? e));

// ── Per-package virtual SUI — ported verbatim from indexer/api.js getVirtuals ──
// NOTE: frontend constants.js disagrees on V5/V6/V7 (9000/9000/3500). We use the
// indexer's values because the engine consumes indexer-derived reserves.
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
function priceFromReserve(vSui, newSuiReserveMist) {
  const realSui = Number(newSuiReserveMist ?? 0) / MIST_PER_SUI;
  const k = vSui * VTOK;
  return k > 0 ? ((vSui + realSui) * (vSui + realSui)) / k : 0;
}

const pkgFromEventType = (t) => (t || '').split('::')[0] || null;

// ── Order state ───────────────────────────────────────────────────────────────
// Order shape (v1):
// {
//   id, curveId, tokenType?, entryPriceSui?, minSuiOut?,
//   takeProfit: [ { multiple|priceSui, sellPct } ... ],   // generic ladder
//   stopLoss:   { multiple|priceSui } | null               // sells 100% remaining
// }
let ORDERS = [];

function normalizeOrder(o, i) {
  const id = o.id ?? `ord-${i + 1}`;
  if (!o.curveId) throw new Error(`order ${id}: curveId required`);
  const tp = Array.isArray(o.takeProfit) ? o.takeProfit.map(r => ({
    multiple: r.multiple != null ? Number(r.multiple) : null,
    priceSui: r.priceSui != null ? Number(r.priceSui) : null,
    sellPct:  Number(r.sellPct ?? 100),
    _fired:   false,
  })) : [];
  // ascending by effective threshold (multiple preferred, else absolute price)
  tp.sort((a, b) => (a.multiple ?? a.priceSui ?? Infinity) - (b.multiple ?? b.priceSui ?? Infinity));
  let sl = null;
  if (o.stopLoss && (o.stopLoss.multiple != null || o.stopLoss.priceSui != null)) {
    sl = {
      multiple: o.stopLoss.multiple != null ? Number(o.stopLoss.multiple) : null,
      priceSui: o.stopLoss.priceSui != null ? Number(o.stopLoss.priceSui) : null,
    };
  }
  if (!tp.length && !sl) throw new Error(`order ${id}: needs at least a takeProfit rung or a stopLoss`);
  return {
    id,
    curveId: o.curveId,
    tokenType: o.tokenType ?? null,
    entryPriceSui: o.entryPriceSui != null ? Number(o.entryPriceSui) : null,
    minSuiOut: Number(o.minSuiOut ?? 0),
    takeProfit: tp,
    stopLoss: sl,
    lastPrice: null,
    done: false,
    _cooldownUntil: 0,
  };
}

function loadOrders() {
  let raw = process.env.STRATEGY_ORDERS;
  if (!raw) {
    try { raw = fs.readFileSync(path.join(__dirname, 'orders.json'), 'utf8'); } catch {}
  }
  if (!raw) { log('no orders configured (set STRATEGY_ORDERS env or orders.json)'); return []; }
  let arr;
  try { arr = JSON.parse(raw); } catch (e) { err('orders parse failed:', e.message); return []; }
  if (!Array.isArray(arr)) { err('orders must be a JSON array'); return []; }
  const out = [];
  arr.forEach((o, i) => { try { out.push(normalizeOrder(o, i)); } catch (e) { err(e.message); } });
  return out;
}

// ── Serialized execution queue (one nexus sell at a time, globally) ───────────
const queue = [];
let running = false;
const firing = new Set(); // order ids queued-or-running (dedupe)

function pump() {
  if (running) return;
  const job = queue.shift();
  if (!job) return;
  running = true;
  Promise.resolve()
    .then(job)
    .catch((e) => err('job error:', e?.message ?? e))
    .finally(() => { running = false; pump(); });
}

function schedule(order) {
  if (order.done) return;
  if (firing.has(order.id)) return;
  if (Date.now() < order._cooldownUntil) return;
  firing.add(order.id);
  queue.push(async () => {
    try { await processOrder(order); }
    finally { firing.delete(order.id); }
  });
  pump();
}

// ── On-chain reads (GraphQL, read-only, no key) ───────────────────────────────
async function resolveTokenType(curveId) {
  const r = await fetch(`${INDEXER_URL}/token/${curveId}`, { signal: AbortSignal.timeout(6000) });
  if (!r.ok) throw new Error(`indexer /token ${r.status}`);
  const d = await r.json();
  const t = d.token_type ?? d.tokenType ?? null;
  if (!t) throw new Error('curve has no token_type yet (indexer not enriched)');
  return t;
}

async function getBalanceWhole(tokenType) {
  const query = `query($addr: SuiAddress!, $coinType: String!) {
    address(address: $addr) { balance(coinType: $coinType) { totalBalance } }
  }`;
  const r = await fetch(SUI_GRAPHQL_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables: { addr: INVOKER_ADDRESS, coinType: tokenType } }),
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) throw new Error(`graphql balance ${r.status}`);
  const d = await r.json();
  if (d.errors?.length) throw new Error(`graphql: ${d.errors[0].message}`);
  const atomic = d?.data?.address?.balance?.totalBalance ?? '0';
  return Number(BigInt(atomic)) / 10 ** TOKEN_DECIMALS;
}

// ── Fire a sell via the proven runner path (server.js signs) ──────────────────
async function fireSell(curveId, tokenWhole, minSuiOut) {
  const body = {
    workflow: 'sell',
    sell: {
      curveId,
      tokenAmount: Number(tokenWhole.toFixed(6)), // runner/bridge expect WHOLE tokens
      minSuiOut: minSuiOut ?? 0,
    },
  };
  const r = await fetch(`${RUNNER_URL}/run-dag`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(190000),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.ok) throw new Error(d.error ?? `runner ${r.status}`);
  return d; // { ok, executionId, digest, ... }
}

// ── Order evaluation ──────────────────────────────────────────────────────────
function slPrice(order)  { const s = order.stopLoss; return s ? (s.priceSui ?? order.entryPriceSui * s.multiple) : null; }
function rungPrice(order, r) { return r.priceSui ?? order.entryPriceSui * r.multiple; }

// Pick the next action at the current price, or null. Stop-loss wins.
function nextAction(order) {
  const price = order.lastPrice;
  if (price == null || order.entryPriceSui == null) return null;
  const sl = slPrice(order);
  if (sl != null && price <= sl) return { kind: 'SL', sellPct: 100, rung: null };
  for (const r of order.takeProfit) {
    if (r._fired) continue;
    if (price >= rungPrice(order, r)) return { kind: 'TP', sellPct: r.sellPct, rung: r };
  }
  return null;
}

async function processOrder(order) {
  if (order.done) return;
  if (!order.tokenType) {
    try { order.tokenType = await resolveTokenType(order.curveId); }
    catch (e) { err(`${order.id}: tokenType resolve failed: ${e.message}`); order._cooldownUntil = Date.now() + ERROR_COOLDOWN_MS; return; }
  }

  // Drain every crossed trigger in one pass (handles a big jump across rungs).
  while (!order.done) {
    const action = nextAction(order);
    if (!action) break;

    let balWhole;
    try { balWhole = await getBalanceWhole(order.tokenType); }
    catch (e) { err(`${order.id}: balance read failed: ${e.message}`); order._cooldownUntil = Date.now() + ERROR_COOLDOWN_MS; return; }

    if (!(balWhole > DUST_WHOLE)) {
      // Nothing to sell — mark this trigger consumed so we don't spin on it.
      log(`${order.id}: ${action.kind} crossed but balance is dust (${balWhole}); marking consumed`);
      if (action.kind === 'SL') order.done = true;
      else { action.rung._fired = true; if (order.takeProfit.every(r => r._fired)) order.done = true; }
      continue;
    }

    const sellWhole = action.sellPct >= 100 ? balWhole : balWhole * (action.sellPct / 100);
    if (!(sellWhole > DUST_WHOLE)) {
      if (action.rung) action.rung._fired = true;
      continue;
    }

    const mult = (order.lastPrice / order.entryPriceSui).toFixed(3);
    log(`${order.id}: ${action.kind} fire — price ${order.lastPrice.toExponential(4)} SUI (${mult}x), selling ${action.sellPct}% = ${sellWhole.toFixed(6)} tokens`);
    try {
      const receipt = await fireSell(order.curveId, sellWhole, order.minSuiOut);
      log(`${order.id}: SOLD — digest ${receipt.digest} execId ${receipt.executionId}`);
    } catch (e) {
      err(`${order.id}: sell failed: ${e.message}`);
      order._cooldownUntil = Date.now() + ERROR_COOLDOWN_MS;
      return; // leave trigger unfired; retry after cooldown on next trade
    }

    if (action.kind === 'SL') { order.done = true; break; }
    action.rung._fired = true;
    if (order.takeProfit.every(r => r._fired)) order.done = true;
  }

  if (order.done) log(`${order.id}: COMPLETE`);
}

// ── Price tick from SSE ───────────────────────────────────────────────────────
function onPrice(curveId, price) {
  for (const order of ORDERS) {
    if (order.done || order.curveId !== curveId) continue;
    if (order.entryPriceSui == null) {
      order.entryPriceSui = price;
      log(`${order.id}: entry price not provided — seeding from first observation ${price.toExponential(4)} SUI`);
    }
    order.lastPrice = price;
    schedule(order);
  }
}

function handleEvent(ev) {
  if (!ev || ev.type === 'connected') return;
  const isTrade = ev.type === 'TokensPurchased' || ev.type === 'TokensBought' || ev.type === 'TokensSold';
  if (!isTrade || !ev.curveId) return;
  const reserveMist = Number(ev.data?.new_sui_reserve ?? 0);
  if (!(reserveMist > 0)) return; // can't price without a reserve
  const vSui  = getVSui(pkgFromEventType(ev.eventType));
  const price = priceFromReserve(vSui, reserveMist);
  if (price > 0) onPrice(ev.curveId, price);
}

// ── SSE reader over fetch (no eventsource dependency) ─────────────────────────
async function streamSSE() {
  const url = `${INDEXER_URL}/stream`; // firehose, all curves
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

function main() {
  console.log('━'.repeat(52));
  console.log('  SUIPUMP STRATEGY BRAIN (TP/SL + generic ladder)');
  console.log('━'.repeat(52));
  log(`runner   : ${RUNNER_URL}`);
  log(`indexer  : ${INDEXER_URL}`);
  log(`graphql  : ${SUI_GRAPHQL_URL}`);
  log(`invoker  : ${INVOKER_ADDRESS}`);
  ORDERS = loadOrders();
  log(`orders   : ${ORDERS.length}`);
  ORDERS.forEach(o => log('  •', summarizeOrder(o)));
  streamSSE();
}

main();
