// api/agent-actions.js — same-origin Vercel proxy for the persistent agent
// action history. Mirrors api/create-order.js: the browser never holds
// STRATEGY_API_KEY. The indexer gates POST/PATCH /agent-actions behind that key
// when it is set; this proxy injects it server-side so the guard is satisfied
// without exposing the secret to the client. GET (list/read) is open.
//
// The agent page calls:
//   GET   /api/agent-actions?limit=50           -> list recent actions
//   POST  /api/agent-actions   { ...fire }        -> record a fire (returns id)
//   PATCH /api/agent-actions?id=<id> { ...updates} -> update on settle/fallback
//
// Env:
//   STRATEGY_API_KEY  — must match the indexer's STRATEGY_API_KEY exactly
//   INDEXER_URL       — optional; defaults to the production indexer

const INDEXER_URL =
  process.env.INDEXER_URL ||
  process.env.VITE_INDEXER_URL ||
  'https://suipump-62s2.onrender.com';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const headers = { 'Content-Type': 'application/json' };
  const key = process.env.STRATEGY_API_KEY;
  if (key) headers['x-strategy-key'] = key;

  try {
    // GET — list recent actions (open read; forward the query string through).
    if (req.method === 'GET') {
      const qs = new URLSearchParams(req.query ?? {}).toString();
      const r = await fetch(`${INDEXER_URL}/agent-actions${qs ? `?${qs}` : ''}`, { method: 'GET' });
      const data = await r.json().catch(() => ([]));
      return res.status(r.status).json(data);
    }

    // POST — record a fire.
    if (req.method === 'POST') {
      let body = req.body;
      if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
      body = body ?? {};
      const r = await fetch(`${INDEXER_URL}/agent-actions`, {
        method: 'POST', headers, body: JSON.stringify(body),
      });
      const data = await r.json().catch(() => ({}));
      return res.status(r.status).json(data);
    }

    // PATCH — update a fire (id in ?id= query). Forward to /agent-actions/:id.
    if (req.method === 'PATCH') {
      const id = typeof req.query?.id === 'string' ? req.query.id : '';
      if (!id) return res.status(400).json({ error: 'id required' });
      let body = req.body;
      if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
      body = body ?? {};
      const r = await fetch(`${INDEXER_URL}/agent-actions/${encodeURIComponent(id)}`, {
        method: 'PATCH', headers, body: JSON.stringify(body),
      });
      const data = await r.json().catch(() => ({}));
      return res.status(r.status).json(data);
    }

    res.setHeader('Allow', 'GET, POST, PATCH');
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    return res.status(502).json({ error: err.message || 'Proxy error reaching indexer' });
  }
}
