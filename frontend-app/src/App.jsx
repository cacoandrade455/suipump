// App.jsx

import React, { useState, useEffect } from 'react';
import { ConnectButton, useCurrentAccount, useSuiClient } from '@mysten/dapp-kit';
import { Flame, Rocket, Plus, Gift } from 'lucide-react';

import { useTokenList } from './useTokenList.js';
import TokenPage from './TokenPage.jsx';
import LaunchModal from './LaunchModal.jsx';
import AirdropPage from './AirdropPage.jsx';
import WhitepaperPage from './WhitepaperPage.jsx';
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

// Minimal hook for header stats — pool SUI + trade count
function useHeaderStats() {
  const client = useSuiClient();
  const [poolSui, setPoolSui] = useState(null);
  const [tradeCount, setTradeCount] = useState(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [buys, sells] = await Promise.all([
          client.queryEvents({
            query: { MoveEventType: `${PACKAGE_ID}::bonding_curve::TokensPurchased` },
            limit: 100, order: 'descending',
          }),
          client.queryEvents({
            query: { MoveEventType: `${PACKAGE_ID}::bonding_curve::TokensSold` },
            limit: 100, order: 'descending',
          }),
        ]);
        let protocolMist = 0;
        for (const e of [...buys.data, ...sells.data]) {
          protocolMist += Number(e.parsedJson?.protocol_fee ?? 0);
        }
        if (!cancelled) {
          setPoolSui((protocolMist * 0.5) / MIST_PER_SUI);
          setTradeCount(buys.data.length + sells.data.length);
        }
      } catch { }
    }
    load();
    const t = setInterval(load, 30_000);
    return () => { cancelled = true; clearInterval(t); };
  }, [client]);

  return { poolSui, tradeCount };
}

// ── Token card ───────────────────────────────────────────────────────────────
function TokenCard({ token, onClick }) {
  const client = useSuiClient();
  const [curveState, setCurveState] = React.useState(null);
  const [iconUrl, setIconUrl] = React.useState(null);

  React.useEffect(() => {
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

  // Fetch icon from CoinMetadata
  React.useEffect(() => {
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
    <button onClick={onClick}
      className="text-left border border-lime-900/50 bg-black hover:border-lime-500/60 hover:bg-lime-950/10 transition-all p-4 w-full"
    >
      <div className="flex items-start justify-between mb-3">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-full overflow-hidden border border-lime-900 flex items-center justify-center bg-lime-950/20 shrink-0">
            {iconUrl
              ? <img src={iconUrl} alt={token.symbol} className="w-full h-full object-cover"
                  onError={e => { e.target.style.display='none'; e.target.parentNode.innerHTML='<span style="font-size:1.25rem">🔥</span>'; }} />
              : <span className="text-xl">🔥</span>
            }
          </div>
          <div>
            <div className="text-sm font-bold text-lime-100 font-mono">{token.name}</div>
            <div className="text-[10px] text-lime-600 font-mono">${token.symbol}</div>
          </div>
        </div>
        {graduated && (
          <div className="text-[10px] font-mono text-emerald-400 border border-emerald-800 px-2 py-0.5">GRAD</div>
        )}
      </div>
      <div className="mb-2">
        <div className="flex justify-between text-[9px] font-mono text-lime-800 mb-1">
          <span>BONDING CURVE</span><span>{fmt(progress, 1)}%</span>
        </div>
        <div className="h-1.5 bg-lime-950">
          <div className="h-full bg-gradient-to-r from-lime-700 to-lime-400" style={{ width: `${progress}%` }} />
        </div>
      </div>
      <div className="flex items-center justify-between text-[10px] font-mono">
        <span className="text-lime-700">{timeAgo}</span>
        <span className="text-lime-500">{curveState ? `${(Number(priceMist) / 1e9).toFixed(7)} SUI` : '…'}</span>
      </div>
    </button>
  );
}

// ── Main App ─────────────────────────────────────────────────────────────────
export default function App() {
  const account = useCurrentAccount();
  const { tokens, loading, error } = useTokenList();
  const { poolSui, tradeCount } = useHeaderStats();
  const [activePage, setActivePage] = useState(null); // null | {curveId,...} | 'airdrop'
  const [showLaunch, setShowLaunch] = useState(false);

  const handleLaunched = ({ curveId, tokenType, name, symbol }) => {
    setShowLaunch(false);
    setActivePage({ curveId, tokenType, name, symbol });
  };

  return (
    <div className="min-h-screen bg-black text-lime-100" style={{ fontFamily: "'JetBrains Mono', ui-monospace, monospace" }}>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;700&family=Space+Grotesk:wght@700&display=swap');`}</style>

      <div className="fixed inset-0 pointer-events-none opacity-[0.04]" style={{
        backgroundImage: 'linear-gradient(rgba(132,204,22,0.8) 1px, transparent 1px), linear-gradient(90deg, rgba(132,204,22,0.8) 1px, transparent 1px)',
        backgroundSize: '40px 40px',
      }} />

      {/* Header */}
      <header className="border-b border-lime-900/60 bg-black/80 backdrop-blur sticky top-0 z-40">
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center justify-between">
          <button onClick={() => setActivePage(null)} className="flex items-center gap-3 hover:opacity-80 transition-opacity">
            <div className="relative">
              <Flame className="text-lime-400" size={24} />
              <div className="absolute inset-0 blur-md bg-lime-400/50 -z-10" />
            </div>
            <div>
              <div className="text-lg font-bold tracking-tight" style={{ fontFamily: "'Space Grotesk', sans-serif" }}>
                SUIPUMP<span className="text-lime-400">.</span>
              </div>
              <div className="text-[9px] font-mono text-lime-700 tracking-[0.2em] -mt-1">TESTNET · LIVE</div>
            </div>
          </button>

          <div className="flex items-center gap-2">
            {/* S1 airdrop pill */}
            <button
              onClick={() => setActivePage('airdrop')}
              className="flex items-center gap-1.5 px-3 py-1.5 border border-lime-900/60 text-[10px] font-mono text-lime-700 hover:border-lime-600 hover:text-lime-400 transition-colors"
            >
              <Gift size={10} />
              {poolSui !== null ? (
                <span>S1 {poolSui.toFixed(4)} SUI</span>
              ) : (
                <span>S1 AIRDROP</span>
              )}
              {tradeCount !== null && (
                <span className="text-lime-900 ml-1">· {tradeCount} trades</span>
              )}
            </button>

            {/* Whitepaper link */}
            <button
              onClick={() => setActivePage('whitepaper')}
              className="px-3 py-1.5 border border-lime-900/60 text-[10px] font-mono text-lime-700 hover:border-lime-600 hover:text-lime-400 transition-colors hidden sm:block"
            >
              WHITEPAPER
            </button>

            {account && (
              <button onClick={() => setShowLaunch(true)}
                className="flex items-center gap-2 px-4 py-2 bg-lime-400 text-black text-xs font-mono tracking-widest hover:bg-lime-300 transition-colors"
              >
                <Plus size={12} /> LAUNCH TOKEN
              </button>
            )}
            <ConnectButton />
          </div>
        </div>
      </header>

      {/* Main content */}
      <main className="max-w-6xl mx-auto px-4 py-6">
        {activePage === 'airdrop' ? (
          <AirdropPage onBack={() => setActivePage(null)} />
        ) : activePage === 'whitepaper' ? (
          <WhitepaperPage onBack={() => setActivePage(null)} />
        ) : activePage ? (
          <TokenPage
            curveId={activePage.curveId}
            tokenType={activePage.tokenType}
            onBack={() => setActivePage(null)}
          />
        ) : (
          <div>
            {/* Hero */}
            <div className="border border-lime-900/30 bg-gradient-to-br from-lime-950/10 to-black p-8 mb-8 text-center">
              <div className="flex items-center justify-center gap-3 mb-3">
                <Flame className="text-lime-400" size={28} />
                <h1 className="text-3xl font-bold tracking-tight" style={{ fontFamily: "'Space Grotesk', sans-serif" }}>
                  SUIPUMP<span className="text-lime-400">.</span>
                </h1>
              </div>
              <p className="text-sm text-lime-600 font-mono mb-6 max-w-md mx-auto">
                Permissionless token launchpad on Sui. Fair launch. No pre-mine. Creator-first fees.
              </p>
              {account ? (
                <button onClick={() => setShowLaunch(true)}
                  className="flex items-center gap-2 px-6 py-3 bg-lime-400 text-black font-mono text-sm tracking-widest hover:bg-lime-300 transition-colors mx-auto"
                >
                  <Rocket size={14} /> LAUNCH A TOKEN
                </button>
              ) : (
                <div className="text-xs font-mono text-lime-700">CONNECT WALLET TO LAUNCH A TOKEN</div>
              )}
            </div>

            {/* Token list header */}
            <div className="mb-4 flex items-center justify-between">
              <div className="text-xs font-mono text-lime-700 tracking-widest">
                {loading ? 'LOADING TOKENS…' : `${tokens.length} TOKEN${tokens.length !== 1 ? 'S' : ''} LAUNCHED`}
              </div>
              <div className="text-[10px] font-mono text-lime-900">SORTED BY NEWEST</div>
            </div>

            {error && (
              <div className="border border-red-900/50 bg-red-950/20 p-4 text-xs font-mono text-red-400 mb-4">
                Failed to load tokens: {error}
              </div>
            )}

            {!loading && tokens.length === 0 && !error && (
              <div className="border border-lime-900/30 p-12 text-center">
                <div className="text-4xl mb-4">🔥</div>
                <div className="text-sm font-mono text-lime-700 mb-2">NO TOKENS YET</div>
                <div className="text-xs font-mono text-lime-900">Be the first to launch a token on SuiPump.</div>
              </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {tokens.map((token) => (
                <TokenCard
                  key={token.curveId}
                  token={token}
                  onClick={() => token.tokenType && setActivePage({
                    curveId: token.curveId,
                    tokenType: token.tokenType,
                    name: token.name,
                    symbol: token.symbol,
                  })}
                />
              ))}
            </div>
          </div>
        )}
      </main>

      <footer className="max-w-6xl mx-auto px-4 py-8 text-[10px] font-mono text-lime-900 text-center tracking-widest">
        SUIPUMP · TESTNET DEMO · CONTRACTS UNAUDITED · DYOR
      </footer>

      {showLaunch && (
        <LaunchModal onClose={() => setShowLaunch(false)} onLaunched={handleLaunched} />
      )}
    </div>
  );
}
