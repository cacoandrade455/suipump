// index.js — SuiPump event indexer
// 
// Architecture (matches Sui blog Feb 2026 recommendation):
//   PRIMARY:  gRPC streaming via subscribeCheckpoints — sub-second latency
//   FALLBACK: GraphQL cursor pagination — backfill + gap recovery on reconnect
//
// Flow:
//   1. Backfill all historical events via GraphQL (cursor-based, idempotent)
//   2. Start gRPC checkpoint stream — process events in real-time
//   3. On stream disconnect: reconnect + backfill gap via GraphQL, then resume stream
//
// Transport:
//   - Indexer is Node.js server-side → use @protobuf-ts/grpc-transport (native HTTP/2)
//   - NOT GrpcWebFetchTransport (browser-only fetch-based)

import 'dotenv/config';
import { GrpcTransport } from '@protobuf-ts/grpc-transport';
import { ChannelCredentials } from '@grpc/grpc-js';
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

const NETWORK     = process.env.NETWORK          ?? 'testnet';
const GRPC_URL    = (process.env.SUI_GRPC_URL ?? `fullnode.${NETWORK}.sui.io:443`).replace('https://', '').replace('http://', '');
const GRAPHQL_URL = process.env.SUI_GRAPHQL_URL  ?? `https://graphql.${NETWORK}.sui.io/graphql`;
const PAGE_SIZE   = 50;

// CRITICAL: these must match exact struct names emitted by the Move contracts.
const EVENT_NAMES = [
  'TokensPurchased',
  'TokensSold',
  'CurveCreated',
  'Comment',
  'Graduated',
];

// Build Set of all tracked event type strings for fast O(1) lookup
const TRACKED_EVENT_TYPES = new Set(
  PACKAGE_IDS.flatMap(pkg =>
    EVENT_NAMES.map(name => `${pkg}::bonding_curve::${name}`)
  )
);

// ── Clients ───────────────────────────────────────────────────────────────────

// Node.js native gRPC transport — uses @grpc/grpc-js, HTTP/2, NOT browser fetch
const grpcTransport = new GrpcTransport({
  host: GRPC_URL,
  channelCredentials: ChannelCredentials.createSsl(),
});

const grpcClient = new SuiGrpcClient({
  network: NETWORK,
  transport: grpcTransport,
});

const graphqlClient = new SuiGraphQLClient({
  url: GRAPHQL_URL,
});

// ── GraphQL backfill (historical + gap recovery) ──────────────────────────────

const EVENTS_QUERY = `
  query SuiPumpEvents($type: String!, $after: String, $first: Int!) {
    events(
      filter: { type: $type }
      first: $first
      after: $after
    ) {
      pageInfo { hasNextPage endCursor }
      nodes {
        timestamp
        contents { type { repr } json }
        transaction {
          digest
          effects { checkpoint { sequenceNumber } }
        }
      }
    }
  }
`;

function parseGraphQLEvent(node, eventType) {
  const digest  = node.transaction?.digest ?? 'unknown';
  const seqRaw  = node.transaction?.effects?.checkpoint?.sequenceNumber ?? 0;
  const tsMs    = node.timestamp ? new Date(node.timestamp).getTime() : null;
  const json    = node.contents?.json ?? {};
  const parsed  = typeof json === 'string' ? JSON.parse(json) : json;
  return {
    id:          { txDigest: digest, eventSeq: seqRaw },
    timestampMs: tsMs ? String(tsMs) : null,
    parsedJson:  parsed,
    type:        eventType,
  };
}

async function syncEventType(eventType, packageId) {
  const cursorKey = `graphql:${eventType}`;
  let cursor  = await getCursor(cursorKey);
  let total   = 0;
  let hasMore = true;

  while (hasMore) {
    const result = await graphqlClient.query({
      query: EVENTS_QUERY,
      variables: { type: eventType, after: cursor ?? null, first: PAGE_SIZE },
    });

    if (result.errors?.length) throw new Error(result.errors.map(e => e.message).join('; '));

    const events   = result.data?.events?.nodes ?? [];
    const pageInfo = result.data?.events?.pageInfo;

    for (const node of events) {
      const evt = parseGraphQLEvent(node, eventType);
      await processEvent(eventType, evt, packageId);
      total++;
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

  return total;
}

async function backfill() {
  console.log('  Backfilling historical events via GraphQL…');
  for (const packageId of PACKAGE_IDS) {
    for (const eventName of EVENT_NAMES) {
      const eventType = `${packageId}::bonding_curve::${eventName}`;
      try {
        const count = await syncEventType(eventType, packageId);
        if (count > 0) console.log(`  synced ${count} new: ${eventName} (${packageId.slice(0,10)}…)`);
      } catch (err) {
        console.error(`  backfill error ${eventName}:`, err.message);
      }
    }
  }
  console.log('  ✓ Backfill complete');
}

// ── Event processor (shared by both streaming and backfill) ───────────────────

async function processEvent(eventType, evt, packageId) {
  await insertEvent(eventType, evt);

  if (eventType.includes('CurveCreated')) {
    await upsertCurve(evt, packageId);
    const curveId = evt.parsedJson?.curve_id;
    if (curveId) await enrichCurveMetadata(curveId);
  }

  const curveId = evt.parsedJson?.curve_id;
  if (curveId && (
    eventType.includes('TokensPurchased') ||
    eventType.includes('TokensSold') ||
    eventType.includes('Comment')
  )) {
    await recomputeStats(curveId);
  }
}

// ── gRPC streaming (primary real-time path) ───────────────────────────────────

// Extract package ID from full event type string
// e.g. "0xbb4e...::bonding_curve::TokensPurchased" → "0xbb4e..."
function pkgFromEventType(eventType) {
  return eventType?.split('::')?.[0] ?? null;
}

// Convert protobuf google.protobuf.Value to plain JS object
function protoValueToJs(val) {
  if (!val) return null;
  if (val.kind?.oneofKind === 'structValue') {
    const obj = {};
    for (const [k, v] of Object.entries(val.kind.structValue.fields ?? {})) {
      obj[k] = protoValueToJs(v);
    }
    return obj;
  }
  if (val.kind?.oneofKind === 'listValue') {
    return (val.kind.listValue.values ?? []).map(protoValueToJs);
  }
  if (val.kind?.oneofKind === 'stringValue')  return val.kind.stringValue;
  if (val.kind?.oneofKind === 'numberValue')  return val.kind.numberValue;
  if (val.kind?.oneofKind === 'boolValue')    return val.kind.boolValue;
  if (val.kind?.oneofKind === 'nullValue')    return null;
  return null;
}

async function processCheckpoint(checkpoint, seqNum) {
  let processed = 0;
  for (const tx of checkpoint.transactions ?? []) {
    const digest = tx.digest ?? 'unknown';
    const tsMs   = tx.timestamp ? new Date(tx.timestamp).getTime() : null;

    for (const event of tx.events?.events ?? []) {
      const eventType = event.eventType;
      if (!eventType || !TRACKED_EVENT_TYPES.has(eventType)) continue;

      const parsedJson = protoValueToJs(event.json);
      const pkgId      = pkgFromEventType(eventType);

      const evt = {
        id:          { txDigest: digest, eventSeq: seqNum },
        timestampMs: tsMs ? String(tsMs) : null,
        parsedJson:  parsedJson ?? {},
        type:        eventType,
      };

      await processEvent(eventType, evt, pkgId);
      processed++;
    }
  }
  return processed;
}

async function startStreaming() {
  console.log(`  Starting gRPC checkpoint stream → ${GRPC_URL}`);

  let reconnectDelay = 1000;

  while (true) {
    try {
      const stream = grpcClient.subscriptionService.subscribeCheckpoints({
        readMask: {
          paths: [
            'transactions.digest',
            'transactions.timestamp',
            'transactions.events',
          ],
        },
      });

      console.log('  ✓ gRPC stream connected');
      reconnectDelay = 1000; // reset on successful connect

      let lastSeq = null;

      for await (const response of stream.responses) {
        const seqNum     = Number(response.cursor ?? 0);
        const checkpoint = response.checkpoint;
        if (!checkpoint) continue;

        const count = await processCheckpoint(checkpoint, seqNum);
        if (count > 0) {
          console.log(`  [stream] checkpoint ${seqNum}: ${count} SuiPump events`);
        }

        lastSeq = seqNum;
      }

      console.log(`  gRPC stream ended at checkpoint ${lastSeq}. Reconnecting…`);

    } catch (err) {
      console.error(`  gRPC stream error: ${err.message}`);
    }

    // Before reconnecting, backfill any gap via GraphQL
    console.log('  Backfilling gap via GraphQL before reconnect…');
    try { await backfill(); } catch (e) { console.error('  gap backfill error:', e.message); }

    await sleep(reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 30_000); // exponential backoff, max 30s
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('━'.repeat(52));
  console.log('  SUIPUMP INDEXER (gRPC streaming + GraphQL backfill)');
  console.log('━'.repeat(52));
  console.log(`  Network:  ${NETWORK}`);
  console.log(`  gRPC:     ${GRPC_URL}`);
  console.log(`  GraphQL:  ${GRAPHQL_URL}`);
  console.log(`  Packages: ${PACKAGE_IDS.length} versions`);
  console.log(`  Events:   ${EVENT_NAMES.join(', ')}`);
  console.log();

  await initSchema();
  startApi();

  // Test GraphQL connectivity
  try {
    const test = await graphqlClient.query({ query: `{ chainIdentifier }` });
    console.log(`  ✓ GraphQL — chain: ${test.data?.chainIdentifier}`);
  } catch (err) {
    console.error(`  ✗ GraphQL failed: ${err.message}`);
  }

  // Step 1: Backfill all historical events
  await backfill();
  await backfillMissingIcons();

  // Step 2: Start graduation watcher
  startGraduationWatcher(grpcClient).catch(err =>
    console.error('Auto-grad watcher crashed:', err.message)
  );

  // Step 3: Start gRPC streaming (runs forever, reconnects on failure)
  await startStreaming();
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
