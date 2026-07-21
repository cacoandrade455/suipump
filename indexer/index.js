// index.js - SuiPump event indexer
//
// PRIMARY:  gRPC checkpoint streaming - sub-second latency
// FALLBACK: GraphQL cursor pagination - backfill + gap recovery on reconnect
//
// Transport: @protobuf-ts/grpc-transport (Node.js native HTTP/2, NOT browser fetch)

import 'dotenv/config';
import { GrpcTransport } from '@protobuf-ts/grpc-transport';
import { ChannelCredentials } from '@grpc/grpc-js';
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { SuiGraphQLClient } from '@mysten/sui/graphql';
import {
  pool, initSchema, getCursor, saveCursor, insertEvent,
  upsertCurve, recomputeStats, recomputeHolders, enrichCurveMetadata, backfillMissingIcons,
  upsertLock, updateLockClaimed,
} from './db.js';
import { refreshBundleScoreCheap } from './bundles.js';
import { startGraduationWatcher } from './auto_graduate.js';
import { startPricePublisher } from './price_publisher.js';
import { startCtoReclaimSweeper } from './cto_reclaim_sweeper.js';
import { startApi } from './api.js';

// -- Config --------------------------------------------------------------------

// V13 -- SEPARATE PUBLISHED LINEAGE (fresh publish 2026-07-17, NOT a V10 upgrade).
// Sui's `compatible` policy rejected upgrading V10 because V13 changes public
// signatures (buy/buy_with_session sui_price_scaled u64 -> &PriceConfig;
// post_comment 7 -> 6 params) and the CTO struct family; that break IS the F-2 fix.
// CONSEQUENCE: V13 has its OWN type identity - V13 curves and events define under
// the V13 package id and do NOT type as V10. Env-gated so the id is never hardcoded
// here; while SUIPUMP_V13_PACKAGE is unset, V13 events are simply not indexed.
const V13_PACKAGE = (process.env.SUIPUMP_V13_PACKAGE ?? '').trim().toLowerCase() || null;
// V14 (GRAD-1): ADDITIVE upgrade of V13. Curve/buy events keep their V13-typed names
// (emitted by V14 code but defined in V13), so they are already indexed via V13
// above; only the NEW V14 event structs (GraduationCapIssued/Rotated) type under the
// V14 package id. Env-gated; while SUIPUMP_V14_PACKAGE is unset those events are
// simply not indexed and the worker behaves exactly as pre-V14.
const V14_PACKAGE = (process.env.SUIPUMP_V14_PACKAGE ?? '').trim().toLowerCase() || null;

const ALL_PACKAGE_IDS = [
  '0x2154486dcf503bd3e8feae4fb913e862f7e2bbf4489769aff63978f55d55b4a8', // V4
  '0x785c0604cb6c60a8547501e307d2b0ca7a586ff912c8abff4edfb88db65b7236', // V5
  '0x21d5b1284d5f1d4d14214654f414ffca20c757ee9f9db7701d3ffaaac62cd768', // V6
  '0xfb8f3f3e4e8d53130ac140906eebea6b6740bfaf0c971aec607fbc723be951f0', // V7
  '0x145a1e79b83cc17680dbfe4f96839cd359c7db380ac15463ecb6dc30f9849b69', // V8_1
  '0xbb4ee050239f59dfd983501ce101698ba27857f77aff2d437cec568fe0062546', // V8
  '0x719698e5138582d78ee95317271e8bce05769569a4f58c940a7f1b424d90ffe2', // V9
  // V10 -- was MISSING, which silently dropped every event whose type defines
  // at this package (agent_session events, and bonding_curve events for any
  // curve created under it): launches went un-indexed ("Not found" token
  // pages) and session history never persisted. New event types start with a
  // null backfill cursor, so the next boot sweeps them from the beginning --
  // all missed launches/sessions are ingested retroactively, no manual repair.
  '0x2deda2cade65cd5afd5ffbe799d48f2491debf08d3aef6fa11aa6e1c8afe1598', // V10
  // V11 -- UPGRADE of V10 (not a separate publish). Events defined in V10
  // (SessionOpened, TokensPurchased, ...) keep V10-typed names even when
  // emitted by V11 code, so they are already tracked above; only the NEW V11
  // event structs (SessionBuyV2/SessionSellV2/UniversalTradingToggled) type
  // under this id. New types start with null cursors -> swept from genesis.
  '0xc03817bce45ff492e5d0f40f9e46f5a075a952b50c5c6146b8fb38138bd699eb', // V11
  // V12 -- comments toggle + Nautilus. CommentGateSet (bonding_curve) and
  // SessionAttested (agent_session) define under this id.
  '0xf5a3566ba920a3e3614e8b25da0ca3237879b6e22eb12f21ccf2bceb6520b9cd', // V12
  // V13 -- separate lineage (see note above). All V13 bonding_curve/agent_session/
  // CTO event types define under the V13 package id. New types start with null
  // cursors -> swept from genesis on first boot once SUIPUMP_V13_PACKAGE is set.
  // Conditional spread so a null id (env unset) never enters the list.
  ...(V13_PACKAGE ? [V13_PACKAGE] : []),
  // V14 -- ADDITIVE upgrade of V13 (see note above). Only the new
  // GraduationCapIssued/Rotated event types define under this id; conditional spread.
  ...(V14_PACKAGE ? [V14_PACKAGE] : []),
];

// The Render worker ALREADY sets a PACKAGE_IDS env override, so the live list and
// the code default (ALL_PACKAGE_IDS) can silently DRIFT. Capture which source won
// and log the effective list at boot so drift is visible in the log, not invisible.
const PACKAGE_IDS_SOURCE = process.env.PACKAGE_IDS
  ? 'env override PACKAGE_IDS'
  : 'code default ALL_PACKAGE_IDS';
const PACKAGE_IDS = process.env.PACKAGE_IDS
  ? process.env.PACKAGE_IDS.split(',').map(s => s.trim()).filter(Boolean)
  : ALL_PACKAGE_IDS;
console.log(
  `[indexer] tracking ${PACKAGE_IDS.length} packages from ${PACKAGE_IDS_SOURCE} ` +
  `(V13 ${V13_PACKAGE ? 'wired: ' + V13_PACKAGE : 'NOT set via SUIPUMP_V13_PACKAGE'}; ` +
  `V14 ${V14_PACKAGE ? 'wired: ' + V14_PACKAGE : 'NOT set via SUIPUMP_V14_PACKAGE'}): ` +
  PACKAGE_IDS.join(', ')
);

const NETWORK     = process.env.NETWORK          ?? 'testnet';
const GRPC_URL    = (process.env.SUI_GRPC_URL    ?? `fullnode.${NETWORK}.sui.io:443`).replace(/^https?:\/\//, '');
const GRAPHQL_URL = process.env.SUI_GRAPHQL_URL  ?? `https://graphql.${NETWORK}.sui.io/graphql`;

const EVENT_NAMES = [
  'TokensPurchased', 'TokensSold', 'CurveCreated', 'Comment', 'Graduated',
  'TokensLocked', 'VestedClaimed',
  // V10 events (these carry curve_id, so they ride the existing curve-keyed
  // insert + pg_notify pipeline). Older packages never emit these -- harmless.
  'BuybackConfigured', 'BuybackExecuted', 'CreatorHeartbeat',
  'ProtocolSurchargeCollected',
  // V12: creator toggled the comments holder gate (carries curve_id).
  'CommentGateSet',
  // V13 CTO surface: TakeoverProposed/TakeoverResolved carry curve_id, but the
  // vote/unvote/reclaim events are PROPOSAL-keyed and carry NO curve_id -- so
  // those three persist + pg_notify with curve_id null (like the session events
  // below), which insertEvent handles fine (curve_id is nullable).
  'TakeoverProposed', 'TakeoverVoted', 'TakeoverUnvoted', 'TakeoverResolved', 'VoteReclaimed',
];

// V10's agent_session module -- a SEPARATE module from bonding_curve, so these
// can't ride the `${pkg}::bonding_curve::${name}` template above. These events
// carry session_id, NOT curve_id, so they never trigger recomputeStats/
// recomputeHolders (correctly -- a session isn't a curve); they just persist to
// `events` and pg_notify like everything else, giving the agent page a queryable
// history instead of the frontend's live GraphQL-scan fallback. Harmless on
// V4-V9 (never emitted there), same as the bonding_curve V10 events above.
const SESSION_EVENT_NAMES = [
  'SessionOpened', 'SessionToppedUp', 'SessionBuy', 'SessionSell', 'SessionClosed',
  // V12: chain-verified enclave-key session opens.
  'SessionAttested',
  // V11 (define under the V11 package id): richer trade events carrying
  // spent_total + escrow_after (+ universal flag), and the owner's
  // universal-trading toggle. Same session-keyed persist + pg_notify pipeline.
  'SessionBuyV2', 'SessionSellV2', 'UniversalTradingToggled',
];

// -- Epoch launch-with-site (partner integration) ------------------------------
// Epoch's record_partner_launch emits PartnerLaunch on a DIFFERENT package +
// module ({EPOCH_PKG}::walrus_names::PartnerLaunch), so it can't go through the
// bonding_curve event-name template. Track it as an explicit extra event type.
// Swap EPOCH_PKG for mainnet alongside the frontend constant.
const EPOCH_PKG = process.env.EPOCH_PKG
  ?? '0xdf5905144e2895c5ac08a673234d9688e4cae97e9d2750aa864e75a5dc53a282';
const EPOCH_PARTNER_LAUNCH_TYPE = `${EPOCH_PKG}::walrus_names::PartnerLaunch`;

const TRACKED_EVENT_TYPES = new Set([
  ...PACKAGE_IDS.flatMap(pkg => EVENT_NAMES.map(name => `${pkg}::bonding_curve::${name}`)),
  ...PACKAGE_IDS.flatMap(pkg => SESSION_EVENT_NAMES.map(name => `${pkg}::agent_session::${name}`)),
  EPOCH_PARTNER_LAUNCH_TYPE,
]);

// -- Clients -------------------------------------------------------------------

const grpcTransport = new GrpcTransport({
  host: GRPC_URL,
  channelCredentials: ChannelCredentials.createSsl(),
});

const grpcClient = new SuiGrpcClient({
  network: NETWORK,
  transport: grpcTransport,
});

const graphqlClient = new SuiGraphQLClient({ url: GRAPHQL_URL });

// -- GraphQL backfill ----------------------------------------------------------

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
  console.log('  Backfilling historical events via GraphQL...');
  for (const packageId of PACKAGE_IDS) {
    for (const eventName of EVENT_NAMES) {
      const eventType = `${packageId}::bonding_curve::${eventName}`;
      try {
        const count = await syncEventType(eventType, packageId);
        if (count > 0) console.log(`  synced ${count} new: ${eventName} (${packageId.slice(0,10)}...)`);
      } catch (err) {
        console.error(`  backfill error ${eventName}:`, err.message);
      }
    }
    // agent_session -- separate module from bonding_curve above, so it needs its
    // own loop with its own event-type template. Never emitted on V4-V9;
    // syncEventType just returns 0 for those, same as any other unused type.
    for (const eventName of SESSION_EVENT_NAMES) {
      const eventType = `${packageId}::agent_session::${eventName}`;
      try {
        const count = await syncEventType(eventType, packageId);
        if (count > 0) console.log(`  synced ${count} new: ${eventName} (${packageId.slice(0,10)}...)`);
      } catch (err) {
        console.error(`  backfill error ${eventName}:`, err.message);
      }
    }
  }
  // Epoch PartnerLaunch -- different package/module, backfilled explicitly so a
  // reconnect gap doesn't drop a site-attached launch.
  try {
    const count = await syncEventType(EPOCH_PARTNER_LAUNCH_TYPE, EPOCH_PKG);
    if (count > 0) console.log(`  synced ${count} new: PartnerLaunch (epoch ${EPOCH_PKG.slice(0,10)}...)`);
  } catch (err) {
    console.error('  backfill error PartnerLaunch:', err.message);
  }
  console.log('  OK Backfill complete');
}

// -- Event processor -----------------------------------------------------------

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

  // V13: a successful community takeover swaps the active creator on-chain.
  // Refresh the curve row so the new creator address is reflected in stats.
  // The success signal is now TakeoverResolved with succeeded === true
  // (TakeoverResolved carries curve_id, so curveId is populated here).
  if (curveId && eventType.includes('TakeoverResolved') && evt.parsedJson?.succeeded === true) {
    try { await recomputeStats(curveId); } catch {}
  }

  if (curveId && (
    eventType.includes('TokensPurchased') ||
    eventType.includes('TokensSold')
  )) {
    await recomputeHolders(curveId);
    // Piggyback the cheap bundle-score recompute on the same trade cadence that
    // just moved holders/balances. It self-throttles (skips curves scored in
    // the last 60s) and never resolves fresh funders, so this stays a light DB
    // read; failures are swallowed inside refreshBundleScoreCheap.
    await refreshBundleScoreCheap(pool, curveId);
  }

  if (eventType.includes('TokensLocked')) {
    await upsertLock(evt);
  }

  if (eventType.includes('VestedClaimed')) {
    await updateLockClaimed(evt);
  }
}

// -- Proto Value -> JS conversion -----------------------------------------------

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

// -- gRPC checkpoint stream processor -----------------------------------------

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
      // GraphQL may lag behind gRPC stream - retry up to 5x with 1s delay
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
        console.log(`  [stream] ${eventType.split('::').pop()} curve=${parsedJson?.curve_id?.slice(0,10)}... tx=${digest.slice(0,12)}...`);
      }
    } catch (err) {
      console.error(`[stream] checkpoint events fetch error:`, err.message);
    }
  }

  return processed;
}

// -- gRPC streaming (primary real-time path) -----------------------------------

async function startStreaming() {
  console.log(`  Starting gRPC checkpoint stream -> ${GRPC_URL}`);
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

      console.log('  OK gRPC stream connected');
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

      console.log(`  gRPC stream ended at checkpoint ${lastSeq}. Reconnecting...`);
    } catch (err) {
      console.error(`  gRPC stream error: ${err.message}`);
    }

    console.log('  Backfilling gap via GraphQL before reconnect...');
    try { await graphqlBackfill(); } catch (e) { console.error('  gap backfill error:', e.message); }

    await sleep(reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 30_000);
  }
}

// -- Helpers -------------------------------------------------------------------

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// -- Main ----------------------------------------------------------------------

async function main() {
  console.log('-'.repeat(52));
  console.log('  SUIPUMP INDEXER (gRPC streaming + GraphQL backfill)');
  console.log('-'.repeat(52));
  console.log(`  Network:  ${NETWORK}`);
  console.log(`  gRPC:     ${GRPC_URL}`);
  console.log(`  GraphQL:  ${GRAPHQL_URL}`);
  console.log(`  Packages: ${PACKAGE_IDS.length} versions`);
  console.log(`  Events:   ${EVENT_NAMES.join(', ')}`);
  console.log();

  // V13 price publisher arming decision, logged up front so a worker booted
  // without the publish-time env states its posture immediately. Missing V13
  // env is NORMAL pre-publish: the worker must run fine without it. The signer
  // check is SUI_PRIVATE_KEY specifically (the Render reality; the publisher's
  // keystore fallback is a local-dev convenience, not an arming signal).
  //
  // This gate MUST list the SAME vars the publisher's own dormancy gate checks
  // (price_publisher.js startPricePublisher). The E-1 cap split (9eb5acc9) added
  // SUIPUMP_PRICE_RELAYER_CAP as a hard requirement there; omitting it here made
  // this gate say "armed", call the publisher, and let it go silently dormant on
  // the missing cap - the split-brain that left PriceConfig at 0 on testnet. Keep
  // the two lists identical, and name the ACTUAL missing var (not a fixed hint).
  const PRICE_PUBLISHER_REQUIRED_ENV = [
    'SUIPUMP_V13_PACKAGE',
    'SUIPUMP_PRICE_CONFIG',
    'SUIPUMP_PRICE_RELAYER_CAP',
    'SUI_PRIVATE_KEY',
  ];
  const pricePublisherMissing = PRICE_PUBLISHER_REQUIRED_ENV.filter(
    (v) => !(process.env[v] && String(process.env[v]).trim())
  );
  const pricePublisherArmed = pricePublisherMissing.length === 0;
  if (!pricePublisherArmed) {
    console.log(`  [price] price publisher dormant: missing ${pricePublisherMissing.join(', ')}`);
  }

  // V13 CTO reclaim sweeper arming, same posture as the price publisher. Needs
  // no PriceConfig - only the V13 package (arming signal) and a signer for gas.
  const ctoSweeperArmed = Boolean(
    process.env.SUIPUMP_V13_PACKAGE &&
    process.env.SUI_PRIVATE_KEY
  );
  if (!ctoSweeperArmed) {
    console.log('  [cto-sweep] reclaim sweeper dormant (set SUIPUMP_V13_PACKAGE + SUI_PRIVATE_KEY to arm)');
  }

  await initSchema();
  startApi();

  try {
    const test = await graphqlClient.query({ query: `{ chainIdentifier }` });
    console.log(`  OK GraphQL - chain: ${test.data?.chainIdentifier}`);
  } catch (err) {
    console.error(`  X GraphQL failed: ${err.message}`);
  }

  await graphqlBackfill();
  await backfillMissingIcons();

  startGraduationWatcher(grpcClient).catch(err =>
    console.error('Auto-grad watcher crashed:', err.message)
  );

  // Same fire-and-forget containment as the graduation watcher. Passes the
  // GraphQL client: pushPrice's build/execute shape is the proven
  // SuiGraphQLClient pattern (see price_publisher.js pushPrice).
  if (pricePublisherArmed) {
    startPricePublisher(graphqlClient).catch(err =>
      console.error('Price publisher crashed:', err.message)
    );
  }

  // Same fire-and-forget containment. reclaim_vote is permissionless and pays
  // the voter (see cto_reclaim_sweeper.js header): the signer only pays gas.
  if (ctoSweeperArmed) {
    startCtoReclaimSweeper(graphqlClient, pool).catch(err =>
      console.error('CTO reclaim sweeper crashed:', err.message)
    );
  }

  await startStreaming();
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
