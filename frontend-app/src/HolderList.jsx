// HolderList.jsx
import React, { useState, useEffect } from 'react';
import { useSuiClient } from '@mysten/dapp-kit';
import { PACKAGE_ID, TOKEN_DECIMALS } from './constants.js';

const CURVE_SUPPLY_WHOLE = 800_000_000;

function shortAddr(addr) {
  if (!addr) return '';
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

function fmt(n) {
  if (n === undefined || n === null || !Number.isFinite(n)) return '0';
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return n.toFixed(2);
}

export default function HolderList({ curveId, refreshKey }) {
  const client = useSuiClient();
  const [holders, setHolders] = useState([]);
  const [totalCirculating, setTotalCirculating] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError(null);
      try {
        const [buys, sells] = await Promise.all([
          client.queryEvents({
            query: { MoveEventType: `${PACKAGE_ID}::bonding_curve::TokensPurchased` },
            limit: 100, order: 'ascending',
          }),
          client.queryEvents({
            query: { MoveEventType: `${PACKAGE_ID}::bonding_curve::TokensSold` },
            limit: 100, order: 'ascending',
          }),
        ]);

        const buyEvents = buys.data
          .filter(e => e.parsedJson?.curve_id === curveId)
          .map(e => ({
            wallet: e.parsedJson?.buyer,
            delta: Number(e.parsedJson?.tokens_out ?? 0) / 10 ** TOKEN_DECIMALS,
          }));

        const sellEvents = sells.data
          .filter(e => e.parsedJson?.curve_id === curveId)
          .map(e => ({
            wallet: e.parsedJson?.seller,
            delta: -(Number(e.parsedJson?.tokens_in ?? 0) / 10 ** TOKEN_DECIMALS),
          }));

        const balances = {};
        for (const { wallet, delta } of [...buyEvents, ...sellEvents]) {
          if (!wallet) continue;
          balances[wallet] = (balances[wallet] ?? 0) + delta;
        }

        const positive = Object.entries(balances)
          .filter(([, bal]) => bal > 0.001)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 10);

        const total = positive.reduce((s, [, b]) => s + b, 0);

        if (!cancelled) {
          setHolders(positive.map(([addr, bal]) => ({ addr, bal })));
          setTotalCirculating(total);
          setLoading(false);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err.message || String(err));
          setLoading(false);
        }
      }
    }

    load();
    const t = setInterval(load, 30_000);
    return () => { cancelled = true; clearInterval(t); };
  }, [curveId, client, refreshKey]);

  if (loading) {
    return (
      <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4 animate-pulse">
        <div className="h-3 bg-white/5 rounded w-32 mb-3" />
        {[...Array(3)].map((_, i) => <div key={i} className="h-6 bg-white/5 rounded mb-2" />)}
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
        <div className="text-[10px] font-mono text-red-400/60">Failed to load holders</div>
      </div>
    );
  }

  if (holders.length === 0) {
    return (
      <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
        <div className="text-[10px] font-mono text-white/30 tracking-widest mb-1">TOP HOLDERS</div>
        <div className="text-[10px] font-mono text-white/20">NO HOLDERS YET</div>
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="text-[10px] font-mono text-white/30 tracking-widest">TOP HOLDERS</div>
        <div className="text-[10px] font-mono text-white/20">
          {holders.length} wallet{holders.length !== 1 ? 's' : ''} · {fmt(totalCirculating)} circulating
        </div>
      </div>

      <div className="space-y-2">
        {holders.map(({ addr, bal }, i) => {
          const pct = totalCirculating > 0 ? (bal / totalCirculating) * 100 : 0;
          return (
            <div key={addr} className="flex items-center gap-3">
              <div className="text-[10px] font-mono text-white/20 w-4 shrink-0 text-right">{i + 1}</div>
              <div className="text-[11px] font-mono text-white/40 w-24 shrink-0">{shortAddr(addr)}</div>
              <div className="flex-1 h-1.5 bg-white/5 rounded-full min-w-0">
                <div
                  className="h-full bg-lime-600/60 rounded-full"
                  style={{ width: `${Math.min(100, pct)}%` }}
                />
              </div>
              <div className="text-[11px] font-mono text-white/60 w-16 text-right shrink-0">{fmt(bal)}</div>
              <div className="text-[10px] font-mono text-white/30 w-10 text-right shrink-0">{Number.isFinite(pct) ? pct.toFixed(1) : '0.0'}%</div>
            </div>
          );
        })}
      </div>

      <div className="mt-3 pt-2 border-t border-white/5 text-[9px] font-mono text-white/15">
        Based on on-chain trade events · Does not include secondary transfers
      </div>
    </div>
  );
}
