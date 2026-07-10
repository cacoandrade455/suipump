// HolderList.jsx — SSE triggers re-fetch on trade, no time-based polling
import React, { useState, useEffect, useRef } from 'react';
import { useCurrentAccount } from '@mysten/dapp-kit-react';
import { Users, BarChart2, Lock } from 'lucide-react';
import { Link } from 'react-router-dom';
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
  const account  = useCurrentAccount();
  const myAddr   = account?.address ?? null;
  const isMe     = (a) => myAddr != null && a === myAddr;
  const [tab,     setTab]     = useState('holders');
  const [holders, setHolders] = useState([]);
  const [traders, setTraders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [locks,   setLocks]   = useState([]);
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
            // Endpoint returns `balance` as a float in WHOLE tokens (e.g. 276396.9).
            // BigInt() throws on non-integer floats, so round to atomic units first.
            // Atomic units also match the TOTAL_SUPPLY scale used for the % bar below.
            holderList = rows.map(r => ({ addr: r.address, raw: BigInt(Math.round(Number(r.balance ?? 0) * TOKEN_SCALE)) }))
              .filter(b => b.raw > 0n);
          }
        } catch {}
      }

      // Compute P&L from trade events
      const traderMap = {};
      for (const e of buys) {
        const { buyer, sui_in = 0, tokens_out = 0 } = e.parsedJson;
        if (!buyer) continue;
        if (!traderMap[buyer]) traderMap[buyer] = { addr: buyer, spent: 0, received: 0, tokBought: 0, tokSold: 0, buyCount: 0, sellCount: 0 };
        traderMap[buyer].spent     += Number(sui_in) / 1e9;
        traderMap[buyer].tokBought += Number(tokens_out) / TOKEN_SCALE;
        traderMap[buyer].buyCount  += 1;
      }
      for (const e of sells) {
        const { seller, sui_out = 0, tokens_in = 0 } = e.parsedJson;
        if (!seller) continue;
        if (!traderMap[seller]) traderMap[seller] = { addr: seller, spent: 0, received: 0, tokBought: 0, tokSold: 0, buyCount: 0, sellCount: 0 };
        traderMap[seller].received += Number(sui_out) / 1e9;
        traderMap[seller].tokSold  += Number(tokens_in) / TOKEN_SCALE;
        traderMap[seller].sellCount += 1;
      }

      const traderList = Object.values(traderMap)
        .map(t => ({ ...t, pnl: t.received - t.spent }))
        .sort((a, b) => b.pnl - a.pnl);

      setHolders(holderList);
      setTraders(traderList);

      // Fetch vesting locks
      if (INDEXER_URL) {
        try {
          const lockRes = await fetch(`${INDEXER_URL}/token/${curveId}/locks`, { signal: AbortSignal.timeout(5000) });
          if (lockRes.ok) setLocks(await lockRes.json());
        } catch {}
      }
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
          const isLock  = event.type === 'TokensLocked' || event.type === 'VestedClaimed';
          if (isTrade || isLock) load();
        } catch {}
      };
      es.onerror = () => { es.close(); timerRef.current = setTimeout(connect, 3000); };
    }
    connect();
    return () => { esRef.current?.close(); clearTimeout(timerRef.current); };
  }, [curveId, tokenType]);

  const TOTAL_SUPPLY = 1_000_000_000 * TOKEN_SCALE;

  return (
    <div className="bg-white/[0.015] border border-white/[0.08] rounded-xl overflow-hidden">
      <div className="flex border-b border-white/[0.07]">
        <button onClick={() => setTab('holders')} className={`flex-1 py-3 text-[10px] font-mono font-bold tracking-[0.1em] transition-colors flex items-center justify-center gap-1.5 ${tab === 'holders' ? 'text-lime-400 bg-lime-400/[0.06] border-b-2 border-lime-400' : 'text-white/40 hover:text-white/70'}`}>
          <Users size={10} /> HOLDERS
        </button>
        <button onClick={() => setTab('traders')} className={`flex-1 py-3 text-[10px] font-mono font-bold tracking-[0.1em] transition-colors flex items-center justify-center gap-1.5 ${tab === 'traders' ? 'text-lime-400 bg-lime-400/[0.06] border-b-2 border-lime-400' : 'text-white/40 hover:text-white/70'}`}>
          <BarChart2 size={10} /> TRADERS
        </button>
        <button onClick={() => setTab('vesting')} className={`flex-1 py-3 text-[10px] font-mono font-bold tracking-[0.1em] transition-colors flex items-center justify-center gap-1.5 ${tab === 'vesting' ? 'text-lime-400 bg-lime-400/[0.06] border-b-2 border-lime-400' : 'text-white/40 hover:text-white/70'}`}>
          <Lock size={10} /> VESTING
        </button>
      </div>

      {loading && (
        <div className="py-8 text-center text-white/20 text-xs font-mono">Loading…</div>
      )}

      {!loading && tab === 'holders' && (
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
                      <Link to={`/portfolio/${h.addr}`} className="text-[10px] font-mono text-white/60 truncate hover:text-lime-400 transition-colors">{shortAddr(h.addr)}</Link>
                      {isMe(h.addr) && <span className="text-[8px] font-mono text-violet-400 border border-violet-400/40 px-1 rounded">YOU</span>}
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
      )}

      {!loading && tab === 'traders' && (
        traders.length === 0 ? (
          <div className="py-8 text-center text-white/20 text-xs font-mono">No traders yet</div>
        ) : (
          <div className="divide-y divide-white/5">
            {traders.slice(0, 20).map((t, i) => (
              <div key={t.addr} className="px-4 py-2.5 flex items-center gap-3">
                <span className="text-[10px] font-mono text-white/20 w-4">{i + 1}</span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5">
                    <Link to={`/portfolio/${t.addr}`} className="text-[10px] font-mono text-white/60 hover:text-lime-400 transition-colors">{shortAddr(t.addr)}</Link>
                    {isMe(t.addr) && <span className="text-[8px] font-mono text-violet-400 border border-violet-400/40 px-1 rounded">YOU</span>}
                    {creator && t.addr === creator && <span className="text-[8px] font-mono text-lime-400/60 border border-lime-400/20 px-1 rounded">DEV</span>}
                  </div>
                  <div className="text-[9px] font-mono mt-0.5 flex items-center gap-1">
                    <span className="text-white/30">{t.buyCount + t.sellCount}T</span>
                    <span className="text-white/20">·</span>
                    <span className="text-lime-400/70">{t.buyCount}B</span>
                    <span className="text-white/20">·</span>
                    <span className="text-red-400/70">{t.sellCount}S</span>
                    <span className="text-white/20">·</span>
                    <span className="text-white/25">{t.tokBought.toFixed(0)} bought · {t.tokSold.toFixed(0)} sold</span>
                  </div>
                </div>
                <span className={`text-[10px] font-mono font-bold ${t.pnl >= 0 ? 'text-lime-400' : 'text-red-400'}`}>
                  {fmtPnl(t.pnl, suiUsd)}
                </span>
              </div>
            ))}
          </div>
        )
      )}

      {!loading && tab === 'vesting' && (
        locks.length === 0 ? (
          <div className="py-8 text-center text-white/20 text-xs font-mono">No vesting locks</div>
        ) : (
          <div className="divide-y divide-white/5">
            {locks.map((lk, i) => {
              const total    = Number(lk.total_amount) / TOKEN_SCALE;
              const claimed  = Number(lk.claimed) / TOKEN_SCALE;
              const locked   = Number(lk.locked) / TOKEN_SCALE;
              const now      = Date.now();
              const startMs  = Number(lk.start_ms);
              const durMs    = Number(lk.duration_ms);
              const elapsed  = Math.max(0, now - startMs);
              const vestedPct = durMs > 0 ? Math.min(100, (elapsed / durMs) * 100) : 100;
              const msLeft   = Math.max(0, startMs + durMs - now);
              const daysLeft = Math.ceil(msLeft / 86_400_000);
              const modeLabel = lk.mode === 1 ? 'MONTHLY' : 'LINEAR';
              return (
                <div key={lk.lock_id} className="px-4 py-3 space-y-1.5">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-1.5">
                      <Link to={`/portfolio/${lk.beneficiary}`} className="text-[10px] font-mono text-white/60 hover:text-lime-400 transition-colors">{shortAddr(lk.beneficiary)}</Link>
                      <span className="text-[8px] font-mono text-lime-400/50 border border-lime-400/20 px-1 rounded">{modeLabel}</span>
                    </div>
                    <span className="text-[10px] font-mono text-white/40">
                      {daysLeft > 0 ? `${daysLeft}d left` : 'FULLY VESTED'}
                    </span>
                  </div>
                  <div className="flex items-center justify-between text-[9px] font-mono text-white/25">
                    <span>{total.toFixed(0)} total · {claimed.toFixed(0)} claimed · {locked.toFixed(0)} locked</span>
                    <span className="text-lime-400/60">{vestedPct.toFixed(1)}% vested</span>
                  </div>
                  <div className="h-1 bg-white/5 rounded-full overflow-hidden">
                    <div className="h-full bg-lime-400/40 rounded-full" style={{ width: `${vestedPct}%` }} />
                  </div>
                </div>
              );
            })}
          </div>
        )
      )}
    </div>
  );
}
