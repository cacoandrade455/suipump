// agent_actions.js — persistent agent action history for SuiPump.
//
// Self-contained: it owns the `agent_actions` table and the /agent-actions
// routes, and is mounted onto the indexer's existing Express app via
// mountAgentActions(app). It does NOT touch db.js or its schema — it ensures
// its own table. The only edit to api.js is the import + the mountAgentActions(app) call.
//
// Records EVERY agent fire (manual from the agent page, and autonomous from the
// strategy brain) so the agent page can show a persistent history that survives
// refresh. One row per fire. The manual path records a 'pending' row on fire and
// PATCHes it to 'settled' (with the leader settlement digest) once the leader
// settles, or 'fallback' if it settled via the bridge. The autonomous path
// (strategy.js recordFire) records a single row per fire.
//
// Consumers:
//   - agent-runner/strategy.js recordFire() POSTs an autonomous fire row.
//   - frontend-app/src/AgentPage.jsx POSTs a manual fire row, then PATCHes it
//     when the leader settles (via the /api/agent-actions Vercel proxy).
//
// SECURITY: write routes (POST/PATCH) are gated by STRATEGY_API_KEY when that
// env var is set on the indexer (same key/guard as orders.js) — callers must
// send header `x-strategy-key`. If unset, writes are OPEN (dev/testnet only).
// Reads (GET) are open. Recording an action never moves funds, but the guard
// keeps the history from being spammed by anonymous writers.

import { pool } from './db.js';

let schemaReady = null;
function ensureSchema() {
  if (!schemaReady) {
    schemaReady = pool.query(`
      CREATE TABLE IF NOT EXISTS agent_actions (
        id                       TEXT PRIMARY KEY,
        kind                     TEXT NOT NULL DEFAULT 'buy',
        source                   TEXT NOT NULL DEFAULT 'manual',
        curve_id                 TEXT,
        token_type               TEXT,
        summary                  TEXT,
        execution_id             TEXT,
        nexus_request_digest     TEXT,
        leader_settlement_digest TEXT,
        leader_sender            TEXT,
        settle_digest            TEXT,
        settled_via              TEXT,
        status                   TEXT NOT NULL DEFAULT 'pending',
        wallet                   TEXT,
        created_at               BIGINT,
        updated_at               BIGINT
      );
      CREATE INDEX IF NOT EXISTS idx_agent_actions_created ON agent_actions (created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_agent_actions_wallet  ON agent_actions (wallet);
      CREATE INDEX IF NOT EXISTS idx_agent_actions_source  ON agent_actions (source);
      CREATE INDEX IF NOT EXISTS idx_agent_actions_status  ON agent_actions (status);
    `).then(() => console.log('  ✓ agent_actions table ready'))
      .catch(e => { console.error('  agent_actions schema error:', e.message); schemaReady = null; });
  }
  return schemaReady;
}

function rowToAction(r) {
  return {
    id:                     r.id,
    kind:                   r.kind ?? 'buy',
    source:                 r.source ?? 'manual',
    curveId:                r.curve_id ?? null,
    tokenType:              r.token_type ?? null,
    summary:                r.summary ?? null,
    executionId:            r.execution_id ?? null,
    nexusRequestDigest:     r.nexus_request_digest ?? null,
    leaderSettlementDigest: r.leader_settlement_digest ?? null,
    leaderSender:           r.leader_sender ?? null,
    settleDigest:           r.settle_digest ?? null,
    settledVia:             r.settled_via ?? null,
    status:                 r.status ?? 'pending',
    wallet:                 r.wallet ?? null,
    createdAt:              r.created_at != null ? Number(r.created_at) : null,
    updatedAt:              r.updated_at != null ? Number(r.updated_at) : null,
  };
}

function writeGuard(req, res) {
  const key = process.env.STRATEGY_API_KEY;
  if (!key) return true;                                   // open in dev
  if (req.headers['x-strategy-key'] === key) return true;
  res.status(401).json({ error: 'unauthorized' });
  return false;
}

const KINDS  = ['buy', 'sell', 'claim', 'launch', 'launch_and_buy', 'dca', 'sniper', 'tpsl', 'copytrade'];
const STATUS = ['pending', 'settled', 'fallback', 'failed'];

export function mountAgentActions(app) {
  ensureSchema();

  // List recent actions. ?limit=50 (max 200) ?source=manual|autonomous|all ?wallet=0x..
  app.get('/agent-actions', async (req, res) => {
    try {
      await ensureSchema();
      const limit  = Math.min(200, Math.max(1, parseInt(String(req.query.limit ?? '50'), 10) || 50));
      const source = String(req.query.source ?? 'all');
      const wallet = typeof req.query.wallet === 'string' ? req.query.wallet : null;
      const where = [], vals = [];
      let i = 1;
      if (source !== 'all') { where.push(`source = $${i++}`); vals.push(source); }
      if (wallet)           { where.push(`wallet = $${i++}`); vals.push(wallet); }
      const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
      vals.push(limit);
      const r = await pool.query(
        `SELECT * FROM agent_actions ${clause} ORDER BY created_at DESC LIMIT $${i}`,
        vals,
      );
      res.json(r.rows.map(rowToAction));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/agent-actions/:id', async (req, res) => {
    try {
      await ensureSchema();
      const r = await pool.query('SELECT * FROM agent_actions WHERE id = $1', [req.params.id]);
      if (!r.rows[0]) return res.status(404).json({ error: 'not found' });
      res.json(rowToAction(r.rows[0]));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Record a fire. Returns the created row (with its id).
  app.post('/agent-actions', async (req, res) => {
    if (!writeGuard(req, res)) return;
    try {
      await ensureSchema();
      const b = req.body ?? {};
      const id = (typeof b.id === 'string' && b.id.trim())
        ? b.id.trim()
        : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      const kind   = KINDS.includes(b.kind)     ? b.kind   : 'buy';
      const source = (b.source === 'autonomous') ? 'autonomous' : 'manual';
      const status = STATUS.includes(b.status)  ? b.status : 'pending';
      const now = Date.now();
      const r = await pool.query(
        `INSERT INTO agent_actions
           (id, kind, source, curve_id, token_type, summary, execution_id,
            nexus_request_digest, leader_settlement_digest, leader_sender,
            settle_digest, settled_via, status, wallet, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$15)
         ON CONFLICT (id) DO NOTHING
         RETURNING *`,
        [
          id, kind, source,
          b.curveId ?? null, b.tokenType ?? null, b.summary ?? null,
          b.executionId ?? null, b.nexusRequestDigest ?? null,
          b.leaderSettlementDigest ?? null, b.leaderSender ?? null,
          b.settleDigest ?? null, b.settledVia ?? null,
          status, b.wallet ?? null, now,
        ],
      );
      // If the id already existed (ON CONFLICT DO NOTHING), return the existing row.
      if (!r.rows[0]) {
        const ex = await pool.query('SELECT * FROM agent_actions WHERE id = $1', [id]);
        return res.status(200).json(rowToAction(ex.rows[0]));
      }
      res.status(201).json(rowToAction(r.rows[0]));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Update a fire (e.g. pending -> settled when the leader settles, attaching the
  // leader settlement digest; or -> fallback with the bridge settle digest).
  app.patch('/agent-actions/:id', async (req, res) => {
    if (!writeGuard(req, res)) return;
    try {
      await ensureSchema();
      const b = req.body ?? {};
      const sets = [], vals = [];
      let i = 1;
      const setField = (col, val) => { sets.push(`${col} = $${i++}`); vals.push(val); };
      if (b.leaderSettlementDigest !== undefined) setField('leader_settlement_digest', b.leaderSettlementDigest ?? null);
      if (b.leaderSender           !== undefined) setField('leader_sender',            b.leaderSender ?? null);
      if (b.settleDigest           !== undefined) setField('settle_digest',            b.settleDigest ?? null);
      if (b.settledVia             !== undefined) setField('settled_via',              b.settledVia ?? null);
      if (b.nexusRequestDigest     !== undefined) setField('nexus_request_digest',     b.nexusRequestDigest ?? null);
      if (b.executionId            !== undefined) setField('execution_id',             b.executionId ?? null);
      if (b.summary                !== undefined) setField('summary',                  b.summary ?? null);
      if (b.status !== undefined && STATUS.includes(b.status)) setField('status', b.status);
      if (!sets.length) return res.status(400).json({ error: 'no updatable fields' });
      sets.push(`updated_at = $${i++}`); vals.push(Date.now());
      vals.push(req.params.id);
      const r = await pool.query(
        `UPDATE agent_actions SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`,
        vals,
      );
      if (!r.rows[0]) return res.status(404).json({ error: 'not found' });
      res.json(rowToAction(r.rows[0]));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  console.log('  ✓ /agent-actions routes mounted');
}
