// api/agent-claim-all.js — Vercel serverless proxy for "claim all creator fees".
//
// FAN-OUT claim: enumerates every curve the connected (agent) wallet created
// that has creator fees pending, then fires the SAME claim DAG that agent-run.js
// fires (workflow:'claim'), once per curve, sequentially. Mirrors agent-run.js
// for key injection (AGENT_API_KEY -> x-agent-key) and the runner /run-dag call.
//
// Why server-side: the runner is gated by AGENT_API_KEY which must never ship to
// the browser. The browser only supplies the address it is connected as
// (creatorAddress); this proxy holds the key and signs each claim as the agent
// wallet (the same wallet, since the site is operated connected AS the agent
// wallet, which both created the curves and holds the CreatorCaps).
//
// Everything settles through Nexus (the claim DAG) — no bridge path. One failed
// curve does not abort the rest; each result is reported individually.

const RUNNER_URL  = process.env.AGENT_RUNNER_URL ?? 'https://suipump-agent-runner.onrender.com';
const INDEXER_URL = process.env.INDEXER_URL ?? process.env.VITE_INDEXER_URL ?? 'https://suipump-62s2.onrender.com';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  body = body ?? {};

  const creatorAddress = body.creatorAddress;
  if (!creatorAddress || !/^0x[a-fA-F0-9]{60,66}$/.test(String(creatorAddress))) {
    return res.status(400).json({ error: 'Missing or invalid creatorAddress' });
  }

  const headers = { 'Content-Type': 'application/json' };
  const key = process.env.AGENT_API_KEY;
  if (key) headers['x-agent-key'] = key;

  try {
    // 1) Enumerate every curve this wallet created. The indexer returns
    //    tokenType per row and stats (incl. creator_fees_sui) inline, so no
    //    per-curve metadata round-trips are needed.
    const enumRes = await fetch(`${INDEXER_URL}/tokens?creator=${encodeURIComponent(creatorAddress)}`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!enumRes.ok) {
      return res.status(502).json({ error: `Could not enumerate curves (indexer ${enumRes.status})` });
    }
    const rows = await enumRes.json().catch(() => []);
    const allCurves = Array.isArray(rows) ? rows : [];

    // 2) Keep only curves with creator fees pending. creator_fees_sui lives in
    //    the nested stats object (row_to_json(s.*)). Treat missing/0 as nothing
    //    to claim. tokenType is required to fire the claim DAG.
    const claimable = allCurves
      .map(r => ({
        curveId:   r.curveId,
        tokenType: r.tokenType,
        symbol:    r.symbol ?? null,
        feesSui:   Number(r.stats?.creator_fees_sui ?? 0),
      }))
      .filter(c => c.curveId && c.tokenType && c.feesSui > 0);

    if (claimable.length === 0) {
      return res.status(200).json({
        ok: true,
        claimedCount: 0,
        totalCurves: allCurves.length,
        totalFeesSui: 0,
        results: [],
        message: 'No curves with creator fees pending.',
      });
    }

    // 3) Fire the claim DAG once per curve, SEQUENTIALLY. Same /run-dag call
    //    agent-run.js makes. One failure is recorded and does not abort the rest.
    const results = [];
    let claimedCount = 0;
    let totalFeesSui = 0;
    for (const c of claimable) {
      try {
        const r = await fetch(`${RUNNER_URL}/run-dag`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ workflow: 'claim', claim: { curveId: c.curveId, tokenType: c.tokenType } }),
        });
        const d = await r.json().catch(() => ({}));
        const ok = r.ok && d.ok !== false;
        if (ok) { claimedCount++; totalFeesSui += c.feesSui; }
        results.push({
          curveId: c.curveId,
          symbol:  c.symbol,
          feesSui: c.feesSui,
          ok,
          digest:      d.digest ?? null,
          executionId: d.executionId ?? null,
          error:       ok ? null : (d.error ?? `runner ${r.status}`),
        });
      } catch (e) {
        results.push({ curveId: c.curveId, symbol: c.symbol, feesSui: c.feesSui, ok: false, digest: null, executionId: null, error: e.message || 'claim failed' });
      }
    }

    return res.status(200).json({
      ok: true,
      claimedCount,
      totalCurves: allCurves.length,
      attempted: claimable.length,
      totalFeesSui,
      results,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Claim-all proxy error' });
  }
}
