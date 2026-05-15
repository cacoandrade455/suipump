// api.js — REST API for SuiPump indexer
// All endpoints return JSON. CORS enabled for frontend.
//
// Endpoints:
//   GET /health                    — liveness check
//   GET /stats                     — global protocol stats
//   GET /tokens                    — all tokens with stats
//   GET /token/:curveId/stats      — single token stats
//   GET /token/:curveId/trades     — trade history
//   GET /leaderboard/volume        — top tokens by volume
//   GET /leaderboard/trades        — top tokens by trade count

import express from 'express';
import cors from 'cors';
import {
  getGlobalStats,
  getAllTokenStats,
  getTokenStats,
  getTradeHistory,
  getAllCurves,
  pool,
} from './db.js';

const PORT = parseInt(process.env.PORT || '3001');
const app  = express();

app.use(cors());
app.use(express.json());

// ── Health ────────────────────────────────────────────────────────────────────

app.get('/health', (req, res) => {
  res.json({ status: 'ok', ts: Date.now() });
});

// ── Global stats ──────────────────────────────────────────────────────────────

app.get('/stats', async (req, res) => {
  try {
    const stats = await getGlobalStats();
    const MIST = 1e9;

    // Protocol fees = 0.5% of total volume (50% of 1% fee)
    const protocolFeesSui = stats.totalVolume * 0.005;
    const s1PoolSui       = protocolFeesSui * 0.5;

    // Also sum buys/sells from token_stats for the frontend breakdown
    const buySellRes = await pool.query(
      'SELECT COALESCE(SUM(buys),0) AS total_buys, COALESCE(SUM(sells),0) AS total_sells FROM token_stats'
    );
    const totalBuys  = Number(buySellRes.rows[0].total_buys);
    const totalSells = Number(buySellRes.rows[0].total_sells);

    res.json({
      totalVolume:    stats.totalVolume,
      totalTrades:    stats.totalTrades,
      totalBuys,
      totalSells,
      tokenCount:     stats.tokenCount,
      protocolFeesSui,
      s1PoolSui,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── All tokens with stats ─────────────────────────────────────────────────────

app.get('/tokens', async (req, res) => {
  try {
    const [curves, statsMap] = await Promise.all([getAllCurves(), getAllTokenStats()]);
    const tokens = curves.map(c => ({
      curveId:       c.curve_id,
      creator:       c.creator,
      name:          c.name,
      symbol:        c.symbol,
      tokenType:     c.token_type,
      packageId:     c.package_id,
      createdAt:     c.created_at,
      stats:         statsMap[c.curve_id] ?? null,
    }));
    res.json(tokens);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Single token stats ────────────────────────────────────────────────────────

app.get('/token/:curveId/stats', async (req, res) => {
  try {
    const stats = await getTokenStats(req.params.curveId);
    if (!stats) return res.status(404).json({ error: 'Not found' });
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Trade history ─────────────────────────────────────────────────────────────

app.get('/token/:curveId/trades', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || '200'), 1000);
    const trades = await getTradeHistory(req.params.curveId, limit);
    res.json(trades);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Leaderboards ──────────────────────────────────────────────────────────────

app.get('/leaderboard/volume', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || '20'), 100);
    const result = await pool.query(
      `SELECT ts.*, c.name, c.symbol, c.token_type, c.created_at
       FROM token_stats ts
       JOIN curves c ON c.curve_id = ts.curve_id
       ORDER BY ts.volume_sui DESC
       LIMIT $1`,
      [limit]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/leaderboard/trades', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || '20'), 100);
    const result = await pool.query(
      `SELECT ts.*, c.name, c.symbol, c.token_type, c.created_at
       FROM token_stats ts
       JOIN curves c ON c.curve_id = ts.curve_id
       ORDER BY ts.trades DESC
       LIMIT $1`,
      [limit]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Recent trades across all tokens (for live feed) ───────────────────────────

app.get('/trades/recent', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || '50'), 200);
    const result = await pool.query(
      `SELECT e.data, e.timestamp_ms, e.event_type, e.curve_id,
              c.name, c.symbol
       FROM events e
       LEFT JOIN curves c ON c.curve_id = e.curve_id
       WHERE e.event_type LIKE '%TokensPurchased' OR e.event_type LIKE '%TokensSold'
       ORDER BY e.timestamp_ms DESC
       LIMIT $1`,
      [limit]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── All token stats (for useTokenStats hook) ─────────────────────────────────

app.get('/tokens/stats', async (req, res) => {
  try {
    const now = Date.now();
    const oneDayAgo = now - 24 * 60 * 60 * 1000;

    // Get all token stats + sparkline data in one query
    const [statsRes, sparklineRes] = await Promise.all([
      pool.query('SELECT * FROM token_stats'),
      pool.query(
        `SELECT curve_id,
                json_agg(json_build_object('t', timestamp_ms, 'p',
                  CASE WHEN event_type LIKE '%TokensPurchased'
                    THEN (data->>'sui_in')::float / 1e9 / NULLIF((data->>'tokens_out')::float / 1e6, 0)
                    ELSE (data->>'sui_out')::float / 1e9 / NULLIF((data->>'tokens_in')::float / 1e6, 0)
                  END
                ) ORDER BY timestamp_ms ASC) as sparkline
         FROM events
         WHERE (event_type LIKE '%TokensPurchased' OR event_type LIKE '%TokensSold')
           AND timestamp_ms > $1
         GROUP BY curve_id`,
        [oneDayAgo]
      ),
    ]);

    const sparklineMap = {};
    for (const row of sparklineRes.rows) {
      sparklineMap[row.curve_id] = (row.sparkline || []).filter(p => p.p > 0);
    }

    const result = statsRes.rows.map(s => ({
      ...s,
      sparkline24h: sparklineMap[s.curve_id] || [],
    }));

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── OHLC trade points for chart ──────────────────────────────────────────────

app.get('/token/:curveId/ohlc', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT data, timestamp_ms, event_type FROM events
       WHERE curve_id = $1
         AND (event_type LIKE '%TokensPurchased' OR event_type LIKE '%TokensSold')
       ORDER BY timestamp_ms ASC`,
      [req.params.curveId]
    );

    const MIST = 1e9;
    const points = result.rows
      .map(row => {
        const d   = row.data;
        const ts  = row.timestamp_ms ? Math.floor(Number(row.timestamp_ms) / 1000) : 0;
        const isBuy = row.event_type.includes('TokensPurchased');
        const price = isBuy
          ? (Number(d.sui_in   ?? 0) / MIST) / (Number(d.tokens_out ?? 1) / 1e6)
          : (Number(d.sui_out  ?? 0) / MIST) / (Number(d.tokens_in  ?? 1) / 1e6);
        return { time: ts, price, kind: isBuy ? 'buy' : 'sell' };
      })
      .filter(p => p.price > 0 && p.time > 0);

    res.json(points);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────

export function startApi() {
  app.listen(PORT, () => {
    console.log(`  ✓ API listening on port ${PORT}`);
  });
}
