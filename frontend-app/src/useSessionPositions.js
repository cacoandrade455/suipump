// useSessionPositions.js - READ-ONLY data module for the portfolio's
// "session-parked positions" feature (ledger decision C-6). NO UI here.
//
// A session-bought position is not an address balance: it lives as a parked
// Coin<T> dynamic OBJECT field ON THE SESSION object (see park_tokens in
// agent_session.move). The wallet's coin list returns nothing for it. This
// module discovers every AgentSession a wallet opened, probes each for parked
// Coin<T> dynamic fields, and surfaces the real token positions. Selling routes
// through the bridge's /session-sell (the session key signs, sellAll:true).
//
// Logic here mirrors AgentPage.jsx faithfully:
//   - discoverMySessions()          (AgentPage ~line 1347)
//   - the parked-balance GraphQL read (AgentPage ~line 2129)
//   - listParkedTokenTypes filtering (AgentPage ~line 1241)
//   - the /session-sell bridge call  (AgentPage ~line 2445)
//
// HARD RULES honored: JSON-RPC forbidden (GraphQL/fetch only); BigInt values are
// converted with Number() before any arithmetic; ASCII-only source.
import { useState, useEffect, useCallback } from 'react';
import { PACKAGE_ID_V10, TOKEN_DECIMALS } from './constants.js';

// Same definitions AgentPage.jsx uses (constants.js has no INDEXER_URL/GQL_URL).
const INDEXER_URL = import.meta.env.VITE_INDEXER_URL || 'https://suipump-62s2.onrender.com';
const GQL_URL = 'https://graphql.testnet.sui.io/graphql';

// Bound the parallel probe fan-out, matching AgentPage's CHUNK=5 discipline.
const CHUNK = 5;

// Framework / plumbing modules that can leak into a dynamic-field scan and must
// never be surfaced as "parked tokens" (same blocklist as listParkedTokenTypes).
const PLUMBING_MODULES = new Set([
  'type_name', 'dynamic_object_field', 'dynamic_field',
  'coin', 'balance', 'agent_session', 'bonding_curve',
]);

// Enumerate every AgentSession this wallet opened. Indexer-first (owner-indexed,
// not capped by chain-RPC event pagination); direct GraphQL scan is the fallback
// so discovery never depends on our own infra being up. Mirrors AgentPage
// discoverMySessions() exactly (8s indexer timeout, dedupe session_id, slice 50;
// GraphQL last:200 SessionOpened filtered by owner, dedupe, slice 20).
async function discoverMySessions(ownerAddress) {
  try {
    const r = await fetch(`${INDEXER_URL}/agent/sessions?owner=${ownerAddress}`, { signal: AbortSignal.timeout(8000) });
    if (r.ok) {
      const rows = await r.json();
      if (Array.isArray(rows) && rows.length > 0) {
        return [...new Set(rows.map(x => x.session_id).filter(Boolean))].slice(0, 50);
      }
    }
  } catch { /* indexer unreachable - fall through to the chain scan */ }
  // SessionOpened defines under V10; V11/V12 code keeps emitting the V10-typed
  // name, so one query covers the whole lineage.
  const evType = `${PACKAGE_ID_V10}::agent_session::SessionOpened`;
  const q = `{ events(filter: { type: "${evType}" }, last: 200) { nodes { contents { json } } } }`;
  const r = await fetch(GQL_URL, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: q }), signal: AbortSignal.timeout(10000),
  });
  const d = await r.json();
  return [...new Set((d?.data?.events?.nodes ?? [])
    .map(n => n.contents?.json)
    .filter(j => j && (j.owner ?? '').toLowerCase() === ownerAddress.toLowerCase())
    .map(j => j.session_id)
    .filter(Boolean))].slice(0, 20);
}

// Pull the inner token type T out of a Coin<T> type repr. A repr looks like
//   0x2::coin::Coin<0xABC...::my_mod::MYTOK>
// Balance types can nest generics, so grab everything between the FIRST "Coin<"
// and the LAST ">". Returns null if the repr is not a Coin<T>.
function extractInnerCoinType(repr) {
  const s = String(repr ?? '');
  const open = s.toLowerCase().indexOf('coin<');
  if (open < 0) return null;
  const start = open + 'coin<'.length;
  const end = s.lastIndexOf('>');
  if (end <= start) return null;
  const inner = s.slice(start, end).trim();
  return inner.length > 0 ? inner : null;
}

// Derive a display name/symbol from a coin type's struct name when no known
// curve matches (e.g. "0xABC::my_mod::MYTOK" -> "MYTOK").
function structNameOf(tokenType) {
  const parts = String(tokenType ?? '').split('::');
  const last = parts[parts.length - 1] || '';
  return last.trim();
}

// Probe one session for its parked Coin<T> dynamic OBJECT fields. Mirrors the
// AgentPage parked-balance read (line 2129) plus the listParkedTokenTypes
// filtering discipline (skip universal_trading, skip framework/plumbing modules,
// only surface real token types with balance > 0). Returns [{ tokenType,
// balanceAtomic (BigInt) }].
async function probeSessionParked(sessionId) {
  const q = `{ object(address: "${sessionId}") { dynamicFields { nodes { value { __typename ... on MoveObject { contents { type { repr } json } } } } } }`;
  const r = await fetch(GQL_URL, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: q }), signal: AbortSignal.timeout(8000),
  });
  const d = await r.json();
  const nodes = d?.data?.object?.dynamicFields?.nodes ?? [];
  const out = [];
  for (const n of nodes) {
    const c = n?.value?.contents;
    const repr = String(c?.type?.repr ?? '');
    const reprLc = repr.toLowerCase();
    // Only Coin<T> dynamic fields hold parked positions.
    if (!reprLc.includes('::coin::coin<')) continue;
    // Skip the universal_trading opt-in field (same policy as AgentPage).
    if (reprLc.includes('universal_trading') || reprLc.includes('dw5pdmvyc2fsx3ryywrpbmc')) continue;
    const bal = c?.json?.balance;
    if (bal == null) continue;
    let atomic;
    try { atomic = BigInt(bal); } catch { continue; }
    if (atomic <= 0n) continue;
    const inner = extractInnerCoinType(repr);
    if (!inner) continue;
    // Exclude framework / plumbing coin generics (Coin<0x2::sui::SUI> etc.) that
    // are not real launched tokens; guard by the inner type's module segment.
    const innerParts = inner.split('::');
    const innerModule = innerParts.length >= 2 ? innerParts[1] : '';
    if (PLUMBING_MODULES.has(innerModule)) continue;
    out.push({ tokenType: inner, balanceAtomic: atomic });
  }
  return out;
}

// Run an async fn over items in bounded batches (CHUNK), collecting settled
// results only. Mirrors AgentPage's CHUNK=5 Promise.allSettled fan-out.
async function mapBounded(items, size, fn) {
  const results = [];
  for (let i = 0; i < items.length; i += size) {
    const batch = items.slice(i, i + size);
    const settled = await Promise.allSettled(batch.map(fn));
    for (let j = 0; j < settled.length; j++) {
      if (settled[j].status === 'fulfilled') results.push({ item: batch[j], value: settled[j].value });
    }
  }
  return results;
}

// Sell an entire session-parked position via the bridge. The SESSION key signs
// (not the shared agent wallet, not the user wallet); the bridge resolves the
// exact parked amount on-chain from sellAll. Mirrors AgentPage settleViaBridge's
// session-sell branch (line 2445): success = r.ok && d.ok !== false; returns
// d.txDigest ?? null; throws on failure. curveId is required (a null curveId
// position is read-only and cannot be sold).
export async function sellSessionPosition({ sessionId, curveId }) {
  if (!sessionId) throw new Error('sellSessionPosition: sessionId is required');
  if (!curveId) throw new Error('sellSessionPosition: curveId is required (read-only position)');
  const r = await fetch(`/api/agent-bridge`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: '/session-sell', sessionId, curveId, sellAll: true, minSuiOut: 0 }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || d.ok === false) throw new Error(d.error || `bridge sell failed (${r.status})`);
  return d.txDigest ?? null;
}

// React hook: discover the connected wallet's sessions, probe each for parked
// Coin<T> positions, and map each to a known curve (case-insensitive tokenType
// match) for display metadata. Positions without a matching curve are still
// surfaced (curveId=null) but are read-only (cannot be sold via /session-sell).
//
//   account = dapp-kit account (may be null)
//   tokens  = useTokenList array of { curveId, name, symbol, iconUrl, tokenType }
//
// Returns { positions, loading, error, refresh }.
export function useSessionPositions(account, tokens) {
  const [positions, setPositions] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  // Bump to force a re-fetch on demand.
  const [nonce, setNonce] = useState(0);

  const refresh = useCallback(() => setNonce(n => n + 1), []);

  const address = account?.address ?? null;
  // Only the length matters for re-running (matches the task's dependency spec).
  const tokensLen = Array.isArray(tokens) ? tokens.length : 0;

  useEffect(() => {
    // No wallet: nothing to discover. Clear state and stay not-loading.
    if (!address) {
      setPositions([]);
      setError(null);
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    (async () => {
      try {
        // Build a case-insensitive tokenType -> token index once per run.
        const tokenByType = new Map();
        for (const t of (Array.isArray(tokens) ? tokens : [])) {
          const tt = t?.tokenType;
          if (tt) tokenByType.set(String(tt).toLowerCase(), t);
        }

        const sessionIds = await discoverMySessions(address);
        if (cancelled) return;

        const probed = await mapBounded(sessionIds, CHUNK, (sid) => probeSessionParked(sid));
        if (cancelled) return;

        const out = [];
        for (const { item: sessionId, value: parkedList } of probed) {
          for (const parked of parkedList) {
            const atomic = parked.balanceAtomic; // BigInt, already > 0
            const known = tokenByType.get(String(parked.tokenType).toLowerCase()) || null;
            // BigInt x number crashes: convert to Number BEFORE arithmetic.
            const balanceWhole = Number(atomic) / 10 ** TOKEN_DECIMALS;
            out.push({
              sessionId,
              tokenType: parked.tokenType,
              curveId: known?.curveId ?? null,
              name: known?.name ?? structNameOf(parked.tokenType),
              symbol: known?.symbol ?? structNameOf(parked.tokenType),
              iconUrl: known?.iconUrl ?? null,
              balanceAtomic: atomic,
              balanceWhole,
            });
          }
        }

        if (!cancelled) {
          setPositions(out);
          setLoading(false);
        }
      } catch (e) {
        if (!cancelled) {
          setError(e?.message || 'Failed to load session positions');
          setPositions([]);
          setLoading(false);
        }
      }
    })();

    return () => { cancelled = true; };
  }, [address, tokensLen, nonce]); // eslint-disable-line react-hooks/exhaustive-deps

  return { positions, loading, error, refresh };
}
