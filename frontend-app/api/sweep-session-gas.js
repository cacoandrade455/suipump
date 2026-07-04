// api/sweep-session-gas.js -- Vercel serverless proxy for recovering a closed
// session key's leftover gas grant.
//
// Mirrors api/create-session-key.js: the browser never holds AGENT_API_KEY.
// After a user closes an AgentSession, AgentPage calls THIS route; it injects
// the key server-side and forwards to the bridge's gated /sweep-session-gas,
// which signs ONE final transfer (with the session's own Turnkey-held key) of
// the entire remaining SUI at the session address back to the OWNER recorded
// at provision time. The recipient is owner-directed by construction on the
// bridge side - this route cannot redirect funds, so the worst a caller can do
// is return someone's own gas to them early.
//
// Env:
//   AGENT_API_KEY       -- must match the bridge's AGENT_API_KEY exactly
//   SUIPUMP_BRIDGE_URL  -- optional; defaults to the production bridge

const BRIDGE_URL = process.env.SUIPUMP_BRIDGE_URL ?? 'https://suipump-bridge.onrender.com';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  body = body ?? {};

  // Only forward what the bridge expects - never let arbitrary fields through
  // to a wallet-spending endpoint.
  const forward = {};
  if (typeof body.sessionId === 'string' && body.sessionId.startsWith('0x')) {
    forward.sessionId = body.sessionId;
  }
  if (typeof body.sessionAddress === 'string' && body.sessionAddress.startsWith('0x')) {
    forward.sessionAddress = body.sessionAddress;
  }
  if (!forward.sessionId && !forward.sessionAddress) {
    return res.status(400).json({ error: 'sessionId or sessionAddress required' });
  }

  const headers = { 'Content-Type': 'application/json' };
  const key = process.env.AGENT_API_KEY;
  if (key) headers['x-agent-key'] = key;

  try {
    // The sweep executes an on-chain transfer signed via Turnkey - generous
    // but bounded timeout, same policy as create-session-key.
    const r = await fetch(`${BRIDGE_URL}/sweep-session-gas`, {
      method: 'POST', headers, body: JSON.stringify(forward),
      signal: AbortSignal.timeout(25000),
    });
    const data = await r.json().catch(() => ({}));
    return res.status(r.status).json(data);
  } catch (err) {
    return res.status(502).json({ error: err.message || 'Bridge proxy error' });
  }
}
