// api/create-session-key.js -- Vercel serverless proxy for per-session enclave
// key provisioning (Phase 1 trust minimization).
//
// Mirrors api/agent-bridge.js: the browser never holds AGENT_API_KEY. Before a
// user opens an AgentSession, AgentPage calls THIS route; it injects the key
// server-side and forwards to the bridge's gated /provision-session-key, which
// creates a fresh Ed25519 key inside Turnkey's enclave, persists the mapping,
// funds the new address with gas, and returns the address. The UI then passes
// that address to open_and_share as session_address, so ONLY that enclave-held
// key can ever sign the session's trades.
//
// Nautilus (Phase 2): the UI may request mode:'enclave', which the bridge
// serves from the live Nitro enclave's /public_key (a CHAIN-attested key,
// used with open_and_share_attested) instead of minting a Turnkey key.
//
// When the bridge reports { configured: false } (Turnkey env or DATABASE_URL
// not set) or is unreachable, the UI falls back to the shared agent wallet -
// this route passes the bridge's answer through unchanged so the UI can decide.
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
  if (typeof body.ownerAddress === 'string') forward.ownerAddress = body.ownerAddress;
  // Signing-key mode: 'turnkey' (default) or 'enclave' (Nautilus). Same
  // strict-allowlist policy - any other value is dropped, and the bridge
  // treats a missing mode as 'turnkey'.
  if (body.mode === 'enclave' || body.mode === 'turnkey') forward.mode = body.mode;

  const headers = { 'Content-Type': 'application/json' };
  const key = process.env.AGENT_API_KEY;
  if (key) headers['x-agent-key'] = key;

  try {
    // Provisioning does real work (enclave key creation + an on-chain gas
    // transfer), so give it a generous but bounded timeout.
    const r = await fetch(`${BRIDGE_URL}/provision-session-key`, {
      method: 'POST', headers, body: JSON.stringify(forward),
      signal: AbortSignal.timeout(25000),
    });
    const data = await r.json().catch(() => ({}));
    return res.status(r.status).json(data);
  } catch (err) {
    return res.status(502).json({ error: err.message || 'Bridge proxy error' });
  }
}
