// fix_unique_constraint.js
import 'dotenv/config';
import pg from 'pg';
const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

console.log('Fixing UNIQUE constraint on events table...');

await pool.query('ALTER TABLE events DROP CONSTRAINT IF EXISTS events_tx_digest_event_seq_key');
console.log('✓ Dropped old constraint (tx_digest, event_seq)');

await pool.query('ALTER TABLE events ADD CONSTRAINT events_tx_digest_event_type_key UNIQUE (tx_digest, event_type)');
console.log('✓ Added new constraint (tx_digest, event_type)');

await pool.end();
console.log('Done.');
