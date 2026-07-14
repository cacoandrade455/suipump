// api/agent-bridge.js - Vercel serverless proxy for the agent's bridge actions.
// The agent UI calls THIS (same-origin, no key); this injects AGENT_API_KEY
// server-side and forwards to the bridge. The key lives only in Vercel's
// server env (NO VITE_ prefix), so it never ships to the browser - only our
// deployed UI, going through this proxy, can reach the bridge's write
// endpoints. A direct browser/curl to the bridge without the key gets 401.
//
// ALLOWED is the exact set of bridge paths the UI actually calls. /buy /sell
// /claim /session-buy have no frontend callers (autonomous fires hit the
// bridge directly, server-side, never through this proxy), and /launch let
// any caller publish + dev-buy from the funded agent wallet with an uncapped
// devBuySui - all five are removed. privateKey is stripped from every
// forwarded body: a caller must never choose the signing key.
//
// Body: { path: '/session-sell', sessionId, curveId, sellAll, minSuiOut,
//         signature, ts }
//
// AUTH: /session-sell moves a session's parked position, so the caller must
// prove they own the session. The client signs the canonical message over
// the body fields; we verify the signature and require the recovered signer
// to be body.sessionId's indexed owner (GET /agent/sessions?owner=).

import { canonicalAuthMessage, verifyOwnerSignature, assertSessionOwner } from '../lib/verifyOwner.js';

const BRIDGE_URL = process.env.SUIPUMP_BRIDGE_URL ?? 'https://suipump-bridge.onrender.com';
const ALLOWED = new Set(['/session-sell']);

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

  // Wallet-signed ownership proof: every allowed path is session-scoped, so
  // the signer must be the session's indexed owner. The canonical fields
  // include `path` (the client signs it); privateKey is still stripped from
  // the forward regardless.
  const { signature, ts, ...fields } = body;
  const { path: _omit, privateKey: _neverForwarded, ...bridgeBody } = fields;
  if (typeof bridgeBody.sessionId !== 'string' || !bridgeBody.sessionId.startsWith('0x')) {
    return res.status(400).json({ error: 'sessionId required' });
  }
  try {
    const signer = await verifyOwnerSignature({
      signature, ts,
      canonicalPayload: canonicalAuthMessage('agent-bridge', ts, fields),
    });
    await assertSessionOwner({ sessionId: bridgeBody.sessionId, ownerAddress: signer });
  } catch (e) {
    return res.status(401).json({ error: `auth: ${e.message}` });
  }

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
