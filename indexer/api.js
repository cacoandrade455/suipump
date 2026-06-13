// api.js — REST API + SSE stream for SuiPump indexer
import express from 'express';
import pg from 'pg';
import cors from 'cors';
import {
  getGlobalStats, getTokenStats, getTradeHistory,
  getAllCurves, pool,
} from './db.js';
import { mountOrders } from './orders.js';

const PORT = parseInt(process.env.PORT || '3001');
const app  = express();
app.use(cors());
app.use(express.json());

// Strategy order store — self-contained module, owns its own strategy_orders
// table; does not touch db.js. Adds GET/POST/PATCH/DELETE /orders.
mountOrders(app);

// ── Virtual reserves per package — must match frontend constants.js ─────────
const MIST = 1_000_000_000;

// vTok = virtual token reserve (same across all versions — defines curve shape)
// vSui = virtual SUI reserve (varies per version — sets launch price)
function getVirtuals(packageId) {
  const vTok = 1_073_000_000; // all versions
  if (!packageId) return { vSui: 3500, vTok };
  if (packageId.startsWith('0x2154')) return { vSui: 30000, vTok }; // V4
  if (packageId.startsWith('0x785c')) return { vSui:  9000, vTok }; // V5: contract VIRTUAL_SUI_RESERVE = 9_000
  if (packageId.startsWith('0x21d5')) return { vSui:  9000, vTok }; // V6: contract VIRTUAL_SUI_RESERVE = 9_000
  if (packageId.startsWith('0xfb8f')) return { vSui:  3500, vTok }; // V7: contract VIRTUAL_SUI_RESERVE = 3_500 (lowered from 9k)
  if (packageId.startsWith('0x7196')) return { vSui:  4369, vTok }; // V9: contract VIRTUAL_SUI_RESERVE = 4_369
  return { vSui: 3500, vTok };                                        // V8, V8_1: contract VIRTUAL_SUI_RESERVE = 3_500
}

// Spot price in SUI per whole token — constant-product formula.
// price = (vSui + realSui)^2 / (vSui x vTok)
// Matches TokenPage header exactly. new_sui_reserve is in MIST.
function priceFromReserve(vSui, vTok, newSuiReserveMist) {
  const realSui = Number(newSuiReserveMist ?? 0) / MIST;
  const k = vSui * vTok;
  return k > 0 ? (vSui + realSui) * (vSui + realSui) / k : 0;
}

// ── SSE client registry ───────────────────────────────────────────────────────

const sseClients = new Map();
let   sseNextId  = 0;

export function emitEvent(eventType, parsedJson, curveId) {
  if (sseClients.size === 0) return;
  const payload = JSON.stringify({
    type:      eventType.split('::').pop(),
    eventType,
    curveId,
    data:      parsedJson,
    ts:        Date.now(),
  });
  const msg = `data: ${payload}\n\n`;
  for (const [id, client] of sseClients) {
    try {
      if (!client.curveId || client.curveId === curveId) {
        client.res.write(msg);
      }
    } catch { sseClients.delete(id); }
  }
}

// ── Health ────────────────────────────────────────────────────────────────────

app.get('/health', (req, res) => res.json({ status: 'ok', ts: Date.now() }));

// ── SSE stream ────────────────────────────────────────────────────────────────





app.get('/stream', (req, res) => {
  const curveId = req.query.curveId ?? null;
  const id      = sseNextId++;
  res.setHeader('Content-Type',      'text/event-stream');
  res.setHeader('Cache-Control',     'no-cache');
  res.setHeader('Connection',        'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  const heartbeat = setInterval(() => {
    try { res.write(': heartbeat\n\n'); }
    catch { clearInterval(heartbeat); sseClients.delete(id); }
  }, 30_000);
  sseClients.set(id, { res, curveId });
  res.write(`data: ${JSON.stringify({ type: 'connected', id })}\n\n`);
  req.on('close', () => { clearInterval(heartbeat); sseClients.delete(id); });
});


app.get('/stats', async (req, res) => {
  try {
    const stats = await getGlobalStats();
    const protocolFeesSui = stats.totalVolume * 0.005;
    const creatorFeesSui  = stats.totalVolume * 0.004;
    const s1PoolSui       = protocolFeesSui * 0.5;
    const [buySellRes, uniqueWalletsRes, graduatedRes] = await Promise.all([
      pool.query('SELECT COALESCE(SUM(buys),0) AS total_buys, COALESCE(SUM(sells),0) AS total_sells FROM token_stats'),
      pool.query(`SELECT COUNT(DISTINCT wallet) AS cnt FROM (SELECT data->>'buyer' AS wallet FROM events WHERE event_type LIKE '%TokensPurchased' OR event_type LIKE '%TokensBought' UNION SELECT data->>'seller' AS wallet FROM events WHERE event_type LIKE '%TokensSold') w WHERE wallet IS NOT NULL AND wallet != ''`),
      pool.query(`SELECT COUNT(*) AS cnt FROM curves WHERE graduated = true`),
    ]);
    res.json({ totalVolume: stats.totalVolume, totalTrades: stats.totalTrades, totalBuys: Number(buySellRes.rows[0]?.total_buys ?? 0), totalSells: Number(buySellRes.rows[0]?.total_sells ?? 0), tokenCount: stats.tokenCount, graduatedCount: Number(graduatedRes.rows[0]?.cnt ?? 0), uniqueWallets: Number(uniqueWalletsRes.rows[0]?.cnt ?? 0), protocolFeesSui, creatorFeesSui, s1PoolSui });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/tokens', async (req, res) => {
  try {
    const { creator } = req.query;
    if (creator) {
      const result = await pool.query(
        `SELECT c.curve_id AS "curveId", c.creator, c.name, c.symbol, c.description,
                c.icon_url AS "iconUrl", c.token_type AS "tokenType", c.package_id AS "packageId",
                c.created_at AS "createdAt", c.graduation_target AS "graduationTarget",
                c.anti_bot_delay AS "antiBotDelay", c.initial_shared_version AS "initialSharedVersion",
                row_to_json(s.*) AS stats
         FROM curves c LEFT JOIN token_stats s ON s.curve_id = c.curve_id
         WHERE lower(c.creator) = lower($1)
         ORDER BY c.created_at DESC`,
        [creator]
      );
      return res.json(result.rows);
    }
    res.json(await getAllCurves());
  }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/tokens/stats', async (req, res) => {
  try {
    const now = Date.now(), oneDayAgo = now - 86_400_000;
    const [statsRes, sparklineRes] = await Promise.all([
      pool.query(`SELECT ts.*, c.package_id FROM token_stats ts LEFT JOIN curves c ON c.curve_id = ts.curve_id`),
      pool.query(`SELECT e.curve_id, c.package_id, json_agg(json_build_object('t', e.timestamp_ms, 'r', (e.data->>'new_sui_reserve')::float) ORDER BY e.timestamp_ms ASC) AS points FROM events e LEFT JOIN curves c ON c.curve_id = e.curve_id WHERE (e.event_type LIKE '%TokensPurchased' OR e.event_type LIKE '%TokensBought' OR e.event_type LIKE '%TokensSold') AND e.timestamp_ms > $1 AND e.data->>'new_sui_reserve' IS NOT NULL GROUP BY e.curve_id, c.package_id`, [oneDayAgo]),
    ]);
    const sparklineMap = {};
    for (const row of sparklineRes.rows) {
      const { vSui, vTok } = getVirtuals(row.package_id);
      sparklineMap[row.curve_id] = (row.points || []).map(p => ({ t: Number(p.t), p: priceFromReserve(vSui, vTok, p.r) })).filter(p => p.p > 0 && p.t > 0);
    }
    res.json(statsRes.rows.map(s => {
      const { vSui, vTok } = getVirtuals(s.package_id);
      const startPrice = vSui / vTok;
      const lastPrice = s.reserve_sui > 0 ? priceFromReserve(vSui, vTok, s.reserve_sui * MIST) : (s.last_price ?? startPrice);
      return { ...s, start_price: startPrice, last_price: lastPrice, sparkline24h: sparklineMap[s.curve_id] || [] };
    }));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/token/:curveId', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT c.*, ts.volume_sui, ts.trades, ts.buys, ts.sells, ts.last_trade_time, ts.last_price, ts.first_price, ts.recent_trades, ts.comment_count, ts.reserve_sui, ts.creator_fees_sui, ts.updated_at, ts.volume_24h, c.graduated FROM curves c LEFT JOIN token_stats ts ON ts.curve_id = c.curve_id WHERE c.curve_id = $1`,
      [req.params.curveId]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Not found' });
    const row = result.rows[0];
    res.json({ ...row, stats: { ...row }, initialSharedVersion: row.initial_shared_version, initial_shared_version: row.initial_shared_version });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/token/:curveId/stats', async (req, res) => {
  try { const stats = await getTokenStats(req.params.curveId); if (!stats) return res.status(404).json({ error: 'Not found' }); res.json(stats); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/token/:curveId/trades', async (req, res) => {
  try { const limit = Math.min(parseInt(req.query.limit || '200'), 1000); res.json(await getTradeHistory(req.params.curveId, limit)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/token/:curveId/comments', async (req, res) => {
  try {
    const result = await pool.query(`SELECT tx_digest, event_seq, timestamp_ms, data FROM events WHERE curve_id = $1 AND event_type LIKE '%::bonding_curve::Comment' ORDER BY timestamp_ms ASC`, [req.params.curveId]);
    res.json(result.rows.map(r => ({ tx_digest: r.tx_digest, event_seq: r.event_seq, timestamp_ms: r.timestamp_ms, author: r.data?.author ?? null, text: r.data?.text ?? null })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/token/:curveId/ohlc', async (req, res) => {
  try {
    const result = await pool.query(`SELECT data, timestamp_ms, event_type, e.curve_id, c.package_id FROM events e LEFT JOIN curves c ON c.curve_id = e.curve_id WHERE e.curve_id = $1 AND (e.event_type LIKE '%TokensPurchased' OR e.event_type LIKE '%TokensBought' OR e.event_type LIKE '%TokensSold') ORDER BY timestamp_ms ASC`, [req.params.curveId]);
    res.json(result.rows.map(row => { const d = row.data; const ts = row.timestamp_ms ? Math.floor(Number(row.timestamp_ms) / 1000) : 0; const isBuy = row.event_type.includes('TokensPurchased') || row.event_type.includes('TokensBought'); const { vSui, vTok } = getVirtuals(row.package_id); return { time: ts, price: priceFromReserve(vSui, vTok, d.new_sui_reserve ?? 0), kind: isBuy ? 'buy' : 'sell', sui: isBuy ? Number(d.sui_in ?? 0) / MIST : Number(d.sui_out ?? 0) / MIST }; }));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/token/:curveId/holders', async (req, res) => {
  try {
    const TOK = 1_000_000;
    const [buysRes, sellsRes] = await Promise.all([
      pool.query(`SELECT data->>'buyer' AS address, SUM((data->>'tokens_out')::float) AS tokens FROM events WHERE curve_id = $1 AND (event_type LIKE '%TokensPurchased' OR event_type LIKE '%TokensBought') GROUP BY data->>'buyer'`, [req.params.curveId]),
      pool.query(`SELECT data->>'seller' AS address, SUM((data->>'tokens_in')::float) AS tokens FROM events WHERE curve_id = $1 AND event_type LIKE '%TokensSold' GROUP BY data->>'seller'`, [req.params.curveId]),
    ]);
    const hmap = {};
    for (const r of buysRes.rows) { if (r.address) hmap[r.address] = (hmap[r.address] ?? 0) + Number(r.tokens ?? 0) / TOK; }
    for (const r of sellsRes.rows) { if (r.address) hmap[r.address] = (hmap[r.address] ?? 0) - Number(r.tokens ?? 0) / TOK; }
    res.json(Object.entries(hmap).filter(([, b]) => b > 0.0001).map(([address, balance]) => ({ address, balance })).sort((a, b) => b.balance - a.balance));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/trades/recent', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || '50'), 200);
    const result = await pool.query(`SELECT e.data, e.timestamp_ms, e.event_type, e.curve_id, c.name, c.symbol FROM events e LEFT JOIN curves c ON c.curve_id = e.curve_id WHERE (e.event_type LIKE '%TokensPurchased' OR e.event_type LIKE '%TokensBought' OR e.event_type LIKE '%TokensSold') ORDER BY e.timestamp_ms DESC LIMIT $1`, [limit]);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Trending feed — 1h rolling momentum score.
// score = (volume_1h × buy_ratio) + (unique_buyers_1h × K) + price_change_bonus
//   volume_1h        = sum of sui_in (buys) + sui_out (sells) over last hour, in SUI
//   buy_ratio        = buy_volume / total_volume  (rewards buy pressure)
//   unique_buyers_1h = distinct buyer addresses last hour (hardest signal to fake)
//   price_change_bonus = (last_reserve - first_reserve) / first_reserve, capped, ×weight
app.get('/trending', async (req, res) => {
  try {
    const limit   = Math.min(parseInt(req.query.limit || '10'), 50);
    const K        = 5;     // weight per unique buyer (in SUI-equivalent points)
    const PRICE_W  = 50;    // weight on fractional price change

    const runQuery = async (sinceMs) => pool.query(
      `WITH window_events AS (
         SELECT
           e.curve_id,
           e.event_type,
           e.timestamp_ms,
           (e.data->>'sui_in')::float          / 1e9 AS sui_in,
           (e.data->>'sui_out')::float         / 1e9 AS sui_out,
           (e.data->>'new_sui_reserve')::float / 1e9 AS reserve,
           e.data->>'buyer'                          AS buyer
         FROM events e
         WHERE (e.event_type LIKE '%TokensPurchased' OR e.event_type LIKE '%TokensBought' OR e.event_type LIKE '%TokensSold')
           AND e.timestamp_ms > $1
       ),
       agg AS (
         SELECT
           curve_id,
           COALESCE(SUM(sui_in),  0)                                  AS buy_vol,
           COALESCE(SUM(sui_out), 0)                                  AS sell_vol,
           COALESCE(SUM(sui_in), 0) + COALESCE(SUM(sui_out), 0)       AS total_vol,
           COUNT(*)                                                   AS trade_count,
           COUNT(DISTINCT buyer) FILTER (WHERE buyer IS NOT NULL)     AS unique_buyers,
           (ARRAY_AGG(reserve ORDER BY timestamp_ms ASC)  FILTER (WHERE reserve IS NOT NULL))[1] AS first_reserve,
           (ARRAY_AGG(reserve ORDER BY timestamp_ms DESC) FILTER (WHERE reserve IS NOT NULL))[1] AS last_reserve
         FROM window_events
         GROUP BY curve_id
       )
       SELECT
         a.curve_id,
         c.name, c.symbol, c.icon_url, c.package_id, c.graduated, c.graduation_target,
         a.buy_vol, a.sell_vol, a.total_vol, a.trade_count, a.unique_buyers,
         a.first_reserve, a.last_reserve,
         (
           a.total_vol * (CASE WHEN a.total_vol > 0 THEN a.buy_vol / a.total_vol ELSE 0 END)
           + a.unique_buyers * $2
           + (CASE WHEN a.first_reserve > 0
                   THEN LEAST(GREATEST((a.last_reserve - a.first_reserve) / a.first_reserve, -1), 5) * $3
                   ELSE 0 END)
         ) AS momentum_score
       FROM agg a
       LEFT JOIN curves c ON c.curve_id = a.curve_id
       WHERE a.total_vol > 0 AND COALESCE(c.graduated, false) = false
       ORDER BY momentum_score DESC
       LIMIT $4`,
      [sinceMs, K, PRICE_W, limit]
    );

    // Primary: 1h rolling window. Fallback: if fewer than 5 results
    // (quiet period / testnet), widen to 24h so the bar still populates.
    let result = await runQuery(Date.now() - 60 * 60 * 1000);
    if (result.rows.length < 5) {
      result = await runQuery(Date.now() - 24 * 60 * 60 * 1000);
    }
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/leaderboard/volume', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || '20'), 100);
    res.json((await pool.query(`SELECT ts.curve_id, c.name, c.symbol, c.icon_url, c.package_id, ts.volume_sui, ts.trades, ts.buys, ts.sells, ts.last_price, ts.reserve_sui FROM token_stats ts LEFT JOIN curves c ON c.curve_id = ts.curve_id ORDER BY ts.volume_sui DESC LIMIT $1`, [limit])).rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/leaderboard/traders', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || '20'), 100);
    const MIST_L = 1_000_000_000;
    const [buysRes, sellsRes] = await Promise.all([
      pool.query(`SELECT data->>'buyer' AS address, SUM((data->>'sui_in')::float) AS sui_spent FROM events WHERE (event_type LIKE '%TokensPurchased' OR event_type LIKE '%TokensBought') GROUP BY data->>'buyer'`),
      pool.query(`SELECT data->>'seller' AS address, SUM((data->>'sui_out')::float) AS sui_received FROM events WHERE event_type LIKE '%TokensSold' GROUP BY data->>'seller'`),
    ]);
    const tm = {};
    for (const r of buysRes.rows) { const a = r.address; if (!a) continue; if (!tm[a]) tm[a] = { address: a, sui_spent: 0, sui_received: 0, buys: 0, sells: 0 }; tm[a].sui_spent += Number(r.sui_spent ?? 0) / MIST_L; tm[a].buys++; }
    for (const r of sellsRes.rows) { const a = r.address; if (!a) continue; if (!tm[a]) tm[a] = { address: a, sui_spent: 0, sui_received: 0, buys: 0, sells: 0 }; tm[a].sui_received += Number(r.sui_received ?? 0) / MIST_L; tm[a].sells++; }
    res.json(Object.values(tm).sort((a, b) => (b.sui_spent + b.sui_received) - (a.sui_spent + a.sui_received)).slice(0, limit));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/trader/:address', async (req, res) => {
  try {
    const { address } = req.params;
    const MIST_L = 1_000_000_000, TOK = 1_000_000;
    const [buysRes, sellsRes] = await Promise.all([
      pool.query(`SELECT e.curve_id, c.name, c.symbol, c.token_type, c.package_id, c.icon_url, c.graduated, COUNT(*) AS buy_count, SUM((data->>'sui_in')::float) AS sui_spent, SUM((data->>'tokens_out')::float) AS tokens_bought, MAX(e.timestamp_ms::bigint) AS last_buy_time, MAX((data->>'new_sui_reserve')::float) AS last_reserve_mist FROM events e LEFT JOIN curves c ON c.curve_id = e.curve_id WHERE (event_type LIKE '%TokensPurchased' OR event_type LIKE '%TokensBought') AND data->>'buyer' = $1 GROUP BY e.curve_id, c.name, c.symbol, c.token_type, c.package_id, c.icon_url, c.graduated`, [address]),
      pool.query(`SELECT e.curve_id, COUNT(*) AS sell_count, SUM((data->>'sui_out')::float) AS sui_received, SUM((data->>'tokens_in')::float) AS tokens_sold FROM events e WHERE event_type LIKE '%TokensSold' AND data->>'seller' = $1 GROUP BY e.curve_id`, [address]),
    ]);
    const cm = {};
    for (const r of buysRes.rows) { cm[r.curve_id] = { curve_id: r.curve_id, name: r.name, symbol: r.symbol, token_type: r.token_type, package_id: r.package_id, icon_url: r.icon_url, graduated: r.graduated, sui_spent: Number(r.sui_spent ?? 0) / MIST_L, tokens_bought: Number(r.tokens_bought ?? 0) / TOK, sui_received: 0, tokens_sold: 0, buys: Number(r.buy_count ?? 0), sells: 0, last_reserve_mist: r.last_reserve_mist }; }
    for (const r of sellsRes.rows) { if (!cm[r.curve_id]) cm[r.curve_id] = { curve_id: r.curve_id, sui_spent: 0, tokens_bought: 0, sui_received: 0, tokens_sold: 0, buys: 0, sells: 0 }; cm[r.curve_id].sui_received += Number(r.sui_received ?? 0) / MIST_L; cm[r.curve_id].tokens_sold += Number(r.tokens_sold ?? 0) / TOK; cm[r.curve_id].sells = Number(r.sell_count ?? 0); }
    res.json(Object.values(cm).map(c => ({ ...c, net_tokens: c.tokens_bought - c.tokens_sold, avg_entry_price: c.tokens_bought > 0 ? c.sui_spent / c.tokens_bought : 0, reserve_sui: Number(c.last_reserve_mist ?? 0) / MIST_L })).sort((a, b) => (b.sui_spent + b.sui_received) - (a.sui_spent + a.sui_received)));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── /token/:id/locks?owner=:address ──────────────────────────────────────────
// Returns lock_ids for a beneficiary on a specific curve.
app.get('/token/:id/locks', async (req, res) => {
  try {
    const { id } = req.params;
    const { owner } = req.query;
    if (!owner) return res.status(400).json({ error: 'owner param required' });

    const result = await pool.query(
      `SELECT lock_id, total_amount, claimed,
              (total_amount - claimed) AS locked,
              start_ms, duration_ms, mode, beneficiary
       FROM vesting_locks
       WHERE curve_id = $1 AND beneficiary = $2
       ORDER BY start_ms DESC`,
      [id, owner]
    );
    res.json(result.rows);
  } catch (err) {
    // Table may not exist yet — return empty array gracefully
    res.json([]);
  }
});

// ── /lock/:lockId ─────────────────────────────────────────────────────────────
// Returns details for a single VestingLock by its object ID.
app.get('/lock/:lockId', async (req, res) => {
  try {
    const { lockId } = req.params;
    const result = await pool.query(
      `SELECT lock_id, curve_id, beneficiary,
              total_amount, claimed,
              (total_amount - claimed) AS locked,
              start_ms, duration_ms, mode
       FROM vesting_locks
       WHERE lock_id = $1`,
      [lockId]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'lock not found' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});




// ── /internal/store-metadata-isv (POST) ──────────────────────────────────────
app.post('/internal/store-metadata-isv', async (req, res) => {
  try {
    const { curveId, metadataObjectId, initialSharedVersion } = req.body;
    if (!curveId || !metadataObjectId) return res.status(400).json({ error: 'missing fields' });
    await pool.query(
      'UPDATE curves SET metadata_object_id = $2, metadata_shared_version = $3 WHERE curve_id = $1',
      [curveId, metadataObjectId, initialSharedVersion ?? null]
    );
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Agent DAG runs (in-memory; demo-scale) ────────────────────────────────────
// The operator runs `nexus dag execute … --json | curl … /internal/agent-run`.
// AgentPage.jsx polls /internal/agent-run/latest (and /:id) to render the real
// on-chain Nexus DAGExecution. Stored in memory — fine for a demo, resets on
// redeploy. No DB schema change required.
const agentRuns = [];                 // newest-last
const MAX_AGENT_RUNS = 50;

// Normalize the `nexus dag execute --json` payload (shape varies by CLI version)
// into { executionId, dagId, vertices, curveId, txDigest, status, finished, receivedAt }.
function normalizeAgentRun(raw) {
  const rec = {
    executionId: null, dagId: null, vertices: {},
    curveId: null, txDigest: null, status: null, checkpoint: null,
    finished: false, receivedAt: Date.now(),
  };
  if (!raw || typeof raw !== 'object') return rec;

  // `nexus dag execute --json` returns the submission receipt:
  //   { digest, execution_id, tx_checkpoint }
  // Per-vertex Ok/Err lives on the DAGExecution object / `nexus dag inspect`,
  // not here — so we record the on-chain execution id + digest and mark it
  // submitted. The UI reads vertex detail from chain (or shows it submitted).
  rec.executionId = raw.execution_id ?? raw.executionId ?? raw.dag_execution_id
                 ?? raw.dagExecutionId ?? raw.objectId ?? null;
  rec.txDigest    = raw.digest ?? raw.tx_digest ?? raw.txDigest ?? null;
  rec.checkpoint  = raw.tx_checkpoint ?? raw.checkpoint ?? null;
  rec.dagId       = raw.dagId ?? raw.dag_id ?? raw.dag ?? null;
  rec.status      = raw.status ?? (rec.executionId ? 'submitted' : null);

  // If a richer payload ever includes vertices/results, parse them too.
  const setVertex = (name, variant, ports) => {
    if (!name) return;
    const key = String(name).replace(/^Plain\(|\)$/g, '');
    rec.vertices[key] = variant === 'Ok' ? 'Ok'
                      : (variant === 'Err' || variant === '_err_eval') ? 'Err'
                      : variant ?? 'pending';
    const cid = ports?.curve_id ?? ports?.curveId;
    if (cid && !rec.curveId) rec.curveId = cid;
  };
  if (raw.vertices && typeof raw.vertices === 'object' && !Array.isArray(raw.vertices)) {
    for (const [name, v] of Object.entries(raw.vertices)) {
      setVertex(name, v?.variant ?? v?.output_variant ?? v, v?.ports ?? v?.data ?? {});
    }
  } else if (Array.isArray(raw.results)) {
    for (const v of raw.results) {
      setVertex(v.vertex ?? v.name, v.variant ?? v.output_variant, v.ports ?? v.data ?? {});
    }
  }
  if (!rec.curveId) rec.curveId = raw.curveId ?? raw.curve_id ?? null;

  const states = Object.values(rec.vertices);
  rec.finished = rec.status === 'submitted' || (states.length > 0 && states.every(s => s === 'Ok' || s === 'Err'));
  return rec;
}

// POST /internal/agent-run — operator's CLI output lands here.
app.post('/internal/agent-run', async (req, res) => {
  try {
    const rec = normalizeAgentRun(req.body);
    agentRuns.push(rec);
    if (agentRuns.length > MAX_AGENT_RUNS) agentRuns.shift();
    res.json({ ok: true, executionId: rec.executionId });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /internal/agent-run/latest?since=<ms> — newest run (optionally newer than `since`).
app.get('/internal/agent-run/latest', async (req, res) => {
  const since = Number(req.query.since ?? 0);
  for (let i = agentRuns.length - 1; i >= 0; i--) {
    if (agentRuns[i].receivedAt >= since) return res.json(agentRuns[i]);
  }
  res.json(null);
});

// GET /internal/agent-run/:id — a specific DAGExecution by id (paste fallback).
app.get('/internal/agent-run/:id', async (req, res) => {
  const { id } = req.params;
  const found = [...agentRuns].reverse().find(r => r.executionId === id);
  res.json(found ?? null);
});

// ── /debug/isv/:id ────────────────────────────────────────────────────────────
app.get('/debug/isv/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const GRAPHQL_URL = process.env.SUI_GRAPHQL_URL ?? 'https://graphql.testnet.sui.io/graphql';

    // Get curve tx digest
    const evtRow = await pool.query(
      "SELECT tx_digest FROM events WHERE curve_id = $1 AND event_type LIKE '%CurveCreated' LIMIT 1",
      [id]
    );
    const curveTxDigest = evtRow.rows[0]?.tx_digest ?? null;

    // Get metadata object id
    const curveRow = await pool.query('SELECT metadata_object_id FROM curves WHERE curve_id = $1', [id]);
    const objectId = curveRow.rows[0]?.metadata_object_id ?? null;

    // Get dependencies of curve tx
    let deps = [], depResults = [];
    if (curveTxDigest) {
      const r2 = await fetch(GRAPHQL_URL, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: '{ transactionBlock(digest: "' + curveTxDigest + '") { effects { dependencies { digest } } } }' }),
        signal: AbortSignal.timeout(8000),
      });
      const d2 = await r2.json();
      deps = d2?.data?.transactionBlock?.effects?.dependencies ?? [];

      // Check each dep for the metadata object
      for (const dep of deps) {
        const r3 = await fetch(GRAPHQL_URL, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: '{ transactionBlock(digest: "' + dep.digest + '") { effects { objectChanges { nodes { address outputState { version } } } } } }' }),
          signal: AbortSignal.timeout(8000),
        });
        const d3 = await r3.json();
        const changes = d3?.data?.transactionBlock?.effects?.objectChanges?.nodes ?? [];
        const found = changes.find(c => c.address === objectId);
        depResults.push({ digest: dep.digest, changeCount: changes.length, foundMetadata: !!found, version: found?.outputState?.version ?? null });
      }
    }

    res.json({ curveTxDigest, objectId, deps: deps.map(d => d.digest), depResults });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── /debug/clear-metadata-isv/:id ────────────────────────────────────────────
app.get('/debug/clear-metadata-isv/:id', async (req, res) => {
  try {
    await pool.query('UPDATE curves SET metadata_shared_version = NULL WHERE curve_id = $1', [req.params.id]);
    res.json({ cleared: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── /token/:id/metadata-object ────────────────────────────────────────────────
app.get('/token/:id/metadata-object', async (req, res) => {
  try {
    const { id } = req.params;
    const row = await pool.query(
      'SELECT token_type, metadata_object_id, metadata_shared_version, package_id FROM curves WHERE curve_id = $1',
      [id]
    );
    if (!row.rows.length) return res.status(404).json({ error: 'curve not found' });
    const { token_type: tokenType, metadata_object_id, metadata_shared_version, package_id: curvePkgId } = row.rows[0];
    if (!tokenType) return res.status(404).json({ error: 'token_type not found' });

    if (metadata_object_id && metadata_shared_version) {
      return res.json({ objectId: metadata_object_id, initialSharedVersion: Number(metadata_shared_version), tokenType });
    }

    const GRAPHQL_URL = process.env.SUI_GRAPHQL_URL ?? 'https://graphql.testnet.sui.io/graphql';

    // Get objectId
    let objectId = metadata_object_id ?? null;
    if (!objectId) {
      const r1 = await fetch(GRAPHQL_URL, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: '{ coinMetadata(coinType: "' + tokenType + '") { address } }' }),
        signal: AbortSignal.timeout(8000),
      });
      const d1 = await r1.json();
      objectId = d1?.data?.coinMetadata?.address ?? null;
    }
    if (!objectId) return res.status(404).json({ error: 'CoinMetadata not found on-chain' });

    // Get ISV by querying the package that contains the token type
    // The token type package was published in Tx1 which also created CoinMetadata
    let isv = null;
    const tokenPkg = tokenType.split('::')[0];
    if (tokenPkg) {
      // Query the package publish tx — it created the metadata object
      const q2 = '{ object(address: "' + tokenPkg + '") { previousTransactionBlock { digest } } }';
      const r2 = await fetch(GRAPHQL_URL, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: q2 }), signal: AbortSignal.timeout(8000),
      });
      const d2 = await r2.json();
      const publishDigest = d2?.data?.object?.previousTransactionBlock?.digest ?? null;

      if (publishDigest) {
        const q3 = '{ transactionBlock(digest: "' + publishDigest + '") { effects { objectChanges { nodes { address outputState { version } } } } } }';
        const r3 = await fetch(GRAPHQL_URL, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: q3 }), signal: AbortSignal.timeout(8000),
        });
        const d3 = await r3.json();
        const changes = d3?.data?.transactionBlock?.effects?.objectChanges?.nodes ?? [];
        const metaChange = changes.find(c => c.address === objectId);
        if (metaChange?.outputState?.version) {
          isv = Number(metaChange.outputState.version);
        }
      }
    }

    if (isv) {
      await pool.query(
        'UPDATE curves SET metadata_object_id = $2, metadata_shared_version = $3 WHERE curve_id = $1',
        [id, objectId, isv]
      );
    }

    res.json({ objectId, initialSharedVersion: isv, tokenType });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

async function startPgListener() {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  try {
    await client.connect();
    await client.query('LISTEN suipump_events');
    client.on('notification', (msg) => { try { const event = JSON.parse(msg.payload); emitEvent(event.eventType, event.data, event.curveId); } catch {} });
    client.on('error', (err) => { console.error('  PG listener error:', err.message); client.end().catch(() => {}); setTimeout(startPgListener, 5_000); });
    console.log('  ✓ PostgreSQL LISTEN active — suipump_events');
  } catch (err) { console.error('  PG listener connect failed:', err.message); setTimeout(startPgListener, 5_000); }
}

export function startApi() {
  app.listen(PORT, () => console.log(`  ✓ API listening on port ${PORT}`));
  startPgListener().catch(err => console.error('PG listener failed:', err.message));
}
