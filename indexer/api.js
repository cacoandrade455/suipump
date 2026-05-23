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
    const s1PoolSui       = protocolFeesSui * 0.5;
    const buySellRes = await pool.query(
      'SELECT COALESCE(SUM(buys),0) AS total_buys, COALESCE(SUM(sells),0) AS total_sells FROM token_stats'
    );
    res.json({
      totalVolume:    stats.totalVolume,
      totalTrades:    stats.totalTrades,
      totalBuys:      Number(buySellRes.rows[0].total_buys),
      totalSells:     Number(buySellRes.rows[0].total_sells),
      tokenCount:     stats.tokenCount,
      protocolFeesSui,
      s1PoolSui,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── All tokens ────────────────────────────────────────────────────────────────

app.get('/tokens', async (req, res) => {
  try { res.json(await getAllCurves()); }
  catch (err) { res.status(500).json({ error: err.message }); }
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

// ── OHLC chart data ───────────────────────────────────────────────────────────

app.get('/token/:curveId/ohlc', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT data, timestamp_ms, event_type FROM events
       WHERE curve_id = $1
         AND (event_type LIKE '%TokensPurchased' OR event_type LIKE '%TokensBought' OR event_type LIKE '%TokensSold')
       ORDER BY timestamp_ms ASC`,
      [req.params.curveId]
    );
    const MIST = 1e9;
    // Use spot price from new_sui_reserve / new_token_reserve after each trade.
    // This reflects the actual curve state, not the average trade price.
    // Virtual reserves for V8: VS=3500 SUI, VT=800M tokens
    const VIRTUAL_SUI    = 3500 * MIST;
    const VIRTUAL_TOKENS = 800_000_000 * 1e6;
    const points = result.rows.map(row => {
      const d     = row.data;
      const ts    = row.timestamp_ms ? Math.floor(Number(row.timestamp_ms) / 1000) : 0;
      const isBuy = row.event_type.includes('TokensPurchased') || row.event_type.includes('TokensBought');
      // Spot price = (real_sui_reserve + virtual_sui) / (real_token_reserve + virtual_tokens)
      const suiRes  = Number(d.new_sui_reserve   ?? 0) + VIRTUAL_SUI;
      const tokRes  = Number(d.new_token_reserve ?? 1) + VIRTUAL_TOKENS;
      const price   = (suiRes / MIST) / (tokRes / 1e6);
      return { time: ts, price, kind: isBuy ? 'buy' : 'sell' };
    }).filter(p => p.price > 0 && p.time > 0);
    res.json(points);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Token stats for homepage ──────────────────────────────────────────────────

app.get('/tokens/stats', async (req, res) => {
  try {
    const now       = Date.now();
    const oneDayAgo = now - 86_400_000;
    const [statsRes, sparklineRes] = await Promise.all([
      pool.query('SELECT * FROM token_stats'),
      pool.query(
        `SELECT curve_id,
                json_agg(json_build_object('t', timestamp_ms, 'p',
                  CASE WHEN (event_type LIKE '%TokensPurchased' OR event_type LIKE '%TokensBought')
                    THEN (data->>'sui_in')::float / 1e9 / NULLIF((data->>'tokens_out')::float / 1e6, 0)
                    ELSE (data->>'sui_out')::float / 1e9 / NULLIF((data->>'tokens_in')::float / 1e6, 0)
                  END
                ) ORDER BY timestamp_ms ASC) as sparkline
         FROM events
         WHERE (event_type LIKE '%TokensPurchased' OR event_type LIKE '%TokensBought' OR event_type LIKE '%TokensSold')
           AND timestamp_ms > $1
         GROUP BY curve_id`, [oneDayAgo]
      ),
    ]);
    const sparklineMap = {};
    for (const row of sparklineRes.rows) {
      sparklineMap[row.curve_id] = (row.sparkline || []).filter(p => p.p > 0);
    }
    res.json(statsRes.rows.map(s => ({ ...s, sparkline24h: sparklineMap[s.curve_id] || [] })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

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
      `SELECT ts.*, c.name, c.symbol, c.token_type, c.created_at
       FROM token_stats ts JOIN curves c ON c.curve_id = ts.curve_id
       ORDER BY ts.volume_sui DESC LIMIT $1`, [limit]
    );
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/leaderboard/trades', async (req, res) => {
  try {
    const limit  = Math.min(parseInt(req.query.limit || '20'), 100);
    const result = await pool.query(
      `SELECT ts.*, c.name, c.symbol, c.token_type, c.created_at
       FROM token_stats ts JOIN curves c ON c.curve_id = ts.curve_id
       ORDER BY ts.trades DESC LIMIT $1`, [limit]
    );
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/leaderboard/traders', async (req, res) => {
  try {
    const limit  = Math.min(parseInt(req.query.limit || '20'), 100);
    const result = await pool.query(
      `SELECT wallet, SUM(vol_sui) AS volume_sui, SUM(trade_count) AS trades
       FROM (
         SELECT data->>'buyer'  AS wallet, (data->>'sui_in')::float  / 1e9 AS vol_sui, 1 AS trade_count
         FROM events WHERE (event_type LIKE '%TokensPurchased' OR event_type LIKE '%TokensBought') AND data->>'buyer' IS NOT NULL
         UNION ALL
         SELECT data->>'seller' AS wallet, (data->>'sui_out')::float / 1e9 AS vol_sui, 1 AS trade_count
         FROM events WHERE event_type LIKE '%TokensSold' AND data->>'seller' IS NOT NULL
       ) t GROUP BY wallet ORDER BY volume_sui DESC LIMIT $1`, [limit]
    );
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Trader portfolio ──────────────────────────────────────────────────────────

app.get('/trader/:address', async (req, res) => {
  try {
    const addr       = req.params.address;
    const MIST       = 1e9;
    const TOKEN_SCALE = 1e6;
    const [buysRes, sellsRes] = await Promise.all([
      pool.query(
        `SELECT e.curve_id, e.data, c.name, c.symbol, c.token_type, c.package_id
         FROM events e LEFT JOIN curves c ON c.curve_id = e.curve_id
         WHERE (e.event_type LIKE '%TokensPurchased' OR e.event_type LIKE '%TokensBought')
           AND e.data->>'buyer' = $1`, [addr]
      ),
      pool.query(
        `SELECT e.curve_id, e.data, c.name, c.symbol, c.token_type, c.package_id
         FROM events e LEFT JOIN curves c ON c.curve_id = e.curve_id
         WHERE e.event_type LIKE '%TokensSold' AND e.data->>'seller' = $1`, [addr]
      ),
    ]);
    const curveMap = {};
    for (const row of buysRes.rows) {
      const id = row.curve_id;
      if (!curveMap[id]) curveMap[id] = { curve_id: id, name: row.name, symbol: row.symbol, token_type: row.token_type, package_id: row.package_id, sui_spent: 0, sui_received: 0, buys: 0, sells: 0, tokens_bought: 0, tokens_sold: 0 };
      curveMap[id].sui_spent     += Number(row.data.sui_in     ?? 0) / MIST;
      curveMap[id].tokens_bought += Number(row.data.tokens_out ?? 0) / TOKEN_SCALE;
      curveMap[id].buys++;
    }
    for (const row of sellsRes.rows) {
      const id = row.curve_id;
      if (!curveMap[id]) curveMap[id] = { curve_id: id, name: row.name, symbol: row.symbol, token_type: row.token_type, package_id: row.package_id, sui_spent: 0, sui_received: 0, buys: 0, sells: 0, tokens_bought: 0, tokens_sold: 0 };
      curveMap[id].sui_received += Number(row.data.sui_out   ?? 0) / MIST;
      curveMap[id].tokens_sold  += Number(row.data.tokens_in ?? 0) / TOKEN_SCALE;
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

// ── Start ─────────────────────────────────────────────────────────────────────

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
