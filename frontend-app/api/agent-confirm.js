// api/agent-confirm.js — Vercel serverless proxy for the C2 async leader-settlement
// poll. The agent UI fires /api/agent-run WITHOUT confirm (instant executionId),
// then polls THIS endpoint every couple seconds and updates the card live when a
// Talus leader settles the walk. This does ONE GraphQL read per call (the runner's
// GET /confirm), so no request hangs — the browser owns the polling cadence.
// Read-only (executionId is already public on-chain); mirrors agent-run.js style.

const RUNNER_URL = process.env.AGENT_RUNNER_URL ?? 'https://suipump-agent-runner.onrender.com';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const executionId = req.query?.executionId ?? '';
  if (!executionId) return res.status(400).json({ ok: false, error: 'executionId required' });

  try {
    const r = await fetch(`${RUNNER_URL}/confirm?executionId=${encodeURIComponent(executionId)}`, {
      method: 'GET',
    });
    const data = await r.json().catch(() => ({}));
    return res.status(r.status).json(data);
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message || 'Runner confirm proxy error' });
  }
}
