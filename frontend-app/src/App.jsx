// v18-strategies-lifted
// App.jsx  -  react-router-dom based routing
// Strategy hooks (useSniper, useDCA, useCopyTrade) lifted to app level so they
// survive modal open/close. Hooks only stop when the browser tab is closed.
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
    } catch {}
  }
  return _suiUsdCache;
}

// ── Network banner ────────────────────────────────────────────────────────────
function NetworkBanner() {
  const [dismissed, setDismissed] = useState(
    () => { try { return sessionStorage.getItem('suipump_net_banner') === '1'; } catch { return false; } }
  );
  if (dismissed) return null;
  return (
    <div className="w-full bg-red-950/40 border-b border-red-500/20 px-4 py-2 flex items-center justify-between gap-3 sticky top-[57px] z-30">
      <div className="flex items-center gap-2.5 min-w-0">
        <AlertTriangle size={11} className="text-red-400/70 shrink-0" />
        <p className="text-[10px] font-mono text-red-300/60 leading-snug">
          <span className="font-bold text-red-200/80">TESTNET</span> — tokens have no real value. For testing only.
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
  const account    = useCurrentAccount();
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
    return {
      ...token,
      name:    metaOverride.name    || token.name,
      symbol:  metaOverride.symbol  || token.symbol,
      iconUrl: metaOverride.iconUrl || token.iconUrl || null,
    };
  } catch { return token; }
}

function useStats() {
  const [stats, setStats] = useState({ poolSui: null, tradeCount: null, volume: null });
  useEffect(() => {
    if (!INDEXER_URL) return;
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch(`${INDEXER_URL}/stats`, { signal: AbortSignal.timeout(5000) });
        if (res.ok && !cancelled) {
          const data = await res.json();
          setStats({ poolSui: data.s1PoolSui, tradeCount: data.totalTrades, volume: data.totalVolume });
        }
      } catch {}
    }
    load();
    const timer = setInterval(load, 30_000);
    return () => { cancelled = true; clearInterval(timer); };
  }, []);
  return stats;
}

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

// ── Header ────────────────────────────────────────────────────────────────────
function Header({ onLaunch, lang, setLang, onToggleFeed, showFeed, onStrategies }) {
  const account = useCurrentAccount();
  const dAppKit = useDAppKit();
  const navigate = useNavigate();
  const [showConnect, setShowConnect] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [showLangMenu, setShowLangMenu] = useState(false);

  return (
    <header className="sticky top-0 z-40 border-b border-white/8 bg-[#080808]/95 backdrop-blur-md">
      <div className="max-w-6xl mx-auto px-4 h-[57px] flex items-center justify-between gap-3">
        {/* Logo */}
        <button onClick={() => navigate('/')} className="flex items-center gap-2 shrink-0 group">
          <div className="w-7 h-7 rounded-lg bg-lime-400 flex items-center justify-center group-hover:bg-lime-300 transition-colors">
            <Flame size={14} className="text-black" />
          </div>
          <span className="text-sm font-mono font-bold text-white tracking-widest hidden sm:block">SUIPUMP</span>
        </button>

        {/* Nav */}
        <nav className="hidden md:flex items-center gap-1">
          {[
            { label: t(lang,'leaderboard'), path: '/leaderboard', icon: <Trophy size={11}/> },
            { label: t(lang,'stats'),       path: '/stats',       icon: <BarChart3 size={11}/> },
            { label: t(lang,'portfolio'),   path: '/portfolio',   icon: <Wallet size={11}/> },
            { label: t(lang,'s1Airdrop'),   path: '/airdrop',     icon: <Gift size={11}/> },
          ].map(({ label, path, icon }) => (
            <Link key={path} to={path}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-mono text-white/40 hover:text-white hover:bg-white/5 transition-all">
              {icon}{label}
            </Link>
          ))}
        </nav>

        {/* Right actions */}
        <div className="flex items-center gap-2">
          {/* Strategies button */}
          <button
            onClick={onStrategies}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-mono text-white/40 hover:text-white hover:bg-white/5 transition-all"
            title="Trading Strategies"
          >
            <Zap size={11} />
            <span className="hidden sm:block">Strategies</span>
          </button>

          {/* Launch */}
          <button
            onClick={onLaunch}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-lime-400 text-black text-[11px] font-mono font-bold hover:bg-lime-300 transition-colors"
          >
            <Plus size={11} />
            <span className="hidden sm:block">{t(lang,'launchToken')}</span>
          </button>

          {/* Connect */}
          {account ? (
            <button
              onClick={() => dAppKit.disconnectWallet()}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-white/10 text-[11px] font-mono text-white/50 hover:text-white hover:border-white/20 transition-all"
            >
              <span className="w-1.5 h-1.5 rounded-full bg-lime-400" />
              <span className="hidden sm:block">{account.address.slice(0,6)}…{account.address.slice(-4)}</span>
            </button>
          ) : (
            <button
              onClick={() => setShowConnect(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-white/10 text-[11px] font-mono text-white/50 hover:text-white hover:border-white/20 transition-all"
            >
              <Wallet size={11} />
              <span className="hidden sm:block">{t(lang,'connect')}</span>
            </button>
          )}

          {/* Mobile menu */}
          <button
            onClick={() => setMenuOpen(o => !o)}
            className="md:hidden p-1.5 text-white/40 hover:text-white transition-colors"
          >
            {menuOpen ? <X size={16}/> : <Menu size={16}/>}
          </button>
        </div>
      </div>

      {/* Mobile menu */}
      {menuOpen && (
        <div className="md:hidden border-t border-white/5 bg-[#080808] px-4 py-3 space-y-1">
          {[
            { label: t(lang,'leaderboard'), path: '/leaderboard' },
            { label: t(lang,'stats'),       path: '/stats' },
            { label: t(lang,'portfolio'),   path: '/portfolio' },
            { label: t(lang,'s1Airdrop'),   path: '/airdrop' },
            { label: t(lang,'whitepaper'),  path: '/whitepaper' },
            { label: t(lang,'roadmap'),     path: '/roadmap' },
          ].map(({ label, path }) => (
            <Link key={path} to={path} onClick={() => setMenuOpen(false)}
              className="block px-3 py-2 rounded-lg text-[11px] font-mono text-white/40 hover:text-white hover:bg-white/5 transition-all">
              {label}
            </Link>
          ))}
        </div>
      )}

      {showConnect && (
        <ConnectModal onClose={() => setShowConnect(false)} />
      )}
    </header>
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

// ── Home page ─────────────────────────────────────────────────────────────────
function HomePage({ onLaunch, lang }) {
  const navigate    = useNavigate();
  const { tokens }  = useTokenList();
  const { stats: curveStats, curveStates } = useTokenStats();
  const globalStats = useStats();

  const [suiUsd,    setSuiUsd]    = useState(0);
  const [search,    setSearch]    = useState('');
  const [sort,      setSort]      = useState('recent');
  const [showAll,   setShowAll]   = useState(false);

  useEffect(() => {
    refreshSuiUsd().then(setSuiUsd);
    const t = setInterval(() => refreshSuiUsd().then(setSuiUsd), 30_000);
    return () => clearInterval(t);
  }, []);

  const displayTokens = React.useMemo(() => {
    let list = tokens.map(applyLocalOverrides);
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(t =>
        t.name?.toLowerCase().includes(q) ||
        t.symbol?.toLowerCase().includes(q) ||
        t.curveId?.toLowerCase().includes(q)
      );
    }
    const getVal = (tk) => {
      const s = curveStats[tk.curveId];
      switch (sort) {
        case 'volume':   return s?.volumeSui  ?? 0;
        case 'mcap':     return s?.lastPrice  ?? 0;
        case 'progress': return curveStates[tk.curveId]?.progress ?? 0;
        case 'recent':   return s?.lastTradeTime ?? tk.createdAt ?? 0;
        default:         return s?.lastTradeTime ?? tk.createdAt ?? 0;
      }
    };
    return list.sort((a, b) => getVal(b) - getVal(a));
  }, [tokens, curveStats, curveStates, search, sort]);

  const topToken = displayTokens[0];
  const visibleTokens = showAll ? displayTokens : displayTokens.slice(0, 20);

  return (
    <div className="space-y-6">
      {/* Stats bar */}
      {(globalStats.volume != null || globalStats.tradeCount != null) && (
        <div className="flex items-center gap-6 py-3 px-4 rounded-xl bg-white/[0.02] border border-white/5 overflow-x-auto scrollbar-hide">
          {globalStats.volume != null && (
            <div className="text-center shrink-0">
              <div className="text-[10px] font-mono text-white/30 tracking-widest">VOLUME</div>
              <div className="text-sm font-mono font-bold text-lime-400">{(globalStats.volume).toFixed(0)} SUI</div>
            </div>
          )}
          {globalStats.tradeCount != null && (
            <div className="text-center shrink-0">
              <div className="text-[10px] font-mono text-white/30 tracking-widest">TRADES</div>
              <div className="text-sm font-mono font-bold text-white">{globalStats.tradeCount.toLocaleString()}</div>
            </div>
          )}
          {globalStats.poolSui != null && (
            <div className="text-center shrink-0">
              <div className="text-[10px] font-mono text-white/30 tracking-widest">S1 POOL</div>
              <div className="text-sm font-mono font-bold text-white">{globalStats.poolSui.toFixed(1)} SUI</div>
            </div>
          )}
          {tokens.length > 0 && (
            <div className="text-center shrink-0">
              <div className="text-[10px] font-mono text-white/30 tracking-widest">TOKENS</div>
              <div className="text-sm font-mono font-bold text-white">{tokens.length}</div>
            </div>
          )}
        </div>
      )}

      {/* Crown banner */}
      {topToken && curveStates[topToken.curveId] && (
        <button
          onClick={() => navigate(`/token/${topToken.curveId}`)}
          className="w-full rounded-2xl border border-lime-400/20 bg-lime-950/10 hover:bg-lime-950/20 transition-all p-4 text-left group"
        >
          <div className="flex items-center gap-3">
            <Crown size={16} className="text-lime-400 shrink-0" />
            <span className="text-[10px] font-mono text-lime-400/70 tracking-widest">COMMUNITY CROWN 👑</span>
          </div>
          <div className="mt-2 flex items-center gap-3">
            {topToken.iconUrl && (
              <img src={topToken.iconUrl} alt={topToken.symbol}
                className="w-10 h-10 rounded-full border border-white/10 object-cover shrink-0" />
            )}
            <div className="min-w-0">
              <div className="text-sm font-mono font-bold text-white group-hover:text-lime-400 transition-colors truncate">
                {topToken.name}
              </div>
              <div className="text-[10px] font-mono text-white/40">${topToken.symbol}</div>
            </div>
            {curveStats[topToken.curveId] && (
              <div className="ml-auto text-right shrink-0">
                <div className="text-xs font-mono font-bold text-lime-400">
                  {(curveStats[topToken.curveId].volumeSui ?? 0).toFixed(1)} SUI vol
                </div>
                <div className="text-[10px] font-mono text-white/30">
                  {(curveStates[topToken.curveId]?.progress ?? 0).toFixed(1)}% bonded
                </div>
              </div>
            )}
          </div>
        </button>
      )}

      {/* Controls */}
      <div className="flex items-center gap-3">
        <div className="flex-1 relative">
          <Search size={12} className="absolute left-3 top-1/2 -translate-y-1/2 text-white/20" />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search tokens…"
            className="w-full bg-white/[0.04] border border-white/8 rounded-xl pl-8 pr-4 py-2.5 text-xs font-mono text-white placeholder-white/20 focus:outline-none focus:border-lime-400/30 transition-colors"
          />
        </div>
        <div className="flex gap-1 overflow-x-auto scrollbar-hide">
          {[
            { id: 'recent',   label: 'NEW'      },
            { id: 'volume',   label: 'VOLUME'   },
            { id: 'mcap',     label: 'MCAP'     },
            { id: 'progress', label: 'BONDING'  },
          ].map(s => (
            <button key={s.id} onClick={() => setSort(s.id)}
              className={`shrink-0 px-3 py-1.5 rounded-lg text-[10px] font-mono font-bold transition-colors ${
                sort === s.id
                  ? 'bg-lime-400 text-black'
                  : 'bg-white/5 text-white/40 hover:text-white hover:bg-white/8'
              }`}>
              {s.label}
            </button>
          ))}
        </div>
      </div>

      {/* Token grid */}
      {tokens.length === 0 ? (
        <div className="rounded-2xl border border-white/5 bg-white/[0.02] p-12 text-center">
          <div className="text-[11px] font-mono text-white/20">No tokens yet — be the first to launch!</div>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {visibleTokens.map(token => {
              const stats = curveStats[token.curveId];
              const cs    = curveStates[token.curveId];
              const price    = stats?.lastPrice ?? stats?.startPrice ?? 0;
              const mcap     = price * TOTAL_SUPPLY_WHOLE * suiUsd;
              const progress = cs?.progress ?? 0;
              const vol24h   = stats?.volume24h ?? 0;
              const sparkline = stats?.sparkline24h ?? [];

              return (
                <button
                  key={token.curveId}
                  onClick={() => navigate(`/token/${token.curveId}`)}
                  className="rounded-2xl border border-white/8 bg-white/[0.02] hover:bg-white/[0.04] hover:border-white/15 transition-all p-4 text-left group"
                >
                  <div className="flex items-start gap-3 mb-3">
                    <div className="w-10 h-10 rounded-full border border-white/10 overflow-hidden flex items-center justify-center bg-lime-950/30 shrink-0">
                      {token.iconUrl
                        ? <img src={token.iconUrl} alt={token.symbol} className="w-full h-full object-cover" onError={e => { e.target.style.display='none'; }} />
                        : <Flame size={14} className="text-lime-400/50" />}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-xs font-mono font-bold text-white truncate group-hover:text-lime-400 transition-colors">
                        {token.name}
                      </div>
                      <div className="text-[10px] font-mono text-white/30">${token.symbol}</div>
                    </div>
                    {token.curveId === topToken?.curveId && (
                      <Crown size={12} className="text-lime-400 shrink-0 mt-0.5" />
                    )}
                  </div>

                  {/* Sparkline */}
                  {sparkline.length > 1 && (
                    <div className="h-8 mb-3 flex items-end gap-0.5">
                      {sparkline.slice(-20).map((v, i, arr) => {
                        const min = Math.min(...arr); const max = Math.max(...arr);
                        const h = max > min ? Math.max(2, ((v - min) / (max - min)) * 32) : 4;
                        const isLast = i === arr.length - 1;
                        return <div key={i} style={{ height: h }} className={`flex-1 rounded-sm ${isLast ? 'bg-lime-400' : 'bg-lime-400/30'}`} />;
                      })}
                    </div>
                  )}

                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between">
                      <span className="text-[10px] font-mono text-white/30">MCAP</span>
                      <span className="text-[10px] font-mono font-bold text-white">
                        {mcap >= 1000 ? `$${(mcap/1000).toFixed(1)}k` : mcap > 0 ? `$${mcap.toFixed(0)}` : '-'}
                      </span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-[10px] font-mono text-white/30">24H VOL</span>
                      <span className="text-[10px] font-mono text-white/60">
                        {vol24h > 0 ? `${vol24h.toFixed(1)} SUI` : '-'}
                      </span>
                    </div>
                    <div className="mt-2">
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-[9px] font-mono text-white/20">BONDING</span>
                        <span className="text-[9px] font-mono text-white/30">{progress.toFixed(1)}%</span>
                      </div>
                      <div className="h-1 bg-white/5 rounded-full overflow-hidden">
                        <div
                          className="h-full bg-gradient-to-r from-lime-600 to-lime-400 rounded-full transition-all"
                          style={{ width: `${Math.min(100, progress)}%` }}
                        />
                      </div>
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
          {!showAll && displayTokens.length > 20 && (
            <div className="text-center">
              <button
                onClick={() => setShowAll(true)}
                className="px-6 py-2.5 rounded-xl border border-white/10 text-xs font-mono text-white/40 hover:text-white hover:border-white/20 transition-all"
              >
                Show all {displayTokens.length} tokens
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ── 404 Page ──────────────────────────────────────────────────────────────────
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
  const navigate = useNavigate();
  const account  = useCurrentAccount();

  const [showLaunch,      setShowLaunch]      = useState(false);
  const [showStrategies,  setShowStrategies]  = useState(false);
  const [showFeed,        setShowFeed]        = useState(false);
  const [lang, setLang] = useState(() => localStorage.getItem('suipump_lang') || 'en');

  const handleLang = (code) => { setLang(code); localStorage.setItem('suipump_lang', code); };
  const handleLaunched = ({ curveId }) => { setShowLaunch(false); navigate(`/token/${curveId}`); };

  const { tokens: allTokens } = useTokenList();
  const tradeKey = useTradeKey();

  // ── Strategy hooks lifted to app level ─────────────────────────────────────
  // These stay alive regardless of modal open/close.
  // They only stop when the browser tab is closed.
  const sniper    = useSniper({    walletAddress: account?.address, keypair: tradeKey.isReady ? tradeKey.keypair : null });
  const dca       = useDCA({       walletAddress: account?.address, keypair: tradeKey.isReady ? tradeKey.keypair : null });
  const copyTrade = useCopyTrade({ walletAddress: account?.address, keypair: tradeKey.isReady ? tradeKey.keypair : null });

  return (
    <div className="min-h-screen bg-[#080808] text-white" style={{ fontFamily: "'JetBrains Mono', ui-monospace, monospace" }}>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;700&family=Space+Grotesk:wght@700&display=swap');`}</style>
      <div className="fixed inset-0 pointer-events-none opacity-[0.03]" style={{
        backgroundImage: 'linear-gradient(rgba(132,204,22,1) 1px, transparent 1px), linear-gradient(90deg, rgba(132,204,22,1) 1px, transparent 1px)',
        backgroundSize: '60px 60px',
      }} />
      <ScrollToTop />
      <Header
        onLaunch={() => setShowLaunch(true)}
        lang={lang}
        setLang={handleLang}
        onToggleFeed={() => setShowFeed(o => !o)}
        showFeed={showFeed}
        onStrategies={() => setShowStrategies(true)}
      />
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
        />
      )}
      {showFeed && (
        <LiveFeedSidebar tokens={allTokens} onClose={() => setShowFeed(false)} />
      )}
    </div>
  );
}
