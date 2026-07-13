// StatsPage.jsx v4 - Terminal design (2g / 6c) + C-5 corrected projection
// Sections: header, primary grid, secondary grid, five-way fee split, top tokens,
// mainnet projection. Data logic unchanged except the C-5 fee model correction
// (protocol + airdrop are each 0.25% of volume, not a single 0.50% bucket; the
// S1 pool IS the airdrop bucket = 0.25% of volume; the design's "~$250k" figure
// was protocol+airdrop combined and is NOT the S1 pool).

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
  if (n == null || !Number.isFinite(n)) return '-';
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

// Terminal stat card. accent = lime-bordered highlight (design: border-lime-400/30
// bg-lime-400/[0.05]); neutral = border-white/[0.08] bg-white/[0.015].
function StatCard({ icon, label, valueSui, valueUsd, accent = false, sub }) {
  return (
    <div className={`rounded-2xl border p-4 flex flex-col gap-1 ${
      accent ? 'border-lime-400/30 bg-lime-400/[0.05]' : 'border-white/[0.08] bg-white/[0.015]'
    }`}>
      <div className={`flex items-center gap-2 text-[9px] font-mono font-semibold tracking-[0.16em] mb-1.5 ${
        accent ? 'text-lime-400' : 'text-white/35'
      }`}>
        {icon} {label}
      </div>
      {valueUsd ? (
        <>
          <div className={`text-[21px] leading-none font-extrabold font-mono ${accent ? 'text-lime-400' : 'text-white'}`}>{valueUsd}</div>
          <div className="text-[11px] font-mono text-white/30 mt-1">{valueSui}</div>
        </>
      ) : (
        <div className={`text-[21px] leading-none font-extrabold font-mono ${accent ? 'text-lime-400' : 'text-white'}`}>{valueSui}</div>
      )}
      {sub && <div className="text-[9.5px] font-mono text-white/35 mt-1.5 leading-relaxed">{sub}</div>}
    </div>
  );
}

function MiniBar({ value, max }) {
  const pct = max > 0 ? Math.max(1, (value / max) * 100) : 0;
  return (
    <div className="flex-1 h-1.5 bg-white/[0.06] rounded-full overflow-hidden">
      <div className="h-full rounded-full bg-lime-400/55" style={{ width: `${pct}%` }} />
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
    airdropBucket:  null,
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

        // C-5 five-way fee model (split_fee_v7, no referral): of the 1.00% trade
        // fee, 40% -> creator (0.40% of vol), 25% -> protocol (0.25%), 25% ->
        // airdrop bucket (0.25%), 10% -> LP (0.10%). The S1 airdrop pool IS the
        // airdrop bucket (0.25% of volume) - NOT 50% of protocol, NOT 0.50%.
        const vol           = d.totalVolume     ?? 0;
        const creatorFees   = d.creatorFeesSui  ?? vol * 0.004;
        const protocolFees  = d.protocolFeesSui ?? vol * 0.0025;
        const airdropBucket = d.airdropFeesSui  ?? vol * 0.0025;
        const lpFees        = vol * 0.001;
        const s1Pool        = d.s1PoolSui       ?? airdropBucket;

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
            airdropBucket,
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
        className="flex items-center gap-2 text-xs font-mono text-white/40 hover:text-lime-400 mb-6 transition-colors"
      >
        <ArrowLeft size={12} /> BACK TO HOME
      </button>

      <div className="max-w-5xl mx-auto space-y-4">

        {/* Header (Terminal card) */}
        <div className="rounded-2xl border border-white/[0.08] bg-white/[0.015] p-6 relative overflow-hidden">
          <div className="absolute top-0 left-1/2 -translate-x-1/2 w-80 h-24 bg-lime-400/[0.08] blur-3xl rounded-full pointer-events-none" />
          <div className="relative flex items-start justify-between">
            <div>
              <div className="flex items-center gap-3 mb-2">
                <BarChart3 className="text-lime-400" size={20} />
                <h1 className="text-lg font-extrabold font-mono tracking-tight text-white">PROTOCOL STATS</h1>
              </div>
              <p className="text-[11px] font-mono text-white/35 max-w-md leading-relaxed">
                Live metrics for SuiPump testnet. All figures computed from on-chain events.
              </p>
            </div>
            <div className="text-right shrink-0">
              <div className="text-[9px] font-mono font-semibold text-white/35 tracking-[0.16em]">SUI/USD</div>
              <div className="text-sm font-bold font-mono text-white/70 mt-1">
                {suiUsd > 0 ? `$${suiUsd.toFixed(4)}` : '-'}
              </div>
            </div>
          </div>
        </div>

        {/* Primary stats grid */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <StatCard
            icon={<TrendingUp size={11} />}
            label="TOTAL VOLUME"
            valueSui={loading ? '...' : `${fmt(data.volume)} SUI`}
            valueUsd={loading ? null : fmtUsd(data.volume, suiUsd)}
            accent
          />
          <StatCard
            icon={<Coins size={11} />}
            label="PROTOCOL FEES"
            valueSui={loading ? '...' : `${fmt(data.protocolFees)} SUI`}
            valueUsd={loading ? null : fmtUsd(data.protocolFees, suiUsd)}
            sub="0.25% of every trade"
          />
          <StatCard
            icon={<Gift size={11} />}
            label="S1 AIRDROP POOL"
            valueSui={loading ? '...' : `${fmt(data.s1Pool)} SUI`}
            valueUsd={loading ? null : fmtUsd(data.s1Pool, suiUsd)}
            accent
            sub="the airdrop bucket - 0.25% of every trade"
          />
          <StatCard
            icon={<Flame size={11} />}
            label="TOTAL TRADES"
            valueSui={loading ? '...' : (data.tradeCount ?? '-').toLocaleString()}
            sub={loading || data.buyCount == null ? null
              : `${(data.buyCount ?? 0).toLocaleString()} buys - ${(data.sellCount ?? 0).toLocaleString()} sells`}
          />
        </div>

        {/* Secondary stats grid */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <StatCard
            icon={<Trophy size={11} />}
            label="TOKENS LAUNCHED"
            valueSui={loading ? '...' : fmt(data.tokenCount ?? tokens.length, 0)}
          />
          <StatCard
            icon={<Zap size={11} />}
            label="GRADUATED"
            valueSui={loading ? '...' : fmt(data.graduatedCount ?? 0, 0)}
            sub="tokens reached DEX"
          />
          <StatCard
            icon={<Coins size={11} />}
            label="CREATOR FEES PAID"
            valueSui={loading ? '...' : `${fmt(data.creatorFees)} SUI`}
            valueUsd={loading ? null : fmtUsd(data.creatorFees, suiUsd)}
            sub="0.40% of every trade"
          />
          <StatCard
            icon={<Users size={11} />}
            label="UNIQUE WALLETS"
            valueSui={loading ? '...' : fmt(data.uniqueWallets ?? 0, 0)}
            sub="traders ever"
          />
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-start">
          {/* Five-way fee breakdown */}
          <div className="rounded-2xl border border-white/[0.08] bg-white/[0.015] p-[18px]">
            <div className="text-[10px] font-mono font-bold text-white/50 tracking-[0.16em] mb-4">FEE BREAKDOWN - PER TRADE (1.00% TOTAL)</div>
            <div className="space-y-3">
              {[
                { label: 'CREATOR',        pct: 40, value: data.creatorFees,   color: '#f59e0b' },
                { label: 'PROTOCOL',       pct: 25, value: data.protocolFees,  color: '#84cc16' },
                { label: 'AIRDROP BUCKET', pct: 25, value: data.airdropBucket, color: '#a78bfa' },
                { label: 'LP (in curve)',  pct: 10, value: data.lpFees,        color: '#38bdf8' },
              ].map(({ label, pct, value, color }) => (
                <div key={label} className="flex items-center gap-3">
                  <div className="text-[10px] font-mono text-white/40 w-[86px] shrink-0">{label}</div>
                  <div className="flex-1 h-2 bg-white/[0.05] rounded-full overflow-hidden">
                    <div className="h-full rounded-full" style={{ width: `${pct}%`, backgroundColor: color + 'd9' }} />
                  </div>
                  <div className="text-[10.5px] font-mono text-white/55 w-9 shrink-0 text-right">{pct}%</div>
                  <div className="text-[11px] font-mono text-white/75 w-14 text-right shrink-0">
                    {loading ? '...' : (fmtUsd(value, suiUsd) ?? `${fmt(value)} SUI`)}
                  </div>
                </div>
              ))}
            </div>
            <div className="text-[10px] font-mono text-white/32 mt-4 leading-relaxed">
              Creators keep earning 0.40% forever. LP deepens the curve until graduation. With a
              referral, protocol and airdrop each cede 0.05% to fund a 0.10% referrer reward; the
              trader always pays 1.00%. Graduation adds a 1% reserve fee: 0.5% creator bonus, 0.5% protocol.
            </div>
            {/* Mainnet projection (C-5 corrected) */}
            <div className="rounded-xl border border-lime-400/20 bg-lime-400/[0.05] p-3.5 mt-4 flex items-center gap-4">
              <div className="flex-1">
                <div className="text-[9px] font-mono font-semibold text-lime-400 tracking-[0.14em] mb-1.5">MAINNET PROJECTION</div>
                <div className="text-[10.5px] font-mono text-white/45 leading-relaxed">
                  $50M monthly volume {'->'} $500k total fees {'->'} $125k S1 airdrop pool (0.25% of volume).
                </div>
              </div>
              <div className="text-right shrink-0">
                <div className="text-[22px] leading-none font-extrabold font-mono text-lime-400">$50M</div>
                <div className="text-[9px] font-mono text-white/35 mt-1.5">target / month</div>
              </div>
            </div>
          </div>

          {/* Top tokens by volume */}
          <div className="rounded-2xl border border-white/[0.08] bg-white/[0.015] overflow-hidden">
            <div className="px-[18px] py-[15px] border-b border-white/[0.06] flex items-center justify-between">
              <div className="text-[10px] font-mono font-bold text-white/50 tracking-[0.16em]">TOP TOKENS BY VOLUME</div>
              <div className="text-[9.5px] font-mono text-white/30">{data.topTokens.length} with trades</div>
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
                    className="w-full flex items-center gap-3 px-[18px] py-3 border-b border-white/[0.04] last:border-0 hover:bg-white/[0.02] transition-colors group text-left"
                  >
                    <div className="text-[10px] font-mono text-white/30 w-3.5 shrink-0 text-right">{i + 1}</div>
                    <div className="w-[110px] shrink-0">
                      <div className="text-[11px] font-mono font-semibold text-white/80 group-hover:text-lime-400 transition-colors truncate">{token.name}</div>
                      <div className="text-[9px] font-mono text-white/30 mt-1">${token.symbol}</div>
                    </div>
                    <MiniBar value={token.volume} max={maxTopVol} />
                    <div className="text-[11px] font-mono font-bold text-white shrink-0 w-16 text-right">
                      {fmtUsd(token.volume, suiUsd) ?? `${fmt(token.volume)} SUI`}
                    </div>
                    <div className="text-[9.5px] font-mono text-white/30 shrink-0 w-[70px] text-right">
                      {fmt(token.volume, 1)} SUI
                    </div>
                  </button>
                ))}
              </div>
            )}
            <div className="px-[18px] py-3 text-[9px] font-mono text-white/25 leading-relaxed">
              TESTNET DATA - RESETS AT MAINNET - REFRESHES EVERY 30s
            </div>
          </div>
        </div>

      </div>
    </div>
  );
}
