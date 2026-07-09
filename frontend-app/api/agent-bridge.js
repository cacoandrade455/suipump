// api/agent-bridge.js — Vercel serverless proxy for the agent's bridge actions.
// The agent UI calls THIS (same-origin, no key); this injects AGENT_API_KEY
// server-side and forwards to the bridge's gated write endpoints (/buy /sell
// /launch /claim). The key lives only in Vercel's server env (NO VITE_ prefix),
// so it never ships to the browser — only our deployed UI, going through this
// proxy, can reach the bridge's write endpoints. A direct browser/curl to the
// bridge without the key gets 401.
//
// Body: { path: '/buy'|'/sell'|'/session-buy'|'/session-sell'|'/launch'|'/claim', ...bridgeBody }

const BRIDGE_URL = process.env.SUIPUMP_BRIDGE_URL ?? 'https://suipump-bridge.onrender.com';
const ALLOWED = new Set(['/buy', '/sell', '/session-buy', '/session-sell', '/launch', '/claim']);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  body = body ?? {};

  const path = String(body.path ?? '');
  if (!ALLOWED.has(path)) return res.status(400).json({ error: `Invalid bridge path: ${path}` });
  const { path: _omit, ...bridgeBody } = body;

  const headers = { 'Content-Type': 'application/json' };
  const key = process.env.AGENT_API_KEY;
  if (key) headers['x-agent-key'] = key;

  try {
    const r = await fetch(`${BRIDGE_URL}${path}`, {
      method: 'POST', headers, body: JSON.stringify(bridgeBody),
    });
    const data = await r.json().catch(() => ({}));
    return res.status(r.status).json(data);
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Bridge proxy error' });
  }
}
