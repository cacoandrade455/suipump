// TradeHistory.jsx
// Live feed of recent buys and sells for a single curve.
// Queries TokensPurchased and TokensSold events, merges, sorts by time,
// and shows the 20 most recent trades with auto-refresh every 10s.

import React, { useState, useEffect } from 'react';
import { useSuiClient } from '@mysten/dapp-kit';
import { ArrowUpRight, ArrowDownLeft } from 'lucide-react';
import { PACKAGE_ID } from './constants.js';

const MIST_PER_SUI = 1e9;

function fmt(n, d = 4) {
  if (!Number.isFinite(n)) return '—';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(2) + 'k';
  return n.toFixed(d);
}

function timeAgo(ts) {
  const diff = Date.now() - ts;
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

function shortAddr(addr) {
  if (!addr) return '—';
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export default function TradeHistory({ curveId, symbol, refreshKey }) {
  const client = useSuiClient();
  const [trades, setTrades] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const [buys, sells] = await Promise.all([
          client.queryEvents({
            query: { MoveEventType: `${PACKAGE_ID}::bonding_curve::TokensPurchased` },
            limit: 50,
            order: 'descending',
          }),
          client.queryEvents({
            query: { MoveEventType: `${PACKAGE_ID}::bonding_curve::TokensSold` },
            limit: 50,
            order: 'descending',
          }),
        ]);

        // Filter to this curve and normalize
        const buyTrades = buys.data
          .filter(e => e.parsedJson?.curve_id === curveId)
          .map(e => ({
            kind: 'buy',
            addr: e.parsedJson.buyer,
            suiAmount: Number(e.parsedJson.sui_in) / MIST_PER_SUI,
            tokenAmount: Number(e.parsedJson.tokens_out) / 1e6,
            ts: Number(e.timestampMs),
            digest: e.id.txDigest,
          }));

        const sellTrades = sells.data
          .filter(e => e.parsedJson?.curve_id === curveId)
          .map(e => ({
            kind: 'sell',
            addr: e.parsedJson.seller,
            suiAmount: Number(e.parsedJson.sui_out) / MIST_PER_SUI,
            tokenAmount: Number(e.parsedJson.tokens_in) / 1e6,
            ts: Number(e.timestampMs),
            digest: e.id.txDigest,
          }));

        const merged = [...buyTrades, ...sellTrades]
          .sort((a, b) => b.ts - a.ts)
          .slice(0, 30);

        if (!cancelled) {
          setTrades(merged);
          setLoading(false);
        }
      } catch {
        if (!cancelled) setLoading(false);
      }
    }

    setLoading(true);
    load();
    const t = setInterval(load, 10_000);
    return () => { cancelled = true; clearInterval(t); };
  }, [curveId, client, refreshKey]);

  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
      <div className="text-[10px] font-mono tracking-widest text-white/30 mb-4">TRADE HISTORY</div>

      {loading && (
        <div className="space-y-2">
          {[...Array(5)].map((_, i) => (
            <div key={i} className="h-8 bg-white/5 rounded-lg animate-pulse" />
          ))}
        </div>
      )}

      {!loading && trades.length === 0 && (
        <div className="text-xs font-mono text-white/20 text-center py-6">
          No trades yet. Be the first.
        </div>
      )}

      {!loading && trades.length > 0 && (
        <div className="space-y-1">
          {/* Header */}
          <div className="grid grid-cols-4 text-[9px] font-mono text-white/20 tracking-widest pb-2 border-b border-white/5">
            <span>TYPE</span>
            <span className="text-right">SUI</span>
            <span className="text-right">{symbol}</span>
            <span className="text-right">TIME</span>
          </div>

          {trades.map((trade, i) => (
            <a
              key={`${trade.digest}-${i}`}
              href={`https://testnet.suivision.xyz/txblock/${trade.digest}`}
              target="_blank"
              rel="noreferrer"
              className="grid grid-cols-4 items-center py-2 border-b border-white/[0.03] last:border-0 hover:bg-white/5 rounded-lg px-1 -mx-1 transition-colors group"
            >
              {/* Type + address */}
              <div className="flex items-center gap-2">
                {trade.kind === 'buy' ? (
                  <div className="flex items-center gap-1 text-lime-400">
                    <ArrowUpRight size={11} />
                    <span className="text-[10px] font-mono font-bold">BUY</span>
                  </div>
                ) : (
                  <div className="flex items-center gap-1 text-red-400">
                    <ArrowDownLeft size={11} />
                    <span className="text-[10px] font-mono font-bold">SELL</span>
                  </div>
                )}
              </div>

              {/* SUI amount */}
              <div className={`text-right text-[11px] font-mono font-bold ${
                trade.kind === 'buy' ? 'text-lime-400' : 'text-red-400'
              }`}>
                {trade.kind === 'buy' ? '-' : '+'}{fmt(trade.suiAmount, 3)} SUI
              </div>

              {/* Token amount */}
              <div className={`text-right text-[11px] font-mono ${
                trade.kind === 'buy' ? 'text-white/70' : 'text-white/40'
              }`}>
                {trade.kind === 'buy' ? '+' : '-'}{fmt(trade.tokenAmount, 0)}
              </div>

              {/* Time */}
              <div className="text-right text-[10px] font-mono text-white/25 group-hover:text-white/40 transition-colors">
                {trade.ts ? timeAgo(trade.ts) : '—'}
              </div>
            </a>
          ))}
        </div>
      )}

      {!loading && trades.length > 0 && (
        <div className="mt-3 text-[9px] font-mono text-white/15 text-center">
          SHOWING LAST {trades.length} TRADES · UPDATES EVERY 10S
        </div>
      )}
    </div>
  );
}
