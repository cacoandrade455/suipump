// TradeHistory.jsx — initial HTTP fetch + SSE real-time append
import React, { useState, useEffect, useRef } from 'react';
import { ArrowUpRight, ArrowDownRight } from 'lucide-react';

const INDEXER_URL  = import.meta.env.VITE_INDEXER_URL || '';
const MIST_PER_SUI = 1e9;
const MAX_TRADES   = 200;

function timeAgo(ts) {
  if (!ts) return '';
  const diff = Date.now() - ts;
  if (diff < 60_000)     return 'just now';
  if (diff < 3_600_000)  return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

export default function TradeHistory({ curveId, symbol, creator = null }) {
  const [trades,    setTrades]    = useState([]);
  const [loading,   setLoading]   = useState(true);
  const [connected, setConnected] = useState(false);
  const seenRef  = useRef(new Set());
  const esRef    = useRef(null);
  const timerRef = useRef(null);

  // Initial HTTP fetch
  useEffect(() => {
    if (!curveId || !INDEXER_URL) return;
    let cancelled = false;

    fetch(`${INDEXER_URL}/token/${curveId}/trades?limit=200`)
      .then(r => r.ok ? r.json() : [])
      .then(rows => {
        if (cancelled) return;
        const items = rows.map(r => {
          const isBuy = r.event_type?.includes('TokensPurchased');
          const id    = `${r.tx_digest || r.curve_id}_${r.timestamp_ms}`;
          seenRef.current.add(id);
          return {
            id,
            kind:   isBuy ? 'buy' : 'sell',
            sui:    Number(isBuy ? r.data.sui_in ?? 0 : r.data.sui_out ?? 0) / MIST_PER_SUI,
            tokens: Number(isBuy ? r.data.tokens_out ?? 0 : r.data.tokens_in ?? 0) / 1e6,
            who:    r.data.buyer ?? r.data.seller,
            ts:     r.timestamp_ms ? Number(r.timestamp_ms) : null,
          };
        });
        setTrades(items);
        setLoading(false);
      })
      .catch(() => setLoading(false));

    return () => { cancelled = true; };
  }, [curveId]);

  // SSE for real-time updates
  useEffect(() => {
    if (!curveId || !INDEXER_URL) return;

    function connect() {
      const es = new EventSource(`${INDEXER_URL}/stream?curveId=${curveId}`);
      esRef.current = es;

      es.onopen = () => setConnected(true);

      es.onmessage = (e) => {
        try {
          const event = JSON.parse(e.data);
          if (event.type === 'connected') return;

          const isTrade = event.type === 'TokensPurchased' ||
                          event.type === 'TokensBought'    ||
                          event.type === 'TokensSold';
          if (!isTrade) return;

          const isBuy = event.type !== 'TokensSold';
          const d     = event.data ?? {};
          const id    = `sse_${event.ts}_${event.curveId}`;
          if (seenRef.current.has(id)) return;
          seenRef.current.add(id);

          const trade = {
            id,
            kind:   isBuy ? 'buy' : 'sell',
            sui:    Number(isBuy ? d.sui_in ?? 0 : d.sui_out ?? 0) / MIST_PER_SUI,
            tokens: Number(isBuy ? d.tokens_out ?? 0 : d.tokens_in ?? 0) / 1e6,
            who:    d.buyer ?? d.seller ?? null,
            ts:     event.ts ?? Date.now(),
          };

          setTrades(prev => [trade, ...prev].slice(0, MAX_TRADES));
        } catch {}
      };

      es.onerror = () => {
        setConnected(false);
        es.close();
        timerRef.current = setTimeout(connect, 3_000);
      };
    }

    connect();
    return () => {
      esRef.current?.close();
      clearTimeout(timerRef.current);
    };
  }, [curveId]);

  if (loading) return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4 animate-pulse">
      <div className="h-3 bg-white/5 rounded w-32 mb-3" />
      {[...Array(3)].map((_, i) => <div key={i} className="h-8 bg-white/5 rounded mb-2" />)}
    </div>
  );

  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="text-[10px] font-mono text-white/30 tracking-widest">
          TRADE HISTORY · {trades.length} TRADE{trades.length !== 1 ? 'S' : ''}
        </div>
        <div className={`w-1.5 h-1.5 rounded-full ${connected ? 'bg-lime-400' : 'bg-white/20'}`} title={connected ? 'Live' : 'Connecting…'} />
      </div>
      {trades.length === 0 ? (
        <div className="text-xs font-mono text-white/20 text-center py-4">No trades yet</div>
      ) : (
        <div className="space-y-1 max-h-64 overflow-y-auto">
          {trades.map((t, i) => (
            <div key={t.id ?? i} className="flex items-center justify-between text-xs font-mono py-1.5 border-b border-white/5 last:border-0">
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
