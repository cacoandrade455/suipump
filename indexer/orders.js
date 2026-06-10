// orders.js — strategy order store for the SuiPump strategy brain.
//
// Self-contained: it owns the `strategy_orders` table and the /orders CRUD
// routes, and is mounted onto the indexer's existing Express app via
// mountOrders(app). It does NOT touch db.js or its schema — it ensures its
// own table. The only edit to api.js is the import + the mountOrders(app) call.
//
// Consumers:
//   - the strategy brain (agent-runner/strategy.js) loads active orders, then
//     PATCHes fired-rung / done state back so it can resume after a restart.
//   - a future strategies UI can create/cancel orders through the same routes.
//
// SECURITY: write routes (POST/PATCH/DELETE) are gated by STRATEGY_API_KEY when
// that env var is set on the indexer — callers must send header `x-strategy-key`.
// If unset, writes are OPEN (dev/testnet only). Set it before mainnet: an open
// POST lets anyone queue a sell the brain will execute from the invoker wallet.

import { pool } from './db.js';

let schemaReady = null;
function ensureSchema() {
  if (!schemaReady) {
    schemaReady = pool.query(`
      CREATE TABLE IF NOT EXISTS strategy_orders (
        id           TEXT PRIMARY KEY,
        curve_id     TEXT NOT NULL,
        token_type   TEXT,
        entry_price  DOUBLE PRECISION,
        min_sui_out  BIGINT NOT NULL DEFAULT 0,
        take_profit  JSONB NOT NULL DEFAULT '[]'::jsonb,
        stop_loss    JSONB,
        status       TEXT NOT NULL DEFAULT 'active',
        created_at   BIGINT,
        updated_at   BIGINT
      );
      CREATE INDEX IF NOT EXISTS idx_strategy_orders_status ON strategy_orders (status);
      CREATE INDEX IF NOT EXISTS idx_strategy_orders_curve  ON strategy_orders (curve_id);
    `).then(() => console.log('  ✓ strategy_orders table ready'))
      .catch(e => { console.error('  strategy_orders schema error:', e.message); schemaReady = null; });
  }
  return schemaReady;
}

// node-pg parses JSONB into JS values already, so take_profit / stop_loss arrive
// as an array / object (or null).
function rowToOrder(r) {
  return {
    id:            r.id,
    curveId:       r.curve_id,
    tokenType:     r.token_type ?? null,
    entryPriceSui: r.entry_price ?? null,
    minSuiOut:     Number(r.min_sui_out ?? 0),
    takeProfit:    Array.isArray(r.take_profit) ? r.take_profit : [],
    stopLoss:      r.stop_loss ?? null,
    status:        r.status,
    createdAt:     r.created_at != null ? Number(r.created_at) : null,
    updatedAt:     r.updated_at != null ? Number(r.updated_at) : null,
  };
}

const isHex = (s) => typeof s === 'string' && /^0x[0-9a-fA-F]+$/.test(s);

function sanitizeRungs(tp) {
  if (!Array.isArray(tp)) return [];
  return tp.map(r => {
    const o = { sellPct: Number(r.sellPct), fired: r.fired === true };
    if (r.multiple != null) o.multiple = Number(r.multiple);
    if (r.priceSui != null) o.priceSui = Number(r.priceSui);
    return o;
  }).filter(r => Number.isFinite(r.sellPct) && r.sellPct > 0 &&
                 (Number.isFinite(r.multiple) || Number.isFinite(r.priceSui)));
}

function sanitizeStop(sl) {
  if (!sl) return null;
  const o = {};
  if (sl.multiple != null) o.multiple = Number(sl.multiple);
  if (sl.priceSui != null) o.priceSui = Number(sl.priceSui);
  if (!Number.isFinite(o.multiple) && !Number.isFinite(o.priceSui)) return null;
  return o;
}

function writeGuard(req, res) {
  const key = process.env.STRATEGY_API_KEY;
  if (!key) return true;                                   // open in dev
  if (req.headers['x-strategy-key'] === key) return true;
  res.status(401).json({ error: 'unauthorized' });
  return false;
}

export function mountOrders(app) {
  ensureSchema();

  // List. ?status=active (default) | done | cancelled | all
  app.get('/orders', async (req, res) => {
    try {
      await ensureSchema();
      const status = String(req.query.status ?? 'active');
      const r = status === 'all'
        ? await pool.query('SELECT * FROM strategy_orders ORDER BY created_at DESC')
        : await pool.query('SELECT * FROM strategy_orders WHERE status = $1 ORDER BY created_at DESC', [status]);
      res.json(r.rows.map(rowToOrder));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/orders/:id', async (req, res) => {
    try {
      await ensureSchema();
      const r = await pool.query('SELECT * FROM strategy_orders WHERE id = $1', [req.params.id]);
      if (!r.rows[0]) return res.status(404).json({ error: 'not found' });
      res.json(rowToOrder(r.rows[0]));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/orders', async (req, res) => {
    if (!writeGuard(req, res)) return;
    try {
      await ensureSchema();
      const b = req.body ?? {};
      if (!isHex(b.curveId)) return res.status(400).json({ error: 'curveId (0x...) required' });
      const tp = sanitizeRungs(b.takeProfit);
      const sl = sanitizeStop(b.stopLoss);
      if (!tp.length && !sl) return res.status(400).json({ error: 'need a takeProfit rung or a stopLoss' });
      const id = (typeof b.id === 'string' && b.id.trim())
        ? b.id.trim()
        : `ord_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const now       = Date.now();
      const entry     = (b.entryPriceSui != null && Number.isFinite(Number(b.entryPriceSui))) ? Number(b.entryPriceSui) : null;
      const tokenType = typeof b.tokenType === 'string' ? b.tokenType : null;
      const minSuiOut = Number.isFinite(Number(b.minSuiOut)) ? Math.trunc(Number(b.minSuiOut)) : 0;
      await pool.query(
        `INSERT INTO strategy_orders
           (id, curve_id, token_type, entry_price, min_sui_out, take_profit, stop_loss, status, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,'active',$8,$8)
         ON CONFLICT (id) DO NOTHING`,
        [id, b.curveId, tokenType, entry, minSuiOut, JSON.stringify(tp), sl ? JSON.stringify(sl) : null, now]
      );
      const r = await pool.query('SELECT * FROM strategy_orders WHERE id = $1', [id]);
      res.status(201).json(rowToOrder(r.rows[0]));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Partial update. The brain uses this to persist entry_price, fired flags,
  // and status; a UI can use it to edit targets.
  app.patch('/orders/:id', async (req, res) => {
    if (!writeGuard(req, res)) return;
    try {
      await ensureSchema();
      const b = req.body ?? {};
      const sets = [], vals = [];
      let i = 1;
      if (b.entryPriceSui !== undefined) { sets.push(`entry_price = $${i++}`); vals.push(b.entryPriceSui == null ? null : Number(b.entryPriceSui)); }
      if (b.takeProfit    !== undefined) { sets.push(`take_profit = $${i++}::jsonb`); vals.push(JSON.stringify(sanitizeRungs(b.takeProfit))); }
      if (b.stopLoss      !== undefined) { sets.push(`stop_loss = $${i++}::jsonb`); const s = sanitizeStop(b.stopLoss); vals.push(s ? JSON.stringify(s) : null); }
      if (b.minSuiOut     !== undefined) { sets.push(`min_sui_out = $${i++}`); vals.push(Math.trunc(Number(b.minSuiOut)) || 0); }
      if (b.status !== undefined && ['active', 'done', 'cancelled'].includes(b.status)) { sets.push(`status = $${i++}`); vals.push(b.status); }
      if (!sets.length) return res.status(400).json({ error: 'no updatable fields' });
      sets.push(`updated_at = $${i++}`); vals.push(Date.now());
      vals.push(req.params.id);
      const r = await pool.query(`UPDATE strategy_orders SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`, vals);
      if (!r.rows[0]) return res.status(404).json({ error: 'not found' });
      res.json(rowToOrder(r.rows[0]));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Cancel (soft) — mark cancelled so the brain stops tracking it.
  app.delete('/orders/:id', async (req, res) => {
    if (!writeGuard(req, res)) return;
    try {
      await ensureSchema();
      const r = await pool.query(
        `UPDATE strategy_orders SET status = 'cancelled', updated_at = $2 WHERE id = $1 RETURNING id`,
        [req.params.id, Date.now()]
      );
      if (!r.rows[0]) return res.status(404).json({ error: 'not found' });
      res.json({ ok: true, id: r.rows[0].id, status: 'cancelled' });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  console.log('  ✓ /orders routes mounted');
}
