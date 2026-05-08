// HolderList.jsx — Top Holders + Top Traders toggle, USD primary
import React, { useState, useEffect } from 'react';
import { useSuiClient } from '@mysten/dapp-kit';
import { Users, TrendingUp, TrendingDown, BarChart2 } from 'lucide-react';
import { PACKAGE_ID } from './constants.js';
import { paginateMultipleEvents } from './paginateEvents.js';

const MIST_PER_SUI = 1_000_000_000n;
const TOKEN_DECIMALS = 6;
const TOKEN_SCALE = 10 ** TOKEN_DECIMALS;

function fmt(n, d = 2) {
  if (n == null) return '—';
  if (!Number.isFinite(n)) return '—';
  if (n >= 1e9) return (n / 1e9).toFixed(d) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(d) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(d) + 'k';
  return n.toFixed(d);
}

function fmtUsd(suiAmt, suiUsd, d = 2) {
  if (suiAmt == null) return '—';
  const usd = suiAmt * suiUsd;
  if (usd >= 1e6) return '$' + (usd / 1e6).toFixed(d) + 'M';
  if (usd >= 1e3) return '$' + (usd / 1e3).toFixed(d) + 'k';
  if (usd >= 1) return '$' + usd.toFixed(d);
  return '$' + usd.toFixed(4);
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

export default function HolderList({ curveId, tokenType, suiUsd = 0 }) {
  const client = useSuiClient();
  const [tab, setTab] = useState('holders'); // 'holders' | 'traders'
  const [holders, setHolders] = useState([]);
  const [traders, setTraders] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!curveId || !client) return;
    let cancelled = false;

    async function load() {
      setLoading(true);
      try {
        const buyType = `${PACKAGE_ID}::bonding_curve::TokensPurchased`;
        const sellType = `${PACKAGE_ID}::bonding_curve::TokensSold`;

        // Fetch all buy/sell events and filter to this curve
        const eventMap = await paginateMultipleEvents(
          client,
          [buyType, sellType],
          { order: 'descending', maxPages: 20 }
        );

        const buys = (eventMap[buyType] || []).filter(e => e.parsedJson?.curve_id === curveId);
        const sells = (eventMap[sellType] || []).filter(e => e.parsedJson?.curve_id === curveId);

        // ── TOP HOLDERS ──────────────────────────────────────────
        const balanceMap = new Map(); // addr → token balance (raw)
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

        const totalCirc = [...balanceMap.values()].reduce((a, b) => a + (b > 0n ? b : 0n), 0n);

        const holderList = [...balanceMap.entries()]
          .filter(([, bal]) => bal > 0n)
          .map(([addr, bal]) => ({
            addr,
            balance: Number(bal) / TOKEN_SCALE,
            pct: totalCirc > 0n ? (Number(bal) / Number(totalCirc)) * 100 : 0,
          }))
          .sort((a, b) => b.balance - a.balance)
          .slice(0, 20);

        // ── TOP TRADERS ──────────────────────────────────────────
        const traderMap = new Map(); // addr → { suiSpent, suiReceived, buyCount, sellCount, tokensIn, tokensOut }

        for (const e of buys) {
          const j = e.parsedJson;
          const addr = j?.buyer;
          if (!addr) continue;
          const suiIn = Number(BigInt(j?.sui_in ?? 0)) / 1e9;
          const tokensOut = Number(BigInt(j?.tokens_out ?? 0)) / TOKEN_SCALE;
          const t = traderMap.get(addr) ?? { suiSpent: 0, suiReceived: 0, buyCount: 0, sellCount: 0, tokensIn: 0, tokensOut: 0 };
          t.suiSpent += suiIn;
          t.tokensOut += tokensOut;
          t.buyCount += 1;
          traderMap.set(addr, t);
        }
        for (const e of sells) {
          const j = e.parsedJson;
          const addr = j?.seller;
          if (!addr) continue;
          const suiOut = Number(BigInt(j?.sui_out ?? 0)) / 1e9;
          const tokensIn = Number(BigInt(j?.tokens_in ?? 0)) / TOKEN_SCALE;
          const t = traderMap.get(addr) ?? { suiSpent: 0, suiReceived: 0, buyCount: 0, sellCount: 0, tokensIn: 0, tokensOut: 0 };
          t.suiReceived += suiOut;
          t.tokensIn += tokensIn;
          t.sellCount += 1;
          traderMap.set(addr, t);
        }

        const traderList = [...traderMap.entries()]
          .map(([addr, t]) => {
            const volume = t.suiSpent + t.suiReceived;
            const pnl = t.suiReceived - t.suiSpent;
            const avgBuy = t.buyCount > 0 ? t.suiSpent / t.tokensOut : 0;
            const avgSell = t.sellCount > 0 ? t.suiReceived / t.tokensIn : 0;
            return { addr, volume, pnl, buyCount: t.buyCount, sellCount: t.sellCount, avgBuy, avgSell };
          })
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
      {/* Tab toggle */}
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
        <HoldersView holders={holders} suiUsd={suiUsd} />
      ) : (
        <TradersView traders={traders} suiUsd={suiUsd} />
      )}
    </div>
  );
}

function HoldersView({ holders, suiUsd }) {
  if (!holders.length) {
    return <div className="py-10 text-center text-white/35 text-xs font-mono">No holders yet</div>;
  }

  return (
    <div>
      {/* Header */}
      <div className="grid grid-cols-[28px_1fr_auto_auto] gap-3 px-4 py-2 text-[10px] font-mono text-white/35 tracking-widest border-b border-white/5">
        <span>#</span>
        <span>WALLET</span>
        <span className="text-right">BALANCE</span>
        <span className="text-right w-12">%</span>
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
          </div>
          <span className="text-xs font-mono text-white/70 text-right">{fmt(h.balance, 0)}</span>
          <span className="text-xs font-mono text-lime-400/80 text-right w-12">{h.pct.toFixed(1)}%</span>
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
      {/* Header */}
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
        const isPos = t.pnl >= 0;
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
                  ? '$' + Math.abs(pnlUsd).toFixed(pnlUsd < 1 ? 3 : 1)
                  : fmt(Math.abs(t.pnl)) + ' SUI'}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
