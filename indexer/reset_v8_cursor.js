// reset_v8_cursor.js — Reset GraphQL cursor for V8 package to force full re-backfill
// Run from indexer/ folder: node reset_v8_cursor.js

import 'dotenv/config';
import pg from 'pg';

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const V8_PKG = '0xbb4ee050239f59dfd983501ce101698ba27857f77aff2d437cec568fe0062546';
const EVENT_NAMES = ['TokensPurchased', 'TokensSold', 'CurveCreated', 'Comment', 'Graduated'];

console.log('Resetting GraphQL cursors for V8 package...');

for (const name of EVENT_NAMES) {
  const eventType = `${V8_PKG}::bonding_curve::${name}`;
  const cursorKey = `graphql:${eventType}`;
  const result = await pool.query(
    'DELETE FROM cursors WHERE event_type = $1',
    [cursorKey]
  );
  console.log(`  Deleted cursor for ${name}: ${result.rowCount} rows`);
}

// Also delete existing V8 events so they get re-inserted cleanly
const deleted = await pool.query(
  `DELETE FROM events WHERE event_type LIKE '${V8_PKG}%'`
);
console.log(`\nDeleted ${deleted.rowCount} existing V8 events (will be re-indexed)`);

await pool.end();
console.log('\nDone. Restart the indexer to trigger full V8 backfill.');
