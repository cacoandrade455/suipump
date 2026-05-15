// S1AirdropCounter.jsx
// Reads s1PoolSui, totalVolume, totalTrades from the indexer /stats endpoint.
// Falls back to RPC event scan if indexer is unavailable.

import React, { useState, useEffect } from 'react';
import { useSuiClient } from '@mysten/dapp-kit';
import { ALL_PACKAGE_IDS } from './constants.js';
const INDEXER_URL = import.meta.env.VITE_INDEXER_URL || '';
import { paginateMultipleEvents } from './paginateEvents.js';

const AIRDROP_SHARE = 0.5;
const MIST_PER_SUI  = 1e9;

async function fetchSuiUsd() {
  try {
    const res = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=SUIUSDT');
    const j   = await res.json();
    return parseFloat(j.price) || 0;
  } catch {
    return 0;
  }
}

function fmtSui(sui) {
  if (sui >= 1000) return `${sui.toFixed(2)} SUI`;
  return `${sui.toFixed(4)} SUI`;
}

function fmtUsd(usd) {
  if (usd >= 1e6) return `$${(usd / 1e6).toFixed(2)}M`;
  if (usd >= 1e3) return `$${(usd / 1e3).toFixed(2)}k`;
  return `$${usd.toFixed(2)}`;
}

export default function S1AirdropCounter() {
  const client = useSuiClient();

  const [poolSui,    setPoolSui]    = useState(0);
  const [volumeSui,  setVolumeSui]  = useState(0);
  const [tradeCount, setTradeCount] = useState(0);
  const [suiUsd,     setSuiUsd]     = useState(0);
  const [loading,    setLoading]    = useState(true);

  // SUI price — refresh every 30s
  useEffect(() => {
    fetchSuiUsd().then(setSuiUsd);
    const t = setInterval(() => fetchSuiUsd().then(setSuiUsd), 30_000);
    return () => clearInterval(t);
  }, []);

  // Stats — indexer first, RPC fallback
  useEffect(() => {
    let cancelled = false;

    async function load() {
      // ── Indexer path (fast) ────────────────────────────────────────────────
      if (INDEXER_URL) {
        try {
          const res = await fetch(`${INDEXER_URL}/stats`, {
            signal: AbortSignal.timeout(5000),
          });
          if (res.ok) {
            const d = await res.json();
            if (!cancelled) {
              setPoolSui(d.s1PoolSui    ?? 0);
              setVolumeSui(d.totalVolume ?? 0);
              setTradeCount(d.totalTrades ?? 0);
              setLoading(false);
            }
            return;
          }
        } catch { /* fall through to RPC */ }
      }

      // ── RPC fallback (slow) ────────────────────────────────────────────────
      try {
        const eventTypes = ALL_PACKAGE_IDS.flatMap(pkg => [
          `${pkg}::bonding_curve::TokensPurchased`,
          `${pkg}::bonding_curve::TokensSold`,
        ]);

        const eventMap = await paginateMultipleEvents(
          client,
          eventTypes,
          { order: 'descending', maxPages: 100 }
        );

        let totalVolumeMist   = 0;
        let totalProtocolMist = 0;

        for (const [type, events] of Object.entries(eventMap)) {
          for (const e of events) {
            const p = e.parsedJson;
            if (type.includes('TokensPurchased')) {
              totalVolumeMist   += Number(p.sui_in       ?? 0);
              totalProtocolMist += Number(p.protocol_fee ?? 0);
            } else {
              totalVolumeMist   += Number(p.sui_out      ?? 0);
              totalProtocolMist += Number(p.protocol_fee ?? 0);
            }
          }
        }

        const totalEvents = Object.values(eventMap).reduce((s, arr) => s + arr.length, 0);

        if (!cancelled) {
          setPoolSui(   (totalProtocolMist * AIRDROP_SHARE) / MIST_PER_SUI);
          setVolumeSui(  totalVolumeMist / MIST_PER_SUI);
          setTradeCount( totalEvents);
          setLoading(false);
        }
      } catch {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    const timer = setInterval(load, 15_000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [client]);

  const poolUsd   = poolSui   * suiUsd;
  const volumeUsd = volumeSui * suiUsd;

  return (
    <div className="border border-lime-500/30 bg-gradient-to-br from-lime-950/20 to-black p-5">
      <div className="flex items-center justify-between mb-4">
        <div>
          <div className="flex items-center gap-2 text-xs font-mono tracking-widest text-lime-400 mb-1">
            🎁 SEASON 1 AIRDROP POOL
          </div>
          <div className="text-[10px] font-mono text-lime-900">
            EST. 50% OF PROTOCOL FEES · DISTRIBUTED AT SEASON CLOSE
          </div>
        </div>
        <div className="text-[9px] font-mono text-amber-800 border border-amber-900/40 px-2 py-1 text-right">
          TESTNET PREVIEW<br />MAINNET S1 TBD
        </div>
      </div>

      <div className="mb-4">
        {loading ? (
          <div className="text-2xl font-bold font-mono text-lime-400">…</div>
        ) : (
          <>
            <div className="text-3xl font-bold font-mono text-lime-400 tabular-nums">
              {fmtSui(poolSui)}
            </div>
            {suiUsd > 0 && (
              <div className="text-sm font-mono text-lime-700 mt-0.5">
                ≈ {fmtUsd(poolUsd)}
              </div>
            )}
          </>
        )}
      </div>

      <div className="grid grid-cols-3 gap-3 border-t border-lime-950 pt-4">
        <div>
          <div className="text-[9px] font-mono text-lime-900 tracking-widest mb-1">TOTAL VOLUME</div>
          <div className="text-sm font-bold font-mono text-lime-600">{fmtSui(volumeSui)}</div>
          {suiUsd > 0 && (
            <div className="text-[10px] font-mono text-lime-900">{fmtUsd(volumeUsd)}</div>
          )}
        </div>
        <div>
          <div className="text-[9px] font-mono text-lime-900 tracking-widest mb-1">TOTAL TRADES</div>
          <div className="text-sm font-bold font-mono text-lime-600">{tradeCount.toLocaleString()}</div>
        </div>
        <div>
          <div className="text-[9px] font-mono text-lime-900 tracking-widest mb-1">YOUR SHARE</div>
          <div className="text-sm font-bold font-mono text-lime-600">TRADE TO EARN</div>
        </div>
      </div>

      <div className="mt-4 border-t border-lime-950 pt-3 grid grid-cols-2 gap-2 text-[10px] font-mono">
        {[
          ['BUY / SELL',       '1 pt per 0.01 SUI'],
          ['LAUNCH TOKEN',     '500 pts flat'],
          ['TOKEN GRADUATES',  '2,000 pts (creator)'],
          ['REFER A LAUNCHER', '20% of their pts'],
        ].map(([action, reward]) => (
          <div key={action} className="flex justify-between">
            <span className="text-lime-800">{action}</span>
            <span className="text-lime-600">{reward}</span>
          </div>
        ))}
      </div>

      <div className="mt-3 text-[9px] font-mono text-lime-900 leading-relaxed">
        Estimated pool = 50% of protocol fees collected · Final amount determined at season close · Distributed in SUI · No vesting
      </div>
    </div>
  );
}
