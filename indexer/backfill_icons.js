// backfill_icons.js — ONE-TIME backfill for icon_url + description
//
// Reads CurveCreated events already stored in the `events` table and copies
// their `icon_url` / `description` fields into the `curves` table for any row
// where those columns are currently NULL.
//
// SAFE:
//   - Only READS from `events` (never modifies it)
//   - Only WRITES `icon_url` and `description` on `curves`, and only where NULL
//   - Idempotent — running it twice is a no-op for already-filled rows
//   - Not wired into index.js — run manually, once
//
// Usage:
//   cd indexer
//   node backfill_icons.js
//
// Requires DATABASE_URL in the environment (same as the indexer).

import 'dotenv/config';
import { pool } from './db.js';

async function main() {
  console.log('━'.repeat(56));
  console.log('  SUIPUMP — backfill icon_url + description');
  console.log('━'.repeat(56));

  // 1. Find every CurveCreated event stored in the events table.
  //    data is JSONB — icon_url / description live inside it.
  const eventsRes = await pool.query(
    `SELECT curve_id,
            data->>'icon_url'    AS icon_url,
            data->>'description' AS description
     FROM events
     WHERE event_type LIKE '%CurveCreated'
       AND curve_id IS NOT NULL`
  );

  console.log(`  Found ${eventsRes.rows.length} CurveCreated events in the events table.`);

  // De-dup: one curve may appear once, but guard anyway. First non-null wins.
  const byCurve = {};
  for (const row of eventsRes.rows) {
    const id = row.curve_id;
    if (!byCurve[id]) byCurve[id] = { icon_url: null, description: null };
    if (row.icon_url    && !byCurve[id].icon_url)    byCurve[id].icon_url    = row.icon_url.trim();
    if (row.description && !byCurve[id].description) byCurve[id].description = row.description.trim();
  }

  const curveIds = Object.keys(byCurve);
  console.log(`  Unique curves: ${curveIds.length}`);
  console.log();

  let updated = 0;
  let skippedNoData = 0;
  let alreadyFilled = 0;

  for (const curveId of curveIds) {
    const { icon_url, description } = byCurve[curveId];

    // Nothing to write for this curve
    if (!icon_url && !description) {
      skippedNoData++;
      continue;
    }

    // COALESCE keeps any existing value — only fills NULL cells.
    const res = await pool.query(
      `UPDATE curves
       SET icon_url    = COALESCE(icon_url,    $2),
           description = COALESCE(description, $3)
       WHERE curve_id = $1
         AND (icon_url IS NULL OR description IS NULL)`,
      [curveId, icon_url || null, description || null]
    );

    if (res.rowCount > 0) {
      updated++;
      console.log(`  ✓ ${curveId.slice(0, 10)}…  icon:${icon_url ? 'yes' : '—'}  desc:${description ? 'yes' : '—'}`);
    } else {
      alreadyFilled++;
    }
  }

  console.log();
  console.log('━'.repeat(56));
  console.log(`  Updated:        ${updated}`);
  console.log(`  Already filled: ${alreadyFilled}`);
  console.log(`  No data in event: ${skippedNoData}`);
  console.log('━'.repeat(56));

  await pool.end();
  process.exit(0);
}

main().catch(err => {
  console.error('Backfill error:', err);
  process.exit(1);
});
