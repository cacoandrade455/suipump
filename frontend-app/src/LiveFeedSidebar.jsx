// LiveFeedSidebar.jsx  -  real-time buys/sells across all tokens
import React, { useState, useEffect, useRef } from 'react';
import { useSuiClient } from '@mysten/dapp-kit';
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
  const client = useSuiClient();
  const navigate = useNavigate();
  const [feed, setFeed] = useState([]);
  const seenRef = useRef(new Set());
  const tokenMap = useRef({});

  // Build curveId → token lookup
  useEffect(() => {
    const m = {};
    for (const t of tokens) m[t.curveId] = t;
    tokenMap.current = m;
  }, [tokens]);

  useEffect(() => {
    let cancelled = false;

    // Push a normalized trade item into the feed if not already seen.
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
      const res = await fetch(`${INDEXER_URL}/trades/recent?limit=50`, {
        signal: AbortSignal.timeout(5000),
      });
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
      // RPC fallback — query all package versions (v4/v5/v6)
      const buyTypes  = ALL_PACKAGE_IDS.map(p => `${p}::bonding_curve::TokensPurchased`);
      const sellTypes = ALL_PACKAGE_IDS.map(p => `${p}::bonding_curve::TokensSold`);
      const eventMap = await paginateMultipleEvents(
        client, [...buyTypes, ...sellTypes], { order: 'descending', maxPages: 3 }
      );
      const newItems = [];
      for (const bt of buyTypes) {
        for (const evt of (eventMap[bt] || [])) {
          const j = evt.parsedJson || {};
          pushItem(newItems, {
            id:      `${evt.id?.txDigest}_${evt.id?.eventSeq}`,
            type:    'buy',
            curveId: j.curve_id,
            wallet:  j.buyer,
            suiAmt:  Number(j.sui_in ?? 0) / MIST_PER_SUI,
            ts:      evt.timestampMs ? Number(evt.timestampMs) : Date.now(),
          });
        }
      }
      for (const st of sellTypes) {
        for (const evt of (eventMap[st] || [])) {
          const j = evt.parsedJson || {};
          pushItem(newItems, {
            id:      `${evt.id?.txDigest}_${evt.id?.eventSeq}`,
            type:    'sell',
            curveId: j.curve_id,
            wallet:  j.seller,
            suiAmt:  Number(j.sui_out ?? 0) / MIST_PER_SUI,
            ts:      evt.timestampMs ? Number(evt.timestampMs) : Date.now(),
          });
        }
      }
      return newItems;
    }

    async function poll() {
      try {
        let newItems = [];
        // Indexer first — fast and pre-aggregated across all packages.
        if (INDEXER_URL) {
          try {
            newItems = await pollIndexer();
          } catch {
            newItems = await pollRpc();
          }
        } else {
          newItems = await pollRpc();
        }

        if (cancelled) return;

        if (newItems.length > 0) {
          newItems.sort((a, b) => b.ts - a.ts);
          setFeed(prev => [...newItems, ...prev].slice(0, MAX_FEED));
        }
      } catch {}
    }

    poll();
    const interval = setInterval(poll, 8_000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [client]);

  function timeAgo(ts) {
    const diff = Date.now() - ts;
    if (diff < 60_000) return `${Math.floor(diff / 1000)}s`;
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
    return `${Math.floor(diff / 3_600_000)}h`;
  }

  return (
    <div className="fixed right-0 top-0 h-full w-72 bg-[#0a0a0a] border-l border-white/10 z-50 flex flex-col shadow-2xl">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-white/10">
        <div className="flex items-center gap-2">
          <Zap size={12} className="text-lime-400" />
          <span className="text-[10px] font-mono font-bold text-white tracking-widest">LIVE FEED</span>
          <span className="w-1.5 h-1.5 rounded-full bg-lime-400 animate-pulse" />
        </div>
        <button onClick={onClose} className="text-white/30 hover:text-white transition-colors">
          <X size={14} />
        </button>
      </div>

      {/* Feed */}
      <div className="flex-1 overflow-y-auto divide-y divide-white/[0.04]">
        {feed.length === 0 ? (
          <div className="text-center text-white/20 text-[10px] font-mono py-12">
            Waiting for trades…
          </div>
        ) : feed.map(item => (
          <button
            key={item.id}
            onClick={() => navigate(`/token/${item.curveId}`)}
            className="w-full px-4 py-2.5 text-left hover:bg-white/[0.03] transition-colors group"
          >
            <div className="flex items-center justify-between mb-0.5">
              <div className="flex items-center gap-1.5">
                <span className={`text-[9px] font-mono font-bold px-1.5 py-0.5 rounded ${
                  item.type === 'buy'
                    ? 'bg-lime-400/15 text-lime-400'
                    : 'bg-red-400/15 text-red-400'
                }`}>
                  {item.type === 'buy' ? 'BUY' : 'SELL'}
                </span>
                <span className="text-[10px] font-mono text-white group-hover:text-lime-400 transition-colors">
                  ${item.symbol}
                </span>
              </div>
              <span className="text-[9px] font-mono text-white/25">{timeAgo(item.ts)}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-[9px] font-mono text-white/30">{shortAddr(item.wallet)}</span>
              <span className={`text-[10px] font-mono font-bold ${
                item.type === 'buy' ? 'text-lime-400' : 'text-red-400'
              }`}>
                {fmt(item.suiAmt)} SUI
              </span>
            </div>
          </button>
        ))}
      </div>

      <div className="px-4 py-2 border-t border-white/5 text-[9px] font-mono text-white/15 text-center">
        REFRESHES EVERY 8s - TESTNET
      </div>
    </div>
  );
}
