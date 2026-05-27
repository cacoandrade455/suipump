// api.js — REST API + SSE stream for SuiPump indexer
import express from 'express';
import pg from 'pg';
import cors from 'cors';
import {
  getGlobalStats, getTokenStats, getTradeHistory,
  getAllCurves, pool,
} from './db.js';

const PORT = parseInt(process.env.PORT || '3001');
const app  = express();
app.use(cors());
app.use(express.json());

// ── Virtual reserves per package — must match frontend curve.js ───────────────
const MIST         = 1_000_000_000;
const TOTAL_SUPPLY = 1_000_000_000; // 1B tokens

function getVirtuals(packageId) {
  if (!packageId) return { vSui: 3500 };
  if (packageId.startsWith('0x2154')) return { vSui: 30000 }; // V4
  if (packageId.startsWith('0x785c')) return { vSui: 10000 }; // V5
  if (packageId.startsWith('0x21d5')) return { vSui: 10000 }; // V6
  if (packageId.startsWith('0xfb8f')) return { vSui: 5000  }; // V7
  if (packageId.startsWith('0x7196')) return { vSui: 4369  }; // V9
  return { vSui: 3500 };                                        // V8, V8_1
}

// price = (virtualSui + realSuiReserve) / TOTAL_SUPPLY
// This formula matches the OHLC chart and token page header exactly.
// new_sui_reserve is in MIST — convert to SUI first.
function priceFromReserve(vSui, newSuiReserveMist) {
  const totalPoolSui = vSui + Number(newSuiReserveMist ?? 0) / MIST;
  return totalPoolSui / TOTAL_SUPPLY;
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

  req.on('close', () => {
    clearInterval(heartbeat);
    sseClients.delete(id);
  });
});

// ── Global stats ──────────────────────────────────────────────────────────────

app.get('/stats', async (req, res) => {
  try {
    const stats = await getGlobalStats();
    const protocolFeesSui = stats.totalVolume * 0.005;
    const creatorFeesSui  = stats.totalVolume * 0.004; // 40% of 1% fee
    const s1PoolSui       = protocolFeesSui * 0.5;

    const [buySellRes, uniqueWalletsRes, graduatedRes] = await Promise.all([
      pool.query('SELECT COALESCE(SUM(buys),0) AS total_buys, COALESCE(SUM(sells),0) AS total_sells FROM token_stats'),
      pool.query(`
        SELECT COUNT(DISTINCT wallet) AS cnt FROM (
          SELECT data->>'buyer'  AS wallet FROM events WHERE event_type LIKE '%TokensPurchased' OR event_type LIKE '%TokensBought'
          UNION
          SELECT data->>'seller' AS wallet FROM events WHERE event_type LIKE '%TokensSold'
        ) w WHERE wallet IS NOT NULL AND wallet != ''
      `),
      pool.query(`SELECT COUNT(*) AS cnt FROM curves WHERE graduated = true`),
    ]);

    res.json({
      totalVolume:    stats.totalVolume,
      totalTrades:    stats.totalTrades,
      totalBuys:      Number(buySellRes.rows[0].total_buys),
      totalSells:     Number(buySellRes.rows[0].total_sells),
      tokenCount:     stats.tokenCount,
      graduatedCount: Number(graduatedRes.rows[0].cnt),
      uniqueWallets:  Number(uniqueWalletsRes.rows[0].cnt),
      protocolFeesSui,
      creatorFeesSui,
      s1PoolSui,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── All tokens ────────────────────────────────────────────────────────────────

app.get('/tokens', async (req, res) => {
  try {
    const { creator } = req.query;
    if (creator) {
      const result = await pool.query(
        `SELECT c.curve_id AS "curveId", c.creator, c.name, c.symbol,
                c.icon_url AS "iconUrl", c.token_type AS "tokenType",
                c.package_id AS "packageId", c.created_at AS "createdAt",
                c.graduated
         FROM curves c WHERE c.creator = $1 ORDER BY c.created_at DESC`,
        [creator]
      );
      return res.json(result.rows);
    }
    res.json(await getAllCurves());
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Single token ──────────────────────────────────────────────────────────────

app.get('/token/:curveId', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT c.*, row_to_json(s.*) AS stats
       FROM curves c LEFT JOIN token_stats s ON s.curve_id = c.curve_id
       WHERE c.curve_id = $1`, [req.params.curveId]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Not found' });
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Single token stats ────────────────────────────────────────────────────────

app.get('/token/:curveId/stats', async (req, res) => {
  try {
    const stats = await getTokenStats(req.params.curveId);
    if (!stats) return res.status(404).json({ error: 'Not found' });
    res.json(stats);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Trade history ─────────────────────────────────────────────────────────────

app.get('/token/:curveId/trades', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || '200'), 1000);
    res.json(await getTradeHistory(req.params.curveId, limit));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Token comments ────────────────────────────────────────────────────────────

app.get('/token/:curveId/comments', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT tx_digest, event_seq, timestamp_ms, data
       FROM events
       WHERE curve_id = $1
         AND event_type LIKE '%::bonding_curve::Comment'
       ORDER BY timestamp_ms ASC`,
      [req.params.curveId]
    );
    // Flatten data fields to top level so frontend reads r.author / r.text directly
    res.json(result.rows.map(r => ({
      tx_digest:    r.tx_digest,
      event_seq:    r.event_seq,
      timestamp_ms: r.timestamp_ms,
      author:       r.data?.author ?? null,
      text:         r.data?.text   ?? null,
    })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── OHLC chart data ───────────────────────────────────────────────────────────

app.get('/token/:curveId/ohlc', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT data, timestamp_ms, event_type, e.curve_id, c.package_id
       FROM events e
       LEFT JOIN curves c ON c.curve_id = e.curve_id
       WHERE e.curve_id = $1
         AND (e.event_type LIKE '%TokensPurchased' OR e.event_type LIKE '%TokensBought' OR e.event_type LIKE '%TokensSold')
       ORDER BY timestamp_ms ASC`,
      [req.params.curveId]
    );

    const points = result.rows.map(row => {
      const d    = row.data;
      const ts   = row.timestamp_ms ? Math.floor(Number(row.timestamp_ms) / 1000) : 0;
      const isBuy = row.event_type.includes('TokensPurchased') || row.event_type.includes('TokensBought');
      const { vSui } = getVirtuals(row.package_id);
      const price = priceFromReserve(vSui, d.new_sui_reserve ?? 0);
      return { time: ts, price, kind: isBuy ? 'buy' : 'sell' };
    }).filter(p => p && p.price > 0 && p.time > 0);

    res.json(points);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Creator cap lookup ───────────────────────────────────────────────────────
// Returns the CreatorCap objectId for a given curve + owner wallet.
// Frontend uses this to avoid GraphQL CORS issues when claiming fees.

app.get('/token/:curveId/creator-cap', async (req, res) => {
  try {
    const { curveId } = req.params;
    const { owner } = req.query;
    if (!owner) return res.status(400).json({ error: 'owner query param required' });

    // Look up curve's package_id so we know the CreatorCap type
    const curveRes = await pool.query('SELECT package_id FROM curves WHERE curve_id = $1', [curveId]);
    if (!curveRes.rows.length) return res.status(404).json({ error: 'curve not found' });
    const packageId = curveRes.rows[0].package_id;
    if (!packageId) return res.status(404).json({ error: 'package_id not found for curve' });

    // Query GraphQL for owned CreatorCap objects matching this curve
    const { SuiGraphQLClient } = await import('@mysten/sui/graphql');
    const NETWORK = process.env.NETWORK ?? 'testnet';
    const GRAPHQL_URL = process.env.SUI_GRAPHQL_URL ?? `https://graphql.${NETWORK}.sui.io/graphql`;
    const gqlClient = new SuiGraphQLClient({ url: GRAPHQL_URL });

    const gql = `{
      owner(address: "${owner}") {
        objects(filter: { type: "${packageId}::bonding_curve::CreatorCap" }) {
          nodes {
            address
            contents { json }
          }
        }
      }
    }`;
    const result = await gqlClient.graphql({ query: gql });
    const nodes = result?.data?.owner?.objects?.nodes ?? [];
    const cap = nodes.find(n => n.contents?.json?.curve_id === curveId);
    if (!cap) return res.status(404).json({ error: 'CreatorCap not found for this wallet' });
    res.json({ objectId: cap.address });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Token holders ─────────────────────────────────────────────────────────────

app.get('/token/:curveId/holders', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT
         COALESCE(data->>'buyer', data->>'seller') AS address,
         SUM(CASE
           WHEN event_type LIKE '%TokensPurchased' OR event_type LIKE '%TokensBought'
             THEN (data->>'tokens_out')::float
           ELSE -(data->>'tokens_in')::float
         END) AS balance
       FROM events
       WHERE curve_id = $1
         AND (event_type LIKE '%TokensPurchased' OR event_type LIKE '%TokensBought' OR event_type LIKE '%TokensSold')
       GROUP BY address
       HAVING SUM(CASE
         WHEN event_type LIKE '%TokensPurchased' OR event_type LIKE '%TokensBought'
           THEN (data->>'tokens_out')::float
         ELSE -(data->>'tokens_in')::float
       END) > 0
       ORDER BY balance DESC
       LIMIT 100`,
      [req.params.curveId]
    );
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Token stats for homepage ──────────────────────────────────────────────────
// CRITICAL: sparkline price uses (vSui + new_sui_reserve) / 1B
// This matches the OHLC chart and token page header exactly.
// DO NOT use sui_in/tokens_out — that's the trade ratio, not the curve price.

app.get('/tokens/stats', async (req, res) => {
  try {
    const now       = Date.now();
    const oneDayAgo = now - 86_400_000;

    const [statsRes, sparklineRes] = await Promise.all([
      // Include package_id so we can compute vSui per token
      pool.query(`
        SELECT ts.*, c.package_id
        FROM token_stats ts
        LEFT JOIN curves c ON c.curve_id = ts.curve_id
      `),
      // Sparkline: use new_sui_reserve + virtual reserves for correct price
      // Join curves to get package_id for vSui lookup
      pool.query(
        `SELECT e.curve_id, c.package_id,
                json_agg(
                  json_build_object(
                    't', e.timestamp_ms,
                    'r', (e.data->>'new_sui_reserve')::float
                  )
                  ORDER BY e.timestamp_ms ASC
                ) AS points
         FROM events e
         LEFT JOIN curves c ON c.curve_id = e.curve_id
         WHERE (e.event_type LIKE '%TokensPurchased'
             OR e.event_type LIKE '%TokensBought'
             OR e.event_type LIKE '%TokensSold')
           AND e.timestamp_ms > $1
           AND e.data->>'new_sui_reserve' IS NOT NULL
         GROUP BY e.curve_id, c.package_id`,
        [oneDayAgo]
      ),
    ]);

    // Build sparkline map using correct price formula
    const sparklineMap = {};
    for (const row of sparklineRes.rows) {
      const { vSui } = getVirtuals(row.package_id);
      const points = (row.points || [])
        .map(p => ({ t: Number(p.t), p: priceFromReserve(vSui, p.r) }))
        .filter(p => p.p > 0 && p.t > 0);
      sparklineMap[row.curve_id] = points;
    }

    // Also compute start_price for tokens with no trades (correct start mcap display)
    const response = statsRes.rows.map(s => {
      const { vSui } = getVirtuals(s.package_id);
      // start_price = virtual pool / total supply (no real reserves)
      const startPrice = vSui / TOTAL_SUPPLY;
      // last_price: use reserve_sui if available (set by recomputeStats),
      // otherwise fall back to start_price
      const lastPrice = s.reserve_sui > 0
        ? priceFromReserve(vSui, s.reserve_sui * MIST)
        : (s.last_price ?? startPrice);

      return {
        ...s,
        last_price:   lastPrice,
        start_price:  startPrice,
        sparkline24h: sparklineMap[s.curve_id] || [],
      };
    });

    res.json(response);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── All tokens stats (for homepage cards with no trade data) ──────────────────
// Returns start_price for ALL curves including those with zero trades

app.get('/tokens/start-prices', async (req, res) => {
  try {
    const result = await pool.query('SELECT curve_id, package_id FROM curves');
    const out = result.rows.map(r => {
      const { vSui } = getVirtuals(r.package_id);
      return { curve_id: r.curve_id, start_price: vSui / TOTAL_SUPPLY };
    });
    res.json(out);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Trader portfolio ──────────────────────────────────────────────────────────

app.get('/trader/:address', async (req, res) => {
  try {
    const address = req.params.address;
    const result = await pool.query(
      `SELECT e.curve_id, c.name, c.symbol, c.icon_url, c.token_type, c.package_id, c.graduated,
              SUM(CASE
                WHEN (e.event_type LIKE '%TokensPurchased' OR e.event_type LIKE '%TokensBought')
                  THEN (e.data->>'tokens_out')::float / 1e6
                ELSE -(e.data->>'tokens_in')::float / 1e6
              END) AS net_tokens,
              SUM(CASE WHEN (e.event_type LIKE '%TokensPurchased' OR e.event_type LIKE '%TokensBought')
                THEN (e.data->>'sui_in')::float / 1e9 ELSE 0 END) AS sui_spent,
              SUM(CASE WHEN e.event_type LIKE '%TokensSold'
                THEN (e.data->>'sui_out')::float / 1e9 ELSE 0 END) AS sui_received,
              COUNT(CASE WHEN (e.event_type LIKE '%TokensPurchased' OR e.event_type LIKE '%TokensBought')
                THEN 1 END) AS buys,
              COUNT(CASE WHEN e.event_type LIKE '%TokensSold' THEN 1 END) AS sells,
              SUM(CASE WHEN (e.event_type LIKE '%TokensPurchased' OR e.event_type LIKE '%TokensBought')
                THEN (e.data->>'tokens_out')::float / 1e6 ELSE 0 END) AS tokens_bought,
              SUM(CASE WHEN e.event_type LIKE '%TokensSold'
                THEN (e.data->>'tokens_in')::float / 1e6 ELSE 0 END) AS tokens_sold,
              MAX(CASE WHEN (e.event_type LIKE '%TokensPurchased' OR e.event_type LIKE '%TokensBought')
                THEN (e.data->>'new_sui_reserve')::float ELSE NULL END) AS last_reserve_mist
       FROM events e
       LEFT JOIN curves c ON c.curve_id = e.curve_id
       WHERE (e.data->>'buyer' = $1 OR e.data->>'seller' = $1)
         AND (e.event_type LIKE '%TokensPurchased' OR e.event_type LIKE '%TokensBought' OR e.event_type LIKE '%TokensSold')
       GROUP BY e.curve_id, c.name, c.symbol, c.icon_url, c.token_type, c.package_id, c.graduated`,
      [address]
    );
    res.json(result.rows.map(r => {
      const suiSpent    = Number(r.sui_spent    ?? 0);
      const tokensBought = Number(r.tokens_bought ?? 0);
      const avgEntry    = tokensBought > 0 ? suiSpent / tokensBought : 0;
      const netTokens   = Number(r.net_tokens ?? 0);
      return {
        curve_id:       r.curve_id,
        name:           r.name,
        symbol:         r.symbol,
        icon_url:       r.icon_url,
        token_type:     r.token_type,
        package_id:     r.package_id,
        graduated:      r.graduated,
        iconUrl:        r.icon_url,
        tokenType:      r.token_type,
        packageId:      r.package_id,
        net_tokens:     netTokens,
        sui_spent:      suiSpent,
        sui_received:   Number(r.sui_received   ?? 0),
        buys:           Number(r.buys           ?? 0),
        sells:          Number(r.sells          ?? 0),
        tokens_bought:  tokensBought,
        tokens_sold:    Number(r.tokens_sold    ?? 0),
        avg_entry_price: avgEntry,
        reserve_sui:    Number(r.last_reserve_mist ?? 0) / MIST,
      };
    }));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Creator tokens ────────────────────────────────────────────────────────────

// duplicate /tokens route removed

// ── Recent trades (live feed) ─────────────────────────────────────────────────

app.get('/trades/recent', async (req, res) => {
  try {
    const limit  = Math.min(parseInt(req.query.limit || '50'), 200);
    const result = await pool.query(
      `SELECT e.data, e.timestamp_ms, e.event_type, e.curve_id, c.name, c.symbol
       FROM events e LEFT JOIN curves c ON c.curve_id = e.curve_id
       WHERE (e.event_type LIKE '%TokensPurchased' OR e.event_type LIKE '%TokensBought' OR e.event_type LIKE '%TokensSold')
       ORDER BY e.timestamp_ms DESC LIMIT $1`, [limit]
    );
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Leaderboards ──────────────────────────────────────────────────────────────

app.get('/leaderboard/volume', async (req, res) => {
  try {
    const limit  = Math.min(parseInt(req.query.limit || '20'), 100);
    const result = await pool.query(
      `SELECT ts.curve_id, c.name, c.symbol, c.icon_url, c.package_id,
              ts.volume_sui, ts.trades, ts.buys, ts.sells, ts.last_price, ts.reserve_sui
       FROM token_stats ts
       LEFT JOIN curves c ON c.curve_id = ts.curve_id
       ORDER BY ts.volume_sui DESC LIMIT $1`, [limit]
    );
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/leaderboard/traders', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || '20'), 100);
    const MIST_LOCAL = 1_000_000_000;
    const TOKEN_SCALE = 1_000_000;
    const [buysRes, sellsRes] = await Promise.all([
      pool.query(`
        SELECT data->>'buyer' AS address,
               e.curve_id, c.name, c.symbol, c.token_type, c.package_id,
               SUM((data->>'sui_in')::float)     AS sui_spent,
               SUM((data->>'tokens_out')::float) AS tokens_bought
        FROM events e LEFT JOIN curves c ON c.curve_id = e.curve_id
        WHERE (event_type LIKE '%TokensPurchased' OR event_type LIKE '%TokensBought')
        GROUP BY data->>'buyer', e.curve_id, c.name, c.symbol, c.token_type, c.package_id
      `),
      pool.query(`
        SELECT data->>'seller' AS address,
               e.curve_id, c.name, c.symbol, c.token_type, c.package_id,
               SUM((data->>'sui_out')::float)   AS sui_received,
               SUM((data->>'tokens_in')::float) AS tokens_sold
        FROM events e LEFT JOIN curves c ON c.curve_id = e.curve_id
        WHERE event_type LIKE '%TokensSold'
        GROUP BY data->>'seller', e.curve_id, c.name, c.symbol, c.token_type, c.package_id
      `),
    ]);
    const traderMap = {};
    for (const row of buysRes.rows) {
      const addr = row.address;
      if (!addr) continue;
      if (!traderMap[addr]) traderMap[addr] = { address: addr, sui_spent: 0, sui_received: 0, buys: 0, sells: 0, tokens_bought: 0, tokens_sold: 0, positions: {} };
      traderMap[addr].sui_spent    += Number(row.sui_spent   ?? 0) / MIST_LOCAL;
      traderMap[addr].tokens_bought += Number(row.tokens_bought ?? 0) / TOKEN_SCALE;
      traderMap[addr].buys++;
    }
    for (const row of sellsRes.rows) {
      const addr = row.address;
      if (!addr) continue;
      if (!traderMap[addr]) traderMap[addr] = { address: addr, sui_spent: 0, sui_received: 0, buys: 0, sells: 0, tokens_bought: 0, tokens_sold: 0, positions: {} };
      traderMap[addr].sui_received += Number(row.sui_received ?? 0) / MIST_LOCAL;
      traderMap[addr].tokens_sold  += Number(row.tokens_sold  ?? 0) / TOKEN_SCALE;
      traderMap[addr].sells++;
    }
    const sorted = Object.values(traderMap)
      .sort((a, b) => (b.sui_spent + b.sui_received) - (a.sui_spent + a.sui_received))
      .slice(0, limit);
    res.json(sorted);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/leaderboard/positions', async (req, res) => {
  try {
    const { address } = req.query;
    if (!address) return res.status(400).json({ error: 'address required' });
    const MIST_LOCAL  = 1_000_000_000;
    const TOKEN_SCALE = 1_000_000;
    const [buysRes, sellsRes] = await Promise.all([
      pool.query(
        `SELECT e.curve_id, c.name, c.symbol, c.token_type, c.package_id,
                SUM((data->>'sui_in')::float)     AS sui_spent,
                SUM((data->>'tokens_out')::float) AS tokens_bought
         FROM events e LEFT JOIN curves c ON c.curve_id = e.curve_id
         WHERE (event_type LIKE '%TokensPurchased' OR event_type LIKE '%TokensBought')
           AND data->>'buyer' = $1
         GROUP BY e.curve_id, c.name, c.symbol, c.token_type, c.package_id`, [address]
      ),
      pool.query(
        `SELECT e.curve_id,
                SUM((data->>'sui_out')::float)   AS sui_received,
                SUM((data->>'tokens_in')::float) AS tokens_sold
         FROM events e
         WHERE event_type LIKE '%TokensSold' AND data->>'seller' = $1
         GROUP BY e.curve_id`, [address]
      ),
    ]);
    const curveMap = {};
    for (const row of buysRes.rows) {
      const id = row.curve_id;
      if (!curveMap[id]) curveMap[id] = { curve_id: id, name: row.name, symbol: row.symbol, token_type: row.token_type, package_id: row.package_id, sui_spent: 0, sui_received: 0, buys: 0, sells: 0, tokens_bought: 0, tokens_sold: 0 };
      curveMap[id].sui_spent    += Number(row.sui_spent    ?? 0) / MIST_LOCAL;
      curveMap[id].tokens_bought += Number(row.tokens_bought ?? 0) / TOKEN_SCALE;
      curveMap[id].buys++;
    }
    for (const row of sellsRes.rows) {
      const id = row.curve_id;
      if (!curveMap[id]) curveMap[id] = { ...curveMap[id], curve_id: id, sui_spent: 0, sui_received: 0, buys: 0, sells: 0, tokens_bought: 0, tokens_sold: 0 };
      curveMap[id].sui_received += Number(row.sui_received ?? 0) / MIST_LOCAL;
      curveMap[id].tokens_sold  += Number(row.tokens_sold  ?? 0) / TOKEN_SCALE;
      curveMap[id].sells++;
    }
    res.json(Object.values(curveMap).map(c => ({
      curve_id: c.curve_id, name: c.name, symbol: c.symbol, token_type: c.token_type, package_id: c.package_id,
      sui_spent: c.sui_spent, sui_received: c.sui_received, buys: c.buys, sells: c.sells,
      net_tokens: c.tokens_bought - c.tokens_sold,
      avg_entry_price: c.tokens_bought > 0 ? c.sui_spent / c.tokens_bought : 0,
    })).sort((a, b) => (b.sui_spent + b.sui_received) - (a.sui_spent + a.sui_received)));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── PostgreSQL LISTEN — receives events from background worker ───────────────

async function startPgListener() {
  const client = new pg.Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  try {
    await client.connect();
    await client.query('LISTEN suipump_events');
    client.on('notification', (msg) => {
      try {
        const event = JSON.parse(msg.payload);
        emitEvent(event.eventType, event.data, event.curveId);
      } catch {}
    });
    client.on('error', (err) => {
      console.error('  PG listener error:', err.message);
      client.end().catch(() => {});
      setTimeout(startPgListener, 5_000);
    });
    console.log('  ✓ PostgreSQL LISTEN active — suipump_events');
  } catch (err) {
    console.error('  PG listener connect failed:', err.message);
    setTimeout(startPgListener, 5_000);
  }
}

export function startApi() {
  app.listen(PORT, () => console.log(`  ✓ API listening on port ${PORT}`));
  startPgListener().catch(err => console.error('PG listener failed:', err.message));
}
