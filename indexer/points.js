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

// ── Excluded wallets ────────────────────────────────────────────────────────
// Wallets filtered from BOTH /points/:address and /leaderboard/points so the
// counter and the board agree. These never earn or show points.
//
// DEFAULT_EXCLUDED is the known set as of 2026-06-26:
//   • protocol / main wallet (0x0be9…d90c55)
//   • agent wallet (0x877a…a5906) — the autopilot stress-buyer
//   • 20 script-generated stress-test wallets
//
// POINTS_EXCLUDED_WALLETS (env, comma-separated full addresses) is MERGED with
// the default, so new test wallets can be added later with no redeploy. All
// comparisons are lowercase. An exact-address allowlist (never a behavioral
// heuristic) so a real user can never be silently dropped for "looking like" a bot.
const DEFAULT_EXCLUDED = [
  // protocol / main
  '0x0be9a8f56ba3b07f295e0c7526e7f47ca3a146649b9d864d2eb47bf3acd90c55',
  // agent
  '0x877af0fae3fa4f8ea936943b59bcd66104f67cf1895302e97761a28b3c3a5906',
  // 20 stress-test wallets
  '0x1fbd3971246f1a3ad7d354012959ee7c78640e3839a6a286320d82ec2cc05f94',
  '0x04f3cf923d324574cc70bc24612b0537ba15a9e34f8dd975e5b66f89803fdc26',
  '0x12e2dbd7fe2e5bdd9dcd9f18260ba21688ca117ed3f2ad36e0ebd03a216cdefd',
  '0x730509fd67c9aff732f6a40d2aec1f7d6ed2737c73f4d843a489a4a5fc32329d',
  '0x9f3eaada73ae29ae2dbc0d4b92f21d23d0de6830e1727374890804a1f9869fcb',
  '0xb7242bacc9d94e78c39e9e19282403f4615a6ecc5becd8ab0bfee87cc4220f65',
  '0xbe9ad014a8c800d20c3573117ae3205a7ab1a3d886daf71a186e449ad0428723',
  '0xd03393081e9defaa92488830b0db8290c62397b259cdf635b144a6425589f8e9',
  '0xd35abbf1d6013f058d1a693fc7c1a434b5a3d35c406b72e53964932d10316e01',
  '0xef7bbb8c4d08d8f545e03ee2b773f06dc95200116b8c38929ce1ec54274d5b60',
  '0x04235628b174c6d5a5280af3abcb63431d652f39b2830e473807e67b5a3e630d',
  '0x0b22e8a03b1e5a39b025da85c012cb7b0e90427a8f4bfcb7cf80d6e7b1d6a965',
  '0x0cb718c005a96845440f64e2c5187858cf48bc4e345249f2ca631434eda23ab8',
  '0x16ef8dc8677999eb0840ff26efcd1b43fe40e3676974db747891910169dcfe9b',
  '0x295bf0f34080d960b9519f9ad630bca12e5e6d42fb97bcdb0f4d385902ebe9dc',
  '0x5a83946798ce1057fc8abcd2468c8bb42680e11beeff3c6fc1aa7b1239810424',
  '0xa18581924494dadd373711aaf696bb2449937e254d4da4f05eef0bb13426e70e',
  '0xc71522902c618aed9d83a43505f86c8b7c8bb593ea202c236444cac867adc4f4',
  '0xd878526e9b485417a0db08d0f16c99d6ef3c87875704ba08bf374aac20aa53cd',
  '0xfb01c5998fbadf75d616b5174d98904a30f23c79e57c61beafe69aaf19926adb',
];

const EXCLUDED = new Set(
  [
    ...DEFAULT_EXCLUDED,
    ...String(process.env.POINTS_EXCLUDED_WALLETS || '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean),
  ].map(a => a.toLowerCase())
);

function isExcluded(address) {
  return EXCLUDED.has(String(address || '').toLowerCase());
}

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
    .filter(row => row.address && !isExcluded(row.address))
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

      // Excluded wallets (protocol, agent, stress-test) always read as zero /
      // unranked — they earn no points and never appear on the board. Explicit
      // short-circuit so this holds even if the aggregation changes.
      if (isExcluded(address)) {
        return res.json({
          address,
          points:         0,
          buyVolumeSui:   0,
          buys:           0,
          distinctTokens: 0,
          rank:           null,
          totalWallets:   0,
          pointsPerSui:   POINTS_PER_SUI,
          excluded:       true,
        });
      }

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
