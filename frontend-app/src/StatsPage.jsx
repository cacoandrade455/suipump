// StatsPage.jsx
// Protocol revenue & metrics dashboard at /stats
// Shows: volume, protocol fees, S1 pool, token count, graduations, top tokens by volume.
// USD primary. Reuses existing useStats() pattern and useTokenList().

import React, { useState, useEffect, useMemo } from 'react';
import { useSuiClient } from '@mysten/dapp-kit';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, TrendingUp, Flame, Gift, Coins, Trophy, Zap, BarChart3 } from 'lucide-react';
import { PACKAGE_ID, DRAIN_SUI_APPROX } from './constants.js';
import { useTokenList } from './useTokenList.js';
import { paginateMultipleEvents } from './paginateEvents.js';

const INDEXER_URL = import.meta.env.VITE_INDEXER_URL || '';

const MIST_PER_SUI = 1e9;
const TOTAL_SUPPLY_WHOLE = 1_000_000_000;

async function fetchSuiUsd() {
  try {
    const r = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=SUIUSDT');
    const j = await r.json();
    return parseFloat(j.price) || 0;
  } catch {
    try {
      const r = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=sui&vs_currencies=usd');
      const j = await r.json();
      return j?.sui?.usd || 0;
    } catch { return 0; }
  }
}

function fmt(n, d = 2) {
  if (n == null || !Number.isFinite(n)) return '—';
  if (n >= 1e9) return (n / 1e9).toFixed(d) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(d) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(d) + 'k';
  return n.toFixed(d);
}

function fmtUsd(sui, suiUsd, d = 2) {
  if (!suiUsd || sui == null) return null;
  const usd = sui * suiUsd;
  if (usd >= 1e9) return `$${(usd / 1e9).toFixed(d)}B`;
  if (usd >= 1e6) return `$${(usd / 1e6).toFixed(d)}M`;
  if (usd >= 1e3) return `$${(usd / 1e3).toFixed(d)}k`;
  return `$${usd.toFixed(d)}`;
}

function StatCard({ icon, label, valueSui, valueUsd, accent = false, sub }) {
  return (
    <div className={`rounded-2xl border p-5 flex flex-col gap-1 ${
      accent
        ? 'border-lime-400/30 bg-lime-950/10'
        : 'border-white/10 bg-white/[0.03]'
    }`}>
      <div className={`flex items-center gap-2 text-[10px] font-mono tracking-widest mb-1 ${
        accent ? 'text-lime-400' : 'text-white/30'
      }`}>
        {icon} {label}
      </div>
      {valueUsd ? (
        <>
          <div className={`text-2xl font-bold font-mono ${accent ? 'text-lime-400' : 'text-white'}`}>
            {valueUsd}
          </div>
          <div className="text-xs font-mono text-white/30">{valueSui}</div>
        </>
      ) : (
        <div className={`text-2xl font-bold font-mono ${accent ? 'text-lime-400' : 'text-white'}`}>
          {valueSui}
        </div>
      )}
      {sub && <div className="text-[10px] font-mono text-white/35 mt-0.5">{sub}</div>}
    </div>
  );
}

function MiniBar({ value, max, color = 'lime' }) {
  const pct = max > 0 ? Math.max(1, (value / max) * 100) : 0;
  return (
    <div className="flex-1 h-1.5 bg-white/5 rounded-full overflow-hidden">
      <div
        className={`h-full rounded-full bg-${color}-500`}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

export default function StatsPage({ onBack }) {
  const client = useSuiClient();
  const navigate = useNavigate();
  const { tokens } = useTokenList();

  const [suiUsd, setSuiUsd] = useState(0);
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState({
    volume: null,
    protocolFees: null,
    creatorFees: null,
    lpFees: null,
    tradeCount: null,
    buyCount: null,
    sellCount: null,
    graduations: null,
    topTokens: [],
    volumeByDay: [],
  });

  useEffect(() => {
    fetchSuiUsd().then(setSuiUsd);
    const t = setInterval(() => fetchSuiUsd().then(setSuiUsd), 30_000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      // Try indexer API first — instant
      if (INDEXER_URL) {
        try {
          const res = await fetch(`${INDEXER_URL}/stats`, { signal: AbortSignal.timeout(5000) });
          if (res.ok) {
            const d = await res.json();
            if (!cancelled) setData({
              volume:       d.totalVolume,
              protocolFees: d.protocolFeesSui,
              tradeCount:   d.totalTrades,
              tokenCount:   d.tokenCount,
              graduated:    0,
              creatorFees:  d.totalVolume * 0.004,
              lpFees:       d.totalVolume * 0.001,
              volumeByDay:  {},
              volumeByCurve: {},
              topTokens:    [],
            });
            setLoading(false);
            return;
          }
        } catch {}
      }
      // Fall back to RPC
      try {
        const buyType = `${PACKAGE_ID}::bonding_curve::TokensPurchased`;
        const sellType = `${PACKAGE_ID}::bonding_curve::TokensSold`;
        const gradType = `${PACKAGE_ID}::bonding_curve::Graduated`;

        const [eventMap, gradEvents] = await Promise.all([
          paginateMultipleEvents(client, [buyType, sellType], { order: 'descending', maxPages: 100 }),
          paginateMultipleEvents(client, [gradType], { order: 'descending', maxPages: 100 }),
        ]);

        if (cancelled) return;

        const buys = eventMap[buyType];
        const sells = eventMap[sellType];
        const grads = gradEvents[gradType];

        let volumeMist = 0, protocolMist = 0, creatorMist = 0, lpMist = 0;
        const volumeByCurve = {};
        const volumeByDay = {};

        for (const e of buys) {
          const p = e.parsedJson;
          const suiIn = Number(p.sui_in ?? 0);
          volumeMist += suiIn;
          protocolMist += Number(p.protocol_fee ?? 0);
          creatorMist += Number(p.creator_fee ?? 0);
          lpMist += Number(p.lp_fee ?? 0);
          if (p.curve_id) volumeByCurve[p.curve_id] = (volumeByCurve[p.curve_id] || 0) + suiIn;
          if (e.timestampMs) {
            const day = new Date(Number(e.timestampMs)).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
            volumeByDay[day] = (volumeByDay[day] || 0) + suiIn;
          }
        }
        for (const e of sells) {
          const p = e.parsedJson;
          const suiOut = Number(p.sui_out ?? 0);
          volumeMist += suiOut;
          protocolMist += Number(p.protocol_fee ?? 0);
          creatorMist += Number(p.creator_fee ?? 0);
          lpMist += Number(p.lp_fee ?? 0);
          if (p.curve_id) volumeByCurve[p.curve_id] = (volumeByCurve[p.curve_id] || 0) + suiOut;
          if (e.timestampMs) {
            const day = new Date(Number(e.timestampMs)).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
            volumeByDay[day] = (volumeByDay[day] || 0) + suiOut;
          }
        }

        // Top 10 tokens by volume
        const topTokens = Object.entries(volumeByCurve)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 10)
          .map(([curveId, vol]) => ({ curveId, volume: vol / MIST_PER_SUI }));

        // Last 7 days of volume
        const days = Object.entries(volumeByDay)
          .map(([day, vol]) => ({ day, volume: vol / MIST_PER_SUI }))
          .slice(-7);

        if (!cancelled) {
          setData({
            volume: volumeMist / MIST_PER_SUI,
            protocolFees: protocolMist / MIST_PER_SUI,
            creatorFees: creatorMist / MIST_PER_SUI,
            lpFees: lpMist / MIST_PER_SUI,
            tradeCount: buys.length + sells.length,
            buyCount: buys.length,
            sellCount: sells.length,
            graduations: grads.length,
            topTokens,
            volumeByDay: days,
          });
          setLoading(false);
        }
      } catch { if (!cancelled) setLoading(false); }
    }
    load();
    const t = setInterval(load, 30_000);
    return () => { cancelled = true; clearInterval(t); };
  }, [client]);

  // Enrich top tokens with name/symbol from token list
  const enrichedTop = useMemo(() => {
    return data.topTokens.map(tt => {
      const meta = tokens.find(t => t.curveId === tt.curveId);
      return { ...tt, name: meta?.name || 'Unknown', symbol: meta?.symbol || '???', tokenType: meta?.tokenType };
    });
  }, [data.topTokens, tokens]);

  const s1Pool = data.protocolFees != null ? data.protocolFees * 0.5 : null;
  const maxTopVol = enrichedTop[0]?.volume || 1;

  // Mini bar chart for daily volume
  const maxDayVol = Math.max(...data.volumeByDay.map(d => d.volume), 1);

  return (
    <div>
      <button
        onClick={onBack}
        className="flex items-center gap-2 text-xs font-mono text-white/40 hover:text-white mb-6 transition-colors"
      >
        <ArrowLeft size={12} /> BACK TO HOME
      </button>

      <div className="max-w-4xl mx-auto space-y-6">

        {/* Header */}
        <div className="rounded-3xl border border-white/10 bg-gradient-to-br from-lime-950/20 via-black to-black p-8 relative overflow-hidden">
          <div className="absolute top-0 left-1/2 -translate-x-1/2 w-80 h-24 bg-lime-400/10 blur-3xl rounded-full pointer-events-none" />
          <div className="relative flex items-start justify-between">
            <div>
              <div className="flex items-center gap-3 mb-2">
                <BarChart3 className="text-lime-400" size={22} />
                <h1 className="text-2xl font-bold text-white" style={{ fontFamily: "'Space Grotesk', sans-serif" }}>
                  PROTOCOL STATS
                </h1>
              </div>
              <p className="text-xs font-mono text-white/30 max-w-md">
                Live metrics for SuiPump testnet. All figures computed from on-chain events.
              </p>
            </div>
            <div className="text-right shrink-0">
              <div className="text-[9px] font-mono text-white/35 tracking-widest">SUI/USD</div>
              <div className="text-sm font-bold font-mono text-white/60">
                {suiUsd > 0 ? `$${suiUsd.toFixed(4)}` : '—'}
              </div>
            </div>
          </div>
        </div>

        {/* Primary stats grid */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <StatCard
            icon={<TrendingUp size={11} />}
            label="TOTAL VOLUME"
            valueSui={loading ? '…' : `${fmt(data.volume)} SUI`}
            valueUsd={loading ? null : fmtUsd(data.volume, suiUsd)}
            accent
          />
          <StatCard
            icon={<Coins size={11} />}
            label="PROTOCOL FEES"
            valueSui={loading ? '…' : `${fmt(data.protocolFees)} SUI`}
            valueUsd={loading ? null : fmtUsd(data.protocolFees, suiUsd)}
            sub="0.50% of every trade"
          />
          <StatCard
            icon={<Gift size={11} />}
            label="S1 AIRDROP POOL"
            valueSui={loading ? '…' : `${fmt(s1Pool)} SUI`}
            valueUsd={loading ? null : fmtUsd(s1Pool, suiUsd)}
            accent
            sub="50% of protocol fees"
          />
          <StatCard
            icon={<Flame size={11} />}
            label="TOTAL TRADES"
            valueSui={loading ? '…' : (data.tradeCount ?? '—').toLocaleString()}
            sub={loading ? null : `${(data.buyCount ?? 0).toLocaleString()} buys · ${(data.sellCount ?? 0).toLocaleString()} sells`}
          />
        </div>

        {/* Secondary stats */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <StatCard
            icon={<Trophy size={11} />}
            label="TOKENS LAUNCHED"
            valueSui={loading ? '…' : (tokens.length || '—').toString()}
          />
          <StatCard
            icon={<Zap size={11} />}
            label="GRADUATED"
            valueSui={loading ? '…' : (data.graduations ?? '—').toString()}
            sub="tokens reached DEX"
          />
          <StatCard
            icon={<Coins size={11} />}
            label="CREATOR FEES PAID"
            valueSui={loading ? '…' : `${fmt(data.creatorFees)} SUI`}
            valueUsd={loading ? null : fmtUsd(data.creatorFees, suiUsd)}
            sub="0.40% of every trade"
          />
          <StatCard
            icon={<Flame size={11} />}
            label="LP FEES RETAINED"
            valueSui={loading ? '…' : `${fmt(data.lpFees)} SUI`}
            valueUsd={loading ? null : fmtUsd(data.lpFees, suiUsd)}
            sub="0.10% stays in curves"
          />
        </div>

        {/* Fee breakdown visual */}
        <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
          <div className="text-[10px] font-mono text-white/30 tracking-widest mb-4">FEE BREAKDOWN · PER TRADE (1.00% TOTAL)</div>
          <div className="space-y-3">
            {[
              { label: 'CREATOR', pct: 40, value: data.creatorFees, color: 'amber' },
              { label: 'PROTOCOL', pct: 50, value: data.protocolFees, color: 'lime' },
              { label: 'LP (in curve)', pct: 10, value: data.lpFees, color: 'sky' },
            ].map(({ label, pct, value, color }) => (
              <div key={label} className="flex items-center gap-3">
                <div className="text-[10px] font-mono text-white/30 w-24 shrink-0">{label}</div>
                <div className="flex-1 h-2 bg-white/5 rounded-full overflow-hidden">
                  <div
                    className={`h-full rounded-full bg-${color}-500/70`}
                    style={{ width: `${pct}%` }}
                  />
                </div>
                <div className="text-[10px] font-mono text-white/50 w-8 shrink-0 text-right">{pct}%</div>
                <div className="text-xs font-mono text-white/60 w-24 text-right shrink-0">
                  {loading ? '…' : fmtUsd(value, suiUsd) ?? `${fmt(value)} SUI`}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Daily volume bar chart */}
        {data.volumeByDay.length > 1 && (
          <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
            <div className="text-[10px] font-mono text-white/30 tracking-widest mb-4">VOLUME BY DAY (SUI)</div>
            <div className="flex items-end gap-2 h-24">
              {data.volumeByDay.map(({ day, volume }) => {
                const pct = Math.max(2, (volume / maxDayVol) * 100);
                const usdLabel = fmtUsd(volume, suiUsd);
                return (
                  <div key={day} className="flex-1 flex flex-col items-center gap-1 group relative">
                    {/* Tooltip */}
                    <div className="absolute bottom-full mb-1 left-1/2 -translate-x-1/2 bg-black border border-white/10 rounded-lg px-2 py-1 text-[9px] font-mono text-white/70 whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none z-10">
                      {usdLabel ?? `${fmt(volume)} SUI`}
                    </div>
                    <div
                      className="w-full bg-lime-400/40 hover:bg-lime-400/70 rounded-t transition-colors"
                      style={{ height: `${pct}%` }}
                    />
                    <div className="text-[8px] font-mono text-white/35 text-center leading-tight">{day}</div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Top tokens by volume */}
        <div className="rounded-2xl border border-white/10 bg-white/[0.03] overflow-hidden">
          <div className="px-5 py-4 border-b border-white/5 flex items-center justify-between">
            <div className="text-[10px] font-mono text-white/30 tracking-widest">TOP TOKENS BY VOLUME</div>
            <div className="text-[10px] font-mono text-white/35">{enrichedTop.length} tokens with trades</div>
          </div>

          {loading ? (
            <div className="space-y-px p-4">
              {[...Array(5)].map((_, i) => (
                <div key={i} className="h-10 bg-white/5 rounded animate-pulse mb-2" />
              ))}
            </div>
          ) : enrichedTop.length === 0 ? (
            <div className="text-xs font-mono text-white/35 text-center py-10">No trades yet.</div>
          ) : (
            <div>
              {enrichedTop.map((token, i) => (
                <button
                  key={token.curveId}
                  onClick={() => token.tokenType && navigate(`/token/${token.curveId}`)}
                  className="w-full flex items-center gap-4 px-5 py-3.5 border-b border-white/[0.03] last:border-0 hover:bg-white/5 transition-colors group text-left"
                >
                  <div className="text-[10px] font-mono text-white/35 w-5 shrink-0 text-right">{i + 1}</div>
                  <div className="w-24 shrink-0">
                    <div className="text-xs font-mono font-bold text-white group-hover:text-lime-400 transition-colors truncate">{token.name}</div>
                    <div className="text-[10px] font-mono text-white/30">${token.symbol}</div>
                  </div>
                  <MiniBar value={token.volume} max={maxTopVol} />
                  <div className="text-xs font-mono font-bold text-white shrink-0 w-28 text-right">
                    {fmtUsd(token.volume, suiUsd) ?? `${fmt(token.volume)} SUI`}
                  </div>
                  <div className="text-[10px] font-mono text-white/30 shrink-0 w-20 text-right">
                    {fmt(token.volume, 2)} SUI
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Projection box */}
        <div className="rounded-2xl border border-lime-400/10 bg-lime-950/10 p-5 flex flex-col sm:flex-row items-start sm:items-center gap-4">
          <div className="flex-1">
            <div className="text-[10px] font-mono text-lime-400/60 tracking-widest mb-1">MAINNET PROJECTION</div>
            <div className="text-xs font-mono text-white/40 leading-relaxed">
              At $50M/month volume → ~$500k/month protocol fees → ~$250k/month into S1 airdrop pool.
            </div>
          </div>
          <div className="text-right shrink-0">
            <div className="text-[9px] font-mono text-white/35 mb-0.5">TARGET VOLUME</div>
            <div className="text-2xl font-bold font-mono text-lime-400">$50M</div>
            <div className="text-[9px] font-mono text-white/35">per month</div>
          </div>
        </div>

        <div className="text-center text-[9px] font-mono text-white/30 py-2">
          TESTNET DATA ONLY · RESETS AT MAINNET LAUNCH · REFRESHES EVERY 30S
        </div>
      </div>
    </div>
  );
}
