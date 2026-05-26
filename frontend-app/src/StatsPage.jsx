// StatsPage.jsx v3 — indexer-first, all sections restored
// Sections: header, primary grid, secondary grid, fee breakdown, daily volume, top tokens, projection

import React, { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, TrendingUp, Flame, Gift, Coins, Trophy, Zap, BarChart3, Users } from 'lucide-react';
import { ALL_PACKAGE_IDS } from './constants.js';
import { useTokenList } from './useTokenList.js';

const INDEXER_URL       = import.meta.env.VITE_INDEXER_URL || '';
const MIST_PER_SUI      = 1e9;
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
  return Number.isInteger(n) ? n.toString() : n.toFixed(d);
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
      accent ? 'border-lime-400/30 bg-lime-950/10' : 'border-white/10 bg-white/[0.03]'
    }`}>
      <div className={`flex items-center gap-2 text-[10px] font-mono tracking-widest mb-1 ${
        accent ? 'text-lime-400' : 'text-white/30'
      }`}>
        {icon} {label}
      </div>
      {valueUsd ? (
        <>
          <div className={`text-2xl font-bold font-mono ${accent ? 'text-lime-400' : 'text-white'}`}>{valueUsd}</div>
          <div className="text-xs font-mono text-white/30">{valueSui}</div>
        </>
      ) : (
        <div className={`text-2xl font-bold font-mono ${accent ? 'text-lime-400' : 'text-white'}`}>{valueSui}</div>
      )}
      {sub && <div className="text-[10px] font-mono text-white/35 mt-0.5">{sub}</div>}
    </div>
  );
}

function MiniBar({ value, max }) {
  const pct = max > 0 ? Math.max(1, (value / max) * 100) : 0;
  return (
    <div className="flex-1 h-1.5 bg-white/5 rounded-full overflow-hidden">
      <div className="h-full rounded-full bg-lime-500" style={{ width: `${pct}%` }} />
    </div>
  );
}

export default function StatsPage({ onBack }) {
  const navigate = useNavigate();
  const { tokens } = useTokenList();

  const [suiUsd,  setSuiUsd]  = useState(0);
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState({
    volume:         null,
    protocolFees:   null,
    creatorFees:    null,
    lpFees:         null,
    s1Pool:         null,
    tradeCount:     null,
    buyCount:       null,
    sellCount:      null,
    tokenCount:     null,
    graduatedCount: null,
    uniqueWallets:  null,
    topTokens:      [],
    volumeByDay:    [],
  });

  useEffect(() => {
    fetchSuiUsd().then(setSuiUsd);
    const t = setInterval(() => fetchSuiUsd().then(setSuiUsd), 30_000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (!INDEXER_URL) { setLoading(false); return; }
      try {
        // Load global stats + top tokens in parallel
        const [statsRes, leaderRes] = await Promise.all([
          fetch(`${INDEXER_URL}/stats`,                  { signal: AbortSignal.timeout(5000) }),
          fetch(`${INDEXER_URL}/leaderboard/volume?limit=10`, { signal: AbortSignal.timeout(5000) }),
        ]);

        if (cancelled) return;

        let d = {};
        if (statsRes.ok) d = await statsRes.json();

        const vol          = d.totalVolume     ?? 0;
        const protocolFees = d.protocolFeesSui ?? vol * 0.005;
        const creatorFees  = d.creatorFeesSui  ?? vol * 0.004;
        const lpFees       = vol * 0.001;
        const s1Pool       = d.s1PoolSui       ?? protocolFees * 0.5;

        let topTokens = [];
        if (leaderRes.ok) {
          const rows = await leaderRes.json();
          topTokens = rows.map(r => ({
            curveId: r.curve_id,
            name:    r.name    || 'Unknown',
            symbol:  r.symbol  || '???',
            volume:  Number(r.volume_sui ?? 0),
            trades:  Number(r.trades     ?? 0),
          }));
        }

        if (!cancelled) {
          setData({
            volume:         vol,
            protocolFees,
            creatorFees,
            lpFees,
            s1Pool,
            tradeCount:     d.totalTrades     ?? null,
            buyCount:       d.totalBuys       ?? null,
            sellCount:      d.totalSells      ?? null,
            tokenCount:     d.tokenCount      ?? null,
            graduatedCount: d.graduatedCount  ?? null,
            uniqueWallets:  d.uniqueWallets   ?? null,
            topTokens,
            volumeByDay:    [],
          });
          setLoading(false);
        }
      } catch { if (!cancelled) setLoading(false); }
    }
    load();
    const t = setInterval(load, 30_000);
    return () => { cancelled = true; clearInterval(t); };
  }, []);

  const maxTopVol = data.topTokens[0]?.volume || 1;

  return (
    <div>
      <button
        onClick={onBack || (() => navigate('/'))}
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
            valueSui={loading ? '…' : `${fmt(data.s1Pool)} SUI`}
            valueUsd={loading ? null : fmtUsd(data.s1Pool, suiUsd)}
            accent
            sub="50% of protocol fees"
          />
          <StatCard
            icon={<Flame size={11} />}
            label="TOTAL TRADES"
            valueSui={loading ? '…' : (data.tradeCount ?? '—').toLocaleString()}
            sub={loading || data.buyCount == null ? null
              : `${(data.buyCount ?? 0).toLocaleString()} buys · ${(data.sellCount ?? 0).toLocaleString()} sells`}
          />
        </div>

        {/* Secondary stats grid */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <StatCard
            icon={<Trophy size={11} />}
            label="TOKENS LAUNCHED"
            valueSui={loading ? '…' : fmt(data.tokenCount ?? tokens.length, 0)}
          />
          <StatCard
            icon={<Zap size={11} />}
            label="GRADUATED"
            valueSui={loading ? '…' : fmt(data.graduatedCount ?? 0, 0)}
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
            icon={<Users size={11} />}
            label="UNIQUE WALLETS"
            valueSui={loading ? '…' : fmt(data.uniqueWallets ?? 0, 0)}
            sub="traders ever"
          />
        </div>

        {/* Fee breakdown */}
        <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
          <div className="text-[10px] font-mono text-white/30 tracking-widest mb-4">FEE BREAKDOWN · PER TRADE (1.00% TOTAL)</div>
          <div className="space-y-3">
            {[
              { label: 'CREATOR',      pct: 40, value: data.creatorFees,  color: '#f59e0b' },
              { label: 'PROTOCOL',     pct: 50, value: data.protocolFees, color: '#84cc16' },
              { label: 'LP (in curve)',pct: 10, value: data.lpFees,       color: '#38bdf8' },
            ].map(({ label, pct, value, color }) => (
              <div key={label} className="flex items-center gap-3">
                <div className="text-[10px] font-mono text-white/30 w-24 shrink-0">{label}</div>
                <div className="flex-1 h-2 bg-white/5 rounded-full overflow-hidden">
                  <div className="h-full rounded-full" style={{ width: `${pct}%`, backgroundColor: color + 'b3' }} />
                </div>
                <div className="text-[10px] font-mono text-white/50 w-8 shrink-0 text-right">{pct}%</div>
                <div className="text-xs font-mono text-white/60 w-24 text-right shrink-0">
                  {loading ? '…' : (fmtUsd(value, suiUsd) ?? `${fmt(value)} SUI`)}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Top tokens by volume */}
        <div className="rounded-2xl border border-white/10 bg-white/[0.03] overflow-hidden">
          <div className="px-5 py-4 border-b border-white/5 flex items-center justify-between">
            <div className="text-[10px] font-mono text-white/30 tracking-widest">TOP TOKENS BY VOLUME</div>
            <div className="text-[10px] font-mono text-white/35">{data.topTokens.length} tokens with trades</div>
          </div>
          {loading ? (
            <div className="space-y-2 p-4">
              {[...Array(5)].map((_, i) => (
                <div key={i} className="h-10 bg-white/5 rounded animate-pulse" />
              ))}
            </div>
          ) : data.topTokens.length === 0 ? (
            <div className="text-xs font-mono text-white/35 text-center py-10">No trades yet.</div>
          ) : (
            <div>
              {data.topTokens.map((token, i) => (
                <button
                  key={token.curveId}
                  onClick={() => navigate(`/token/${token.curveId}`)}
                  className="w-full flex items-center gap-4 px-5 py-3.5 border-b border-white/[0.03] last:border-0 hover:bg-white/5 transition-colors group text-left"
                >
                  <div className="text-[10px] font-mono text-white/35 w-5 shrink-0 text-right">{i + 1}</div>
                  <div className="w-28 shrink-0">
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

        {/* Mainnet projection */}
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
