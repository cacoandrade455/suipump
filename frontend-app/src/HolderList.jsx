// HolderList.jsx
// Reconstructs token holder distribution by scanning TokensPurchased and
// TokensSold events for a specific curve. Shows top 10 holders with
// address, token amount, and % of circulating supply.
//
// Limitations (RPC-based, no indexer):
//   - Only tracks wallets that traded directly on the curve (not secondary transfers)
//   - Max 100 events per query — sufficient for testnet, needs pagination at scale
//   - Refreshes every 30s or when refreshKey changes

import React, { useState, useEffect } from 'react';
import { useSuiClient } from '@mysten/dapp-kit';
import { PACKAGE_ID, TOKEN_DECIMALS } from './constants.js';

const CURVE_SUPPLY_WHOLE = 800_000_000; // tokens sold via curve

function shortAddr(addr) {
  if (!addr) return '';
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

function fmt(n) {
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
        // Fetch buy and sell events for this curve
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

        // Filter to this curve only
        const buyEvents = buys.data
          .filter(e => e.parsedJson?.curve_id === curveId)
          .map(e => ({
            wallet: e.parsedJson.buyer,
            delta: Number(e.parsedJson.tokens_out) / 10 ** TOKEN_DECIMALS,
          }));

        const sellEvents = sells.data
          .filter(e => e.parsedJson?.curve_id === curveId)
          .map(e => ({
            wallet: e.parsedJson.seller,
            delta: -(Number(e.parsedJson.tokens_in) / 10 ** TOKEN_DECIMALS),
          }));

        // Aggregate net balance per wallet
        const balances = {};
        for (const { wallet, delta } of [...buyEvents, ...sellEvents]) {
          if (!wallet) continue;
          balances[wallet] = (balances[wallet] ?? 0) + delta;
        }

        // Filter out zero/negative balances (sold everything)
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
      <div className="border border-lime-900/30 bg-black p-4">
        <div className="text-[10px] font-mono text-lime-900 tracking-widest">LOADING HOLDERS…</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="border border-lime-900/30 bg-black p-4">
        <div className="text-[10px] font-mono text-red-800">Failed to load holders</div>
      </div>
    );
  }

  if (holders.length === 0) {
    return (
      <div className="border border-lime-900/30 bg-black p-4">
        <div className="text-[10px] font-mono text-lime-900 tracking-widest mb-1">TOP HOLDERS</div>
        <div className="text-[10px] font-mono text-lime-900">NO HOLDERS YET</div>
      </div>
    );
  }

  return (
    <div className="border border-lime-900/30 bg-black p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="text-[10px] font-mono text-lime-700 tracking-widest">TOP HOLDERS</div>
        <div className="text-[10px] font-mono text-lime-900">
          {holders.length} wallet{holders.length !== 1 ? 's' : ''} · {fmt(totalCirculating)} circulating
        </div>
      </div>

      <div className="space-y-1">
        {holders.map(({ addr, bal }, i) => {
          const pct = totalCirculating > 0 ? (bal / totalCirculating) * 100 : 0;
          const pctOfSupply = (bal / CURVE_SUPPLY_WHOLE) * 100;
          return (
            <div key={addr} className="flex items-center gap-3">
              {/* Rank */}
              <div className="text-[10px] font-mono text-lime-900 w-4 shrink-0">
                {i + 1}
              </div>

              {/* Address */}
              <div className="text-[11px] font-mono text-lime-600 w-24 shrink-0">
                {shortAddr(addr)}
              </div>

              {/* Bar */}
              <div className="flex-1 h-1.5 bg-lime-950 min-w-0">
                <div
                  className="h-full bg-lime-600"
                  style={{ width: `${Math.min(100, pct)}%` }}
                />
              </div>

              {/* Amount */}
              <div className="text-[11px] font-mono text-lime-400 w-16 text-right shrink-0">
                {fmt(bal)}
              </div>

              {/* % of holders */}
              <div className="text-[10px] font-mono text-lime-700 w-12 text-right shrink-0">
                {pct.toFixed(1)}%
              </div>
            </div>
          );
        })}
      </div>

      <div className="mt-3 pt-2 border-t border-lime-950 text-[9px] font-mono text-lime-900">
        Based on on-chain trade events · Does not include secondary transfers
      </div>
    </div>
  );
}
