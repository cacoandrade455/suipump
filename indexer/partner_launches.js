// partner_launches.js — Epoch launch-with-site accounting for SuiPump.
//
// Self-contained, mounted onto the indexer's Express app via
// mountPartnerLaunches(app), exactly like points.js / orders.js. Owns NO table —
// it reads the immutable `events` table, where the worker stores the Epoch
// PartnerLaunch event.
//
// On-chain proof of every site-attached launch + the 3-SUI cut. Epoch's
// record_partner_launch emits:
//   {EPOCH_PKG}::walrus_names::PartnerLaunch { partner, name, payer, amount }
// We filter to partner == 'suipump'. `amount` is in MIST.
//
// ── REQUIRED worker change (not in this file) ───────────────────────────────
// For PartnerLaunch rows to exist in `events`, the indexer WORKER (index.js)
// must subscribe to the Epoch package's events, not just SuiPump's. Add
// EPOCH_PKG to the worker's event watch set so it stores
// `{EPOCH_PKG}::walrus_names::PartnerLaunch` rows (event_type + data JSONB) the
// same way it stores bonding_curve events. Without that, this endpoint returns
// empty — the read side is correct, but there's nothing to read until the
// worker ingests the event.
//
// ENDPOINT:
//   GET /partner-launches?limit=  → { total, totalCutSui, launches:[...] }

import { pool } from './db.js';

const MIST = 1_000_000_000;
const PARTNER = 'suipump';

export function mountPartnerLaunches(app) {
  app.get('/partner-launches', async (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit || '100', 10), 500);

      // Match the PartnerLaunch event by suffix (package-agnostic, so a mainnet
      // package swap doesn't break the read), filtered to our partner tag.
      const rows = await pool.query(
        `SELECT
           data->>'name'   AS name,
           data->>'payer'  AS payer,
           data->>'amount' AS amount_mist,
           tx_digest,
           timestamp_ms
         FROM events
         WHERE event_type LIKE '%::walrus_names::PartnerLaunch'
           AND data->>'partner' = $1
         ORDER BY timestamp_ms DESC
         LIMIT $2`,
        [PARTNER, limit]
      );

      const totals = await pool.query(
        `SELECT
           COUNT(*)                                     AS total,
           COALESCE(SUM((data->>'amount')::float), 0)   AS total_mist
         FROM events
         WHERE event_type LIKE '%::walrus_names::PartnerLaunch'
           AND data->>'partner' = $1`,
        [PARTNER]
      );

      res.json({
        total:       Number(totals.rows[0]?.total ?? 0),
        totalCutSui: Number(totals.rows[0]?.total_mist ?? 0) / MIST,
        launches: rows.rows.map(r => ({
          name:      r.name,
          payer:     r.payer,
          amountSui: Number(r.amount_mist ?? 0) / MIST,
          txDigest:  r.tx_digest,
          ts:        Number(r.timestamp_ms ?? 0),
        })),
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
}
