// v21-fresh-reserve-slippage
// TokenPage.jsx
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useCurrentAccount, useDAppKit, useCurrentClient } from '@mysten/dapp-kit-react';
import { Transaction } from '@mysten/sui/transactions';
import { SuiGraphQLClient } from '@mysten/sui/graphql';
import { ArrowLeft, Copy, Check, Share2, ExternalLink, Settings, Edit3, Clock, Zap, ShieldAlert, Plus, Trash2, Bell } from 'lucide-react';
import { useTPSL, makeLevel } from './useTPSL.js';
import PriceChart from './PriceChart.jsx';
import TradeHistory from './TradeHistory.jsx';
import { useTokenPageFeed } from './useRealtimeFeed.js';
import HolderList from './HolderList.jsx';
import Comments from './Comments.jsx';
import AIAnalysis from './AIAnalysis.jsx';
import { PACKAGE_ID, PACKAGE_ID_V4, PACKAGE_ID_V5, PACKAGE_ID_V6, PACKAGE_ID_V7, PACKAGE_ID_V8_1, PACKAGE_ID_V8, PACKAGE_ID_V9, ALL_PACKAGE_IDS, MIST_PER_SUI, DRAIN_SUI_APPROX, VIRTUAL_SUI_V4, VIRTUAL_SUI_V5, VIRTUAL_SUI_V6, VIRTUAL_SUI_V7, VIRTUAL_SUI_V8, VIRTUAL_SUI_V9, VIRTUAL_TOKENS_V4, VIRTUAL_TOKENS_V5, VIRTUAL_TOKENS_V6, VIRTUAL_TOKENS_V7, VIRTUAL_TOKENS_V8, VIRTUAL_TOKENS_V9, DRAIN_SUI_V4, DRAIN_SUI_V5, DRAIN_SUI_V6, DRAIN_SUI_V7, DRAIN_SUI_V8, DRAIN_SUI_V9, isNewCurve, isV5OrLater, isV7OrLater, isV8OrLater, isV9OrLater, supportsMetadataUpdate, curveShapeFor } from './constants.js';
import { buyQuote, sellQuote } from './curve.js';
import { t } from './i18n.js';

// BCS helpers
function bcsOptionNone() { return new Uint8Array([0]); }
function bcsOptionSomeAddress(addr) {
  const hex = addr.replace('0x', '').padStart(64, '0');
  const bytes = new Uint8Array(33);
  bytes[0] = 1;
  for (let i = 0; i < 32; i++) bytes[i + 1] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

// ── constants ─────────────────────────────────────────────────────────────────
const TOKEN_DECIMALS     = 6;
const TOTAL_SUPPLY_WHOLE = 1_000_000_000;
const SUI_CLOCK_ID       = '0x6';

// Quick-buy preset amounts (whole SUI, no fractions — SUI is cheap)
const QUICK_BUY_AMOUNTS = ['1', '10', '50', '100', '500'];

// ── CreatorCap resolution ───────────────────────────────────────────────────
// Normalize a Sui address/ID to canonical 0x + 64-hex lowercase form so that
// strict matching can't fail on prefix/padding/case differences. Sui GraphQL
// can return a struct's `ID` field in a shape that does not byte-match the URL
// param, which previously made the cap lookup miss a cap sitting in the wallet.
function _normAddr(a) {
  if (a == null) return '';
  let s = String(a).trim().toLowerCase();
  if (s.startsWith('0x')) s = s.slice(2);
  s = s.replace(/^0+/, '');
  if (s === '') s = '0';
  return '0x' + s.padStart(64, '0');
}

const _SUI_GQL_URL = 'https://graphql.testnet.sui.io/graphql';

async function _gql(query, ms = 8000) {
  const r = await fetch(_SUI_GQL_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
    signal: AbortSignal.timeout(ms),
  });
  return r.json();
}

// Resolve the CreatorCap object for `curveId` owned by `ownerAddr`.
// Returns { capId, capPkgId }. Throws an actionable error if none is found.
// Strategy: (1) indexer fast path, (2) type-filtered + paginated per known
// package, (3) package-agnostic bounded scan (catches caps minted by a package
// id not present in constants). All comparisons are normalized.
async function resolveCreatorCap(ownerAddr, curveId, indexerUrl) {
  const want = _normAddr(curveId);

  // 1. Indexer endpoint — trust only when it returns an objectId.
  if (indexerUrl) {
    try {
      const res = await fetch(`${indexerUrl}/token/${curveId}/creator-cap?owner=${ownerAddr}`, { signal: AbortSignal.timeout(5000) });
      if (res.ok) {
        const d = await res.json();
        if (d && d.objectId) return { capId: d.objectId, capPkgId: d.packageId ?? d.package_id ?? null };
      }
    } catch {}
  }

  let scanned = 0;

  // 2. Type-filtered, paginated query per known package (cheap — caps only).
  for (const pid of ALL_PACKAGE_IDS) {
    if (!pid) continue;
    let cursor = null;
    for (let page = 0; page < 5; page++) {
      const after = cursor ? `, after: "${cursor}"` : '';
      const q = `{ address(address: "${ownerAddr}") { objects(first: 50${after}, filter: { type: "${pid}::bonding_curve::CreatorCap" }) { pageInfo { hasNextPage endCursor } nodes { address contents { json } } } } }`;
      let result;
      try { result = await _gql(q); } catch { break; }
      const conn = result?.data?.address?.objects;
      const nodes = conn?.nodes ?? [];
      for (const n of nodes) {
        scanned++;
        if (_normAddr(n.contents?.json?.curve_id) === want) return { capId: n.address, capPkgId: pid };
      }
      if (!conn?.pageInfo?.hasNextPage) break;
      cursor = conn.pageInfo.endCursor;
    }
  }

  // 3. Package-agnostic fallback — bounded scan over owned objects, matched by
  //    type repr. Covers caps minted by a package id missing from constants.
  {
    let cursor = null;
    for (let page = 0; page < 8; page++) {
      const after = cursor ? `, after: "${cursor}"` : '';
      const q = `{ address(address: "${ownerAddr}") { objects(first: 50${after}) { pageInfo { hasNextPage endCursor } nodes { address contents { type { repr } json } } } } }`;
      let result;
      try { result = await _gql(q); } catch { break; }
      const conn = result?.data?.address?.objects;
      const nodes = conn?.nodes ?? [];
      for (const n of nodes) {
        const repr = n.contents?.type?.repr || '';
        if (!repr.includes('::bonding_curve::CreatorCap')) continue;
        scanned++;
        if (_normAddr(n.contents?.json?.curve_id) === want) {
          return { capId: n.address, capPkgId: repr.split('::')[0] };
        }
      }
      if (!conn?.pageInfo?.hasNextPage) break;
      cursor = conn.pageInfo.endCursor;
    }
  }

  if (scanned > 0) {
    throw new Error('This token\u2019s CreatorCap is not in the connected wallet. Connect the wallet that launched it, or claim via the agent.');
  }
  throw new Error('No CreatorCap in the connected wallet. This token was launched by a different wallet \u2014 claim from that wallet or via the agent.');
}

function mistToSui(mist) {
  if (mist == null) return 0;
  return Number(mist) / 1e9;
}

function priceMistPerToken(suiReserveMist, tokensSold, vSuiSui, vTokTokens) {
  const vSui = BigInt(vSuiSui) * BigInt(MIST_PER_SUI);
  const vTok = BigInt(vTokTokens) * 10n ** BigInt(TOKEN_DECIMALS);
  const realSui = BigInt(suiReserveMist);
  const realTok = BigInt(tokensSold);
  const numSui = vSui + realSui;
  const numTok = vTok - realTok;
  if (numTok === 0n) return 0n;
  return (numSui * 10n ** BigInt(TOKEN_DECIMALS)) / numTok;
}

function fmt(n, decimals = 4) {
  if (n == null) return '-';
  if (typeof n === 'bigint') n = Number(n);
  if (isNaN(n)) return '-';
  if (Math.abs(n) >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
  if (Math.abs(n) >= 1_000) return (n / 1_000).toFixed(2) + 'k';
  return n.toFixed(decimals);
}

function fmtUsd(suiAmt, suiUsd, decimals = 2) {
  if (suiAmt == null) return '-';
  const usd = Number(suiAmt) * suiUsd;
  if (usd >= 1_000_000) return `$${(usd / 1_000_000).toFixed(2)}M`;
  if (usd >= 1_000) return `$${(usd / 1_000).toFixed(1)}k`;
  if (usd >= 1) return `$${usd.toFixed(2)}`;
  return `$${usd.toFixed(decimals + 2)}`;
}

async function fetchSuiUsd() {
  try {
    const r = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=SUIUSDT');
    const j = await r.json();
    return parseFloat(j.price) || 0;
  } catch {
    try {
      const r = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=sui&vs_currencies=usd');
      const j = await r.json();
      return j?.sui?.usd || 0;
    } catch { return 0; }
  }
}

function parseDescription(raw) {
  if (!raw) return { desc: '', twitter: '', telegram: '', website: '', dex: 'cetus' };
  const idx = raw.indexOf('||');
  if (idx === -1) return { desc: raw, twitter: '', telegram: '', website: '', dex: 'cetus' };
  const descPart = raw.slice(0, idx);
  try {
    const links = JSON.parse(raw.slice(idx + 2));
    return { desc: descPart, twitter: links.twitter || '', telegram: links.telegram || '', website: links.website || '', dex: links.dex || 'cetus' };
  } catch {
    const parts = raw.split('||');
    return { desc: parts[0]?.trim() || '', twitter: parts[1]?.trim() || '', telegram: parts[2]?.trim() || '', website: parts[3]?.trim() || '', dex: 'cetus' };
  }
}

function isPlaceholderIcon(url) {
  if (!url) return true;
  return url.includes('suipump.test');
}

function isPlaceholderDesc(desc) {
  if (!desc) return false;
  return desc.startsWith('Template description placeholder') || desc.startsWith('Template Coin');
}

function getTokenPackageId(tokenType) {
  if (!tokenType) return null;
  if (PACKAGE_ID_V9 && tokenType.startsWith(PACKAGE_ID_V9)) return PACKAGE_ID_V9;
  if (PACKAGE_ID_V9  && tokenType.startsWith(PACKAGE_ID_V9))  return PACKAGE_ID_V9;
  if (PACKAGE_ID_V8_1 && tokenType.startsWith(PACKAGE_ID_V8_1)) return PACKAGE_ID_V8_1;
  if (PACKAGE_ID_V8 && tokenType.startsWith(PACKAGE_ID_V8)) return PACKAGE_ID_V8;
  if (PACKAGE_ID_V7 && tokenType.startsWith(PACKAGE_ID_V7)) return PACKAGE_ID_V7;
  if (PACKAGE_ID_V6 && tokenType.startsWith(PACKAGE_ID_V6)) return PACKAGE_ID_V6;
  if (PACKAGE_ID_V5 && tokenType.startsWith(PACKAGE_ID_V5)) return PACKAGE_ID_V5;
  if (tokenType.startsWith(PACKAGE_ID_V4)) return PACKAGE_ID_V4;
  return null;
}

function resolvePackageId(tokenType, packageIdHint) {
  // packageIdHint comes from the indexer and is always the correct bonding
  // curve package. Use it first. getTokenPackageId() tries to match the coin
  // package against curve package IDs which can never work — they're always
  // different addresses. Only fall back to it if hint is missing.
  if (packageIdHint) return packageIdHint;
  const fromType = getTokenPackageId(tokenType);
  if (fromType) return fromType;
  return PACKAGE_ID;
}

const SLIPPAGE_PRESETS = ['0.5', '1', '2', '5'];

// ── Target Return Calculator ──────────────────────────────────────────────────
// Given current curve state + a buy amount, shows what mcap the token needs to
// reach for 2x / 5x / 10x returns after fees on both sides.
// Uses binary search on future SUI reserve to find the sell price that yields
// the target proceeds. Fully deterministic curve math — no RPC needed.
function calcReturnTargets(reserveMist, tokensRemaining, suiInMist, vSui, vTok, suiUsd) {
  if (!reserveMist || !tokensRemaining || !suiInMist || suiInMist <= 0n) return null;

  const buyResult = buyQuote(reserveMist, tokensRemaining, suiInMist, vSui, vTok);
  if (!buyResult?.tokensOut || buyResult.tokensOut <= 0n) return null;

  const tokensReceived  = buyResult.tokensOut;
  const suiSpent        = suiInMist;
  const newReserveMist  = reserveMist + buyResult.actualSwap + buyResult.fees.lp;
  const newTokensRemaining = tokensRemaining - tokensReceived;
  const DRAIN_MIST      = BigInt(9000) * BigInt(MIST_PER_SUI);

  function sellProceedsAtReserve(futureSuiReserve) {
    try {
      const result = sellQuote(futureSuiReserve, newTokensRemaining, tokensReceived, vSui, vTok);
      return result?.suiOut ?? 0n;
    } catch { return 0n; }
  }

  function findReserveForMultiplier(multiplier) {
    // target: sell proceeds >= multiplier * suiSpent
    const targetProceeds = (suiSpent * BigInt(Math.round(multiplier * 100))) / 100n;
    if (sellProceedsAtReserve(DRAIN_MIST) < targetProceeds) return null; // not reachable before grad
    let lo = newReserveMist;
    let hi = DRAIN_MIST;
    for (let i = 0; i < 64; i++) {
      const mid = (lo + hi) / 2n;
      if (sellProceedsAtReserve(mid) >= targetProceeds) hi = mid;
      else lo = mid;
      if (hi - lo < 1_000_000n) break; // 0.001 SUI precision
    }
    return hi;
  }

  return [2, 5, 10].map(mult => {
    const reserveNeeded = findReserveForMultiplier(mult);
    if (!reserveNeeded) return { mult, reachable: false };
    const soldAtTarget = BigInt(800_000_000) * 10n ** 6n - newTokensRemaining;
    const priceAtTarget = Number(priceMistPerToken(reserveNeeded, soldAtTarget, vSui, vTok)) / 1e9;
    const mcapSui = priceAtTarget * TOTAL_SUPPLY_WHOLE;
    return {
      mult,
      reachable:  true,
      reserveSui: Number(reserveNeeded) / 1e9,
      mcapSui,
      mcapUsd:    mcapSui * suiUsd,
    };
  });
}

// ── Vesting panel (V7+) ───────────────────────────────────────────────────────
const VEST_MODE_LABEL = { 0: 'Cliff', 1: 'Linear', 2: 'Monthly' };
const VEST_DURATIONS_MS = {
  '7d':   7   * 24 * 60 * 60 * 1000,
  '30d':  30  * 24 * 60 * 60 * 1000,
  '180d': 180 * 24 * 60 * 60 * 1000,
  '365d': 365 * 24 * 60 * 60 * 1000,
};
const MONTH_MS = 30 * 24 * 60 * 60 * 1000;

function vestedAmount(total, startMs, durationMs, mode, nowMs) {
  if (nowMs <= startMs) return 0;
  const elapsed = nowMs - startMs;
  if (elapsed >= durationMs) return total;
  if (mode === 0) return 0;
  if (mode === 1) return Math.floor(total * elapsed / durationMs);
  const totalMonths   = Math.floor(durationMs / MONTH_MS);
  const elapsedMonths = Math.floor(elapsed / MONTH_MS);
  return Math.floor(total * elapsedMonths / totalMonths);
}

function VestingPanel({ curveId, tokenType, packageId, account, tokenBalance, lang, initialSharedVersion = null }) {
  const client = useCurrentClient();
  const dAppKit = useDAppKit();

  const [locks, setLocks]             = React.useState([]);
  const [loading, setLoading]         = React.useState(true);
  const [busy, setBusy]               = React.useState(false);
  const [msg, setMsg]                 = React.useState('');
  const [showLockForm, setShowLockForm] = React.useState(false);
  const [lockAmount, setLockAmount]   = React.useState('');
  const [lockMode, setLockMode]       = React.useState(0);
  const [lockDuration, setLockDuration] = React.useState('30d');

  const isV7      = isV7OrLater(packageId);
  const vestingPkg = packageId; // use the token's actual package — lock_tokens exists in V7 and V8

  const loadLocks = useCallback(async () => {
    if (!isV7 || !curveId || !account || !vestingPkg) { setLoading(false); return; }
    try {
      // queryEvents removed in @mysten/sui 2.x — use indexer for lock IDs
      const INDEXER_URL_VP = import.meta.env.VITE_INDEXER_URL || '';
      let mine = [];
      if (INDEXER_URL_VP) {
        try {
          const res = await fetch(`${INDEXER_URL_VP}/token/${curveId}/locks?owner=${account.address}`, { signal: AbortSignal.timeout(5000) });
          if (res.ok) { const rows = await res.json(); mine = rows.map(r => r.lock_id).filter(Boolean); }
        } catch {}
      }
      // Lock detail fetching needs direct RPC — will work once CORS is resolved
      // For now, locks are listed but details may not load in browser context
      const out = [];
      for (const lockId of mine) {
        try {
          const res = await fetch(`${import.meta.env.VITE_INDEXER_URL || ''}/lock/${lockId}`, { signal: AbortSignal.timeout(3000) });
          if (res.ok) {
            const f = await res.json();
            out.push({ id: lockId, total: Number(f.total_amount ?? 0), claimed: Number(f.claimed ?? 0), remaining: Number(f.locked ?? 0), startMs: Number(f.start_ms ?? 0), durationMs: Number(f.duration_ms ?? 0), mode: Number(f.mode ?? 0) });
          }
        } catch {}
      }
      setLocks(out);
    } catch {} finally { setLoading(false); }
  }, [isV7, curveId, account, client, vestingPkg, tokenType]);

  useEffect(() => { loadLocks(); }, [loadLocks]);

  const handleClaim = async (lockId) => {
    if (!account || busy) return;
    setBusy(true); setMsg('');
    try {
      // VestLock objects are user-owned, not shared — use tx.object directly
      const tx = new Transaction();
      const lockRef = tx.object(lockId);
      const [claimed] = tx.moveCall({ target: `${vestingPkg}::bonding_curve::claim_vested`, typeArguments: [tokenType], arguments: [lockRef, tx.object(SUI_CLOCK_ID)] });
      tx.transferObjects([claimed], account.address);
      const claimResult = await dAppKit.signAndExecuteTransaction({ transaction: tx });
      if (claimResult.$kind === 'FailedTransaction') throw new Error(claimResult.FailedTransaction.status.error ?? 'Claim failed');
      setMsg('Claimed ✓'); setBusy(false); setTimeout(() => { setMsg(''); loadLocks(); }, 1500);
    } catch (e) { setMsg(e.message || 'Claim failed'); setBusy(false); }
  };

  const handleLock = async () => {
    if (!account || busy) return;
    const amt = parseFloat(lockAmount);
    if (!amt || amt <= 0) { setMsg('Enter an amount'); return; }
    if (amt > tokenBalance) { setMsg('Amount exceeds your balance'); return; }
    setBusy(true); setMsg('');
    try {
      const atomic = BigInt(Math.floor(amt * 10 ** TOKEN_DECIMALS));
      const coins  = await client.listCoins({ owner: account.address, coinType: tokenType });
      if (!coins.objects.length) throw new Error('No token balance');
      const tx  = new Transaction();
      // Always use sharedObjectRef for the curve — tx.object() on a shared object causes TypeMismatch
      let isv = initialSharedVersion ?? curveState?.initial_shared_version ?? null;
      if (!isv) {
        // Fetch ISV from indexer as last resort
        try {
          const _IURL = import.meta.env.VITE_INDEXER_URL || '';
          const r = await fetch(`${_IURL}/token/${curveId}`, { signal: AbortSignal.timeout(3000) });
          if (r.ok) { const d = await r.json(); isv = d.initialSharedVersion ?? d.initial_shared_version ?? null; }
        } catch {}
      }
      if (!isv) throw new Error('Could not resolve curve shared version');
      const curveRef = tx.sharedObjectRef({ objectId: curveId, initialSharedVersion: isv, mutable: false });
      const coinObjs = coins.objects.map(c => tx.object(c.objectId));
      let tokenCoin;
      if (coinObjs.length === 1) { [tokenCoin] = tx.splitCoins(coinObjs[0], [tx.pure.u64(atomic)]); }
      else { tx.mergeCoins(coinObjs[0], coinObjs.slice(1)); [tokenCoin] = tx.splitCoins(coinObjs[0], [tx.pure.u64(atomic)]); }
      const durationMs = VEST_DURATIONS_MS[lockDuration] ?? VEST_DURATIONS_MS['30d'];
      tx.moveCall({ target: `${vestingPkg}::bonding_curve::lock_tokens`, typeArguments: [tokenType], arguments: [curveRef, tokenCoin, tx.pure.u8(lockMode), tx.pure.u64(durationMs), tx.object(SUI_CLOCK_ID)] });
      const lockResult = await dAppKit.signAndExecuteTransaction({ transaction: tx });
      if (lockResult.$kind === 'FailedTransaction') throw new Error(lockResult.FailedTransaction.status.error ?? 'Lock failed');
      setMsg('Locked ✓'); setBusy(false); setLockAmount(''); setShowLockForm(false); setTimeout(() => { setMsg(''); loadLocks(); }, 1500);
    } catch (e) { setMsg(e.message || 'Lock failed'); setBusy(false); }
  };

  if (!isV7) return null;
  if (loading) return null;
  if (locks.length === 0 && !account) return null;

  const now = Date.now();

  return (
    <div className="bg-white/[0.03] border border-white/10 rounded-xl overflow-hidden">
      <div className="px-4 py-3 border-b border-white/10 flex items-center justify-between">
        <span className="text-[10px] font-mono text-white/35 tracking-widest">VESTING LOCKS</span>
        {account && <button onClick={() => setShowLockForm(o => !o)} className="text-[10px] font-mono text-lime-400 hover:text-lime-300 transition-colors">{showLockForm ? 'Cancel' : '+ Lock tokens'}</button>}
      </div>
      {showLockForm && (
        <div className="px-4 py-3 border-b border-white/10 space-y-3">
          <p className="text-[9px] font-mono text-white/25 leading-relaxed">Lock tokens you already hold. Terms are immutable once set.</p>
          <div>
            <div className="text-[9px] tracking-widest text-white/30 mb-1.5">AMOUNT</div>
            <input type="number" value={lockAmount} onChange={e => { setLockAmount(e.target.value); setMsg(''); }} placeholder={`0 — you hold ${tokenBalance}`} min="0" className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-lime-400/50" />
            <div className="flex gap-1.5 mt-1.5">
              {[50, 75, 100].map(pct => (
                <button key={pct} onClick={() => setLockAmount(((tokenBalance * pct) / 100).toFixed(0))}
                  className="flex-1 py-1 rounded text-[9px] font-mono text-white/40 bg-white/5 border border-white/10 hover:text-lime-400 hover:border-lime-400/30 transition-colors">
                  {pct}%
                </button>
              ))}
            </div>
          </div>
          <div>
            <div className="text-[9px] tracking-widest text-white/30 mb-1.5">MODE</div>
            <div className="grid grid-cols-3 gap-1.5">
              {[{ v: 0, l: 'Cliff' }, { v: 1, l: 'Linear' }, { v: 2, l: 'Monthly' }].map(({ v, l }) => {
                const disabled = v === 2 && lockDuration === '7d';
                return <button key={v} disabled={disabled} onClick={() => setLockMode(v)} className={`py-2 rounded-lg text-[10px] font-mono transition-colors ${disabled ? 'bg-white/5 text-white/15 cursor-not-allowed' : lockMode === v ? 'bg-lime-400 text-black' : 'bg-white/5 text-white/40 hover:text-white/70'}`}>{l}</button>;
              })}
            </div>
          </div>
          <div>
            <div className="text-[9px] tracking-widest text-white/30 mb-1.5">DURATION</div>
            <div className="grid grid-cols-4 gap-1.5">
              {['7d', '30d', '180d', '365d'].map(d => (
                <button key={d} onClick={() => { setLockDuration(d); if (d === '7d' && lockMode === 2) setLockMode(0); }} className={`py-2 rounded-lg text-[10px] font-mono transition-colors ${lockDuration === d ? 'bg-lime-400 text-black' : 'bg-white/5 text-white/40 hover:text-white/70'}`}>{d}</button>
              ))}
            </div>
          </div>
          <button onClick={handleLock} disabled={busy || !lockAmount} className={`w-full py-2.5 rounded-lg text-[11px] font-mono transition-colors ${busy || !lockAmount ? 'bg-white/5 text-white/25 cursor-not-allowed' : 'bg-lime-400 hover:bg-lime-300 text-black'}`}>{busy ? 'Locking…' : 'Lock tokens'}</button>
        </div>
      )}
      {locks.length === 0 ? (
        <div className="py-6 text-center text-white/35 text-xs font-mono">No locks for this token.</div>
      ) : (
        <div className="divide-y divide-white/5">
          {locks.map(lk => {
            const vested    = vestedAmount(lk.total, lk.startMs, lk.durationMs, lk.mode, now);
            const claimable = Math.max(0, vested - lk.claimed);
            const pct       = lk.total > 0 ? (vested / lk.total) * 100 : 0;
            const whole     = (n) => (n / 10 ** TOKEN_DECIMALS).toLocaleString();
            return (
              <div key={lk.id} className="px-4 py-3 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-[10px] font-mono text-white/50">{VEST_MODE_LABEL[lk.mode]} · {Math.round(lk.durationMs / 86400000)}d</span>
                  <span className="text-[10px] font-mono text-white/40">{whole(lk.remaining)} locked</span>
                </div>
                <div className="h-1.5 bg-white/5 rounded-full overflow-hidden">
                  <div className="h-full bg-lime-400" style={{ width: `${Math.min(100, pct)}%` }} />
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-[9px] font-mono text-white/30">{pct.toFixed(1)}% vested · {whole(lk.claimed)} claimed</span>
                  <button onClick={() => handleClaim(lk.id)} disabled={busy || claimable <= 0} className={`text-[10px] font-mono px-2.5 py-1 rounded transition-colors ${busy || claimable <= 0 ? 'bg-white/5 text-white/20 cursor-not-allowed' : 'bg-lime-400 hover:bg-lime-300 text-black'}`}>
                    {claimable > 0 ? `Claim ${whole(claimable)}` : 'Nothing vested'}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
      {msg && <div className="px-4 py-2 border-t border-white/10 text-[10px] font-mono text-lime-400">{msg}</div>}
    </div>
  );
}

// ── Creator Tools Panel ───────────────────────────────────────────────────────

function CreatorToolsPanel({ curveId, tokenType, packageIdHint, account, curveState, currentDesc, currentTwitter, currentTelegram, currentWebsite, currentDex, lang }) {
  const client = useCurrentClient();
  const dAppKit = useDAppKit();
  const pkgId   = resolvePackageId(tokenType, packageIdHint);
  const isV5Token = isV5OrLater(pkgId);
  const isV6Token = !!(PACKAGE_ID_V6 && pkgId === PACKAGE_ID_V6);
  const isV7Token = isV7OrLater(pkgId);
  const isV8Token = isV8OrLater(pkgId);
  const metadataPkg = isV9OrLater(pkgId) ? PACKAGE_ID_V9 : pkgId === PACKAGE_ID_V8_1 ? PACKAGE_ID_V8_1 : isV8Token ? PACKAGE_ID_V8 : PACKAGE_ID_V7;
  const METADATA_UPDATE_ENABLED = true;

  const [tab,  setTab]  = useState('links');
  const [msg,  setMsg]  = useState('');
  const [busy, setBusy] = useState(false);
  const [links, setLinks] = useState({ desc: currentDesc || '', twitter: currentTwitter || '', telegram: currentTelegram || '', website: currentWebsite || '', dex: currentDex || 'cetus' });
  const [meta,  setMeta]  = useState({ name: '', symbol: '', description: '', iconUrl: '' });
  const [iconUploading, setIconUploading]   = useState(false);
  const [iconUploadError, setIconUploadError] = useState(null);

  const showMsg = (m) => { setMsg(m); setTimeout(() => setMsg(''), 4000); };

  const getCapId = async () => {
    const { capId } = await resolveCreatorCap(account.address, curveId, import.meta.env.VITE_INDEXER_URL || '');
    return capId;
  };

  const getCurveRef = async (tx) => {
    // Use initialSharedVersion from curveState (loaded from indexer) — no direct RPC call
    const isv = curveState?.initial_shared_version ?? null;
    return isv ? tx.sharedObjectRef({ objectId: curveId, initialSharedVersion: isv, mutable: true }) : tx.object(curveId);
  };

  const handleQueueLinks = () => {
    if (!links.desc && !links.twitter && !links.telegram && !links.website) { showMsg('Fill in at least one field'); return; }
    localStorage.setItem(`suipump_links_${curveId}`, JSON.stringify({ updatedAt: Date.now(), desc: links.desc.trim() || null, twitter: links.twitter.trim() || null, telegram: links.telegram.trim() || null, website: links.website.trim() || null, dex: links.dex || 'cetus' }));
    showMsg('Links updated! ✅');
    setTimeout(() => window.location.reload(), 1200);
  };

  const handleUpdateMetadata = async () => {
    if (!meta.name && !meta.symbol && !meta.description && !meta.iconUrl) { showMsg('Fill in at least one field'); return; }
    if (!(isV7Token || isV8Token || isV9OrLater(pkgId)) || !metadataPkg) { showMsg('Metadata update requires V7+ token'); return; }
    const windowClosesAt = curveState?.created_at_ms ? Number(curveState.created_at_ms) + 24 * 60 * 60 * 1000 : 0;
    if (windowClosesAt > 0 && Date.now() >= windowClosesAt) { showMsg('24h window has closed'); return; }
    if (curveState?.metadata_updated === true) { showMsg('Already updated — one time only'); return; }
    setBusy(true); setMsg('');
    try {
      // Fetch CoinMetadata object info via indexer proxy — avoids CORS
      const IURL_CM = import.meta.env.VITE_INDEXER_URL || '';
      let metadataId = null;
      let metaSharedVersion = null;
      if (IURL_CM) {
        try {
          const res = await fetch(`${IURL_CM}/token/${curveId}/metadata-object`, { signal: AbortSignal.timeout(5000) });
          if (res.ok) { const d = await res.json(); metadataId = d.objectId; metaSharedVersion = d.initialSharedVersion; }
        } catch {}
      }
      if (!metadataId) throw new Error('CoinMetadata object not found — indexer may not support this endpoint yet');
      const capId = await getCapId();
      const tx = new Transaction();
      const curveRef = await getCurveRef(tx);
      const metadataRef = metaSharedVersion ? tx.sharedObjectRef({ objectId: metadataId, initialSharedVersion: String(metaSharedVersion), mutable: true }) : tx.object(metadataId);
      tx.moveCall({
        target: `${metadataPkg}::bonding_curve::update_metadata`,
        typeArguments: [tokenType],
        arguments: [tx.object(capId), curveRef, metadataRef, tx.pure.option('string', meta.name.trim() || null), tx.pure.option('string', meta.symbol.trim() || null), tx.pure.option('string', meta.description.trim() || null), tx.pure.option('string', meta.iconUrl.trim() || null), tx.object(SUI_CLOCK_ID)],
      });
      const metaResult = await dAppKit.signAndExecuteTransaction({ transaction: tx });
      if (metaResult.$kind === 'FailedTransaction') throw new Error(metaResult.FailedTransaction.status.error ?? 'Update failed');
      showMsg('Metadata updated on-chain ✅'); setBusy(false); setTimeout(() => window.location.reload(), 1400);
    } catch (e) { showMsg(e.message || 'Update failed'); setBusy(false); }
  };

  return (
    <div className="bg-white/[0.03] border border-lime-400/20 rounded-xl p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <Edit3 size={11} className="text-lime-400/70" />
          <span className="text-[9px] font-mono tracking-widest text-lime-400/70">CREATOR TOOLS</span>
        </div>
        <div className="flex gap-1">
          {['links', ...((METADATA_UPDATE_ENABLED && (isV6Token || isV7Token || isV8Token || isV9OrLater(pkgId))) ? ['metadata'] : [])].map(tabName => (
            <button key={tabName} onClick={() => setTab(tabName)} className={`px-2.5 py-1 rounded-lg text-[9px] font-mono transition-colors ${tab === tabName ? 'bg-lime-400/10 text-lime-400 border border-lime-400/30' : 'text-white/30 hover:text-white/60'}`}>{tabName.toUpperCase()}</button>
          ))}
        </div>
      </div>

      {tab === 'links' && (
        <div className="space-y-2.5">
          <div className="text-[9px] font-mono text-white/25">Update your social links — saved instantly</div>
          <textarea value={links.desc} onChange={e => setLinks(l => ({ ...l, desc: e.target.value }))} placeholder="Token description…" rows={2} className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-white text-xs focus:outline-none focus:border-lime-400/50 transition-colors resize-none" />
          {[{ key: 'twitter', placeholder: 'https://x.com/yourtoken' }, { key: 'telegram', placeholder: 'https://t.me/yourtoken' }, { key: 'website', placeholder: 'https://yourtoken.xyz' }].map(({ key, placeholder }) => (
            <input key={key} value={links[key]} onChange={e => setLinks(l => ({ ...l, [key]: e.target.value }))} placeholder={placeholder} className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-white text-xs focus:outline-none focus:border-lime-400/50 transition-colors" />
          ))}
          <button onClick={handleQueueLinks} disabled={busy} className={`w-full py-2 rounded-lg text-[10px] font-mono font-bold transition-colors ${busy ? 'bg-white/5 text-white/20 cursor-not-allowed' : 'bg-lime-400/10 border border-lime-400/30 text-lime-400 hover:bg-lime-400/20'}`}>{busy ? 'SAVING…' : 'UPDATE LINKS'}</button>
        </div>
      )}

      {METADATA_UPDATE_ENABLED && tab === 'metadata' && (isV6Token || isV7Token || isV8Token || isV9OrLater(pkgId)) && (() => {
        const windowClosesAt = curveState?.created_at_ms ? Number(curveState.created_at_ms) + 24 * 60 * 60 * 1000 : 0;
        const nowMs      = Date.now();
        const windowOpen = windowClosesAt > 0 && nowMs < windowClosesAt;
        const hoursLeft  = windowOpen ? Math.ceil((windowClosesAt - nowMs) / (1000 * 60 * 60)) : 0;
        const alreadyUpdated = isV7Token ? curveState?.metadata_updated === true : JSON.parse(localStorage.getItem(`suipump_meta_${curveId}`) || '{}').used === true;
        return (
          <div className="space-y-2.5">
            {alreadyUpdated ? (
              <div className="rounded-lg bg-white/5 border border-white/10 px-3 py-3 text-[9px] font-mono text-white/40 text-center">✅ Metadata already updated — one-time change used</div>
            ) : !windowOpen ? (
              <div className="rounded-lg bg-white/5 border border-white/10 px-3 py-3 text-[9px] font-mono text-white/40 text-center">🔒 24h update window has closed</div>
            ) : (
              <>
                <div className="flex items-center justify-between">
                  <div className="text-[9px] font-mono text-white/25">{isV7Token ? 'On-chain · one-time only' : 'Instant · one-time only'} · {hoursLeft}h remaining</div>
                  <div className="flex items-center gap-1 text-[9px] font-mono text-lime-400/60"><Clock size={9} />{hoursLeft}h left</div>
                </div>
                {[{ key: 'name', placeholder: 'New token name (optional)' }, { key: 'symbol', placeholder: 'NEW SYMBOL (optional)' }, { key: 'description', placeholder: 'New description (optional)' }].map(({ key, placeholder }) => (
                  <input key={key} value={meta[key]} onChange={e => setMeta(m => ({ ...m, [key]: e.target.value }))} placeholder={placeholder} className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-white text-xs focus:outline-none focus:border-lime-400/50 transition-colors" />
                ))}
                <div className="space-y-1.5">
                  <div className="flex gap-2 items-center">
                    <label className="flex-1 flex items-center gap-2 bg-white/5 border border-white/10 rounded-xl px-3 py-2 cursor-pointer hover:border-lime-400/40 transition-colors">
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-white/40 shrink-0"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
                      <span className="text-xs font-mono text-white/40 truncate">{iconUploading ? 'Uploading…' : meta.iconUrl ? 'Image uploaded ✓' : 'Upload icon image'}</span>
                      <input type="file" accept="image/*" className="hidden" onChange={async (e) => {
                        const file = e.target.files?.[0]; if (!file) return;
                        setIconUploading(true); setIconUploadError(null);
                        try {
                          const fd = new FormData(); fd.append('image', file);
                          const res = await fetch('https://api.imgur.com/3/image', { method: 'POST', headers: { Authorization: 'Client-ID 546c25a59c58ad7' }, body: fd });
                          const json = await res.json();
                          if (!json.success) throw new Error(json.data?.error || 'Upload failed');
                          setMeta(m => ({ ...m, iconUrl: json.data.link }));
                        } catch (err) { setIconUploadError(err.message); } finally { setIconUploading(false); }
                      }} />
                    </label>
                    {meta.iconUrl && <img src={meta.iconUrl} alt="preview" className="w-9 h-9 rounded-lg object-cover border border-white/10" />}
                  </div>
                  {iconUploadError && <div className="text-[9px] font-mono text-red-400">{iconUploadError}</div>}
                  <input value={meta.iconUrl} onChange={e => setMeta(m => ({ ...m, iconUrl: e.target.value }))} placeholder="or paste URL (optional)" className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-white text-xs focus:outline-none focus:border-lime-400/50 transition-colors" />
                </div>
                <button onClick={handleUpdateMetadata} disabled={busy} className={`w-full py-2 rounded-lg text-[10px] font-mono font-bold transition-colors ${busy ? 'bg-white/5 text-white/20 cursor-not-allowed' : 'bg-lime-400 text-black hover:bg-lime-300'}`}>{busy ? 'UPDATING…' : (isV7Token ? 'UPDATE ON-CHAIN' : 'UPDATE NOW (INSTANT)')}</button>
              </>
            )}
          </div>
        );
      })()}


      {msg && <div className={`text-[10px] font-mono text-center ${msg.includes('✅') || msg.includes('🎉') ? 'text-lime-400' : 'text-red-400'}`}>{msg}</div>}
    </div>
  );
}

// ── Trade Panel ───────────────────────────────────────────────────────────────

function TradePanelContent({
  lang, side, setSide, amount, setAmount,
  slippage, setSlippage, quote, txStatus, txMsg,
  account, onExecute, priceSui, priceUsd, suiUsd, symbol, graduated,
  suiBalance, tokenBalance, isCreator, creatorFeesMist,
  curveId: panelCurveId, tokenType: panelTokenType, packageIdHint: panelPkgHint, curveState,
  // curve math for return calculator
  reserveMist, tokensRemaining, vSui, vTok,
}) {
  const dAppKit = useDAppKit();
  const client2 = useCurrentClient();
  const [claiming,       setClaiming]       = useState(false);
  const [claimMsg,       setClaimMsg]       = useState('');
  const [showSlippage,   setShowSlippage]   = useState(false);
  const [customSlippage, setCustomSlippage] = useState('');
  const [showReturnCalc, setShowReturnCalc] = useState(false);
  const isPending  = txStatus === 'pending';
  const pkgId      = resolvePackageId(panelTokenType, panelPkgHint);
  const slippageNum = parseFloat(slippage) || 0;
  const isCustom   = !SLIPPAGE_PRESETS.includes(slippage);

  const handleSlippagePreset = (v) => { setSlippage(v); setCustomSlippage(''); };
  const handleCustomSlippage = (v) => {
    const clean = v.replace(/[^0-9.]/g, '');
    setCustomSlippage(clean);
    const n = parseFloat(clean);
    if (!isNaN(n) && n >= 0 && n <= 50) setSlippage(clean);
  };

  // ── Quick-buy: set amount then immediately fire the trade ─────────────────
  // We need to call executeTrade with the new amount value, not the stale closure.
  // Solution: set amount first, then re-invoke onExecute after React flushes state.
  // onExecute reads `amount` from its parent closure — we bypass this by passing
  // the amount directly via a temporary ref that executeTrade reads on next tick.
  const quickBuyAmountRef = React.useRef(null);

  const handleQuickBuy = useCallback((suiAmt) => {
    if (!account || isPending || !curveState) return;
    quickBuyAmountRef.current = suiAmt;
    setAmount(suiAmt);
    // Give React one tick to propagate the amount state, then fire
    setTimeout(() => {
      onExecute();
      quickBuyAmountRef.current = null;
    }, 30);
  }, [account, isPending, curveState, setAmount, onExecute]);

  const handleClaim = async () => {
    if (!account || !panelCurveId || !panelTokenType || claiming) return;
    setClaiming(true); setClaimMsg('');
    try {
      // Resolve the CreatorCap (normalized, paginated, package-agnostic).
      let capId = null;
      let capPkgId = pkgId;
      {
        const r = await resolveCreatorCap(account.address, panelCurveId, import.meta.env.VITE_INDEXER_URL || '');
        capId = r.capId;
        if (r.capPkgId) capPkgId = r.capPkgId;
      }

      // Get ISV from indexer — avoids getObject CORS issue
      const _IURL = import.meta.env.VITE_INDEXER_URL || '';
      let isv = panelCurveId && _IURL
        ? await fetch(`${_IURL}/token/${panelCurveId}`, { signal: AbortSignal.timeout(3000) })
            .then(r => r.ok ? r.json() : null)
            .then(d => d?.initialSharedVersion ?? d?.initial_shared_version ?? null)
            .catch(() => null)
        : null;

      const tx = new Transaction();
      const curveRef = isv
        ? tx.sharedObjectRef({ objectId: panelCurveId, initialSharedVersion: isv, mutable: true })
        : tx.object(panelCurveId);
      tx.moveCall({
        target: `${capPkgId}::bonding_curve::claim_creator_fees`,
        typeArguments: [panelTokenType],
        arguments: [tx.object(capId), curveRef],
      });
      const feeResult = await dAppKit.signAndExecuteTransaction({ transaction: tx });
      if (feeResult.$kind === 'FailedTransaction') throw new Error(feeResult.FailedTransaction.status.error ?? 'Claim failed');
      setClaimMsg('Fees claimed! 🎉'); setClaiming(false); setTimeout(() => setClaimMsg(''), 3000);
    } catch (err) { setClaimMsg(err.message || 'Claim failed'); setClaiming(false); }
  };

  // ── Return targets (memoized — only recalculate when inputs change) ────────
  const returnTargets = React.useMemo(() => {
    if (!showReturnCalc || side !== 'buy' || !amount || parseFloat(amount) <= 0) return null;
    if (!reserveMist || !tokensRemaining || !vSui || !vTok) return null;
    try {
      const suiInMist = BigInt(Math.floor(parseFloat(amount) * Number(MIST_PER_SUI)));
      return calcReturnTargets(reserveMist, tokensRemaining, suiInMist, vSui, vTok, suiUsd);
    } catch { return null; }
  }, [showReturnCalc, side, amount, reserveMist, tokensRemaining, vSui, vTok, suiUsd]);

  return (
    <div className="bg-white/[0.03] border border-white/10 rounded-xl p-4 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="text-[10px] font-mono text-white/35 tracking-widest">{t(lang, 'trade')}</div>
        <button onClick={() => setShowSlippage(s => !s)} className={`flex items-center gap-1.5 px-2 py-1 rounded-lg text-[10px] font-mono transition-colors ${showSlippage ? 'bg-lime-400/10 border border-lime-400/30 text-lime-400' : 'text-white/35 hover:text-white/60'}`}>
          <Settings size={10} />
          {slippageNum === 0 ? 'NO SLIPPAGE' : `${slippage}% ${t(lang, 'slippage')}`}
        </button>
      </div>

      {/* Slippage panel */}
      {showSlippage && (
        <div className="bg-white/[0.02] border border-white/10 rounded-lg p-3 space-y-2">
          <div className="text-[9px] font-mono text-white/35 tracking-widest">SLIPPAGE TOLERANCE</div>
          <div className="flex gap-1.5">
            {SLIPPAGE_PRESETS.map(v => (
              <button key={v} onClick={() => handleSlippagePreset(v)} className={`flex-1 py-1.5 text-[10px] font-mono rounded-lg border transition-colors ${slippage === v && !isCustom ? 'bg-lime-400/10 border-lime-400/30 text-lime-400' : 'border-white/10 text-white/40 hover:border-white/25 hover:text-white/60'}`}>{v}%</button>
            ))}
            <input type="number" min="0" max="50" step="0.1" value={customSlippage} onChange={e => handleCustomSlippage(e.target.value)} placeholder="—"
              className={`w-14 py-1.5 text-[10px] font-mono rounded-lg border text-center bg-transparent transition-colors ${isCustom ? 'border-lime-400/30 text-lime-400' : 'border-white/10 text-white/40'} focus:outline-none focus:border-lime-400/50`} />
          </div>
        </div>
      )}

      {/* Creator fee claim */}
      {isCreator && (
        <div className="space-y-2 pb-2 border-b border-white/5">
          <div className="flex items-center justify-between">
            <div className="text-[10px] font-mono text-white/35">{t(lang, 'creatorFees')}</div>
            {Number(creatorFeesMist) > 0 && <div className="text-xs font-mono text-lime-400">{fmt(Number(creatorFeesMist) / 1e9, 4)} SUI</div>}
          </div>
          <button onClick={handleClaim} disabled={claiming || Number(creatorFeesMist) === 0} className={`w-full py-2 rounded-lg text-[10px] font-mono font-bold transition-colors ${claiming || Number(creatorFeesMist) === 0 ? 'bg-white/5 text-white/20 cursor-not-allowed' : 'bg-lime-400/10 border border-lime-400/30 text-lime-400 hover:bg-lime-400/20'}`}>{claiming ? 'CLAIMING…' : Number(creatorFeesMist) === 0 ? 'NO FEES YET' : t(lang, 'claimFees')}</button>
          {claimMsg && <div className={`text-[10px] font-mono text-center ${claimMsg.includes('🎉') ? 'text-lime-400' : 'text-red-400'}`}>{claimMsg}</div>}
        </div>
      )}

      {/* Price display */}
      <div className="grid grid-cols-2 gap-2 pt-1 border-t border-white/5">
        <div>
          <div className="text-[10px] font-mono text-white/35 mb-0.5">{t(lang, 'price')}</div>
          <div className="text-white/70 text-xs font-mono">{suiUsd > 0 ? `$${priceUsd.toFixed(6)}` : `${fmt(priceSui, 6)} SUI`}</div>
        </div>
        <div>
          <div className="text-[10px] font-mono text-white/35 mb-0.5">{t(lang, 'inSui')}</div>
          <div className="text-white/50 text-xs font-mono">{fmt(priceSui, 6)} SUI</div>
        </div>
      </div>

      {/* Graduated state */}
      {graduated ? (
        <div className="text-center py-4 text-xs font-mono text-lime-400/70">
          🎓 {t(lang, 'graduationComplete')}
          <a href="https://app.cetus.zone" target="_blank" rel="noreferrer" className="block mt-2 text-lime-400 hover:text-lime-300 underline">{t(lang, 'viewOnCetus')} ↗</a>
        </div>
      ) : (
        <>
          {/* Buy / Sell toggle */}
          <div className="flex rounded-lg overflow-hidden border border-white/10">
            <button onClick={() => setSide('buy')}  className={`flex-1 py-2.5 text-xs font-mono font-bold transition-colors ${side === 'buy'  ? 'bg-lime-400 text-black' : 'text-white/50 hover:text-white/80'}`}>{t(lang, 'buy')}</button>
            <button onClick={() => setSide('sell')} className={`flex-1 py-2.5 text-xs font-mono font-bold transition-colors ${side === 'sell' ? 'bg-red-500 text-white' : 'text-white/50 hover:text-white/80'}`}>{t(lang, 'sell')}</button>
          </div>

          {/* Amount input + preset buttons */}
          <div className="space-y-1.5">
            <div className="text-[10px] font-mono text-white/35">
              {side === 'buy' ? t(lang, 'amount') : `AMOUNT ($${symbol})`}
            </div>
            <div className="flex gap-2">
              <input type="number" min="0" step="any" value={amount} onChange={e => setAmount(e.target.value)}
                placeholder={side === 'buy' ? '0.00' : '0'}
                className="flex-1 bg-white/5 border border-white/10 rounded-lg px-3 py-2.5 text-sm font-mono text-white placeholder-white/20 focus:outline-none focus:border-lime-400/50 focus:bg-lime-400/5 transition-colors" />
              <button onClick={() => {
                if (side === 'buy') { const max = Math.max(0, suiBalance - 0.1); setAmount(max > 0 ? max.toFixed(4) : '0'); }
                else { setAmount(tokenBalance > 1 ? (tokenBalance - 1).toFixed(0) : tokenBalance > 0 ? tokenBalance.toFixed(0) : '0'); }
              }} className="px-3 py-2.5 text-[10px] font-mono text-white/40 hover:text-lime-400 border border-white/10 rounded-lg hover:border-lime-400/30 transition-colors">
                {t(lang, 'max')}
              </button>
            </div>

            {side === 'buy' ? (
              <div className="space-y-1.5">
                {/* Quick-buy label */}
                <div className="flex items-center gap-1 text-[9px] font-mono text-white/20 tracking-widest">
                  <Zap size={8} className="text-lime-400/40" />
                  QUICK BUY — tap to buy instantly
                </div>
                {/* Quick-buy buttons — one click sets amount + fires trade immediately */}
                <div className="flex gap-1.5">
                  {QUICK_BUY_AMOUNTS.map(v => (
                    <button key={v}
                      disabled={!account || isPending || !curveState}
                      onClick={() => handleQuickBuy(v)}
                      className={`flex-1 py-2 text-[11px] font-mono font-bold rounded-lg border transition-all duration-100 ${
                        !account || isPending || !curveState
                          ? 'border-white/5 text-white/15 cursor-not-allowed'
                          : 'border-lime-400/40 text-lime-400 bg-lime-400/5 hover:bg-lime-400/15 hover:border-lime-400 active:scale-95 active:bg-lime-400/25'
                      }`}>
                      {v}
                    </button>
                  ))}
                </div>
                <div className="text-[9px] font-mono text-white/20">Balance: {fmt(suiBalance, 3)} SUI</div>
              </div>
            ) : tokenBalance > 0 ? (
              <div className="space-y-1">
                <div className="flex gap-1.5">
                  {[25, 50, 75, 100].map(pct => (
                    <button key={pct}
                      onClick={() => setAmount(pct === 100 && tokenBalance > 1 ? (tokenBalance - 1).toFixed(0) : ((tokenBalance * pct) / 100).toFixed(0))}
                      className="flex-1 py-1 text-[9px] font-mono text-white/30 hover:text-lime-400 border border-white/10 rounded-md hover:border-lime-400/30 transition-colors">
                      {pct}%
                    </button>
                  ))}
                </div>
                <div className="text-[9px] font-mono text-white/20">Balance: {fmt(tokenBalance, 0)} ${symbol}</div>
              </div>
            ) : (
              <div className="text-[9px] font-mono text-white/20">Balance: 0 ${symbol}</div>
            )}
          </div>

          {/* Quote box */}
          {quote && (
            <div className="bg-white/[0.02] border border-white/5 rounded-lg p-3 space-y-1.5">
              {side === 'buy' ? (
                <>
                  <div className="flex justify-between text-[10px] font-mono">
                    <span className="text-white/35">{t(lang, 'youReceive')} <span className="text-white/20 text-[8px]">(min)</span></span>
                    <span className="text-white">{fmt(Number(quote.tokensOut) * (1 - slippageNum / 100) / 1e6, 0)} ${symbol}</span>
                  </div>
                  <div className="flex justify-between text-[10px] font-mono">
                    <span className="text-white/35">{t(lang, 'priceImpact')}</span>
                    <span className={Number(quote.priceImpact) > 5 ? 'text-red-400' : 'text-white/50'}>{Number(quote.priceImpact).toFixed(2)}%</span>
                  </div>
                </>
              ) : (
                <>
                  <div className="flex justify-between text-[10px] font-mono">
                    <span className="text-white/35">{t(lang, 'youReceive')} <span className="text-white/20 text-[8px]">(min)</span></span>
                    <span className="text-white">{fmt(Number(quote.suiOut) * (1 - slippageNum / 100) / 1e9, 4)} SUI</span>
                  </div>
                  <div className="flex justify-between text-[10px] font-mono">
                    <span className="text-white/35">{t(lang, 'priceImpact')}</span>
                    <span className={Number(quote.priceImpact) > 5 ? 'text-red-400' : 'text-white/50'}>{Number(quote.priceImpact).toFixed(2)}%</span>
                  </div>
                </>
              )}
              <div className="flex justify-between text-[10px] font-mono">
                <span className="text-white/35">{t(lang, 'fee')}</span>
                <span className="text-white/50">1%</span>
              </div>

              {/* Return calculator toggle — buy side only */}
              {side === 'buy' && (
                <button onClick={() => setShowReturnCalc(s => !s)}
                  className="w-full mt-0.5 pt-1.5 border-t border-white/5 text-[9px] font-mono text-white/25 hover:text-lime-400/60 transition-colors flex items-center justify-center gap-1">
                  <Zap size={8} />
                  {showReturnCalc ? 'HIDE RETURN TARGETS' : 'SHOW RETURN TARGETS'}
                </button>
              )}
            </div>
          )}

          {/* Return targets panel */}
          {showReturnCalc && side === 'buy' && (
            <div className="bg-white/[0.02] border border-lime-400/10 rounded-lg p-3 space-y-2">
              <div className="text-[9px] font-mono text-lime-400/50 tracking-widest flex items-center gap-1">
                <Zap size={8} /> RETURN TARGETS
              </div>
              {!returnTargets ? (
                <div className="text-[10px] font-mono text-white/25">Enter a buy amount above to see targets</div>
              ) : (
                <div className="space-y-2">
                  {returnTargets.map(tgt => (
                    <div key={tgt.mult} className="flex items-center justify-between">
                      <span className={`text-[11px] font-mono font-bold ${tgt.mult === 2 ? 'text-lime-400' : tgt.mult === 5 ? 'text-white/80' : 'text-white/60'}`}>
                        {tgt.mult}x
                      </span>
                      {tgt.reachable ? (
                        <div className="text-right text-[10px] font-mono">
                          <span className="text-white/60">
                            {suiUsd > 0 ? `MC ${fmtUsd(tgt.mcapSui, suiUsd)}` : `MC ${fmt(tgt.mcapSui, 0)} SUI`}
                          </span>
                          <span className="text-white/25 ml-2 text-[9px]">
                            @ {fmt(tgt.reserveSui, 0)} SUI raised
                          </span>
                        </div>
                      ) : (
                        <span className="text-[10px] font-mono text-white/20">not reachable before grad</span>
                      )}
                    </div>
                  ))}
                  <div className="text-[8px] font-mono text-white/15 pt-1 border-t border-white/5">
                    sell full position · both fees included · estimate only
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Execute button */}
          <button onClick={onExecute} disabled={!account || isPending || !amount || parseFloat(amount) <= 0}
            className={`w-full py-3 rounded-xl text-sm font-mono font-bold transition-colors ${
              !account || isPending || !amount || parseFloat(amount) <= 0
                ? 'bg-white/5 text-white/20 cursor-not-allowed'
                : side === 'buy' ? 'bg-lime-400 text-black hover:bg-lime-300' : 'bg-red-500 text-white hover:bg-red-400'
            }`}>
            {isPending ? '⏳ …' : !account ? 'Connect wallet' : side === 'buy' ? t(lang, 'buy') : t(lang, 'sell')}
          </button>

          {txStatus && txMsg && (
            <div className={`text-[10px] font-mono text-center py-1 ${txStatus === 'success' ? 'text-lime-400' : txStatus === 'error' ? 'text-red-400' : 'text-white/40'}`}>
              {txMsg}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ── TP/SL Panel ───────────────────────────────────────────────────────────────
// Shown in the right column below the trade panel.
// User sets take-profit and/or stop-loss levels with partial sell %.
// When triggered, fires a sell PTB → Slush wallet signs.

function TPSLPanel({
  account, curveId, tokenType, pkgId,
  priceSui,
  latestOhlcPoint,
  tokenBalance,
  reserveMist, tokensRemaining, vSui, vTok,
  slippage,
  keypair,        // Ed25519Keypair | null — if set, signs autonomously (no Slush popup)
}) {
  const client = useCurrentClient();
  const dAppKit = useDAppKit();

  const [showConfig, setShowConfig]       = useState(false);
  const [entryPrice, setEntryPrice]       = useState('');
  const [pendingLevels, setPendingLevels] = useState([
    { type: 'tp', pct: '100',  sellPct: '50' },
    { type: 'sl', pct: '-20',  sellPct: '100' },
  ]);
  const [ocoLink, setOcoLink]       = useState(false);
  const [triggerMsg, setTriggerMsg] = useState(null);
  const [selling, setSelling]       = useState(false);

  // ── Build and sign the sell PTB ──────────────────────────────────────────
  const executeSell = useCallback(async (sellWholeTokens) => {
    if (!account || !curveId || !tokenType || !pkgId || selling) return;
    if (sellWholeTokens <= 0) return;
    setSelling(true);
    try {
      const tokInAtomic = BigInt(Math.floor(sellWholeTokens * 10 ** TOKEN_DECIMALS));

      // Determine signer address — keypair address or connected wallet
      const signerAddress = keypair
        ? keypair.getPublicKey().toSuiAddress()
        : account.address;

      // Fetch ISV from indexer at sell time — TPSLPanel doesn't have access
      // to initialSharedVersionProp or curveState from the outer TokenPage scope
      let isv = null;
      try {
        const IURL = import.meta.env.VITE_INDEXER_URL || '';
        if (IURL) {
          const isvRes = await fetch(`${IURL}/token/${curveId}`, { signal: AbortSignal.timeout(3000) });
          if (isvRes.ok) {
            const isvData = await isvRes.json();
            isv = isvData.initialSharedVersion ?? isvData.initial_shared_version ?? null;
          }
        }
      } catch { /* fallback to tx.object */ }
      const tx = new Transaction();
      const curveRef = isv
        ? tx.sharedObjectRef({ objectId: curveId, initialSharedVersion: isv, mutable: true })
        : tx.object(curveId);

      // Get token coins owned by the signer — wallet handles this via dAppKit
      const coins = await client.listCoins({ owner: signerAddress, coinType: tokenType });
      if (!coins.objects.length) throw new Error('No token balance in trading wallet');
      const coinObjs = coins.objects.map(c => tx.object(c.objectId));
      if (coinObjs.length > 1) tx.mergeCoins(coinObjs[0], coinObjs.slice(1));
      const [tokenCoin] = tx.splitCoins(coinObjs[0], [tx.pure.u64(tokInAtomic)]);

      const slippageNum = parseFloat(slippage) || 1;
      const sq = sellQuote(reserveMist, tokensRemaining, tokInAtomic, vSui, vTok);
      const minOut = sq?.suiOut != null
        ? BigInt(Math.floor(Number(sq.suiOut) * (1 - slippageNum / 100)))
        : 0n;

      const sellArgs = isV7OrLater(pkgId)
        ? [curveRef, tokenCoin, tx.pure.u64(minOut), tx.pure.option('address', null)]
        : [curveRef, tokenCoin, tx.pure.u64(minOut)];

      const [suiOut] = tx.moveCall({
        target: `${pkgId}::bonding_curve::sell`,
        typeArguments: [tokenType],
        arguments: sellArgs,
      });
      tx.transferObjects([suiOut], signerAddress);

      // ── Autonomous path (keypair) ────────────────────────────────────────
      if (keypair) {
        tx.setSender(signerAddress);
        const autonomousClient = new SuiGraphQLClient({ url: '/api/rpc' });
        const builtTx = await tx.build({ client: autonomousClient });
        const { signature } = await keypair.signTransaction(builtTx);
        const result = await autonomousClient.executeTransaction({
          transaction: builtTx,
          signatures: [signature],
        });
        const success = result?.errors == null;
        setTriggerMsg(m => m ? { ...m, status: success ? 'done' : 'error', digest: result?.data?.executeTransaction?.digest } : m);
        setSelling(false);
        return;
      }

      // ── Slush fallback (no keypair) ──────────────────────────────────────
      const sellResult = await dAppKit.signAndExecuteTransaction({ transaction: tx });
      if (sellResult.$kind === 'FailedTransaction') throw new Error(sellResult.FailedTransaction.status.error ?? 'Sell failed');
      setTriggerMsg(m => m ? { ...m, status: 'done' } : m);
      setSelling(false);
    } catch (err) {
      setTriggerMsg(m => m ? { ...m, status: 'error', error: err.message } : m);
      setSelling(false);
    }
  }, [account, curveId, tokenType, pkgId, selling, client, dAppKit, reserveMist, tokensRemaining, vSui, vTok, slippage, keypair]);

  // ── onTrigger callback passed to useTPSL ────────────────────────────────
  const handleTrigger = useCallback(({ level, currentPriceSui }) => {
    const sellTokens = tokenBalance * (level.sellPct / 100);
    setTriggerMsg({ level, currentPriceSui, status: 'pending', sellTokens });
    executeSell(sellTokens);
  }, [tokenBalance, executeSell]);

  const { config, activate, deactivate, isActive } = useTPSL({
    walletAddress:   account?.address,
    curveId,
    currentPriceSui: priceSui,
    latestOhlcPoint: latestOhlcPoint ?? null,
    onTrigger:       handleTrigger,
  });

  // ── Helpers ──────────────────────────────────────────────────────────────
  const updateLevel = (idx, field, val) => {
    setPendingLevels(prev => prev.map((l, i) => i === idx ? { ...l, [field]: val } : l));
  };
  const addLevel = () => {
    if (pendingLevels.length >= 4) return;
    setPendingLevels(prev => [...prev, { type: 'tp', pct: '200', sellPct: '100' }]);
  };
  const removeLevel = (idx) => {
    setPendingLevels(prev => prev.filter((_, i) => i !== idx));
  };

  const handleActivate = () => {
    const ep = parseFloat(entryPrice) || priceSui;
    if (!ep || ep <= 0) return;
    // OCO group is shared across all levels when linked — first to fire cancels the rest.
    const ocoGroup = ocoLink ? `oco_${Date.now()}` : null;
    const levels = pendingLevels
      .filter(l => l.pct !== '' && l.sellPct !== '')
      .map(l => {
        const pctNum  = parseFloat(l.pct);
        const sellNum = parseFloat(l.sellPct);
        // For trail, the entered % is the drop-from-peak threshold (always positive).
        if (l.type === 'trail') {
          return makeLevel('trail', 0, sellNum, { trailPct: Math.abs(pctNum), ocoGroup });
        }
        return makeLevel(l.type, pctNum, sellNum, { ocoGroup });
      });
    if (!levels.length) return;
    activate(ep, levels);
    setShowConfig(false);
  };

  const pctColor = (type) => type === 'tp' ? 'text-lime-400' : 'text-red-400';
  const pctBorder = (type) => type === 'tp' ? 'border-lime-400/30' : type === 'trail' ? 'border-amber-400/30' : 'border-red-400/30';

  if (!account) return null;

  return (
    <div className="bg-white/[0.03] border border-white/10 rounded-xl overflow-hidden">
      {/* Header */}
      <div className="px-4 py-3 flex items-center justify-between border-b border-white/5">
        <div className="flex items-center gap-2">
          <ShieldAlert size={11} className={isActive ? 'text-lime-400' : 'text-white/30'} />
          <span className="text-[10px] font-mono tracking-widest text-white/35">TP / SL</span>
          {isActive && (
            <span className="flex items-center gap-1 text-[9px] font-mono text-lime-400/70">
              <span className="w-1.5 h-1.5 rounded-full bg-lime-400 animate-pulse inline-block" />
              {keypair ? 'AUTO · NO POPUP' : 'ACTIVE · TAB MUST STAY OPEN'}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {isActive && (
            <button onClick={deactivate}
              className="text-[9px] font-mono text-red-400/60 hover:text-red-400 transition-colors">
              CANCEL
            </button>
          )}
          <button
            onClick={() => setShowConfig(s => !s)}
            className="text-[9px] font-mono text-lime-400/70 hover:text-lime-400 transition-colors"
          >
            {showConfig ? 'CLOSE' : isActive ? 'EDIT' : 'SET UP'}
          </button>
        </div>
      </div>

      {/* Active levels display */}
      {isActive && !showConfig && (
        <div className="px-4 py-3 space-y-2">
          <div className="text-[9px] font-mono text-white/25 mb-1">
            Entry: {config.entryPriceSui?.toFixed(8)} SUI · Now: {priceSui?.toFixed(8)} SUI
          </div>
          {config.peakPrice != null && config.levels?.some(l => l.type === 'trail') && (
            <div className="text-[9px] font-mono text-amber-400/40 -mt-1">Peak: {config.peakPrice.toFixed(8)} SUI</div>
          )}
          {config.levels?.map(level => {
            const changePct = priceSui && config.entryPriceSui
              ? ((priceSui - config.entryPriceSui) / config.entryPriceSui) * 100
              : 0;
            const peak     = config.peakPrice ?? config.entryPriceSui;
            const dropPct  = peak && priceSui ? ((peak - priceSui) / peak) * 100 : 0;
            const accent   = level.type === 'tp' ? 'text-lime-400' : level.type === 'trail' ? 'text-amber-400' : 'text-red-400';
            const barCol   = level.type === 'tp' ? 'bg-lime-400/50' : level.type === 'trail' ? 'bg-amber-400/50' : 'bg-red-400/50';
            const idle     = level.type === 'tp' ? 'border-lime-400/20 bg-lime-950/10' : level.type === 'trail' ? 'border-amber-400/20 bg-amber-950/10' : 'border-red-400/20 bg-red-950/10';
            const inactive = level.triggered || level.cancelled;
            const progress = level.type === 'tp'
              ? Math.min(100, Math.max(0, (changePct / level.pct) * 100))
              : level.type === 'trail'
              ? Math.min(100, Math.max(0, (dropPct / (level.trailPct || 1)) * 100))
              : Math.min(100, Math.max(0, (Math.abs(Math.min(0, changePct)) / Math.abs(level.pct)) * 100));

            return (
              <div key={level.id} className={`rounded-lg border px-3 py-2 space-y-1.5 ${
                inactive ? 'border-white/10 bg-white/[0.02] opacity-50' : idle
              }`}>
                <div className="flex items-center justify-between text-[10px] font-mono">
                  <span className={accent}>
                    {level.type === 'tp' ? `▲ TP +${level.pct}%`
                      : level.type === 'trail' ? `⇲ TRAIL ↓${level.trailPct}%`
                      : `▼ SL ${level.pct}%`}
                    {level.ocoGroup && <span className="text-white/25 ml-1">· OCO</span>}
                  </span>
                  <span className="text-white/40">Sell {level.sellPct}%</span>
                  {level.cancelled && <span className="text-white/25 text-[9px]">CANCELLED</span>}
                  {level.triggered && !level.cancelled && <span className="text-white/25 text-[9px]">TRIGGERED</span>}
                </div>
                {!inactive && (
                  <div className="h-1 bg-white/5 rounded-full overflow-hidden">
                    <div className={`h-full rounded-full transition-all ${barCol}`} style={{ width: `${progress}%` }} />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Trigger notification */}
      {triggerMsg && (
        <div className={`mx-4 mb-3 rounded-lg border px-3 py-2.5 text-[10px] font-mono space-y-1 ${
          triggerMsg.status === 'done'    ? 'border-lime-400/30 bg-lime-950/20' :
          triggerMsg.status === 'error'   ? 'border-red-400/30 bg-red-950/20' :
          'border-white/10 bg-white/[0.02]'
        }`}>
          <div className="flex items-center gap-1.5">
            <Bell size={10} className={triggerMsg.level.type === 'tp' ? 'text-lime-400' : triggerMsg.level.type === 'trail' ? 'text-amber-400' : 'text-red-400'} />
            <span className="text-white/70 font-bold">
              {triggerMsg.level.type === 'tp' ? 'Take-profit' : triggerMsg.level.type === 'trail' ? 'Trailing stop' : 'Stop-loss'} triggered
            </span>
          </div>
          <div className="text-white/40">
            Selling {triggerMsg.sellTokens?.toFixed(0)} tokens ({triggerMsg.level.sellPct}%)
          </div>
          {triggerMsg.status === 'pending' && (
            <div className="text-white/30 animate-pulse">
              {keypair ? 'Auto-executing…' : 'Waiting for wallet signature…'}
            </div>
          )}
          {triggerMsg.status === 'done' && (
            <div className="text-lime-400">Sold successfully ✓</div>
          )}
          {triggerMsg.status === 'error' && (
            <div className="text-red-400">{triggerMsg.error || 'Sell failed'}</div>
          )}
          <button onClick={() => setTriggerMsg(null)}
            className="text-[9px] text-white/20 hover:text-white/50 transition-colors">
            dismiss
          </button>
        </div>
      )}

      {/* Config form */}
      {showConfig && (
        <div className="px-4 py-3 space-y-3">
          {/* Entry price */}
          <div>
            <div className="text-[9px] font-mono text-white/30 tracking-widest mb-1.5">ENTRY PRICE (SUI per token)</div>
            <input
              type="number" step="any" min="0"
              value={entryPrice}
              onChange={e => setEntryPrice(e.target.value)}
              placeholder={priceSui ? priceSui.toFixed(8) : '0.00000000'}
              className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-[11px] font-mono text-white placeholder-white/20 focus:outline-none focus:border-lime-400/40 transition-colors"
            />
            <button
              onClick={() => setEntryPrice(priceSui?.toFixed(8) ?? '')}
              className="mt-1 text-[9px] font-mono text-lime-400/60 hover:text-lime-400 transition-colors"
            >
              use current price
            </button>
          </div>

          {/* Levels */}
          <div className="space-y-2">
            <div className="text-[9px] font-mono text-white/30 tracking-widest">LEVELS</div>
            {pendingLevels.map((level, idx) => (
              <div key={idx} className="flex items-center gap-2">
                {/* TP / SL / TRAIL toggle (cycles) */}
                <button
                  onClick={() => updateLevel(idx, 'type', level.type === 'tp' ? 'sl' : level.type === 'sl' ? 'trail' : 'tp')}
                  className={`w-12 py-1.5 rounded-lg text-[9px] font-mono font-bold border transition-colors flex-shrink-0 ${
                    level.type === 'tp'
                      ? 'border-lime-400/40 text-lime-400 bg-lime-400/5'
                      : level.type === 'trail'
                      ? 'border-amber-400/40 text-amber-400 bg-amber-400/5'
                      : 'border-red-400/40 text-red-400 bg-red-400/5'
                  }`}
                >
                  {level.type === 'tp' ? 'TP' : level.type === 'trail' ? 'TRAIL' : 'SL'}
                </button>
                {/* % trigger */}
                <div className="flex-1 relative">
                  <input
                    type="number" step="1"
                    value={level.pct}
                    onChange={e => updateLevel(idx, 'pct', e.target.value)}
                    placeholder={level.type === 'tp' ? '+100' : level.type === 'trail' ? '15' : '-20'}
                    className={`w-full bg-white/5 border rounded-lg px-2 py-1.5 text-[11px] font-mono text-center focus:outline-none transition-colors ${pctBorder(level.type)} focus:border-lime-400/50`}
                  />
                  <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[8px] font-mono text-white/20">{level.type === 'trail' ? '↓%' : '%'}</span>
                </div>
                {/* Sell % */}
                <div className="flex-1 relative">
                  <input
                    type="number" step="1" min="1" max="100"
                    value={level.sellPct}
                    onChange={e => updateLevel(idx, 'sellPct', e.target.value)}
                    placeholder="100"
                    className="w-full bg-white/5 border border-white/10 rounded-lg px-2 py-1.5 text-[11px] font-mono text-center focus:outline-none focus:border-lime-400/40 transition-colors"
                  />
                  <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[8px] font-mono text-white/20">sell%</span>
                </div>
                {/* Remove */}
                <button onClick={() => removeLevel(idx)}
                  className="text-white/20 hover:text-red-400 transition-colors flex-shrink-0">
                  <Trash2 size={11} />
                </button>
              </div>
            ))}
            {pendingLevels.length < 4 && (
              <button onClick={addLevel}
                className="flex items-center gap-1 text-[9px] font-mono text-white/25 hover:text-lime-400 transition-colors">
                <Plus size={10} /> Add level
              </button>
            )}
          </div>

          {/* OCO toggle */}
          {pendingLevels.length >= 2 && (
            <button
              onClick={() => setOcoLink(v => !v)}
              className={`w-full flex items-center justify-between rounded-lg border px-3 py-2 transition-colors ${
                ocoLink ? 'border-lime-400/40 bg-lime-400/5' : 'border-white/10 hover:border-white/20'
              }`}
            >
              <span className="text-[10px] font-mono text-white/60">
                OCO <span className="text-white/30">— one cancels other</span>
              </span>
              <span className={`w-8 h-4 rounded-full relative transition-colors ${ocoLink ? 'bg-lime-400' : 'bg-white/15'}`}>
                <span className={`absolute top-0.5 w-3 h-3 rounded-full bg-black transition-all ${ocoLink ? 'left-4' : 'left-0.5'}`} />
              </span>
            </button>
          )}

          {/* Helper text */}
          <div className="text-[8px] font-mono text-white/15 leading-relaxed">
            TP = sell when price rises by %. SL = sell when price falls by % (enter negative). TRAIL = sell when price drops ↓% from its peak. OCO = the first level to fire cancels the rest. Sell % = portion of your balance to sell. Tab must stay open.
          </div>

          {/* Activate */}
          <button
            onClick={handleActivate}
            disabled={!pendingLevels.length || !account}
            className={`w-full py-2.5 rounded-lg text-[11px] font-mono font-bold transition-colors ${
              !pendingLevels.length || !account
                ? 'bg-white/5 text-white/20 cursor-not-allowed'
                : 'bg-lime-400 text-black hover:bg-lime-300'
            }`}
          >
            ACTIVATE TP/SL
          </button>
        </div>
      )}

      {/* Empty state */}
      {!isActive && !showConfig && (
        <div className="px-4 py-4 text-center">
          <div className="text-[10px] font-mono text-white/20 mb-1">No active orders</div>
          <div className="text-[9px] font-mono text-white/15">Auto-sell when price hits your targets</div>
        </div>
      )}
    </div>
  );
}

// ── Trades / Holders toggle block ─────────────────────────────────────────────

function TradesHoldersBlock({ curveId, tokenType, suiUsd, lang, creator, trades, connected, loading, symbol }) {
  const [tab, setTab] = useState('trades');
  return (
    <div className="space-y-0">
      <div className="flex bg-white/[0.03] border border-white/10 rounded-t-xl overflow-hidden">
        <button onClick={() => setTab('trades')}  className={`flex-1 py-3 text-xs font-mono font-bold tracking-wider transition-colors ${tab === 'trades'  ? 'text-lime-400 bg-lime-400/5 border-b-2 border-lime-400' : 'text-white/40 hover:text-white/70'}`}>TRADES</button>
        <button onClick={() => setTab('holders')} className={`flex-1 py-3 text-xs font-mono font-bold tracking-wider transition-colors ${tab === 'holders' ? 'text-lime-400 bg-lime-400/5 border-b-2 border-lime-400' : 'text-white/40 hover:text-white/70'}`}>{t(lang, 'holders')}</button>
      </div>
      <div className="[&>div]:rounded-t-none [&>div]:border-t-0">
        {tab === 'trades'
          ? <TradeHistory trades={trades} connected={connected} loading={loading} symbol={symbol} creator={creator} />
          : <HolderList curveId={curveId} tokenType={tokenType} suiUsd={suiUsd} creator={creator} />}
      </div>
    </div>
  );
}

function CommentsBlock({ curveId, packageId, lang, initialSharedVersion = null, tokenType = null }) {
  return (
    <div>
      <div className="text-[10px] font-mono text-white/35 tracking-widest mb-2">{t(lang, 'comments')}</div>
      <Comments curveId={curveId} packageId={packageId} initialSharedVersion={initialSharedVersion} tokenType={tokenType} />
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function TokenPage({ curveId, tokenType, packageId: packageIdHint, initialSharedVersion: initialSharedVersionProp = null, onBack, lang = 'en', tradeKeypair = null, tradeKeyReady = false }) {
  const navigate = useNavigate();
  const account  = useCurrentAccount();
  const client   = useCurrentClient();
  const dAppKit  = useDAppKit();

  // ── Shared SSE feed — one connection for chart + trades ──────────────────
  // Must be declared before any hook that consumes feedOhlc/feedTrades
  const { trades: feedTrades, ohlc: feedOhlc, loading: feedLoading, connected: feedConnected } = useTokenPageFeed(curveId, packageIdHint);

  const [suiUsd,          setSuiUsd]          = useState(0);
  const [curveState,      setCurveState]      = useState(null);
  const [metadata,        setMetadata]        = useState(null);
  const [iconUrl,         setIconUrl]         = useState(null);
  const [curveCreatedData, setCurveCreatedData] = useState(null);
  const [suiBalance,      setSuiBalance]      = useState(0);
  const [tokenBalance,    setTokenBalance]    = useState(0);
  const [side,            setSide]            = useState('buy');
  const [amount,          setAmount]          = useState('');
  const [slippage,        setSlippage]        = useState('1');
  const [txStatus,        setTxStatus]        = useState(null);
  const [txMsg,           setTxMsg]           = useState('');
  const [copied,          setCopied]          = useState(false);
  const [shared,          setShared]          = useState(false);
  const [linkCopied,      setLinkCopied]      = useState(false);

  // ── data loading ──────────────────────────────────────────────────────────

  useEffect(() => {
    fetchSuiUsd().then(setSuiUsd);
    const timer = setInterval(() => fetchSuiUsd().then(setSuiUsd), 30_000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!curveId) return;
    const IURL = import.meta.env.VITE_INDEXER_URL || '';
    if (!IURL) return;
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch(`${IURL}/token/${curveId}`, { signal: AbortSignal.timeout(5000) });
        if (res.ok && !cancelled) {
          const d = await res.json();
          // Map indexer response to curve state field names expected by component
          // Handle both camelCase (getAllCurves alias) and snake_case (raw SELECT c.*)
          const stats = d.stats ?? {};
          setCurveState(prev => ({
            sui_reserve:            String(stats.reserve_sui != null ? Math.round(stats.reserve_sui * 1e9) : (d.suiReserve ?? d.sui_reserve ?? 0)),
            token_reserve:          String(stats.token_reserve != null ? Math.round(stats.token_reserve * 1e6) : (d.tokenReserve ?? d.token_reserve ?? String(800_000_000 * 1e6))),
            graduated:              d.graduated ?? false,
            creator_fees:           prev?.creator_fees ?? '0', // preserved — on-chain fetch owns this field; do NOT reset to 0 each poll
            creator:                d.creator ?? null,
            initial_shared_version: d.initialSharedVersion ?? d.initial_shared_version ?? null,
            metadata_updated:       d.metadataUpdated ?? d.metadata_updated ?? false,
            created_at_ms:          d.createdAt ?? d.created_at ?? null,
            package_id:             d.packageId ?? d.package_id ?? null,
          }));
        }
      } catch {}
    }
    load();
    const timer = setInterval(load, 10_000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [curveId]);

  // ── Fetch real on-chain creator_fees — indexer estimate is stale after claims ──
  useEffect(() => {
    if (!curveId || !client) return;
    let cancelled = false;
    async function fetchOnChainFees() {
      try {
        // Direct fetch — client.graphql() silently fails for some queries
        const gql = `{ object(address: "${curveId}") { asMoveObject { contents { json } } } }`;
        const r = await fetch('https://graphql.testnet.sui.io/graphql', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: gql }),
          signal: AbortSignal.timeout(8000),
        });
        const result = await r.json();
        const json = result?.data?.object?.asMoveObject?.contents?.json;
        if (json && json.creator_fees != null && !cancelled) {
          const feeMist = typeof json.creator_fees === 'object'
            ? String(json.creator_fees?.value ?? 0)
            : String(json.creator_fees ?? 0);
          setCurveState(prev => prev ? { ...prev, creator_fees: feeMist } : prev);
        }
      } catch {}
    }
    fetchOnChainFees();
    // Refresh every 15s and after any tx (via curveId dependency)
    const t = setInterval(fetchOnChainFees, 15_000);
    return () => { cancelled = true; clearInterval(t); };
  }, [curveId, client]);

  useEffect(() => {
    if (!tokenType) return;
    let cancelled = false;
    // Load metadata from indexer — avoids CORS on graphql.testnet.sui.io
    const IURL_META = import.meta.env.VITE_INDEXER_URL || '';
    if (IURL_META) {
      fetch(`${IURL_META}/token/${curveId}`, { signal: AbortSignal.timeout(5000) })
        .then(r => r.ok ? r.json() : null)
        .then(d => {
          if (!d || cancelled) return;
          // /token/:curveId returns snake_case from raw SELECT c.* 
          const icon = d.iconUrl || d.icon_url || null;
          const m = { name: d.name, symbol: d.symbol, description: d.description, iconUrl: icon };
          setMetadata(m);
          if (icon && !isPlaceholderIcon(icon)) setIconUrl(icon);
        }).catch(() => {});
    }
    (async () => {
      try {
        const packageIds = ALL_PACKAGE_IDS.filter(Boolean).filter((v, i, a) => a.indexOf(v) === i);
        let found = null;
        for (const pid of packageIds) {
          if (found) break;
          let cursor = null;
          for (let page = 0; page < 10 && !found; page++) {
            const res = { data: [], nextCursor: null, hasNextPage: false }; // queryEvents removed; CurveCreated data comes from indexer
            found = null; // queryEvents removed; curve data comes from indexer
            if (!res.hasNextPage) break;
            cursor = res.nextCursor;
          }
        }
        if (found?.parsedJson && !cancelled) setCurveCreatedData(found.parsedJson);
      } catch {}
    })();
    return () => { cancelled = true; };
  }, [tokenType, client, curveId]);

  useEffect(() => {
    if (!account || !client) return;
    let cancelled = false;
    async function loadBalances() {
      try {
        const sui = await client.getBalance({ owner: account.address, coinType: '0x2::sui::SUI' });
        if (!cancelled) setSuiBalance(Number(sui.balance?.balance ?? '0') / 1e9);
        if (tokenType) {
          const tok = await client.getBalance({ owner: account.address, coinType: tokenType });
          if (!cancelled) setTokenBalance(Number(tok.balance?.balance ?? '0') / 10 ** TOKEN_DECIMALS);
        }
      } catch {}
    }
    loadBalances();
    const timer = setInterval(loadBalances, 15_000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [account, client, tokenType]);

  // Fresh reserves fetched on amount change for accurate quote display
  const [freshReserveMist,     setFreshReserveMist]     = React.useState(null);
  const [freshTokensRemaining, setFreshTokensRemaining] = React.useState(null);

  // Debounced fetch — runs 300ms after amount changes
  React.useEffect(() => {
    if (!amount || !curveId) return;
    const IURL = import.meta.env.VITE_INDEXER_URL || '';
    if (!IURL) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const r = await fetch(`${IURL}/token/${curveId}/stats`, { signal: AbortSignal.timeout(2000) });
        if (r.ok && !cancelled) {
          const d = await r.json();
          if (d.reserve_sui   != null) setFreshReserveMist(BigInt(Math.round(d.reserve_sui * 1e9)));
          if (d.token_reserve != null) setFreshTokensRemaining(BigInt(Math.round(d.token_reserve * 1e6)));
        }
      } catch {}
    }, 300);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [amount, curveId]);

  // ── derived state ─────────────────────────────────────────────────────────

  const pkgId    = resolvePackageId(tokenType, packageIdHint ?? curveState?.package_id ?? null);
  // Use curveShapeFor() — single source of truth for all virtual reserve values.
  // Previously used inline ternary chains which could silently fall through to
  // wrong defaults, causing the displayed quote to differ from the executed tx.
  const { virtualSui: vSui, virtualTokens: vTok, drainSui } = curveShapeFor(pkgId);

  // Fresh reserves override stale curveState for quote accuracy
  const reserveMist     = freshReserveMist     ?? (curveState ? BigInt(curveState.sui_reserve)   : 0n);
  const tokensRemaining = freshTokensRemaining ?? (curveState ? BigInt(curveState.token_reserve) : 0n);
  const tokensSold      = BigInt(800_000_000) * 10n ** BigInt(TOKEN_DECIMALS) - tokensRemaining;
  const progress        = Math.min(100, (mistToSui(reserveMist) / drainSui) * 100);
  const priceMist       = curveState ? priceMistPerToken(reserveMist, tokensSold, vSui, vTok) : 0n;
  const priceSui        = Number(priceMist) / 1e9;
  const priceUsd        = priceSui * suiUsd;
  // Pump.fun-style mcap using constant-product curve price × total supply.
  // Formula: price = (vSui + realSui)² / (vSui * vTok)
  //          mcap  = price * TOTAL_SUPPLY
  // Gives ~$4.4K at launch → ~$66K at graduation = 15x ✓
  const _realSui    = Number(reserveMist) / 1e9;
  const _k          = vSui * vTok;
  const _priceSui   = _k > 0 ? (vSui + _realSui) * (vSui + _realSui) / _k : 0;
  const marketCapSui = _priceSui * TOTAL_SUPPLY_WHOLE;
  const graduated       = curveState?.graduated ?? false;
  const creatorFeesMist = curveState ? BigInt(curveState.creator_fees ?? 0) : 0n;
  const creatorAddr     = curveState?.creator ?? null;

  const _metaOverride  = (() => { try { return JSON.parse(localStorage.getItem(`suipump_meta_${curveId}`)  || '{}'); } catch { return {}; } })();
  const _linksOverride = (() => { try { return JSON.parse(localStorage.getItem(`suipump_links_${curveId}`) || '{}'); } catch { return {}; } })();

  const name   = _metaOverride.name   || curveCreatedData?.name   || metadata?.name   || '';
  const symbol = _metaOverride.symbol || curveCreatedData?.symbol || metadata?.symbol || '';
  const _rawDesc = (_metaOverride.description || _linksOverride.desc || metadata?.description || '').trim();
  const rawDesc  = isPlaceholderDesc(_rawDesc) ? '' : _rawDesc;
  const _parsed  = parseDescription(rawDesc);
  const desc     = _parsed.desc;
  const twitter  = _linksOverride.twitter  || _parsed.twitter;
  const telegram = _linksOverride.telegram || _parsed.telegram;
  const website  = _linksOverride.website  || _parsed.website;
  const dex      = _linksOverride.dex      || _parsed.dex;
  const _overrideIcon = _metaOverride.iconUrl || null;

  const [isCreator, setIsCreator] = React.useState(false);
  // isCreator: true when wallet address matches the curve's creator field.
  // This is fast, reliable, and doesn't require a GQL call.
  // curveState.creator is loaded from the indexer on mount.
  React.useEffect(() => {
    if (!account?.address) { setIsCreator(false); return; }
    if (curveState?.creator) {
      setIsCreator(curveState.creator.toLowerCase() === account.address.toLowerCase());
    } else {
      setIsCreator(false);
    }
  }, [account?.address, curveState?.creator]);

  // ── actions ───────────────────────────────────────────────────────────────

  const handleCopy = () => { if (curveId) { navigator.clipboard.writeText(curveId); setCopied(true); setTimeout(() => setCopied(false), 1500); } };
  const handleShare = () => {
    const url = `${window.location.origin}/token/${curveId}`;
    if (navigator.share) { navigator.share({ title: `${name} ($${symbol}) on SuiPump`, url }); } else { navigator.clipboard.writeText(url); }
    setShared(true); setTimeout(() => setShared(false), 1500);
  };
  const handleCopyLink = () => { navigator.clipboard.writeText(`${window.location.origin}/token/${curveId}`); setLinkCopied(true); setTimeout(() => setLinkCopied(false), 1500); };

  const quoteTrade = useCallback(() => {
    if (!amount || parseFloat(amount) <= 0 || !curveState) return null;
    try {
      if (side === 'buy') {
        const suiIn = BigInt(Math.floor(parseFloat(amount) * Number(MIST_PER_SUI)));
        return buyQuote(reserveMist, tokensRemaining, suiIn, vSui, vTok);
      } else {
        const tokIn = BigInt(Math.floor(parseFloat(amount) * 10 ** TOKEN_DECIMALS));
        return sellQuote(reserveMist, tokensRemaining, tokIn, vSui, vTok);
      }
    } catch { return null; }
  }, [amount, side, curveState, reserveMist, tokensRemaining, vSui, vTok]);

  const executeTrade = useCallback(async () => {
    if (!account || !curveState || !curveId || !tokenType) return;
    // Read amount from state (may have been set by quick-buy just before this fires)
    const amtFloat = parseFloat(amount);
    if (!amtFloat || amtFloat <= 0) return;
    if (!pkgId) return;

    setTxStatus('pending');
    setTxMsg('');

    try {
      const initialSharedVersion = initialSharedVersionProp ?? curveState?.initial_shared_version ?? null;
      const tx = new Transaction();
      const curveRef = initialSharedVersion
        ? tx.sharedObjectRef({ objectId: curveId, initialSharedVersion, mutable: true })
        : tx.object(curveId);

      const slippageNum = parseFloat(slippage) || 0;
      const isV5 = isV5OrLater(pkgId);

      if (side === 'buy') {
        const suiInMist = BigInt(Math.floor(amtFloat * Number(MIST_PER_SUI)));

        // ── Fresh reserve fetch — avoid stale-state slippage aborts ──────────
        // The curveState in component state can be seconds old. Large buys on
        // active curves fail with E_SLIPPAGE_EXCEEDED (abort 3) if the reserve
        // moved since the last SSE update. Fetch fresh stats right before quoting.
        let freshReserveMist = reserveMist;
        let freshTokensRemaining = tokensRemaining;
        try {
          const IURL = import.meta.env.VITE_INDEXER_URL || '';
          if (IURL) {
            const fr = await fetch(`${IURL}/token/${curveId}/stats`, { signal: AbortSignal.timeout(3000) });
            if (fr.ok) {
              const fs = await fr.json();
              if (fs.reserve_sui != null) freshReserveMist = BigInt(Math.round(fs.reserve_sui * 1e9));
              if (fs.token_reserve != null) freshTokensRemaining = BigInt(Math.round(fs.token_reserve));
            }
          }
        } catch { /* fallback to cached state */ }

        const [payment] = tx.splitCoins(tx.gas, [tx.pure.u64(suiInMist)]);
        const bq = buyQuote(freshReserveMist, freshTokensRemaining, suiInMist, vSui, vTok);

        // Auto-bump effective slippage if price impact exceeds user's setting.
        // Prevents E_SLIPPAGE_EXCEEDED on high-impact buys without forcing user
        // to manually raise slippage every time.
        const impactPct = bq?.priceImpact ?? 0;
        const effectiveSlippage = Math.max(slippageNum, impactPct > 5 ? impactPct + 3 : slippageNum);
        const minOut = bq?.tokensOut != null ? BigInt(Math.floor(Number(bq.tokensOut) * (1 - effectiveSlippage / 100))) : 0n;
        // V9: buy(curve, payment, min_out, referral, sui_price_scaled, clock)
        // Fetch live SUI price for oracle; pass 0 as fallback if unavailable
        let suiPriceScaled = 0n;
        try {
          const priceRes = await fetch(
            'https://api.binance.com/api/v3/ticker/price?symbol=SUIUSDT',
            { signal: AbortSignal.timeout(2000) }
          );
          if (priceRes.ok) {
            const priceData = await priceRes.json();
            const priceUsd = parseFloat(priceData.price ?? '0');
            if (priceUsd > 0) suiPriceScaled = BigInt(Math.floor(priceUsd * 1000));
          }
        } catch { /* fallback: 0 triggers stored/BASE_GRAD threshold */ }
        const isV9 = isV9OrLater(pkgId);
        const buyArgs = isV9
          ? [curveRef, payment, tx.pure.u64(minOut), tx.pure.option('address', null), tx.pure.u64(suiPriceScaled), tx.object(SUI_CLOCK_ID)]
          : isV5
          ? [curveRef, payment, tx.pure.u64(minOut), tx.pure.option('address', null), tx.object(SUI_CLOCK_ID)]
          : [curveRef, payment, tx.pure.u64(minOut)];
        const [tokens, refund] = tx.moveCall({ target: `${pkgId}::bonding_curve::buy`, typeArguments: [tokenType], arguments: buyArgs });
        tx.transferObjects([tokens, refund], account.address);
      } else {
        const tokInAtomic = BigInt(Math.floor(amtFloat * 10 ** TOKEN_DECIMALS));
        const coins = await client.listCoins({ owner: account.address, coinType: tokenType });
        const coinObjs = coins.objects.map(c => tx.object(c.objectId));
        let tokenCoin;
        if (!coinObjs.length) throw new Error('No token balance');
        if (coinObjs.length === 1) { [tokenCoin] = tx.splitCoins(coinObjs[0], [tx.pure.u64(tokInAtomic)]); }
        else { tx.mergeCoins(coinObjs[0], coinObjs.slice(1)); [tokenCoin] = tx.splitCoins(coinObjs[0], [tx.pure.u64(tokInAtomic)]); }
        const sq = sellQuote(reserveMist, tokensRemaining, tokInAtomic, vSui, vTok);
        const minOut = sq?.suiOut != null ? BigInt(Math.floor(Number(sq.suiOut) * (1 - slippageNum / 100))) : 0n;
        const sellArgs = isV7OrLater(pkgId)
          ? [curveRef, tokenCoin, tx.pure.u64(minOut), tx.pure.option('address', null)]
          : [curveRef, tokenCoin, tx.pure.u64(minOut)];
        const [suiOut] = tx.moveCall({ target: `${pkgId}::bonding_curve::sell`, typeArguments: [tokenType], arguments: sellArgs });
        tx.transferObjects([suiOut], account.address);
      }

      const tradeResult = await dAppKit.signAndExecuteTransaction({ transaction: tx });
      if (tradeResult.$kind === 'FailedTransaction') throw new Error(tradeResult.FailedTransaction.status.error ?? 'Transaction failed');
      setTxStatus('success'); setTxMsg(side === 'buy' ? 'Buy successful! 🎉' : 'Sell successful!'); setAmount('');
      setTimeout(() => { setTxStatus(null); setTxMsg(''); }, 3000);
    } catch (err) {
      setTxStatus('error'); setTxMsg(err.message || 'Transaction failed');
      setTimeout(() => { setTxStatus(null); setTxMsg(''); }, 4000);
    }
  }, [account, curveState, curveId, tokenType, side, amount, slippage, client, dAppKit, reserveMist, tokensRemaining, pkgId, vSui, vTok]);

  const quote = quoteTrade();
  const scrollToTop = () => window.scrollTo({ top: 0, behavior: 'smooth' });

  // Shared props for both mobile and desktop trade panel instances
  const tradePanelProps = {
    lang, side, setSide, amount, setAmount, slippage, setSlippage,
    quote, txStatus, txMsg, account, onExecute: executeTrade,
    priceSui, priceUsd, suiUsd, symbol, graduated,
    suiBalance, tokenBalance, isCreator, creatorFeesMist,
    curveId, tokenType, packageIdHint: pkgId, curveState,
    reserveMist, tokensRemaining, vSui, vTok,
  };

  // ── render ────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen" style={{ fontFamily: "'JetBrains Mono', ui-monospace, monospace" }}>
      <button onClick={onBack || (() => navigate('/'))} className="flex items-center gap-2 text-white/50 hover:text-lime-400 transition-colors text-xs font-mono mb-4 group">
        <ArrowLeft size={14} className="group-hover:-translate-x-0.5 transition-transform" />
        {t(lang, 'backToHome')}
      </button>

      {graduated && (
        <div className="mb-4 px-4 py-3 bg-lime-400/10 border border-lime-400/30 rounded-xl text-xs font-mono text-lime-400 flex items-center justify-between">
          <span>🎓 {t(lang, 'graduationComplete')}</span>
          <a href="https://app.cetus.zone" target="_blank" rel="noreferrer" className="flex items-center gap-1 text-lime-400 hover:text-lime-300 underline">{t(lang, 'viewOnCetus')} <ExternalLink size={10} /></a>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-4">
        {/* Left column */}
        <div className="space-y-4">
          {/* Token header */}
          <div className="bg-white/[0.03] border border-white/10 rounded-xl p-4">
            <div className="flex items-start gap-3">
              <div className="w-12 h-12 rounded-xl overflow-hidden flex-shrink-0 bg-white/5 flex items-center justify-center text-xl">
                {(_overrideIcon || iconUrl) ? <img src={_overrideIcon || iconUrl} alt={symbol} className="w-full h-full object-cover" onError={e => { e.target.style.display='none'; e.target.nextSibling.style.display='flex'; }} /> : null}
                <span style={{ display: (_overrideIcon || iconUrl) ? 'none' : 'flex' }} className="text-2xl items-center justify-center w-full h-full">🔥</span>
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <h1 className="text-white font-bold text-lg">{name}</h1>
                  <span className="text-lime-400 text-sm font-mono">${symbol}</span>
                </div>
                <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
                  <span className="text-white/35 text-[10px] font-mono truncate max-w-[180px]">{curveId ? `${curveId.slice(0, 6)}...${curveId.slice(-4)}` : ''}</span>
                  <button onClick={handleCopy} className="text-white/35 hover:text-lime-400 transition-colors flex items-center gap-1 text-[10px] font-mono">{copied ? <Check size={10} /> : <Copy size={10} />}{copied ? t(lang, 'copied') : t(lang, 'copyCA')}</button>
                  <button onClick={handleShare} className="text-white/35 hover:text-lime-400 transition-colors flex items-center gap-1 text-[10px] font-mono"><svg width="9" height="9" viewBox="0 0 24 24" fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>{shared ? t(lang, 'share') + '!' : t(lang, 'share')}</button>
                  <button onClick={handleCopyLink} className="text-white/35 hover:text-lime-400 transition-colors flex items-center gap-1 text-[10px] font-mono">{linkCopied ? <Check size={10} /> : <Share2 size={10} />}{linkCopied ? 'COPIED!' : 'SHARE LINK'}</button>
                </div>
                <div className="flex items-center gap-3 mt-1.5 flex-wrap">
                  {twitter  && <a href={twitter.startsWith('http')  ? twitter  : `https://${twitter}`}  target="_blank" rel="noreferrer" className="flex items-center gap-1 text-[10px] font-mono text-white/35 hover:text-lime-400 transition-colors"><svg width="9" height="9" viewBox="0 0 24 24" fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>Twitter</a>}
                  {telegram && <a href={telegram.startsWith('http') ? telegram : `https://${telegram}`} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-[10px] font-mono text-white/35 hover:text-lime-400 transition-colors"><ExternalLink size={9} /> Telegram</a>}
                  {website  && <a href={website.startsWith('http')  ? website  : `https://${website}`}  target="_blank" rel="noreferrer" className="flex items-center gap-1 text-[10px] font-mono text-white/35 hover:text-lime-400 transition-colors"><ExternalLink size={9} /> Website</a>}
                </div>
              </div>
              <div className="text-right shrink-0">
                <div className="text-white text-sm font-mono font-bold">{suiUsd > 0 ? `$${priceUsd.toFixed(6)}` : `${fmt(priceSui, 6)} SUI`}</div>
                <div className="text-white/35 text-[10px] font-mono">{t(lang, 'price')}</div>
                <div className="text-white/70 text-xs font-mono mt-1">{suiUsd > 0 ? fmtUsd(marketCapSui, suiUsd) : `${fmt(marketCapSui)} SUI`}</div>
                <div className="text-white/35 text-[10px] font-mono">{t(lang, 'mcap')}</div>
              </div>
            </div>
            {desc && <p className="mt-3 text-xs font-mono text-white/40 leading-relaxed">{desc}</p>}
            <div className="mt-4">
              <div className="flex justify-between text-[10px] font-mono text-white/35 mb-1.5">
                <span>{t(lang, 'bondingCurveProgress')}</span>
                <span className="text-lime-400">{progress.toFixed(1)}%</span>
              </div>
              <div className="h-2 bg-white/5 rounded-full overflow-hidden">
                <div className="h-full bg-gradient-to-r from-lime-600 to-lime-400 rounded-full transition-all duration-500" style={{ width: `${progress}%` }} />
              </div>
              <div className="flex items-center justify-between text-[10px] font-mono text-white/25 mt-1">
                <span>{fmt(mistToSui(reserveMist))} {t(lang, 'suiRaised')}</span>
                <span>{fmt(drainSui)} {t(lang, 'suiTarget')}</span>
              </div>
            </div>
            {!graduated && (
              <div className="mt-3 flex items-center gap-1.5">
                <span className="text-[8px] font-mono text-white/20 tracking-widest">GRADUATES TO</span>
                <span className={`text-[9px] font-mono px-2 py-0.5 rounded-full border ${dex === 'deepbook' ? 'border-blue-400/30 text-blue-400/70 bg-blue-400/5' : dex === 'turbos' ? 'border-purple-400/30 text-purple-400/70 bg-purple-400/5' : 'border-lime-400/30 text-lime-400/70 bg-lime-400/5'}`}>
                  {dex === 'deepbook' ? '⚡ DeepBook' : dex === 'turbos' ? '🔄 Turbos' : '🌊 Cetus'}
                </span>
              </div>
            )}
          </div>

          <PriceChart ohlc={feedOhlc} connected={feedConnected} suiUsd={suiUsd} loading={feedLoading} />
          <AIAnalysis curveId={curveId} tokenType={tokenType} name={name} symbol={symbol} progress={progress} reserveSui={mistToSui(reserveMist)} creatorFeesSui={Number(creatorFeesMist) / 1e9} graduated={graduated} tokensSoldWhole={Number(tokensSold) / 10 ** TOKEN_DECIMALS} />

          <div className="lg:hidden"><TradePanelContent {...tradePanelProps} /></div>

          <TradesHoldersBlock curveId={curveId} tokenType={tokenType} suiUsd={suiUsd} lang={lang} creator={creatorAddr} trades={feedTrades} connected={feedConnected} loading={feedLoading} symbol={symbol} />
          <CommentsBlock curveId={curveId} packageId={pkgId} lang={lang} initialSharedVersion={initialSharedVersionProp ?? curveState?.initial_shared_version ?? null} tokenType={tokenType} />
          {isCreator && (
            <div className="lg:hidden">
              <CreatorToolsPanel curveId={curveId} tokenType={tokenType} packageIdHint={pkgId} account={account} curveState={curveState} currentDesc={desc} currentTwitter={twitter} currentTelegram={telegram} currentWebsite={website} currentDex={dex} lang={lang} />
            </div>
          )}
        </div>

        {/* Right column */}
        <div className="hidden lg:block space-y-4">
          <TradePanelContent {...tradePanelProps} />
          <TPSLPanel
            account={account}
            curveId={curveId}
            tokenType={tokenType}
            pkgId={pkgId}
            priceSui={priceSui}
            latestOhlcPoint={feedOhlc.length > 0 ? feedOhlc[feedOhlc.length - 1] : null}
            tokenBalance={tokenBalance}
            reserveMist={reserveMist}
            tokensRemaining={tokensRemaining}
            vSui={vSui}
            vTok={vTok}
            slippage={slippage}
            keypair={tradeKeyReady ? tradeKeypair : null}
          />
          <VestingPanel curveId={curveId} tokenType={tokenType} packageId={pkgId} account={account} tokenBalance={tokenBalance} lang={lang} initialSharedVersion={curveState?.initial_shared_version ?? null} />
          {isCreator && (
            <CreatorToolsPanel curveId={curveId} tokenType={tokenType} packageIdHint={pkgId} account={account} curveState={curveState} currentDesc={desc} currentTwitter={twitter} currentTelegram={telegram} currentWebsite={website} currentDex={dex} lang={lang} />
          )}
        </div>
      </div>

      <div className="sm:hidden fixed bottom-6 right-4 z-50">
        <button onClick={scrollToTop} className="bg-white/10 hover:bg-white/20 border border-white/20 rounded-full p-3 text-white/60 hover:text-white transition-colors backdrop-blur-sm">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="18 15 12 9 6 15"/></svg>
        </button>
      </div>
    </div>
  );
}
