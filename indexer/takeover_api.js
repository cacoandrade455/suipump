// takeover_api.js - V10 Community Takeover (CTO) read route.
//
// Self-contained, same pattern as orders.js / agent_actions.js: it takes the
// Express `app` and the shared pg `pool`, and adds ONE read endpoint. It owns no
// tables and never mutates anything - all data is derived from the `events`
// table the indexer already writes (the V10 Takeover* and CreatorHeartbeat
// events all carry curve_id, so they're already persisted there).
//
// Mount from api.js with:
//     import { mountTakeover } from './takeover_api.js';
//     mountTakeover(app, pool);
//
// Endpoint:
//   GET /token/:id/takeover
//     -> {} when there is no active proposal, otherwise:
//        {
//          proposal_id, nominee, nominator,
//          snapshot_supply, closes_ms,
//          for_weight, against_weight,
//          initial_shared_version,        // null -- proposal obj version not in events
//          last_creator_activity_ms,      // latest heartbeat, else curve created_at
//          last_creator_activity_source,  // 'heartbeat' | 'launch_fallback' --
//                                          //   the contract's ONLY activity signal is
//                                          //   an explicit creator_heartbeat call, so a
//                                          //   creator who is genuinely active but has
//                                          //   never heartbeated reads identically to an
//                                          //   abandoned one on-chain. 'launch_fallback'
//                                          //   tells the frontend this number is a guess
//                                          //   from launch time, not a real reading --
//                                          //   show "never heartbeated", not a stale-
//                                          //   looking activity date.
//        }
//
// "Active" = the most recent TakeoverProposed for this curve whose proposal_id
// has NOT yet been consumed by a TakeoverSucceeded or TakeoverFailed.

export function mountTakeover(app, pool) {
  app.get('/token/:id/takeover', async (req, res) => {
    const curveId = req.params.id;
    if (!curveId) return res.status(400).json({ error: 'curve id required' });

    try {
      // 1. Latest proposal for this curve.
      const propRes = await pool.query(
        `SELECT data, timestamp_ms
           FROM events
          WHERE curve_id = $1
            AND event_type LIKE '%TakeoverProposed'
          ORDER BY timestamp_ms DESC NULLS LAST, id DESC
          LIMIT 1`,
        [curveId]
      );

      // last_creator_activity_ms is useful even with no proposal, so compute it
      // regardless: latest CreatorHeartbeat for the curve, else the curve's
      // created_at. (Heartbeat.at_ms and curves.created_at are both epoch ms.)
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

      if (!propRes.rows.length) {
        return res.json({ last_creator_activity_ms: lastActivity, last_creator_activity_source: activitySource });
      }

      const prop = propRes.rows[0].data ?? {};
      const proposalId = prop.proposal_id ?? null;
      if (!proposalId) {
        return res.json({ last_creator_activity_ms: lastActivity, last_creator_activity_source: activitySource });
      }

      // 2. Has this proposal already been resolved (succeeded or failed)?
      const resolvedRes = await pool.query(
        `SELECT 1
           FROM events
          WHERE curve_id = $1
            AND (event_type LIKE '%TakeoverSucceeded' OR event_type LIKE '%TakeoverFailed')
            AND (data->>'proposal_id') = $2
          LIMIT 1`,
        [curveId, proposalId]
      );
      if (resolvedRes.rows.length) {
        // Resolved -- no active proposal to surface.
        return res.json({ last_creator_activity_ms: lastActivity, last_creator_activity_source: activitySource });
      }

      // 3. Tally votes for this proposal_id. Weights are u64 strings on-chain;
      //    sum as NUMERIC to avoid float loss, return as strings.
      const voteRes = await pool.query(
        `SELECT (data->>'support')::boolean AS support,
                SUM((data->>'weight')::numeric) AS total
           FROM events
          WHERE curve_id = $1
            AND event_type LIKE '%TakeoverVoted'
            AND (data->>'proposal_id') = $2
          GROUP BY (data->>'support')::boolean`,
        [curveId, proposalId]
      );
      let forWeight = 0n, againstWeight = 0n;
      for (const row of voteRes.rows) {
        const w = BigInt(String(row.total ?? '0').split('.')[0] || '0');
        if (row.support === true) forWeight = w; else againstWeight = w;
      }

      return res.json({
        proposal_id:            proposalId,
        nominee:                prop.nominee ?? null,
        nominator:              prop.nominator ?? null,
        snapshot_supply:        prop.snapshot_supply ?? '0',
        closes_ms:              Number(prop.closes_ms ?? 0),
        for_weight:             forWeight.toString(),
        against_weight:         againstWeight.toString(),
        initial_shared_version: null, // proposal object version is not in events
        last_creator_activity_ms:     lastActivity,
        last_creator_activity_source: activitySource,
      });
    } catch (err) {
      console.error('[takeover] /token/:id/takeover error:', err.message);
      res.status(500).json({ error: 'takeover lookup failed' });
    }
  });
}
