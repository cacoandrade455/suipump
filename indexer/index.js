// index.js — SuiPump event indexer (gRPC + GraphQL, v2 SDK)
//
// Migration from JSON-RPC (v1 SDK):
//   - Event querying:    queryEvents (JSON-RPC) → GraphQL events query
//   - Object fetching:   getObject (JSON-RPC)   → SuiGrpcClient core.getObject
//   - Real-time stream:  polling every 5s       → GraphQL subscription (push)
//   - Fallback:          GraphQL cursor polling  (same logic, no polling loop needed)
//
// Public endpoints used (free, no API key):
//   gRPC:    https://fullnode.testnet.sui.io:443
//   GraphQL: https://sui-testnet.mystenlabs.com/graphql
//
// Zero downtime: both old cursors and new GraphQL cursors are stored in the
// same `cursors` table. Old JSON-RPC cursors are ignored on startup.
// The UNIQUE(tx_digest, event_seq) constraint silently drops any duplicates
// if both code paths briefly overlap during deploy.

import 'dotenv/config';
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { SuiGraphQLClient, graphql } from '@mysten/sui/graphql';
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

const NETWORK      = process.env.NETWORK ?? 'testnet';
const GRPC_URL     = process.env.SUI_GRPC_URL     ?? `https://fullnode.${NETWORK}.sui.io:443`;
const GRAPHQL_URL  = process.env.SUI_GRAPHQL_URL  ?? `https://sui-${NETWORK}.mystenlabs.com/graphql`;
const PAGE_SIZE    = 50;
const POLL_MS      = parseInt(process.env.POLL_MS ?? '10000'); // fallback poll interval

// ── Clients ───────────────────────────────────────────────────────────────────

const grpcClient = new SuiGrpcClient({
  network: NETWORK,
  baseUrl: GRPC_URL,
});

const graphqlClient = new SuiGraphQLClient({
  url: GRAPHQL_URL,
  network: NETWORK,
});

// ── Event type helpers ────────────────────────────────────────────────────────

// SuiPump event short names → GraphQL filter type prefixes
const EVENT_NAMES = [
  'TokensBought',
  'TokensSold',
  'TokensLaunched',
  'Comment',
  'Graduated',
];

// Build full event type strings for a package
function getEventTypes(packageId) {
  return EVENT_NAMES.map(name => `${packageId}::bonding_curve::${name}`);
}

// ── GraphQL event query ───────────────────────────────────────────────────────

const EVENTS_QUERY = graphql(`
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
        transactionDigest: sendingModule {
          package { address }
          name
        }
        sender { address }
        timestamp
        contents {
          type { repr }
          json
          bcs
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
`);

// ── Parse GraphQL event into the shape insertEvent/upsertCurve expect ─────────

function parseGraphQLEvent(node, eventType) {
  const digest  = node.transaction?.digest ?? 'unknown';
  const seqRaw  = node.transaction?.effects?.checkpoint?.sequenceNumber ?? 0;
  const tsMs    = node.timestamp ? new Date(node.timestamp).getTime() : null;
  const json    = node.contents?.json ?? {};

  // Reconstruct parsedJson compatible with the old JSON-RPC shape
  const parsedJson = typeof json === 'string' ? JSON.parse(json) : json;

  return {
    id: {
      txDigest:  digest,
      eventSeq:  seqRaw,
    },
    timestampMs: tsMs ? String(tsMs) : null,
    parsedJson,
    type: eventType,
  };
}

// ── Sync one event type via GraphQL (backfill + catchup) ──────────────────────

async function syncEventType(eventType, packageId) {
  // Use a namespaced cursor key so old JSON-RPC cursors don't interfere
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

    const events   = result.data?.events?.nodes ?? [];
    const pageInfo = result.data?.events?.pageInfo;

    for (const node of events) {
      const evt = parseGraphQLEvent(node, eventType);

      await insertEvent(eventType, evt);

      // TokensLaunched / CurveCreated — upsert curve record
      if (eventType.includes('TokensLaunched') || eventType.includes('CurveCreated')) {
        await upsertCurve(evt, packageId);
        const curveId = evt.parsedJson?.curve_id;
        if (curveId) await enrichCurveMetadata(curveId, grpcClient);
      }

      // Trade / comment — recompute stats
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

    // Gentle rate limiting between pages
    if (events.length === PAGE_SIZE) await sleep(100);
  }

  return newEvents;
}

// ── Full sync across all event types and package IDs ─────────────────────────

async function syncAll() {
  for (const packageId of PACKAGE_IDS) {
    for (const eventType of getEventTypes(packageId)) {
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

// ── Real-time subscription via GraphQL ────────────────────────────────────────
// GraphQL subscriptions push new events as they happen — no polling needed.
// Falls back to polling if subscription fails.

async function startSubscriptions() {
  console.log('  Starting GraphQL event subscriptions…');

  let subscriptionCount = 0;

  for (const packageId of PACKAGE_IDS) {
    for (const eventType of getEventTypes(packageId)) {
      try {
        // GraphQL subscription — fires callback for each new event
        const unsubscribe = await graphqlClient.subscribe({
          query: graphql(`
            subscription SuiPumpLive($type: String!) {
              events(filter: { type: $type }) {
                transactionDigest: sendingModule {
                  package { address }
                  name
                }
                sender { address }
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
          `),
          variables: { type: eventType },
          onResult: async (result) => {
            const node = result.data?.events;
            if (!node) return;
            try {
              const evt = parseGraphQLEvent(node, eventType);
              await insertEvent(eventType, evt);

              if (eventType.includes('TokensLaunched') || eventType.includes('CurveCreated')) {
                const pkgId = eventType.split('::')[0];
                await upsertCurve(evt, pkgId);
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

              const shortName = eventType.split('::').pop();
              console.log(`  [live] ${shortName} — ${curveId?.slice(0, 10) ?? 'n/a'}…`);
            } catch (err) {
              console.error('  [live] event processing error:', err.message);
            }
          },
          onError: (err) => {
            console.error(`  [live] subscription error (${eventType.split('::').pop()}):`, err.message);
          },
        });

        subscriptionCount++;
        // Store unsubscribe handles for graceful shutdown (optional)
      } catch (err) {
        console.warn(`  subscription failed for ${eventType.split('::').pop()}: ${err.message}`);
      }
    }
  }

  if (subscriptionCount > 0) {
    console.log(`  ✓ ${subscriptionCount} live subscriptions active`);
    return true;
  }

  console.warn('  ⚠ No subscriptions started — falling back to polling');
  return false;
}

// ── Polling fallback (used if subscriptions not supported) ───────────────────

async function startPolling() {
  console.log(`  Falling back to polling every ${POLL_MS / 1000}s…`);
  while (true) {
    await sleep(POLL_MS);
    try {
      await syncAll();
    } catch (err) {
      console.error('  poll error:', err.message);
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

  // Step 1: Backfill all historical events via GraphQL pagination
  console.log('  Backfilling historical events…');
  await syncAll();
  console.log('  ✓ Backfill complete');
  console.log();

  // Step 2: Backfill missing metadata
  await backfillMissingIcons(grpcClient);
  console.log();

  // Step 3: Start auto-graduation watcher
  startGraduationWatcher().catch(err =>
    console.error('Auto-grad watcher crashed:', err.message)
  );

  // Step 4: Start real-time subscriptions (falls back to polling if unsupported)
  const subscribed = await startSubscriptions();
  if (!subscribed) {
    // Polling fallback — runs forever
    startPolling();
  } else {
    // Subscriptions are active — run a periodic catchup sync every 60s
    // to catch any events missed during subscription gaps/reconnects
    console.log('  Running catchup sync every 60s as safety net…');
    while (true) {
      await sleep(60_000);
      try {
        await syncAll();
      } catch (err) {
        console.error('  catchup error:', err.message);
      }
    }
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
