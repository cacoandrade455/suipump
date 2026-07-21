// bundles.js -- bundle / coordinated-wallet detection for a token.
//
// Self-contained, same pattern as takeover_api.js / agent_session_api.js: it
// takes the Express `app` and the shared pg `pool`, and adds ONE read endpoint.
// ALL clustering logic lives here; api.js only mounts it. The wallet_funders
// table it reads/writes is created by db.js initSchema (funding is a property
// of the WALLET, not of any curve, so that table is global by design).
//
// Mount from api.js with:
//     import { mountBundles } from './bundles.js';
//     mountBundles(app, pool);
//
// Endpoint:
//   GET /token/:curveId/bundles
//     -> {
//          circulating_whole,   // sum of ALL netted holder balances (whole
//                               //   tokens) -- in the trade-derived model this
//                               //   sum IS net circulating supply
//          holders,             // holder count (netted balance > dust)
//          clusters: [{
//            id,                  // 'b0', 'b1', ... sorted by pct desc
//            wallets,             // full 66-char member addresses
//            pct_of_circulating,  // sum(member balances) / circulating * 100
//            funder,              // shared funder address ('funding' only)
//            kind,                // 'funding' | 'temporal'
//          }],
//          edges: [{ from, to, kind: 'funding' }],  // funder -> wallet only;
//                               //   temporal clusters convey by color, no edges
//          meta: { resolved, pending },  // funder-resolution progress over the
//                               //   top holders (fresh lookups are capped per
//                               //   request; pending shrinks on later requests)
//        }
//     Empty-safe: a token with no holders returns the same shape with zeros
//     and empty arrays, HTTP 200.
//
// Board bundle badge (see computeBundleScoreCheap / refreshBundleScoreCheap
// below): the same clustering pipeline, but with fresh GraphQL funder
// resolution DISABLED, so the per-card score is a pure DB read that never
// hits the public GraphQL endpoint. Board = cheap cached score, modal = full
// detail; both take the SAME largest-cluster pct, so they converge (the modal
// path overwrites bundle_score with its fully-resolved value on each request).
//
// Three signals, merged via union-find over wallets:
//   1. FUNDING: top holders sharing the same first external funder (earliest
//      on-chain tx touching the wallet whose sender is not the wallet itself,
//      resolved live via GraphQL and memoized forever in wallet_funders).
//      Groups of >= 2 wallets form a cluster, kind 'funding'.
//   2. TEMPORAL (co-buy): within the first 10 minutes after the first trade,
//      buys bucketed into 3-second windows; >= 3 distinct buyers co-occurring
//      in a bucket form a cluster.
//   3. TEMPORAL (identical size): an identical sui_in MIST amount appearing
//      across >= 3 distinct buyers within the first hour forms a cluster.
//      Amounts compare as the raw u64 STRINGS from the event JSON -- never
//      floats (hard rule: no float math on MIST).
// Overlapping clusters merge; a merged cluster is kind 'funding' if any
// funding-cluster member is in it, else 'temporal'.
import { SuiGraphQLClient } from '@mysten/sui/graphql';

const GRAPHQL_URL = process.env.SUI_GRAPHQL_URL
  ?? `https://graphql.${process.env.NETWORK ?? 'testnet'}.sui.io/graphql`;
const gqlClient = new SuiGraphQLClient({ url: GRAPHQL_URL });

const TOK  = 1_000_000;   // atomic per whole token
const DUST = 0.0001;      // same holder dust cutoff as /token/:curveId/holders

const TOP_HOLDERS_FOR_FUNDING = 50;  // funder resolution scope (by balance)
const MAX_FRESH_RESOLUTIONS   = 25;  // fresh GraphQL lookups per request (latency bound)
const RESOLVE_CHUNK           = 5;   // parallel batch size (same as SWEEP ALL probe)

const COBUY_BUCKET_MS   = 3_000;             // co-buy window
const LAUNCH_WINDOW_MS  = 10 * 60 * 1_000;   // co-buy scan: first 10 min of trading
const AMOUNT_WINDOW_MS  = 60 * 60 * 1_000;   // identical-amount scan: first hour
const MIN_FUNDING_WALLETS  = 2;
const MIN_TEMPORAL_WALLETS = 3;

// Too-early gate for the badge score -- mirrors the AIAnalysis concentration
// gate (AIAnalysis.jsx: holders >= 10 AND circulating >= CIRC_GATE_WHOLE) so a
// token reads the SAME "not enough data" verdict on the board badge, the token
// header, and the AI card. Below the gate the score is null (unmeasured), never
// 0 (which means measured-and-low). Both live here so the two consumers of the
// score (the cheap board path and the resolved modal path) share one gate.
const MIN_HOLDERS_FOR_SCORE = 10;
const MIN_CIRCULATING_WHOLE = 40_000_000;

// In-process response cache -- clustering rereads the full trade history and
// may fire GraphQL lookups, so a 60s TTL keeps repeat page loads cheap.
// Resets on redeploy, same tradeoff as the agentRuns store in api.js. The same
// 60s window doubles as the recompute-skip guard for the persisted bundle_score.
const CACHE_TTL_MS = 60_000;
const bundleCache  = new Map();   // curveId -> { at, data }

// -- Funder resolution ---------------------------------------------------------
// Earliest txs touching the wallet, ascending by checkpoint (the live schema's
// `transactions` field returns oldest-first with `first:`; the old
// `transactionBlocks`/`recvAddress` names no longer exist). The first tx whose
// sender differs from the wallet itself is its funder (faucet, exchange, or a
// bundler's mother wallet -- exactly the link we want).
async function resolveFunder(address) {
  const result = await gqlClient.query({
    query: `query($addr: SuiAddress!) {
      transactions(first: 3, filter: { affectedAddress: $addr }) {
        nodes { sender { address } effects { timestamp } }
      }
    }`,
    variables: { addr: address },
  });
  // A 200 response can still carry GraphQL-level errors (timeout, complexity
  // limit, resolver failure) with data: null -- the client only throws on
  // non-2xx HTTP. Treat those as failures so the wallet stays PENDING (the
  // Promise.allSettled rejected branch) instead of being memoized forever as
  // 'resolved, no external funder'. Only real data may reach wallet_funders.
  if (result?.errors?.length) {
    throw new Error(`graphql: ${result.errors[0]?.message ?? 'query error'}`);
  }
  if (!result?.data?.transactions) {
    throw new Error('graphql: empty response');
  }
  const nodes = result.data.transactions.nodes ?? [];
  const tsOf = (n) => {
    const t = n?.effects?.timestamp ? Date.parse(n.effects.timestamp) : NaN;
    return Number.isFinite(t) ? t : null;
  };
  for (const n of nodes) {
    const sender = n?.sender?.address ?? null;
    if (sender && sender.toLowerCase() !== address.toLowerCase()) {
      return { funder: sender, firstSeenMs: tsOf(n) };
    }
  }
  // No external funder in the earliest txs (all self-sent / sponsored) --
  // still record the resolution so we never re-query this wallet.
  return { funder: null, firstSeenMs: nodes.length ? tsOf(nodes[0]) : null };
}

// -- Union-find over wallet addresses ------------------------------------------

function ufFind(parent, x) {
  let root = x;
  while (parent.get(root) !== root) root = parent.get(root);
  let cur = x;   // path compression
  while (parent.get(cur) !== root) { const next = parent.get(cur); parent.set(cur, root); cur = next; }
  return root;
}

function ufUnion(parent, a, b) {
  if (!parent.has(a)) parent.set(a, a);
  if (!parent.has(b)) parent.set(b, b);
  const ra = ufFind(parent, a), rb = ufFind(parent, b);
  if (ra !== rb) parent.set(ra, rb);
}

// -- Shared clustering core ----------------------------------------------------
// Runs the full three-signal pipeline (funding provenance, temporal co-buy,
// identical-size) and returns the merged clusters plus circulating/holders.
//
//   resolveFresh: true  -> the modal path. Unknown top-holder funders are
//                          resolved live via GraphQL (capped per call) and
//                          memoized in wallet_funders.
//   resolveFresh: false -> the cheap board path. Funding uses ONLY the funders
//                          ALREADY in wallet_funders (cache hits); NO fresh
//                          GraphQL lookups, so this is a pure DB read that
//                          cannot 429 the public endpoint. Temporal signals are
//                          pure trade-row math and are always available.
//
// Returns { circulating, holderCount, clusters, edges, meta }. `clusters` is
// sorted by pct_of_circulating desc, so clusters[0] is the largest cluster.
async function computeClusters(pool, curveId, { resolveFresh }) {
  // 1. Netted holder balances -- SAME math as /token/:curveId/holders (buys
  //    minus sells from events, whole tokens, dust filtered), in the single-
  //    query UNION ALL form used by /search/by-symbol.
  const holdersRes = await pool.query(
    `SELECT addr, SUM(toks) AS bal FROM (
       SELECT data->>'buyer'  AS addr,  (data->>'tokens_out')::float AS toks
         FROM events WHERE curve_id = $1
           AND (event_type LIKE '%TokensPurchased' OR event_type LIKE '%TokensBought')
       UNION ALL
       SELECT data->>'seller' AS addr, -(data->>'tokens_in')::float AS toks
         FROM events WHERE curve_id = $1
           AND event_type LIKE '%TokensSold'
     ) t WHERE addr IS NOT NULL GROUP BY addr`,
    [curveId]
  );
  const balanceOf = {};   // address -> whole tokens
  for (const r of holdersRes.rows) {
    const bal = Number(r.bal ?? 0) / TOK;
    if (bal > DUST) balanceOf[r.addr] = bal;
  }
  const holderAddrs = Object.keys(balanceOf);
  // Sum of ALL holder balances IS net circulating in the trade-derived model.
  const circulating = holderAddrs.reduce((s, a) => s + balanceOf[a], 0);

  if (holderAddrs.length === 0) {
    return { circulating: 0, holderCount: 0, clusters: [], edges: [], meta: { resolved: 0, pending: 0 } };
  }

  // 2. Funder resolution for the top holders by balance. Already-resolved
  //    wallets come from wallet_funders (memoized forever). On the modal path
  //    the rest are resolved live, capped per request, in parallel batches of 5
  //    (same bounded-parallelism pattern as the frontend SWEEP ALL probe); on
  //    the cheap board path fresh resolution is skipped entirely.
  const topWallets = [...holderAddrs].sort((a, b) => balanceOf[b] - balanceOf[a]).slice(0, TOP_HOLDERS_FOR_FUNDING);
  const knownRes = await pool.query(
    `SELECT address, funder FROM wallet_funders WHERE address = ANY($1)`,
    [topWallets]
  );
  const funderOf = {};   // address -> funder address (null = resolved, none found)
  for (const r of knownRes.rows) funderOf[r.address] = r.funder ?? null;

  if (resolveFresh) {
    const unresolved = topWallets.filter(a => !(a in funderOf));
    const toResolve  = unresolved.slice(0, MAX_FRESH_RESOLUTIONS);
    for (let i = 0; i < toResolve.length; i += RESOLVE_CHUNK) {
      const settled = await Promise.allSettled(toResolve.slice(i, i + RESOLVE_CHUNK).map(async (addr) => {
        const { funder, firstSeenMs } = await resolveFunder(addr);
        await pool.query(
          `INSERT INTO wallet_funders (address, funder, first_seen_ms, resolved_at)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (address) DO NOTHING`,
          [addr, funder, firstSeenMs, Date.now()]
        );
        return { addr, funder };
      }));
      for (const s of settled) {
        if (s.status === 'fulfilled') funderOf[s.value.addr] = s.value.funder;
        // rejected = GraphQL hiccup -- wallet stays pending, retried next request
      }
    }
  }
  const resolvedCount = topWallets.filter(a => a in funderOf).length;
  const meta = { resolved: resolvedCount, pending: topWallets.length - resolvedCount };

  // 3. Funding clusters: top-holder wallets sharing the same funder.
  const byFunder = {};   // funder -> [wallets]
  for (const [addr, funder] of Object.entries(funderOf)) {
    if (!funder) continue;
    (byFunder[funder] ??= []).push(addr);
  }
  const fundingClusters = Object.entries(byFunder)
    .filter(([, wallets]) => wallets.length >= MIN_FUNDING_WALLETS)
    .map(([funder, wallets]) => ({ funder, wallets }));

  // 4. Temporal clusters from the indexed buy history (ascending).
  const buysRes = await pool.query(
    `SELECT data->>'buyer' AS buyer, data->>'sui_in' AS sui_in, timestamp_ms
       FROM events WHERE curve_id = $1
         AND (event_type LIKE '%TokensPurchased' OR event_type LIKE '%TokensBought')
       ORDER BY timestamp_ms ASC`,
    [curveId]
  );
  const buys = buysRes.rows
    .filter(r => r.buyer && r.timestamp_ms != null)
    .map(r => ({ buyer: r.buyer, suiIn: String(r.sui_in ?? '0'), ts: Number(r.timestamp_ms) }));
  const temporalClusters = [];   // arrays of wallets
  if (buys.length) {
    const t0 = buys[0].ts;
    // 4a. Co-buy: 3-second buckets over the first 10 minutes of trading.
    const byBucket = new Map();   // bucket index -> Set(buyers)
    for (const b of buys) {
      if (b.ts - t0 > LAUNCH_WINDOW_MS) break;
      const bucket = Math.floor((b.ts - t0) / COBUY_BUCKET_MS);
      if (!byBucket.has(bucket)) byBucket.set(bucket, new Set());
      byBucket.get(bucket).add(b.buyer);
    }
    for (const wallets of byBucket.values()) {
      if (wallets.size >= MIN_TEMPORAL_WALLETS) temporalClusters.push([...wallets]);
    }
    // 4b. Identical sui_in MIST amount across distinct buyers in the first
    //     hour. Amounts compare as the raw u64 strings -- never floats.
    const byAmount = new Map();   // sui_in string -> Set(buyers)
    for (const b of buys) {
      if (b.ts - t0 > AMOUNT_WINDOW_MS) break;
      if (!byAmount.has(b.suiIn)) byAmount.set(b.suiIn, new Set());
      byAmount.get(b.suiIn).add(b.buyer);
    }
    for (const wallets of byAmount.values()) {
      if (wallets.size >= MIN_TEMPORAL_WALLETS) temporalClusters.push([...wallets]);
    }
  }

  // 5. Merge overlapping clusters via union-find over member wallets.
  const parent = new Map();
  const inFundingCluster = new Set();
  for (const fc of fundingClusters) {
    for (const w of fc.wallets) { inFundingCluster.add(w); ufUnion(parent, fc.wallets[0], w); }
  }
  for (const tc of temporalClusters) {
    for (const w of tc) ufUnion(parent, tc[0], w);
  }
  const components = new Map();   // root -> [wallets]
  for (const w of parent.keys()) {
    const root = ufFind(parent, w);
    if (!components.has(root)) components.set(root, []);
    components.get(root).push(w);
  }

  // 6. Shape the merged components. Kind is 'funding' if any funding-cluster
  //    member landed in the component; its funder = the most common funder
  //    among those members. pct uses whole-token balances (0 for temporal
  //    members that already exited their position).
  const clusters = [...components.values()]
    .map(wallets => {
      const kind = wallets.some(w => inFundingCluster.has(w)) ? 'funding' : 'temporal';
      let funder = null;
      if (kind === 'funding') {
        const tally = {};
        for (const w of wallets) { const f = funderOf[w]; if (f) tally[f] = (tally[f] ?? 0) + 1; }
        funder = Object.entries(tally).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
      }
      const heldWhole = wallets.reduce((s, w) => s + (balanceOf[w] ?? 0), 0);
      return {
        wallets,
        pct_of_circulating: circulating > 0 ? (heldWhole / circulating) * 100 : 0,
        funder,
        kind,
      };
    })
    .sort((a, b) => b.pct_of_circulating - a.pct_of_circulating)
    .map((c, i) => ({ id: `b${i}`, ...c }));

  // Edges are funder -> wallet only; temporal clusters convey by color.
  const edges = fundingClusters.flatMap(fc =>
    fc.wallets.map(w => ({ from: fc.funder, to: w, kind: 'funding' }))
  );

  return { circulating, holderCount: holderAddrs.length, clusters, edges, meta };
}

// Bucket the largest cluster's pct_of_circulating into the 0..1 badge score,
// applying the too-early gate. `clusters` is sorted desc so clusters[0] is the
// largest. Below the gate -> null (unmeasured). At/above the gate -> the top
// cluster's fraction, or 0 when no cluster was detected (measured-and-low).
function scoreFromClusters({ holderCount, circulating, clusters }) {
  if (holderCount < MIN_HOLDERS_FOR_SCORE || circulating < MIN_CIRCULATING_WHOLE) return null;
  const top = clusters[0];
  if (!top) return 0;
  return Math.max(0, Math.min(1, top.pct_of_circulating / 100));
}

// -- Cheap board score (no fresh GraphQL) --------------------------------------
// Returns the 0..1 bundle score for a curve using ONLY data already on hand:
// temporal clusters (pure trade-row math) and funding clusters restricted to
// wallet_funders cache hits. null when below the too-early gate. Never resolves
// a new funder, so it is safe to call on a hot event path.
export async function computeBundleScoreCheap(pool, curveId) {
  const { holderCount, circulating, clusters } = await computeClusters(pool, curveId, { resolveFresh: false });
  return scoreFromClusters({ holderCount, circulating, clusters });
}

// Recompute + persist the cheap bundle score for a curve, skipping curves whose
// bundle_score_at is < 60s old (same TTL as the modal cache). Non-throwing:
// bundle scoring is a best-effort badge, never worth failing an event ingest.
export async function refreshBundleScoreCheap(pool, curveId, { force = false } = {}) {
  try {
    if (!curveId) return;
    if (!force) {
      const r = await pool.query('SELECT bundle_score_at FROM curves WHERE curve_id = $1', [curveId]);
      const at = r.rows[0]?.bundle_score_at;
      if (at != null && Date.now() - Number(at) < CACHE_TTL_MS) return; // fresh -- skip
    }
    const score = await computeBundleScoreCheap(pool, curveId);
    await pool.query(
      'UPDATE curves SET bundle_score = $2, bundle_score_at = $3 WHERE curve_id = $1',
      [curveId, score, Date.now()]
    );
  } catch (err) {
    console.error('[bundles] refreshBundleScoreCheap error:', err.message);
  }
}

export function mountBundles(app, pool) {
  app.get('/token/:curveId/bundles', async (req, res) => {
    const curveId = req.params.curveId;
    try {
      const cached = bundleCache.get(curveId);
      if (cached && Date.now() - cached.at < CACHE_TTL_MS) return res.json(cached.data);

      const { circulating, holderCount, clusters, edges, meta } =
        await computeClusters(pool, curveId, { resolveFresh: true });

      const data = {
        circulating_whole: circulating,
        holders:           holderCount,
        clusters,
        edges,
        meta,
      };
      bundleCache.set(curveId, { at: Date.now(), data });

      // Convergence: overwrite the board's cheap bundle_score with THIS fully-
      // resolved value (funders resolved live above), so opening the map and
      // returning to the board shows the same number the badge buckets from.
      // Same largest-cluster definition + too-early gate as computeBundleScoreCheap.
      const score = scoreFromClusters({ holderCount, circulating, clusters });
      pool.query(
        'UPDATE curves SET bundle_score = $2, bundle_score_at = $3 WHERE curve_id = $1',
        [curveId, score, Date.now()]
      ).catch(() => {});

      res.json(data);
    } catch (err) {
      console.error('[bundles] /token/:curveId/bundles error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });
}
