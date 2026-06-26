// api/epoch-session.js — Vercel serverless proxy for Epoch comped-registration auth.
//
// SECURITY-CRITICAL: this holds the Epoch shared secret and makes the
// server-to-server POST /partner/session call. The secret NEVER reaches the
// browser — the client calls THIS route, this route injects the Bearer secret
// and forwards to Epoch. Same pattern as the agent-bridge proxy injecting
// AGENT_API_KEY. If the secret ever shipped client-side, anyone could authorize
// free Epoch registrations and drain the comp allocation.
//
// Flow: creator clicks "Create a landing page" → browser POSTs here with
// { session } → we authorize ONE comped registration for that session with
// Epoch → browser then redirects to Epoch's /sign/register page carrying only
// the session id (useless without our authorized row).
//
// ENV (set in Vercel, server-side only):
//   EPOCH_API_BASE   e.g. https://names.epochsui.com   (Steve sends the live base)
//   EPOCH_SHARED_SECRET   the Bearer secret (Steve sends privately)

const EPOCH_API_BASE     = process.env.EPOCH_API_BASE || 'https://names.epochsui.com';
const EPOCH_SHARED_SECRET = process.env.EPOCH_SHARED_SECRET || '';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed — use POST' });
    return;
  }
  if (!EPOCH_SHARED_SECRET) {
    // Fail loud rather than silently calling Epoch unauthenticated.
    console.error('[epoch-session] EPOCH_SHARED_SECRET unset — refusing to proxy');
    res.status(500).json({ error: 'epoch integration not configured' });
    return;
  }

  // Body may arrive parsed (Vercel) or raw — handle both.
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  const session = body?.session;
  if (!session || typeof session !== 'string') {
    res.status(400).json({ error: 'session required' });
    return;
  }

  try {
    const r = await fetch(`${EPOCH_API_BASE}/partner/session`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${EPOCH_SHARED_SECRET}`,
      },
      body: JSON.stringify({ partner: 'suipump', session }),
      signal: AbortSignal.timeout(8000),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      res.status(r.status).json({ error: data?.error || `epoch session ${r.status}` });
      return;
    }
    // Authorized. Tell the browser it's safe to redirect to Epoch's sign page.
    res.status(200).json({ ok: true, session });
  } catch (e) {
    console.error('[epoch-session] proxy error:', e.message);
    res.status(502).json({ error: 'epoch session authorization failed' });
  }
}
