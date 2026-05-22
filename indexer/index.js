// index.js — SuiPump event indexer (gRPC + GraphQL, @mysten/sui v2)
//
// Event querying:  queryEvents (JSON-RPC) → GraphQL events query (raw string)
// Object fetching: getObject (JSON-RPC)   → SuiGrpcClient core.getObject
// Real-time:       polling every 10s      → GraphQL cursor pagination (no sub yet)
//
// Public endpoints (free, no API key):
//   gRPC:    https://fullnode.testnet.sui.io:443
//   GraphQL: https://sui-testnet.mystenlabs.com/graphql
//
// Zero downtime: new cursors are namespaced graphql:<event_type>
// Old JSON-RPC cursors are ignored. UNIQUE(tx_digest, event_seq) drops duplicates.

import 'dotenv/config';
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { SuiGraphQLClient } from '@mysten/sui/graphql';
import {
  pool, initSchema, getCursor, saveCursor, insertEvent,
  upsertCurve, recomputeStats, enrichCurveMetadata, backfillMissingIcons,
} from './db.js';
import { startGraduationWatcher } from './auto_graduate.js';
import { startApi } from './api.js';

// ── Config ────────────────────────────────────────────────────────────────────

const ALL_PACKAGE_IDS = [
  '0x2154486dcf503bd3e8feae4fb913e862f7e2bbf4489769aff63978f55d55b4a8', // V4
  '0x785c0604cb6c60a8547501e307d2b0ca7a586ff912c8abff4edfb88db65b7236', // V5
  '0x21d5b1284d5f1d4d14214654f414ffca20c757ee9f9db7701d3ffaaac62cd768', // V6
  '0xfb8f3f3e4e8d53130ac140906eebea6b6740bfaf0c971aec607fbc723be951f0', // V7
  '0x145a1e79b83cc17680dbfe4f96839cd359c7db380ac15463ecb6dc30f9849b69', // V8_1
  '0xbb4ee050239f59dfd983501ce101698ba27857f77aff2d437cec568fe0062546', // V8
];

const PACKAGE_IDS = process.env.PACKAGE_IDS
  ? process.env.PACKAGE_IDS.split(',').map(s => s.trim()).filter(Boolean)
  : ALL_PACKAGE_IDS;

const NETWORK      = process.env.NETWORK       ?? 'testnet';
const GRPC_URL     = process.env.SUI_GRPC_URL  ?? `https://fullnode.${NETWORK}.sui.io:443`;
const GRAPHQL_URL  = process.env.SUI_GRAPHQL_URL ?? `https://sui-${NETWORK}.mystenlabs.com/graphql`;
const PAGE_SIZE    = 50;
const POLL_MS      = parseInt(process.env.POLL_MS ?? '10000');

// ── Clients ───────────────────────────────────────────────────────────────────

const grpcClient = new SuiGrpcClient({
  network: NETWORK,
  baseUrl:  GRPC_URL,
});

const graphqlClient = new SuiGraphQLClient({
  url:     GRAPHQL_URL,
  network: NETWORK,
});

// ── Event type helpers ────────────────────────────────────────────────────────

const EVENT_NAMES = [
  'TokensBought',
  'TokensSold',
  'TokensLaunched',
  'Comment',
  'Graduated',
];

function getEventTypes(packageId) {
  return EVENT_NAMES.map(name => `${packageId}::bonding_curve::${name}`);
}

// ── GraphQL event query (raw string — no tagged template needed) ──────────────

const EVENTS_QUERY = `
  query SuiPumpEvents($type: String!, $after: String, $first: Int!) {
    events(
      filter: { type: $type }
      first: $first
      after: $after
    ) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        timestamp
        contents {
          type { repr }
          json
        }
        transaction {
          digest
          effects {
            checkpoint { sequenceNumber }
          }
        }
      }
    }
  }
`;

// ── Parse GraphQL event node ──────────────────────────────────────────────────

function parseGraphQLEvent(node, eventType) {
  const digest  = node.transaction?.digest ?? 'unknown';
  const seqRaw  = node.transaction?.effects?.checkpoint?.sequenceNumber ?? 0;
  const tsMs    = node.timestamp ? new Date(node.timestamp).getTime() : null;
  const json    = node.contents?.json ?? {};
  const parsedJson = typeof json === 'string' ? JSON.parse(json) : json;

  return {
    id:          { txDigest: digest, eventSeq: seqRaw },
    timestampMs: tsMs ? String(tsMs) : null,
    parsedJson,
    type: eventType,
  };
}

// ── Sync one event type ───────────────────────────────────────────────────────

async function syncEventType(eventType, packageId) {
  const cursorKey = `graphql:${eventType}`;
  let cursor    = await getCursor(cursorKey);
  let newEvents = 0;
  let hasMore   = true;

  while (hasMore) {
    const result = await graphqlClient.query({
      query: EVENTS_QUERY,
      variables: {
        type:  eventType,
        after: cursor ?? null,
        first: PAGE_SIZE,
      },
    });

    if (result.errors?.length) {
      throw new Error(result.errors.map(e => e.message).join('; '));
    }

    const events   = result.data?.events?.nodes ?? [];
    const pageInfo = result.data?.events?.pageInfo;

    for (const node of events) {
      const evt = parseGraphQLEvent(node, eventType);

      await insertEvent(eventType, evt);

      if (eventType.includes('TokensLaunched') || eventType.includes('CurveCreated')) {
        await upsertCurve(evt, packageId);
        const curveId = evt.parsedJson?.curve_id;
        if (curveId) await enrichCurveMetadata(curveId, grpcClient);
      }

      const curveId = evt.parsedJson?.curve_id;
      if (curveId && (
        eventType.includes('TokensBought') ||
        eventType.includes('TokensSold') ||
        eventType.includes('TokensPurchased') ||
        eventType.includes('Comment')
      )) {
        await recomputeStats(curveId);
      }

      newEvents++;
    }

    if (pageInfo?.hasNextPage && pageInfo?.endCursor) {
      cursor = pageInfo.endCursor;
      await saveCursor(cursorKey, cursor);
    } else {
      if (pageInfo?.endCursor) await saveCursor(cursorKey, pageInfo.endCursor);
      hasMore = false;
    }

    if (events.length === PAGE_SIZE) await sleep(100);
  }

  return newEvents;
}

// ── Full sync ─────────────────────────────────────────────────────────────────

async function syncAll() {
  for (const packageId of PACKAGE_IDS) {
    for (const eventType of getEventTypes(packageId)) {
      try {
        const count = await syncEventType(eventType, packageId);
        if (count > 0) {
          console.log(`  synced ${count} new events: ${eventType.split('::').pop()}`);
        }
      } catch (err) {
        console.error(`  error syncing ${eventType.split('::').pop()}:`, err.message, err.cause?.message ?? '');
      }
    }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('━'.repeat(50));
  console.log('  SUIPUMP INDEXER (gRPC + GraphQL)');
  console.log('━'.repeat(50));
  console.log(`  Network:  ${NETWORK}`);
  console.log(`  gRPC:     ${GRPC_URL}`);
  console.log(`  GraphQL:  ${GRAPHQL_URL}`);
  console.log(`  Packages: ${PACKAGE_IDS.length} versions`);
  console.log();

  await initSchema();
  startApi();

  // Test GraphQL connectivity
  console.log('  Testing GraphQL connectivity…');
  try {
    const test = await graphqlClient.query({
      query: `{ chainIdentifier }`,
    });
    console.log(`  ✓ GraphQL connected — chain: ${test.data?.chainIdentifier}`);
  } catch (err) {
    console.error(`  ✗ GraphQL connection failed: ${err.message}`, err.cause?.message ?? '');
    console.error(`  ⚠ Will keep retrying — indexer may be degraded`);
  }

  console.log('  Backfilling historical events…');
  await syncAll();
  console.log('  ✓ Backfill complete');
  console.log();

  await backfillMissingIcons(grpcClient);
  console.log();

  startGraduationWatcher().catch(err =>
    console.error('Auto-grad watcher crashed:', err.message)
  );

  // Poll every POLL_MS — no subscription support yet in SDK v2
  console.log(`  Polling for new events every ${POLL_MS / 1000}s…`);
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
