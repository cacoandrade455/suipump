// v18-strategies-lifted
// App.jsx  -  react-router-dom based routing
import React, { useState, useEffect } from 'react';
import { Routes, Route, useNavigate, useParams, Link, useLocation } from 'react-router-dom';
import { useCurrentAccount, useDAppKit, useCurrentClient } from '@mysten/dapp-kit-react';
import { ConnectButton, ConnectModal } from '@mysten/dapp-kit-react/ui';
import { Flame, Rocket, Plus, Gift, TrendingUp, Coins, Users, Trophy, Wallet, Search, Menu, X, Map, Copy, Crown, BarChart3, Github, MessageCircle, Bell, Star, Zap, Activity, ChevronRight, AlertTriangle } from 'lucide-react';

import { useTokenList } from './useTokenList.js';
import { useTokenStats } from './useTokenStats.js';
import TokenPage from './TokenPage.jsx';
import LaunchModal from './LaunchModal.jsx';
import AirdropPage from './AirdropPage.jsx';
import WhitepaperPage from './WhitepaperPage.jsx';
import LeaderboardPage from './LeaderboardPage.jsx';
import PortfolioPage from './PortfolioPage.jsx';
import RoadmapPage from './RoadmapPage.jsx';
import StatsPage from './StatsPage.jsx';
import { LANGUAGES, translations, t } from './i18n.js';
import { PACKAGE_ID, PACKAGE_ID_V4, PACKAGE_ID_V5, PACKAGE_ID_V6, PACKAGE_ID_V7, PACKAGE_ID_V8_1, PACKAGE_ID_V8, ALL_PACKAGE_IDS, DRAIN_SUI_APPROX, DRAIN_SUI_V4, DRAIN_SUI_V5, DRAIN_SUI_V6, DRAIN_SUI_V7, VIRTUAL_SUI_V4, VIRTUAL_SUI_V5, VIRTUAL_SUI_V6, VIRTUAL_TOKENS_V4, VIRTUAL_TOKENS_V5, VIRTUAL_TOKENS_V6, TOKEN_DECIMALS, isNewCurve, isV7OrLater, curveShapeFor } from './constants.js';
import { mistToSui, priceMistPerToken } from './curve.js';
import { paginateEvents, paginateMultipleEvents } from './paginateEvents.js';
import LiveFeedSidebar from './LiveFeedSidebar.jsx';
import { useWatchlist } from './useWatchlist.js';
import StrategiesModal from './StrategiesModal.jsx';
import { useTradeKey } from './useTradeKey.js';
import { useSniper } from './useSniper.js';
import { useDCA } from './useDCA.js';
import { useCopyTrade } from './useCopyTrade.js';
import { useRebalance } from './useRebalance.js';

const MIST_PER_SUI = 1e9;
const TOTAL_SUPPLY_WHOLE = 1_000_000_000;

let _suiUsdCache = 0;
async function refreshSuiUsd() {
  try {
    const r = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=SUIUSDT');
    const j = await r.json();
    _suiUsdCache = parseFloat(j.price) || 0;
  } catch {
    try {
      const r = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=sui&vs_currencies=usd');
      const j = await r.json();
      _suiUsdCache = j?.sui?.usd || 0;
    } catch { _suiUsdCache = 0; }
  }
  return _suiUsdCache;
}

function fmt(n, d = 2) {
  if (n == null) return ' - ';
  if (!Number.isFinite(n)) return ' - ';
  if (n >= 1e9) return (n / 1e9).toFixed(d) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(d) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(d) + 'k';
  return n.toFixed(d);
}

function timeAgoShort(ts) {
  if (!ts) return ' - ';
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

// ── Network detection banner ──────────────────────────────────────────────────
function NetworkBanner() {
  const account = useCurrentAccount();
  const [dismissed, setDismissed] = useState(
    () => { try { return sessionStorage.getItem('suipump_net_banner') === '1'; } catch { return false; } }
  );

  if (dismissed || !account) return null;

  const chains = account.chains ?? [];
  const onTestnet = chains.length === 0 || chains.some(c => c === 'sui:testnet' || c === 'sui:unknown');
  if (onTestnet) return null;

  const chainLabel = chains[0]?.replace('sui:', '') ?? 'unknown';

  return (
    <div className="w-full bg-red-950/60 border-b border-red-500/30 px-4 py-2.5 flex items-center justify-between gap-3 sticky top-[57px] z-30">
      <div className="flex items-center gap-2.5 min-w-0">
        <AlertTriangle size={13} className="text-red-400 shrink-0" />
        <p className="text-[11px] font-mono text-red-300 leading-snug">
          Your wallet is on <span className="font-bold text-red-200 uppercase">{chainLabel}</span> — SuiPump runs on <span className="font-bold text-red-200">testnet</span>. Switch networks in your wallet to trade.
        </p>
      </div>
      <button
        onClick={() => { try { sessionStorage.setItem('suipump_net_banner', '1'); } catch {} setDismissed(true); }}
        className="shrink-0 text-red-400/60 hover:text-red-300 transition-colors"
        aria-label="Dismiss"
      >
        <X size={13} />
      </button>
    </div>
  );
}

// ── Strategies locked banner ──────────────────────────────────────────────────
function StrategiesLockedBanner({ tradeKey, onOpenStrategies }) {
  const account = useCurrentAccount();
  const [dismissed, setDismissed] = useState(
    () => { try { return sessionStorage.getItem('suipump_key_banner') === '1'; } catch { return false; } }
  );

  if (!account || !tradeKey.hasKey || tradeKey.isReady || dismissed) return null;

  return (
    <div className="w-full bg-yellow-950/40 border-b border-yellow-500/20 px-4 py-2 flex items-center justify-between gap-3 sticky top-[57px] z-30">
      <div className="flex items-center gap-2.5 min-w-0">
        <Zap size={11} className="text-yellow-400/70 shrink-0" />
        <p className="text-[10px] font-mono text-yellow-300/60 leading-snug">
          Autonomous trading strategies are <span className="font-bold text-yellow-200/80">paused</span>. Unlock in <span className="font-bold text-yellow-200/80">strategies modal</span>.
        </p>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <button
          onClick={() => { onOpenStrategies(); }}
          className="text-[9px] font-mono font-bold text-yellow-400 hover:text-yellow-300 transition-colors px-2 py-1 rounded-lg border border-yellow-400/30 hover:border-yellow-400/60"
        >
          UNLOCK
        </button>
        <button
          onClick={() => { try { sessionStorage.setItem('suipump_key_banner', '1'); } catch {} setDismissed(true); }}
          className="text-yellow-400/40 hover:text-yellow-300 transition-colors"
          aria-label="Dismiss"
        >
          <X size={12} />
        </button>
      </div>
    </div>
  );
}

function ScrollToTop() {
  const { pathname } = useLocation();
  useEffect(() => { window.scrollTo(0, 0); }, [pathname]);
  return null;
}

// ── Live stats hook ───────────────────────────────────────────────────────────
const INDEXER_URL = import.meta.env.VITE_INDEXER_URL || '';

function applyLocalOverrides(token) {
  try {
    const metaOverride  = JSON.parse(localStorage.getItem(`suipump_meta_${token.curveId}`)  || '{}');
    const linksOverride = JSON.parse(localStorage.getItem(`suipump_links_${token.curveId}`) || '{}');
    return {
      ...token,
      name:    metaOverride.name    || token.name,
      symbol:  metaOverride.symbol  || token.symbol,
      iconUrl: metaOverride.iconUrl || token.iconUrl || null,
    };
  } catch {
    return token;
  }
}

function useStats() {
  const [stats, setStats] = useState({ poolSui: null, tradeCount: null, tokenCount: null, volume: null });

  useEffect(() => {
    if (!INDEXER_URL) return;
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch(`${INDEXER_URL}/stats`, { signal: AbortSignal.timeout(5000) });
        if (res.ok && !cancelled) {
          const data = await res.json();
          setStats({ poolSui: data.s1PoolSui, tradeCount: data.totalTrades, tokenCount: data.tokenCount ?? null, volume: data.totalVolume });
        }
      } catch {}
    }
    load();
    const timer = setInterval(load, 30_000);
    return () => { cancelled = true; clearInterval(timer); };
  }, []);

  return stats;
}

// ── % change badge ────────────────────────────────────────────────────────────
function PctBadge({ pct }) {
  if (pct == null || !Number.isFinite(pct)) return null;
  const isUp = pct >= 0;
  return (
    <span className={`text-[10px] font-mono font-bold px-1.5 py-0.5 rounded-md ${
      isUp ? 'text-lime-400 bg-lime-400/10' : 'text-red-400 bg-red-400/10'
    }`}>
      {isUp ? '+' : ''}{pct.toFixed(1)}%
    </span>
  );
}

// ── Sparkline mini chart ──────────────────────────────────────────────────────
function Sparkline({ points, width = 80, height = 24 }) {
  if (!points || points.length < 2) return null;
  const prices = points.map(p => p.p);
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const range = max - min || 1;
  const pts = prices.map((p, i) => {
    const x = (i / (prices.length - 1)) * width;
    const y = height - ((p - min) / range) * height;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  const isUp = prices[prices.length - 1] >= prices[0];
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} style={{ overflow: 'visible' }}>
      <polyline points={pts} fill="none" stroke={isUp ? '#84cc16' : '#f87171'} strokeWidth="1.5" strokeLinejoin="round" opacity="0.8" />
    </svg>
  );
}

// ── Token card ────────────────────────────────────────────────────────────────
function TokenCard({ token, stats, curveState: curveStateProp, isCrown, suiUsd = 0, isWatched, onToggleWatch }) {
  const navigate = useNavigate();
  const iconUrl = token.iconUrl || null;

  const cardShape   = curveShapeFor(token.packageId);
  const cardDrain   = cardShape.drainSui;
  const cardVSui    = cardShape.virtualSui;
  const cardVTok    = cardShape.virtualTokens;
  const reserveSui  = curveStateProp?.reserveSui ?? 0;
  const reserveMist = BigInt(Math.round(reserveSui * 1e9));
  const progress    = curveStateProp?.progress ?? 0;
  const graduated   = curveStateProp?.graduated ?? false;
  const pricePerWhole  = stats?.lastPrice ?? 0;
  const marketCapSui   = pricePerWhole * TOTAL_SUPPLY_WHOLE;
  const priceMist      = pricePerWhole > 0
    ? BigInt(Math.round(pricePerWhole * 1e9))
    : priceMistPerToken(0n, BigInt(800_000_000) * 10n ** BigInt(TOKEN_DECIMALS), cardVSui, cardVTok);
  const isTrending = stats?.recentTrades >= 3;
  const isNew = token.timestamp && (Date.now() - token.timestamp) < 30 * 60 * 1000;
  const suiUntilGrad = Math.max(0, cardDrain - mistToSui(reserveMist));
  const devBuySui = stats?.devBuyMist ? stats.devBuyMist / 1e9 : 0;

  const timeAgo = token.timestamp ? (() => {
    const diff = Date.now() - token.timestamp;
    if (diff < 60_000) return 'just now';
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`;
    return `${Math.floor(diff / 86_400_000)}d`;
  })() : '';

  return (
    <button
      onClick={() => navigate(`/token/${token.curveId}`)}
      className={`text-left rounded-2xl border bg-white/[0.03] hover:bg-white/[0.06] transition-all duration-200 p-4 w-full group relative ${
        isCrown
          ? 'border-lime-400/50 shadow-lg shadow-lime-400/10'
          : 'border-white/10 hover:border-lime-400/30'
      }`}
    >
      {isCrown && (
        <div className="absolute -top-3 left-1/2 -translate-x-1/2 flex items-center gap-1 bg-[#080808] border border-lime-400/40 rounded-full px-2.5 py-0.5">
          <Crown size={10} className="text-lime-400" />
          <span className="text-[9px] font-mono font-bold text-lime-400 tracking-widest">COMMUNITY CROWN</span>
        </div>
      )}

      <div className={`flex items-start justify-between mb-2 ${isCrown ? 'mt-1' : ''}`}>
        <div className="flex items-center gap-2.5">
          <div className={`w-10 h-10 rounded-full overflow-hidden border-2 flex items-center justify-center bg-lime-950/30 shrink-0 transition-all ${
            isCrown ? 'border-lime-400/40' : 'border-white/10 group-hover:border-lime-400/30'
          }`}>
            {iconUrl
              ? <img src={iconUrl} alt={token.symbol} className="w-full h-full object-cover"
                  onError={e => { e.target.style.display='none'; if (e.target.nextSibling) e.target.nextSibling.style.display='flex'; }} />
              : null}
            <div className="w-full h-full flex items-center justify-center text-lg" style={{ display: iconUrl ? 'none' : 'flex' }}>🔥</div>
          </div>
          <div className="min-w-0">
            <div className="text-sm font-bold text-white font-mono truncate max-w-[120px] group-hover:text-lime-400 transition-colors">
              {token.name}
            </div>
            <div className="text-[10px] font-mono text-white/40">${token.symbol}</div>
          </div>
        </div>
        <div className="flex flex-col items-end gap-1 shrink-0">
          <button
            onClick={e => { e.stopPropagation(); onToggleWatch(token.curveId); }}
            className={`transition-colors ${isWatched ? 'text-lime-400' : 'text-white/15 hover:text-white/40'}`}
            title={isWatched ? 'Remove from watchlist' : 'Add to watchlist'}
          >
            <Star size={12} fill={isWatched ? 'currentColor' : 'none'} />
          </button>
          {isTrending && <span className="text-[8px] font-mono text-lime-400/70 bg-lime-400/10 px-1.5 py-0.5 rounded-full">HOT</span>}
          {isNew && !isTrending && <span className="text-[8px] font-mono text-blue-400/70 bg-blue-400/10 px-1.5 py-0.5 rounded-full">NEW</span>}
          {graduated && <span className="text-[8px] font-mono text-emerald-400/70 bg-emerald-400/10 px-1.5 py-0.5 rounded-full">GRAD</span>}
        </div>
      </div>

      <div className="flex items-center justify-between mb-1.5">
        <div className="text-[10px] font-mono text-white/30">{timeAgo}</div>
        <div className="flex items-center gap-2">
          {stats?.pctChange != null && <PctBadge pct={stats.pctChange} />}
          {stats?.sparkline24h && <Sparkline points={stats.sparkline24h} />}
        </div>
      </div>

      <div className="mb-3">
        <div className="flex items-center justify-between mb-1">
          <div className="text-[10px] font-mono text-white/30">
            {progress.toFixed(1)}% bonded
          </div>
          {suiUntilGrad > 0 && !graduated && (
            <div className="text-[9px] font-mono text-white/20">
              {fmt(suiUntilGrad)} SUI to grad
            </div>
          )}
        </div>
        <div className="h-1.5 rounded-full bg-white/5 overflow-hidden">
          <div
            className={`h-full rounded-full transition-all duration-500 ${
              graduated
                ? 'bg-emerald-400'
                : progress > 80
                ? 'bg-gradient-to-r from-lime-500 to-lime-300'
                : 'bg-gradient-to-r from-lime-700 to-lime-400'
            }`}
            style={{ width: `${Math.max(progress, 1)}%` }}
          />
        </div>
      </div>

      <div className="flex items-center justify-between text-[10px] font-mono">
        <div className="flex items-center gap-2 text-white/30">
          {marketCapSui > 0 && suiUsd > 0 && (
            <span className="text-lime-400/60">
              {marketCapSui * suiUsd >= 1000
                ? `$${((marketCapSui * suiUsd) / 1000).toFixed(1)}k`
                : `$${(marketCapSui * suiUsd).toFixed(0)}`}
            </span>
          )}
          {(stats?.volume ?? 0) > 0 && (
            <span className="text-lime-400/60">{fmt(stats.volume, 1)} SUI vol</span>
          )}
          {stats?.trades > 0 && (
            <span>{stats.trades} trades</span>
          )}
          {stats?.holderCount > 0 && (
            <span className="flex items-center gap-0.5">
              <Users size={8} /> {stats.holderCount}
            </span>
          )}
          {stats?.commentCount > 0 && (
            <span className="flex items-center gap-0.5">
              <MessageCircle size={8} /> {stats.commentCount}
            </span>
          )}
        </div>
        {devBuySui > 0 && (
          <span className="text-white/20">dev {fmt(devBuySui, 2)} SUI</span>
        )}
      </div>
    </button>
  );
}

function SkeletonCard() {
  return (
    <div className="rounded-2xl border border-white/5 bg-white/[0.02] p-4 w-full animate-pulse">
      <div className="flex items-center gap-3 mb-4">
        <div className="w-11 h-11 rounded-full bg-white/5" />
        <div className="flex-1">
          <div className="h-3 bg-white/5 rounded w-24 mb-2" />
          <div className="h-2.5 bg-white/5 rounded w-16" />
        </div>
      </div>
      <div className="h-1.5 bg-white/5 rounded-full mb-3" />
      <div className="flex justify-between">
        <div className="h-2.5 bg-white/5 rounded w-16" />
        <div className="h-2.5 bg-white/5 rounded w-24" />
      </div>
    </div>
  );
}

// ── Community Crown featured banner ───────────────────────────────────────────
function CrownBanner({ token, stats, curveState: curveStateProp, suiUsd }) {
  const navigate = useNavigate();
  const iconUrl = token?.iconUrl || null;

  if (!token) return null;

  const reserveSui2    = curveStateProp?.reserveSui ?? 0;
  const progress       = curveStateProp?.progress ?? 0;
  const pricePerWhole2 = stats?.lastPrice ?? 0;
  const mcapSui        = pricePerWhole2 * TOTAL_SUPPLY_WHOLE;

  return (
    <button
      onClick={() => navigate(`/token/${token.curveId}`)}
      className="w-full mb-6 rounded-2xl border border-lime-400/30 bg-gradient-to-r from-lime-950/30 to-black p-4 text-left hover:border-lime-400/50 transition-all group relative overflow-hidden"
    >
      <div className="absolute top-0 right-0 w-48 h-full bg-lime-400/5 blur-2xl pointer-events-none" />
      <div className="relative flex items-center gap-4">
        <div className="w-12 h-12 rounded-full overflow-hidden border-2 border-lime-400/40 flex items-center justify-center bg-lime-950/30 shrink-0">
          {iconUrl
            ? <img src={iconUrl} alt={token.symbol} className="w-full h-full object-cover"
                onError={e => { e.target.style.display='none'; if (e.target.nextSibling) e.target.nextSibling.style.display='flex'; }} />
            : null}
          <div className="w-full h-full flex items-center justify-center text-xl" style={{ display: iconUrl ? 'none' : 'flex' }}>🔥</div>
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-0.5">
            <Crown size={11} className="text-lime-400 shrink-0" />
            <span className="text-[9px] font-mono font-bold text-lime-400/70 tracking-widest">COMMUNITY CROWN 👑</span>
          </div>
          <div className="text-sm font-bold text-white font-mono group-hover:text-lime-400 transition-colors truncate">
            {token.name} <span className="text-white/40 font-normal">${token.symbol}</span>
          </div>
          <div className="flex items-center gap-3 mt-1 text-[10px] font-mono text-white/30">
            {mcapSui > 0 && suiUsd > 0 && (
              <span className="text-lime-400/70">
                ${((mcapSui * suiUsd) / 1000).toFixed(1)}k mcap
              </span>
            )}
            {(stats?.volume ?? 0) > 0 && <span>{fmt(stats.volume, 1)} SUI vol</span>}
            <span>{progress.toFixed(1)}% bonded</span>
          </div>
        </div>
        <ChevronRight size={16} className="text-lime-400/40 group-hover:text-lime-400 transition-colors shrink-0" />
      </div>
    </button>
  );
}

// ── Stats bar ─────────────────────────────────────────────────────────────────
function StatsBar({ stats }) {
  const items = [
    { icon: <Coins size={13} />, label: 'TOKENS', value: stats.tokenCount != null ? stats.tokenCount : ' - ' },
    { icon: <TrendingUp size={13} />, label: 'TRADES', value: stats.tradeCount ?? ' - ' },
    { icon: <Flame size={13} />, label: 'VOLUME', value: stats.volume != null ? `${fmt(stats.volume)} SUI` : '-' },
    { icon: <Gift size={13} />, label: 'S1 POOL', value: stats.poolSui != null ? `${stats.poolSui.toFixed(2)} SUI` : ' - ' },
  ];
  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-8">
      {items.map(({ icon, label, value }) => (
        <div key={label} className="rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3 flex items-center gap-3">
          <div className="text-lime-400/60">{icon}</div>
          <div>
            <div className="text-[9px] font-mono text-white/30 tracking-widest">{label}</div>
            <div className="text-sm font-bold font-mono text-white">{value}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Mobile wallet buttons ─────────────────────────────────────────────────────
function MobileWalletButtons() {
  const [show, setShow] = React.useState(false);
  const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
  if (!isMobile) return null;
  const dappUrl = encodeURIComponent('https://suipump.vercel.app');
  const wallets = [
    { name: 'Phantom', icon: 'https://www.phantom.app/img/phantom-logo.png', url: `https://phantom.app/ul/browse/${dappUrl}?ref=${dappUrl}` },
    { name: 'Slush', icon: 'https://slush.app/favicon.ico', url: `https://slush.app/open?url=${dappUrl}` },
  ];
  return (
    <div className="mt-3">
      {!show ? (
        <button
          onClick={() => setShow(true)}
          className="w-full py-2.5 rounded-xl border border-white/10 text-[10px] font-mono text-white/40 hover:text-white hover:border-white/20 transition-colors"
        >
          Open in wallet browser
        </button>
      ) : (
        <div className="flex gap-2">
          {wallets.map(w => (
            <a key={w.name} href={w.url}
              className="flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl border border-white/10 text-[10px] font-mono text-white/50 hover:text-white hover:border-white/20 transition-colors"
            >
              <img src={w.icon} alt={w.name} className="w-4 h-4 rounded" onError={e => { e.target.style.display='none'; }} />
              {w.name}
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Notifications ─────────────────────────────────────────────────────────────
function useNotifications(walletAddress) {
  const [notifications, setNotifications] = useState([]);
  const [unread, setUnread] = useState(0);
  const storageKey = walletAddress ? `suipump_notif_seen_${walletAddress}` : null;
  const IURL = import.meta.env.VITE_INDEXER_URL || '';

  useEffect(() => {
    if (!walletAddress || !IURL) return;
    let cancelled = false;

    async function load() {
      try {
        const tokensRes = await fetch(`${IURL}/tokens?creator=${walletAddress}`, { signal: AbortSignal.timeout(5000) });
        if (!tokensRes.ok) return;
        const myTokens = await tokensRes.json();
        const myCurveIds = new Set(myTokens.map(t => t.curveId).filter(Boolean));

        if (myCurveIds.size === 0) { if (!cancelled) setNotifications([]); return; }

        const commentResults = await Promise.all(
          [...myCurveIds].slice(0, 10).map(cid =>
            fetch(`${IURL}/token/${cid}/comments`, { signal: AbortSignal.timeout(5000) })
              .then(r => r.ok ? r.json() : [])
              .then(rows => rows.map(r => ({
                id: r.tx_digest + '_' + (r.event_seq ?? 0),
                type: 'comment',
                curveId: cid,
                author: r.author ?? r.data?.author ?? '',
                text: r.text ?? r.data?.text ?? '',
                timestamp: r.timestamp_ms ? Number(r.timestamp_ms) : 0,
              })))
              .catch(() => [])
          )
        );

        const gradResults = await Promise.all(
          [...myCurveIds].slice(0, 10).map(cid =>
            fetch(`${IURL}/token/${cid}`, { signal: AbortSignal.timeout(5000) })
              .then(r => r.ok ? r.json() : null)
              .then(d => d?.graduated ? [{ id: `grad_${cid}`, type: 'graduated', curveId: cid, author: null, text: null, timestamp: d.graduatedAt ?? 0 }] : [])
              .catch(() => [])
          )
        );

        const allComments = commentResults.flat().filter(c => c.author !== walletAddress);
        const allGrads = gradResults.flat();

        const relevant = [...allComments, ...allGrads]
          .sort((a, b) => b.timestamp - a.timestamp)
          .slice(0, 20);

        if (!cancelled) {
          setNotifications(relevant);
          const lastSeen = parseInt(localStorage.getItem(storageKey) || '0', 10);
          setUnread(relevant.filter(n => n.timestamp > lastSeen).length);
        }
      } catch {}
    }

    load();
    const timer = setInterval(load, 30_000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [walletAddress, storageKey]);

  const markAllRead = () => {
    if (!storageKey) return;
    localStorage.setItem(storageKey, String(Date.now()));
    setUnread(0);
  };

  return { notifications, unread, markAllRead };
}

function NotificationBell({ walletAddress }) {
  const navigate = useNavigate();
  const { notifications, unread, markAllRead } = useNotifications(walletAddress);
  const [open, setOpen] = useState(false);
  const bellRef = React.useRef(null);

  useEffect(() => {
    if (!open) return;
    function handle(e) {
      if (bellRef.current && !bellRef.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener('mousedown', handle);
    return () => document.removeEventListener('mousedown', handle);
  }, [open]);

  const toggle = () => {
    if (!open) markAllRead();
    setOpen(o => !o);
  };

  function timeAgo(ts) {
    if (!ts) return '';
    const diff = Date.now() - ts;
    if (diff < 60_000) return 'just now';
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
    return `${Math.floor(diff / 86_400_000)}d ago`;
  }

  function shortAddr(addr) {
    if (!addr) return '-';
    return addr.slice(0, 6) + '…' + addr.slice(-4);
  }

  if (!walletAddress) return null;

  return (
    <div className="relative" ref={bellRef}>
      <button
        onClick={toggle}
        className={`relative p-1.5 rounded-lg transition-colors ${
          open ? 'text-lime-400 bg-lime-400/10' : 'text-white/30 hover:text-white'
        }`}
        title="Notifications"
      >
        <Bell size={13} />
        {unread > 0 && (
          <span className="absolute -top-0.5 -right-0.5 w-3.5 h-3.5 bg-red-500 rounded-full text-[8px] font-bold text-white flex items-center justify-center leading-none">
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-2 w-80 bg-[#0e0e0e] border border-white/10 rounded-xl shadow-2xl z-50 overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3 border-b border-white/10">
            <span className="text-[10px] font-mono text-white/50 tracking-widest">NOTIFICATIONS</span>
            <span className="text-[10px] font-mono text-white/25">{notifications.length} total</span>
          </div>
          {notifications.length === 0 ? (
            <div className="px-4 py-8 text-center text-white/25 text-xs font-mono">
              No comments on your tokens yet
            </div>
          ) : (
            <div className="max-h-80 overflow-y-auto divide-y divide-white/5">
              {notifications.map(n => (
                <button
                  key={n.id}
                  onClick={() => { navigate(`/token/${n.curveId}`); setOpen(false); }}
                  className="w-full px-4 py-3 text-left hover:bg-white/[0.03] transition-colors"
                >
                  {n.type === 'graduated' ? (
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <span className="text-base">🎓</span>
                        <div>
                          <p className="text-xs font-mono font-bold text-lime-400">Token Graduated!</p>
                          <p className="text-[10px] font-mono text-white/40">{n.curveId?.slice(0, 12)}…</p>
                        </div>
                      </div>
                      <span className="text-[10px] font-mono text-white/25 flex-shrink-0">{timeAgo(n.timestamp)}</span>
                    </div>
                  ) : (
                    <>
                      <div className="flex items-start justify-between gap-2 mb-1">
                        <span className="text-[10px] font-mono text-lime-400/80">{shortAddr(n.author)}</span>
                        <span className="text-[10px] font-mono text-white/25 flex-shrink-0">{timeAgo(n.timestamp)}</span>
                      </div>
                      <p className="text-xs text-white/60 leading-relaxed line-clamp-2">{n.text}</p>
                      <p className="text-[9px] font-mono text-white/20 mt-1">{n.curveId?.slice(0, 12)}…</p>
                    </>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Custom wallet button ──────────────────────────────────────────────────────
function WalletButton({ size = 'md', lang = 'en' }) {
  const account = useCurrentAccount();
  const dAppKit = useDAppKit();
  const [open, setOpen] = useState(false);
  const [showMenu, setShowMenu] = useState(false);
  const menuRef = React.useRef(null);

  useEffect(() => {
    if (!showMenu) return;
    function handle(e) {
      if (menuRef.current && !menuRef.current.contains(e.target)) setShowMenu(false);
    }
    document.addEventListener('mousedown', handle);
    return () => document.removeEventListener('mousedown', handle);
  }, [showMenu]);

  const btnCls = size === 'sm'
    ? 'flex items-center gap-1.5 px-3 py-1.5 text-[10px] rounded-xl font-mono font-bold border transition-all'
    : 'flex items-center gap-2 px-4 py-2 text-xs rounded-xl font-mono font-bold border transition-all';

  if (!account) {
    return (
      <>
        <button
          onClick={() => setOpen(true)}
          className={`${btnCls} bg-white/5 border-white/15 text-white/70 hover:border-lime-400/40 hover:text-white`}
        >
          {t(lang, 'connect')}
        </button>
        <ConnectModal open={open} onOpenChange={setOpen} />
      </>
    );
  }

  const addr = account.address;
  const short = `${addr.slice(0, 6)}…${addr.slice(-4)}`;

  return (
    <div className="relative" ref={menuRef}>
      <button
        onClick={() => setShowMenu(o => !o)}
        className={`${btnCls} bg-white/5 border-white/15 text-white/70 hover:border-lime-400/40 hover:text-white`}
      >
        <span>{short}</span>
        <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor" className="opacity-50">
          <path d="M5 7L1 3h8z"/>
        </svg>
      </button>
      {showMenu && (
        <div className="absolute right-0 top-full mt-1.5 w-44 bg-[#111] border border-white/10 rounded-xl shadow-xl z-50 overflow-hidden">
          <div className="px-3 py-2 border-b border-white/5">
            <div className="text-[9px] font-mono text-white/30 tracking-widest mb-0.5">{t(lang, 'wallet')}</div>
            <div className="text-[10px] font-mono text-white/60 truncate">{short}</div>
          </div>
          <button
            onClick={() => { dAppKit.disconnectWallet(); setShowMenu(false); }}
            className="w-full px-3 py-2.5 text-left text-[10px] font-mono text-red-400/80 hover:bg-white/5 hover:text-red-400 transition-colors"
          >
            {t(lang, 'disconnect')}
          </button>
        </div>
      )}
    </div>
  );
}

// ── Hero connect button ───────────────────────────────────────────────────────
function ConnectWalletHero({ lang = 'en' }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-2 px-6 py-3 rounded-2xl border border-white/10 text-sm font-mono text-white/50 hover:border-lime-400/40 hover:text-white/80 transition-all"
      >
        {t(lang, 'connectWalletToLaunch')}
      </button>
      <ConnectModal open={open} onOpenChange={setOpen} />
    </>
  );
}

// ── Language flag emoji ───────────────────────────────────────────────────────
const LANG_FLAG_EMOJI = {
  en: '🇺🇸', zh: '🇨🇳', pt: '🇧🇷', ko: '🇰🇷', vi: '🇻🇳', ru: '🇷🇺', es: '🇪🇸',
};

function FlagImg({ code }) {
  const emoji = LANG_FLAG_EMOJI[code] || '🌐';
  return (
    <span style={{ fontFamily: "'Apple Color Emoji','Segoe UI Emoji','Noto Color Emoji',sans-serif", fontSize: '13px', lineHeight: 1 }}>
      {emoji}
    </span>
  );
}

// ── Header ────────────────────────────────────────────────────────────────────
function Header({ onLaunch, lang, setLang, onToggleFeed, showFeed, onStrategies }) {
  const account = useCurrentAccount();
  const { poolSui, tradeCount } = useStats();
  const [menuOpen, setMenuOpen] = useState(false);
  const [langOpen, setLangOpen] = useState(false);
  const langRef = React.useRef(null);

  useEffect(() => {
    if (!langOpen) return;
    function handle(e) {
      if (langRef.current && !langRef.current.contains(e.target)) setLangOpen(false);
    }
    document.addEventListener('mousedown', handle);
    return () => document.removeEventListener('mousedown', handle);
  }, [langOpen]);

  return (
    <header className="sticky top-0 z-40 border-b border-white/8 bg-[#080808]/95 backdrop-blur-md">
      <div className="max-w-6xl mx-auto px-4 h-[57px] flex items-center justify-between gap-3">
        <div className="flex items-center gap-4">
          <Link to="/" className="flex items-center gap-2 shrink-0 group">
            <img src="data:image/png;base64,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" alt="SuiPump" className="w-6 h-6" style={{ filter: 'drop-shadow(0 0 8px rgba(132,204,22,0.4))' }} />
            <span className="text-sm font-mono font-bold text-white tracking-widest hidden sm:block">SUIPUMP</span>
          </Link>

          <nav className="hidden md:flex items-center gap-1">
            {[
              { label: t(lang, 'leaderboard'), path: '/leaderboard' },
              { label: t(lang, 'stats'),       path: '/stats' },
              { label: t(lang, 'portfolio'),   path: '/portfolio' },
              { label: t(lang, 's1Airdrop'),   path: '/airdrop' },
              { label: t(lang, 'whitepaper'),  path: '/whitepaper' },
              { label: t(lang, 'roadmap'),     path: '/roadmap' },
            ].map(({ label, path }) => (
              <Link key={path} to={path}
                className="px-2.5 py-1.5 rounded-lg text-[10px] font-mono text-white/35 hover:text-white hover:bg-white/5 transition-all tracking-wider">
                {label}
              </Link>
            ))}
          </nav>
        </div>

        {/* Desktop right */}
        <div className="hidden sm:flex items-center gap-2">
          <a href="https://x.com/SuiPump_SUMP" target="_blank" rel="noreferrer" className="p-1.5 rounded-lg text-white/30 hover:text-white transition-colors" title="X / Twitter">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>
          </a>
          <a href="https://discord.gg/UZ4wzDcEPN" target="_blank" rel="noreferrer" className="p-1.5 rounded-lg text-white/30 hover:text-white transition-colors" title="Discord">
            <MessageCircle size={12} />
          </a>
          <a href="https://t.me/SuiPump_SUMP" target="_blank" rel="noreferrer" className="p-1.5 rounded-lg text-white/30 hover:text-white transition-colors" title="Telegram">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z"/></svg>
          </a>
          <a href="https://github.com/cacoandrade455/suipump" target="_blank" rel="noreferrer" className="p-1.5 rounded-lg text-white/30 hover:text-white transition-colors" title="GitHub">
            <Github size={12} />
          </a>
          <div className="w-px h-4 bg-white/10 mx-1" />
          <button
            onClick={onToggleFeed}
            className={`p-2 rounded-lg transition-colors ${showFeed ? 'text-lime-400 bg-lime-400/10' : 'text-white/30 hover:text-lime-400'}`}
            title="Live Feed"
          >
            <Activity size={13} />
          </button>
          {account && (
            <button onClick={onLaunch} className="flex items-center gap-2 px-4 py-2 bg-lime-400 text-black text-xs font-mono tracking-widest hover:bg-lime-300 transition-colors rounded-xl font-bold">
              <Plus size={12} /> {t(lang, 'launchToken')}
            </button>
          )}
          {account && (
            <button
              onClick={onStrategies}
              className="flex items-center gap-1.5 px-3 py-2 rounded-xl border border-lime-400/30 text-lime-400 text-[10px] font-mono font-bold hover:bg-lime-400/10 transition-all"
              title="Trading Strategies"
            >
              <Zap size={11} /> STRATEGIES
            </button>
          )}
          <WalletButton size="md" lang={lang} />
        </div>

        {/* Mobile right */}
        <div className="flex sm:hidden items-center gap-2">
          {account && (
            <button onClick={onLaunch} className="flex items-center gap-1 px-3 py-1.5 bg-lime-400 text-black text-[10px] font-mono font-bold rounded-xl hover:bg-lime-300 transition-colors">
              <Plus size={11} /> {t(lang, 'launch')}
            </button>
          )}
          {account && (
            <button onClick={onStrategies} className="p-1.5 rounded-lg border border-lime-400/30 text-lime-400 hover:bg-lime-400/10 transition-colors" title="Strategies">
              <Zap size={14} />
            </button>
          )}
          <WalletButton size="sm" lang={lang} />
          <NotificationBell walletAddress={account?.address} />
          <button onClick={() => setMenuOpen(o => !o)} className="p-1.5 rounded-lg border border-white/10 text-white/50 hover:text-white transition-colors">
            {menuOpen ? <X size={16} /> : <Menu size={16} />}
          </button>
        </div>
      </div>

      {/* Mobile menu */}
      {menuOpen && (
        <div className="md:hidden border-t border-white/5 bg-[#080808] px-4 py-3 space-y-1">
          {[
            { label: t(lang, 'leaderboard'), path: '/leaderboard' },
            { label: t(lang, 'stats'),       path: '/stats' },
            { label: t(lang, 'portfolio'),   path: '/portfolio' },
            { label: t(lang, 's1Airdrop'),   path: '/airdrop' },
            { label: t(lang, 'whitepaper'),  path: '/whitepaper' },
            { label: t(lang, 'roadmap'),     path: '/roadmap' },
          ].map(({ label, path }) => (
            <Link key={path} to={path} onClick={() => setMenuOpen(false)}
              className="block px-3 py-2 rounded-lg text-[11px] font-mono text-white/40 hover:text-white hover:bg-white/5 transition-all">
              {label}
            </Link>
          ))}
          <div className="pt-2 border-t border-white/5">
            <NotificationBell walletAddress={account?.address} />
          </div>
        </div>
      )}
    </header>
  );
}

// ── Home page ─────────────────────────────────────────────────────────────────
function HomePage({ onLaunch, lang = 'en' }) {
  const { isWatched, toggle: toggleWatch } = useWatchlist();
  const account = useCurrentAccount();
  const { tokens, loading, error } = useTokenList();

  const [curveStates, setCurveStates] = React.useState({});
  React.useEffect(() => {
    if (!tokens || tokens.length === 0) return;
    let cancelled = false;
    async function loadCurveStates() {
      const IURL = import.meta.env.VITE_INDEXER_URL || '';
      if (!IURL) return;
      try {
        const res = await fetch(`${IURL}/tokens/stats`, { signal: AbortSignal.timeout(8000) });
        if (!res.ok || cancelled) return;
        const rows = await res.json();
        const map = {};
        for (const s of rows) {
          const token = tokens.find(t => t.curveId === s.curve_id);
          if (!token) continue;
          const reserveSui    = Number(s.reserve_sui ?? 0);
          const tokenDrain    = curveShapeFor(token.packageId).drainSui;
          const progress      = Math.min(100, (reserveSui / tokenDrain) * 100);
          map[s.curve_id]     = { reserveSui, progress, lastTradeTime: s.last_trade_time || 0, graduated: s.graduated ?? false };
        }
        if (!cancelled) setCurveStates(map);
      } catch {}
    }
    loadCurveStates();
    const timer = setInterval(loadCurveStates, 15_000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [tokens]);

  const stats = useStats();
  const tokenStats = useTokenStats(tokens);
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState('newest');
  const [suiUsd, setSuiUsd] = useState(_suiUsdCache);

  const SORT_OPTIONS = [
    { id: 'newest',     label: t(lang, 'newest') },
    { id: 'trending',   label: t(lang, 'trending') },
    { id: 'last_trade', label: t(lang, 'lastTrade') },
    { id: 'volume',     label: t(lang, 'volumeSort') },
    { id: 'market_cap', label: t(lang, 'marketCap') },
    { id: 'trades',     label: t(lang, 'tradesSort') },
    { id: 'progress',   label: t(lang, 'progress') },
    { id: 'oldest',     label: t(lang, 'oldest') },
    { id: 'watchlist',  label: '⭐ WATCHLIST' },
  ];

  useEffect(() => {
    refreshSuiUsd().then(p => setSuiUsd(p));
    const timer = setInterval(() => refreshSuiUsd().then(p => setSuiUsd(p)), 30_000);
    return () => clearInterval(timer);
  }, []);

  const filtered = tokens.filter(tok => {
    if (!search.trim()) return true;
    const q = search.toLowerCase().trim();
    if (tok.name?.toLowerCase().includes(q)) return true;
    if (tok.symbol?.toLowerCase().includes(q)) return true;
    if (q.startsWith('0x') && tok.curveId?.toLowerCase().includes(q)) return true;
    return false;
  });

  const crownCurveId = React.useMemo(() => {
    if (search.trim()) return null;
    let best = null, bestVol = 0;
    for (const tok of tokens) {
      const vol = tokenStats[tok.curveId]?.volume ?? 0;
      if (vol > bestVol) { bestVol = vol; best = tok.curveId; }
    }
    return bestVol > 0 ? best : null;
  }, [tokens, tokenStats, search]);

  const showLastTradeHint = sort === 'last_trade';

  const sorted = [...filtered].sort((a, b) => {
    const sa = tokenStats[a.curveId];
    const sb = tokenStats[b.curveId];
    const mcap = (curveId, pkgId) => {
      const cs = curveStates[curveId];
      if (!cs) return 0;
      const shape = curveShapeFor(pkgId);
      const totalPoolSui = cs.reserveSui + shape.virtualSui;
      return totalPoolSui;
    };
    switch (sort) {
      case 'newest':     return (b.timestamp || 0) - (a.timestamp || 0);
      case 'oldest':     return (a.timestamp || 0) - (b.timestamp || 0);
      case 'trending':   return (sb?.recentTrades || 0) - (sa?.recentTrades || 0);
      case 'last_trade': return (curveStates[b.curveId]?.lastTradeTime || 0) - (curveStates[a.curveId]?.lastTradeTime || 0);
      case 'market_cap': return mcap(b.curveId, b.packageId) - mcap(a.curveId, a.packageId);
      case 'volume':     return (sb?.volume || 0) - (sa?.volume || 0);
      case 'trades':     return (sb?.trades || 0) - (sa?.trades || 0);
      case 'progress':   return (curveStates[b.curveId]?.progress || 0) - (curveStates[a.curveId]?.progress || 0);
      case 'watchlist':  {
        const wa = isWatched(a.curveId) ? 1 : 0;
        const wb = isWatched(b.curveId) ? 1 : 0;
        if (wb !== wa) return wb - wa;
        return (b.timestamp || 0) - (a.timestamp || 0);
      }
      default: return (b.timestamp || 0) - (a.timestamp || 0);
    }
  });

  return (
    <div>
      {/* ── Hero banner — always visible ── */}
      <div className="mb-8 relative overflow-hidden rounded-3xl border border-white/5" style={{ background: 'radial-gradient(ellipse 80% 60% at 50% 0%, rgba(132,204,22,0.08) 0%, transparent 70%), #0a0a0a' }}>
        {/* Grid overlay */}
        <div className="absolute inset-0 opacity-[0.04] pointer-events-none" style={{ backgroundImage: 'linear-gradient(rgba(132,204,22,1) 1px, transparent 1px), linear-gradient(90deg, rgba(132,204,22,1) 1px, transparent 1px)', backgroundSize: '40px 40px' }} />
        {/* Glow behind logo */}
        <div className="absolute top-0 left-1/2 -translate-x-1/2 w-64 h-64 rounded-full pointer-events-none" style={{ background: 'radial-gradient(circle, rgba(132,204,22,0.15) 0%, transparent 70%)' }} />

        <div className="relative flex flex-col items-center text-center px-6 py-10 gap-3">
          {/* Real logo + gradient name */}
          <div className="flex flex-col items-center" style={{ gap: 0 }}>
            <img src="data:image/png;base64,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" alt="SuiPump" className="w-48" style={{ filter: 'drop-shadow(0 0 32px rgba(132,204,22,0.6))', marginBottom: '-8px' }} />
            <span className="text-5xl font-black tracking-tight leading-none" style={{ fontFamily: "'Space Grotesk', sans-serif", letterSpacing: '-0.02em', background: 'linear-gradient(135deg, #84cc16 0%, #ffffff 50%, #84cc16 100%)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', backgroundClip: 'text' }}>SUIPUMP</span>
          </div>


          {/* Divider */}
          <div className="w-12 h-px bg-lime-400/30 my-1" />

          {/* Tagline */}
          <h1 className="text-lg font-semibold text-white/90 max-w-sm" style={{ fontFamily: "'Space Grotesk', sans-serif" }}>
            {t(lang, 'heroTagline')}
          </h1>
          <p className="text-[11px] font-mono text-white/35 tracking-wide">{t(lang, 'heroSub')}</p>

          {/* Catchphrase */}
          <p className="text-sm font-black tracking-widest mt-1" style={{ fontFamily: "'Space Grotesk', sans-serif" }}>
            <span className="text-white">LAUNCH. BUILD. PUMP.</span> <span className="text-lime-400">EARN.</span>
          </p>

          {/* CTA */}
          {account ? (
            <button onClick={onLaunch} className="mt-2 flex items-center gap-2 px-8 py-3 bg-lime-400 text-black text-sm font-black tracking-widest hover:bg-lime-300 transition-all rounded-2xl shadow-lg shadow-lime-400/20 hover:shadow-lime-400/40" style={{ fontFamily: "'Space Grotesk', sans-serif" }}>
              <Plus size={14} /> LAUNCH A TOKEN
            </button>
          ) : (
            <div className="mt-2 flex flex-col items-center gap-2">
              <ConnectWalletHero lang={lang} />
              <MobileWalletButtons />
            </div>
          )}
        </div>
      </div>

      <StatsBar stats={stats} />

      <div className="flex flex-wrap gap-2 mb-4">
        <div className="relative flex-1 min-w-[200px]">
          <Search size={12} className="absolute left-3 top-1/2 -translate-y-1/2 text-white/20" />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder={t(lang, 'searchTokens')}
            className="w-full bg-white/[0.04] border border-white/8 rounded-xl pl-8 pr-4 py-2.5 text-xs font-mono text-white placeholder-white/20 focus:outline-none focus:border-lime-400/30 transition-colors"
          />
        </div>
      </div>

      <div className="flex flex-wrap gap-1.5 mb-4 overflow-x-auto scrollbar-hide">
        {SORT_OPTIONS.map(opt => (
          <button key={opt.id} onClick={() => setSort(opt.id)}
            className={`shrink-0 px-3 py-1.5 rounded-lg text-[10px] font-mono font-bold transition-colors ${
              sort === opt.id
                ? 'bg-lime-400 text-black font-bold'
                : 'bg-white/5 text-white/30 hover:bg-white/10 hover:text-white/60'
            }`}>{opt.label}</button>
        ))}
      </div>

      <div className="mb-3 flex items-center justify-between">
        <div className="text-xs font-mono text-white/30 tracking-widest">
          {loading ? t(lang, 'loadingTokens') : `${sorted.length} ${t(lang, 'tokensLaunched')}${search ? ` ${t(lang, 'tokensFound')}` : ''}`}
        </div>
        {showLastTradeHint && (
          <div className="text-[10px] font-mono text-white/35">{t(lang, 'sortedByLastTrade')}</div>
        )}
        {sort === 'market_cap' && (
          <div className="text-[10px] font-mono text-white/35">{t(lang, 'marketCapFormula')}</div>
        )}
      </div>

      {!search.trim() && crownCurveId && (
        <CrownBanner
          token={tokens.find(tok => tok.curveId === crownCurveId)}
          stats={tokenStats[crownCurveId]}
          curveState={curveStates[crownCurveId]}
          suiUsd={suiUsd}
        />
      )}

      {error && (
        <div className="rounded-2xl border border-red-500/20 bg-red-950/20 p-4 text-xs font-mono text-red-400 mb-4">{t(lang, 'failedToLoad')} {error}</div>
      )}

      {loading && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {[...Array(6)].map((_, i) => <SkeletonCard key={i} />)}
        </div>
      )}

      {!loading && sorted.length === 0 && !error && (
        <div className="rounded-3xl border border-white/10 p-16 text-center">
          <div className="text-5xl mb-4">{search ? '🔍' : '🔥'}</div>
          <div className="text-sm font-mono text-white/40 mb-2">{search ? `No tokens matching "${search}"` : t(lang, 'noTokensYet')}</div>
          {!search && <div className="text-xs font-mono text-white/35">{t(lang, 'beFirstToLaunch')}</div>}
        </div>
      )}

      {!loading && sorted.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-y-6 gap-x-3">
          {sorted.map((rawToken) => {
            const token = applyLocalOverrides(rawToken);
            return (
              <TokenCard
                key={token.curveId}
                token={token}
                stats={tokenStats[token.curveId]}
                curveState={curveStates[token.curveId]}
                isCrown={token.curveId === crownCurveId}
                suiUsd={suiUsd}
                isWatched={isWatched(token.curveId)}
                onToggleWatch={toggleWatch}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Token page wrapper ────────────────────────────────────────────────────────
function TokenPageWrapper({ lang, tradeKey }) {
  const { curveId } = useParams();
  const navigate = useNavigate();
  const [tokenType, setTokenType] = useState(null);
  const [packageId, setPackageId] = useState(null);
  const [initialSharedVersion, setInitialSharedVersion] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!curveId) return;
    let cancelled = false;
    async function load() {
      const IURL = import.meta.env.VITE_INDEXER_URL || '';
      try {
        if (IURL) {
          const res = await fetch(`${IURL}/token/${curveId}`, { signal: AbortSignal.timeout(5000) });
          if (res.ok) {
            const d = await res.json();
            const tokenType = d.tokenType || d.token_type;
            const packageId = d.packageId || d.package_id;
            const isv = d.initialSharedVersion || d.initial_shared_version || null;
            if (tokenType) {
              if (!cancelled) {
                setTokenType(tokenType);
                if (packageId) setPackageId(packageId);
                if (isv) setInitialSharedVersion(isv);
              }
              return;
            }
          }
        }
        if (!cancelled) setError('Could not determine token type');
      } catch (err) {
        if (!cancelled) setError(err.message || String(err));
      }
    }
    load();
    return () => { cancelled = true; };
  }, [curveId]);

  if (error) return <div className="text-xs font-mono text-red-500 p-8">Failed to load token: {error}</div>;
  if (!tokenType) return (
    <div className="rounded-2xl border border-white/5 bg-white/[0.02] p-8 animate-pulse">
      <div className="h-4 bg-white/5 rounded w-48 mb-3" />
      <div className="h-3 bg-white/5 rounded w-32" />
    </div>
  );
  return <TokenPage curveId={curveId} tokenType={tokenType} packageId={packageId} initialSharedVersion={initialSharedVersion} onBack={() => navigate('/')} lang={lang} tradeKeypair={tradeKey?.keypair ?? null} tradeKeyReady={tradeKey?.isReady ?? false} />;
}

// ── 404 ───────────────────────────────────────────────────────────────────────
function NotFoundPage({ onBack }) {
  return (
    <div className="min-h-screen bg-black flex flex-col items-center justify-center gap-6 px-4">
      <div className="text-lime-400 font-mono text-6xl font-bold">404</div>
      <div className="text-white/50 font-mono text-sm tracking-widest text-center">PAGE NOT FOUND</div>
      <div className="text-white/25 font-mono text-xs text-center max-w-xs">
        This token or page doesn't exist. It may have been moved or the address is invalid.
      </div>
      <button
        onClick={onBack}
        className="px-6 py-2.5 bg-lime-400 text-black font-mono text-xs font-bold rounded-xl hover:bg-lime-300 transition-colors tracking-widest"
      >
        BACK TO HOME
      </button>
    </div>
  );
}

// ── App root ──────────────────────────────────────────────────────────────────
export default function App() {
  const navigate   = useNavigate();
  const account    = useCurrentAccount();

  const [showLaunch,     setShowLaunch]     = useState(false);
  const [showStrategies, setShowStrategies] = useState(false);
  const [showFeed,       setShowFeed]       = useState(false);
  const [lang, setLang] = useState(() => localStorage.getItem('suipump_lang') || 'en');

  const handleLang     = (code) => { setLang(code); localStorage.setItem('suipump_lang', code); };
  const handleLaunched = ({ curveId }) => { setShowLaunch(false); navigate(`/token/${curveId}`); };

  const { tokens: allTokens } = useTokenList();
  const tradeKey = useTradeKey();

  // Strategy hooks lifted to app level — survive modal open/close
  // Only stop when the browser tab is closed
  const sniper    = useSniper({    walletAddress: account?.address, keypair: tradeKey.isReady ? tradeKey.keypair : null });
  const dca       = useDCA({       walletAddress: account?.address, keypair: tradeKey.isReady ? tradeKey.keypair : null });
  const copyTrade = useCopyTrade({ walletAddress: account?.address, keypair: tradeKey.isReady ? tradeKey.keypair : null });
  const rebalance = useRebalance({  walletAddress: account?.address, keypair: tradeKey.isReady ? tradeKey.keypair : null });

  return (
    <div className="min-h-screen bg-[#080808] text-white" style={{ fontFamily: "'JetBrains Mono', ui-monospace, monospace" }}>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;700&family=Space+Grotesk:wght@700&display=swap');`}</style>
      <div className="fixed inset-0 pointer-events-none opacity-[0.03]" style={{
        backgroundImage: 'linear-gradient(rgba(132,204,22,1) 1px, transparent 1px), linear-gradient(90deg, rgba(132,204,22,1) 1px, transparent 1px)',
        backgroundSize: '60px 60px',
      }} />
      <ScrollToTop />
      <Header onLaunch={() => setShowLaunch(true)} lang={lang} setLang={handleLang} onToggleFeed={() => setShowFeed(o => !o)} showFeed={showFeed} onStrategies={() => setShowStrategies(true)} />
      <NetworkBanner />
      <StrategiesLockedBanner tradeKey={tradeKey} onOpenStrategies={() => setShowStrategies(true)} />

      <main className="max-w-6xl mx-auto px-4 py-6">
        <Routes>
          <Route path="/" element={<HomePage onLaunch={() => setShowLaunch(true)} lang={lang} />} />
          <Route path="/token/:curveId" element={<TokenPageWrapper lang={lang} tradeKey={tradeKey} />} />
          <Route path="/airdrop" element={<AirdropPage onBack={() => navigate('/')} lang={lang} />} />
          <Route path="/stats" element={<StatsPage onBack={() => navigate('/')} lang={lang} />} />
          <Route path="/whitepaper" element={<WhitepaperPage onBack={() => navigate('/')} lang={lang} />} />
          <Route path="/leaderboard" element={<LeaderboardPage onBack={() => navigate('/')} lang={lang} />} />
          <Route path="/portfolio" element={<PortfolioPage onBack={() => navigate('/')} lang={lang} />} />
          <Route path="/roadmap" element={<RoadmapPage onBack={() => navigate('/')} lang={lang} />} />
          <Route path="*" element={<NotFoundPage onBack={() => navigate('/')} />} />
        </Routes>
      </main>

      <footer className="max-w-6xl mx-auto px-4 py-8 border-t border-white/5 mt-8">
        <div className="flex items-center justify-center gap-4 mb-3">
          <a href="https://x.com/SuiPump_SUMP" target="_blank" rel="noreferrer" className="text-white/25 hover:text-white/60 transition-colors">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>
          </a>
          <a href="https://discord.gg/UZ4wzDcEPN" target="_blank" rel="noreferrer" className="text-white/25 hover:text-white/60 transition-colors">
            <MessageCircle size={12} />
          </a>
          <a href="https://t.me/SuiPump_SUMP" target="_blank" rel="noreferrer" className="text-white/25 hover:text-white/60 transition-colors">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z"/></svg>
          </a>
          <a href="https://github.com/cacoandrade455/suipump" target="_blank" rel="noreferrer" className="text-white/25 hover:text-white/60 transition-colors">
            <Github size={12} />
          </a>
        </div>
        <div className="text-[10px] font-mono text-white/35 text-center tracking-widest">
          {t(lang, 'footerText')}
        </div>
      </footer>

      {showLaunch && (
        <LaunchModal onClose={() => setShowLaunch(false)} onLaunched={handleLaunched} lang={lang} />
      )}
      {showStrategies && (
        <StrategiesModal
          onClose={() => setShowStrategies(false)}
          tradeKey={tradeKey}
          sniper={sniper}
          dca={dca}
          copyTrade={copyTrade}
          rebalance={rebalance}
        />
      )}
      {showFeed && (
        <LiveFeedSidebar tokens={allTokens} onClose={() => setShowFeed(false)} />
      )}
    </div>
  );
}
