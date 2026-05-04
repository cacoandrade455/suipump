// App.jsx — react-router-dom based routing
import React, { useState, useEffect } from 'react';
import { Routes, Route, useNavigate, useParams, Link, useLocation } from 'react-router-dom';
import { ConnectButton, useCurrentAccount, useSuiClient } from '@mysten/dapp-kit';
import { Flame, Rocket, Plus, Gift, TrendingUp, Coins, Users, Trophy } from 'lucide-react';

import { useTokenList } from './useTokenList.js';
import TokenPage from './TokenPage.jsx';
import LaunchModal from './LaunchModal.jsx';
import AirdropPage from './AirdropPage.jsx';
import WhitepaperPage from './WhitepaperPage.jsx';
import LeaderboardPage from './LeaderboardPage.jsx';
import { PACKAGE_ID, DRAIN_SUI_APPROX, TOKEN_DECIMALS } from './constants.js';
import { mistToSui, priceMistPerToken } from './curve.js';

const MIST_PER_SUI = 1e9;

function fmt(n, d = 2) {
  if (!Number.isFinite(n)) return '—';
  if (n >= 1e9) return (n / 1e9).toFixed(d) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(d) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(d) + 'k';
  return n.toFixed(d);
}

// Scroll to top on route change
function ScrollToTop() {
  const { pathname } = useLocation();
  useEffect(() => { window.scrollTo(0, 0); }, [pathname]);
  return null;
}

// Live stats hook
function useStats() {
  const client = useSuiClient();
  const [stats, setStats] = useState({ poolSui: null, tradeCount: null, volume: null });

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [buys, sells] = await Promise.all([
          client.queryEvents({ query: { MoveEventType: `${PACKAGE_ID}::bonding_curve::TokensPurchased` }, limit: 100, order: 'descending' }),
          client.queryEvents({ query: { MoveEventType: `${PACKAGE_ID}::bonding_curve::TokensSold` }, limit: 100, order: 'descending' }),
        ]);
        let protocolMist = 0;
        let volumeMist = 0;
        for (const e of buys.data) {
          protocolMist += Number(e.parsedJson?.protocol_fee ?? 0);
          volumeMist += Number(e.parsedJson?.sui_in ?? 0);
        }
        for (const e of sells.data) {
          protocolMist += Number(e.parsedJson?.protocol_fee ?? 0);
          volumeMist += Number(e.parsedJson?.sui_out ?? 0);
        }
        if (!cancelled) setStats({
          poolSui: (protocolMist * 0.5) / MIST_PER_SUI,
          tradeCount: buys.data.length + sells.data.length,
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

// Token card
function TokenCard({ token }) {
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
      className="text-left rounded-2xl border border-white/10 bg-white/[0.03] hover:bg-white/[0.06] hover:border-lime-400/30 transition-all duration-200 p-4 w-full group"
    >
      <div className="flex items-start justify-between mb-3">
        <div className="flex items-center gap-3">
          <div className="w-11 h-11 rounded-full overflow-hidden border-2 border-white/10 group-hover:border-lime-400/30 flex items-center justify-center bg-lime-950/30 shrink-0 transition-all">
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
        {graduated && (
          <div className="text-[10px] font-mono text-emerald-400 bg-emerald-400/10 border border-emerald-400/20 px-2 py-0.5 rounded-full">
            GRAD
          </div>
        )}
      </div>

      <div className="mb-3">
        <div className="flex justify-between text-[10px] font-mono mb-1.5">
          <span className="text-white/30">BONDING CURVE</span>
          <span className="text-lime-400/60">{fmt(progress, 1)}%</span>
        </div>
        <div className="h-1.5 bg-white/5 rounded-full overflow-hidden">
          <div
            className="h-full bg-gradient-to-r from-lime-600 to-lime-400 rounded-full transition-all duration-500"
            style={{ width: `${Math.max(progress, 1)}%` }}
          />
        </div>
      </div>

      <div className="flex items-center justify-between">
        <span className="text-[11px] font-mono text-white/30">{timeAgo}</span>
        <span className="text-[11px] font-mono text-white/60">
          {curveState ? `${(Number(priceMist) / 1e9).toFixed(7)} SUI` : '…'}
        </span>
      </div>
    </button>
  );
}

// Skeleton card
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

// Header
function Header({ onLaunch }) {
  const account = useCurrentAccount();
  const { poolSui, tradeCount } = useStats();

  return (
    <header className="border-b border-white/5 bg-black/80 backdrop-blur sticky top-0 z-40">
      <div className="max-w-6xl mx-auto px-4 py-3 flex items-center justify-between">
        <Link to="/" className="flex items-center gap-3 hover:opacity-80 transition-opacity">
          <div className="relative">
            <Flame className="text-lime-400" size={22} />
            <div className="absolute inset-0 blur-lg bg-lime-400/40 -z-10" />
          </div>
          <div>
            <div className="text-base font-bold tracking-tight text-white" style={{ fontFamily: "'Space Grotesk', sans-serif" }}>
              SUIPUMP<span className="text-lime-400">.</span>
            </div>
            <div className="text-[9px] font-mono text-white/30 tracking-[0.2em] -mt-0.5">TESTNET · LIVE</div>
          </div>
        </Link>

        <div className="flex items-center gap-2">
          <Link to="/airdrop"
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-white/10 text-[10px] font-mono text-white/50 hover:border-lime-400/40 hover:text-lime-400 transition-all"
          >
            <Gift size={10} />
            {poolSui !== null ? <span>S1 {poolSui.toFixed(4)} SUI</span> : <span>S1 AIRDROP</span>}
            {tradeCount !== null && <span className="text-white/20 ml-1">· {tradeCount} trades</span>}
          </Link>
          <Link to="/leaderboard"
            className="px-3 py-1.5 rounded-lg border border-white/10 text-[10px] font-mono text-white/50 hover:border-lime-400/40 hover:text-lime-400 transition-all hidden sm:flex items-center gap-1.5"
          >
            <Trophy size={10} /> LEADERBOARD
          </Link>
          <Link to="/whitepaper"
            className="px-3 py-1.5 rounded-lg border border-white/10 text-[10px] font-mono text-white/50 hover:border-lime-400/40 hover:text-lime-400 transition-all hidden sm:block"
          >
            WHITEPAPER
          </Link>
          {account && (
            <button onClick={onLaunch}
              className="flex items-center gap-2 px-4 py-2 bg-lime-400 text-black text-xs font-mono tracking-widest hover:bg-lime-300 transition-colors rounded-xl font-bold"
            >
              <Plus size={12} /> LAUNCH TOKEN
            </button>
          )}
          <ConnectButton />
        </div>
      </div>
    </header>
  );
}

// Stats bar
function StatsBar({ tokenCount, stats }) {
  const items = [
    { icon: <Coins size={13} />, label: 'TOKENS', value: tokenCount ?? '—' },
    { icon: <TrendingUp size={13} />, label: 'TRADES', value: stats.tradeCount ?? '—' },
    { icon: <Flame size={13} />, label: 'VOLUME', value: stats.volume != null ? `${fmt(stats.volume)} SUI` : '—' },
    { icon: <Gift size={13} />, label: 'S1 POOL', value: stats.poolSui != null ? `${stats.poolSui.toFixed(2)} SUI` : '—' },
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

// Homepage
function HomePage({ onLaunch }) {
  const account = useCurrentAccount();
  const { tokens, loading, error } = useTokenList();
  const stats = useStats();

  return (
    <div>
      {/* Hero */}
      <div className="relative rounded-3xl border border-white/10 bg-gradient-to-br from-lime-950/20 via-black to-black p-8 sm:p-12 mb-8 text-center overflow-hidden">
        {/* Glow */}
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

          <p className="text-sm sm:text-base text-white/50 font-mono mb-2 max-w-lg mx-auto leading-relaxed">
            Permissionless token launchpad on Sui.
          </p>
          <p className="text-xs text-white/30 font-mono mb-8 max-w-lg mx-auto">
            Fair launch · No pre-mine · 40% creator fees · Graduates to Cetus
          </p>

          {account ? (
            <button onClick={onLaunch}
              className="inline-flex items-center gap-2 px-8 py-3.5 bg-lime-400 text-black font-mono text-sm tracking-widest hover:bg-lime-300 transition-colors rounded-2xl font-bold shadow-lg shadow-lime-400/20"
            >
              <Rocket size={14} /> LAUNCH A TOKEN
            </button>
          ) : (
            <div className="inline-flex items-center gap-2 px-6 py-3 rounded-2xl border border-white/10 text-sm font-mono text-white/40">
              CONNECT WALLET TO LAUNCH
            </div>
          )}
        </div>
      </div>

      {/* Stats */}
      <StatsBar tokenCount={tokens.length} stats={stats} />

      {/* Token grid header */}
      <div className="mb-4 flex items-center justify-between">
        <div className="text-xs font-mono text-white/40 tracking-widest">
          {loading ? 'LOADING TOKENS…' : `${tokens.length} TOKEN${tokens.length !== 1 ? 'S' : ''} LAUNCHED`}
        </div>
        <div className="text-[10px] font-mono text-white/20">SORTED BY NEWEST</div>
      </div>

      {error && (
        <div className="rounded-2xl border border-red-500/20 bg-red-950/20 p-4 text-xs font-mono text-red-400 mb-4">
          Failed to load tokens: {error}
        </div>
      )}

      {/* Skeletons while loading */}
      {loading && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {[...Array(6)].map((_, i) => <SkeletonCard key={i} />)}
        </div>
      )}

      {!loading && tokens.length === 0 && !error && (
        <div className="rounded-3xl border border-white/10 p-16 text-center">
          <div className="text-5xl mb-4">🔥</div>
          <div className="text-sm font-mono text-white/40 mb-2">NO TOKENS YET</div>
          <div className="text-xs font-mono text-white/20">Be the first to launch a token on SuiPump.</div>
        </div>
      )}

      {!loading && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {tokens.map((token) => <TokenCard key={token.curveId} token={token} />)}
        </div>
      )}
    </div>
  );
}

// Token page wrapper
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

// Root app
export default function App() {
  const navigate = useNavigate();
  const [showLaunch, setShowLaunch] = useState(false);

  const handleLaunched = ({ curveId }) => {
    setShowLaunch(false);
    navigate(`/token/${curveId}`);
  };

  return (
    <div className="min-h-screen bg-[#080808] text-white" style={{ fontFamily: "'JetBrains Mono', ui-monospace, monospace" }}>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;700&family=Space+Grotesk:wght@700&display=swap');`}</style>

      {/* Subtle grid */}
      <div className="fixed inset-0 pointer-events-none opacity-[0.03]" style={{
        backgroundImage: 'linear-gradient(rgba(132,204,22,1) 1px, transparent 1px), linear-gradient(90deg, rgba(132,204,22,1) 1px, transparent 1px)',
        backgroundSize: '60px 60px',
      }} />

      <ScrollToTop />
      <Header onLaunch={() => setShowLaunch(true)} />

      <main className="max-w-6xl mx-auto px-4 py-6">
        <Routes>
          <Route path="/" element={<HomePage onLaunch={() => setShowLaunch(true)} />} />
          <Route path="/token/:curveId" element={<TokenPageWrapper />} />
          <Route path="/airdrop" element={<AirdropPage onBack={() => navigate('/')} />} />
          <Route path="/whitepaper" element={<WhitepaperPage onBack={() => navigate('/')} />} />
          <Route path="/leaderboard" element={<LeaderboardPage onBack={() => navigate('/')} />} />
        </Routes>
      </main>

      <footer className="max-w-6xl mx-auto px-4 py-8 text-[10px] font-mono text-white/20 text-center tracking-widest border-t border-white/5 mt-8">
        SUIPUMP · TESTNET DEMO · CONTRACTS UNAUDITED · DYOR
      </footer>

      {showLaunch && (
        <LaunchModal onClose={() => setShowLaunch(false)} onLaunched={handleLaunched} />
      )}
    </div>
  );
}
