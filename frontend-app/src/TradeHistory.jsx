// TradeHistory.jsx — receives trades + connected via props from TokenPage (shared SSE)
import React from 'react';
import { Link } from 'react-router-dom';
import { useCurrentAccount } from '@mysten/dapp-kit-react';
import { ArrowUpRight, ArrowDownRight } from 'lucide-react';

const MAX_TRADES = 200;

function timeAgo(ts) {
  if (!ts) return '';
  const diff = Date.now() - ts;
  if (diff < 60_000)     return 'just now';
  if (diff < 3_600_000)  return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

export default function TradeHistory({ trades = [], connected = false, loading = false, symbol, creator = null }) {
  const account = useCurrentAccount();
  const myAddr  = account?.address ?? null;

  if (loading) return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4 animate-pulse">
      <div className="h-3 bg-white/5 rounded w-32 mb-3" />
      {[...Array(3)].map((_, i) => <div key={i} className="h-8 bg-white/5 rounded mb-2" />)}
    </div>
  );

  return (
    <div className="rounded-2xl border border-white/[0.08] bg-white/[0.015] p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="text-[10px] font-mono font-semibold text-white/30 tracking-[0.12em]">
          TRADE HISTORY · {trades.length} TRADE{trades.length !== 1 ? 'S' : ''}
        </div>
        <div className={`w-1.5 h-1.5 rounded-full ${connected ? 'bg-lime-400' : 'bg-white/20'}`} title={connected ? 'Live' : 'Connecting…'} />
      </div>
      {trades.length === 0 ? (
        <div className="text-xs font-mono text-white/20 text-center py-4">No trades yet</div>
      ) : (
        <div className="max-h-64 overflow-y-auto -mx-4">
          {trades.slice(0, MAX_TRADES).map((t, i) => (
            <div key={t.id ?? i} className="flex items-center justify-between text-xs font-mono px-4 py-2 border-b border-white/[0.04] last:border-0 hover:bg-white/[0.025] transition-colors">
              <div className="flex items-center gap-2">
                {t.kind === 'buy'
                  ? <ArrowUpRight size={12} className="text-lime-400" />
                  : <ArrowDownRight size={12} className="text-red-400" />}
                <span className={t.kind === 'buy' ? 'text-lime-400' : 'text-red-400'}>
                  {t.kind.toUpperCase()}
                </span>
                {t.who && (
                  <Link to={`/portfolio/${t.who}`} className="text-white/40 hover:text-lime-400 transition-colors hidden sm:inline">
                    {`${t.who.slice(0, 6)}…${t.who.slice(-4)}`}
                  </Link>
                )}
                {myAddr && t.who === myAddr && (
                  <span className="text-[8px] font-mono font-bold text-violet-400 bg-violet-400/10 border border-violet-400/40 rounded px-1 py-0.5">YOU</span>
                )}
                {creator && t.who === creator && (
                  <span className="text-[8px] font-mono font-bold text-lime-400 bg-lime-400/10 border border-lime-400/30 rounded px-1 py-0.5">DEV</span>
                )}
              </div>
              <div className="flex items-center gap-4">
                <span className="text-white/60">{t.sui.toFixed(4)} SUI</span>
                <span className="text-white/30">{t.tokens.toFixed(0)} {symbol}</span>
                <span className="text-white/20">{timeAgo(t.ts)}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
