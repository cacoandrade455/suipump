// points.js — airdrop points store for SuiPump.
//
// Self-contained, mounted onto the indexer's Express app via mountPoints(app),
// exactly like orders.js / agent_actions.js. It owns NO table — points are
// COMPUTED on read from the immutable `events` table, so:
//   • the "snapshot of every trading wallet since testnet" is automatic and
//     retroactive to the very first trade (the events table IS the snapshot),
//   • the formula can be tuned anytime without losing the underlying data.
//
// FORMULA (frozen 2026-06-26):
//   points = (total BUY volume in SUI) × POINTS_PER_SUI
//   • BUY volume only — sum of sui_in over TokensPurchased / TokensBought.
//     Sells earn nothing, so there is no wash-trade loop: round-tripping a
//     position earns zero. A farmer can only push points up by continuously
//     buying, which on a bonding curve costs more each buy and leaves them
//     holding the bag. Farming therefore IS real buy pressure.
//   • No cap.
//   • POINTS_PER_SUI = 100 (1 SUI bought = 100 points). Display scale only;
//     the underlying ranking is identical to raw buy volume.
//
// NOTE on farming posture (documented, accepted): buy-only + no-cap is
// whale/sybil-weighted — a determined faucet-farmer with many wallets can rank
// high. Because points are computed from events, a sybil dampener (distinct-days,
// per-wallet diminishing returns) can be layered later with zero data loss.
//
// ENDPOINTS:
//   GET /points/:address            → one wallet's points + breakdown + rank
//   GET /leaderboard/points?limit=  → top N wallets by points
//
// Reads are open (same as the other read endpoints). No writes.

import { pool } from './db.js';

const MIST = 1_000_000_000;
const POINTS_PER_SUI = 100;

// Single source of truth for the per-wallet buy aggregation. Returns rows of
// { address, buy_volume_sui, buys, distinct_tokens } for ALL wallets, ordered
// by buy_volume_sui desc. Used by both endpoints so the number on the counter
// and the number on the leaderboard can never disagree.
//
// event_type matching mirrors the rest of api.js exactly:
//   buys = '%TokensPurchased' OR '%TokensBought'
// sui_in is in MIST; divide by 1e9 for SUI.
async function aggregateBuyers() {
  const r = await pool.query(
    `SELECT
       data->>'buyer'                              AS address,
       COALESCE(SUM((data->>'sui_in')::float), 0)  AS sui_in_mist,
       COUNT(*)                                    AS buys,
       COUNT(DISTINCT curve_id)                    AS distinct_tokens
     FROM events
     WHERE (event_type LIKE '%TokensPurchased' OR event_type LIKE '%TokensBought')
       AND data->>'buyer' IS NOT NULL
     GROUP BY data->>'buyer'`
  );
  return r.rows
    .map(row => {
      const buyVolumeSui = Number(row.sui_in_mist ?? 0) / MIST;
      return {
        address:        row.address,
        buyVolumeSui,
        points:         Math.floor(buyVolumeSui * POINTS_PER_SUI),
        buys:           Number(row.buys ?? 0),
        distinctTokens: Number(row.distinct_tokens ?? 0),
      };
    })
    .sort((a, b) => b.points - a.points);
}

export function mountPoints(app) {
  // Leaderboard — top N wallets by airdrop points.
  app.get('/leaderboard/points', async (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit || '50', 10), 200);
      const all   = await aggregateBuyers();
      res.json({
        pointsPerSui: POINTS_PER_SUI,
        totalWallets: all.length,
        leaders: all.slice(0, limit).map((w, i) => ({
          rank:           i + 1,
          address:        w.address,
          points:         w.points,
          buyVolumeSui:   w.buyVolumeSui,
          buys:           w.buys,
          distinctTokens: w.distinctTokens,
        })),
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // One wallet's points + breakdown + rank. Rank is computed over the full set
  // so a wallet always knows where it stands, not just whether it's top-N.
  app.get('/points/:address', async (req, res) => {
    try {
      const address = String(req.params.address || '').toLowerCase();
      if (!address) return res.status(400).json({ error: 'address required' });

      const all = await aggregateBuyers();
      const idx = all.findIndex(w => (w.address || '').toLowerCase() === address);

      if (idx === -1) {
        // Wallet has never bought — zero points, unranked. Still a valid 200 so
        // the header counter can render "0" without erroring on new wallets.
        return res.json({
          address,
          points:         0,
          buyVolumeSui:   0,
          buys:           0,
          distinctTokens: 0,
          rank:           null,
          totalWallets:   all.length,
          pointsPerSui:   POINTS_PER_SUI,
        });
      }

      const w = all[idx];
      res.json({
        address:        w.address,
        points:         w.points,
        buyVolumeSui:   w.buyVolumeSui,
        buys:           w.buys,
        distinctTokens: w.distinctTokens,
        rank:           idx + 1,
        totalWallets:   all.length,
        pointsPerSui:   POINTS_PER_SUI,
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
}
