// game_progress.js — wallet-keyed save state for the SuiPump arcade game.
//
// Self-contained: it owns the `game_progress` table and the /game-progress
// routes, and is mounted onto the indexer's existing Express app via
// mountGameProgress(app). It does NOT touch db.js or its schema — it ensures
// its own table. It reuses the shared pool exported by db.js (same pattern as
// agent_actions.js / orders.js). The only edit to api.js is the import + the
// mountGameProgress(app) call.
//
// Stores ONE progress row per wallet (the player's latest save). The browser
// saves locally (localStorage) every checkpoint with zero latency; the player
// presses "Save to wallet" to persist this row, keyed by their connected
// wallet address, so progress follows them across devices. This NEVER moves
// funds, signs a transaction, or touches any Move contract — the wallet is used
// purely as an identity key.
//
// Consumers:
//   - frontend-app/src/GamePage.jsx GETs /game-progress/:wallet on mount to
//     resume, and POSTs /game-progress to persist on the "Save to wallet" tap.
//
// SECURITY: the write route (POST) is gated by STRATEGY_API_KEY when that env
// var is set on the indexer (same key/guard as agent_actions.js / orders.js) —
// callers must send header `x-strategy-key`. If unset, writes are OPEN
// (dev/testnet only). Reads (GET) are open.

import { pool } from './db.js';

let _schemaReady = null;
async function ensureSchema() {
  if (_schemaReady) return _schemaReady;
  _schemaReady = (async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS game_progress (
        wallet         TEXT PRIMARY KEY,
        checkpoint     INTEGER     NOT NULL DEFAULT 0,
        boss_defeated  BOOLEAN     NOT NULL DEFAULT FALSE,
        deaths         INTEGER     NOT NULL DEFAULT 0,
        best_time_ms   BIGINT,
        payload        JSONB,
        created_at     BIGINT      NOT NULL,
        updated_at     BIGINT      NOT NULL
      )
    `);
  })();
  return _schemaReady;
}

function rowToProgress(r) {
  if (!r) return null;
  return {
    wallet:       r.wallet,
    checkpoint:   r.checkpoint != null ? Number(r.checkpoint) : 0,
    bossDefeated: r.boss_defeated === true,
    deaths:       r.deaths != null ? Number(r.deaths) : 0,
    bestTimeMs:   r.best_time_ms != null ? Number(r.best_time_ms) : null,
    payload:      r.payload ?? null,
    createdAt:    r.created_at != null ? Number(r.created_at) : null,
    updatedAt:    r.updated_at != null ? Number(r.updated_at) : null,
  };
}

function writeGuard(req, res) {
  const key = process.env.STRATEGY_API_KEY;
  if (!key) return true;                                   // open in dev
  if (req.headers['x-strategy-key'] === key) return true;
  res.status(401).json({ error: 'unauthorized' });
  return false;
}

// Basic sanity on a Sui address used as the key. Not a security control (the
// API key is) — just keeps junk out of the primary key.
function isWalletLike(w) {
  return typeof w === 'string' && /^0x[0-9a-fA-F]{1,64}$/.test(w);
}

export function mountGameProgress(app) {
  ensureSchema();

  // Fetch a wallet's saved progress. Open read.
  app.get('/game-progress/:wallet', async (req, res) => {
    try {
      await ensureSchema();
      const wallet = String(req.params.wallet || '');
      if (!isWalletLike(wallet)) return res.status(400).json({ error: 'bad wallet' });
      const r = await pool.query('SELECT * FROM game_progress WHERE wallet = $1', [wallet]);
      if (!r.rows[0]) return res.status(404).json({ error: 'no save' });
      res.json(rowToProgress(r.rows[0]));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Upsert a wallet's progress. One row per wallet — latest save wins.
  app.post('/game-progress', async (req, res) => {
    if (!writeGuard(req, res)) return;
    try {
      await ensureSchema();
      const b = req.body ?? {};
      const wallet = String(b.wallet || '');
      if (!isWalletLike(wallet)) return res.status(400).json({ error: 'bad wallet' });

      const checkpoint    = Number.isFinite(+b.checkpoint) ? Math.max(0, Math.floor(+b.checkpoint)) : 0;
      const bossDefeated  = b.bossDefeated === true;
      const deaths        = Number.isFinite(+b.deaths) ? Math.max(0, Math.floor(+b.deaths)) : 0;
      const bestTimeMs    = Number.isFinite(+b.bestTimeMs) ? Math.max(0, Math.floor(+b.bestTimeMs)) : null;
      const payload       = (b.payload && typeof b.payload === 'object') ? b.payload : null;
      const now = Date.now();

      const r = await pool.query(
        `INSERT INTO game_progress
           (wallet, checkpoint, boss_defeated, deaths, best_time_ms, payload, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$7)
         ON CONFLICT (wallet) DO UPDATE SET
           checkpoint    = EXCLUDED.checkpoint,
           boss_defeated = game_progress.boss_defeated OR EXCLUDED.boss_defeated,
           deaths        = EXCLUDED.deaths,
           best_time_ms  = CASE
                             WHEN game_progress.best_time_ms IS NULL THEN EXCLUDED.best_time_ms
                             WHEN EXCLUDED.best_time_ms IS NULL THEN game_progress.best_time_ms
                             ELSE LEAST(game_progress.best_time_ms, EXCLUDED.best_time_ms)
                           END,
           payload       = EXCLUDED.payload,
           updated_at    = EXCLUDED.updated_at
         RETURNING *`,
        [wallet, checkpoint, bossDefeated, deaths, bestTimeMs, payload, now],
      );
      res.status(200).json(rowToProgress(r.rows[0]));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  console.log('  ✓ /game-progress routes mounted');
}
