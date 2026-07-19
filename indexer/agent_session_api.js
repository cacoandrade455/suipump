// agent_session_api.js -- fast, indexed AgentSession lookup for a wallet.
//
// Self-contained, same pattern as takeover_api.js / orders.js: it takes the
// Express `app` and the shared pg `pool`, and adds ONE read endpoint. It owns
// no tables and never mutates anything -- all data is derived from the
// `events` table (index.js now tracks the agent_session module's five events:
// SessionOpened, SessionToppedUp, SessionBuy, SessionSell, SessionClosed).
//
// Mount from api.js with:
//     import { mountAgentSession } from './agent_session_api.js';
//     mountAgentSession(app, pool);
//
// Why this exists: AgentSessionPanel (frontend) previously resolved a wallet's
// active session by scanning the last 50 SessionOpened events LIVE via GraphQL,
// then a second live getObject call for current state -- two network round
// trips to a third-party RPC on every page load, with a silent "no session"
// fallback on any hiccup. This route answers the same question from the
// indexer's own Postgres in one query, using data the indexer already has.
//
// Endpoint:
//   GET /agent/session?owner=0x...
//     -> {} when this owner has no session on record, otherwise:
//        {
//          sessionId, ownerAddr, sessionAddress,
//          escrow, spent, spendCap, expiryMs, revoked, attested,
//        }
//     `escrow` is the deposit amount as of the LAST recorded state-changing
//     event (SessionOpened's deposit, or a later TopUp/Buy/Sell/Closed's
//     running total) -- the same value AgentSessionPanel's getObject call
//     would show, just sourced from history instead of a live read.

export function mountAgentSession(app, pool) {
  // Owner-history index (mainnet scale): /agent/sessions filters SessionOpened
  // rows by owner, which without this is a sequential scan of the whole events
  // table. Partial expression index keeps it tiny (SessionOpened rows only)
  // and matches the route's LOWER() comparison exactly. Fire-and-forget: a
  // failure only costs speed, never correctness.
  pool.query(
    `CREATE INDEX IF NOT EXISTS idx_events_session_opened_owner
       ON events (LOWER(data->>'owner'), timestamp_ms DESC)
     WHERE event_type LIKE '%SessionOpened'`
  ).catch(e => console.warn('[agent_session] owner index create failed:', e.message));

  // Full session history for a wallet -- every AgentSession this owner ever
  // opened, deduped by session_id, newest first. Powers the frontend's
  // SWEEP ALL cross-session discovery (replacing its testnet-era live GraphQL
  // scan of the last 200 SessionOpened events, which caps out at chain-RPC
  // pagination limits and third-party availability).
  //
  //   GET /agent/sessions?owner=0x...[&limit=50]
  //     -> [{ session_id, session_address, deposit, spend_cap, expiry_ms,
  //           opened_at_ms, tx_digest }]  (possibly empty)
  app.get('/agent/sessions', async (req, res) => {
    const owner = typeof req.query.owner === 'string' ? req.query.owner.trim() : '';
    if (!/^0x[0-9a-fA-F]{1,64}$/.test(owner)) {
      return res.status(400).json({ error: 'owner query param required (0x... address)' });
    }
    const limit = Math.min(Math.max(parseInt(req.query.limit ?? '50', 10) || 50, 1), 200);
    try {
      const r = await pool.query(
        `SELECT DISTINCT ON (data->>'session_id')
                data->>'session_id'      AS session_id,
                data->>'session_address' AS session_address,
                data->>'deposit'         AS deposit,
                data->>'spend_cap'       AS spend_cap,
                data->>'expiry_ms'       AS expiry_ms,
                timestamp_ms             AS opened_at_ms,
                tx_digest
           FROM events
          WHERE event_type LIKE '%SessionOpened'
            AND LOWER(data->>'owner') = LOWER($1)
          ORDER BY data->>'session_id', timestamp_ms DESC NULLS LAST
          LIMIT $2`,
        [owner, limit]
      );
      // DISTINCT ON orders by session_id; re-sort newest first for the caller.
      const rows = r.rows
        .filter(x => x.session_id)
        .sort((a, b) => Number(b.opened_at_ms ?? 0) - Number(a.opened_at_ms ?? 0));
      res.json(rows);
    } catch (err) {
      console.error('[agent_session] /agent/sessions error:', err.message);
      res.status(500).json({ error: 'sessions lookup failed' });
    }
  });

  app.get('/agent/session', async (req, res) => {
    const owner = typeof req.query.owner === 'string' ? req.query.owner : null;
    if (!owner) return res.status(400).json({ error: 'owner query param required' });

    try {
      // 1. Most recent SessionOpened for this owner -- the session identity.
      const openRes = await pool.query(
        `SELECT data, timestamp_ms
           FROM events
          WHERE event_type LIKE '%SessionOpened'
            AND (data->>'owner') = $1
          ORDER BY timestamp_ms DESC NULLS LAST, id DESC
          LIMIT 1`,
        [owner]
      );
      if (!openRes.rows.length) return res.json({});

      const opened = openRes.rows[0].data ?? {};
      const sessionId = opened.session_id ?? null;
      if (!sessionId) return res.json({});

      // Escrow and spent are tracked by DIFFERENT event types (SessionBuy never
      // emits a resulting escrow figure, since bought tokens go to a dynamic
      // field, not back to escrow) -- so they are looked up INDEPENDENTLY rather
      // than from "the single most recent event," which would go stale on
      // escrow whenever the latest event happens to be a buy.
      const [escrowRes, spentRes, closedRes, attestedRes] = await Promise.all([
        // Most recent event that actually reports a resulting escrow balance.
        pool.query(
          `SELECT event_type, data
             FROM events
            WHERE (data->>'session_id') = $1
              AND (event_type LIKE '%SessionToppedUp' OR event_type LIKE '%SessionSell')
            ORDER BY timestamp_ms DESC NULLS LAST, id DESC
            LIMIT 1`,
          [sessionId]
        ),
        // Most recent buy -- the only event carrying a spent running total.
        pool.query(
          `SELECT data
             FROM events
            WHERE (data->>'session_id') = $1
              AND event_type LIKE '%SessionBuy'
            ORDER BY timestamp_ms DESC NULLS LAST, id DESC
            LIMIT 1`,
          [sessionId]
        ),
        // Has this session been closed (close_session or expire_refund)?
        pool.query(
          `SELECT 1
             FROM events
            WHERE (data->>'session_id') = $1
              AND event_type LIKE '%SessionClosed'
            LIMIT 1`,
          [sessionId]
        ),
        // Was this session opened via open_and_share_attested (Nautilus)?
        // SessionAttested is emitted exactly once, in the SAME tx as
        // SessionOpened, and there is no un-attest path -- event existence IS
        // the state, so a simple EXISTS answers it with no staleness class.
        // The LIKE predicate is package-agnostic on purpose: the event types
        // under its defining package (V12 for the V10 lineage; a V13-lineage
        // SessionAttested would match here too, automatically).
        pool.query(
          `SELECT 1
             FROM events
            WHERE (data->>'session_id') = $1
              AND event_type LIKE '%SessionAttested'
            LIMIT 1`,
          [sessionId]
        ),
      ]);

      const revoked = closedRes.rows.length > 0;
      const attested = attestedRes.rows.length > 0;
      const escrow  = revoked
        ? '0'
        : String(escrowRes.rows[0]?.data?.new_escrow ?? opened.deposit ?? '0');
      const spent   = String(spentRes.rows[0]?.data?.spent_total ?? '0');
      // KNOWN GAP: SessionBuy does not emit a resulting escrow figure (only
      // sui_spent and spent_total) -- so if the most recent session activity is
      // a buy with no top-up/sell since, `escrow` above is genuinely the
      // PRE-buy balance, not current. This is not a query bug: the number is
      // not emitted anywhere on-chain for this route to find. A caller that
      // needs the true current escrow after a recent buy should do a live
      // getObject on `sessionId` as a fallback, same as AgentSessionPanel did
      // before this route existed -- this endpoint is a fast first-paint, not a
      // guaranteed-fresh balance. (Possible real fix: have buy_with_session's
      // SessionBuy event also emit the resulting escrow value, closing this at
      // the source -- unverified whether that's upgrade-compatible on the live
      // V10 package or needs a fresh publish; check before relying on it.)

      res.json({
        sessionId,
        ownerAddr:      opened.owner ?? owner,
        sessionAddress: opened.session_address ?? null,
        escrow,
        spent,
        spendCap:  String(opened.spend_cap ?? '0'),
        expiryMs:  Number(opened.expiry_ms ?? 0),
        revoked,
        attested,
      });
    } catch (err) {
      console.error('[agent_session] /agent/session error:', err.message);
      res.status(500).json({ error: 'session lookup failed' });
    }
  });
}
