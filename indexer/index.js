// index.js — SuiPump event indexer  (V8-aware)
// Backfills all historical events then polls for new ones every 5s.
// Writes to PostgreSQL. Exposes REST API via api.js.
//
// Env vars required:
//   DATABASE_URL  — PostgreSQL connection string (from Render)
//   SUI_RPC_URL   — optional, defaults to Mysten testnet public RPC
//   PORT          — optional, defaults to 3001

import 'dotenv/config';
import { SuiClient, getFullnodeUrl } from '@mysten/sui/client';
import {
  pool, initSchema, getCursor, saveCursor, insertEvent,
  upsertCurve, recomputeStats, enrichCurveMetadata, backfillMissingIcons,
} from './db.js';
import { startGraduationWatcher } from './auto_graduate.js';
import { startApi } from './api.js';

// All deployed SuiPump package versions. The indexer MUST cover every version
// or tokens/trades/volume from older or newer packages silently disappear.
// PACKAGE_IDS env var (Render) overrides this; the default below is the
// complete V4-V8 set so a missing/incomplete env var still indexes everything.
const ALL_PACKAGE_IDS = [
  '0x2154486dcf503bd3e8feae4fb913e862f7e2bbf4489769aff63978f55d55b4a8', // V4
  '0x785c0604cb6c60a8547501e307d2b0ca7a586ff912c8abff4edfb88db65b7236', // V5
  '0x21d5b1284d5f1d4d14214654f414ffca20c757ee9f9db7701d3ffaaac62cd768', // V6
  '0xfb8f3f3e4e8d53130ac140906eebea6b6740bfaf0c971aec607fbc723be951f0', // V7
  // V8: add the real package ID here once contracts-v8 is published.
  // Also update the PACKAGE_IDS env var on Render.
  ...(process.env.PACKAGE_ID_V8 ? [process.env.PACKAGE_ID_V8] : []),
];

const PACKAGE_IDS = process.env.PACKAGE_IDS
  ? process.env.PACKAGE_IDS.split(',').map(s => s.trim()).filter(Boolean)
  : ALL_PACKAGE_IDS;
const RPC_URL  = process.env.SUI_RPC_URL || getFullnodeUrl('testnet');
const POLL_MS  = parseInt(process.env.POLL_MS || '5000');
const PAGE_SIZE = 100;

const client = new SuiClient({ url: RPC_URL });

// Event types to index (one entry per package ID)
function getEventTypes(packageId) {
  return [
    `${packageId}::bonding_curve::TokensPurchased`,
    `${packageId}::bonding_curve::TokensSold`,
    `${packageId}::bonding_curve::CurveCreated`,
    `${packageId}::bonding_curve::Comment`,
    `${packageId}::bonding_curve::Graduated`,
  ];
}

// ── Backfill + poll for one event type ───────────────────────────────────────

async function syncEventType(eventType, packageId) {
  let cursor = await getCursor(eventType);
  let newEvents = 0;
  let hasMore = true;

  while (hasMore) {
    const res = await client.queryEvents({
      query: { MoveEventType: eventType },
      cursor: cursor ?? undefined,
      limit: PAGE_SIZE,
      order: 'ascending',
    });

    for (const evt of res.data) {
      await insertEvent(eventType, evt);

      if (eventType.includes('CurveCreated')) {
        await upsertCurve(evt, packageId);
        const curveId2 = evt.parsedJson?.curve_id;
        if (curveId2) await enrichCurveMetadata(curveId2, client);
      }

      const curveId = evt.parsedJson?.curve_id;
      if (
        curveId &&
        (eventType.includes('TokensPurchased') ||
          eventType.includes('TokensSold') ||
          eventType.includes('Comment'))
      ) {
        await recomputeStats(curveId);
      }

      newEvents++;
    }

    if (res.hasNextPage && res.nextCursor) {
      cursor = res.nextCursor;
      await saveCursor(eventType, cursor);
    } else {
      if (res.nextCursor) await saveCursor(eventType, res.nextCursor);
      hasMore = false;
    }

    if (res.data.length === PAGE_SIZE) await sleep(200);
  }

  return newEvents;
}

// ── Full sync across all event types and package IDs ─────────────────────────

async function syncAll() {
  for (const packageId of PACKAGE_IDS) {
    const eventTypes = getEventTypes(packageId);
    for (const eventType of eventTypes) {
      try {
        const count = await syncEventType(eventType, packageId);
        if (count > 0) {
          console.log(`  synced ${count} new events: ${eventType.split('::').pop()}`);
        }
      } catch (err) {
        console.error(`  error syncing ${eventType.split('::').pop()}:`, err.message);
      }
    }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('━'.repeat(50));
  console.log('  SUIPUMP INDEXER');
  console.log('━'.repeat(50));
  console.log(`  RPC:      ${RPC_URL}`);
  console.log(`  Packages: ${PACKAGE_IDS.join(', ')}`);
  console.log(`  Poll:     every ${POLL_MS / 1000}s`);
  console.log();

  await initSchema();
  startApi();

  console.log('  Backfilling historical events…');
  await syncAll();
  console.log('  ✓ Backfill complete');
  console.log();

  await backfillMissingIcons(client);
  console.log();

  // Start auto-graduation watcher (non-blocking)
  startGraduationWatcher().catch(err => console.error('Auto-grad watcher crashed:', err.message));

  console.log('  Polling for new events…');
  while (true) {
    await sleep(POLL_MS);
    try {
      await syncAll();
    } catch (err) {
      console.error('  poll error:', err.message);
    }
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
