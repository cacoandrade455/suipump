// api.js — REST API + SSE stream for SuiPump indexer
import express from 'express';
import pg from 'pg';
import cors from 'cors';
import {
  getGlobalStats, getTokenStats, getTradeHistory,
  getAllCurves, pool,
} from './db.js';

const PORT = parseInt(process.env.PORT || '3001');
const app  = express();
app.use(cors());
app.use(express.json());

// ── Virtual reserves per package — must match frontend curve.js ───────────────
const MIST         = 1_000_000_000;
const TOTAL_SUPPLY = 1_000_000_000; // 1B tokens

function getVirtuals(packageId) {
  if (!packageId) return { vSui: 3500 };
  if (packageId.startsWith('0x2154')) return { vSui: 30000 }; // V4
  if (packageId.startsWith('0x785c')) return { vSui: 10000 }; // V5
  if (packageId.startsWith('0x21d5')) return { vSui: 10000 }; // V6
  if (packageId.startsWith('0xfb8f')) return { vSui: 5000  }; // V7
  if (packageId.startsWith('0x7196')) return { vSui: 4369  }; // V9
  return { vSui: 3500 };                                        // V8, V8_1
}

// price = (virtualSui + realSuiReserve) / TOTAL_SUPPLY
// This formula matches the OHLC chart and token page header exactly.
// new_sui_reserve is in MIST — convert to SUI first.
function priceFromReserve(vSui, newSuiReserveMist) {
  const totalPoolSui = vSui + Number(newSuiReserveMist ?? 0) / MIST;
  return totalPoolSui / TOTAL_SUPPLY;
}

// ── SSE client registry ───────────────────────────────────────────────────────

const sseClients = new Map();
let   sseNextId  = 0;

export function emitEvent(eventType, parsedJson, curveId) {
  if (sseClients.size === 0) return;
  const payload = JSON.stringify({
    type:      eventType.split('::').pop(),
    eventType,
    curveId,
    data:      parsedJson,
    ts:        Date.now(),
  });
  const msg = `data: ${payload}\n\n`;
  for (const [id, client] of sseClients) {
    try {
      if (!client.curveId || client.curveId === curveId) {
        client.res.write(msg);
      }
    } catch { sseClients.delete(id); }
  }
}

// ── Health ────────────────────────────────────────────────────────────────────

app.get('/health', (req, res) => res.json({ status: 'ok', ts: Date.now() }));

// ── SSE stream ────────────────────────────────────────────────────────────────


app.get('/stream', (req, res) => {
  const curveId = req.query.curveId ?? null;
  const id      = sseNextId++;

  res.setHeader('Content-Type',      'text/event-stream');
  res.setHeader('Cache-Control',     'no-cache');
  res.setHeader('Connection',        'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const heartbeat = setInterval(() => {
    try { res.write(': heartbeat\n\n'); }
    catch { clearInterval(heartbeat); sseClients.delete(id); }
  }, 30_000);

  sseClients.set(id, { res, curveId });
  res.write(`data: ${JSON.stringify({ type: 'connected', id })}\n\n`);

  req.on('close', () => {
    clearInterval(heartbeat);
    sseClients.delete(id);
  });
});


// ── Global stats ──────────────────────────────────────────────────────────────

app.get('/stats', async (req, res) => {
  try {
    const stats = await getGlobalStats();
    const protocolFeesSui = stats.totalVolume * 0.005;
    const creatorFeesSui  = stats.totalVolume * 0.004;
    const s1PoolSui       = protocolFeesSui * 0.5;

    const [buySellRes, uniqueWalletsRes, graduatedRes] = await Promise.all([
      pool.query('SELECT COALESCE(SUM(buys),0) AS total_buys, COALESCE(SUM(sells),0) AS total_sells FROM token_stats'),
      pool.query(`SELECT COUNT(DISTINCT wallet) AS cnt FROM (
          SELECT data->>'buyer'  AS wallet FROM events WHERE event_type LIKE '%TokensPurchased' OR event_type LIKE '%TokensBought'
          UNION SELECT data->>'seller' AS wallet FROM events WHERE event_type LIKE '%TokensSold'
        ) w WHERE wallet IS NOT NULL AND wallet != ''`),
      pool.query(`SELECT COUNT(*) AS cnt FROM curves WHERE graduated = true`),
    ]);

    res.json({
      totalVolume:     stats.totalVolume,
      totalTrades:     stats.totalTrades,
      totalBuys:       Number(buySellRes.rows[0]?.total_buys  ?? 0),
      totalSells:      Number(buySellRes.rows[0]?.total_sells ?? 0),
      tokenCount:      stats.tokenCount,
      graduatedCount:  Number(graduatedRes.rows[0]?.cnt ?? 0),
      uniqueWallets:   Number(uniqueWalletsRes.rows[0]?.cnt ?? 0),
      protocolFeesSui,
      creatorFeesSui,
      s1PoolSui,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── All tokens list ───────────────────────────────────────────────────────────

app.get('/tokens', async (req, res) => {
  try { res.json(await getAllCurves()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// ── All token stats (for homepage) ───────────────────────────────────────────

app.get('/tokens/stats', async (req, res) => {
  try {
    const now       = Date.now();
    const oneDayAgo = now - 86_400_000;

    const [statsRes, sparklineRes] = await Promise.all([
      pool.query(`SELECT ts.*, c.package_id FROM token_stats ts LEFT JOIN curves c ON c.curve_id = ts.curve_id`),
      pool.query(`SELECT e.curve_id, c.package_id,
          json_agg(json_build_object('t', e.timestamp_ms, 'r', (e.data->>'new_sui_reserve')::float) ORDER BY e.timestamp_ms ASC) AS points
         FROM events e LEFT JOIN curves c ON c.curve_id = e.curve_id
         WHERE (e.event_type LIKE '%TokensPurchased' OR e.event_type LIKE '%TokensBought' OR e.event_type LIKE '%TokensSold')
           AND e.timestamp_ms > $1 AND e.data->>'new_sui_reserve' IS NOT NULL
         GROUP BY e.curve_id, c.package_id`, [oneDayAgo]),
    ]);

    const sparklineMap = {};
    for (const row of sparklineRes.rows) {
      const { vSui } = getVirtuals(row.package_id);
      sparklineMap[row.curve_id] = (row.points || [])
        .map(p => ({ t: Number(p.t), p: priceFromReserve(vSui, p.r) }))
        .filter(p => p.p > 0 && p.t > 0);
    }

    res.json(statsRes.rows.map(s => {
      const { vSui } = getVirtuals(s.package_id);
      const startPrice = vSui / TOTAL_SUPPLY;
      const lastPrice  = s.reserve_sui > 0 ? priceFromReserve(vSui, s.reserve_sui * MIST) : (s.last_price ?? startPrice);
      return { ...s, start_price: startPrice, last_price: lastPrice, sparkline24h: sparklineMap[s.curve_id] || [] };
    }));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Single token ──────────────────────────────────────────────────────────────

app.get('/token/:curveId', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT c.*, ts.volume_sui, ts.trades, ts.buys, ts.sells, ts.last_trade_time,
              ts.last_price, ts.first_price, ts.recent_trades, ts.comment_count,
              ts.reserve_sui, ts.creator_fees_sui, ts.updated_at, ts.volume_24h,
              c.graduated
       FROM curves c LEFT JOIN token_stats ts ON ts.curve_id = c.curve_id
       WHERE c.curve_id = $1`,
      [req.params.curveId]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Not found' });
    const row = result.rows[0];
    const { vSui } = getVirtuals(row.package_id);
    res.json({ ...row, stats: { ...row }, initialSharedVersion: row.initial_shared_version, initial_shared_version: row.initial_shared_version });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Single token stats ────────────────────────────────────────────────────────

app.get('/token/:curveId/stats', async (req, res) => {
  try {
    const stats = await getTokenStats(req.params.curveId);
    if (!stats) return res.status(404).json({ error: 'Not found' });
    res.json(stats);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Trade history ─────────────────────────────────────────────────────────────

app.get('/token/:curveId/trades', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || '200'), 1000);
    res.json(await getTradeHistory(req.params.curveId, limit));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Token comments ────────────────────────────────────────────────────────────

app.get('/token/:curveId/comments', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT tx_digest, event_seq, timestamp_ms, data FROM events
       WHERE curve_id = $1 AND event_type LIKE '%::bonding_curve::Comment'
       ORDER BY timestamp_ms ASC`, [req.params.curveId]
    );
    res.json(result.rows.map(r => ({
      tx_digest: r.tx_digest, event_seq: r.event_seq, timestamp_ms: r.timestamp_ms,
      author: r.data?.author ?? null, text: r.data?.text ?? null,
    })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── OHLC chart data ───────────────────────────────────────────────────────────

app.get('/token/:curveId/ohlc', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT data, timestamp_ms, event_type, e.curve_id, c.package_id
       FROM events e LEFT JOIN curves c ON c.curve_id = e.curve_id
       WHERE e.curve_id = $1
         AND (e.event_type LIKE '%TokensPurchased' OR e.event_type LIKE '%TokensBought' OR e.event_type LIKE '%TokensSold')
       ORDER BY timestamp_ms ASC`, [req.params.curveId]
    );
    const points = result.rows.map(row => {
      const d = row.data;
      const ts = row.timestamp_ms ? Math.floor(Number(row.timestamp_ms) / 1000) : 0;
      const isBuy = row.event_type.includes('TokensPurchased') || row.event_type.includes('TokensBought');
      const { vSui } = getVirtuals(row.package_id);
      const price = priceFromReserve(vSui, d.new_sui_reserve ?? 0);
      return { time: ts, price, kind: isBuy ? 'buy' : 'sell', sui: isBuy ? Number(d.sui_in ?? 0) / MIST : Number(d.sui_out ?? 0) / MIST };
    });
    res.json(points);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Holder list ───────────────────────────────────────────────────────────────

app.get('/token/:curveId/holders', async (req, res) => {
  try {
    const MIST_L = 1_000_000_000, TOK = 1_000_000;
    const [buysRes, sellsRes] = await Promise.all([
      pool.query(`SELECT data->>'buyer' AS address, SUM((data->>'tokens_out')::float) AS tokens
         FROM events WHERE curve_id = $1 AND (event_type LIKE '%TokensPurchased' OR event_type LIKE '%TokensBought')
         GROUP BY data->>'buyer'`, [req.params.curveId]),
      pool.query(`SELECT data->>'seller' AS address, SUM((data->>'tokens_in')::float) AS tokens
         FROM events WHERE curve_id = $1 AND event_type LIKE '%TokensSold'
         GROUP BY data->>'seller'`, [req.params.curveId]),
    ]);
    const hmap = {};
    for (const r of buysRes.rows)  { if (r.address) { hmap[r.address] = (hmap[r.address] ?? 0) + Number(r.tokens ?? 0) / TOK; } }
    for (const r of sellsRes.rows) { if (r.address) { hmap[r.address] = (hmap[r.address] ?? 0) - Number(r.tokens ?? 0) / TOK; } }
    const holders = Object.entries(hmap).filter(([, b]) => b > 0.0001)
      .map(([address, balance]) => ({ address, balance }))
      .sort((a, b) => b.balance - a.balance);
    res.json(holders);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Recent trades ─────────────────────────────────────────────────────────────

app.get('/trades/recent', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || '50'), 200);
    const result = await pool.query(
      `SELECT e.data, e.timestamp_ms, e.event_type, e.curve_id, c.name, c.symbol
       FROM events e LEFT JOIN curves c ON c.curve_id = e.curve_id
       WHERE (e.event_type LIKE '%TokensPurchased' OR e.event_type LIKE '%TokensBought' OR e.event_type LIKE '%TokensSold')
       ORDER BY e.timestamp_ms DESC LIMIT $1`, [limit]
    );
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Leaderboards ──────────────────────────────────────────────────────────────

app.get('/leaderboard/volume', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || '20'), 100);
    const result = await pool.query(
      `SELECT ts.curve_id, c.name, c.symbol, c.icon_url, c.package_id,
              ts.volume_sui, ts.trades, ts.buys, ts.sells, ts.last_price, ts.reserve_sui
       FROM token_stats ts LEFT JOIN curves c ON c.curve_id = ts.curve_id
       ORDER BY ts.volume_sui DESC LIMIT $1`, [limit]
    );
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/leaderboard/traders', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || '20'), 100);
    const MIST_L = 1_000_000_000, TOK = 1_000_000;
    const [buysRes, sellsRes] = await Promise.all([
      pool.query(`SELECT data->>'buyer' AS address, SUM((data->>'sui_in')::float) AS sui_spent, SUM((data->>'tokens_out')::float) AS tokens_bought FROM events WHERE (event_type LIKE '%TokensPurchased' OR event_type LIKE '%TokensBought') GROUP BY data->>'buyer'`),
      pool.query(`SELECT data->>'seller' AS address, SUM((data->>'sui_out')::float) AS sui_received, SUM((data->>'tokens_in')::float) AS tokens_sold FROM events WHERE event_type LIKE '%TokensSold' GROUP BY data->>'seller'`),
    ]);
    const tm = {};
    for (const r of buysRes.rows)  { const a = r.address; if (!a) continue; if (!tm[a]) tm[a] = { address: a, sui_spent: 0, sui_received: 0, buys: 0, sells: 0 }; tm[a].sui_spent += Number(r.sui_spent ?? 0) / MIST_L; tm[a].buys++; }
    for (const r of sellsRes.rows) { const a = r.address; if (!a) continue; if (!tm[a]) tm[a] = { address: a, sui_spent: 0, sui_received: 0, buys: 0, sells: 0 }; tm[a].sui_received += Number(r.sui_received ?? 0) / MIST_L; tm[a].sells++; }
    res.json(Object.values(tm).sort((a, b) => (b.sui_spent + b.sui_received) - (a.sui_spent + a.sui_received)).slice(0, limit));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Trader portfolio ──────────────────────────────────────────────────────────

app.get('/trader/:address', async (req, res) => {
  try {
    const { address } = req.params;
    const MIST_L = 1_000_000_000, TOK = 1_000_000;
    const [buysRes, sellsRes] = await Promise.all([
      pool.query(`SELECT e.curve_id, c.name, c.symbol, c.token_type, c.package_id, c.icon_url, c.graduated,
          SUM((data->>'sui_in')::float) AS sui_spent, SUM((data->>'tokens_out')::float) AS tokens_bought,
          MAX(e.timestamp_ms::bigint) AS last_buy_time, MAX((data->>'new_sui_reserve')::float) AS last_reserve_mist
         FROM events e LEFT JOIN curves c ON c.curve_id = e.curve_id
         WHERE (event_type LIKE '%TokensPurchased' OR event_type LIKE '%TokensBought') AND data->>'buyer' = $1
         GROUP BY e.curve_id, c.name, c.symbol, c.token_type, c.package_id, c.icon_url, c.graduated`, [address]),
      pool.query(`SELECT e.curve_id, SUM((data->>'sui_out')::float) AS sui_received, SUM((data->>'tokens_in')::float) AS tokens_sold
         FROM events e WHERE event_type LIKE '%TokensSold' AND data->>'seller' = $1 GROUP BY e.curve_id`, [address]),
    ]);
    const cm = {};
    for (const r of buysRes.rows) {
      const id = r.curve_id;
      cm[id] = { curve_id: id, name: r.name, symbol: r.symbol, token_type: r.token_type, package_id: r.package_id, icon_url: r.icon_url, graduated: r.graduated,
        sui_spent: Number(r.sui_spent ?? 0) / MIST_L, tokens_bought: Number(r.tokens_bought ?? 0) / TOK,
        sui_received: 0, tokens_sold: 0, buys: 1, sells: 0, last_reserve_mist: r.last_reserve_mist };
    }
    for (const r of sellsRes.rows) {
      const id = r.curve_id;
      if (!cm[id]) cm[id] = { curve_id: id, sui_spent: 0, tokens_bought: 0, sui_received: 0, tokens_sold: 0, buys: 0, sells: 0 };
      cm[id].sui_received += Number(r.sui_received ?? 0) / MIST_L;
      cm[id].tokens_sold  += Number(r.tokens_sold  ?? 0) / TOK;
      cm[id].sells++;
    }
    res.json(Object.values(cm).map(c => ({ ...c, net_tokens: c.tokens_bought - c.tokens_sold,
      avg_entry_price: c.tokens_bought > 0 ? c.sui_spent / c.tokens_bought : 0,
      reserve_sui: Number(c.last_reserve_mist ?? 0) / MIST_L }))
      .sort((a, b) => (b.sui_spent + b.sui_received) - (a.sui_spent + a.sui_received)));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── /debug/metadata/:tokenType ───────────────────────────────────────────────
app.get('/debug/metadata/:type(*)', async (req, res) => {
  try {
    const tokenType = req.params.type;
    const GRAPHQL_URL = process.env.SUI_GRAPHQL_URL ?? 'https://graphql.testnet.sui.io/graphql';
    const metaType = '0x2::coin::CoinMetadata<' + tokenType + '>';

    // Try coinMetadata
    const r1 = await fetch(GRAPHQL_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: '{ coinMetadata(coinType: "' + tokenType + '") { address owner { ... on Shared { initialSharedVersion }  } } }' }),
      signal: AbortSignal.timeout(8000),
    });
    const d1 = await r1.json();

    // Try objects
    const r2 = await fetch(GRAPHQL_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: '{ objects(filter: { type: "' + metaType + '" } first: 1) { nodes { address owner { ... on Shared { initialSharedVersion }  } } } }' }),
      signal: AbortSignal.timeout(8000),
    });
    const d2 = await r2.json();

    res.json({ coinMetadata: d1, objectsQuery: d2 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── /token/:id/locks?owner=:address ──────────────────────────────────────────
// Returns lock_ids for a beneficiary on a specific curve.
app.get('/token/:id/locks', async (req, res) => {
  try {
    const { id } = req.params;
    const { owner } = req.query;
    if (!owner) return res.status(400).json({ error: 'owner param required' });

    const result = await pool.query(
      `SELECT lock_id, total_amount, claimed,
              (total_amount - claimed) AS locked,
              start_ms, duration_ms, mode, beneficiary
       FROM vesting_locks
       WHERE curve_id = $1 AND beneficiary = $2
       ORDER BY start_ms DESC`,
      [id, owner]
    );
    res.json(result.rows);
  } catch (err) {
    // Table may not exist yet — return empty array gracefully
    res.json([]);
  }
});

// ── /lock/:lockId ─────────────────────────────────────────────────────────────
// Returns details for a single VestingLock by its object ID.
app.get('/lock/:lockId', async (req, res) => {
  try {
    const { lockId } = req.params;
    const result = await pool.query(
      `SELECT lock_id, curve_id, beneficiary,
              total_amount, claimed,
              (total_amount - claimed) AS locked,
              start_ms, duration_ms, mode
       FROM vesting_locks
       WHERE lock_id = $1`,
      [lockId]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'lock not found' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── /token/:id/metadata-object ────────────────────────────────────────────────
app.get('/token/:id/metadata-object', async (req, res) => {
  try {
    const { id } = req.params;

    // Read from DB first — populated by backfillMetadataObject at index time
    const row = await pool.query(
      'SELECT token_type, metadata_object_id, metadata_shared_version FROM curves WHERE curve_id = $1',
      [id]
    );
    if (!row.rows.length) return res.status(404).json({ error: 'curve not found' });
    const { token_type: tokenType, metadata_object_id, metadata_shared_version } = row.rows[0];
    if (!tokenType) return res.status(404).json({ error: 'token_type not found' });

    // If already stored, return immediately
    if (metadata_object_id && metadata_shared_version) {
      return res.json({
        objectId:             metadata_object_id,
        initialSharedVersion: Number(metadata_shared_version),
        tokenType,
      });
    }

    // Not stored yet — trigger backfill async and query GQL for objectId now
    const { backfillMetadataObject } = await import('./db.js');
    backfillMetadataObject(id).catch(() => {});

    const GRAPHQL_URL = process.env.SUI_GRAPHQL_URL ?? 'https://graphql.testnet.sui.io/graphql';
    const r = await fetch(GRAPHQL_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: '{ coinMetadata(coinType: "' + tokenType + '") { address } }' }),
      signal: AbortSignal.timeout(8000),
    });
    const d = await r.json();
    const objectId = d?.data?.coinMetadata?.address ?? null;
    if (!objectId) return res.status(404).json({ error: 'CoinMetadata not found on-chain' });

    // ISV not yet in DB — return null for now, backfill will store it
    // Frontend will retry on next page load once backfill completes
    res.json({ objectId, initialSharedVersion: null, tokenType, backfilling: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// ── PostgreSQL LISTEN — receives events from background worker ───────────────

async function startPgListener() {
  const client = new pg.Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  try {
    await client.connect();
    await client.query('LISTEN suipump_events');
    client.on('notification', (msg) => {
      try {
        const event = JSON.parse(msg.payload);
        emitEvent(event.eventType, event.data, event.curveId);
      } catch {}
    });
    client.on('error', (err) => {
      console.error('  PG listener error:', err.message);
      client.end().catch(() => {});
      setTimeout(startPgListener, 5_000);
    });
    console.log('  ✓ PostgreSQL LISTEN active — suipump_events');
  } catch (err) {
    console.error('  PG listener connect failed:', err.message);
    setTimeout(startPgListener, 5_000);
  }
}

export function startApi() {
  app.listen(PORT, () => console.log(`  ✓ API listening on port ${PORT}`));
  startPgListener().catch(err => console.error('PG listener failed:', err.message));
}
