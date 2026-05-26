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
            <img src="data:image/png;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/4gHYSUNDX1BST0ZJTEUAAQEAAAHIAAAAAAQwAABtbnRyUkdCIFhZWiAH4AABAAEAAAAAAABhY3NwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAA9tYAAQAAAADTLQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAlkZXNjAAAA8AAAACRyWFlaAAABFAAAABRnWFlaAAABKAAAABRiWFlaAAABPAAAABR3dHB0AAABUAAAABRyVFJDAAABZAAAAChnVFJDAAABZAAAAChiVFJDAAABZAAAAChjcHJ0AAABjAAAADxtbHVjAAAAAAAAAAEAAAAMZW5VUwAAAAgAAAAcAHMAUgBHAEJYWVogAAAAAAAAb6IAADj1AAADkFhZWiAAAAAAAABimQAAt4UAABjaWFlaIAAAAAAAACSgAAAPhAAAts9YWVogAAAAAAAA9tYAAQAAAADTLXBhcmEAAAAAAAQAAAACZmYAAPKnAAANWQAAE9AAAApbAAAAAAAAAABtbHVjAAAAAAAAAAEAAAAMZW5VUwAAACAAAAAcAEcAbwBvAGcAbABlACAASQBuAGMALgAgADIAMAAxADb/2wBDAAUDBAQEAwUEBAQFBQUGBwwIBwcHBw8LCwkMEQ8SEhEPERETFhwXExQaFRERGCEYGh0dHx8fExciJCIeJBweHx7/2wBDAQUFBQcGBw4ICA4eFBEUHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh7/wAARCAGDAXkDASIAAhEBAxEB/8QAHQABAQACAgMBAAAAAAAAAAAAAAECCAUHAwQGCf/EADcQAAIBAwMDAgQEBQMFAQAAAAABAgMEEQUGIRIxQQdRCBMiYTJCcYEUFSNSoTORsRYkNEPBcv/EABsBAQEBAAMBAQAAAAAAAAAAAAABAgQFBwMG/8QALBEBAAICAQQCAgEEAwADAAAAAAECAxEEBRIhMQZBEyIyFFFhcYGhsULB4f/aAAwDAQACEQMRAD8A05CBUYmQABkAAAAAAFXYoEXcoAAAAAAAABdJ3AKkMDR3IC4GBo7kBcDA0dyAuBgaO5AXAwNHcgLgYQ0bQADSgAGgAA0AAGgZiZADEGRGBAAUAAQRgvkYGxMGWCAgAAAAAKkMBdigAAAABUmdAASGjYEMFSGjZgLuAVkAAAAAAAAAAAAAAwAGBgALEmAwAu0AAUAAAAEkDEyIyCAuA0BAAAAAAAAAgVIAwigAAAAAAAIpYZlCoAqBSAAAAaAADQAAaAADQAAaAADQCkAAAAAAICgNbQBgGwAEk2AAi7CNlI0BAXBAAAAAACopEUAAAAANACpDAEXcowAzIAAgAVAQGWPsMfYNsQZY+wwASGACwkmBgAzO1gwMAE3KyYGADSBCgMyxBlj7B9gjEAAAAAAAAhSAAAFgABGkfYhX2IQAAAKMF7AAAAAASQq7EKuxpkAANgAAFIZIDFlRRkAAA2AAgAAkbjyuhLqfSnhvsEpdXTLCaCTk8RWZe/sZdKfEuZr2Pp+SIh85nTHDUmmRPH4jLlqXU8YQcISp5Ty/YzvuarO0bWM9wnkRmlBxUckTyh9bVQARmQAFIgAAaQhcDAYQFwQAAABCkYWAAEloABBiC4GAKGAAAI+xUkyUiRkkNJtMFQBUAAALgLuULEJgyRAFiF4IAGtGAXJGwxsyCYKu5quoiWq+TzgeRiWeqPLPa0ewutSvIWlpSlUrVZKKil2MZL17d/2TJbthlpNhd6lfU7OzpynUm8fSsmw/p58P1G40+nf6xcThUksuB9j6H+ktltrTqeqarBVbyUc9LXKZ29GbawoOnBLCTR+A658jtjyxhwz7/wC3W5c0ugd7fD1pr06dxo1xN3KjlQ92a07i0i60fU61pcxcZ0pdL4P0WX9JKc+Y+DU34tNDp6Zum3u7ajinWpuc3jzk5Hx3rGbPl/FklvDkl0a30tOPKDeStYnjwg2nyj91T9radhTzCAeALTEz4Y3sABlsAAAABNDMTLBMA0mQGgEmNAwwXwEhjgFIyS1sABFAAAAAAAIClRClYkZACgUhUASKAGoAAFA+wDDMpkZCMuH3DMQJZeEF7+CtuE8L8LQeOmKXMW+WZn213drOhRqV60LeksucvBtd8PXpfQ0rTqeu6tRUrqpFOMGuEdbfDbsD+faw9Wu6f9C3msdS4ZtvRpQp0o28EowpRwkux+G+T9ZnHE4cX/Lg583d4hjUSw3FvEOEjOUmknWXEksMxpqTl1NYTM6tNxpxy+qPVznwee48eTtnNaP2dd2zthXU03KT+jwdQfFHt+d7s16i4dVSlxFo7jlH5s5RSajHv9ziN4abDXNs3VhUSb+W2k/c7Hplp4fKjPP25MX1MQ/PPmMmpc84LhR4XY5bd2lVtG1y5sqsGpRqS4x4ycSvwr3PacOWt8UXr9uzxW3B4wRhkNRGo2+mvICclH2oACgAAAAAjIXBAzIZGJchEfYmPsUElYQFwQjQAAAAKAQKhoAAViQAACoIoXQAAsQAAKAFQTQkJrMP3Anwu/gkTtN6llN9CVPu5I9rQdPranq1vplJNzrVFFHqTzw2ucHaXw26HT1je0K9SLk7VqaOPysscfFOS3p8sviNtpvTPQbbbO1bKzo01Gq6S+a8fm+59N15hFJPqcvq/Qzgo4UZQSSXLLCKU3TS/Fxk8W5vfyOVa8W8S6ms2m07eDWNQt9J024v7iUY06UG1nydRelnqrLdO8rvS601GjGUujPnD4OK+KredTT7Clt6xq4U/prNPlGueydaudA3Ta31Oo4JTXU15jnk/edO6LGfiT3+/pzIw7jb9BPmyf8AThF4jzJhxxLxhrn9Di9qarR1/QLbU7aouipBdn3aRyVTqm0qf4l3PxPOw5MGS1bzuY9ODeJi7WH4qNmTttTW4LOi/l121LC7Gv77c+OD9AvUDQKW49s3Gl16adX5bcHjs2aK7u0S50DXbqwuqco/Jm4rKxk9A+LdSjkYfwZPEw7HBkj04V9iJZRk+OfD7ES5yuzP1m53qXP142YGACTqJYiyAAsx/ZQAEhQAFAxMhgMyxBWQIAAgMhk0YsaXYACLAACqLuUi7lKAADP2AFwDQihANgACAAwAKiNFRJnQMNZ/coXHYt41qYfK3iTq6ouf9vBsV8HlnTheX15Ujy4cGuv09Din35Zsn8H9RVHf0m+0OEdH8sm1OlTavt8c9p1psfKfXF488ofMpwzXlx0rkwoJ/m4Xbkxu6anTnSjn+ouPueP8a827Jt9us3qzSP4gdUq6j6kahGU26car6V7HXzUnFSTzj/B9p600p2nqVqlGax/VZ8ZFKnnp+qMlye59PpWOLSId1ijdWyfwsb6Uqb25dVsdPFLqfubGz+qn0xeJ98o/O7a+s3OgavQ1Gzm41KMk2s9+Tef0s3Tbbt23b16VZOvGC+Ys85PxHyfpN4t+fG4GfDMW2+snUbj0pfU+GzpD4i/TuGsabU1fTqP9ems1OlfiO7ISnFfLx2fLMbqlCtRdOcFKk1iUffPB+S4PPy1yRyKxqYn0+NZ7JfnJVpOhcTp104ShLDizxvPU2vw+Dv74hfSmWmXNTXNLoudCq25xS7HQUswm6bWMeGev9O6lj5+GL1nzHt2GLL3RpCkXv4JlYTWXk5vZOtuRECLgrSTwR9jVZifBMaQACVjyAAgBgBJjbEFaATSFRCoIMxZkRghAAZagAAUXcpEU0AADP2GS7EKuwaAAAAAAq7ERV2Gk3tQQpiywBPHACjln1nU0Z1uUcelN/c7y+EbVqdjui8o1p4jWj0wT9zo7lZy+D6T0y1mroW7tPunLFNVk5/ocLnYv6njTiljNT9W/slKrUSXbA6lHo6uWpY/Q9bRb2GoaRb6hRa6asU00/sew3H8Mu7PGOZjjjZNW8al1Fo1LU/4qdtzsd1/zSMH0XUnJvB0coOMuh+XlG9/rLtKjuzZ1xS6U7mks0357Gjur2lSyv6tpUTU6UnTf7M9P+Oc6M+GKT7j/AMc/i5fD05uPSvfydi+iu+rjZ24relUrydnWklNZ4R1zCLS+X+ZFXTnjKWeX7M77kUrmr2WhzMkRMP0Z0e/paxp9K/spxnQqRTbT9z3PodRYfC7fc1O+Hv1Xq6FdQ0PWK/8A2dTEYSmzamyr293aQuLeSlQqLqhNP3PMesdLv0/JOSsbiXU5aTEsL+yttRo1La9pqpSlFpprKNWfXL0jr6TcVNY0ij12km24xXKNrJdcE3OLUF59zwXNtRvbadK6pxq0p/kaOp4HVr9P5MRjn+Xv/wDWK5NQ/OmdKSquDXRjw+540mpuMVwvc2U9avRb5kautaFBwxzKlFGuN3bXFlcypV6co1E8STXses9O6ni5lN0n/h2GHLv28TeTFsya5MWjsKx+z72nfoAAt7aj0AAKAAARlIwk+kKQBkABJWEAYI0FRCoAADQAAM/aryVERV3DQCsgBFIu5kPUbSZ8JgAueMCJ2lIB1LtgPn3MoqSi8S5E2iC09jGWKby+ckcu2O3ky6Z+HyR4T/qL6vBrdbxpiMm5M/7B57ptfcMGP4+H1t5htx8MG9I6zt/+UXNV/PtsQpxb7o7lrxwozRof6Vboq7Z3jZ3lKco0VNKaN6tLvbfUNOoXVCSlCpTTbXueY/Mek90d9fDrcuPT3YpJZ79Sw0zUX4ntmfyHcX8wtqaVC4fzG0vL5Nt1lKUpPOfB1x8RG3f5t6f1fo67inJVE17I4/x/l/h5NY2+OC2paSvPXlPnuYuPvyeSpD5VepB94tox7nrFdTWLO1rO4KblGSlF9LTymvB3z6C+r1fSZQ0jW6iqW3EYOT5R0I1jxkypqdGcatKbk+7S8HE5XGryqTFoYvj3D9GrS9tL3T6d5a1FWp1FlJPODyyxmLSan7Gnfo/6wattm6hZ3k517JvDTfZG2u19d03cemQv9Mrwm5xz0p9jznrPQr0nuxw6zJhmJ25GahUg1NdafE4+Don179JqGoWtXW9EopVoxcpwijvSE+hS6FmfnArYlQ6XTTjLKnFnT4OpX6feL1nxHsx3mr85bu2q2lxUoV4uM4yxJM8ST6nOX4cYRsP8Rvpf/Cz/AJ/pFHNOonOrGK7M16q9TbpyykuMezPVOl9Sp1DBXNjl2GPJthFYj+pGVJx4ZJHZ+/L7gANQ1AABIEZSMiT6QABkABJWEYKu5CNBUQqAAA0AADP2qKu5EVdw0rIVkADIAn0kx4VFSTn093jJI/4DeWvlP6hFfGyttPYsLSveV6NtQhKdarLpSSNkfTX0Htf5XTv9ck/mVIqSg12OG+F/YEtSuJa/qNDqo0vqpZXk2ig3RhFwSlTXHTg/D9f65OG048c+nXcjkal0fu70D0e606dbT6vya8VmMY+TWTdmiXWg6zX0+6g1OjLGX5P0IpT6bl1HJ4f5fBqt8WOm0bTXqN1CkoSrt5aXc4vxTrWXlXml58f5TBfdnRMXlZZUWOEsE7eT0Kbbu7OfTKMn86MoL6oNN/qjc/4a9Xlqnp/QlWm5ShPpeTSyacYupD9zbP4SVKWzpJ/6aln9z838srW3DmXF5MR2u76jTm3J45PQ3BaxuNt6nGo+tO2njP6Hv4U4Zb5PBqqnHQr3jj5Ev+DzHg1mnLpMOtw286fnpuKiqGsXFF/lqy/5PR7HO78hBbovel/+xv8AycEe1YJm2Osu2xxOgkU4ybi8Z7lByL236fXbHD/LJo7G9HfUbUNnaxTU60p2TaU4t8ROu+MrwHFyjKXt2XufLJirkx9tvt870i0P0O25rllr+lUtTsZxca0c/T4b8HJThKNFQbzNd17mpfw3+pUtD1SlomqVc2lV/Rl9n4RtrQlTrpXPVmdRKUcPwzy/rnRK8a81+rOsy45pO3qanp1vqOm1bS5SnCrFpp+DSj1m2bW2ruitGMH/AA1RuSeOxvD0/U6ufpjL6jrL4idow3Jtid7QpL51CLk2l4J8Z5/9Bk/Bv9WsOXTSyP1POcoi5eGeS4pu2qypSWHFnj78nqdZjxMOyrO4HjPBBjANQ3HoABVCMpGEn0gADIACSsBCkI0BAAUBFfg0IAAz9qiruRFXcNKyFZAABGSVifpmvbwe/t/T6mo6xbWdCHV8yok8HHo7O+HDRnq/qFQjOOaUI9T/AFON1HkTx+JfJH1Dj557K+G2np3odPbW2rbTqKTSgpNry2j6DoUajqOXL/IYwj8u3hTXDisGVWeKaeOex43lzfnmct58upv+0+XjfTTl1S/C3/sdR/E7s+ruLbdLU7OGalom8JcyO4ZqLpJd2/B4lGjdQnb3cU4Yx0tcHy6fz56Zy4mPUmOe3zD85q1GrQqunWpuE13TR45NYZt56g+iGj61eVbywxSqzbeEsI6/pfD1qqryVSdN0m+OeT0/D8l4eotedS59ORMx5dGaNZ3F/fU7S0pOrKrJLGMm73ortiW29lW1j0YqzfVPPdHF+mvpDoO0+i7rQ+fdv356Ts+EIKmkl0yXZI/Ndd65TmT+HH/H/txs+abeEq4i3yk/KOP3ReQs9r6hWqy6Yfw00n98HIU4RdVVJvMl4Onvif3ZDS9tS0ihcRV1Vabw/DOo6DxMnL5O7R4j0zgpG2pm4K7udZuLjqbUqkv+T0iyk23lNNvLfuQ9ep+mOKQ7akagAAjwoWKa5T7EDw4OOcN9jUeZI9vJZ1Z211G8pSaqwn1Jexuf8Pe7nuTbFOFefVeUo4km+yRpZTpqM1Fyz9J258Me46mj7s/g6tV/LuZKKWTqOscamfBabfT4Z6RaNtxI0sx+W5YUuX+uTxXtGN3YV7accxqxdPB5HnKkuzRkn0ySPHq92KZj/Lq96s0S9YdAnom+L+yUMU41H0v3Piljpwv0NhPi80SNnqVrqdKOJ3Lbka9PHRhd85PZ+kZfz8Os/cOzxW/Uw13Ay2uQc+PXlyvoABr6AjKRhJ9IAAyAAkrAQpCNAAKKivwRFfgogADP2qKu5EVdwu1ZCsgUI+5RjIn0kfyIv3Ni/hCsIyqV79JfMhPGceDXTwbS/BxCP/Td9Ua5VbB1XXZ1wL/6cblenflRv5sJPtLuZTWM9X4CR5ryf5V2LVbdpce3ypv/AAzxriU747bOs9ylCpTry6rdqTXhPPYzjGEnKVSP1GpNj6t61tTe15SrVJVrRV5RxJ9lk2A2N6nba3PQp4uY0rmWPplLCyfreV8emMdb1jb7VxPtcJvD+lIxqzg+IxXHkJ2tR9UbqlP/APM0xOnT6epTS/VnQ8nh8+vjHVi1ZrLxTlKUo5pNPwzzqLpzjj65fY8cbi0pUZ1Li8ow6PEppHXW/fWPbu3LarTta0a95hpRzlHI6d8dz9/5Ms7mVjFNn2G9tyadtbRri/v6sYVOn6I58mj/AKlbqud2a7cX13UbgpONKOfHg9r1E9QtX3jeyqXNecKSfFNPg+MiuqXPKPSOmdKpwo7teXNw4u0Um6Si+yBZ4TwjE7u3qLOXPiFBCmUBGMZfU3hog4znIFpxScnJ8+DnNgXU6G8dMqRbi4V03/ucHU5mmj39uya3BZOPEvmLlfqfPkVicN/9Sxkj9X6EaTcxudFtq68wTPbfMlJe3k4XZTctq6e33+UsnL1lmpFrhfY8U6hEbnt/u6af5Olviusv4rb9pcS/9UX/AMGo8U3Jvwjc34m4J7P60+MGmdSSUm129j0z4he39Nqzs8P8YRPIRG+exUz9Lkhy5kBcEL/8YTYRlIyJMoAAgACSsBC5IRoABYFRX4IisogADEqirvkiKgDAAbgABqv7fqzryGzHwf3qhpl5aZ5dXODWd/8Aw7x+EjUo093rTXjNRdR1PW8U24OSv+HHz0m0NsoLDX+TGrH+jVk/NOSx+zLKTUXhfU1wjKok402nh4xJHjHdMYotHuNf+usiO23lob6u2krXel7SqJRTquWP1Plba+vLWf8A2VapSSfLUjt74qdFnYb6lcqn/SnTTzjydORzFZT790e2dOyUz8Sk1h2nHiLQ+y0b1J3NpVFQoX85Y/ubZzD9ad6VKXQ72K/ZnWnCfbgkuTk/grMa0+mTFD6rXN97h1mLdze1U14jJrJ81UuK9eo6terNzf8Ae8njnmWA8vvz9zVceOtZ8eWq0rWCfLz2/QsXjwRMPk+ka7NNbjSSy5FGQLW9Qe0KQEnwxMhVDqWexB46UzG1iV/c5XZtF3O69OpJfirRRxKSg++T7v0Q0mer74sZU4/+PVU58eEfHmX7MF5/xLGa2qt1tsUHbaHa0H+WmjkV+B57mOI0ben0/wBq4PIo8KPvyeMZ577T/t1G4mzpv4qbr+H2pQo5x81cGnz/AAv9TZv4xNT6qOm2sO8cpr9jWRLh/dHqnQcH4uLEx9uzx01WEk+p5RexE8xxjDK12O/rOq6lyFyQIGIiUkIw2QoAAAAGSVhAARoAABdykXcq7gAAWGJDJdjEyKAADcAAHr9liTyfZejWsvQt/Wd71dKb6P8Adnxp5rKtK3u6NZPEoTUv9j558f5KTT+745Y8P0ZoVVVtbe5jz1xTz+xnCKlWk84Xf9z4b0R3FDcmyLS6lV660Uk4t/Y+6VOKn09fMsv7I8Z6hxb8TnXrP8IdTkidunfih2vW1fasdRoU+qrRlmTS8I1BlFqcl7M/RbVrSOq6Zc2FWmpwrQdPnxwaN+rG06+1903dr8uSt+vNOTXDR+3+LdQ3WcVp/wAx/wDbk8fJqXxZWTsnxwHJJZaP2lscz+0enY921BF7lMeZ8ygAAAALCxKAdgnnLwZ+07YULHy5N9yR5zjuOG0s8s+kxEV3CzERBHpck5PnGUjZj4S9sKjGtrtem3GrHphlHQWzdDuNd3FbWNClKfVNJ4Xg3q2Xt2jtrQbfSaEUnGnGT+zayfkflnU4w4q4cfuXDz3jXhzUcS+Z+vB5ozj09cmkkvJ4pJxXCyvJwnqJqtDQ9p3V1UqqnKVN9HPdnn3TsFs1vxR/d1+KvdZqf8SuuvUt9XNrCfVToVHFYZ1RPhZ++Dk9x6hU1TWLq+rSzOpNvnzycZJZpJecnsvAw/hxUp/aHcVjVYhWCvx+hDkWl9AMAqSxBWQIFRCoAzFmTZiyS1AACNgADIVdyBFSVAAZAAUVdikRQ1AACx58SzM+Tx9ySTnDD/Fn/Ays5Mk/r613xhFtOp3DUz4d0fDPvV6Nr38muKvTQr4hTy/Jt3mNanDDXy2s5R+cOnXdzY3NK7pSca1KWYNG6noLvm23TtqjTrVk72jHplBvls/GfKukRlwzekbmfbgZ8f3DseEpKp1x/DB8HXvrVsGz3loNe7hT6b2jH+mku/c7Ek6kU/p5/tIq0cRkqbfGJRPwfG5duHmiJ8acSs9svzu17SrrS9SnY3kJU50304ax2OP5Saku3Y3F9cPSe13JbT1PS6cY3eOpqK5bNUdx6FqGh307W/oyhOLa5Xc9T6T1rHzMfZE/tHuHOx5XELkobWcdiHcRvXpy9xpSApdCFAJuY9p5/sfqY56JrK4Zf8httYX1f/D6zWO3ZM6Wp0KSznD9j2LOzr3l1ClRg5t8JRWWeTS7C6v7iFra0J1pzaWIrJs96G+jsdLdPWtYUHVwnCEl+H9Tp+f1GnExzMz5cXLm1GnI/D/6aQ0DTqer6pTX8RVj1Um1yjueEZ9PTL/fyYf01KNJRUKSXjtn7GU5SlJRi2vHV7nkubnX53InJad6cK9twy6frjD8vk1s+KjfMasv+nbSqpOnltpncnqvvGjs/bVe4qtRuZQaprPL4NHdx6vW1rVq9/Wm51JybTfsftfjfSt3/Paun34mLzuXFR6n9T74wVdyLOOeGU/eR727G3sABi0eVDEyMTUxEMyAAgFRAAZC5IRsABDYAAAAApV3MclCSrIAaZXIyQAXJTEEAqzgYKXcwK8vjKPo/T3dl5tLXqN9a1ZpKS64p8NHzf6lgl1Zn+E+d6ReupSa9z9AfTvd1hvHQqV3b1ofO6MTj1c5PoJpQn0wfD7tmh3ptvrVNoaxC5t6r/hvzRb4aNx/TnfWj7y0lVbWrFXDSbgnyfgvkXx62Sv5MLg5sWvL6uCkm+nsvc+M9QfTvRN320o16FOnctf6qWGmfaSi6a6Wmn9zBqp1JJ9/J+M4vIycS/bXcWhx43DTff3oxrmhVqlazpyubeLb6vJ1jdWN3bVpUatCrBrv1Qwfotc29GtS+XVhGpF98nye5vTzb24Wo3dpRpwfd0kkz9jwflWbDGuTG/8AP2+tc8w0Ma6cx9hGUXHk2v134ftCnVbsHOEV5lI+Wuvh5vW3/DV49OfJ3WP5ZwLTqbTE/wCn2rydfTXeOc57lTjlvz7Gwlr8O+ouX9W4pr9z6PQvh80lVV/M5ylju4SN5vlXAp4m22/6tq9b21W5qJU6VSUn4jFs7C2J6Sbg3DWhJUJ0aMuXJ8cG0u2vSzaehSira1jUkl+KeHg+xt7Ojax6LeFOnTS5cUlk6nn/ACi011g8f9uNfPNnXnpz6WaJtWjCc7encXOOZzjlpnZHTCNDDklTXGIkqPNH6IuMfMmWhTbhGT/CvH9x+Oy8zk57zFvO3zj9vDFJfLXXFul+U4/dGuWm3NKq397VhGMIOUE5cs8W8dz6ZtrTal9qVenBRT6KecPJp36wepepbv1GcKdeVOyjLEY57o/R9A6DN7RkvHh9seLU+Xg9ZfUG+3frVRKcpW8W1GPVxg68glBuXZ+wi6izKMePuZRccOTfPselVw/jjtr6c+ka9I3l5YCbYHqGp8yADJAMTLJiVAAAAwGQQAEbAAAAAAAATBQAkqAgaZAAAAAFTZSFELAyrGeexB4LS/ZJXwqb+qLeYvsc3tDc2rbY1GF3plxOm0/qinwzgw3jHLz7ozkpExv6lMkdzbv0q9cdL1qnDT9bmqNw8LqZ3Pa1re7tlcWdWFWm1lNSPzejN0ZqopSi+/VF8n3uyfVLcm160J293Vr0V+Scm0fnef0DBnibUjzLi2wN5ZJwam45Xsw1RjmrnKfg6Q2V8Qml3sYw1yHy5NYeEdn6FvjbOswUra/t4Rfickj8dyfjmfjz3TO9uNOCX0MIw6MyX0vsY5hFcLBhC902v/p39vLH9s8o80alGUfpq05L3TOv/osseIo+VsUwwTWHnsIrq46OuIcqCeZ1Yr9yVL6zgsTvbenH7zwfCnS8+bffVmMMywqU/qfTF4/tPLCDSUZQzFnC6vu/bWjpzuNRoza8Rnk633j6/besIzjpLc664xJcM5vA+IZe/um0uRXBMu4qslbUnKvVjGgucNnVfqT6z6Dt62q2em143N12xn8Br/vr1j3PuOrKPz3bUXwlCbXB1pdV6lxcOtXm5yby5Pls/a8D41TDbuu5GPj9s7l9NvffGtbrvqlS+upzpZyotnyaUqjaccJGTl19lhe4k1HiMm35P1OOlMdOyrlxWF+rGFIOKxyE8BstZtE9s+liNICZGRb34QZC5IRAAABkEYDIyASVgABGgAAAYmSAAAAAAKCA0mlBF3KDQAAzMBkYgEMgYlRNKpYtKWZcogLWdQuhv6nLGY+Ey9Ta6k8Y8EAjxK+CLco5f0v3PZoX13TSVG5rU3H2m0esCTWLe2e2H1Gm763Bp9NQo31V489TOXtvV3eFCPTC+nj7nwKYyZrjpHjthmcUS7Bq+sG8aixK/lz9jidR3/uS/i1Xv6nPtJo+UyQn4a73EQsYqw9y61W/uJZrXNWeeeZs9RyVR5qdbfvkgNRStfTUViCbT4mnJeB2XHCANzbxpZ9L+XCMYuEe8ct+Sh9iMx6TPPbAyQFmV2AAjIAAAAIsRsIykfcbXQABs0AAigMQALkgAuQiADIETKAABoVAgAoIu5QzIAAgAAKCANbUEANwqL+xECG1bGTEFNsslz9jAoNwrIMkBuFBAElQQBAAAAAAAZAKTIBJagyACKAEbAoMSpgQAFgC4CKxMDEAEAqIioCgIF2AAKAyAE0ZKiFBoAATQAAgCoNAQAAAAAAAAAAAAAAAAAAAMjIXQyBgLoABJIgABFCNFI2BAAAABQBCmgAQMzAAAgyTJkgAyBF2KAAAAAjyUVFyYPJVkbVlkZIBtGTITIyNpMKBkDaaAANmgADZoAA2aAwRjZpRkgG1iFyCAbUAA2oABtAAAAAQR9yFZAAAAAeRk1EDFlAKCKRFJIAAgAAgqYyQAXJTFdzIAAAAAAAALoAAXXhOSgBkAAAAAAAAIygLAAAaAADQAAgCNjIFMS5IAAAAAAAA+xRGADUAPAAAqAEgADMgACCPuADQLuZgEkAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAI+wAEAAAAAAAAAAAgBYIAAahp//Z" alt="SuiPump" className="w-7 h-7 rounded-lg object-cover group-hover:opacity-90 transition-opacity" />
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
