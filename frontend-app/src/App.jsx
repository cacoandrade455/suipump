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
            <img src="data:image/png;base64,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" alt="SuiPump" className="w-7 h-7" />
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
          <div className="flex flex-col items-center gap-3">
            <img src="data:image/png;base64,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" alt="SuiPump" className="w-28 h-28" style={{ filter: 'drop-shadow(0 0 20px rgba(132,204,22,0.5))' }} />
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
