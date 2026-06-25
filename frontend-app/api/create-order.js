// api/create-order.js -- Vercel serverless function.
// Proxies TP/SL (and other) strategy-order creation to the indexer's /orders
// route, injecting the STRATEGY_API_KEY server-side so the key NEVER ships to
// the browser bundle. The agent UI calls THIS route (no key); this function
// adds the x-strategy-key header and forwards to the indexer.
//
// Why a proxy: the indexer gates POST/PATCH/DELETE /orders behind
// STRATEGY_API_KEY (orders.js writeGuard). Putting that key in the frontend via
// VITE_ would expose it to every visitor, letting anyone queue a sell the
// strategy brain executes from the invoker wallet. Keeping it here (server-side
// env, NO VITE_ prefix) means the browser never sees it.
//
// Env:
//   STRATEGY_API_KEY  -- must match the indexer's STRATEGY_API_KEY exactly
//   INDEXER_URL       -- optional; defaults to the production indexer
//
// Body (forwarded as-is to the indexer): the order create payload, e.g.
//   { curveId, type:'tpsl', tokenType?, entryPriceSui?, takeProfit:[...], stopLoss? }

const INDEXER_URL = process.env.INDEXER_URL ?? 'https://suipump-62s2.onrender.com';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  body = body ?? {};

  // sniper / copytrade / autopilot are curve-less — they discover their target
  // (or, for autopilot, the trending curve) at runtime, so no curveId is required.
  if (!body.curveId && body.type !== 'sniper' && body.type !== 'copytrade' && body.type !== 'autopilot') {
    return res.status(400).json({ error: 'Missing curveId' });
  }

  const key = process.env.STRATEGY_API_KEY;
  // If the key isn't configured here, forward without it. The indexer will
  // accept the create only if ITS STRATEGY_API_KEY is also unset (dev/testnet
  // open mode); otherwise it returns 401, which we pass through unchanged.
  const headers = { 'Content-Type': 'application/json' };
  if (key) headers['x-strategy-key'] = key;

  try {
    const r = await fetch(`${INDEXER_URL}/orders`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    const data = await r.json().catch(() => ({}));
    // Pass the indexer's status + body straight through so the UI sees the real
    // result (201 + order on success, 400/401/500 + error otherwise).
    return res.status(r.status).json(data);
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Proxy error reaching indexer' });
  }
}
