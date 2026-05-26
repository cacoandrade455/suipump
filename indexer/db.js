// db.js — PostgreSQL connection, schema, and query helpers

import pg from 'pg';
import { SuiGraphQLClient } from '@mysten/sui/graphql';

const { Pool } = pg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

// ── Internal GraphQL client for metadata fetches ──────────────────────────────
// enrichCurveMetadata / refreshCurveMetadata need getObject + getCoinMetadata.
// SuiGrpcClient does NOT support these — throws INVALID_ARGUMENT.
// SuiGraphQLClient v2 supports both methods natively.
const NETWORK     = process.env.NETWORK         ?? 'testnet';
const GRAPHQL_URL = process.env.SUI_GRAPHQL_URL ?? `https://graphql.${NETWORK}.sui.io/graphql`;
const rpcClient   = new SuiGraphQLClient({ url: GRAPHQL_URL });

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

    CREATE TABLE IF NOT EXISTS cursors (
      event_type  TEXT PRIMARY KEY,
      cursor_data JSONB
    );

    CREATE TABLE IF NOT EXISTS token_stats (
      curve_id              TEXT PRIMARY KEY,
      volume_sui            DOUBLE PRECISION DEFAULT 0,
      volume_24h            DOUBLE PRECISION DEFAULT 0,
      trades                INT              DEFAULT 0,
      buys                  INT              DEFAULT 0,
      sells                 INT              DEFAULT 0,
      last_trade_time       BIGINT,
      last_price            DOUBLE PRECISION,
      first_price           DOUBLE PRECISION,
      recent_trades         INT              DEFAULT 0,
      comment_count         INT              DEFAULT 0,
      reserve_sui           DOUBLE PRECISION DEFAULT 0,
      updated_at            BIGINT
    );

    CREATE INDEX IF NOT EXISTS idx_token_stats_volume     ON token_stats (volume_sui DESC);
    CREATE INDEX IF NOT EXISTS idx_token_stats_trades     ON token_stats (trades DESC);
    CREATE INDEX IF NOT EXISTS idx_token_stats_last_trade ON token_stats (last_trade_time DESC);

    CREATE TABLE IF NOT EXISTS curves (
      curve_id              TEXT PRIMARY KEY,
      creator               TEXT,
      name                  TEXT,
      symbol                TEXT,
      description           TEXT,
      icon_url              TEXT,
      token_type            TEXT,
      package_id            TEXT,
      created_at            BIGINT,
      graduation_target     SMALLINT,
      anti_bot_delay        SMALLINT,
      initial_shared_version BIGINT
    );

    ALTER TABLE curves ADD COLUMN IF NOT EXISTS graduation_target     SMALLINT;
    ALTER TABLE curves ADD COLUMN IF NOT EXISTS anti_bot_delay        SMALLINT;
    ALTER TABLE curves ADD COLUMN IF NOT EXISTS description           TEXT;
    ALTER TABLE curves ADD COLUMN IF NOT EXISTS icon_url              TEXT;
    ALTER TABLE curves ADD COLUMN IF NOT EXISTS token_type            TEXT;
    ALTER TABLE curves ADD COLUMN IF NOT EXISTS initial_shared_version BIGINT;
    ALTER TABLE token_stats ADD COLUMN IF NOT EXISTS reserve_sui      DOUBLE PRECISION DEFAULT 0;
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
       ON CONFLICT (tx_digest, event_type) DO NOTHING`,
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
    if (!err.message?.includes('unique')) console.error('insertEvent error:', err.message);
  }
}

// ── Curve insert ──────────────────────────────────────────────────────────────

export async function upsertCurve(evt, packageId) {
  const j = evt.parsedJson;
  if (!j?.curve_id) return;

  const graduationTarget = j.graduation_target !== undefined ? Number(j.graduation_target) : null;
  const antiBotDelay     = j.anti_bot_delay    !== undefined ? Number(j.anti_bot_delay)    : null;
  const iconUrl          = j.icon_url     ?? null;
  const description      = j.description  ?? null;

  await pool.query(
    `INSERT INTO curves
       (curve_id, creator, name, symbol, description, icon_url, package_id, created_at,
        graduation_target, anti_bot_delay)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (curve_id) DO UPDATE SET
       graduation_target = COALESCE($9,  curves.graduation_target),
       anti_bot_delay    = COALESCE($10, curves.anti_bot_delay),
       description       = COALESCE($5,  curves.description),
       icon_url          = COALESCE($6,  curves.icon_url)`,
    [
      j.curve_id, j.creator, j.name, j.symbol,
      description, iconUrl, packageId,
      evt.timestampMs ? Number(evt.timestampMs) : null,
      graduationTarget, antiBotDelay,
    ]
  );

  // Fetch and store initial_shared_version if missing
  // This is a one-time enrichment per curve — safe to do async
  backfillSharedVersion(j.curve_id).catch(() => {});
}

// ── Backfill initial_shared_version for a curve ───────────────────────────────
// Called once per new CurveCreated event. Stores the shared object version
// so the frontend can build sharedObjectRef without a direct RPC call.

async function backfillSharedVersion(curveId) {
  try {
    // Only fetch if not already stored
    const existing = await pool.query(
      'SELECT initial_shared_version FROM curves WHERE curve_id = $1',
      [curveId]
    );
    if (existing.rows[0]?.initial_shared_version) return;

    const obj = await rpcClient.getObject({ objectId: curveId });
    const isv = obj?.object?.owner?.Shared?.initialSharedVersion;
    if (!isv) return;

    await pool.query(
      'UPDATE curves SET initial_shared_version = $2 WHERE curve_id = $1',
      [curveId, Number(isv)]
    );
  } catch {
    // Non-fatal — will retry on next event for this curve
  }
}

// ── Stats recompute ───────────────────────────────────────────────────────────

export async function recomputeStats(curveId) {
  const now        = Date.now();
  const oneDayAgo  = now - 24 * 60 * 60 * 1000;
  const oneHourAgo = now - 60 * 60 * 1000;
  const MIST       = 1e9;

  const [buysRes, sellsRes, commentsRes] = await Promise.all([
    pool.query(
      `SELECT data, timestamp_ms FROM events
       WHERE curve_id = $1 AND (event_type LIKE '%TokensPurchased' OR event_type LIKE '%TokensBought')
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
  let lastReserveSui = 0;

  for (const row of buysRes.rows) {
    const d  = row.data;
    const ts = row.timestamp_ms ? Number(row.timestamp_ms) : 0;
    const suiIn = Number(d.sui_in ?? 0) / MIST;
    volumeSui += suiIn;
    buys++;
    if (ts > oneDayAgo)  volume24h += suiIn;
    if (ts > oneHourAgo) recentTrades++;
    if (!lastTradeTime || ts > lastTradeTime) {
      lastTradeTime  = ts;
      lastReserveSui = Number(d.new_sui_reserve ?? 0) / MIST;
    }
    const tokensOut = Number(d.tokens_out ?? 0) / 1e6;
    if (tokensOut > 0) {
      const price = suiIn / tokensOut;
      if (!lastPrice) lastPrice = price;
      firstPrice = price;
    }
  }

  for (const row of sellsRes.rows) {
    const d  = row.data;
    const ts = row.timestamp_ms ? Number(row.timestamp_ms) : 0;
    const suiOut = Number(d.sui_out ?? 0) / MIST;
    volumeSui += suiOut;
    sells++;
    if (ts > oneDayAgo)  volume24h += suiOut;
    if (ts > oneHourAgo) recentTrades++;
    if (!lastTradeTime || ts > lastTradeTime) {
      lastTradeTime  = ts;
      lastReserveSui = Number(d.new_sui_reserve ?? 0) / MIST;
    }
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
        last_trade_time, last_price, first_price, recent_trades, comment_count,
        reserve_sui, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
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
       reserve_sui     = $12,
       updated_at      = $13`,
    [curveId, volumeSui, volume24h, buys + sells, buys, sells,
     lastTradeTime, lastPrice, firstPrice, recentTrades, commentCount,
     lastReserveSui, now]
  );
}

// ── Enrich curve with icon_url + token_type (COALESCE — only fills nulls) ────
// Uses internal SuiGraphQLClient — NOT the gRPC client passed in.
// The _unusedClient parameter is kept for backwards-compat with callers.
export async function enrichCurveMetadata(curveId, _unusedClient) {
  try {
    const obj = await rpcClient.getObject({ objectId: curveId });
    const typeStr   = obj?.object?.type ?? '';
    const match     = typeStr.match(/Curve<(.+)>$/);
    const tokenType = match ? match[1] : null;
    if (!tokenType) return;

    const meta        = await rpcClient.getCoinMetadata({ coinType: tokenType });
    const iconUrl     = meta?.coinMetadata?.iconUrl     ?? null;
    const description = meta?.coinMetadata?.description ?? null;

    // Also grab initial_shared_version while we have the object
    const isv = obj?.object?.owner?.Shared?.initialSharedVersion ?? null;

    await pool.query(
      `UPDATE curves SET
         token_type             = COALESCE($2, curves.token_type),
         icon_url               = COALESCE($3, curves.icon_url),
         description            = COALESCE($4, curves.description),
         initial_shared_version = COALESCE($5, curves.initial_shared_version)
       WHERE curve_id = $1`,
      [curveId, tokenType, iconUrl, description, isv ? Number(isv) : null]
    );
  } catch (err) {
    console.error(`  enrich ${curveId.slice(0, 12)}… failed:`, err.message);
  }
}

// ── Refresh curve metadata (OVERWRITE — called on MetadataUpdated event) ──────
// Uses internal SuiGraphQLClient — NOT the gRPC client passed in.
export async function refreshCurveMetadata(curveId, _unusedClient) {
  try {
    const obj = await rpcClient.getObject({ objectId: curveId });
    const typeStr   = obj?.object?.type ?? '';
    const match     = typeStr.match(/Curve<(.+)>$/);
    const tokenType = match ? match[1] : null;
    if (!tokenType) return;

    const meta        = await rpcClient.getCoinMetadata({ coinType: tokenType });
    const iconUrl     = meta?.coinMetadata?.iconUrl     ?? null;
    const description = meta?.coinMetadata?.description ?? null;
    const name        = meta?.coinMetadata?.name        ?? null;
    const symbol      = meta?.coinMetadata?.symbol      ?? null;

    await pool.query(
      `UPDATE curves SET
         token_type  = $2,
         icon_url    = $3,
         description = $4,
         name        = COALESCE($5, curves.name),
         symbol      = COALESCE($6, curves.symbol)
       WHERE curve_id = $1`,
      [curveId, tokenType, iconUrl, description, name, symbol]
    );
  } catch (err) {
    console.error(`  refresh ${curveId.slice(0, 12)}… failed:`, err.message);
  }
}

// ── Startup sweep: fill icon_url for curves missing it ───────────────────────

export async function backfillMissingIcons(_unusedClient) {
  const res = await pool.query(
    `SELECT curve_id FROM curves WHERE icon_url IS NULL OR token_type IS NULL`
  );
  if (res.rows.length === 0) return;
  console.log(`  Backfilling icons for ${res.rows.length} tokens…`);
  for (const row of res.rows) {
    await enrichCurveMetadata(row.curve_id);
    await new Promise(r => setTimeout(r, 300));
  }
  console.log(`  ✓ Icon backfill complete`);
}

// ── Query helpers ─────────────────────────────────────────────────────────────

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
      COALESCE(SUM(volume_sui), 0) AS total_volume,
      COALESCE(SUM(trades), 0)     AS total_trades,
      COUNT(*)                      AS token_count
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
     WHERE curve_id = $1
       AND (event_type LIKE '%TokensPurchased' OR event_type LIKE '%TokensBought' OR event_type LIKE '%TokensSold')
     ORDER BY timestamp_ms DESC
     LIMIT $2`,
    [curveId, limit]
  );
  return res.rows;
}

export async function getAllCurves() {
  const res = await pool.query(`
    SELECT
      c.curve_id               AS "curveId",
      c.creator,
      c.name,
      c.symbol,
      c.description,
      c.icon_url               AS "iconUrl",
      c.token_type             AS "tokenType",
      c.package_id             AS "packageId",
      c.created_at             AS "createdAt",
      c.graduation_target      AS "graduationTarget",
      c.anti_bot_delay         AS "antiBotDelay",
      c.initial_shared_version AS "initialSharedVersion",
      row_to_json(s.*)         AS stats
    FROM curves c
    LEFT JOIN token_stats s ON s.curve_id = c.curve_id
    ORDER BY c.created_at DESC
  `);
  return res.rows;
}
