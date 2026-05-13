// db.js — PostgreSQL connection, schema, and query helpers

import pg from 'pg';
const { Pool } = pg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

// ── Schema ────────────────────────────────────────────────────────────────────

export async function initSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS events (
      id            BIGSERIAL PRIMARY KEY,
      event_type    TEXT      NOT NULL,
      tx_digest     TEXT      NOT NULL,
      event_seq     BIGINT    NOT NULL,
      timestamp_ms  BIGINT,
      curve_id      TEXT,
      data          JSONB     NOT NULL,
      UNIQUE (tx_digest, event_seq)
    );

    CREATE INDEX IF NOT EXISTS idx_events_curve_id   ON events (curve_id);
    CREATE INDEX IF NOT EXISTS idx_events_event_type ON events (event_type);
    CREATE INDEX IF NOT EXISTS idx_events_timestamp  ON events (timestamp_ms DESC);

    -- Cursor tracking so indexer knows where to resume after restart
    CREATE TABLE IF NOT EXISTS cursors (
      event_type  TEXT PRIMARY KEY,
      cursor_data JSONB
    );

    -- Pre-computed per-token stats (rebuilt on each new event)
    CREATE TABLE IF NOT EXISTS token_stats (
      curve_id        TEXT PRIMARY KEY,
      volume_sui      DOUBLE PRECISION DEFAULT 0,
      volume_24h      DOUBLE PRECISION DEFAULT 0,
      trades          INT              DEFAULT 0,
      buys            INT              DEFAULT 0,
      sells           INT              DEFAULT 0,
      last_trade_time BIGINT,
      last_price      DOUBLE PRECISION,
      first_price     DOUBLE PRECISION,
      recent_trades   INT              DEFAULT 0,
      comment_count   INT              DEFAULT 0,
      updated_at      BIGINT
    );

    CREATE INDEX IF NOT EXISTS idx_token_stats_volume    ON token_stats (volume_sui DESC);
    CREATE INDEX IF NOT EXISTS idx_token_stats_trades    ON token_stats (trades DESC);
    CREATE INDEX IF NOT EXISTS idx_token_stats_last_trade ON token_stats (last_trade_time DESC);

    -- Curve registry (from CurveCreated events)
    CREATE TABLE IF NOT EXISTS curves (
      curve_id    TEXT PRIMARY KEY,
      creator     TEXT,
      name        TEXT,
      symbol      TEXT,
      token_type  TEXT,
      package_id  TEXT,
      created_at  BIGINT
    );
  `);
  console.log('✓ Schema initialized');
}

// ── Cursor helpers ────────────────────────────────────────────────────────────

export async function getCursor(eventType) {
  const res = await pool.query(
    'SELECT cursor_data FROM cursors WHERE event_type = $1',
    [eventType]
  );
  return res.rows[0]?.cursor_data ?? null;
}

export async function saveCursor(eventType, cursor) {
  await pool.query(
    `INSERT INTO cursors (event_type, cursor_data)
     VALUES ($1, $2)
     ON CONFLICT (event_type) DO UPDATE SET cursor_data = $2`,
    [eventType, JSON.stringify(cursor)]
  );
}

// ── Event insert ──────────────────────────────────────────────────────────────

export async function insertEvent(eventType, evt) {
  const curveId = evt.parsedJson?.curve_id ?? null;
  try {
    await pool.query(
      `INSERT INTO events (event_type, tx_digest, event_seq, timestamp_ms, curve_id, data)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (tx_digest, event_seq) DO NOTHING`,
      [
        eventType,
        evt.id?.txDigest ?? evt.id?.txDigest,
        evt.id?.eventSeq ?? 0,
        evt.timestampMs ? Number(evt.timestampMs) : null,
        curveId,
        JSON.stringify(evt.parsedJson ?? {}),
      ]
    );
  } catch (err) {
    // Ignore duplicate key errors
    if (!err.message?.includes('unique')) console.error('insertEvent error:', err.message);
  }
}

// ── Curve insert ──────────────────────────────────────────────────────────────

export async function upsertCurve(evt, packageId) {
  const j = evt.parsedJson;
  if (!j?.curve_id) return;
  await pool.query(
    `INSERT INTO curves (curve_id, creator, name, symbol, package_id, created_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (curve_id) DO NOTHING`,
    [j.curve_id, j.creator, j.name, j.symbol, packageId, evt.timestampMs ? Number(evt.timestampMs) : null]
  );
}

// ── Stats recompute for a single curve ───────────────────────────────────────

export async function recomputeStats(curveId) {
  const now = Date.now();
  const oneDayAgo = now - 24 * 60 * 60 * 1000;
  const oneHourAgo = now - 60 * 60 * 1000;
  const MIST = 1e9;

  const [buysRes, sellsRes, commentsRes] = await Promise.all([
    pool.query(
      `SELECT data, timestamp_ms FROM events
       WHERE curve_id = $1 AND event_type LIKE '%TokensPurchased'
       ORDER BY timestamp_ms DESC`,
      [curveId]
    ),
    pool.query(
      `SELECT data, timestamp_ms FROM events
       WHERE curve_id = $1 AND event_type LIKE '%TokensSold'
       ORDER BY timestamp_ms DESC`,
      [curveId]
    ),
    pool.query(
      `SELECT COUNT(*) as cnt FROM events
       WHERE curve_id = $1 AND event_type LIKE '%Comment%'`,
      [curveId]
    ),
  ]);

  let volumeSui = 0, volume24h = 0, buys = 0, sells = 0;
  let lastTradeTime = null, lastPrice = null, firstPrice = null;
  let recentTrades = 0;

  for (const row of buysRes.rows) {
    const d = row.data;
    const ts = row.timestamp_ms ? Number(row.timestamp_ms) : 0;
    const suiIn = Number(d.sui_in ?? 0) / MIST;
    volumeSui += suiIn;
    buys++;
    if (ts > oneDayAgo) { volume24h += suiIn; }
    if (ts > oneHourAgo) recentTrades++;
    if (!lastTradeTime || ts > lastTradeTime) lastTradeTime = ts;
    const tokensOut = Number(d.tokens_out ?? 0) / 1e6;
    if (tokensOut > 0) {
      const price = suiIn / tokensOut;
      if (!lastPrice) lastPrice = price;
      firstPrice = price;
    }
  }

  for (const row of sellsRes.rows) {
    const d = row.data;
    const ts = row.timestamp_ms ? Number(row.timestamp_ms) : 0;
    const suiOut = Number(d.sui_out ?? 0) / MIST;
    volumeSui += suiOut;
    sells++;
    if (ts > oneDayAgo) { volume24h += suiOut; }
    if (ts > oneHourAgo) recentTrades++;
    if (!lastTradeTime || ts > lastTradeTime) lastTradeTime = ts;
    const tokensIn = Number(d.tokens_in ?? 0) / 1e6;
    if (tokensIn > 0) {
      const price = suiOut / tokensIn;
      if (!lastPrice) lastPrice = price;
      firstPrice = price;
    }
  }

  const commentCount = Number(commentsRes.rows[0]?.cnt ?? 0);

  await pool.query(
    `INSERT INTO token_stats
       (curve_id, volume_sui, volume_24h, trades, buys, sells,
        last_trade_time, last_price, first_price, recent_trades, comment_count, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT (curve_id) DO UPDATE SET
       volume_sui      = $2,
       volume_24h      = $3,
       trades          = $4,
       buys            = $5,
       sells           = $6,
       last_trade_time = $7,
       last_price      = $8,
       first_price     = $9,
       recent_trades   = $10,
       comment_count   = $11,
       updated_at      = $12`,
    [curveId, volumeSui, volume24h, buys + sells, buys, sells,
     lastTradeTime, lastPrice, firstPrice, recentTrades, commentCount, now]
  );
}

// ── Query helpers for API ─────────────────────────────────────────────────────

export async function getAllTokenStats() {
  const res = await pool.query('SELECT * FROM token_stats');
  const map = {};
  for (const row of res.rows) map[row.curve_id] = row;
  return map;
}

export async function getTokenStats(curveId) {
  const res = await pool.query('SELECT * FROM token_stats WHERE curve_id = $1', [curveId]);
  return res.rows[0] ?? null;
}

export async function getGlobalStats() {
  const res = await pool.query(`
    SELECT
      COALESCE(SUM(volume_sui), 0)  AS total_volume,
      COALESCE(SUM(trades), 0)      AS total_trades,
      COUNT(*)                       AS token_count
    FROM token_stats
  `);
  const curvesRes = await pool.query('SELECT COUNT(*) as cnt FROM curves');
  return {
    totalVolume: Number(res.rows[0].total_volume),
    totalTrades: Number(res.rows[0].total_trades),
    tokenCount:  Number(curvesRes.rows[0].cnt),
  };
}

export async function getTradeHistory(curveId, limit = 100) {
  const res = await pool.query(
    `SELECT data, timestamp_ms, event_type FROM events
     WHERE curve_id = $1 AND (event_type LIKE '%TokensPurchased' OR event_type LIKE '%TokensSold')
     ORDER BY timestamp_ms DESC
     LIMIT $2`,
    [curveId, limit]
  );
  return res.rows;
}

export async function getAllCurves() {
  const res = await pool.query('SELECT * FROM curves ORDER BY created_at DESC');
  return res.rows;
}
