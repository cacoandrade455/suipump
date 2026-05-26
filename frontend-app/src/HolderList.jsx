// HolderList.jsx — SSE triggers re-fetch on trade, no time-based polling
import React, { useState, useEffect, useRef } from 'react';
import { Users, BarChart2 } from 'lucide-react';
import { ALL_PACKAGE_IDS } from './constants.js';

const INDEXER_URL  = import.meta.env.VITE_INDEXER_URL || '';
const TOKEN_SCALE  = 1e6;

function shortAddr(a) {
  if (!a) return '???';
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

function fmtPnl(pnl, suiUsd) {
  const usd = pnl * suiUsd;
  const sign = pnl >= 0 ? '+' : '';
  if (suiUsd > 0) return `${sign}$${Math.abs(usd).toFixed(1)}`;
  return `${sign}${pnl.toFixed(2)} SUI`;
}

async function fetchTradeEvents(curveId) {
  if (INDEXER_URL) {
    try {
      const res = await fetch(`${INDEXER_URL}/token/${curveId}/trades?limit=500`, { signal: AbortSignal.timeout(5000) });
      if (res.ok) {
        const rows = await res.json();
        const buys  = rows.filter(r => r.event_type?.includes('TokensPurchased')).map(r => ({ parsedJson: { ...r.data, curve_id: curveId } }));
        const sells = rows.filter(r => r.event_type?.includes('TokensSold')).map(r => ({ parsedJson: { ...r.data, curve_id: curveId } }));
        return { buys, sells };
      }
    } catch {}
  }
  return { buys: [], sells: [] }; // RPC fallback removed (CORS blocked)
}

export default function HolderList({ curveId, tokenType, suiUsd = 0, creator = null }) {
  const [tab,     setTab]     = useState('holders');
  const [holders, setHolders] = useState([]);
  const [traders, setTraders] = useState([]);
  const [loading, setLoading] = useState(true);
  const esRef    = useRef(null);
  const timerRef = useRef(null);
  const loadingRef = useRef(false);

  async function load() {
    if (loadingRef.current) return;
    loadingRef.current = true;
    try {
      const { buys, sells } = await fetchTradeEvents(curveId);

      const candidates = new Set();
      for (const e of buys)  { const a = e.parsedJson?.buyer;  if (a) candidates.add(a); }
      for (const e of sells) { const a = e.parsedJson?.seller; if (a) candidates.add(a); }

      let holderList = [];
      // Load holder balances from indexer — avoids CORS on graphql endpoint
      if (INDEXER_URL) {
        try {
          const res = await fetch(`${INDEXER_URL}/token/${curveId}/holders`, { signal: AbortSignal.timeout(5000) });
          if (res.ok) {
            const rows = await res.json();
            holderList = rows.map(r => ({ addr: r.address, raw: BigInt(r.balance ?? 0) }))
              .filter(b => b.raw > 0n);
          }
        } catch {}
      }

      // Compute P&L from trade events
      const traderMap = {};
      for (const e of buys) {
        const { buyer, sui_in = 0, tokens_out = 0 } = e.parsedJson;
        if (!buyer) continue;
        if (!traderMap[buyer]) traderMap[buyer] = { addr: buyer, spent: 0, received: 0, tokBought: 0, tokSold: 0 };
        traderMap[buyer].spent     += Number(sui_in) / 1e9;
        traderMap[buyer].tokBought += Number(tokens_out) / TOKEN_SCALE;
      }
      for (const e of sells) {
        const { seller, sui_out = 0, tokens_in = 0 } = e.parsedJson;
        if (!seller) continue;
        if (!traderMap[seller]) traderMap[seller] = { addr: seller, spent: 0, received: 0, tokBought: 0, tokSold: 0 };
        traderMap[seller].received += Number(sui_out) / 1e9;
        traderMap[seller].tokSold  += Number(tokens_in) / TOKEN_SCALE;
      }

      const traderList = Object.values(traderMap)
        .map(t => ({ ...t, pnl: t.received - t.spent }))
        .sort((a, b) => b.pnl - a.pnl);

      setHolders(holderList);
      setTraders(traderList);
    } catch {} finally {
      loadingRef.current = false;
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // SSE for real-time refresh
    if (!INDEXER_URL) return;
    function connect() {
      const es = new EventSource(`${INDEXER_URL}/stream?curveId=${curveId}`);
      esRef.current = es;
      es.onmessage = (e) => {
        try {
          const event = JSON.parse(e.data);
          if (event.type === 'connected') return;
          const isTrade = event.type === 'TokensPurchased' || event.type === 'TokensBought' || event.type === 'TokensSold';
          if (isTrade) load();
        } catch {}
      };
      es.onerror = () => { es.close(); timerRef.current = setTimeout(connect, 3000); };
    }
    connect();
    return () => { esRef.current?.close(); clearTimeout(timerRef.current); };
  }, [curveId, tokenType]);

  const TOTAL_SUPPLY = 1_000_000_000 * TOKEN_SCALE;

  return (
    <div className="bg-white/[0.03] border border-white/10 rounded-xl overflow-hidden">
      <div className="flex border-b border-white/10">
        <button onClick={() => setTab('holders')} className={`flex-1 py-2.5 text-[10px] font-mono tracking-wider transition-colors flex items-center justify-center gap-1.5 ${tab === 'holders' ? 'text-lime-400 bg-lime-400/5' : 'text-white/30 hover:text-white/60'}`}>
          <Users size={10} /> HOLDERS
        </button>
        <button onClick={() => setTab('traders')} className={`flex-1 py-2.5 text-[10px] font-mono tracking-wider transition-colors flex items-center justify-center gap-1.5 ${tab === 'traders' ? 'text-lime-400 bg-lime-400/5' : 'text-white/30 hover:text-white/60'}`}>
          <BarChart2 size={10} /> TRADERS
        </button>
      </div>

      {loading ? (
        <div className="py-8 text-center text-white/20 text-xs font-mono">Loading…</div>
      ) : tab === 'holders' ? (
        holders.length === 0 ? (
          <div className="py-8 text-center text-white/20 text-xs font-mono">No holders yet</div>
        ) : (
          <div className="divide-y divide-white/5">
            {holders.slice(0, 20).map((h, i) => {
              const pct = (Number(h.raw) / TOTAL_SUPPLY) * 100;
              const isCreator = creator && h.addr === creator;
              return (
                <div key={h.addr} className="px-4 py-2.5 flex items-center gap-3">
                  <span className="text-[10px] font-mono text-white/20 w-4">{i + 1}</span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="text-[10px] font-mono text-white/60 truncate">{shortAddr(h.addr)}</span>
                      {isCreator && <span className="text-[8px] font-mono text-lime-400/60 border border-lime-400/20 px-1 rounded">DEV</span>}
                    </div>
                    <div className="h-1 bg-white/5 rounded-full mt-1 overflow-hidden">
                      <div className="h-full bg-lime-400/50 rounded-full" style={{ width: `${Math.min(100, pct * 2)}%` }} />
                    </div>
                  </div>
                  <span className="text-[10px] font-mono text-white/40">{pct.toFixed(2)}%</span>
                </div>
              );
            })}
          </div>
        )
      ) : (
        traders.length === 0 ? (
          <div className="py-8 text-center text-white/20 text-xs font-mono">No traders yet</div>
        ) : (
          <div className="divide-y divide-white/5">
            {traders.slice(0, 20).map((t, i) => (
              <div key={t.addr} className="px-4 py-2.5 flex items-center gap-3">
                <span className="text-[10px] font-mono text-white/20 w-4">{i + 1}</span>
                <div className="flex-1 min-w-0">
                  <span className="text-[10px] font-mono text-white/60">{shortAddr(t.addr)}</span>
                  <div className="text-[9px] font-mono text-white/25 mt-0.5">{t.tokBought.toFixed(0)} bought · {t.tokSold.toFixed(0)} sold</div>
                </div>
                <span className={`text-[10px] font-mono font-bold ${t.pnl >= 0 ? 'text-lime-400' : 'text-red-400'}`}>
                  {fmtPnl(t.pnl, suiUsd)}
                </span>
              </div>
            ))}
          </div>
        )
      )}
    </div>
  );
}
