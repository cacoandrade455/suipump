// lib/verifyOwner.js - server-side wallet-signed ownership verification for
// the money-mover API routes. IMPORTED HELPER ONLY: it lives outside api/ so
// it never deploys as a public route, and it must NEVER be imported
// client-side (the client's half is src/authSign.js; the shared
// canonicalization is lib/authCanonical.js).
//
// Model: the client attaches only { signature, ts } to its normal request
// body. Each route strips those two fields, rebuilds the canonical message
// from the remaining fields it already validates (canonicalAuthMessage), and
// calls verifyOwnerSignature. The recovered signer address is then compared
// against the owner the route derives from data it already has - the
// connected wallet in the body (create-order wallet, claim-all
// creatorAddress), the order's stored wallet (cancel-order), or the
// session's indexed owner (session routes, via assertSessionOwner). Nothing
// is hardcoded or configured per-operator.
//
// verifyPersonalMessageSignature handles Ed25519/Secp256k1/Secp256r1 wallet
// signatures generically (no zkLogin branch in v1 - all supported wallets
// sign standard personal messages).

import { verifyPersonalMessageSignature } from '@mysten/sui/verify';
import { normalizeSuiAddress } from '@mysten/sui/utils';
import { canonicalAuthMessage, stableStringify } from './authCanonical.js';

export { canonicalAuthMessage, stableStringify };

const INDEXER_URL =
  process.env.INDEXER_URL ??
  process.env.VITE_INDEXER_URL ??
  'https://suipump-62s2.onrender.com';

// Freshness window for a signed request. A single-use nonce store is a known
// fast-follow; v1 bounds replay to this window.
const MAX_SKEW_MS = 60000;

function normLower(addr) {
  return normalizeSuiAddress(String(addr)).toLowerCase();
}

// Verify a personal-message signature over the SERVER-derived canonical
// payload. Returns the recovered signer address (normalized, lowercased) or
// throws. When expectedAddress is given, also asserts signer == expected.
export async function verifyOwnerSignature({ signature, ts, expectedAddress, canonicalPayload }) {
  if (typeof signature !== 'string' || signature.length === 0) {
    throw new Error('missing signature');
  }
  const tsNum = Number(ts);
  if (!Number.isFinite(tsNum)) throw new Error('missing or invalid ts');
  if (Math.abs(Date.now() - tsNum) > MAX_SKEW_MS) {
    throw new Error('signature expired (ts outside the 60s window)');
  }
  if (typeof canonicalPayload !== 'string' || canonicalPayload.length === 0) {
    throw new Error('empty canonical payload');
  }

  let publicKey;
  try {
    publicKey = await verifyPersonalMessageSignature(
      new TextEncoder().encode(canonicalPayload),
      signature
    );
  } catch (e) {
    throw new Error(`invalid signature: ${e.message}`);
  }

  const recovered = normLower(publicKey.toSuiAddress());
  if (expectedAddress != null) {
    let expected;
    try { expected = normLower(expectedAddress); }
    catch { throw new Error('invalid expected owner address'); }
    if (recovered !== expected) throw new Error('signer does not match owner');
  }
  return recovered;
}

// Confirm ownerAddress actually owns the given session, using the EXISTING
// owner-indexed route GET {INDEXER_URL}/agent/sessions?owner= (see
// indexer/agent_session_api.js). Matches on session_id or session_address,
// whichever the caller supplied. Throws unless ownership is confirmed.
export async function assertSessionOwner({ sessionId, sessionAddress, ownerAddress }) {
  const wantId = sessionId ? normLower(sessionId) : null;
  const wantAddr = sessionAddress ? normLower(sessionAddress) : null;
  if (!wantId && !wantAddr) throw new Error('sessionId or sessionAddress required');
  if (!ownerAddress) throw new Error('owner address required');

  const r = await fetch(
    `${INDEXER_URL}/agent/sessions?owner=${encodeURIComponent(ownerAddress)}&limit=200`,
    { signal: AbortSignal.timeout(8000) }
  );
  if (!r.ok) throw new Error(`session ownership lookup failed (indexer ${r.status})`);
  const rows = await r.json().catch(() => []);
  const list = Array.isArray(rows) ? rows : [];

  const owned = list.some((row) => {
    const rid = row?.session_id ? normLower(row.session_id) : null;
    const raddr = row?.session_address ? normLower(row.session_address) : null;
    return (wantId != null && rid === wantId) || (wantAddr != null && raddr === wantAddr);
  });
  if (!owned) throw new Error('session is not owned by the signer');
  return true;
}

// Sui GraphQL endpoint for the live session-open read below. GraphQL only -
// JSON-RPC is forbidden repo-wide (hard shutdown 2026-07-31).
const SUI_GRAPHQL_URL =
  process.env.SUI_GRAPHQL_URL ?? 'https://graphql.testnet.sui.io/graphql';

// assertSessionOpen - live on-chain check that an AgentSession is OPEN and can
// still trade: the object exists, revoked is false, and expiry_ms is neither
// the 0 CLOSED sentinel (V11 close_session) nor in the past. assertSessionOwner
// above only proves the signer OPENED the session at some point (indexer
// SessionOpened history); this proves the session can actually fire NOW, so
// arm-time rejects orders the strategy runner would immediately close.
// Throws with a human-readable reason unless the session is open. Fails
// CLOSED on read errors by design: arming against an unverifiable session
// just creates an order the runner's gate kills on first wake.
export async function assertSessionOpen({ sessionId }) {
  if (!sessionId) throw new Error('sessionId required');
  const r = await fetch(SUI_GRAPHQL_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: 'query($id: SuiAddress!) { object(address: $id) { asMoveObject { contents { json } } } }',
      variables: { id: String(sessionId) },
    }),
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) throw new Error(`session read failed (graphql ${r.status})`);
  const d = await r.json().catch(() => null);
  if (d?.errors?.length) throw new Error(`session read failed: ${d.errors[0].message}`);
  const json = d?.data?.object?.asMoveObject?.contents?.json;
  if (!json) throw new Error('session object not found on-chain');
  if (json.revoked === true || json.revoked === 'true') throw new Error('session revoked');
  // u64 arrives as a string in GraphQL json; ms timestamps are Number-safe.
  const expiryMs = Number(json.expiry_ms ?? 0);
  if (!(expiryMs > 0)) throw new Error('session closed');
  if (expiryMs <= Date.now()) throw new Error('session expired');
  return true;
}
