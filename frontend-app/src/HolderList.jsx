// HolderList.jsx — SSE triggers re-fetch on trade, no time-based polling
import React, { useState, useEffect, useRef } from 'react';
import { useSuiClient } from '@mysten/dapp-kit';
import { Users, BarChart2 } from 'lucide-react';
import { ALL_PACKAGE_IDS } from './constants.js';
import { paginateMultipleEvents } from './paginateEvents.js';

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

async function fetchTradeEvents(client, curveId) {
  if (INDEXER_URL) {
    try {
      const res = await fetch(`${INDEXER_URL}/token/${curveId}/trades?limit=500`, { signal: AbortSignal.timeout(5000) });
      if (res.ok) {
        const rows = await res.json();
        const buys  = rows.filter(r => r.event_type?.includes('TokensPurchased')).map(r => ({ parsedJson: { ...r.data, curve_id: curveId } }));
        const sells = rows.filter(r => r.event_type?.includes('TokensSold')).map(r => ({ parsedJson: { ...r.data, curve_id: curveId } }));
        if (buys.length + sells.length > 0) return { buys, sells };
      }
    } catch {}
  }
  const buyTypes  = ALL_PACKAGE_IDS.map(p => `${p}::bonding_curve::TokensPurchased`);
  const sellTypes = ALL_PACKAGE_IDS.map(p => `${p}::bonding_curve::TokensSold`);
  const eventMap  = await paginateMultipleEvents(client, [...buyTypes, ...sellTypes], { order: 'descending', maxPages: 20 });
  return {
    buys:  buyTypes.flatMap(bt   => (eventMap[bt]  || []).filter(e => e.parsedJson?.curve_id === curveId)),
    sells: sellTypes.flatMap(st  => (eventMap[st]  || []).filter(e => e.parsedJson?.curve_id === curveId)),
  };
}

export default function HolderList({ curveId, tokenType, suiUsd = 0, creator = null }) {
  const client   = useSuiClient();
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
      const { buys, sells } = await fetchTradeEvents(client, curveId);

      // Top holders — real on-chain balances
      const candidates = new Set();
      for (const e of buys)  { const a = e.parsedJson?.buyer;  if (a) candidates.add(a); }
      for (const e of sells) { const a = e.parsedJson?.seller; if (a) candidates.add(a); }

      let holderList = [];
      if (tokenType && candidates.size > 0) {
        const balances = await Promise.all([...candidates].map(async (addr) => {
          try {
            const bal = await client.getBalance({ owner: addr, coinType: tokenType });
            return { addr, raw: BigInt(bal.totalBalance ?? '0') };
          } catch { return { addr, raw: 0n }; }
        }));
        holderList = balances
          .filter(b => b.raw > 0n)
          .sort((a, b) => (b.raw > a.raw ? 1 : -1))
          .slice(0, 20)
          .map((b, i) => ({
            rank:    i + 1,
            addr:    b.addr,
            balance: Number(b.raw) / TOKEN_SCALE,
            pct:     Number(b.raw) / (800_000_000 * TOKEN_SCALE) * 100,
            isCreator: b.addr === creator,
          }));
      }

      // Top traders
      const traderMap = new Map();
      for (const e of buys) {
        const j = e.parsedJson;
        const addr = j?.buyer;
        if (!addr) continue;
        const suiIn    = Number(BigInt(j?.sui_in    ?? 0)) / 1e9;
        const tokensOut = Number(BigInt(j?.tokens_out ?? 0)) / TOKEN_SCALE;
        const tr = traderMap.get(addr) ?? { suiSpent: 0, suiReceived: 0, buyCount: 0, sellCount: 0, tokensIn: 0, tokensOut: 0 };
        tr.suiSpent  += suiIn;
        tr.tokensOut += tokensOut;
        tr.buyCount  += 1;
        traderMap.set(addr, tr);
      }
      for (const e of sells) {
        const j = e.parsedJson;
        const addr = j?.seller;
        if (!addr) continue;
        const suiOut   = Number(BigInt(j?.sui_out   ?? 0)) / 1e9;
        const tokensIn = Number(BigInt(j?.tokens_in ?? 0)) / TOKEN_SCALE;
        const tr = traderMap.get(addr) ?? { suiSpent: 0, suiReceived: 0, buyCount: 0, sellCount: 0, tokensIn: 0, tokensOut: 0 };
        tr.suiReceived += suiOut;
        tr.tokensIn    += tokensIn;
        tr.sellCount   += 1;
        traderMap.set(addr, tr);
      }

      const traderList = [...traderMap.entries()]
        .map(([addr, tr]) => ({
          addr,
          volume:    tr.suiSpent + tr.suiReceived,
          pnl:       tr.suiReceived - tr.suiSpent,
          buyCount:  tr.buyCount,
          sellCount: tr.sellCount,
        }))
        .sort((a, b) => b.volume - a.volume)
        .slice(0, 20);

      setHolders(holderList);
      setTraders(traderList);
    } catch (err) {
      console.error('HolderList error:', err);
    } finally {
      setLoading(false);
      loadingRef.current = false;
    }
  }

  // Initial load
  useEffect(() => {
    if (!curveId || !client) return;
    load();
  }, [curveId, client, tokenType]);

  // SSE — re-fetch holders/traders when a trade happens on this curve
  useEffect(() => {
    if (!curveId || !INDEXER_URL) return;

    function connect() {
      const es = new EventSource(`${INDEXER_URL}/stream?curveId=${curveId}`);
      esRef.current = es;

      es.onmessage = (e) => {
        try {
          const event = JSON.parse(e.data);
          if (event.type === 'connected') return;
          const isTrade = event.type === 'TokensPurchased' ||
                          event.type === 'TokensBought'    ||
                          event.type === 'TokensSold';
          if (isTrade) load();
        } catch {}
      };

      es.onerror = () => {
        es.close();
        timerRef.current = setTimeout(connect, 3_000);
      };
    }

    connect();
    return () => { esRef.current?.close(); clearTimeout(timerRef.current); };
  }, [curveId]);

  return (
    <div className="bg-white/[0.03] border border-white/10 rounded-xl overflow-hidden">
      <div className="flex border-b border-white/10">
        <button onClick={() => setTab('holders')}
          className={`flex-1 flex items-center justify-center gap-2 py-3 text-xs font-mono font-bold tracking-wider transition-colors ${
            tab === 'holders' ? 'text-lime-400 border-b-2 border-lime-400 bg-lime-400/5' : 'text-white/40 hover:text-white/70'
          }`}>
          <Users size={13} /> TOP HOLDERS
        </button>
        <button onClick={() => setTab('traders')}
          className={`flex-1 flex items-center justify-center gap-2 py-3 text-xs font-mono font-bold tracking-wider transition-colors ${
            tab === 'traders' ? 'text-lime-400 border-b-2 border-lime-400 bg-lime-400/5' : 'text-white/40 hover:text-white/70'
          }`}>
          <BarChart2 size={13} /> TOP TRADERS
        </button>
      </div>

      {loading ? (
        <div className="py-10 text-center text-white/35 text-xs font-mono">Loading…</div>
      ) : tab === 'holders' ? (
        <div>
          <div className="grid grid-cols-[auto_1fr_auto_auto] gap-x-3 px-4 py-2 text-[9px] font-mono text-white/25 border-b border-white/5">
            <span>#</span><span>WALLET</span><span className="text-right">BALANCE</span><span className="text-right">% SUPPLY</span>
          </div>
          {holders.length === 0 ? (
            <div className="py-6 text-center text-white/20 text-xs font-mono">No holders yet</div>
          ) : holders.map(h => (
            <div key={h.addr} className="grid grid-cols-[auto_1fr_auto_auto] gap-x-3 items-center px-4 py-2.5 border-b border-white/5 last:border-0 text-xs font-mono">
              <span className="text-white/30">{h.rank}</span>
              <div className="flex items-center gap-2 min-w-0">
                <div className="w-5 h-5 rounded-full flex-shrink-0"
                  style={{ background: `hsl(${parseInt(h.addr.slice(2,6),16) % 360},60%,50%)` }} />
                <span className="text-white/60 truncate">{shortAddr(h.addr)}</span>
                {h.isCreator && <span className="text-[8px] font-bold text-lime-400 bg-lime-400/10 border border-lime-400/30 rounded px-1">DEV</span>}
              </div>
              <span className="text-white/50 text-right">
                {h.balance >= 1e6 ? `${(h.balance/1e6).toFixed(1)}M` : h.balance >= 1e3 ? `${(h.balance/1e3).toFixed(0)}k` : h.balance.toFixed(0)}
              </span>
              <span className={`text-right font-bold ${h.pct >= 5 ? 'text-lime-400' : 'text-white/40'}`}>
                {h.pct.toFixed(2)}%
              </span>
            </div>
          ))}
        </div>
      ) : (
        <div>
          <div className="grid grid-cols-[1fr_auto_auto_auto] gap-x-3 px-4 py-2 text-[9px] font-mono text-white/25 border-b border-white/5">
            <span>WALLET</span><span>VOLUME</span><span>B/S</span><span>PnL</span>
          </div>
          {traders.length === 0 ? (
            <div className="py-6 text-center text-white/20 text-xs font-mono">No traders yet</div>
          ) : traders.map((tr, i) => (
            <div key={tr.addr} className="grid grid-cols-[1fr_auto_auto_auto] gap-x-3 items-center px-4 py-2.5 border-b border-white/5 last:border-0 text-xs font-mono">
              <div className="flex items-center gap-2 min-w-0">
                <div className="w-5 h-5 rounded-full flex-shrink-0"
                  style={{ background: `hsl(${parseInt(tr.addr.slice(2,6),16) % 360},60%,50%)` }} />
                <span className="text-white/60 truncate">{shortAddr(tr.addr)}</span>
              </div>
              <span className="text-white/50">
                {suiUsd > 0 ? `$${(tr.volume * suiUsd).toFixed(0)}` : `${tr.volume.toFixed(1)}`}
              </span>
              <span className="text-white/30">{tr.buyCount}/{tr.sellCount}</span>
              <span className={tr.pnl >= 0 ? 'text-lime-400 font-bold' : 'text-red-400 font-bold'}>
                {fmtPnl(tr.pnl, suiUsd)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
