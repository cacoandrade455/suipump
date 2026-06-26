// api/epoch-recovery.js — Vercel serverless proxy for Epoch registration recovery.
//
// SECURITY-CRITICAL: holds the Epoch shared secret server-side. Used as the
// fallback when the post-registration redirect drops (closed tab, etc.) so a
// completed registration is never lost. The browser calls THIS route with a
// session id (or wallet); this route injects the Bearer secret and queries
// Epoch's GET /partner/registration. Secret never reaches the client.
//
// Epoch returns: 200 { name, wallet, session, nameCap, registeredAt, txDigest, partner }
//                404 if no completed registration for that session/wallet.
//
// ENV (Vercel, server-side only):
//   EPOCH_API_BASE        e.g. https://names.epochsui.com
//   EPOCH_SHARED_SECRET   the Bearer secret

const EPOCH_API_BASE      = process.env.EPOCH_API_BASE || 'https://names.epochsui.com';
const EPOCH_SHARED_SECRET = process.env.EPOCH_SHARED_SECRET || '';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed — use GET' });
    return;
  }
  if (!EPOCH_SHARED_SECRET) {
    console.error('[epoch-recovery] EPOCH_SHARED_SECRET unset — refusing to proxy');
    res.status(500).json({ error: 'epoch integration not configured' });
    return;
  }

  const session = req.query?.session ? String(req.query.session) : '';
  const wallet  = req.query?.wallet  ? String(req.query.wallet)  : '';
  if (!session && !wallet) {
    res.status(400).json({ error: 'session or wallet required' });
    return;
  }

  // Prefer session (more specific — proves "this SuiPump session"); fall back to wallet.
  const qs = session
    ? `session=${encodeURIComponent(session)}`
    : `wallet=${encodeURIComponent(wallet)}`;

  try {
    const r = await fetch(`${EPOCH_API_BASE}/partner/registration?${qs}`, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${EPOCH_SHARED_SECRET}` },
      signal: AbortSignal.timeout(8000),
    });
    if (r.status === 404) {
      res.status(404).json({ error: 'no registration found' });
      return;
    }
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      res.status(r.status).json({ error: data?.error || `epoch recovery ${r.status}` });
      return;
    }
    // Pass through the registration record (name, wallet, nameCap, ...).
    res.status(200).json(data);
  } catch (e) {
    console.error('[epoch-recovery] proxy error:', e.message);
    res.status(502).json({ error: 'epoch recovery failed' });
  }
}
