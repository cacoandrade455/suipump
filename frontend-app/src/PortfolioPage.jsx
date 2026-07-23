// v19-terminal-2e
// PortfolioPage.jsx
import React, { useState, useEffect, useMemo } from 'react';
import { useCurrentAccount, useDAppKit, useCurrentClient } from '@mysten/dapp-kit-react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { useTokenList } from './useTokenList.js';
import { priceMistPerToken, mistToSui } from './curve.js';
import { Transaction } from '@mysten/sui/transactions';
import { SuiGraphQLClient } from '@mysten/sui/graphql';
import { TOKEN_DECIMALS, DRAIN_SUI_APPROX, ALL_PACKAGE_IDS } from './constants.js';
import { paginateMultipleEvents } from './paginateEvents.js';
import { useSessionPositions, sellSessionPosition } from './useSessionPositions.js';
import { t } from './i18n.js';
import { executeTx } from './lib/executeTx.js';
import { ReferralLinkCard } from './ReferralsPage.jsx';

const MIST_PER_SUI = 1e9;
const INDEXER_URL = import.meta.env.VITE_INDEXER_URL || '';

function fmt(n, d = 2) {
  if (n == null) return '-';
  if (!Number.isFinite(n) || n === 0) return '0';
  if (n >= 1e6) return (n / 1e6).toFixed(d) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(d) + 'k';
  return n.toFixed(d);
}

function fmtPnl(n, d = 3) {
  if (n == null || !Number.isFinite(n)) return '-';
  const abs = Math.abs(n);
  const str = abs >= 1e3 ? (abs/1e3).toFixed(1) + 'k' : abs.toFixed(d);
  return (n >= 0 ? '+' : '-') + str + ' SUI';
}

// Compact integer with thousands separators (ASCII only).
function fmtInt(n) {
  if (n == null || !Number.isFinite(n)) return '-';
  return Math.round(n).toLocaleString('en-US');
}

// Two-char identicon initials from an address (the "7b" tile in the design).
function initialsOf(addr) {
  const s = String(addr ?? '');
  const hex = s.startsWith('0x') ? s.slice(2) : s;
  return (hex.slice(0, 2) || '??').toLowerCase();
}

function TokenRow({ token, iconUrl, right, onClick }) {
  return (
    <button
      onClick={onClick}
      className="w-full flex items-center gap-3 px-5 py-4 border-b border-white/[0.03] last:border-0 hover:bg-white/5 transition-colors group text-left"
    >
      <div className="w-9 h-9 rounded-full border border-white/10 overflow-hidden flex items-center justify-center bg-lime-950/30 shrink-0 group-hover:border-lime-400/30 transition-colors">
        {iconUrl
          ? <img src={iconUrl} alt={token.symbol} className="w-full h-full object-cover"
              onError={e => { e.target.style.display = 'none'; e.target.nextSibling.style.display = 'block'; }} />
          : null}
        <span className="text-base" style={{ display: iconUrl ? 'none' : 'block' }}>🔥</span>
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-xs font-mono font-bold text-white truncate group-hover:text-lime-400 transition-colors">
          {token.name || 'Unknown'}
        </div>
        <div className="text-[10px] font-mono text-white/30">${token.symbol || '???'}</div>
      </div>
      {right}
    </button>
  );
}

// -- Canvas PnL card helpers ---------------------------------------------------

function drawMascotOnCanvas(ctx, img, x, y, size) {
  if (!img) return;
  ctx.save();
  ctx.drawImage(img, x, y, size, size);
  ctx.restore();
}

function drawPnlCard({ canvas, name, symbol, pnlSui, pnlPct, spent, entryPrice, currentPrice, isClosed }) {
  const W = 900, H = 480;
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  const isUp = pnlSui >= 0;
  const pnlColor = isUp ? '#a3e635' : '#ef4444';
  const bgColor1 = isUp ? '#050f02' : '#0f0202';
  const bgColor2 = isUp ? '#0a1f04' : '#1a0404';

  // Background
  const bg = ctx.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, bgColor1); bg.addColorStop(1, bgColor2);
  ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);

  // Lime glow bottom-left
  const glow = ctx.createRadialGradient(0, H, 0, 0, H, 400);
  glow.addColorStop(0, isUp ? '#84cc1625' : '#ef444420');
  glow.addColorStop(1, 'transparent');
  ctx.fillStyle = glow; ctx.fillRect(0, 0, W, H);

  // Border
  ctx.strokeStyle = pnlColor + '60'; ctx.lineWidth = 2;
  ctx.beginPath();
  const r = 20;
  ctx.moveTo(r, 0); ctx.lineTo(W-r, 0); ctx.quadraticCurveTo(W, 0, W, r);
  ctx.lineTo(W, H-r); ctx.quadraticCurveTo(W, H, W-r, H);
  ctx.lineTo(r, H); ctx.quadraticCurveTo(0, H, 0, H-r);
  ctx.lineTo(0, r); ctx.quadraticCurveTo(0, 0, r, 0);
  ctx.closePath(); ctx.stroke();

  // Header -- logo + name
  ctx.font = 'bold 14px monospace'; ctx.fillStyle = '#a3e635';
  ctx.fillText('🔥 SUIPUMP', 42, 52);
  ctx.font = 'bold 28px monospace'; ctx.fillStyle = '#ffffff';
  ctx.fillText(name || 'Unknown', 42, 95);
  ctx.font = '15px monospace'; ctx.fillStyle = pnlColor + 'aa';
  ctx.fillText(`$${symbol}`, 42, 120);

  // Divider
  ctx.strokeStyle = '#ffffff15'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(42, 138); ctx.lineTo(W-42, 138); ctx.stroke();

  // Multiplier
  const mult = spent > 0 ? ((spent + pnlSui) / spent) : 1;
  const multStr = mult >= 1 ? `${mult.toFixed(2)}x` : `${mult.toFixed(2)}x`;
  ctx.font = 'bold 88px monospace'; ctx.fillStyle = pnlColor;
  ctx.fillText(multStr, 42, 250);

  // PnL amount
  const sign = isUp ? '+' : '';
  ctx.font = 'bold 22px monospace'; ctx.fillStyle = pnlColor + 'cc';
  ctx.fillText(`${sign}${pnlSui.toFixed(3)} SUI ${isUp ? 'TOTAL PROFIT' : 'TOTAL LOSS'}`, 42, 290);

  // Divider 2
  ctx.strokeStyle = '#ffffff15'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(42, 315); ctx.lineTo(W-42, 315); ctx.stroke();

  // Stats row
  ctx.font = 'bold 12px monospace'; ctx.fillStyle = '#ffffff60';
  ctx.fillText('INVESTED', 42, 345);
  ctx.fillText('ENTRY MC', 280, 345);
  ctx.fillText('CURRENT MC', 480, 345);

  ctx.font = 'bold 18px monospace'; ctx.fillStyle = '#ffffff';
  ctx.fillText(`${spent.toFixed(2)} SUI`, 42, 372);

  const fmtMc = (p) => {
    if (!p || p <= 0) return '—';
    const mc = p * 1_000_000_000;
    if (mc >= 1e6) return `$${(mc/1e6).toFixed(1)}M`;
    if (mc >= 1e3) return `$${(mc/1e3).toFixed(1)}k`;
    return `$${mc.toFixed(0)}`;
  };
  ctx.fillText(fmtMc(entryPrice), 280, 372);
  ctx.fillText(fmtMc(currentPrice), 480, 372);

  // Footer
  ctx.font = 'bold 13px monospace'; ctx.fillStyle = '#ffffff40';
  ctx.fillText('SUIPUMP  |  suipump.org', 42, 448);

  // Status badge
  const badgeText = isClosed ? '● Closed' : (isUp ? '● Pumping' : '● Dumping');
  const badgeColor = isClosed ? '#ffffff30' : pnlColor;
  ctx.font = 'bold 13px monospace'; ctx.fillStyle = badgeColor;
  ctx.fillText(badgeText, W - 160, 448);

  // Mascot drawn after image load in PnlShareButton
}

// Preload mascots at module load so the share handler can render synchronously.
// iOS requires navigator.share() to fire inside the user gesture, so we must not
// wait on an image load between the tap and the share call.
const _MASCOTS = {};
function _preloadMascot(src) {
  if (typeof window === 'undefined') return null;
  if (_MASCOTS[src]) return _MASCOTS[src];
  const im = new Image();
  im.src = src;
  _MASCOTS[src] = im;
  return im;
}
_preloadMascot('/mascot_pump.png');
_preloadMascot('/mascot_dump.png');

// True only on real mobile devices. Desktop Windows Edge/Chrome also support
// file sharing, so a plain canShare check wrongly routes desktop into the OS
// share dialog -- we do not want that. Desktop must just download.
function _isMobileDevice() {
  if (typeof navigator === 'undefined') return false;
  if (navigator.userAgentData && typeof navigator.userAgentData.mobile === 'boolean') return navigator.userAgentData.mobile;
  const ua = navigator.userAgent || '';
  if (/iphone|ipad|ipod|android|mobile/i.test(ua)) return true;
  // iPadOS 13+ reports as desktop Safari but is a touch device
  if (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) return true;
  return false;
}

// Deliver a canvas as a PNG. Tries the native share sheet on mobile; if the
// platform refuses (Android Chrome throws NotAllowedError when the user gesture
// /transient activation is lost across the async toBlob, or canShare is false),
// ALWAYS falls back to a real file download so the user gets the image either
// way. Desktop downloads directly.
async function sharePngFromCanvas(canvas, filename, shareText) {
  const blob = await new Promise(res => canvas.toBlob(res, 'image/png'));
  if (!blob) return 'error';

  const isMobile = _isMobileDevice();

  // Mobile: try the native share sheet first.
  if (isMobile && typeof navigator !== 'undefined' && navigator.canShare) {
    const file = new File([blob], filename, { type: 'image/png' });
    if (navigator.canShare({ files: [file] })) {
      try {
        // Blank title improves file-share compatibility across some targets.
        await navigator.share({ files: [file], title: '', text: shareText });
        return 'shared';
      } catch (err) {
        // User dismissed the sheet -- do NOT then dump a download on them.
        if (err && err.name === 'AbortError') return 'cancelled';
        // Any other error (notably Android's NotAllowedError when transient
        // activation was spent by the await above) falls through to download.
      }
    }
  }

  // Fallback for EVERYONE who didn't share: download the PNG. The <a download>
  // click works on Android Chrome (the previous window.open got popup-blocked
  // once activation was gone, so Android users saw nothing happen). window.open
  // is only a last resort if the download attribute is genuinely unsupported.
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    if ('download' in a) {
      a.href = url;
      a.download = filename;
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      a.remove();
    } else {
      window.open(url, '_blank');
    }
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 15000);
  }
  return 'downloaded';
}

function PnlShareButton({ tk, unrealizedPnl, currentPrice }) {
  const [busy, setBusy] = useState(false);

  const handleShare = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const canvas = document.createElement('canvas');
      const totalPnl = (tk.realizedPnl || 0) + (unrealizedPnl || 0);
      const isUp = totalPnl >= 0;
      const pct = tk.suiSpent > 0 ? (totalPnl / tk.suiSpent) * 100 : 0;

      drawPnlCard({
        canvas, name: tk.name, symbol: tk.symbol,
        pnlSui: totalPnl,
        pnlPct: pct,
        spent: tk.suiSpent, entryPrice: tk.avgEntryPrice,
        currentPrice: currentPrice || 0, isClosed: tk.isClosed,
      });

      // Draw the preloaded mascot if it has finished loading; otherwise render
      // without it rather than blocking (keeps the iOS user gesture alive).
      const mascot = _MASCOTS[isUp ? '/mascot_pump.png' : '/mascot_dump.png'];
      if (mascot && mascot.complete && mascot.naturalWidth > 0) {
        drawMascotOnCanvas(canvas.getContext('2d'), mascot, canvas.width - 290, 10, 280);
      }

      const shareText = `My $${tk.symbol || ''} PnL on SuiPump: ${totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(2)} SUI (${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%) · suipump.org`;
      await sharePngFromCanvas(canvas, `suipump-${tk.symbol || 'pnl'}.png`, shareText);
    } catch {}
    setBusy(false);
  };

  return (
    <button onClick={e => { e.stopPropagation(); handleShare(); }} disabled={busy}
      className="flex items-center gap-1 px-2 py-1 rounded-lg bg-lime-400/10 border border-lime-400/20 text-lime-400 text-[9px] font-mono font-bold hover:bg-lime-400/20 transition-colors disabled:opacity-50">
      {busy ? 'SHARING…' : 'SHARE PNL'}
    </button>
  );
}

// -- PFP storage ---------------------------------------------------------------
function pfpKey(addr) { return `suipump_pfp_${addr}`; }
function getPfp(addr) { try { return localStorage.getItem(pfpKey(addr)) || ''; } catch { return ''; } }
function setPfp(addr, url) { try { localStorage.setItem(pfpKey(addr), url); } catch {} }

// -- HOLDINGS tab --------------------------------------------------------------

function HoldingsTab({ account, tokens, lang, onTotalValue, onCount }) {
  const navigate = useNavigate();
  const [holdings, setHoldings] = useState([]);
  const [loading, setLoading] = useState(true);
  const [iconUrls, setIconUrls] = useState({});

  useEffect(() => {
    if (!account?.address) { setLoading(false); return; }
    let cancelled = false;

    async function load() {
      setLoading(true);
      try {
        // Step 1: Fetch all curve stats -- has correct last_price per curve
        let tokenStats = {};
        if (INDEXER_URL) {
          try {
            const res = await fetch(`${INDEXER_URL}/tokens/stats`, { signal: AbortSignal.timeout(5000) });
            if (res.ok) {
              const rows = await res.json();
              for (const r of rows) tokenStats[r.curve_id] = r;
            }
          } catch {}
        }

        // Step 2: ON-CHAIN balances -- the source of truth for holdings.
        // The old /trader/:address derivation only counted trades the indexer
        // attributed to THIS wallet, so tokens that arrived any other way --
        // swept back from an agent session (bought by the SESSION address),
        // airdropped, transferred in, swapped elsewhere -- never showed. The
        // chain does not care how a coin arrived: read the wallet's actual
        // coin balances and intersect with the known SuiPump token types.
        let results = [];
        let chainOk = false;
        try {
          // token_type -> curve row map. /tokens carries tokenType per curve;
          // the richer `tokens` prop entry (app shape) wins when present.
          const typeMap = {};
          if (INDEXER_URL) {
            try {
              const tr = await fetch(`${INDEXER_URL}/tokens`, { signal: AbortSignal.timeout(8000) });
              if (tr.ok) {
                for (const row of await tr.json()) {
                  const tt = (row.tokenType ?? row.token_type ?? '').toLowerCase();
                  if (tt) typeMap[tt] = row;
                }
              }
            } catch {}
          }
          for (const tk of tokens) {
            const tt = (tk.tokenType ?? tk.token_type ?? '').toLowerCase();
            if (tt) typeMap[tt] = { ...(typeMap[tt] ?? {}), ...tk };
          }

          // Every coin balance at the address. PAGE SIZE IS 50: the RPC's
          // GraphQL validator hard-rejects larger pages ("Page size is too
          // large: 100 > 50"), and that rejection nulls the WHOLE read - which
          // silently dropped holdings to the attribution fallback. 6 pages
          // keeps the same 300-coin-type ceiling.
          const balances = [];
          let cursor = null;
          for (let page = 0; page < 6; page++) {
            const q = `{ address(address: "${account.address}") { balances(first: 50${cursor ? `, after: "${cursor}"` : ''}) { pageInfo { hasNextPage endCursor } nodes { coinType { repr } totalBalance } } } }`;
            const r = await fetch('https://graphql.testnet.sui.io/graphql', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ query: q }), signal: AbortSignal.timeout(8000),
            });
            const d = await r.json();
            const b = d?.data?.address?.balances;
            if (!b) break;
            balances.push(...(b.nodes ?? []));
            chainOk = true;
            if (!b.pageInfo?.hasNextPage) break;
            cursor = b.pageInfo.endCursor;
          }

          for (const b of balances) {
            const tt = (b?.coinType?.repr ?? '').toLowerCase();
            const row = typeMap[tt];
            if (!row) continue; // not a SuiPump token
            const curveId = row.curveId ?? row.curve_id;
            if (!curveId) continue;
            const balance = Number(BigInt(b.totalBalance ?? 0)) / 1e6; // TOKEN_DECIMALS = 6 across all SuiPump tokens
            if (!(balance > 0)) continue;
            const token = tokens.find(t => t.curveId === curveId) ?? {
              curveId,
              name:      row.name,
              symbol:    row.symbol,
              iconUrl:   row.iconUrl ?? row.icon_url,
              packageId: row.packageId ?? row.package_id,
            };
            const stats = tokenStats[curveId];
            let valueSui = 0;
            if (stats?.last_price && stats.last_price > 0) {
              valueSui = balance * stats.last_price;
            }
            results.push({ ...token, balance, valueSui, graduated: row.graduated ?? false });
          }
        } catch { chainOk = false; }

        // FALLBACK ONLY: the pre-chain-truth derivation (indexer trade
        // attribution) -- used solely when the balance read failed outright,
        // so the tab never blanks on an RPC hiccup. By design it misses
        // non-platform acquisitions.
        if (!chainOk && INDEXER_URL) {
          try {
            const tradRes = await fetch(`${INDEXER_URL}/trader/${account.address}`, { signal: AbortSignal.timeout(8000) });
            if (tradRes.ok) {
              const positions = await tradRes.json();
              results = positions
                .filter(p => (p.net_tokens ?? p.balance ?? 0) > 0)
                .map(p => {
                  const balance = p.net_tokens ?? p.balance ?? 0;
                  const token = tokens.find(t => t.curveId === p.curve_id);
                  if (!token) return null;
                  const stats = tokenStats[p.curve_id];
                  let valueSui = 0;
                  if (stats?.last_price && stats.last_price > 0) {
                    valueSui = balance * stats.last_price;
                  } else {
                    const reserveSui = stats?.reserve_sui ?? 0;
                    const reserveMist = BigInt(Math.round(reserveSui * MIST_PER_SUI));
                    const tokensRemaining = BigInt(Math.round((stats?.token_reserve ?? 800_000_000) * 1e6));
                    const tokensSold = BigInt(800_000_000) * BigInt(1e6) - tokensRemaining;
                    const priceMist = priceMistPerToken(reserveMist, tokensSold);
                    const rawBalance = BigInt(Math.round(balance * 1e6));
                    const valueInMist = (rawBalance * priceMist) / BigInt(1e6);
                    valueSui = Number(valueInMist) / MIST_PER_SUI;
                  }
                  return { ...token, balance, valueSui, graduated: p.graduated ?? false };
                })
                .filter(Boolean);
            }
          } catch {}
        }

        if (cancelled) return;
        const valid = results.sort((a, b) => b.valueSui - a.valueSui);
        const total = valid.reduce((s, h) => s + h.valueSui, 0);
        setHoldings(valid);
        onTotalValue(total);
        if (onCount) onCount(valid.length);

        const icons = {};
        for (const h of valid) { if (h.iconUrl) icons[h.curveId] = h.iconUrl; }
        if (!cancelled) setIconUrls(icons);
      } catch {}
      finally { if (!cancelled) setLoading(false); }
    }

    load();
    return () => { cancelled = true; };
  }, [account?.address, tokens.length]);

  if (!account) return <div className="text-xs font-mono text-white/30 text-center py-12">{t(lang, 'connectToView')}</div>;
  if (loading) return <div className="text-xs font-mono text-white/30 text-center py-12">Loading…</div>;
  if (!holdings.length) return <div className="text-xs font-mono text-white/20 text-center py-12">{t(lang, 'noHoldings')}</div>;

  const totalValueSui = holdings.reduce((s, h) => s + h.valueSui, 0);
  const allocW = (v) => `${Math.max(0, Math.min(100, totalValueSui > 0 ? (v / totalValueSui) * 100 : 0))}%`;
  const priceOf = (h) => (h.balance > 0 ? h.valueSui / h.balance : 0);
  const avatar = (h) => (
    iconUrls[h.curveId]
      ? <img src={iconUrls[h.curveId]} alt={h.symbol} className="w-full h-full object-cover"
          onError={e => { e.target.style.display = 'none'; e.target.nextSibling.style.display = 'flex'; }} />
      : null
  );

  return (
    <div className="border border-white/[0.08] rounded-2xl bg-white/[0.015] overflow-hidden">
      {/* Desktop table */}
      <div className="hidden lg:block">
        <div className="grid grid-cols-[1.6fr_110px_120px_110px_1fr] gap-3 px-[18px] py-[11px] border-b border-white/[0.06] text-[9px] font-mono font-semibold tracking-[0.12em] text-white/30">
          <span>TOKEN</span>
          <span className="text-right">BALANCE</span>
          <span className="text-right">PRICE</span>
          <span className="text-right">VALUE</span>
          <span>ALLOCATION</span>
        </div>
        {holdings.map((h) => (
          <div
            key={h.curveId}
            onClick={() => navigate(`/token/${h.curveId}`)}
            className="grid grid-cols-[1.6fr_110px_120px_110px_1fr] gap-3 items-center px-[18px] py-[11px] border-b border-white/[0.04] last:border-0 hover:bg-white/[0.025] transition-colors cursor-pointer"
          >
            <div className="flex items-center gap-[10px] min-w-0">
              <span className="w-8 h-8 rounded-[10px] shrink-0 border border-white/12 overflow-hidden flex items-center justify-center bg-lime-950/30">
                {avatar(h)}
                <span className="text-sm" style={{ display: iconUrls[h.curveId] ? 'none' : 'flex' }}>🔥</span>
              </span>
              <div className="min-w-0">
                <div className="flex items-center gap-[6px]">
                  <span className="text-[12px] font-mono font-semibold text-white truncate">{h.name || 'Unknown'}</span>
                  {h.graduated && <span className="text-[7.5px] font-mono font-semibold text-emerald-400 bg-emerald-400/[0.13] px-[5px] py-[2px] rounded shrink-0">GRAD</span>}
                </div>
                <div className="text-[9.5px] font-mono text-white/35 mt-[4px]">${h.symbol || '???'}</div>
              </div>
            </div>
            <span className="text-right text-[11px] font-mono text-white/70">{fmt(h.balance, 0)}</span>
            <span className="text-right text-[11px] font-mono text-white/70">{fmt(priceOf(h), 6)}</span>
            <span className="text-right text-[11.5px] font-mono font-bold text-lime-400">{fmt(h.valueSui, 4)}</span>
            <div className="h-[5px] rounded-[3px] bg-white/[0.06] overflow-hidden self-center">
              <div className="h-full rounded-[3px] bg-lime-400/55" style={{ width: allocW(h.valueSui) }} />
            </div>
          </div>
        ))}
      </div>

      {/* Mobile cards */}
      <div className="lg:hidden">
        {holdings.map((h) => (
          <div
            key={h.curveId}
            onClick={() => navigate(`/token/${h.curveId}`)}
            className="flex items-center gap-3 px-4 py-[11px] border-b border-white/[0.05] last:border-0 active:bg-white/[0.03]"
          >
            <span className="w-10 h-10 rounded-xl shrink-0 border border-white/12 overflow-hidden flex items-center justify-center bg-lime-950/30">
              {avatar(h)}
              <span className="text-base" style={{ display: iconUrls[h.curveId] ? 'none' : 'flex' }}>🔥</span>
            </span>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-[6px]">
                <span className="text-[12.5px] font-mono font-semibold text-white truncate">{h.name || 'Unknown'}</span>
                {h.graduated && <span className="text-[7.5px] font-mono font-semibold text-emerald-400 bg-emerald-400/[0.13] px-[5px] py-[2px] rounded shrink-0">GRAD</span>}
              </div>
              <div className="text-[9.5px] font-mono text-white/35 my-[6px]">{fmt(h.balance, 0)} ${h.symbol || '???'}</div>
              <div className="h-[4px] rounded-[3px] bg-white/[0.06] overflow-hidden">
                <div className="h-full rounded-[3px] bg-lime-400/55" style={{ width: allocW(h.valueSui) }} />
              </div>
            </div>
            <div className="text-right shrink-0">
              <div className="text-[12.5px] font-mono font-bold text-lime-400">{fmt(h.valueSui, 4)}</div>
              <div className="text-[10px] font-mono text-white/35 mt-[6px]">{fmt(priceOf(h), 6)}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// -- SESSION POSITIONS (ledger C-6) -------------------------------------------
// Positions parked on the wallet's agent sessions. Distinct from address-balance
// holdings; sells route through /session-sell (never userSell). Own wallet only.

function SessionPositionsSection({ account, tokens, lang }) {
  const { positions, loading, refresh } = useSessionPositions(account, tokens);
  const [busyKey, setBusyKey] = useState(null);
  const [msg, setMsg] = useState('');

  const keyOf = (p) => `${p.sessionId}:${p.tokenType}`;

  async function handleSell(p) {
    const k = keyOf(p);
    if (busyKey || !p.curveId) return;
    setBusyKey(k);
    setMsg('');
    try {
      await sellSessionPosition({ sessionId: p.sessionId, curveId: p.curveId });
      setMsg(t(lang, 'sessionSellOk'));
      refresh();
    } catch (e) {
      setMsg(`${t(lang, 'sessionSellFail')}: ${e?.message || 'error'}`);
    } finally {
      setBusyKey(null);
      setTimeout(() => setMsg(''), 5000);
    }
  }

  // Nothing to show: no positions and not loading -> render nothing.
  if (!loading && positions.length === 0) return null;

  const badge = (
    <span className="text-[8px] font-mono font-semibold text-[#a78bfa] border border-violet-400/40 bg-violet-400/10 px-[6px] py-[3px] rounded shrink-0">
      {t(lang, 'sessionTag')}
    </span>
  );

  return (
    <div className="border border-violet-400/20 rounded-2xl bg-violet-400/[0.03] overflow-hidden">
      <div className="flex items-center gap-[10px] px-[18px] py-[11px] border-b border-white/[0.06]">
        <span className="text-[10px] font-mono font-bold tracking-[0.14em] text-[#a78bfa]">{t(lang, 'sessionPositions')}</span>
        <span className="text-[9.5px] font-mono text-white/35">{t(lang, 'sessionParked')}</span>
        {loading && <span className="ml-auto text-[9.5px] font-mono text-white/30">Loading…</span>}
      </div>

      {msg && (
        <div className="px-[18px] py-2 text-[10px] font-mono text-[#a78bfa] border-b border-white/[0.05]">{msg}</div>
      )}

      {positions.map((p) => {
        const k = keyOf(p);
        const selling = busyKey === k;
        const sellable = !!p.curveId;
        const avatar = (
          p.iconUrl
            ? <img src={p.iconUrl} alt={p.symbol} className="w-full h-full object-cover"
                onError={e => { e.target.style.display = 'none'; e.target.nextSibling.style.display = 'flex'; }} />
            : null
        );
        return (
          <div key={k} className="flex items-center gap-3 px-4 lg:px-[18px] py-[11px] border-b border-white/[0.04] last:border-0">
            <span className="w-9 h-9 rounded-[10px] shrink-0 border border-violet-400/25 overflow-hidden flex items-center justify-center bg-violet-950/20">
              {avatar}
              <span className="text-sm" style={{ display: p.iconUrl ? 'none' : 'flex' }}>🔥</span>
            </span>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-[6px]">
                <span className="text-[12px] font-mono font-semibold text-white truncate">{p.name || 'Unknown'}</span>
                {badge}
                {!sellable && (
                  <span className="text-[7.5px] font-mono font-semibold text-white/40 border border-white/12 px-[5px] py-[2px] rounded shrink-0">{t(lang, 'readOnlyTag')}</span>
                )}
              </div>
              <div className="text-[9.5px] font-mono text-white/35 mt-[4px]">
                {fmt(p.balanceWhole, 0)} ${p.symbol || '???'}
              </div>
            </div>
            <button
              onClick={() => handleSell(p)}
              disabled={!sellable || selling}
              className="h-[30px] px-3 border border-red-400/30 rounded-lg text-red-400 text-[9.5px] font-mono font-bold hover:bg-red-400/10 transition-colors disabled:opacity-30 disabled:cursor-not-allowed shrink-0"
            >
              {selling ? t(lang, 'sellingAction') : t(lang, 'sellAction')}
            </button>
          </div>
        );
      })}
    </div>
  );
}

// -- CREATOR FEES bar (persistent) --------------------------------------------
// Self-contained: reads on-chain creator_fees for the wallet's created tokens
// and claims them. The claim logic is preserved byte-identical from the previous
// CreatedTab.handleClaimAll (build-then-execute for the trade-key path; wallet
// signAndExecute otherwise). Own wallet only.

function CreatorFeesBar({ createdTokens, account, tradeKeypair, lang }) {
  const dAppKit = useDAppKit();
  const client  = useCurrentClient();
  const [feeMap, setFeeMap]         = useState({});
  const [feeNonce, setFeeNonce]     = useState(0);
  const [claimingAll, setClaimingAll] = useState(false);
  const [claimMsg, setClaimMsg]     = useState('');

  // Read real on-chain creator_fees for each created token via GraphQL.
  useEffect(() => {
    if (!account?.address || !createdTokens.length) { setFeeMap({}); return; }
    let cancelled = false;
    (async () => {
      const map = {};
      await Promise.allSettled(createdTokens.map(async tk => {
        try {
          const gql = `{ object(address: "${tk.curveId}") { asMoveObject { contents { json } } } }`;
          const r = await client.graphql({ query: gql });
          const json = r?.data?.object?.asMoveObject?.contents?.json;
          if (json?.creator_fees != null) {
            const mist = typeof json.creator_fees === 'object'
              ? Number(json.creator_fees?.value ?? 0)
              : Number(json.creator_fees ?? 0);
            map[tk.curveId] = mist / 1e9;
          }
        } catch {}
      }));
      if (!cancelled) setFeeMap(map);
    })();
    return () => { cancelled = true; };
  }, [createdTokens, account?.address, feeNonce]);

  const totalClaimable = useMemo(
    () => createdTokens.reduce((s, tk) => s + (feeMap[tk.curveId] ?? 0), 0),
    [createdTokens, feeMap]
  );
  const feeSymbols = useMemo(
    () => createdTokens.filter(tk => (feeMap[tk.curveId] ?? 0) > 0).map(tk => `$${tk.symbol || '???'}`),
    [createdTokens, feeMap]
  );

  const handleClaimAll = async () => {
    if (!account || claimingAll) return;
    setClaimingAll(true);
    setClaimMsg('');
    let claimed = 0;
    try {
      // Find all CreatorCaps owned by this wallet across all package versions
      const capsByPkg = {};
      // Direct fetch to Sui GraphQL -- bypasses dapp-kit-react wrapper
      const GRAPHQL_URL_CA = 'https://graphql.testnet.sui.io/graphql';
      for (const pkgId of ALL_PACKAGE_IDS) {
        try {
          const query = `{ address(address: "${account.address}") { objects(filter: { type: "${pkgId}::bonding_curve::CreatorCap" }) { nodes { address contents { json } } } } }`;
          const r = await fetch(GRAPHQL_URL_CA, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query }), signal: AbortSignal.timeout(8000),
          });
          const result = await r.json();
          const nodes = result?.data?.address?.objects?.nodes ?? [];
          for (const node of nodes) {
            const cId = node.contents?.json?.curve_id;
            if (cId) capsByPkg[cId] = node.address;
          }
        } catch {}
      }

      for (const tk of createdTokens) {
        const capId = capsByPkg[tk.curveId];
        if (!capId) continue; // skip tokens where we don't own the creator cap

        // Check on-chain creator_fees -- skip if zero to avoid ENoFees abort
        let onChainFeesMist = 0n;
        try {
          const feeGql = `{ object(address: "${tk.curveId}") { asMoveObject { contents { json } } } }`;
          const feeR = await fetch('https://graphql.testnet.sui.io/graphql', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query: feeGql }), signal: AbortSignal.timeout(5000),
          });
          const feeResult = await feeR.json();
          const feeJson = feeResult?.data?.object?.asMoveObject?.contents?.json;
          const rawFee = feeJson?.creator_fees;
          onChainFeesMist = BigInt(typeof rawFee === 'object' ? (rawFee?.value ?? 0) : (rawFee ?? 0));
        } catch {}
        if (onChainFeesMist === 0n) continue; // nothing to claim

        // Fetch ISV for sharedObjectRef
        let isv = null;
        try {
          const isvRes = await fetch(`${INDEXER_URL}/token/${tk.curveId}`, { signal: AbortSignal.timeout(3000) });
          if (isvRes.ok) { const d = await isvRes.json(); isv = d.initialSharedVersion ?? d.initial_shared_version ?? null; }
        } catch {}

        const tx = new Transaction();
        const curveRef = isv
          ? tx.sharedObjectRef({ objectId: tk.curveId, initialSharedVersion: isv, mutable: true })
          : tx.object(tk.curveId);
        tx.moveCall({
          target: `${tk.packageId}::bonding_curve::claim_creator_fees`,
          typeArguments: [tk.tokenType],
          arguments: [tx.object(capId), curveRef],
        });
        if (tradeKeypair) {
          // Autonomous path -- no wallet popup
          const autoClient = new SuiGraphQLClient({ url: '/api/rpc' });
          tx.setSender(account.address);
          const builtTx = await tx.build({ client: autoClient });
          const { signature } = await tradeKeypair.signTransaction(builtTx);
          const execResult = await autoClient.executeTransaction({ transaction: builtTx, signatures: [signature] });
          if (execResult?.errors == null) claimed++;
        } else {
          const result = await executeTx(dAppKit, null, tx, account.address);
          if (result.$kind === 'Transaction') claimed++;
        }
      }
      setClaimMsg(claimed > 0 ? `Claimed from ${claimed} token${claimed !== 1 ? 's' : ''} ✓` : 'Nothing to claim');
      if (claimed > 0) setFeeNonce(n => n + 1);
    } catch (e) {
      setClaimMsg(e.message || 'Claim failed');
    } finally {
      setClaimingAll(false);
      setTimeout(() => setClaimMsg(''), 4000);
    }
  };

  if (totalClaimable <= 0 && !claimMsg) return null;

  const across = feeSymbols.length > 0 ? ` (${feeSymbols.join(' · ')})` : '';

  return (
    <div className="border border-amber-500/25 rounded-[14px] bg-amber-500/[0.04] px-[18px] py-[14px]">
      <div className="flex items-center gap-[14px] flex-wrap">
        <span className="text-[10px] font-mono font-bold tracking-[0.14em] text-amber-500">{t(lang, 'creatorFeesLabel')}</span>
        <span className="text-[11px] font-mono text-white/55">
          {fmt(totalClaimable, 3)} SUI {t(lang, 'claimableInFees')}{across}
        </span>
        <button
          onClick={handleClaimAll}
          disabled={claimingAll || totalClaimable <= 0}
          className="ml-auto h-8 px-4 rounded-[9px] bg-amber-500 text-black text-[10.5px] font-mono font-bold hover:bg-amber-400 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {claimingAll ? t(lang, 'claimingAction') : t(lang, 'claimAllAction')}
        </button>
      </div>
      {claimMsg && <div className="text-[10px] font-mono text-amber-400 mt-2">{claimMsg}</div>}
    </div>
  );
}

// -- TRADED tab ----------------------------------------------------------------

function TradedTab({ account, tokens, lang }) {
  const navigate = useNavigate();
  const [tradedTokens, setTradedTokens] = useState([]);
  const [loading, setLoading] = useState(true);
  const [iconUrls, setIconUrls] = useState({});
  const [currentPrices, setCurrentPrices] = useState({});

  useEffect(() => {
    if (!account?.address) { setLoading(false); return; }
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const addr = account.address;

        // Indexer path
        if (INDEXER_URL) {
          try {
            const res = await fetch(`${INDEXER_URL}/trader/${addr}`, { signal: AbortSignal.timeout(5000) });
            if (res.ok) {
              const rows = await res.json();
              if (rows.length > 0) {
                const enriched = rows.map(r => {
                  const meta = tokens.find(tk => tk.curveId === r.curve_id);
                  return {
                    curveId:       r.curve_id,
                    name:          meta?.name   || r.name   || 'Unknown',
                    symbol:        meta?.symbol || r.symbol || '???',
                    tokenType:     meta?.tokenType || null,
                    iconUrl:       meta?.iconUrl || null,
                    suiSpent:      r.sui_spent    ?? 0,
                    suiReceived:   r.sui_received ?? 0,
                    buys:          r.buys         ?? 0,
                    sells:         r.sells        ?? 0,
                    realizedPnl:   (r.sui_received ?? 0) - (r.sui_spent ?? 0),
                    isClosed:      (r.net_tokens  ?? 0) <= 0.001,
                    avgEntryPrice: r.avg_entry_price ?? 0,
                  };
                }).sort((a, b) => (b.suiSpent + b.suiReceived) - (a.suiSpent + a.suiReceived));

                if (!cancelled) { setTradedTokens(enriched); setLoading(false); }

                const icons = {};
                const prices = {};
                for (const tk of enriched) {
                  if (tk.iconUrl) icons[tk.curveId] = tk.iconUrl;
                }
                if (!cancelled) setIconUrls(icons);

                // Fetch current prices from indexer stats
                try {
                  const statsRes = await fetch(`${INDEXER_URL}/tokens/stats`, { signal: AbortSignal.timeout(5000) });
                  if (statsRes.ok) {
                    const statsRows = await statsRes.json();
                    for (const s of statsRows) { if (s.last_price) prices[s.curve_id] = s.last_price; }
                    if (!cancelled) setCurrentPrices(prices);
                  }
                } catch {}
                return;
              }
            }
          } catch {}
        }

        // RPC fallback removed (CORS blocked) -- empty state
        if (!cancelled) { setTradedTokens([]); setLoading(false); }
      } catch { if (!cancelled) setLoading(false); }
    }
    load();
    return () => { cancelled = true; };
  }, [account?.address, tokens.length]);

  if (!account) return <div className="text-xs font-mono text-white/30 text-center py-12">{t(lang, 'connectToView')}</div>;
  if (loading) return <div className="text-xs font-mono text-white/30 text-center py-12">Loading…</div>;
  if (!tradedTokens.length) return <div className="text-xs font-mono text-white/20 text-center py-12">{t(lang, 'noTrades')}</div>;

  return (
    <div className="border border-white/[0.08] rounded-2xl bg-white/[0.015] overflow-hidden">
      <div className="px-5 py-3 border-b border-white/5">
        <span className="text-[10px] font-mono text-white/30">{tradedTokens.length} token{tradedTokens.length !== 1 ? 's' : ''} traded</span>
      </div>
      {tradedTokens.map((tk) => {
        const pnl = tk.realizedPnl;
        const isUp = pnl >= 0;
        return (
          <TokenRow key={tk.curveId} token={tk} iconUrl={iconUrls[tk.curveId]}
            onClick={() => navigate(`/token/${tk.curveId}`)}
            right={
              <div className="text-right shrink-0 space-y-1">
                <div className={`text-xs font-mono font-bold ${isUp ? 'text-lime-400' : 'text-red-400'}`}>{fmtPnl(pnl)}</div>
                <div className="text-[10px] font-mono text-white/30">{tk.buys}B / {tk.sells}S</div>
                {tk.isClosed && <div className="text-[9px] font-mono text-white/20">CLOSED</div>}
                <PnlShareButton tk={tk} unrealizedPnl={0} currentPrice={currentPrices[tk.curveId] ?? 0} />
              </div>
            }
          />
        );
      })}
    </div>
  );
}

// -- CREATED tab ---------------------------------------------------------------
// Presentational: receives the wallet's created tokens (fetched once at the page
// level, shared with CreatorFeesBar) and loads its own display stats. Claiming
// lives in CreatorFeesBar now (persistent amber bar).

function CreatedTab({ createdTokens, loading: tokensLoading, lang }) {
  const navigate = useNavigate();
  const [curveStats, setCurveStats] = useState({});
  const [loading, setLoading]       = useState(true);
  const [iconUrls, setIconUrls]     = useState({});

  useEffect(() => {
    if (!createdTokens.length) { setLoading(false); return; }
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        let indexerStats = {};
        if (INDEXER_URL) {
          try {
            const res = await fetch(`${INDEXER_URL}/tokens/stats`, { signal: AbortSignal.timeout(5000) });
            if (res.ok) {
              const rows = await res.json();
              for (const r of rows) indexerStats[r.curve_id] = r;
            }
          } catch {}
        }

        const curveObjs = await Promise.all(
          createdTokens.map(tk =>
            fetch(`${INDEXER_URL}/token/${tk.curveId}`, { signal: AbortSignal.timeout(5000) })
              .then(r => r.ok ? r.json() : null)
              .catch(() => null)
          )
        );

        const statsMap = {};
        for (let i = 0; i < createdTokens.length; i++) {
          const tk = createdTokens[i];
          const obj = curveObjs[i];
          const idxStat = indexerStats[tk.curveId] ?? {};
          statsMap[tk.curveId] = {
            volumeSui:      idxStat.volume_sui  ?? 0,
            trades:         idxStat.trades      ?? 0,
            progress:       idxStat.progress    ?? 0,
            graduated:      obj?.graduated      ?? idxStat.graduated ?? false,
          };
        }

        if (!cancelled) {
          setCurveStats(statsMap);
          const icons = {};
          for (const tk of createdTokens) { if (tk.iconUrl) icons[tk.curveId] = tk.iconUrl; }
          setIconUrls(icons);
          setLoading(false);
        }
      } catch { if (!cancelled) setLoading(false); }
    }
    load();
    return () => { cancelled = true; };
  }, [createdTokens.length]);

  if (tokensLoading || loading) return <div className="text-xs font-mono text-white/30 text-center py-12">Loading…</div>;
  if (!createdTokens.length) return <div className="text-xs font-mono text-white/20 text-center py-12">{t(lang, 'noCreated')}</div>;

  return (
    <div className="border border-white/[0.08] rounded-2xl bg-white/[0.015] overflow-hidden">
      <div className="px-5 py-3 border-b border-white/5">
        <span className="text-[10px] font-mono text-white/30">{createdTokens.length} token{createdTokens.length !== 1 ? 's' : ''} launched</span>
      </div>
      {createdTokens.map((tk) => {
        const stats = curveStats[tk.curveId] ?? {};
        return (
          <TokenRow key={tk.curveId} token={tk} iconUrl={iconUrls[tk.curveId]}
            onClick={() => navigate(`/token/${tk.curveId}`)}
            right={
              <div className="text-right shrink-0 space-y-0.5">
                <div className="text-xs font-mono font-bold text-lime-400">{fmt(stats.volumeSui, 2)} SUI vol</div>
                <div className="text-[10px] font-mono text-white/30">{stats.trades ?? 0} trades</div>
                {stats.graduated
                  ? <div className="text-[9px] font-mono text-emerald-400">GRAD</div>
                  : <div className="text-[9px] font-mono text-white/20">{fmt(stats.progress, 1)}%</div>
                }
              </div>
            }
          />
        );
      })}
    </div>
  );
}

// -- Summary stat block --------------------------------------------------------

function StatBlock({ label, value, valueClass = '', sub, subClass = 'text-white/35', align = 'left' }) {
  return (
    <div className={align === 'right' ? 'text-right' : ''}>
      <div className="text-[9px] font-mono font-semibold tracking-[0.14em] text-white/32">{label}</div>
      <div className={`mt-[7px] text-2xl font-extrabold font-mono ${valueClass}`}>{value}</div>
      {sub != null && <div className={`text-[10px] font-mono mt-[5px] ${subClass}`}>{sub}</div>}
    </div>
  );
}

// -- Main ----------------------------------------------------------------------

export default function PortfolioPage({ onBack, lang = 'en', tradeKeypair = null }) {
  const account    = useCurrentAccount();
  const { tokens } = useTokenList();
  const navigate   = useNavigate();
  const { walletAddress } = useParams();

  // walletAddress from URL params takes priority; fall back to connected wallet
  const viewAddress = walletAddress || account?.address;
  const isOwnWallet = !walletAddress || (account?.address && walletAddress.toLowerCase() === account.address.toLowerCase());

  // Fake account object so tabs work with any address
  const viewAccount = viewAddress ? { address: viewAddress } : null;

  const [tab, setTab]               = useState('holdings');
  const [suiUsd, setSuiUsd]         = useState(0);
  const [totalValueSui, setTotalValueSui] = useState(0);
  const [holdingsCount, setHoldingsCount] = useState(null);
  const [tradedCount, setTradedCount]     = useState(null);
  const [realizedSui, setRealizedSui]     = useState(null);
  const [closedCount, setClosedCount]     = useState(0);
  const [points, setPoints]         = useState(null);
  const [rank, setRank]             = useState(null);
  const [createdTokens, setCreatedTokens] = useState([]);
  const [createdLoading, setCreatedLoading] = useState(true);
  const [pfpUrl, setPfpUrl]         = useState('');
  const [editingPfp, setEditingPfp] = useState(false);
  const [pfpInput, setPfpInput]     = useState('');
  const [pfpUploading, setPfpUploading] = useState(false);
  const [pfpError, setPfpError]     = useState('');

  useEffect(() => {
    if (viewAddress) setPfpUrl(getPfp(viewAddress));
  }, [viewAddress]);

  // Airdrop points + rank for the summary card (indexer /points/:address).
  useEffect(() => {
    if (!viewAddress || !INDEXER_URL) { setPoints(null); setRank(null); return; }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${INDEXER_URL}/points/${viewAddress}`, { signal: AbortSignal.timeout(5000) });
        if (!res.ok) return;
        const d = await res.json();
        if (cancelled) return;
        setPoints(Number(d.points ?? 0));
        setRank(d.rank ?? null);
      } catch {}
    })();
    return () => { cancelled = true; };
  }, [viewAddress]);

  // Realized PnL (closed positions) + traded count from the indexer trader feed.
  useEffect(() => {
    if (!viewAddress || !INDEXER_URL) { setRealizedSui(null); setTradedCount(null); setClosedCount(0); return; }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${INDEXER_URL}/trader/${viewAddress}`, { signal: AbortSignal.timeout(6000) });
        if (!res.ok) return;
        const rows = await res.json();
        if (cancelled || !Array.isArray(rows)) return;
        setTradedCount(rows.length);
        // Realized PnL = net SUI cashflow over CLOSED positions only (positions
        // with no remaining balance). Open positions have no cost basis here, so
        // they are excluded rather than fabricated.
        const closed = rows.filter(r => (r.net_tokens ?? 0) <= 0.001);
        const realized = closed.reduce((s, r) => s + ((r.sui_received ?? 0) - (r.sui_spent ?? 0)), 0);
        setClosedCount(closed.length);
        setRealizedSui(realized);
      } catch {}
    })();
    return () => { cancelled = true; };
  }, [viewAddress]);

  // Created tokens (fetched once, shared by CreatedTab + CreatorFeesBar).
  useEffect(() => {
    if (!viewAddress || !INDEXER_URL) { setCreatedTokens([]); setCreatedLoading(false); return; }
    let cancelled = false;
    setCreatedLoading(true);
    fetch(`${INDEXER_URL}/tokens?creator=${viewAddress}`, { signal: AbortSignal.timeout(8000) })
      .then(r => r.ok ? r.json() : [])
      .then(rows => {
        if (cancelled) return;
        const normalized = (Array.isArray(rows) ? rows : []).map(r => ({
          curveId:      r.curveId   ?? r.curve_id,
          creator:      r.creator,
          name:         r.name,
          symbol:       r.symbol,
          iconUrl:      r.iconUrl   ?? r.icon_url,
          tokenType:    r.tokenType ?? r.token_type,
          packageId:    r.packageId ?? r.package_id,
          createdAt:    r.createdAt ?? r.created_at,
        }));
        setCreatedTokens(normalized);
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setCreatedLoading(false); });
    return () => { cancelled = true; };
  }, [viewAddress]);

  useEffect(() => {
    async function fetchPrice() {
      try {
        const r = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=SUIUSDT');
        const j = await r.json();
        setSuiUsd(parseFloat(j.price) || 0);
      } catch {
        try {
          const r = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=sui&vs_currencies=usd');
          const j = await r.json();
          setSuiUsd(j?.sui?.usd || 0);
        } catch {}
      }
    }
    fetchPrice();
    const timer = setInterval(fetchPrice, 30_000);
    return () => clearInterval(timer);
  }, []);

  function savePfp() {
    const url = pfpInput.trim();
    if (url && viewAddress) { setPfp(viewAddress, url); setPfpUrl(url); }
    setEditingPfp(false);
    setPfpInput('');
    setPfpError('');
  }

  async function handlePfpUpload(file) {
    if (!file || !viewAddress) return;
    setPfpUploading(true); setPfpError('');
    try {
      const fd = new FormData();
      fd.append('image', file);
      const res = await fetch('https://api.imgur.com/3/image', {
        method: 'POST',
        headers: { Authorization: 'Client-ID 546c25a59c58ad7' },
        body: fd,
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.data?.error || 'Upload failed');
      const url = json.data.link;
      setPfp(viewAddress, url);
      setPfpUrl(url);
      setEditingPfp(false);
      setPfpInput('');
    } catch (err) {
      setPfpError(err.message || 'Upload failed');
    } finally {
      setPfpUploading(false);
    }
  }

  const createdCount = createdTokens.length;
  const TABS = [
    { id: 'holdings', label: t(lang, 'holdings'), count: holdingsCount },
    { id: 'traded',   label: t(lang, 'traded'),   count: tradedCount },
    { id: 'created',  label: t(lang, 'created'),  count: createdLoading ? null : createdCount },
  ];

  if (!viewAddress) {
    return (
      <div>
        <button onClick={onBack} className="flex items-center gap-2 text-xs font-mono text-white/40 hover:text-white mb-6 transition-colors">
          <ArrowLeft size={12} /> {t(lang, 'backToHome')}
        </button>
        <div className="max-w-2xl mx-auto">
          <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-8 text-center">
            <div className="text-sm font-mono text-white/30">{t(lang, 'connectToView')}</div>
          </div>
        </div>
      </div>
    );
  }

  const realizedUp = (realizedSui ?? 0) >= 0;

  return (
    <div>
      <button onClick={onBack} className="flex items-center gap-2 text-xs font-mono text-white/40 hover:text-white mb-6 transition-colors">
        <ArrowLeft size={12} /> {t(lang, 'backToHome')}
      </button>

      <div className="max-w-[1240px] mx-auto flex flex-col gap-[14px]">

        {/* Viewing someone else banner */}
        {!isOwnWallet && (
          <div className="rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3 text-[10px] font-mono text-white/40 text-center">
            Viewing portfolio for <span className="text-lime-400">{viewAddress.slice(0, 8)}…{viewAddress.slice(-6)}</span>
          </div>
        )}

        {/* Referral link CTA - own wallet only; links through to /referrals. */}
        {isOwnWallet && <ReferralLinkCard lang={lang} />}

        {/* Summary card */}
        <div
          className="border border-white/[0.08] rounded-2xl bg-white/[0.015] p-5"
          style={{ backgroundImage: 'radial-gradient(circle at 12% 0%, rgba(132,204,22,.08), transparent 55%)' }}
        >
          {/* Desktop layout */}
          <div className="hidden lg:flex items-center gap-10 flex-wrap">
            <div className="flex items-center gap-[13px]">
              <div className="relative">
                <div
                  className="w-11 h-11 rounded-[13px] border border-violet-400/40 overflow-hidden flex items-center justify-center font-mono font-extrabold text-[17px]"
                  style={{ backgroundImage: 'linear-gradient(140deg, #6d28d9, #4c1d95)' }}
                >
                  {pfpUrl
                    ? <img src={pfpUrl} alt="pfp" className="w-full h-full object-cover" onError={() => setPfpUrl('')} />
                    : <span>{initialsOf(viewAddress)}</span>}
                </div>
                {isOwnWallet && (
                  <button
                    onClick={() => setEditingPfp(v => !v)}
                    className="absolute -bottom-1 -right-1 w-5 h-5 rounded-full bg-lime-400 text-black text-[8px] font-bold flex items-center justify-center hover:bg-lime-300 transition-colors"
                  >✎</button>
                )}
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-[14px] font-mono font-bold text-white">{viewAddress.slice(0, 6)}…{viewAddress.slice(-4)}</span>
                  {isOwnWallet && <span className="text-[8px] font-mono font-semibold text-[#a78bfa] border border-violet-400/40 px-[6px] py-[3px] rounded">{t(lang, 'youTag')}</span>}
                  <button
                    onClick={() => { navigator.clipboard.writeText(viewAddress).catch(() => {}); }}
                    className="text-[9px] font-mono text-white/30 hover:text-white/60 transition-colors"
                  >COPY</button>
                </div>
                <div className="text-[10px] font-mono text-white/35 mt-[6px]">{t(lang, 'networkTestnet')}</div>
              </div>
            </div>

            <StatBlock
              label={t(lang, 'totalValue')}
              value={<>{fmt(totalValueSui, 2)} <span className="text-[13px] text-white/40">SUI</span></>}
              sub={suiUsd > 0 && totalValueSui > 0 ? `≈ $${(totalValueSui * suiUsd).toFixed(2)}` : null}
            />
            {realizedSui != null && (
              <StatBlock
                label={t(lang, 'realizedPnlLabel')}
                value={fmtPnl(realizedSui)}
                valueClass={realizedUp ? 'text-lime-400' : 'text-red-400'}
                sub={`${closedCount} ${t(lang, 'closedTrades')}`}
              />
            )}
            <StatBlock
              label={t(lang, 'airdropPointsLabel')}
              value={points != null ? fmtInt(points) : '-'}
              valueClass="text-lime-400"
              sub={rank != null ? `${t(lang, 'rankWord')} #${rank}` : null}
            />
          </div>

          {/* Mobile layout */}
          <div className="lg:hidden">
            <div className="flex items-center gap-3 mb-4">
              <div className="relative">
                <div
                  className="w-10 h-10 rounded-xl border border-violet-400/40 overflow-hidden flex items-center justify-center font-mono font-extrabold text-[15px]"
                  style={{ backgroundImage: 'linear-gradient(140deg, #6d28d9, #4c1d95)' }}
                >
                  {pfpUrl
                    ? <img src={pfpUrl} alt="pfp" className="w-full h-full object-cover" onError={() => setPfpUrl('')} />
                    : <span>{initialsOf(viewAddress)}</span>}
                </div>
                {isOwnWallet && (
                  <button
                    onClick={() => setEditingPfp(v => !v)}
                    className="absolute -bottom-1 -right-1 w-5 h-5 rounded-full bg-lime-400 text-black text-[8px] font-bold flex items-center justify-center"
                  >✎</button>
                )}
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-[13px] font-mono font-bold text-white truncate">{viewAddress.slice(0, 6)}…{viewAddress.slice(-4)}</span>
                  {isOwnWallet && <span className="text-[8px] font-mono font-semibold text-[#a78bfa] border border-violet-400/40 px-[5px] py-[2px] rounded shrink-0">{t(lang, 'youTag')}</span>}
                </div>
                <div className="text-[9.5px] font-mono text-white/35 mt-[5px]">{t(lang, 'networkTestnet')}</div>
              </div>
            </div>
            <div className="flex items-end justify-between gap-3">
              <div>
                <div className="text-[9px] font-mono font-semibold tracking-[0.14em] text-white/32">{t(lang, 'totalValue')}</div>
                <div className="mt-2 text-[28px] leading-none font-extrabold font-mono">{fmt(totalValueSui, 2)} <span className="text-[14px] text-white/40">SUI</span></div>
                {suiUsd > 0 && totalValueSui > 0 && (
                  <div className="text-[10px] font-mono text-white/35 mt-[6px]">≈ ${(totalValueSui * suiUsd).toFixed(2)}</div>
                )}
              </div>
              {realizedSui != null && (
                <div className="text-right">
                  <div className="text-[9px] font-mono font-semibold tracking-[0.14em] text-white/32">{t(lang, 'realizedPnlLabel')}</div>
                  <div className={`mt-2 text-[20px] leading-none font-extrabold font-mono ${realizedUp ? 'text-lime-400' : 'text-red-400'}`}>{fmtPnl(realizedSui)}</div>
                  <div className="text-[10px] font-mono text-white/35 mt-[6px]">{closedCount} {t(lang, 'closedTrades')}</div>
                </div>
              )}
              <div className="text-right">
                <div className="text-[9px] font-mono font-semibold tracking-[0.14em] text-white/32">{t(lang, 'airdropPointsLabel')}</div>
                <div className="mt-2 text-[20px] leading-none font-extrabold font-mono text-lime-400">{points != null ? fmtInt(points) : '-'}</div>
                {rank != null && <div className="text-[10px] font-mono text-white/35 mt-[6px]">{t(lang, 'rankWord')} #{rank}</div>}
              </div>
            </div>
          </div>
        </div>

        {/* PFP edit */}
        {editingPfp && isOwnWallet && (
          <div className="border border-white/[0.08] rounded-2xl bg-white/[0.015] px-5 py-4 space-y-2">
            <label className="flex items-center gap-2 bg-white/5 border border-white/10 rounded-lg px-3 py-2 cursor-pointer hover:border-lime-400/40 transition-colors">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-white/40 shrink-0"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
              <span className="text-xs font-mono text-white/40 flex-1">
                {pfpUploading ? 'Uploading…' : 'Upload image'}
              </span>
              <input type="file" accept="image/*" className="hidden" disabled={pfpUploading}
                onChange={e => { const f = e.target.files?.[0]; if (f) handlePfpUpload(f); }} />
            </label>
            <div className="flex gap-2">
              <input
                value={pfpInput}
                onChange={e => setPfpInput(e.target.value)}
                placeholder="or paste image URL…"
                className="flex-1 bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 text-xs font-mono text-white placeholder-white/20 focus:outline-none focus:border-lime-400/40"
                onKeyDown={e => e.key === 'Enter' && savePfp()}
              />
              <button onClick={savePfp} className="px-3 py-1.5 bg-lime-400 text-black text-xs font-mono font-bold rounded-lg hover:bg-lime-300 transition-colors">Save</button>
            </div>
            {pfpError && <div className="text-[9px] font-mono text-red-400">{pfpError}</div>}
          </div>
        )}

        {/* Tab pills */}
        <div className="flex gap-2 flex-wrap items-center">
          {TABS.map(tb => (
            <button
              key={tb.id}
              onClick={() => setTab(tb.id)}
              className={`font-mono px-[15px] py-[9px] text-[11px] rounded-[10px] transition-colors ${
                tab === tb.id
                  ? 'bg-lime-400/[0.13] text-lime-400 border border-lime-400/35 font-bold'
                  : 'border border-white/10 text-white/45 font-semibold hover:text-white/70'
              }`}
            >
              {tb.label}{tb.count != null ? ` ${tb.count}` : ''}
            </button>
          ))}
        </div>

        {/* Tab content */}
        {tab === 'holdings' && (
          <HoldingsTab
            account={viewAccount}
            tokens={tokens}
            lang={lang}
            onTotalValue={setTotalValueSui}
            onCount={setHoldingsCount}
          />
        )}
        {tab === 'traded' && (
          <TradedTab
            account={viewAccount}
            tokens={tokens}
            lang={lang}
          />
        )}
        {tab === 'created' && (
          <CreatedTab
            createdTokens={createdTokens}
            loading={createdLoading}
            lang={lang}
          />
        )}

        {/* Session-parked positions (ledger C-6) -- own wallet only. */}
        {isOwnWallet && tab === 'holdings' && (
          <SessionPositionsSection account={viewAccount} tokens={tokens} lang={lang} />
        )}

        {/* Creator fees bar (persistent, own wallet). */}
        {isOwnWallet && (
          <CreatorFeesBar
            createdTokens={createdTokens}
            account={viewAccount}
            tradeKeypair={tradeKeypair}
            lang={lang}
          />
        )}

        <div className="text-[9px] font-mono text-white/15 text-center">
          {t(lang, 'valuesEstimate')}
        </div>
      </div>
    </div>
  );
}
