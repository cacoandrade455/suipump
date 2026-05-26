// StatsPage.jsx
import React, { useState, useEffect } from 'react';
import { useCurrentClient } from '@mysten/dapp-kit-react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, TrendingUp, Flame, Gift, Coins, Trophy, Zap, BarChart3 } from 'lucide-react';
import { PACKAGE_ID, ALL_PACKAGE_IDS, DRAIN_SUI_APPROX } from './constants.js';
import { useTokenList } from './useTokenList.js';
import { paginateMultipleEvents } from './paginateEvents.js';

const INDEXER_URL = import.meta.env.VITE_INDEXER_URL || '';
const MIST_PER_SUI = 1e9;

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
  if (usd >= 1e6) return `$${(usd / 1e6).toFixed(d)}M`;
  if (usd >= 1e3) return `$${(usd / 1e3).toFixed(d)}k`;
  return `$${usd.toFixed(d)}`;
}

function StatCard({ icon, label, valueSui, valueUsd, accent = false, sub }) {
  return (
    <div className={`rounded-2xl border p-5 flex flex-col gap-1 ${accent ? 'border-lime-400/30 bg-lime-950/10' : 'border-white/10 bg-white/[0.03]'}`}>
      <div className={`flex items-center gap-2 text-[10px] font-mono tracking-widest mb-1 ${accent ? 'text-lime-400' : 'text-white/30'}`}>
        {icon} {label}
      </div>
      {valueUsd ? (
        <><div className={`text-2xl font-bold font-mono ${accent ? 'text-lime-400' : 'text-white'}`}>{valueUsd}</div>
        <div className="text-xs font-mono text-white/30">{valueSui}</div></>
      ) : (
        <div className={`text-2xl font-bold font-mono ${accent ? 'text-lime-400' : 'text-white'}`}>{valueSui}</div>
      )}
      {sub && <div className="text-[10px] font-mono text-white/35 mt-0.5">{sub}</div>}
    </div>
  );
}

export default function StatsPage({ onBack }) {
  const client = useCurrentClient();
  const navigate = useNavigate();
  const { tokens } = useTokenList();
  const [suiUsd, setSuiUsd] = useState(0);
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState({ volume: null, protocolFees: null, tradeCount: null, buyCount: null, sellCount: null, tokenCount: null, topTokens: [] });

  useEffect(() => {
    fetchSuiUsd().then(setSuiUsd);
    const timer = setInterval(() => fetchSuiUsd().then(setSuiUsd), 30_000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (INDEXER_URL) {
        try {
          const res = await fetch(`${INDEXER_URL}/stats`, { signal: AbortSignal.timeout(5000) });
          if (res.ok) {
            const d = await res.json();
            if (!cancelled) {
              setData({ volume: d.totalVolume, protocolFees: d.protocolFeesSui, tradeCount: d.totalTrades, buyCount: d.totalBuys ?? null, sellCount: d.totalSells ?? null, tokenCount: d.tokenCount ?? null, topTokens: [] });
              setLoading(false);
              return;
            }
          }
        } catch {}
      }
      // RPC fallback
      try {
        const buyTypes  = ALL_PACKAGE_IDS.map(p => `${p}::bonding_curve::TokensPurchased`);
        const sellTypes = ALL_PACKAGE_IDS.map(p => `${p}::bonding_curve::TokensSold`);
        const eventMap  = await paginateMultipleEvents(client, [...buyTypes, ...sellTypes], { order: 'descending', maxPages: 50 });
        const allBuys  = buyTypes.flatMap(t => eventMap[t] ?? []);
        const allSells = sellTypes.flatMap(t => eventMap[t] ?? []);
        let volume = 0;
        for (const e of allBuys)  volume += Number(e.parsedJson?.sui_in  ?? 0) / MIST_PER_SUI;
        for (const e of allSells) volume += Number(e.parsedJson?.sui_out ?? 0) / MIST_PER_SUI;
        if (!cancelled) {
          setData({ volume, protocolFees: volume * 0.005, tradeCount: allBuys.length + allSells.length, buyCount: allBuys.length, sellCount: allSells.length, tokenCount: tokens.length, topTokens: [] });
          setLoading(false);
        }
      } catch { if (!cancelled) setLoading(false); }
    }
    load();
    return () => { cancelled = true; };
  }, [client, tokens.length]);

  return (
    <div className="min-h-screen" style={{ fontFamily: "'JetBrains Mono', ui-monospace, monospace" }}>
      <button onClick={onBack || (() => navigate('/'))} className="flex items-center gap-2 text-white/50 hover:text-lime-400 transition-colors text-xs font-mono mb-6 group">
        <ArrowLeft size={14} className="group-hover:-translate-x-0.5 transition-transform" />Back
      </button>
      <div className="flex items-center gap-3 mb-6">
        <BarChart3 size={20} className="text-lime-400" />
        <h1 className="text-xl font-bold text-white font-mono">Protocol Stats</h1>
      </div>
      {loading ? (
        <div className="text-center text-white/20 text-xs font-mono py-12">Loading…</div>
      ) : (
        <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
          <StatCard icon={<TrendingUp size={10} />} label="TOTAL VOLUME" valueSui={`${fmt(data.volume)} SUI`} valueUsd={fmtUsd(data.volume, suiUsd)} accent />
          <StatCard icon={<Coins size={10} />} label="PROTOCOL FEES" valueSui={`${fmt(data.protocolFees)} SUI`} valueUsd={fmtUsd(data.protocolFees, suiUsd)} />
          <StatCard icon={<Zap size={10} />} label="TOTAL TRADES" valueSui={fmt(data.tradeCount, 0)} sub={data.buyCount != null ? `${fmt(data.buyCount, 0)} buys · ${fmt(data.sellCount, 0)} sells` : undefined} />
          {data.tokenCount != null && <StatCard icon={<Flame size={10} />} label="TOKENS LAUNCHED" valueSui={fmt(data.tokenCount, 0)} />}
        </div>
      )}
    </div>
  );
}
