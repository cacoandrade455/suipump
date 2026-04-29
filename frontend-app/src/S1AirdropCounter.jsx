// S1AirdropCounter.jsx
// Computes the running S1 airdrop pool estimate by scanning all
// TokensPurchased and TokensSold events across all SuiPump curves,
// summing 50% of the protocol fee (0.50% of each trade's volume).
//
// TESTNET PREVIEW: This counter is for demonstration only.
// The real S1 airdrop counter starts at zero on mainnet deployment.
// Testnet trades do not count toward the actual airdrop.

import React, { useState, useEffect } from 'react';
import { useSuiClient } from '@mysten/dapp-kit';
import { PACKAGE_ID } from './constants.js';

const PROTOCOL_SHARE_BPS = 50;   // 0.50% of trade volume
const AIRDROP_SHARE = 0.5;        // 50% of protocol fees → S1 pool
const MIST_PER_SUI = 1e9;

async function fetchSuiUsd() {
  try {
    const res = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=SUIUSDT');
    const j = await res.json();
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

// Animated number counter
function AnimatedNumber({ value, formatter }) {
  const [displayed, setDisplayed] = useState(value);
  useEffect(() => {
    if (value === displayed) return;
    const diff = value - displayed;
    const steps = 30;
    let step = 0;
    const interval = setInterval(() => {
      step++;
      setDisplayed(displayed + diff * (step / steps));
      if (step >= steps) { setDisplayed(value); clearInterval(interval); }
    }, 16);
    return () => clearInterval(interval);
  }, [value]);
  return <span>{formatter(displayed)}</span>;
}

export default function S1AirdropCounter() {
  const client = useSuiClient();
  const [poolSui, setPoolSui] = useState(0);
  const [volumeSui, setVolumeSui] = useState(0);
  const [tradeCount, setTradeCount] = useState(0);
  const [suiUsd, setSuiUsd] = useState(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchSuiUsd().then(setSuiUsd);
    const t = setInterval(() => fetchSuiUsd().then(setSuiUsd), 30_000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [buys, sells] = await Promise.all([
          client.queryEvents({
            query: { MoveEventType: `${PACKAGE_ID}::bonding_curve::TokensPurchased` },
            limit: 100, order: 'descending',
          }),
          client.queryEvents({
            query: { MoveEventType: `${PACKAGE_ID}::bonding_curve::TokensSold` },
            limit: 100, order: 'descending',
          }),
        ]);

        let totalVolumeMist = 0;
        let totalProtocolMist = 0;

        for (const e of buys.data) {
          const p = e.parsedJson;
          const suiIn = Number(p.sui_in ?? 0);
          const protocolFee = Number(p.protocol_fee ?? 0);
          totalVolumeMist += suiIn;
          totalProtocolMist += protocolFee;
        }

        for (const e of sells.data) {
          const p = e.parsedJson;
          const suiOut = Number(p.sui_out ?? 0);
          const protocolFee = Number(p.protocol_fee ?? 0);
          // For sells, volume = gross out before fee
          const grossOut = suiOut + Number(p.protocol_fee ?? 0) + Number(p.creator_fee ?? 0);
          totalVolumeMist += grossOut;
          totalProtocolMist += protocolFee;
        }

        const airdropPoolSui = (totalProtocolMist * AIRDROP_SHARE) / MIST_PER_SUI;
        const volumeTotalSui = totalVolumeMist / MIST_PER_SUI;
        const trades = buys.data.length + sells.data.length;

        if (!cancelled) {
          setPoolSui(airdropPoolSui);
          setVolumeSui(volumeTotalSui);
          setTradeCount(trades);
          setLoading(false);
        }
      } catch { if (!cancelled) setLoading(false); }
    }
    load();
    const t = setInterval(load, 15_000);
    return () => { cancelled = true; clearInterval(t); };
  }, [client]);

  const poolUsd = poolSui * suiUsd;
  const volumeUsd = volumeSui * suiUsd;

  return (
    <div className="border border-lime-500/30 bg-gradient-to-br from-lime-950/20 to-black p-5">
      {/* Header */}
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
          TESTNET PREVIEW<br/>MAINNET S1 TBD
        </div>
      </div>

      {/* Main pool stat */}
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

      {/* Supporting stats */}
      <div className="grid grid-cols-3 gap-3 border-t border-lime-950 pt-4">
        <div>
          <div className="text-[9px] font-mono text-lime-900 tracking-widest mb-1">TOTAL VOLUME</div>
          <div className="text-sm font-bold font-mono text-lime-600">{fmtSui(volumeSui)}</div>
          {suiUsd > 0 && <div className="text-[10px] font-mono text-lime-900">{fmtUsd(volumeUsd)}</div>}
        </div>
        <div>
          <div className="text-[9px] font-mono text-lime-900 tracking-widest mb-1">TOTAL TRADES</div>
          <div className="text-sm font-bold font-mono text-lime-600">{tradeCount}</div>
        </div>
        <div>
          <div className="text-[9px] font-mono text-lime-900 tracking-widest mb-1">YOUR SHARE</div>
          <div className="text-sm font-bold font-mono text-lime-600">TRADE TO EARN</div>
        </div>
      </div>

      {/* How to earn */}
      <div className="mt-4 border-t border-lime-950 pt-3 grid grid-cols-2 gap-2 text-[10px] font-mono">
        {[
          ['BUY / SELL', '1 pt per 0.01 SUI'],
          ['LAUNCH TOKEN', '500 pts flat'],
          ['TOKEN GRADUATES', '2,000 pts (creator)'],
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
