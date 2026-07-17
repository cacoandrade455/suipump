// takeover_api.js - V13 Community Takeover (CTO) read route.
//
// Self-contained, same pattern as orders.js / agent_actions.js: it takes the
// Express `app` and the shared pg `pool`, and adds ONE read endpoint. It owns no
// tables and never mutates anything - all data is derived from the `events`
// table the indexer already writes.
//
// V13 CTO event schema (these REPLACE the old CTO takeover events entirely):
//   TakeoverProposed { curve_id, proposal_id, proposer, deadline_ms }
//   TakeoverVoted    { proposal_id, voter, amount, total_weight }   (no curve_id)
//   TakeoverUnvoted  { proposal_id, voter, amount }                 (no curve_id)
//   TakeoverResolved { proposal_id, curve_id, succeeded, total_weight }
//   VoteReclaimed    { proposal_id, voter, amount }                 (no curve_id)
// The vote/unvote/reclaim events are PROPOSAL-keyed (no curve_id), so this route
// keys the vote tally on proposal_id, not curve_id. TakeoverProposed and
// TakeoverResolved carry curve_id and are found by curve.
//
// Mount from api.js with:
//     import { mountTakeover } from './takeover_api.js';
//     mountTakeover(app, pool);
//
// Endpoint:
//   GET /token/:id/takeover
//     -> when there is no proposal for the curve:
//        { last_creator_activity_ms, last_creator_activity_source }
//     -> otherwise:
//        {
//          proposal_id, proposer,
//          deadline_ms,                   // number (epoch ms)
//          total_weight,                  // string -- live tally = SUM(voted.amount)
//                                         //   MINUS SUM(unvoted.amount) for this
//                                         //   proposal_id, as NUMERIC (u64 strings
//                                         //   on-chain), fractional part stripped.
//                                         //   Derived from voted-minus-unvoted, NOT
//                                         //   the event's own total_weight field
//                                         //   (that field is not decremented by
//                                         //   unvote, so it would over-count).
//          resolved,                      // bool -- a TakeoverResolved exists for
//                                         //   this proposal_id
//          succeeded,                     // bool -- the resolved row's succeeded flag
//          initial_shared_version,        // the TakeoverProposal object's shared
//                                         //   version, fetched live (not in events)
//                                         //   -- only looked up while resolved=false
//                                         //   (an active proposal the user will act
//                                         //   on); null when resolved, or when the
//                                         //   lookup itself fails (callers handle
//                                         //   null with a tx.object() fallback)
//          last_creator_activity_ms,      // latest CreatorHeartbeat.at_ms, else curve created_at
//          last_creator_activity_source,  // 'heartbeat' | 'launch_fallback' --
//                                         //   the contract's ONLY activity signal is
//                                         //   an explicit creator_heartbeat call, so a
//                                         //   creator who is genuinely active but has
//                                         //   never heartbeated reads identically to an
//                                         //   abandoned one on-chain. 'launch_fallback'
//                                         //   tells the frontend this number is a guess
//                                         //   from launch time, not a real reading --
//                                         //   show "never heartbeated", not a stale-
//                                         //   looking activity date.
//        }
//
// The LATEST proposal for the curve = the most recent TakeoverProposed row for
// it. resolved/succeeded come from any TakeoverResolved row matching that
// proposal_id. CreatorHeartbeat is UNCHANGED, so last_creator_activity_* is
// computed exactly as before and is returned even when no proposal exists.
//
// initial_shared_version for the TakeoverProposal object is NOT emitted in any
// event (it's the object's owner metadata, only available from a direct chain
// read) -- so this module does one live GraphQL lookup for it, but only when the
// proposal is unresolved (still actionable). Kept as its own minimal client (not
// importing index.js's internals) to preserve this module's "reads only pool +
// one narrow chain call" self-containment, same spirit as orders.js owning only
// its table.
import { SuiGraphQLClient } from '@mysten/sui/graphql';

const TAKEOVER_GRAPHQL_URL = process.env.SUI_GRAPHQL_URL
  ?? `https://graphql.${process.env.NETWORK ?? 'testnet'}.sui.io/graphql`;
const takeoverGqlClient = new SuiGraphQLClient({ url: TAKEOVER_GRAPHQL_URL });

async function fetchProposalSharedVersion(proposalId) {
  try {
    const result = await takeoverGqlClient.query({
      query: `query($id: SuiAddress!) { object(address: $id) { owner { ... on Shared { initialSharedVersion } } } }`,
      variables: { id: proposalId },
    });
    return result?.data?.object?.owner?.initialSharedVersion ?? null;
  } catch {
    return null; // degrade to null -- callers already handle a missing version (tx.object fallback)
  }
}

export function mountTakeover(app, pool) {
  app.get('/token/:id/takeover', async (req, res) => {
    const curveId = req.params.id;
    if (!curveId) return res.status(400).json({ error: 'curve id required' });

    try {
      // last_creator_activity_ms is useful even with no proposal, so compute it
      // regardless: latest CreatorHeartbeat for the curve, else the curve's
      // created_at. (Heartbeat.at_ms and curves.created_at are both epoch ms.)
      // CreatorHeartbeat is UNCHANGED by the V13 CTO rewrite.
      const hbRes = await pool.query(
        `SELECT (data->>'at_ms') AS at_ms
           FROM events
          WHERE curve_id = $1
            AND event_type LIKE '%CreatorHeartbeat'
          ORDER BY timestamp_ms DESC NULLS LAST, id DESC
          LIMIT 1`,
        [curveId]
      );
      let lastActivity = hbRes.rows[0]?.at_ms != null ? Number(hbRes.rows[0].at_ms) : null;
      // The contract's ONLY activity signal is an explicit creator_heartbeat call
      // -- it has no notion of "creator traded/claimed fees counts as active."
      // A creator who is genuinely active but has never clicked heartbeat is
      // indistinguishable, on-chain, from an abandoned one. That's a contract
      // design property, not something this route can fix by reading different
      // data -- so instead of hiding it, expose WHICH signal this number is, so
      // the frontend can show "never heartbeated" rather than implying a real
      // activity reading.
      let activitySource = 'heartbeat';
      if (lastActivity == null) {
        const cRes = await pool.query(
          `SELECT created_at FROM curves WHERE curve_id = $1`,
          [curveId]
        );
        lastActivity = cRes.rows[0]?.created_at != null ? Number(cRes.rows[0].created_at) : null;
        activitySource = 'launch_fallback';
      }

      // 1. Latest proposal for this curve. TakeoverProposed carries curve_id.
      const propRes = await pool.query(
        `SELECT data
           FROM events
          WHERE curve_id = $1
            AND event_type LIKE '%TakeoverProposed'
          ORDER BY timestamp_ms DESC NULLS LAST, id DESC
          LIMIT 1`,
        [curveId]
      );

      if (!propRes.rows.length) {
        return res.json({ last_creator_activity_ms: lastActivity, last_creator_activity_source: activitySource });
      }

      const prop = propRes.rows[0].data ?? {};
      const proposalId = prop.proposal_id ?? null;
      if (!proposalId) {
        return res.json({ last_creator_activity_ms: lastActivity, last_creator_activity_source: activitySource });
      }

      // 2. Has this proposal been resolved? TakeoverResolved is proposal-keyed
      //    (also carries curve_id, but we match on proposal_id to be exact).
      const resolvedRes = await pool.query(
        `SELECT (data->>'succeeded')::boolean AS succeeded
           FROM events
          WHERE event_type LIKE '%TakeoverResolved'
            AND (data->>'proposal_id') = $1
          ORDER BY timestamp_ms DESC NULLS LAST, id DESC
          LIMIT 1`,
        [proposalId]
      );
      const resolved = resolvedRes.rows.length > 0;
      const succeeded = resolved && resolvedRes.rows[0].succeeded === true;

      // 3. Live weight tally for this proposal_id = SUM(voted.amount) minus
      //    SUM(unvoted.amount). Vote/unvote events are PROPOSAL-keyed (no
      //    curve_id), so we key on proposal_id, not curve_id. Amounts are u64
      //    strings on-chain; sum as NUMERIC to avoid float loss. Derived from
      //    voted-minus-unvoted (NOT the event's own total_weight, which the
      //    Voted event does not decrement on unvote).
      const votedRes = await pool.query(
        `SELECT COALESCE(SUM((data->>'amount')::numeric), 0) AS total
           FROM events
          WHERE event_type LIKE '%TakeoverVoted'
            AND (data->>'proposal_id') = $1`,
        [proposalId]
      );
      const unvotedRes = await pool.query(
        `SELECT COALESCE(SUM((data->>'amount')::numeric), 0) AS total
           FROM events
          WHERE event_type LIKE '%TakeoverUnvoted'
            AND (data->>'proposal_id') = $1`,
        [proposalId]
      );
      const votedTotal   = BigInt(String(votedRes.rows[0]?.total ?? '0').split('.')[0] || '0');
      const unvotedTotal = BigInt(String(unvotedRes.rows[0]?.total ?? '0').split('.')[0] || '0');
      let totalWeight = votedTotal - unvotedTotal;
      if (totalWeight < 0n) totalWeight = 0n;

      // One live lookup, only while the proposal is still actionable (unresolved)
      // -- not derivable from indexed events (see the module-level note above).
      const initialSharedVersion = resolved ? null : await fetchProposalSharedVersion(proposalId);

      return res.json({
        proposal_id:            proposalId,
        proposer:               prop.proposer ?? null,
        deadline_ms:            Number(prop.deadline_ms ?? 0),
        total_weight:           totalWeight.toString(),
        resolved,
        succeeded,
        initial_shared_version: initialSharedVersion,
        last_creator_activity_ms:     lastActivity,
        last_creator_activity_source: activitySource,
      });
    } catch (err) {
      console.error('[takeover] /token/:id/takeover error:', err.message);
      res.status(500).json({ error: 'takeover lookup failed' });
    }
  });
}
