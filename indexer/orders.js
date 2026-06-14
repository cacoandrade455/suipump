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
        curve_id     TEXT,
        token_type   TEXT,
        type         TEXT NOT NULL DEFAULT 'tpsl',
        params       JSONB NOT NULL DEFAULT '{}'::jsonb,
        entry_price  DOUBLE PRECISION,
        min_sui_out  BIGINT NOT NULL DEFAULT 0,
        take_profit  JSONB NOT NULL DEFAULT '[]'::jsonb,
        stop_loss    JSONB,
        status       TEXT NOT NULL DEFAULT 'active',
        created_at   BIGINT,
        updated_at   BIGINT
      );
      ALTER TABLE strategy_orders ADD COLUMN IF NOT EXISTS type   TEXT  NOT NULL DEFAULT 'tpsl';
      ALTER TABLE strategy_orders ADD COLUMN IF NOT EXISTS params JSONB NOT NULL DEFAULT '{}'::jsonb;
      ALTER TABLE strategy_orders ALTER COLUMN curve_id DROP NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_strategy_orders_status ON strategy_orders (status);
      CREATE INDEX IF NOT EXISTS idx_strategy_orders_curve  ON strategy_orders (curve_id);
      CREATE INDEX IF NOT EXISTS idx_strategy_orders_type   ON strategy_orders (type);
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
    curveId:       r.curve_id ?? null,
    tokenType:     r.token_type ?? null,
    type:          r.type ?? 'tpsl',
    params:        (r.params && typeof r.params === 'object' && !Array.isArray(r.params)) ? r.params : {},
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

const ORDER_TYPES = ['tpsl', 'sniper', 'dca', 'copytrade'];

// sanitizeThen — validate an optional `then` chaining block. After a buy-strategy
// (sniper/dca/copytrade) settles a buy, the brain arms whatever `then` specifies
// on the bought curve. Today the only child is `tpsl` (an auto-exit). Returns a
// clean { tpsl: { takeProfit, stopLoss } } or null. Structured so more child
// types can be added without changing callers.
function sanitizeThen(then) {
  if (!then || typeof then !== 'object' || Array.isArray(then)) return null;
  if (then.tpsl && typeof then.tpsl === 'object') {
    const tp = sanitizeRungs(then.tpsl.takeProfit);
    const sl = sanitizeStop(then.tpsl.stopLoss);
    if (tp.length || sl) return { tpsl: { takeProfit: tp, stopLoss: sl } };
  }
  return null;
}

// Validate + clean per-type params for the non-tpsl strategies. Returns a clean
// params object, or null if required fields are missing/invalid. These shapes
// are the contract the strategy brain's handlers (A2/A3/A4) will consume.
function sanitizeParams(type, raw) {
  const p = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
  const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
  const slippage = num(p.slippageBps);

  if (type === 'sniper') {
    // Buy `amountSui` the moment a NEW launch matches the filters. This shape is
    // the exact contract the strategy brain's sniper handler reads:
    //   ev.data.creator  vs  creators[]   (OR within the list)
    //   ev.data.symbol   vs  symbols[]    (OR within the list, exact)
    //   ev.data.name     vs  nameIncludes (case-insensitive substring)
    // `match` controls AND ("all", default) vs OR ("any") ACROSS those categories.
    // With NO filters, `all:true` is required to opt into sniping every launch
    // (guard against accidentally draining the agent wallet on the whole chain).
    // `maxSnipes` caps total fires (optional; UNBOUNDED if omitted — by design).
    // `fired` is the internal counter; it is preserved across re-creates / PATCH
    // round-trips so a restart resumes the cap correctly.
    const amountSui = num(p.amountSui);
    if (!(amountSui > 0)) return null;

    const creators = Array.isArray(p.creators)
      ? p.creators.filter(isHex).map(s => s.toLowerCase())
      : [];
    const symbols = Array.isArray(p.symbols)
      ? p.symbols.filter(s => typeof s === 'string' && s.trim())
          .map(s => s.trim().toUpperCase().slice(0, 12))
      : [];
    const nameIncludes = (typeof p.nameIncludes === 'string' && p.nameIncludes.trim())
      ? p.nameIncludes.trim().toLowerCase().slice(0, 64)
      : null;

    const hasFilter = creators.length > 0 || symbols.length > 0 || nameIncludes != null;
    const all = p.all === true;
    // Require at least one filter, OR an explicit all-launches opt-in.
    if (!hasFilter && !all) return null;

    const out = { amountSui };
    if (creators.length)     out.creators = creators;
    if (symbols.length)      out.symbols = symbols;
    if (nameIncludes != null) out.nameIncludes = nameIncludes;
    // `all` is only meaningful with NO filters; if filters are present it is
    // dropped so a stray all:true can never silently bypass the filters.
    if (!hasFilter && all)   out.all = true;
    out.match = p.match === 'any' ? 'any' : 'all';

    const maxSnipes = num(p.maxSnipes);
    if (maxSnipes > 0) out.maxSnipes = Math.trunc(maxSnipes);

    // Preserve the fired counter on re-create / PATCH; default to 0.
    const fired = num(p.fired);
    out.fired = (fired != null && fired >= 0) ? Math.trunc(fired) : 0;

    // Preserve curves already sniped (brain PATCHes this back so a restart
    // doesn't re-buy a past launch).
    if (Array.isArray(p.snipedCurves)) out.snipedCurves = p.snipedCurves.filter(isHex);

    // Optional `then` chaining (e.g. arm TP/SL on each sniped curve).
    const then = sanitizeThen(p.then);
    if (then) out.then = then;

    if (slippage != null) out.slippageBps = slippage;
    return out;
  }

  if (type === 'dca') {
    // Accumulate `suiPerBuy` on curveId across `buys` fills, with one of two
    // triggers. The strategy brain owns the loop (emits a Nexus task + settles
    // each buy through the bridge) and tracks a running average cost.
    //   • time mode: a fill every `intervalMs` (>= 1s).
    //   • dip  mode: a fill each time price drops `dropPct`% (×rung) from entry.
    // Provide intervalMs for time, or dropPct for dip. If both are given, dropPct
    // wins (mode:'dip'). Tracking fields (done/avgPriceSui/filledSui/entryPriceSui/
    // lastFireMs) are preserved across PATCH round-trips so a restart resumes.
    const suiPerBuy = num(p.suiPerBuy);
    const buys      = num(p.buys);
    if (!(suiPerBuy > 0)) return null;
    if (!(buys > 0)) return null;

    const intervalMs = num(p.intervalMs);
    const dropPct    = num(p.dropPct);
    const dipMode    = p.mode === 'dip' || (dropPct > 0 && !(intervalMs >= 1000));
    if (!dipMode && !(intervalMs >= 1000)) return null;   // time mode needs a valid interval
    if (dipMode && !(dropPct > 0)) return null;           // dip mode needs a drop step

    const out = { suiPerBuy, buys: Math.trunc(buys) };
    // Optional distinct anchor (first-buy) size; rungs use suiPerBuy.
    const anchorSui = num(p.anchorSui);
    if (anchorSui > 0) out.anchorSui = anchorSui;
    if (dipMode) {
      out.mode = 'dip';
      out.dropPct = dropPct;
    } else {
      out.intervalMs = Math.trunc(intervalMs);
    }

    // Preserve runtime tracking across re-create / PATCH (default fresh).
    out.done = (() => { const d = num(p.done); return (d != null && d >= 0) ? Math.trunc(d) : 0; })();
    const filled = num(p.filledSui);   if (filled  > 0) out.filledSui    = filled;
    const avg    = num(p.avgPriceSui); if (avg     > 0) out.avgPriceSui  = avg;
    const entry  = num(p.entryPriceSui); if (entry > 0) out.entryPriceSui = entry;
    const last   = num(p.lastFireMs);  if (last    > 0) out.lastFireMs    = Math.trunc(last);

    // Optional `then` chaining: arm a child (e.g. TP/SL) after the buys settle,
    // targeting the blended average cost.
    const then = sanitizeThen(p.then);
    if (then) out.then = then;
    if (slippage != null) out.slippageBps = slippage;
    return out;
  }

  if (type === 'copytrade') {
    // Mirror trades by targetWallet. `ratio` scales their size, or a fixed
    // `suiPerTrade`; one of the two is required.
    if (!isHex(p.targetWallet)) return null;
    const ratio       = num(p.ratio);
    const suiPerTrade = num(p.suiPerTrade);
    if (!(ratio > 0) && !(suiPerTrade > 0)) return null;
    const out = { targetWallet: p.targetWallet };
    if (ratio > 0)       out.ratio = ratio;
    if (suiPerTrade > 0) out.suiPerTrade = suiPerTrade;
    // Optional `then` chaining: arm a child (e.g. TP/SL) on each mirrored buy.
    const then = sanitizeThen(p.then);
    if (then) out.then = then;
    if (slippage != null) out.slippageBps = slippage;
    return out;
  }

  return null;
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
      const type = ORDER_TYPES.includes(b.type) ? b.type : 'tpsl';

      const id = (typeof b.id === 'string' && b.id.trim())
        ? b.id.trim()
        : `ord_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const now       = Date.now();
      const tokenType = typeof b.tokenType === 'string' ? b.tokenType : null;
      const minSuiOut = Number.isFinite(Number(b.minSuiOut)) ? Math.trunc(Number(b.minSuiOut)) : 0;

      let curveId = isHex(b.curveId) ? b.curveId : null;
      let tp = [], sl = null, entry = null, params = {};

      if (type === 'tpsl') {
        if (!curveId) return res.status(400).json({ error: 'curveId (0x...) required' });
        tp = sanitizeRungs(b.takeProfit);
        sl = sanitizeStop(b.stopLoss);
        if (!tp.length && !sl) return res.status(400).json({ error: 'need a takeProfit rung or a stopLoss' });
        entry = (b.entryPriceSui != null && Number.isFinite(Number(b.entryPriceSui))) ? Number(b.entryPriceSui) : null;
      } else {
        params = sanitizeParams(type, b.params);
        if (!params) return res.status(400).json({ error: `invalid params for type "${type}"` });
        // dca trades a specific curve; sniper/copytrade discover their target at runtime.
        if (type === 'dca' && !curveId) return res.status(400).json({ error: 'dca requires curveId (0x...)' });
      }

      await pool.query(
        `INSERT INTO strategy_orders
           (id, curve_id, token_type, type, params, entry_price, min_sui_out, take_profit, stop_loss, status, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8::jsonb,$9::jsonb,'active',$10,$10)
         ON CONFLICT (id) DO NOTHING`,
        [id, curveId, tokenType, type, JSON.stringify(params), entry, minSuiOut, JSON.stringify(tp), sl ? JSON.stringify(sl) : null, now]
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
      if (b.params        !== undefined) { sets.push(`params = $${i++}::jsonb`); const pj = (b.params && typeof b.params === 'object' && !Array.isArray(b.params)) ? b.params : {}; vals.push(JSON.stringify(pj)); }
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
