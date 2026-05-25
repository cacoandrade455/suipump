// dedup_events.js — Remove duplicate events from double-indexing
// Same fix as Session 30: GraphQL uses checkpoint seq, old JSON-RPC used event seq.
// Same tx_digest = same event. Keep the row with the highest id (most recent insert).
//
// Usage: cd indexer && node dedup_events.js

import 'dotenv/config';
import pg from 'pg';
const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

console.log('━'.repeat(50));
console.log('  SuiPump — dedup events table');
console.log('━'.repeat(50));

// Show current state
const before = await pool.query(`
  SELECT
    COUNT(*)                                        AS total_rows,
    COUNT(DISTINCT (tx_digest, event_type))         AS unique_tx_events,
    COUNT(*) - COUNT(DISTINCT (tx_digest, event_type)) AS estimated_dupes
  FROM events
  WHERE event_type LIKE '%TokensPurchased' OR event_type LIKE '%TokensSold'
`);
console.log('\nBefore:');
console.log('  total rows:      ', before.rows[0].total_rows);
console.log('  unique tx+type:  ', before.rows[0].unique_tx_events);
console.log('  estimated dupes: ', before.rows[0].estimated_dupes);

// Delete duplicates — keep lowest id (first inserted) per (tx_digest, event_type)
const result = await pool.query(`
  DELETE FROM events
  WHERE id IN (
    SELECT id FROM (
      SELECT id,
             ROW_NUMBER() OVER (
               PARTITION BY tx_digest, event_type
               ORDER BY id ASC
             ) AS rn
      FROM events
    ) ranked
    WHERE rn > 1
  )
`);
console.log(`\nDeleted ${result.rowCount} duplicate rows.`);

// Recompute stats for all affected curves
console.log('\nRecomputing token_stats for all curves…');
const curves = await pool.query(`SELECT DISTINCT curve_id FROM events WHERE curve_id IS NOT NULL`);
console.log(`  ${curves.rows.length} curves to recompute`);

const MIST = 1e9;
let done = 0;
for (const { curve_id } of curves.rows) {
  const [buysRes, sellsRes] = await Promise.all([
    pool.query(
      `SELECT data, timestamp_ms FROM events
       WHERE curve_id = $1 AND (event_type LIKE '%TokensPurchased' OR event_type LIKE '%TokensBought')`,
      [curve_id]
    ),
    pool.query(
      `SELECT data, timestamp_ms FROM events
       WHERE curve_id = $1 AND event_type LIKE '%TokensSold'`,
      [curve_id]
    ),
  ]);

  const now = Date.now();
  const oneDayAgo  = now - 86_400_000;
  const oneHourAgo = now - 3_600_000;

  let volumeSui = 0, volume24h = 0, buys = 0, sells = 0, recentTrades = 0;
  let lastTradeTime = null, lastPrice = null, firstPrice = null;

  for (const row of buysRes.rows) {
    const d = row.data;
    const ts = row.timestamp_ms ? Number(row.timestamp_ms) : 0;
    const suiIn = Number(d.sui_in ?? 0) / MIST;
    volumeSui += suiIn; buys++;
    if (ts > oneDayAgo)  volume24h += suiIn;
    if (ts > oneHourAgo) recentTrades++;
    if (!lastTradeTime || ts > lastTradeTime) lastTradeTime = ts;
    const tok = Number(d.tokens_out ?? 0) / 1e6;
    if (tok > 0) { const p = suiIn / tok; if (!lastPrice) lastPrice = p; firstPrice = p; }
  }

  for (const row of sellsRes.rows) {
    const d = row.data;
    const ts = row.timestamp_ms ? Number(row.timestamp_ms) : 0;
    const suiOut = Number(d.sui_out ?? 0) / MIST;
    volumeSui += suiOut; sells++;
    if (ts > oneDayAgo)  volume24h += suiOut;
    if (ts > oneHourAgo) recentTrades++;
    if (!lastTradeTime || ts > lastTradeTime) lastTradeTime = ts;
    const tok = Number(d.tokens_in ?? 0) / 1e6;
    if (tok > 0) { const p = suiOut / tok; if (!lastPrice) lastPrice = p; firstPrice = p; }
  }

  await pool.query(`
    INSERT INTO token_stats
      (curve_id, volume_sui, volume_24h, trades, buys, sells,
       last_trade_time, last_price, first_price, recent_trades, updated_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
    ON CONFLICT (curve_id) DO UPDATE SET
      volume_sui      = $2, volume_24h  = $3, trades     = $4,
      buys            = $5, sells       = $6, last_trade_time = $7,
      last_price      = $8, first_price = $9, recent_trades   = $10,
      updated_at      = $11
  `, [curve_id, volumeSui, volume24h, buys + sells, buys, sells,
      lastTradeTime, lastPrice, firstPrice, recentTrades, now]);

  done++;
  if (done % 10 === 0) process.stdout.write(`  ${done}/${curves.rows.length}…\r`);
}

// Show after state
const after = await pool.query(`
  SELECT COUNT(*) AS total_rows,
         COALESCE(SUM(trades),0) AS total_trades,
         COALESCE(SUM(buys),0)   AS total_buys,
         COALESCE(SUM(sells),0)  AS total_sells
  FROM token_stats
`);
console.log('\n\nAfter:');
console.log('  total event rows:', after.rows[0].total_rows);
console.log('  total trades:    ', after.rows[0].total_trades);
console.log('  buys:            ', after.rows[0].total_buys);
console.log('  sells:           ', after.rows[0].total_sells);

await pool.end();
console.log('\n✓ Done');
