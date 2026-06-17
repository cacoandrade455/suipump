// api/agent-claim-all.js — Vercel serverless proxy for "claim all creator fees".
//
// FAN-OUT claim that SETTLES THROUGH THE BRIDGE — same as every other on-chain
// action in SuiPump. The DAG plans; the bridge executes and moves the SUI. This
// proxy enumerates every curve the connected (agent) wallet created with fees
// pending, then calls the bridge POST /claim once per curve. The bridge finds
// the CreatorCap in the agent wallet, runs claim_creator_fees on-chain, and
// returns a REAL txDigest + the actual SUI claimed (from balanceChanges).
//
// A curve is only marked ok when the bridge returns a settled txDigest — so the
// UI can never show a green check for a claim that didn't actually land. The
// total is summed from the bridge's on-chain suiClaimed, not the indexer's
// estimate.
//
// Key handling mirrors agent-run.js: AGENT_API_KEY is injected server-side as
// x-agent-key (the bridge gates /claim behind it) and never ships to the browser.

const BRIDGE_URL  = process.env.AGENT_BRIDGE_URL ?? 'https://suipump-bridge.onrender.com';
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
    // 1) Enumerate every curve this wallet created. The indexer returns tokenType
    //    per row and stats (incl. creator_fees_sui) inline, so the only purpose
    //    here is to find which curves are worth a claim call. The bridge resolves
    //    the actual CreatorCap + tokenType itself, so it just needs curveId.
    const enumRes = await fetch(`${INDEXER_URL}/tokens?creator=${encodeURIComponent(creatorAddress)}`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!enumRes.ok) {
      return res.status(502).json({ error: `Could not enumerate curves (indexer ${enumRes.status})` });
    }
    const rows = await enumRes.json().catch(() => []);
    const allCurves = Array.isArray(rows) ? rows : [];

    // 2) Keep only curves the indexer believes have creator fees pending. This is
    //    a pre-filter to avoid firing no-op claims; the bridge is still the
    //    source of truth for what actually settles.
    const candidates = allCurves
      .map(r => ({
        curveId:    r.curveId,
        symbol:     r.symbol ?? null,
        feesSuiEst: Number(r.stats?.creator_fees_sui ?? 0),
      }))
      .filter(c => c.curveId && c.feesSuiEst > 0);

    if (candidates.length === 0) {
      return res.status(200).json({
        ok: true,
        claimedCount: 0,
        totalCurves: allCurves.length,
        attempted: 0,
        totalFeesSui: 0,
        results: [],
        message: 'No curves with creator fees pending.',
      });
    }

    // 3) Settle each through the bridge POST /claim, SEQUENTIALLY. ok is true ONLY
    //    when the bridge returns a real txDigest. totalFeesSui sums the bridge's
    //    on-chain suiClaimed (falling back to the indexer estimate only for the
    //    display amount on a settled row). One failure does not abort the rest.
    const results = [];
    let claimedCount = 0;
    let totalFeesSui = 0;
    for (const c of candidates) {
      try {
        const r = await fetch(`${BRIDGE_URL}/claim`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ curveId: c.curveId }),
        });
        const d = await r.json().catch(() => ({}));
        const txDigest = d.txDigest ?? null;
        const ok = r.ok && !!txDigest;
        const suiClaimed = (d.suiClaimed != null && d.suiClaimed !== 'unknown')
          ? Number(d.suiClaimed)
          : null;
        if (ok) {
          claimedCount++;
          totalFeesSui += (suiClaimed ?? c.feesSuiEst);
          // Push a notification with the REAL on-chain claimed amount so the bell
          // shows "Agent claimed X SUI on $SYMBOL". Best-effort; never blocks claim.
          fetch(`${INDEXER_URL}/notify`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              wallet:  creatorAddress,
              type:    'claim',
              curveId: c.curveId,
              symbol:  c.symbol,
              sui:     suiClaimed ?? c.feesSuiEst,
              digest:  txDigest,
            }),
            signal: AbortSignal.timeout(6000),
          }).catch(() => {});
        }
        results.push({
          curveId:  c.curveId,
          symbol:   c.symbol,
          feesSui:  suiClaimed ?? c.feesSuiEst,
          ok,
          digest:   txDigest,
          error:    ok ? null : (d.error ?? `bridge ${r.status}`),
        });
      } catch (e) {
        results.push({ curveId: c.curveId, symbol: c.symbol, feesSui: c.feesSuiEst, ok: false, digest: null, error: e.message || 'claim failed' });
      }
    }

    return res.status(200).json({
      ok: true,
      claimedCount,
      totalCurves: allCurves.length,
      attempted: candidates.length,
      totalFeesSui,
      results,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Claim-all proxy error' });
  }
}
