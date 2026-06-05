// v18-strategies-lifted
// App.jsx  -  react-router-dom based routing
import React, { useState, useEffect } from 'react';
import { Routes, Route, useNavigate, useParams, Link, useLocation } from 'react-router-dom';
import { useCurrentAccount, useDAppKit, useCurrentClient } from '@mysten/dapp-kit-react';
import { ConnectButton, ConnectModal } from '@mysten/dapp-kit-react/ui';
import { Flame, Rocket, Plus, Gift, TrendingUp, Coins, Users, Trophy, Wallet, Search, Menu, X, Map, Copy, Crown, BarChart3, Github, MessageCircle, Bell, Star, Zap, Activity, ChevronRight, AlertTriangle, Bot } from 'lucide-react';

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
import AgentPage from './AgentPage.jsx';
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
import { useLimitOrder } from './useLimitOrder.js';

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
const DEX_LABEL = { 0: 'Cetus', 1: 'DeepBook', 2: 'Turbos' };

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
              {fmt(suiUntilGrad)} SUI to {DEX_LABEL[token.graduationTarget ?? token.graduation_target] ?? 'grad'}
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
            <img src="data:image/png;base64,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" alt="SuiPump" className="w-5 h-5" style={{ filter: 'drop-shadow(0 0 6px rgba(132,204,22,0.4))' }} />
            <span className="text-sm font-mono font-bold text-lime-400 tracking-widest hidden sm:block">SUIPUMP</span>
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
          {account && (
            <Link
              to="/agent"
              className="flex items-center gap-1.5 px-3 py-2 rounded-xl border border-violet-400/40 text-violet-400 text-[10px] font-mono font-bold hover:bg-violet-400/10 transition-all"
              title="Autonomous Agent"
            >
              <Bot size={11} /> AGENT
            </Link>
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

// ── Live Ticker ──────────────────────────────────────────────────────────────
function LiveTicker({ stats }) {
  if (!stats) return null;
  const items = [
    { label: 'S1 POOL', value: stats.poolSui   != null ? `${stats.poolSui.toFixed(2)} SUI`   : '—' },
    { label: 'VOLUME',  value: stats.volume     != null ? `${fmt(stats.volume)} SUI`           : '—' },
    { label: 'TRADES',  value: stats.tradeCount != null ? stats.tradeCount.toLocaleString()    : '—' },
    { label: 'TOKENS',  value: stats.tokenCount != null ? stats.tokenCount                     : '—' },
  ];
  return (
    <div className="w-full bg-lime-400/5 border-b border-lime-400/10 px-4 py-1.5 flex items-center justify-center gap-6 overflow-x-auto">
      {items.map(({ label, value }) => (
        <div key={label} className="flex items-center gap-1.5 shrink-0">
          <span className="text-[9px] font-mono text-lime-400/40 tracking-widest">{label}</span>
          <span className="text-[10px] font-mono font-bold text-lime-400/80">{value}</span>
        </div>
      ))}
    </div>
  );
}

// ── Home page ─────────────────────────────────────────────────────────────────
// ── Trending Bar — 1h momentum, top 10 ────────────────────────────────────────
function TrendingBar({ lang = 'en' }) {
  const navigate = useNavigate();
  const [items, setItems]   = React.useState([]);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    const IURL = import.meta.env.VITE_INDEXER_URL || '';
    if (!IURL) { setLoading(false); return; }
    let cancelled = false;
    async function load() {
      try {
        const r = await fetch(`${IURL}/trending?limit=10`, { signal: AbortSignal.timeout(8000) });
        if (!r.ok || cancelled) return;
        const rows = await r.json();
        if (!cancelled) { setItems(rows); setLoading(false); }
      } catch { if (!cancelled) setLoading(false); }
    }
    load();
    const timer = setInterval(load, 30_000);
    return () => { cancelled = true; clearInterval(timer); };
  }, []);

  if (loading || items.length === 0) return null;

  return (
    <div className="mb-5">
      <div className="flex items-center gap-1.5 mb-2">
        <TrendingUp size={13} className="text-lime-400" />
        <span className="text-[10px] font-mono text-white/40 tracking-widest">TRENDING NOW</span>
        <span className="text-[8px] font-mono text-white/20">· last 1h</span>
      </div>
      <div className="flex gap-2 overflow-x-auto scrollbar-hide pb-1">
        {items.map((it, i) => {
          const priceUp = (it.last_reserve ?? 0) >= (it.first_reserve ?? 0);
          return (
            <button key={it.curve_id} onClick={() => navigate(`/token/${it.curve_id}`)}
              className="shrink-0 flex items-center gap-2 bg-white/[0.04] hover:bg-white/[0.07] border border-white/8 hover:border-lime-400/30 rounded-xl px-3 py-2 transition-colors">
              <span className="text-[10px] font-mono font-bold text-lime-400/60 w-4">{i + 1}</span>
              {it.icon_url
                ? <img src={it.icon_url} alt="" className="w-6 h-6 rounded-full object-cover" onError={e => { e.target.style.display = 'none'; }} />
                : <div className="w-6 h-6 rounded-full bg-white/10" />}
              <div className="text-left">
                <div className="text-[11px] font-mono font-bold text-white leading-tight">
                  ${it.symbol || '?'}
                  {it.graduation_target != null && (
                    <span className="text-[7px] font-mono text-lime-400/40 ml-1 uppercase">
                      {DEX_LABEL[it.graduation_target] ?? ''}
                    </span>
                  )}
                </div>
                <div className="text-[8px] font-mono text-white/30 leading-tight">
                  {Number(it.total_vol).toFixed(1)} SUI · {it.unique_buyers} buyers
                </div>
              </div>
              <span className={`text-[9px] font-mono font-bold ${priceUp ? 'text-lime-400' : 'text-red-400'}`}>
                {priceUp ? '↑' : '↓'}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

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
          <div className="flex flex-col items-center" style={{ gap: 0, marginTop: '-12px' }}>
            <img src="data:image/png;base64,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" alt="SuiPump" className="w-36" style={{ filter: 'drop-shadow(0 0 28px rgba(132,204,22,0.55))', marginBottom: '-6px' }} />
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

      <TrendingBar lang={lang} />

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
  const appStats  = useStats();

  // Strategy hooks lifted to app level — survive modal open/close
  // Only stop when the browser tab is closed
  const sniper    = useSniper({    walletAddress: account?.address, keypair: tradeKey.isReady ? tradeKey.keypair : null });
  const dca       = useDCA({       walletAddress: account?.address, keypair: tradeKey.isReady ? tradeKey.keypair : null });
  const copyTrade = useCopyTrade({ walletAddress: account?.address, keypair: tradeKey.isReady ? tradeKey.keypair : null });
  const rebalance   = useRebalance({ walletAddress: account?.address, keypair: tradeKey.isReady ? tradeKey.keypair : null });
  const limitOrder  = useLimitOrder(tradeKey, allTokens);

  return (
    <div className="min-h-screen bg-[#080808] text-white" style={{ fontFamily: "'JetBrains Mono', ui-monospace, monospace" }}>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;700&family=Space+Grotesk:wght@700&display=swap');`}</style>
      <div className="fixed inset-0 pointer-events-none opacity-[0.03]" style={{
        backgroundImage: 'linear-gradient(rgba(132,204,22,1) 1px, transparent 1px), linear-gradient(90deg, rgba(132,204,22,1) 1px, transparent 1px)',
        backgroundSize: '60px 60px',
      }} />
      <ScrollToTop />
      <Header onLaunch={() => setShowLaunch(true)} lang={lang} setLang={handleLang} onToggleFeed={() => setShowFeed(o => !o)} showFeed={showFeed} onStrategies={() => setShowStrategies(true)} />
      <LiveTicker stats={appStats} />
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
          <Route path="/portfolio" element={<PortfolioPage onBack={() => navigate('/')} lang={lang} tradeKeypair={tradeKey.isReady ? tradeKey.keypair : null} />} />
          <Route path="/portfolio/:walletAddress" element={<PortfolioPage onBack={() => navigate(-1)} lang={lang} tradeKeypair={tradeKey.isReady ? tradeKey.keypair : null} />} />
          <Route path="/roadmap" element={<RoadmapPage onBack={() => navigate('/')} lang={lang} />} />
          <Route path="/agent" element={<AgentPage onBack={() => navigate('/')} />} />
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
          limitOrder={limitOrder}
        />
      )}
      {showFeed && (
        <LiveFeedSidebar tokens={allTokens} onClose={() => setShowFeed(false)} />
      )}
    </div>
  );
}
