// v16-holderfix
// HolderList.jsx — Top Holders + Top Traders toggle, USD primary
import React, { useState, useEffect } from 'react';
import { useSuiClient } from '@mysten/dapp-kit';
import { Users, BarChart2 } from 'lucide-react';
import { PACKAGE_ID } from './constants.js';
import { paginateMultipleEvents } from './paginateEvents.js';

const INDEXER_URL = import.meta.env.VITE_INDEXER_URL || '';

const TOKEN_DECIMALS = 6;
const TOKEN_SCALE = 10 ** TOKEN_DECIMALS;
const TOTAL_SUPPLY = 1_000_000_000; // 1B whole tokens — denominator for %

function fmt(n, d = 2) {
  if (n == null) return '—';
  if (!Number.isFinite(n)) return '—';
  if (n >= 1e9) return (n / 1e9).toFixed(d) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(d) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(d) + 'k';
  return n.toFixed(d);
}

function shortAddr(addr) {
  if (!addr) return '—';
  return addr.slice(0, 6) + '…' + addr.slice(-4);
}

function walletColor(addr) {
  if (!addr) return '#84cc16';
  const hue = parseInt(addr.slice(2, 6), 16) % 360;
  return `hsl(${hue}, 70%, 55%)`;
}

export default function HolderList({ curveId, tokenType, suiUsd = 0, creator = null }) {
  const client = useSuiClient();
  const [tab, setTab] = useState('holders');
  const [holders, setHolders] = useState([]);
  const [traders, setTraders] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!curveId || !client) return;
    let cancelled = false;

    async function load() {
      setLoading(true);
      try {
        const buyType  = `${PACKAGE_ID}::bonding_curve::TokensPurchased`;
        const sellType = `${PACKAGE_ID}::bonding_curve::TokensSold`;

        let buys = [], sells = [];

        // Try indexer for trade data
        if (INDEXER_URL) {
          try {
            const res = await fetch(`${INDEXER_URL}/token/${curveId}/trades?limit=500`, { signal: AbortSignal.timeout(5000) });
            if (res.ok) {
              const rows = await res.json();
              buys  = rows.filter(r => r.event_type.includes('TokensPurchased')).map(r => ({ parsedJson: { ...r.data, buyer: r.data.buyer, curve_id: curveId } }));
              sells = rows.filter(r => r.event_type.includes('TokensSold')).map(r => ({ parsedJson: { ...r.data, seller: r.data.seller, curve_id: curveId } }));
            }
          } catch {}
        }

        // Fall back to RPC if indexer failed
        if (buys.length === 0 && sells.length === 0) {
          const eventMap = await paginateMultipleEvents(client, [buyType, sellType], { order: 'descending', maxPages: 20 });
          buys  = (eventMap[buyType]  || []).filter(e => e.parsedJson?.curve_id === curveId);
          sells = (eventMap[sellType] || []).filter(e => e.parsedJson?.curve_id === curveId);
        }

        // ── TOP HOLDERS ──────────────────────────────────────────────
        const balanceMap = new Map(); // addr → raw token balance (atomic)
        for (const e of buys) {
          const j = e.parsedJson;
          const addr = j?.buyer;
          const tokens = BigInt(j?.tokens_out ?? 0);
          if (addr) balanceMap.set(addr, (balanceMap.get(addr) ?? 0n) + tokens);
        }
        for (const e of sells) {
          const j = e.parsedJson;
          const addr = j?.seller;
          const tokens = BigInt(j?.tokens_in ?? 0);
          if (addr) balanceMap.set(addr, (balanceMap.get(addr) ?? 0n) - tokens);
        }

        const holderList = [...balanceMap.entries()]
          .filter(([, bal]) => bal > 0n)
          .map(([addr, bal]) => ({
            addr,
            balance: Number(bal) / TOKEN_SCALE,
            // % of TOTAL SUPPLY (1B whole tokens), not just circulating
            pct: (Number(bal) / TOKEN_SCALE / TOTAL_SUPPLY) * 100,
          }))
          .sort((a, b) => b.balance - a.balance)
          .slice(0, 20);

        // ── TOP TRADERS ──────────────────────────────────────────────
        const traderMap = new Map();
        for (const e of buys) {
          const j = e.parsedJson;
          const addr = j?.buyer;
          if (!addr) continue;
          const suiIn     = Number(BigInt(j?.sui_in     ?? 0)) / 1e9;
          const tokensOut = Number(BigInt(j?.tokens_out ?? 0)) / TOKEN_SCALE;
          const t = traderMap.get(addr) ?? { suiSpent: 0, suiReceived: 0, buyCount: 0, sellCount: 0, tokensIn: 0, tokensOut: 0 };
          t.suiSpent  += suiIn;
          t.tokensOut += tokensOut;
          t.buyCount  += 1;
          traderMap.set(addr, t);
        }
        for (const e of sells) {
          const j = e.parsedJson;
          const addr = j?.seller;
          if (!addr) continue;
          const suiOut   = Number(BigInt(j?.sui_out   ?? 0)) / 1e9;
          const tokensIn = Number(BigInt(j?.tokens_in ?? 0)) / TOKEN_SCALE;
          const t = traderMap.get(addr) ?? { suiSpent: 0, suiReceived: 0, buyCount: 0, sellCount: 0, tokensIn: 0, tokensOut: 0 };
          t.suiReceived += suiOut;
          t.tokensIn    += tokensIn;
          t.sellCount   += 1;
          traderMap.set(addr, t);
        }

        const traderList = [...traderMap.entries()]
          .map(([addr, t]) => ({
            addr,
            volume:    t.suiSpent + t.suiReceived,
            pnl:       t.suiReceived - t.suiSpent,
            buyCount:  t.buyCount,
            sellCount: t.sellCount,
          }))
          .sort((a, b) => b.volume - a.volume)
          .slice(0, 20);

        if (!cancelled) {
          setHolders(holderList);
          setTraders(traderList);
        }
      } catch (err) {
        console.error('HolderList error:', err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    const interval = setInterval(load, 30_000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [curveId, client]);

  return (
    <div className="bg-white/[0.03] border border-white/10 rounded-xl overflow-hidden">
      <div className="flex border-b border-white/10">
        <button
          onClick={() => setTab('holders')}
          className={`flex-1 flex items-center justify-center gap-2 py-3 text-xs font-mono font-bold tracking-wider transition-colors ${
            tab === 'holders'
              ? 'text-lime-400 border-b-2 border-lime-400 bg-lime-400/5'
              : 'text-white/40 hover:text-white/70'
          }`}
        >
          <Users size={13} />
          TOP HOLDERS
        </button>
        <button
          onClick={() => setTab('traders')}
          className={`flex-1 flex items-center justify-center gap-2 py-3 text-xs font-mono font-bold tracking-wider transition-colors ${
            tab === 'traders'
              ? 'text-lime-400 border-b-2 border-lime-400 bg-lime-400/5'
              : 'text-white/40 hover:text-white/70'
          }`}
        >
          <BarChart2 size={13} />
          TOP TRADERS
        </button>
      </div>

      {loading ? (
        <div className="py-10 text-center text-white/35 text-xs font-mono">Loading…</div>
      ) : tab === 'holders' ? (
        <HoldersView holders={holders} creator={creator} />
      ) : (
        <TradersView traders={traders} suiUsd={suiUsd} />
      )}
    </div>
  );
}

function HoldersView({ holders, creator }) {
  if (!holders.length) {
    return <div className="py-10 text-center text-white/35 text-xs font-mono">No holders yet</div>;
  }

  return (
    <div>
      <div className="grid grid-cols-[28px_1fr_auto_auto] gap-3 px-4 py-2 text-[10px] font-mono text-white/35 tracking-widest border-b border-white/5">
        <span>#</span>
        <span>WALLET</span>
        <span className="text-right">BALANCE</span>
        <span className="text-right w-16">% SUPPLY</span>
      </div>

      {holders.map((h, i) => (
        <div
          key={h.addr}
          className="grid grid-cols-[28px_1fr_auto_auto] gap-3 px-4 py-2.5 border-b border-white/5 last:border-0 hover:bg-white/[0.02] transition-colors items-center"
        >
          <span className="text-xs font-mono text-white/35">{i + 1}</span>
          <div className="flex items-center gap-2 min-w-0">
            <div
              className="w-5 h-5 rounded-full flex-shrink-0"
              style={{ backgroundColor: walletColor(h.addr) }}
            />
            <span className="text-xs font-mono text-white/70 truncate">{shortAddr(h.addr)}</span>
            {creator && h.addr === creator && (
              <span className="text-[9px] font-mono font-bold text-lime-400 bg-lime-400/10 border border-lime-400/30 rounded px-1.5 py-0.5 flex-shrink-0">
                DEV
              </span>
            )}
          </div>
          <span className="text-xs font-mono text-white/70 text-right">{fmt(h.balance, 0)}</span>
          <span className="text-xs font-mono text-lime-400/80 text-right w-16">{h.pct.toFixed(2)}%</span>
        </div>
      ))}
    </div>
  );
}

function TradersView({ traders, suiUsd }) {
  if (!traders.length) {
    return <div className="py-10 text-center text-white/35 text-xs font-mono">No trades yet</div>;
  }

  return (
    <div>
      <div className="grid grid-cols-[28px_1fr_auto_auto_auto] gap-2 px-4 py-2 text-[10px] font-mono text-white/35 tracking-widest border-b border-white/5">
        <span>#</span>
        <span>WALLET</span>
        <span className="text-right">VOLUME</span>
        <span className="text-right">B/S</span>
        <span className="text-right w-16">PnL</span>
      </div>

      {traders.map((t, i) => {
        const pnlUsd = t.pnl * suiUsd;
        const volUsd = t.volume * suiUsd;
        const isPos  = t.pnl >= 0;
        return (
          <div
            key={t.addr}
            className="grid grid-cols-[28px_1fr_auto_auto_auto] gap-2 px-4 py-2.5 border-b border-white/5 last:border-0 hover:bg-white/[0.02] transition-colors items-center"
          >
            <span className="text-xs font-mono text-white/35">{i + 1}</span>
            <div className="flex items-center gap-2 min-w-0">
              <div
                className="w-5 h-5 rounded-full flex-shrink-0"
                style={{ backgroundColor: walletColor(t.addr) }}
              />
              <span className="text-xs font-mono text-white/70 truncate">{shortAddr(t.addr)}</span>
            </div>
            <div className="text-right">
              <div className="text-xs font-mono text-white/80">
                {suiUsd > 0
                  ? '$' + (volUsd >= 1000 ? (volUsd / 1000).toFixed(1) + 'k' : volUsd.toFixed(0))
                  : fmt(t.volume) + ' SUI'}
              </div>
            </div>
            <div className="text-right">
              <span className="text-[10px] font-mono text-lime-400/70">{t.buyCount}</span>
              <span className="text-[10px] font-mono text-white/30">/</span>
              <span className="text-[10px] font-mono text-red-400/70">{t.sellCount}</span>
            </div>
            <div className="text-right w-16">
              <div className={`text-xs font-mono font-bold ${isPos ? 'text-lime-400' : 'text-red-400'}`}>
                {isPos ? '+' : ''}
                {suiUsd > 0
                  ? '$' + Math.abs(pnlUsd).toFixed(Math.abs(pnlUsd) < 1 ? 3 : 1)
                  : fmt(Math.abs(t.pnl)) + ' SUI'}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
