// api/cancel-order.js — same-origin Vercel proxy to CANCEL a strategy order.
//
// Mirrors api/create-order.js: the browser never holds STRATEGY_API_KEY. The
// indexer's /orders write routes (POST/PATCH/DELETE) are guarded by that key
// when it is set; this proxy injects it server-side so the guard is satisfied
// without exposing the secret to the client.
//
// The active-strategies panel in AgentPage.jsx calls:
//   POST /api/cancel-order  { id: "<order id>" }
// and this forwards a soft-cancel:
//   DELETE {INDEXER_URL}/orders/<id>   (header x-strategy-key: STRATEGY_API_KEY)
//
// DELETE on the indexer is a SOFT cancel (sets status='cancelled'); it does not
// remove the row, so a cancelled order simply stops being tracked by the brain.

const INDEXER_URL =
  process.env.INDEXER_URL ||
  process.env.VITE_INDEXER_URL ||
  'https://suipump-62s2.onrender.com';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method not allowed' });
  }

  // Body may arrive parsed (Vercel) or as a raw string; handle both.
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  const id = body && typeof body.id === 'string' ? body.id.trim() : '';
  if (!id) return res.status(400).json({ error: 'order id required' });

  const headers = { 'Content-Type': 'application/json' };
  if (process.env.STRATEGY_API_KEY) {
    headers['x-strategy-key'] = process.env.STRATEGY_API_KEY;
  }

  try {
    const r = await fetch(`${INDEXER_URL}/orders/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers,
      signal: AbortSignal.timeout(10000),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      return res.status(r.status).json({ error: data.error || `cancel failed (${r.status})` });
    }
    return res.status(200).json(data); // { ok:true, id, status:'cancelled' }
  } catch (e) {
    return res.status(502).json({ error: `indexer unreachable: ${e.message}` });
  }
}
