// api/agent-run.js — Vercel serverless proxy for the agent's Nexus DAG emit.
// The agent UI calls THIS; it injects AGENT_API_KEY server-side and forwards to
// the runner's gated /run-dag. Key never ships to the browser. Mirrors
// agent-bridge.js. Body is the runner /run-dag payload ({ workflow, ... }).

const RUNNER_URL = process.env.AGENT_RUNNER_URL ?? 'https://suipump-agent-runner.onrender.com';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  body = body ?? {};

  const headers = { 'Content-Type': 'application/json' };
  const key = process.env.AGENT_API_KEY;
  if (key) headers['x-agent-key'] = key;

  try {
    const r = await fetch(`${RUNNER_URL}/run-dag`, {
      method: 'POST', headers, body: JSON.stringify(body),
    });
    const data = await r.json().catch(() => ({}));
    return res.status(r.status).json(data);
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Runner proxy error' });
  }
}
