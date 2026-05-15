// reset_cursors.js — clears corrupted cursor state so indexer backfills from scratch
// Usage: node indexer/reset_cursors.js

import 'dotenv/config';
import pg from 'pg';
const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

console.log('Deleting all cursors...');
const res = await pool.query('DELETE FROM cursors');
console.log(`✓ Deleted ${res.rowCount} cursor(s). Indexer will backfill from scratch on next deploy.`);
await pool.end();
