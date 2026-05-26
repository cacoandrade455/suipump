// LiveFeedSidebar.jsx  -  real-time buys/sells across all tokens
import React, { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Zap, X } from 'lucide-react';
import { ALL_PACKAGE_IDS } from './constants.js';
import { paginateMultipleEvents } from './paginateEvents.js';

const INDEXER_URL = import.meta.env.VITE_INDEXER_URL || '';
const MIST_PER_SUI = 1e9;
const MAX_FEED = 40;

function shortAddr(a) {
  if (!a) return '???';
  return `${a.slice(0, 4)}…${a.slice(-3)}`;
}

function fmt(n) {
  if (n == null) return ' - ';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
  return n.toFixed(2);
}

export default function LiveFeedSidebar({ tokens, onClose }) {
  const navigate = useNavigate();
  const [feed, setFeed] = useState([]);
  const seenRef = useRef(new Set());
  const tokenMap = useRef({});
  const esRef = useRef(null);
  const timerRef = useRef(null);

  useEffect(() => {
    const m = {};
    for (const t of tokens) m[t.curveId] = t;
    tokenMap.current = m;
  }, [tokens]);

  useEffect(() => {
    let cancelled = false;

    function pushItem(newItems, { id, type, curveId, wallet, suiAmt, ts }) {
      if (!id || seenRef.current.has(id)) return;
      if (suiAmt < 0.01) return;
      seenRef.current.add(id);
      const token = tokenMap.current[curveId];
      newItems.push({
        id, type, curveId,
        name:   token?.name   || '???',
        symbol: token?.symbol || '???',
        wallet, suiAmt, ts,
      });
    }

    async function pollIndexer() {
      const res = await fetch(`${INDEXER_URL}/trades/recent?limit=50`, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) throw new Error('indexer not ok');
      const rows = await res.json();
      const newItems = [];
      for (const r of rows) {
        const isBuy = r.event_type?.includes('TokensPurchased');
        const d = r.data || {};
        pushItem(newItems, {
          id:      d.tx_digest ? `${d.tx_digest}_${isBuy ? 'b' : 's'}` : `${r.curve_id}_${r.timestamp_ms}`,
          type:    isBuy ? 'buy' : 'sell',
          curveId: r.curve_id,
          wallet:  isBuy ? d.buyer : d.seller,
          suiAmt:  Number(isBuy ? d.sui_in : d.sui_out ?? 0) / MIST_PER_SUI,
          ts:      r.timestamp_ms ? Number(r.timestamp_ms) : Date.now(),
        });
      }
      return newItems;
    }

    async function pollRpc() {
      const buyTypes  = ALL_PACKAGE_IDS.map(p => `${p}::bonding_curve::TokensPurchased`);
      const sellTypes = ALL_PACKAGE_IDS.map(p => `${p}::bonding_curve::TokensSold`);
      const eventMap = {}; // RPC fallback removed (CORS blocked)
      const newItems = [];
      for (const bt of buyTypes) {
        for (const e of (eventMap[bt] || [])) {
          const j = e.parsedJson || {};
          pushItem(newItems, {
            id: e.id?.txDigest + '_b',
            type: 'buy', curveId: j.curve_id, wallet: j.buyer,
            suiAmt: Number(j.sui_in ?? 0) / MIST_PER_SUI,
            ts: e.timestampMs ? Number(e.timestampMs) : Date.now(),
          });
        }
      }
      for (const st of sellTypes) {
        for (const e of (eventMap[st] || [])) {
          const j = e.parsedJson || {};
          pushItem(newItems, {
            id: e.id?.txDigest + '_s',
            type: 'sell', curveId: j.curve_id, wallet: j.seller,
            suiAmt: Number(j.sui_out ?? 0) / MIST_PER_SUI,
            ts: e.timestampMs ? Number(e.timestampMs) : Date.now(),
          });
        }
      }
      return newItems;
    }

    // SSE primary path
    function connectSSE() {
      if (!INDEXER_URL) return;
      const es = new EventSource(`${INDEXER_URL}/stream`);
      esRef.current = es;
      es.onmessage = (e) => {
        try {
          const event = JSON.parse(e.data);
          if (event.type === 'connected') return;
          const isBuy = event.type === 'TokensPurchased' || event.type === 'TokensBought';
          const isSell = event.type === 'TokensSold';
          if (!isBuy && !isSell) return;
          const d = event.data ?? {};
          const newItems = [];
          pushItem(newItems, {
            id: (d.tx_digest || event.txDigest || `${event.curveId}_${Date.now()}`) + (isBuy ? '_b' : '_s'),
            type: isBuy ? 'buy' : 'sell',
            curveId: event.curveId || d.curve_id,
            wallet: isBuy ? d.buyer : d.seller,
            suiAmt: Number(isBuy ? d.sui_in ?? 0 : d.sui_out ?? 0) / MIST_PER_SUI,
            ts: event.ts ?? Date.now(),
          });
          if (newItems.length > 0) {
            setFeed(prev => [...newItems, ...prev].slice(0, MAX_FEED));
          }
        } catch {}
      };
      es.onerror = () => {
        es.close();
        timerRef.current = setTimeout(connectSSE, 3000);
      };
    }

    // Initial load from indexer
    (async () => {
      try {
        let newItems;
        if (INDEXER_URL) {
          try { newItems = await pollIndexer(); }
          catch { newItems = await pollRpc(); }
        } else {
          newItems = await pollRpc();
        }
        if (!cancelled && newItems.length > 0) {
          setFeed(prev => [...newItems, ...prev].slice(0, MAX_FEED));
        }
      } catch {}
    })();

    connectSSE();

    return () => {
      cancelled = true;
      esRef.current?.close();
      clearTimeout(timerRef.current);
    };
  }, []);

  const timeAgo = (ts) => {
    if (!ts) return '';
    const d = Date.now() - ts;
    if (d < 60000) return `${Math.floor(d / 1000)}s`;
    if (d < 3600000) return `${Math.floor(d / 60000)}m`;
    return `${Math.floor(d / 3600000)}h`;
  };

  return (
    <div className="fixed inset-y-0 right-0 w-72 bg-[#0a0a0a] border-l border-white/10 z-40 flex flex-col shadow-2xl">
      <div className="flex items-center justify-between px-4 py-3 border-b border-white/10">
        <div className="flex items-center gap-2">
          <Zap size={12} className="text-lime-400" />
          <span className="text-[10px] font-mono text-white/50 tracking-widest">LIVE FEED</span>
        </div>
        <button onClick={onClose} className="text-white/30 hover:text-white transition-colors">
          <X size={14} />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto">
        {feed.length === 0 ? (
          <div className="text-center text-white/20 text-xs font-mono py-12">Waiting for trades…</div>
        ) : (
          feed.map(item => (
            <button
              key={item.id}
              onClick={() => navigate(`/token/${item.curveId}`)}
              className="w-full px-4 py-2.5 border-b border-white/5 hover:bg-white/[0.03] transition-colors text-left"
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className={`text-[10px] font-mono font-bold ${item.type === 'buy' ? 'text-lime-400' : 'text-red-400'}`}>
                    {item.type === 'buy' ? '▲' : '▼'} {item.symbol}
                  </span>
                  <span className="text-[10px] font-mono text-white/40">{fmt(item.suiAmt)} SUI</span>
                </div>
                <span className="text-[9px] font-mono text-white/25">{timeAgo(item.ts)}</span>
              </div>
              <div className="text-[9px] font-mono text-white/25 mt-0.5">{shortAddr(item.wallet)}</div>
            </button>
          ))
        )}
      </div>
    </div>
  );
}
