// index.js — SuiPump event indexer
//
// PRIMARY:  gRPC checkpoint streaming — sub-second latency
// FALLBACK: GraphQL cursor pagination — backfill + gap recovery on reconnect
//
// Transport: @protobuf-ts/grpc-transport (Node.js native HTTP/2, NOT browser fetch)

import 'dotenv/config';
import { GrpcTransport } from '@protobuf-ts/grpc-transport';
import { ChannelCredentials } from '@grpc/grpc-js';
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { SuiGraphQLClient } from '@mysten/sui/graphql';
import {
  pool, initSchema, getCursor, saveCursor, insertEvent,
  upsertCurve, recomputeStats, enrichCurveMetadata, backfillMissingIcons,
  upsertLock, updateLockClaimed,
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
  '0x719698e5138582d78ee95317271e8bce05769569a4f58c940a7f1b424d90ffe2', // V9
];

const PACKAGE_IDS = process.env.PACKAGE_IDS
  ? process.env.PACKAGE_IDS.split(',').map(s => s.trim()).filter(Boolean)
  : ALL_PACKAGE_IDS;

const NETWORK     = process.env.NETWORK          ?? 'testnet';
const GRPC_URL    = (process.env.SUI_GRPC_URL    ?? `fullnode.${NETWORK}.sui.io:443`).replace(/^https?:\/\//, '');
const GRAPHQL_URL = process.env.SUI_GRAPHQL_URL  ?? `https://graphql.${NETWORK}.sui.io/graphql`;

const EVENT_NAMES = ['TokensPurchased', 'TokensSold', 'CurveCreated', 'Comment', 'Graduated', 'TokensLocked', 'VestedClaimed'];

const TRACKED_EVENT_TYPES = new Set(
  PACKAGE_IDS.flatMap(pkg => EVENT_NAMES.map(name => `${pkg}::bonding_curve::${name}`))
);

// ── Clients ───────────────────────────────────────────────────────────────────

const grpcTransport = new GrpcTransport({
  host: GRPC_URL,
  channelCredentials: ChannelCredentials.createSsl(),
});

const grpcClient = new SuiGrpcClient({
  network: NETWORK,
  transport: grpcTransport,
});

const graphqlClient = new SuiGraphQLClient({ url: GRAPHQL_URL });

// ── GraphQL backfill ──────────────────────────────────────────────────────────

const EVENTS_QUERY = `
  query SuiPumpEvents($type: String!, $after: String, $first: Int!) {
    events(filter: { type: $type } first: $first after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes {
        timestamp
        contents { type { repr } json }
        transaction { digest effects { checkpoint { sequenceNumber } } }
      }
    }
  }
`;

function parseGraphQLEvent(node, eventType) {
  const digest = node.transaction?.digest ?? 'unknown';
  const seqRaw = node.transaction?.effects?.checkpoint?.sequenceNumber ?? 0;
  const tsMs   = node.timestamp ? new Date(node.timestamp).getTime() : null;
  const json   = node.contents?.json ?? {};
  const parsed = typeof json === 'string' ? JSON.parse(json) : json;
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
      variables: { type: eventType, after: cursor ?? null, first: 50 },
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

    if (events.length === 50) await sleep(100);
  }
  return total;
}

async function graphqlBackfill() {
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

// ── Event processor ───────────────────────────────────────────────────────────

async function processEvent(eventType, evt, packageId) {
  await insertEvent(eventType, evt);
  // Notify web service via PostgreSQL LISTEN/NOTIFY
  try {
    const payload = JSON.stringify({
      type:      eventType.split('::').pop(),
      eventType,
      curveId:   evt.parsedJson?.curve_id ?? null,
      data:      evt.parsedJson,
      ts:        evt.timestampMs ? Number(evt.timestampMs) : Date.now(),
      digest:    evt.id?.txDigest ?? null,
    });
    await pool.query(`SELECT pg_notify('suipump_events', $1)`, [payload]);
  } catch {}

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

  if (eventType.includes('TokensLocked')) {
    await upsertLock(evt);
  }

  if (eventType.includes('VestedClaimed')) {
    await updateLockClaimed(evt);
  }
}

// ── Proto Value → JS conversion ───────────────────────────────────────────────

function protoValueToJs(val) {
  if (!val) return null;
  const k = val.kind;
  if (!k) return null;
  if (k.oneofKind === 'structValue') {
    const obj = {};
    for (const [key, v] of Object.entries(k.structValue?.fields ?? {})) {
      obj[key] = protoValueToJs(v);
    }
    return obj;
  }
  if (k.oneofKind === 'listValue')   return (k.listValue?.values ?? []).map(protoValueToJs);
  if (k.oneofKind === 'stringValue') return k.stringValue;
  if (k.oneofKind === 'numberValue') return k.numberValue;
  if (k.oneofKind === 'boolValue')   return k.boolValue;
  if (k.oneofKind === 'nullValue')   return null;
  return null;
}

function pkgFromEventType(eventType) {
  return eventType?.split('::')?.[0] ?? null;
}

// ── gRPC checkpoint stream processor ─────────────────────────────────────────

async function processCheckpoint(checkpoint, seqNum) {
  let processed = 0;

  // Single pass: collect tracked event types present in this checkpoint
  const trackedEventTypes = new Set();
  let totalEvents = 0;
  for (const tx of checkpoint.transactions ?? []) {
    for (const event of tx.events?.events ?? []) {
      totalEvents++;
      if (event.eventType && TRACKED_EVENT_TYPES.has(event.eventType)) {
        trackedEventTypes.add(event.eventType);
      }
    }
  }

  if (totalEvents > 0 && trackedEventTypes.size > 0) {
  }
  if (trackedEventTypes.size === 0) return 0;

  for (const eventType of trackedEventTypes) {
    try {
      // GraphQL may lag behind gRPC stream — retry up to 5x with 1s delay
      let nodes = [];
      for (let attempt = 0; attempt < 5; attempt++) {
        if (attempt > 0) await sleep(1000);
        const result = await graphqlClient.query({
          query: `query CheckpointEvents($type: String!, $cp: UInt53!) {
            events(filter: { type: $type, atCheckpoint: $cp }, first: 50) {
              nodes {
                contents { type { repr } json }
                transaction { digest }
                timestamp
              }
            }
          }`,
          variables: { type: eventType, cp: seqNum },
        });
        nodes = result.data?.events?.nodes ?? [];
        if (nodes.length > 0) break;
      }

      for (let i = 0; i < nodes.length; i++) {
        const node = nodes[i];
        const digest = node.transaction?.digest ?? 'unknown';
        const tsMs   = node.timestamp ? new Date(node.timestamp).getTime() : null;
        const json   = node.contents?.json ?? {};
        const parsedJson = typeof json === 'string' ? JSON.parse(json) : json;
        const pkgId  = pkgFromEventType(eventType);

        const evt = {
          id:          { txDigest: digest, eventSeq: i },
          timestampMs: tsMs ? String(tsMs) : null,
          parsedJson,
          type:        eventType,
        };

        await processEvent(eventType, evt, pkgId);
        processed++;
        console.log(`  [stream] ${eventType.split('::').pop()} curve=${parsedJson?.curve_id?.slice(0,10)}… tx=${digest.slice(0,12)}…`);
      }
    } catch (err) {
      console.error(`[stream] checkpoint events fetch error:`, err.message);
    }
  }

  return processed;
}

// ── gRPC streaming (primary real-time path) ───────────────────────────────────

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
            'transactions.events.events.event_type',
            'transactions.events.events.json',
          ],
        },
      });

      console.log('  ✓ gRPC stream connected');
      reconnectDelay = 1000;
      let lastSeq = null;

      for await (const response of stream.responses) {
        const seqNum     = Number(response.cursor ?? 0);
        const checkpoint = response.checkpoint;
        if (!checkpoint) continue;

        const count = await processCheckpoint(checkpoint, seqNum);
        if (count > 0) console.log(`  [stream] checkpoint ${seqNum}: ${count} SuiPump events`);
        lastSeq = seqNum;
      }

      console.log(`  gRPC stream ended at checkpoint ${lastSeq}. Reconnecting…`);
    } catch (err) {
      console.error(`  gRPC stream error: ${err.message}`);
    }

    console.log('  Backfilling gap via GraphQL before reconnect…');
    try { await graphqlBackfill(); } catch (e) { console.error('  gap backfill error:', e.message); }

    await sleep(reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 30_000);
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

  try {
    const test = await graphqlClient.query({ query: `{ chainIdentifier }` });
    console.log(`  ✓ GraphQL — chain: ${test.data?.chainIdentifier}`);
  } catch (err) {
    console.error(`  ✗ GraphQL failed: ${err.message}`);
  }

  await graphqlBackfill();
  await backfillMissingIcons();

  startGraduationWatcher(grpcClient).catch(err =>
    console.error('Auto-grad watcher crashed:', err.message)
  );

  await startStreaming();
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
