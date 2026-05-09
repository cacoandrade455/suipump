// App.jsx — react-router-dom based routing
import React, { useState, useEffect } from 'react';
import { Routes, Route, useNavigate, useParams, Link, useLocation } from 'react-router-dom';
import { ConnectButton, useCurrentAccount, useSuiClient, useDisconnectWallet, useAccounts, ConnectModal } from '@mysten/dapp-kit';
import { Flame, Rocket, Plus, Gift, TrendingUp, Coins, Users, Trophy, Wallet, Search, Menu, X, Map, Copy, Crown, BarChart3, Github, MessageCircle, Bell } from 'lucide-react';

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
import { PACKAGE_ID, DRAIN_SUI_APPROX, TOKEN_DECIMALS } from './constants.js';
import { mistToSui, priceMistPerToken } from './curve.js';
import { paginateEvents, paginateMultipleEvents } from './paginateEvents.js';

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
  if (n == null) return '—';
  if (!Number.isFinite(n)) return '—';
  if (n >= 1e9) return (n / 1e9).toFixed(d) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(d) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(d) + 'k';
  return n.toFixed(d);
}

function timeAgoShort(ts) {
  if (!ts) return '—';
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

function ScrollToTop() {
  const { pathname } = useLocation();
  useEffect(() => { window.scrollTo(0, 0); }, [pathname]);
  return null;
}

// ── Live stats hook ──────────────────────────────────────────────────────────

function useStats() {
  const client = useSuiClient();
  const [stats, setStats] = useState({ poolSui: null, tradeCount: null, volume: null });

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const buyType = `${PACKAGE_ID}::bonding_curve::TokensPurchased`;
        const sellType = `${PACKAGE_ID}::bonding_curve::TokensSold`;
        const eventMap = await paginateMultipleEvents(client, [buyType, sellType], { order: 'descending', maxPages: 20 });
        let protocolMist = 0, volumeMist = 0;
        for (const e of eventMap[buyType]) {
          protocolMist += Number(e.parsedJson?.protocol_fee ?? 0);
          volumeMist += Number(e.parsedJson?.sui_in ?? 0);
        }
        for (const e of eventMap[sellType]) {
          protocolMist += Number(e.parsedJson?.protocol_fee ?? 0);
          volumeMist += Number(e.parsedJson?.sui_out ?? 0);
        }
        if (!cancelled) setStats({
          poolSui: (protocolMist * 0.5) / MIST_PER_SUI,
          tradeCount: eventMap[buyType].length + eventMap[sellType].length,
          volume: volumeMist / MIST_PER_SUI,
        });
      } catch { }
    }
    load();
    const t = setInterval(load, 30_000);
    return () => { cancelled = true; clearInterval(t); };
  }, [client]);

  return stats;
}

// ── % change badge ───────────────────────────────────────────────────────────

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

// ── Token card ───────────────────────────────────────────────────────────────

function TokenCard({ token, stats, isCrown, suiUsd = 0 }) {
  const client = useSuiClient();
  const navigate = useNavigate();
  const [curveState, setCurveState] = useState(null);
  const [iconUrl, setIconUrl] = useState(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const obj = await client.getObject({ id: token.curveId, options: { showContent: true } });
        if (!cancelled) setCurveState(obj.data?.content?.fields ?? null);
      } catch { }
    }
    load();
    const t = setInterval(load, 10_000);
    return () => { cancelled = true; clearInterval(t); };
  }, [token.curveId, client]);

  useEffect(() => {
    if (!token.tokenType) return;
    let cancelled = false;
    client.getCoinMetadata({ coinType: token.tokenType })
      .then(m => { if (!cancelled && m?.iconUrl) setIconUrl(m.iconUrl); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [token.tokenType, client]);

  const reserveMist = curveState ? BigInt(curveState.sui_reserve) : 0n;
  const tokensRemaining = curveState ? BigInt(curveState.token_reserve) : 0n;
  const tokensSold = BigInt(800_000_000) * 10n ** BigInt(TOKEN_DECIMALS) - tokensRemaining;
  const progress = Math.min(100, (mistToSui(reserveMist) / DRAIN_SUI_APPROX) * 100);
  const priceMist = curveState ? priceMistPerToken(reserveMist, tokensSold) : 0n;
  const graduated = curveState?.graduated ?? false;

  const pricePerWhole = Number(priceMist) / 1e9;
  const marketCapSui = pricePerWhole * TOTAL_SUPPLY_WHOLE;
  const isTrending = stats?.recentTrades >= 3;

  const timeAgo = token.timestamp ? (() => {
    const diff = Date.now() - token.timestamp;
    if (diff < 60_000) return 'just now';
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
    return `${Math.floor(diff / 86_400_000)}d ago`;
  })() : '';

  return (
    <button
      onClick={() => token.tokenType && navigate(`/token/${token.curveId}`)}
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

      <div className={`flex items-start justify-between mb-3 ${isCrown ? 'mt-1' : ''}`}>
        <div className="flex items-center gap-3">
          <div className={`w-11 h-11 rounded-full overflow-hidden border-2 flex items-center justify-center bg-lime-950/30 shrink-0 transition-all ${
            isCrown ? 'border-lime-400/40' : 'border-white/10 group-hover:border-lime-400/30'
          }`}>
            {iconUrl
              ? <img src={iconUrl} alt={token.symbol} className="w-full h-full object-cover"
                  onError={e => { e.target.style.display='none'; e.target.nextSibling.style.display='block'; }} />
              : null}
            <span className="text-xl" style={{ display: iconUrl ? 'none' : 'block' }}>🔥</span>
          </div>
          <div>
            <div className="text-sm font-bold text-white font-mono">{token.name}</div>
            <div className="text-[11px] text-lime-400/70 font-mono">${token.symbol}</div>
          </div>
        </div>
        <div className="flex items-center gap-1.5 flex-wrap justify-end">
          {isTrending && (
            <div className="text-[10px] font-mono text-lime-400 bg-lime-400/10 border border-lime-400/20 px-1.5 py-0.5 rounded-full flex items-center gap-1">
              <Flame size={9} /> HOT
            </div>
          )}
          {graduated && (
            <div className="text-[10px] font-mono text-emerald-400 bg-emerald-400/10 border border-emerald-400/20 px-2 py-0.5 rounded-full">
              GRAD
            </div>
          )}
          <PctBadge pct={stats?.pctChange} />
        </div>
      </div>

      <div className="mb-3">
        <div className="flex justify-between text-[10px] font-mono mb-1.5">
          <span className="text-white/30">BONDING CURVE</span>
          <span className="text-lime-400/60">{fmt(progress, 1)}%</span>
        </div>
        <div className="h-1.5 bg-white/5 rounded-full overflow-hidden">
          <div
            className={`h-full rounded-full transition-all duration-500 ${
              isCrown
                ? 'bg-gradient-to-r from-lime-500 to-lime-300'
                : 'bg-gradient-to-r from-lime-600 to-lime-400'
            }`}
            style={{ width: `${Math.max(progress, 1)}%` }}
          />
        </div>
      </div>

      <div className="flex items-center justify-between">
        <span className="text-[11px] font-mono text-white/30">{timeAgo}</span>
        <div className="flex items-center gap-2">
          {stats?.trades > 0 && (
            <span className="text-[10px] font-mono text-white/35">{stats.trades} trade{stats.trades !== 1 ? 's' : ''}</span>
          )}
          {marketCapSui > 0 && (() => {
            const mcUsd = suiUsd > 0 ? marketCapSui * suiUsd : null;
            return (
              <span className="text-[10px] font-mono text-white/30">
                MC {mcUsd != null ? (mcUsd >= 1e6 ? `$${(mcUsd/1e6).toFixed(2)}M` : mcUsd >= 1e3 ? `$${(mcUsd/1e3).toFixed(1)}k` : `$${mcUsd.toFixed(0)}`) : `${fmt(marketCapSui, 0)} SUI`}
              </span>
            );
          })()}
          <span className="text-[11px] font-mono text-white/60">
            {curveState
              ? suiUsd > 0
                ? (() => { const p = (Number(priceMist)/1e9)*suiUsd; return p >= 0.01 ? `$${p.toFixed(4)}` : p >= 1e-6 ? `$${p.toFixed(8)}` : `$${p.toPrecision(4)}`; })()
                : `${(Number(priceMist) / 1e9).toFixed(7)} SUI`
              : '…'}
          </span>
        </div>
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
        <button onClick={() => setShow(true)} className="w-full py-2.5 text-xs font-mono text-white/40 hover:text-white/70 transition-colors border border-white/10 rounded-xl">
          Open in mobile wallet app
        </button>
      ) : (
        <div className="space-y-2">
          <div className="text-[10px] font-mono text-white/30 text-center mb-2">OPEN IN WALLET APP</div>
          {wallets.map((w) => (
            <a key={w.name} href={w.url} target="_blank" rel="noreferrer"
              className="flex items-center gap-3 w-full px-4 py-3 rounded-xl bg-white/[0.04] border border-white/10 hover:border-lime-400/40 hover:bg-white/[0.07] transition-all">
              <img src={w.icon} alt={w.name} className="w-7 h-7 rounded-lg" onError={(e) => { e.target.style.display = 'none'; }} />
              <span className="text-sm font-mono text-white">{w.name}</span>
              <span className="ml-auto text-[10px] text-white/30">OPEN →</span>
            </a>
          ))}
          <p className="text-[9px] font-mono text-white/35 text-center pt-1">App will open in your wallet&apos;s built-in browser</p>
        </div>
      )}
    </div>
  );
}

// ── Notifications ─────────────────────────────────────────────────────────────

function useNotifications(walletAddress) {
  const client = useSuiClient();
  const [notifications, setNotifications] = useState([]);
  const [unread, setUnread] = useState(0);
  const storageKey = walletAddress ? `suipump_notif_seen_${walletAddress}` : null;

  useEffect(() => {
    if (!walletAddress || !client) return;
    let cancelled = false;

    async function load() {
      try {
        const curveCreatedType = `${PACKAGE_ID}::bonding_curve::CurveCreated`;
        const createdEvents = await paginateEvents(client, { MoveEventType: curveCreatedType }, { order: 'descending' });
        const myCurveIds = new Set(
          createdEvents
            .filter(e => e.sender === walletAddress)
            .map(e => e.parsedJson?.curve_id)
            .filter(Boolean)
        );

        if (myCurveIds.size === 0) {
          if (!cancelled) { setNotifications([]); setUnread(0); }
          return;
        }

        const commentType = `${PACKAGE_ID}::bonding_curve::CommentPosted`;
        const gradType = `${PACKAGE_ID}::bonding_curve::Graduated`;
        const [commentEvents, gradEvents] = await Promise.all([
          paginateEvents(client, { MoveEventType: commentType }, { order: 'descending', maxPages: 10 }),
          paginateEvents(client, { MoveEventType: gradType }, { order: 'descending', maxPages: 5 }),
        ]);

        const comments = commentEvents
          .filter(e => myCurveIds.has(e.parsedJson?.curve_id))
          .map(e => ({
            id: e.id?.txDigest + '_' + e.id?.eventSeq,
            type: 'comment',
            curveId: e.parsedJson?.curve_id,
            author: e.parsedJson?.author,
            text: e.parsedJson?.text,
            timestamp: e.timestampMs ? Number(e.timestampMs) : 0,
          }));

        const graduations = gradEvents
          .filter(e => myCurveIds.has(e.parsedJson?.curve_id))
          .map(e => ({
            id: e.id?.txDigest + '_' + e.id?.eventSeq,
            type: 'graduated',
            curveId: e.parsedJson?.curve_id,
            author: null,
            text: null,
            timestamp: e.timestampMs ? Number(e.timestampMs) : 0,
          }));

        const relevant = [...comments, ...graduations]
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
    const t = setInterval(load, 30_000);
    return () => { cancelled = true; clearInterval(t); };
  }, [walletAddress, client, storageKey]);

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
    if (!addr) return '—';
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
// Replaces dapp-kit's ConnectButton to avoid its white-box styling.

function WalletButton({ size = 'md', lang = 'en' }) {
  const account = useCurrentAccount();
  const { mutate: disconnect } = useDisconnectWallet();
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
          {t(lang,'connect')}
        </button>
        <ConnectModal trigger={<span />} open={open} onOpenChange={setOpen} />
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
            <div className="text-[9px] font-mono text-white/30 tracking-widest mb-0.5">{t(lang,'wallet')}</div>
            <div className="text-[10px] font-mono text-white/60 truncate">{short}</div>
          </div>
          <button
            onClick={() => { disconnect(); setShowMenu(false); }}
            className="w-full px-3 py-2.5 text-left text-[10px] font-mono text-red-400/80 hover:bg-white/5 hover:text-red-400 transition-colors"
          >
            {t(lang,'disconnect')}
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
        {t(lang,'connectWalletToLaunch')}
      </button>
      <ConnectModal trigger={<span />} open={open} onOpenChange={setOpen} />
    </>
  );
}

// ── Header ────────────────────────────────────────────────────────────────────

function Header({ onLaunch, lang, setLang }) {
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

  const currentLang = LANGUAGES.find(l => l.code === lang) || LANGUAGES[0];

  return (
    <header className="border-b border-white/5 bg-black/80 backdrop-blur sticky top-0 z-40">
      <div className="max-w-6xl mx-auto px-4 py-3 flex items-center justify-between">
        <Link to="/" className="flex items-center gap-2.5 hover:opacity-80 transition-opacity" onClick={() => setMenuOpen(false)}>
          <div className="relative">
            <Flame className="text-lime-400" size={20} />
            <div className="absolute inset-0 blur-lg bg-lime-400/40 -z-10" />
          </div>
          <div>
            <div className="text-sm font-bold tracking-tight text-white" style={{ fontFamily: "'Space Grotesk', sans-serif" }}>
              SUIPUMP<span className="text-lime-400">.</span>
            </div>
            <div className="text-[8px] font-mono text-white/30 tracking-[0.2em] -mt-0.5">TESTNET · LIVE</div>
          </div>
        </Link>

        {/* Desktop nav */}
        <div className="hidden sm:flex items-center gap-2">
          <Link to="/airdrop" className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-white/10 text-[10px] font-mono text-white/50 hover:border-lime-400/40 hover:text-lime-400 transition-all">
            <Gift size={10} />
            {poolSui !== null ? <span>{t(lang,'s1Airdrop')} {poolSui.toFixed(4)} SUI</span> : <span>{t(lang,'s1Airdrop')}</span>}
            {tradeCount !== null && <span className="text-white/35 ml-1">· {tradeCount} {t(lang,'trades').toLowerCase()}</span>}
          </Link>
          <Link to="/stats" className="px-3 py-1.5 rounded-lg border border-white/10 text-[10px] font-mono text-white/50 hover:border-lime-400/40 hover:text-lime-400 transition-all flex items-center gap-1.5"><BarChart3 size={10} /> {t(lang,'stats')}</Link>
          <Link to="/leaderboard" className="px-3 py-1.5 rounded-lg border border-white/10 text-[10px] font-mono text-white/50 hover:border-lime-400/40 hover:text-lime-400 transition-all flex items-center gap-1.5"><Trophy size={10} /> {t(lang,'leaderboard')}</Link>
          <Link to="/portfolio" className="px-3 py-1.5 rounded-lg border border-white/10 text-[10px] font-mono text-white/50 hover:border-lime-400/40 hover:text-lime-400 transition-all flex items-center gap-1.5"><Wallet size={10} /> {t(lang,'portfolio')}</Link>
          <Link to="/whitepaper" className="px-3 py-1.5 rounded-lg border border-white/10 text-[10px] font-mono text-white/50 hover:border-lime-400/40 hover:text-lime-400 transition-all">{t(lang,'whitepaper')}</Link>
          <Link to="/roadmap" className="px-3 py-1.5 rounded-lg border border-white/10 text-[10px] font-mono text-white/50 hover:border-lime-400/40 hover:text-lime-400 transition-all flex items-center gap-1.5"><Map size={10} /> {t(lang,'roadmap')}</Link>
          <div className="flex items-center gap-1 ml-1">
            {/* Language picker */}
            <div className="relative" ref={langRef}>
              <button
                onClick={() => setLangOpen(o => !o)}
                className="flex items-center gap-1 px-2 py-1.5 rounded-lg text-[10px] font-mono text-white/40 hover:text-white border border-transparent hover:border-white/10 transition-all"
              >
                <span>{currentLang.flag}</span>
                <span>{currentLang.label}</span>
                <svg width="8" height="8" viewBox="0 0 10 10" fill="currentColor" className="opacity-40"><path d="M5 7L1 3h8z"/></svg>
              </button>
              {langOpen && (
                <div className="absolute right-0 top-full mt-1 bg-[#111] border border-white/10 rounded-xl shadow-xl z-50 overflow-hidden min-w-[110px]">
                  {LANGUAGES.map(l => (
                    <button
                      key={l.code}
                      onClick={() => { setLang(l.code); setLangOpen(false); }}
                      className={`w-full flex items-center gap-2 px-3 py-2 text-[10px] font-mono transition-colors ${
                        lang === l.code ? 'text-lime-400 bg-lime-400/10' : 'text-white/50 hover:bg-white/5 hover:text-white'
                      }`}
                    >
                      <span>{l.flag}</span>
                      <span>{l.label}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
            <a href="https://x.com/SuiPump_SUMP" target="_blank" rel="noreferrer"
              className="p-1.5 rounded-lg text-white/30 hover:text-white transition-colors" title="X / Twitter">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>
            </a>
            <a href="https://discord.gg/TwpXG7q4Ee" target="_blank" rel="noreferrer"
              className="p-1.5 rounded-lg text-white/30 hover:text-white transition-colors" title="Discord">
              <MessageCircle size={13} />
            </a>
            <a href="https://github.com/cacoandrade455/suipump" target="_blank" rel="noreferrer"
              className="p-1.5 rounded-lg text-white/30 hover:text-white transition-colors" title="GitHub">
              <Github size={13} />
            </a>
            <NotificationBell walletAddress={account?.address} />
          </div>
          {account && (
            <button onClick={onLaunch} className="flex items-center gap-2 px-4 py-2 bg-lime-400 text-black text-xs font-mono tracking-widest hover:bg-lime-300 transition-colors rounded-xl font-bold">
              <Plus size={12} /> {t(lang,'launchToken')}
            </button>
          )}
          <WalletButton size="md" lang={lang} />
        </div>

        {/* Mobile nav */}
        <div className="flex sm:hidden items-center gap-2">
          {account && (
            <button onClick={onLaunch} className="flex items-center gap-1 px-3 py-1.5 bg-lime-400 text-black text-[10px] font-mono font-bold rounded-xl hover:bg-lime-300 transition-colors">
              <Plus size={11} /> {t(lang,'launch')}
            </button>
          )}
          <WalletButton size="sm" lang={lang} />
          <NotificationBell walletAddress={account?.address} />
          <button onClick={() => setMenuOpen(o => !o)} className="p-1.5 rounded-lg border border-white/10 text-white/50 hover:text-white transition-colors">
            {menuOpen ? <X size={16} /> : <Menu size={16} />}
          </button>
        </div>
      </div>

      {menuOpen && (
        <div className="sm:hidden border-t border-white/5 bg-black/95 px-4 py-3 space-y-2">
          <Link to="/airdrop" onClick={() => setMenuOpen(false)} className="flex items-center gap-2 py-2.5 text-sm font-mono text-white/60 hover:text-lime-400 transition-colors border-b border-white/5">
            <Gift size={14} /> S1 AIRDROP
            {poolSui !== null && <span className="ml-auto text-xs text-white/30">{poolSui.toFixed(4)} SUI</span>}
          </Link>
          <Link to="/stats" onClick={() => setMenuOpen(false)} className="flex items-center gap-2 py-2.5 text-sm font-mono text-white/60 hover:text-lime-400 transition-colors border-b border-white/5"><BarChart3 size={14} /> STATS</Link>
          <Link to="/leaderboard" onClick={() => setMenuOpen(false)} className="flex items-center gap-2 py-2.5 text-sm font-mono text-white/60 hover:text-lime-400 transition-colors border-b border-white/5"><Trophy size={14} /> LEADERBOARD</Link>
          <Link to="/portfolio" onClick={() => setMenuOpen(false)} className="flex items-center gap-2 py-2.5 text-sm font-mono text-white/60 hover:text-lime-400 transition-colors border-b border-white/5"><Wallet size={14} /> PORTFOLIO</Link>
          <Link to="/whitepaper" onClick={() => setMenuOpen(false)} className="flex items-center gap-2 py-2.5 text-sm font-mono text-white/60 hover:text-lime-400 transition-colors border-b border-white/5">WHITEPAPER</Link>
          <Link to="/roadmap" onClick={() => setMenuOpen(false)} className="flex items-center gap-2 py-2.5 text-sm font-mono text-white/60 hover:text-lime-400 transition-colors"><Map size={14} /> ROADMAP</Link>
          <div className="flex items-center gap-4 pt-2 border-t border-white/5">
            <a href="https://x.com/SuiPump_SUMP" target="_blank" rel="noreferrer" className="flex items-center gap-2 text-sm font-mono text-white/40 hover:text-white transition-colors">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg> X
            </a>
            <a href="https://discord.gg/TwpXG7q4Ee" target="_blank" rel="noreferrer" className="flex items-center gap-2 text-sm font-mono text-white/40 hover:text-white transition-colors">
              <MessageCircle size={14} /> Discord
            </a>
            <a href="https://github.com/cacoandrade455/suipump" target="_blank" rel="noreferrer" className="flex items-center gap-2 text-sm font-mono text-white/40 hover:text-white transition-colors">
              <Github size={14} /> GitHub
            </a>
          </div>
          <div className="pt-1"><MobileWalletButtons /></div>
        </div>
      )}
    </header>
  );
}

// ── Stats bar ─────────────────────────────────────────────────────────────────

function StatsBar({ tokenCount, stats, lang = 'en' }) {
  const items = [
    { icon: <Coins size={13} />, label: t(lang,'tokens'), value: tokenCount ?? '—' },
    { icon: <TrendingUp size={13} />, label: t(lang,'trades'), value: stats.tradeCount ?? '—' },
    { icon: <Flame size={13} />, label: t(lang,'volume'), value: stats.volume != null ? `${fmt(stats.volume)} SUI` : '—' },
    { icon: <Gift size={13} />, label: t(lang,'s1Pool'), value: stats.poolSui != null ? `${stats.poolSui.toFixed(2)} SUI` : '—' },
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

// ── Community Crown featured banner ──────────────────────────────────────────

function CrownBanner({ token, stats, suiUsd }) {
  const client = useSuiClient();
  const navigate = useNavigate();
  const [curveState, setCurveState] = useState(null);
  const [iconUrl, setIconUrl] = useState(null);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    client.getObject({ id: token.curveId, options: { showContent: true } })
      .then(o => { if (!cancelled) setCurveState(o.data?.content?.fields ?? null); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [token?.curveId, client]);

  useEffect(() => {
    if (!token?.tokenType) return;
    let cancelled = false;
    client.getCoinMetadata({ coinType: token.tokenType })
      .then(m => { if (!cancelled && m?.iconUrl) setIconUrl(m.iconUrl); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [token?.tokenType, client]);

  if (!token) return null;

  const reserveMist = curveState ? BigInt(curveState.sui_reserve) : 0n;
  const tokensRemaining = curveState ? BigInt(curveState.token_reserve) : 0n;
  const tokensSold = BigInt(800_000_000) * 10n ** BigInt(TOKEN_DECIMALS) - tokensRemaining;
  const priceMist = curveState ? priceMistPerToken(reserveMist, tokensSold) : 0n;
  const priceSui = Number(priceMist) / 1e9;
  const mcapSui = priceSui * TOTAL_SUPPLY_WHOLE;
  const progress = Math.min(100, (mistToSui(reserveMist) / DRAIN_SUI_APPROX) * 100);

  return (
    <button
      onClick={() => token.tokenType && navigate(`/token/${token.curveId}`)}
      className="w-full text-left rounded-2xl border border-lime-400/40 bg-gradient-to-r from-lime-950/30 via-black to-black p-4 mb-4 relative overflow-hidden hover:border-lime-400/60 transition-all group"
    >
      {/* Glow */}
      <div className="absolute top-0 left-0 w-64 h-full bg-lime-400/5 blur-3xl pointer-events-none" />

      <div className="relative flex items-center gap-4">
        {/* Crown badge */}
        <div className="flex items-center gap-1.5 shrink-0">
          <Crown size={14} className="text-lime-400" />
          <span className="text-[9px] font-mono font-bold text-lime-400 tracking-widest">COMMUNITY CROWN</span>
        </div>

        <div className="w-px h-6 bg-white/10 shrink-0" />

        {/* Icon */}
        <div className="w-10 h-10 rounded-full border-2 border-lime-400/40 overflow-hidden flex items-center justify-center bg-lime-950/30 shrink-0">
          {iconUrl
            ? <img src={iconUrl} alt={token.symbol} className="w-full h-full object-cover" onError={e => { e.target.style.display='none'; e.target.nextSibling.style.display='block'; }} />
            : null}
          <span className="text-lg" style={{ display: iconUrl ? 'none' : 'block' }}>🔥</span>
        </div>

        {/* Name + symbol */}
        <div className="min-w-0">
          <div className="text-sm font-bold text-white font-mono group-hover:text-lime-400 transition-colors">{token.name}</div>
          <div className="text-[11px] text-lime-400/60 font-mono">${token.symbol}</div>
        </div>

        {/* Stats */}
        <div className="hidden sm:flex items-center gap-6 ml-auto shrink-0">
          {stats?.volume > 0 && (
            <div className="text-right">
              <div className="text-xs font-mono font-bold text-white">{fmt(stats.volume, 2)} SUI</div>
              <div className="text-[9px] font-mono text-white/30">VOLUME</div>
            </div>
          )}
          {mcapSui > 0 && (
            <div className="text-right">
              <div className="text-xs font-mono font-bold text-white">
                {suiUsd > 0
                  ? `$${mcapSui * suiUsd >= 1000 ? ((mcapSui * suiUsd) / 1000).toFixed(1) + 'k' : (mcapSui * suiUsd).toFixed(0)}`
                  : `${fmt(mcapSui)} SUI`}
              </div>
              <div className="text-[9px] font-mono text-white/30">MCAP</div>
            </div>
          )}
          <div className="text-right">
            <div className="text-xs font-mono font-bold text-lime-400">{progress.toFixed(1)}%</div>
            <div className="text-[9px] font-mono text-white/30">CURVE</div>
          </div>
        </div>

        {/* Progress bar — full width at bottom on mobile */}
        <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-white/5">
          <div
            className="h-full bg-gradient-to-r from-lime-500 to-lime-300 transition-all duration-500"
            style={{ width: `${Math.max(progress, 1)}%` }}
          />
        </div>
      </div>
    </button>
  );
}

// ── Home page ─────────────────────────────────────────────────────────────────

function HomePage({ onLaunch, lang = 'en' }) {
  const account = useCurrentAccount();
  const { tokens, loading, error } = useTokenList();
  const stats = useStats();
  const tokenStats = useTokenStats(tokens);
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState('newest');
  const [suiUsd, setSuiUsd] = useState(_suiUsdCache);

  const SORT_OPTIONS = [
    { id: 'newest',     label: t(lang,'newest') },
    { id: 'oldest',     label: t(lang,'oldest') },
    { id: 'trending',   label: t(lang,'trending') },
    { id: 'last_trade', label: t(lang,'lastTrade') },
    { id: 'market_cap', label: t(lang,'marketCap') },
    { id: 'volume',     label: t(lang,'volumeSort') },
    { id: 'trades',     label: t(lang,'tradesSort') },
    { id: 'reserve',    label: t(lang,'reserve') },
    { id: 'progress',   label: t(lang,'progress') },
  ];

  useEffect(() => {
    refreshSuiUsd().then(p => setSuiUsd(p));
    const t = setInterval(() => refreshSuiUsd().then(p => setSuiUsd(p)), 30_000);
    return () => clearInterval(t);
  }, []);

  const filtered = tokens.filter(t => {
    if (!search.trim()) return true;
    const q = search.toLowerCase().trim();
    if (t.name?.toLowerCase().includes(q)) return true;
    if (t.symbol?.toLowerCase().includes(q)) return true;
    if (q.startsWith('0x') && t.curveId?.toLowerCase().includes(q)) return true;
    return false;
  });

  const crownCurveId = React.useMemo(() => {
    if (search.trim()) return null;
    let best = null, bestVol = 0;
    for (const t of tokens) {
      const vol = tokenStats[t.curveId]?.volume ?? 0;
      if (vol > bestVol) { bestVol = vol; best = t.curveId; }
    }
    return bestVol > 0 ? best : null;
  }, [tokens, tokenStats, search]);

  const sorted = [...filtered].sort((a, b) => {
    const sa = tokenStats[a.curveId];
    const sb = tokenStats[b.curveId];
    switch (sort) {
      case 'newest':     return (b.timestamp || 0) - (a.timestamp || 0);
      case 'oldest':     return (a.timestamp || 0) - (b.timestamp || 0);
      case 'trending':   return (sb?.recentTrades || 0) - (sa?.recentTrades || 0);
      case 'last_trade': return (sb?.lastTradeTime || 0) - (sa?.lastTradeTime || 0);
      case 'market_cap': return (sb?.lastPrice || 0) - (sa?.lastPrice || 0);
      case 'volume':     return (sb?.volume || 0) - (sa?.volume || 0);
      case 'trades':     return (sb?.trades || 0) - (sa?.trades || 0);
      case 'reserve':    return (sb?.reserveSui || 0) - (sa?.reserveSui || 0);
      case 'progress':   return (sb?.reserveSui || 0) - (sa?.reserveSui || 0);
      default: return 0;
    }
  });

  const showLastTradeHint = sort === 'last_trade';

  return (
    <div>
      <div className="relative rounded-3xl border border-white/10 bg-gradient-to-br from-lime-950/20 via-black to-black p-8 sm:p-12 mb-8 text-center overflow-hidden">
        <div className="absolute top-0 left-1/2 -translate-x-1/2 w-96 h-32 bg-lime-400/10 blur-3xl rounded-full pointer-events-none" />
        <div className="relative">
          <div className="flex items-center justify-center gap-3 mb-4">
            <div className="relative">
              <Flame className="text-lime-400" size={36} />
              <div className="absolute inset-0 blur-xl bg-lime-400/60 -z-10" />
            </div>
            <h1 className="text-4xl sm:text-5xl font-bold tracking-tight text-white" style={{ fontFamily: "'Space Grotesk', sans-serif" }}>
              SUIPUMP<span className="text-lime-400">.</span>
            </h1>
          </div>
          <p className="text-sm sm:text-base text-white/50 font-mono mb-2 max-w-lg mx-auto leading-relaxed">{t(lang,'heroTagline')}</p>
          <p className="text-xs text-white/30 font-mono mb-8 max-w-lg mx-auto">{t(lang,'heroSub')}</p>
          {account ? (
            <button onClick={onLaunch} className="inline-flex items-center gap-2 px-8 py-3.5 bg-lime-400 text-black font-mono text-sm tracking-widest hover:bg-lime-300 transition-colors rounded-2xl font-bold shadow-lg shadow-lime-400/20">
              <Rocket size={14} /> {t(lang,'launchAToken')}
            </button>
          ) : (
            <ConnectWalletHero lang={lang} />
          )}
        </div>
      </div>

      <StatsBar tokenCount={tokens.length} stats={stats} lang={lang} />

      <div className="flex flex-col sm:flex-row gap-3 mb-4">
        <div className="relative flex-1">
          <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-white/35 pointer-events-none" />
          <input
            value={search} onChange={e => setSearch(e.target.value)}
            placeholder={t(lang,'searchPlaceholder')}
            className="w-full bg-white/5 border border-white/10 rounded-xl pl-9 pr-4 py-2.5 text-white text-xs font-mono focus:outline-none focus:border-lime-400/40 transition-colors placeholder-white/20"
          />
        </div>
        <div className="flex gap-1.5 flex-wrap">
          {SORT_OPTIONS.map(opt => (
            <button key={opt.id} onClick={() => setSort(opt.id)}
              className={`px-3 py-2 rounded-xl text-[10px] font-mono tracking-widest transition-all whitespace-nowrap ${
                sort === opt.id ? 'bg-lime-400 text-black font-bold' : 'bg-white/5 text-white/30 hover:bg-white/10 hover:text-white/60'
              }`}>{opt.label}</button>
          ))}
        </div>
      </div>

      <div className="mb-3 flex items-center justify-between">
        <div className="text-xs font-mono text-white/30 tracking-widest">
          {loading ? t(lang,'loadingTokens') : `${sorted.length} ${t(lang, sorted.length !== 1 ? 'tokensLaunched' : 'tokensLaunched')}${search ? ` ${t(lang,'tokensFound')}` : ''}`}
        </div>
        {showLastTradeHint && (
          <div className="text-[10px] font-mono text-white/35">{t(lang,'sortedByLastTrade')}</div>
        )}
        {sort === 'market_cap' && (
          <div className="text-[10px] font-mono text-white/35">{t(lang,'marketCapFormula')}</div>
        )}
      </div>

      {/* Community Crown featured banner */}
      {!search.trim() && crownCurveId && (
        <CrownBanner
          token={tokens.find(t => t.curveId === crownCurveId)}
          stats={tokenStats[crownCurveId]}
          suiUsd={suiUsd}
        />
      )}

      {error && (
        <div className="rounded-2xl border border-red-500/20 bg-red-950/20 p-4 text-xs font-mono text-red-400 mb-4">Failed to load tokens: {error}</div>
      )}

      {loading && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {[...Array(6)].map((_, i) => <SkeletonCard key={i} />)}
        </div>
      )}

      {!loading && sorted.length === 0 && !error && (
        <div className="rounded-3xl border border-white/10 p-16 text-center">
          <div className="text-5xl mb-4">{search ? '🔍' : '🔥'}</div>
          <div className="text-sm font-mono text-white/40 mb-2">{search ? `No tokens matching "${search}"` : t(lang,'noTokensYet')}</div>
          {!search && <div className="text-xs font-mono text-white/35">{t(lang,'beFirstToLaunch')}</div>}
        </div>
      )}

      {!loading && sorted.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-y-6 gap-x-3">
          {sorted.map((token) => (
            <TokenCard
              key={token.curveId}
              token={token}
              stats={tokenStats[token.curveId]}
              isCrown={token.curveId === crownCurveId}
              suiUsd={suiUsd}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ── Token page wrapper ────────────────────────────────────────────────────────

function TokenPageWrapper() {
  const { curveId } = useParams();
  const navigate = useNavigate();
  const client = useSuiClient();
  const [tokenType, setTokenType] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!curveId) return;
    let cancelled = false;
    async function load() {
      try {
        const obj = await client.getObject({ id: curveId, options: { showContent: true, showType: true } });
        if (cancelled) return;
        const typeStr = obj.data?.type ?? '';
        const match = typeStr.match(/Curve<(.+)>$/);
        if (match) setTokenType(match[1]);
        else setError('Could not determine token type');
      } catch (err) {
        if (!cancelled) setError(err.message || String(err));
      }
    }
    load();
    return () => { cancelled = true; };
  }, [curveId, client]);

  if (error) return <div className="text-xs font-mono text-red-500 p-8">Failed to load token: {error}</div>;
  if (!tokenType) return (
    <div className="rounded-2xl border border-white/5 bg-white/[0.02] p-8 animate-pulse">
      <div className="h-4 bg-white/5 rounded w-48 mb-3" />
      <div className="h-3 bg-white/5 rounded w-32" />
    </div>
  );
  return <TokenPage curveId={curveId} tokenType={tokenType} onBack={() => navigate('/')} />;
}

// ── App root ──────────────────────────────────────────────────────────────────

export default function App() {
  const navigate = useNavigate();
  const [showLaunch, setShowLaunch] = useState(false);
  const [lang, setLang] = useState(() => localStorage.getItem('suipump_lang') || 'en');

  const handleLang = (code) => {
    setLang(code);
    localStorage.setItem('suipump_lang', code);
  };

  const handleLaunched = ({ curveId }) => { setShowLaunch(false); navigate(`/token/${curveId}`); };

  return (
    <div className="min-h-screen bg-[#080808] text-white" style={{ fontFamily: "'JetBrains Mono', ui-monospace, monospace" }}>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;700&family=Space+Grotesk:wght@700&display=swap');`}</style>
      <div className="fixed inset-0 pointer-events-none opacity-[0.03]" style={{
        backgroundImage: 'linear-gradient(rgba(132,204,22,1) 1px, transparent 1px), linear-gradient(90deg, rgba(132,204,22,1) 1px, transparent 1px)',
        backgroundSize: '60px 60px',
      }} />
      <ScrollToTop />
      <Header onLaunch={() => setShowLaunch(true)} lang={lang} setLang={handleLang} />
      <main className="max-w-6xl mx-auto px-4 py-6">
        <Routes>
          <Route path="/" element={<HomePage onLaunch={() => setShowLaunch(true)} lang={lang} />} />
          <Route path="/token/:curveId" element={<TokenPageWrapper />} />
          <Route path="/airdrop" element={<AirdropPage onBack={() => navigate('/')} />} />
          <Route path="/stats" element={<StatsPage onBack={() => navigate('/')} />} />
          <Route path="/whitepaper" element={<WhitepaperPage onBack={() => navigate('/')} />} />
          <Route path="/leaderboard" element={<LeaderboardPage onBack={() => navigate('/')} />} />
          <Route path="/portfolio" element={<PortfolioPage onBack={() => navigate('/')} />} />
          <Route path="/roadmap" element={<RoadmapPage onBack={() => navigate('/')} />} />
        </Routes>
      </main>
      <footer className="max-w-6xl mx-auto px-4 py-8 text-[10px] font-mono text-white/35 text-center tracking-widest border-t border-white/5 mt-8">
        {t(lang,'footerText')}
      </footer>
      {showLaunch && <LaunchModal onClose={() => setShowLaunch(false)} onLaunched={handleLaunched} />}
    </div>
  );
}
