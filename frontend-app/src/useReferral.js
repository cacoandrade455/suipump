// useReferral.js - referral capture, first-touch reporting, and per-trade
// referrer resolution for the SuiPump referral program.
//
// The on-chain plumbing already pays the referrer directly at settlement
// (bonding_curve routes REFERRAL_SHARE_BPS of the trade fee to the referral
// address). This module is purely client-side glue:
//
//   1. captureRefParam()    - read ?ref=CODE from the URL, persist it, strip it.
//   2. useReferralCapture() - App-root hook that reports the visit intent to the
//                             indexer (POST /referral/visit) on load and on every
//                             wallet connect/change. The SERVER enforces
//                             first-touch; the client only reports intent.
//   3. resolveReferralArg() - called right before a buy/sell PTB is built. Looks
//                             up the connected wallet's confirmed binding
//                             (GET /referral/binding) and returns the referrer
//                             address to pass, or null. NEVER throws and returns
//                             null on any failure, so referral logic can never
//                             block or fail a trade (graceful degradation).
//
// Transport is plain fetch against the indexer REST API - no Sui client here.

import { useEffect } from 'react';
import { useCurrentAccount } from '@mysten/dapp-kit-react';

const INDEXER_URL = import.meta.env.VITE_INDEXER_URL || '';

// Clear, single localStorage key for the ref code captured BEFORE a wallet is
// connected (there is no wallet yet to key a server-side pending row). This is a
// marketing referral code only - not trading, session, or otherwise critical
// state - so it is safe to hold client-side until connect, at which point the
// server takes over as the source of truth. Cleared once reported.
const REF_STORAGE_KEY = 'suipump_ref_pending';

const ADDR_RE = /^0x[a-fA-F0-9]{60,66}$/;
// Mirror of the server-side A2 charset/length rule, applied leniently so we
// never persist obvious garbage. The server remains the source of truth.
const CODE_RE = /^[A-Za-z0-9_]{3,20}$/;

function readParamCode() {
  try {
    const params = new URLSearchParams(window.location.search);
    const raw = params.get('ref');
    if (!raw) return null;
    const code = raw.trim();
    return CODE_RE.test(code) ? code.toUpperCase() : null;
  } catch { return null; }
}

function stripRefFromUrl() {
  try {
    const url = new URL(window.location.href);
    if (!url.searchParams.has('ref')) return;
    url.searchParams.delete('ref');
    // Keep the rest of the query/hash; only drop ?ref= so shares/bookmarks are clean.
    const qs = url.searchParams.toString();
    const next = url.pathname + (qs ? `?${qs}` : '') + url.hash;
    window.history.replaceState({}, '', next);
  } catch { /* non-fatal */ }
}

export function getPendingCode() {
  try {
    const c = localStorage.getItem(REF_STORAGE_KEY);
    return c && CODE_RE.test(c) ? c.toUpperCase() : null;
  } catch { return null; }
}

function setPendingCode(code) {
  try { localStorage.setItem(REF_STORAGE_KEY, code); } catch { /* ignore */ }
}

function clearPendingCode() {
  try { localStorage.removeItem(REF_STORAGE_KEY); } catch { /* ignore */ }
}

// Read ?ref= from the URL, persist it (so it survives until the wallet connects),
// and strip it from the address bar. Returns the captured code or null.
export function captureRefParam() {
  const code = readParamCode();
  if (code) setPendingCode(code);
  stripRefFromUrl();
  return code;
}

// Report a pending referral intent to the indexer. Best-effort: the server
// enforces first-touch and self-referral, so a repeated or racing call is
// harmless. On success we clear the local pending (the server now holds it).
async function reportVisit(wallet, code) {
  if (!INDEXER_URL || !ADDR_RE.test(wallet) || !code) return;
  try {
    const res = await fetch(`${INDEXER_URL}/referral/visit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ wallet, code }),
      signal: AbortSignal.timeout(5000),
    });
    // 200 => recorded or intentional no-op (unknown code / already bound).
    // 400 self-referral or bad input => stop retrying this code either way.
    if (res.ok || res.status === 400) clearPendingCode();
  } catch { /* network down: keep the pending code and retry on next connect */ }
}

// App-root hook. Captures ?ref= once on mount, then reports the pending intent
// whenever a wallet is connected or changes. The visit is only ever a report;
// the binding is written server-side on the wallet's first trade.
export function useReferralCapture() {
  const account = useCurrentAccount();
  const wallet  = account?.address ?? null;

  // Capture on mount (before any wallet may be connected).
  useEffect(() => { captureRefParam(); }, []);

  // Report on connect / change.
  useEffect(() => {
    if (!wallet) return;
    const code = getPendingCode();
    if (!code) return;
    reportVisit(wallet.toLowerCase(), code);
  }, [wallet]);
}

// Resolve the referral address to pass in a buy/sell PTB for `walletAddress`.
// Returns a lowercase 0x string (the confirmed referrer) or null. NEVER throws;
// returns null on any failure so a trade always proceeds with option::none().
// Client-side self-referral guard: if the resolved referrer equals the trader,
// return null and never send it.
export async function resolveReferralArg(walletAddress) {
  try {
    const wallet = String(walletAddress ?? '').toLowerCase();
    if (!INDEXER_URL || !ADDR_RE.test(wallet)) return null;
    const res = await fetch(
      `${INDEXER_URL}/referral/binding?wallet=${encodeURIComponent(wallet)}`,
      { signal: AbortSignal.timeout(2500) },
    );
    if (!res.ok) return null;
    const d = await res.json();
    const referrer = d?.referrer ? String(d.referrer).toLowerCase() : null;
    if (!referrer || !ADDR_RE.test(referrer)) return null;
    if (referrer === wallet) return null; // self-referral guard
    return referrer;
  } catch { return null; }
}
