// api/agent-claim-all.js - RETIRED endpoint (HTTP 410).
//
// This proxy used to fan out "claim all creator fees" through the bridge's
// POST /claim, which signed claim_creator_fees with the SHARED AGENT WALLET
// key. That execution path is removed: the bridge no longer signs with the
// shared agent wallet, and its /claim route now answers HTTP 410 itself.
// Creator-fee claiming moves to user-wallet-signed flows - the creator signs
// claim_creator_fees from their own wallet, holding their own CreatorCap
// (see PortfolioPage's wallet-signed claim path).
//
// Kept as a stub so any stale client gets a clear retirement message instead
// of a broken proxy hop. No auth, no signature verification, no bridge or
// indexer calls remain - the route does nothing but explain itself.

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  return res.status(410).json({
    ok: false,
    error: 'this endpoint is retired - creator-fee claiming via the shared agent wallet is no longer supported; claim creator fees from your own wallet (user-wallet-signed claim_creator_fees with your CreatorCap)',
  });
}
