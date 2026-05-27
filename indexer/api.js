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
    const row = await pool.query('SELECT token_type FROM curves WHERE curve_id = $1', [id]);
    if (!row.rows.length) return res.status(404).json({ error: 'curve not found' });
    const tokenType = row.rows[0].token_type;
    if (!tokenType) return res.status(404).json({ error: 'token_type not found' });

    const GRAPHQL_URL = process.env.SUI_GRAPHQL_URL ?? 'https://graphql.testnet.sui.io/graphql';

    // Single query: get objectId + ISV in one shot
    const query = '{ coinMetadata(coinType: "' + tokenType + '") { address asMoveObject { owner { ... on Shared { initialSharedVersion } } } } }';
    const r = await fetch(GRAPHQL_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
      signal: AbortSignal.timeout(8000),
    });
    const d = await r.json();
    const cm = d?.data?.coinMetadata;
    if (!cm?.address) return res.status(404).json({ error: 'CoinMetadata not found on-chain' });

    const isv = cm?.asMoveObject?.owner?.initialSharedVersion ?? null;
    res.json({ objectId: cm.address, initialSharedVersion: isv, tokenType });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


