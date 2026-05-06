// TradeHistory.jsx
import React, { useState, useEffect } from 'react';
import { useSuiClient } from '@mysten/dapp-kit';
import { ArrowUpRight, ArrowDownRight } from 'lucide-react';
import { PACKAGE_ID } from './constants.js';
import { paginateMultipleEvents } from './paginateEvents.js';

const MIST_PER_SUI = 1e9;

function timeAgo(ts) {
  if (!ts) return '';
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

export default function TradeHistory({ curveId, symbol, refreshKey }) {
  const client = useSuiClient();
  const [trades, setTrades] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        setLoading(true);

        const buyType = `${PACKAGE_ID}::bonding_curve::TokensPurchased`;
        const sellType = `${PACKAGE_ID}::bonding_curve::TokensSold`;

        const eventMap = await paginateMultipleEvents(
          client,
          [buyType, sellType],
          { order: 'descending', maxPages: 20 }
        );

        if (cancelled) return;

        const all = [
          ...eventMap[buyType]
            .filter(e => e.parsedJson?.curve_id === curveId)
            .map(e => ({
              kind: 'buy',
              sui: Number(e.parsedJson.sui_in) / MIST_PER_SUI,
              tokens: Number(e.parsedJson.tokens_out) / 1e6,
              who: e.parsedJson.buyer,
              ts: e.timestampMs ? Number(e.timestampMs) : null,
              digest: e.id?.txDigest,
            })),
          ...eventMap[sellType]
            .filter(e => e.parsedJson?.curve_id === curveId)
            .map(e => ({
              kind: 'sell',
              sui: Number(e.parsedJson.sui_out) / MIST_PER_SUI,
              tokens: Number(e.parsedJson.tokens_in) / 1e6,
              who: e.parsedJson.seller,
              ts: e.timestampMs ? Number(e.timestampMs) : null,
              digest: e.id?.txDigest,
            })),
        ].sort((a, b) => (b.ts || 0) - (a.ts || 0)).slice(0, 50);

        if (!cancelled) { setTrades(all); setLoading(false); }
      } catch { if (!cancelled) setLoading(false); }
    }
    load();
    return () => { cancelled = true; };
  }, [curveId, client, refreshKey]);

  if (loading) return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4 animate-pulse">
      <div className="h-3 bg-white/5 rounded w-32 mb-3" />
      {[...Array(3)].map((_, i) => <div key={i} className="h-8 bg-white/5 rounded mb-2" />)}
    </div>
  );

  if (trades.length === 0) return null;

  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
      <div className="text-[10px] font-mono text-white/30 tracking-widest mb-3">
        TRADE HISTORY · {trades.length} TRADE{trades.length !== 1 ? 'S' : ''}
      </div>
      <div className="space-y-1 max-h-64 overflow-y-auto">
        {trades.map((t, i) => (
          <div key={i} className="flex items-center justify-between text-xs font-mono py-1.5 border-b border-white/5 last:border-0">
            <div className="flex items-center gap-2">
              {t.kind === 'buy'
                ? <ArrowUpRight size={12} className="text-lime-400" />
                : <ArrowDownRight size={12} className="text-red-400" />}
              <span className={t.kind === 'buy' ? 'text-lime-400' : 'text-red-400'}>
                {t.kind.toUpperCase()}
              </span>
              <span className="text-white/40 hidden sm:inline">
                {t.who ? `${t.who.slice(0, 6)}…${t.who.slice(-4)}` : ''}
              </span>
            </div>
            <div className="flex items-center gap-4">
              <span className="text-white/60">{t.sui.toFixed(4)} SUI</span>
              <span className="text-white/30">{t.tokens.toFixed(0)} {symbol}</span>
              <span className="text-white/20">{timeAgo(t.ts)}</span>
              {t.digest && (
                <a href={`https://testnet.suivision.xyz/txblock/${t.digest}`}
                  target="_blank" rel="noreferrer"
                  className="text-white/20 hover:text-lime-400 transition-colors"
                >↗</a>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
