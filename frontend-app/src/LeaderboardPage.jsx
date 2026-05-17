// LeaderboardPage.jsx
import React, { useState, useEffect } from 'react';
import { useSuiClient } from '@mysten/dapp-kit';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, TrendingUp, Trophy, Zap } from 'lucide-react';
import { ALL_PACKAGE_IDS } from './constants.js';
import { useTokenList } from './useTokenList.js';
import { paginateMultipleEvents } from './paginateEvents.js';

const INDEXER_URL = import.meta.env.VITE_INDEXER_URL || '';
import { t } from './i18n.js';

const MIST_PER_SUI = 1e9;

function fmt(n, d = 2) {
  if (n == null) return '—';
  if (!Number.isFinite(n)) return '—';
  if (n >= 1e6) return (n / 1e6).toFixed(d) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(d) + 'k';
  return n.toFixed(d);
}

function shortAddr(addr) {
  if (!addr) return '—';
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function RankBadge({ rank }) {
  if (rank === 1) return <span className="text-yellow-400 text-sm">🥇</span>;
  if (rank === 2) return <span className="text-white/50 text-sm">🥈</span>;
  if (rank === 3) return <span className="text-amber-600 text-sm">🥉</span>;
  return <span className="text-white/20 font-mono text-xs w-5 text-center">{rank}</span>;
}

export default function LeaderboardPage({ onBack, lang = 'en' }) {
  const client = useSuiClient();
  const navigate = useNavigate();
  const { tokens } = useTokenList();

  const [tokenVolumes, setTokenVolumes] = useState([]);
  const [topTraders, setTopTraders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState('tokens');

  useEffect(() => {
    let cancelled = false;

    // Indexer path — pre-aggregated, fast, all packages.
    async function loadFromIndexer() {
      const [tokRes, trdRes] = await Promise.all([
        fetch(`${INDEXER_URL}/leaderboard/volume?limit=100`,  { signal: AbortSignal.timeout(5000) }),
        fetch(`${INDEXER_URL}/leaderboard/traders?limit=20`, { signal: AbortSignal.timeout(5000) }),
      ]);
      if (!tokRes.ok || !trdRes.ok) throw new Error('indexer not ok');

      const tokRows = await tokRes.json();
      const trdRows = await trdRes.json();

      const sortedTokens = tokRows.map(r => ({
        curveId: r.curve_id,
        volume:  Number(r.volume_sui ?? 0),
        trades:  Number(r.trades ?? 0),
      }));
      const sortedTraders = trdRows.map(r => ({
        addr:   r.wallet,
        volume: Number(r.volume_sui ?? 0),
        trades: Number(r.trades ?? 0),
      }));
      return { sortedTokens, sortedTraders };
    }

    // RPC fallback — query all package versions (v4/v5/v6).
    async function loadFromRpc() {
      const buyTypes  = ALL_PACKAGE_IDS.map(p => `${p}::bonding_curve::TokensPurchased`);
      const sellTypes = ALL_PACKAGE_IDS.map(p => `${p}::bonding_curve::TokensSold`);
      const eventMap = await paginateMultipleEvents(
        client, [...buyTypes, ...sellTypes], { order: 'descending', maxPages: 20 }
      );

      const buysData  = buyTypes.flatMap(bt  => eventMap[bt]  || []);
      const sellsData = sellTypes.flatMap(st => eventMap[st] || []);

      const volumeByCurve = {}, tradesByCurve = {};
      const volumeByTrader = {}, tradesByTrader = {};

      for (const e of buysData) {
        const j = e.parsedJson || {};
        const sui = Number(j.sui_in ?? 0) / MIST_PER_SUI;
        if (j.curve_id) {
          volumeByCurve[j.curve_id] = (volumeByCurve[j.curve_id] || 0) + sui;
          tradesByCurve[j.curve_id] = (tradesByCurve[j.curve_id] || 0) + 1;
        }
        if (j.buyer) {
          volumeByTrader[j.buyer] = (volumeByTrader[j.buyer] || 0) + sui;
          tradesByTrader[j.buyer] = (tradesByTrader[j.buyer] || 0) + 1;
        }
      }
      for (const e of sellsData) {
        const j = e.parsedJson || {};
        const sui = Number(j.sui_out ?? 0) / MIST_PER_SUI;
        if (j.curve_id) {
          volumeByCurve[j.curve_id] = (volumeByCurve[j.curve_id] || 0) + sui;
          tradesByCurve[j.curve_id] = (tradesByCurve[j.curve_id] || 0) + 1;
        }
        if (j.seller) {
          volumeByTrader[j.seller] = (volumeByTrader[j.seller] || 0) + sui;
          tradesByTrader[j.seller] = (tradesByTrader[j.seller] || 0) + 1;
        }
      }

      const sortedTokens = Object.entries(volumeByCurve)
        .map(([curveId, volume]) => ({ curveId, volume, trades: tradesByCurve[curveId] || 0 }))
        .sort((a, b) => b.volume - a.volume);
      const sortedTraders = Object.entries(volumeByTrader)
        .map(([addr, volume]) => ({ addr, volume, trades: tradesByTrader[addr] || 0 }))
        .sort((a, b) => b.volume - a.volume)
        .slice(0, 20);

      return { sortedTokens, sortedTraders };
    }

    async function load() {
      try {
        let data;
        if (INDEXER_URL) {
          try { data = await loadFromIndexer(); }
          catch { data = await loadFromRpc(); }
        } else {
          data = await loadFromRpc();
        }
        if (!cancelled) {
          setTokenVolumes(data.sortedTokens);
          setTopTraders(data.sortedTraders);
          setLoading(false);
        }
      } catch {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => { cancelled = true; };
  }, [client]);

  const enrichedTokens = tokenVolumes.map(tv => {
    const meta = tokens.find(tk => tk.curveId === tv.curveId);
    return { ...tv, name: meta?.name || 'Unknown', symbol: meta?.symbol || '???', tokenType: meta?.tokenType };
  });

  const maxVolume = enrichedTokens[0]?.volume || 1;
  const maxTraderVolume = topTraders[0]?.volume || 1;

  return (
    <div>
      <button
        onClick={onBack}
        className="flex items-center gap-2 text-xs font-mono text-white/40 hover:text-white mb-6 transition-colors"
      >
        <ArrowLeft size={12} /> {t(lang, 'backToHome')}
      </button>

      <div className="max-w-2xl mx-auto">
        <div className="rounded-3xl border border-white/10 bg-gradient-to-br from-lime-950/20 via-black to-black p-6 mb-6 relative overflow-hidden">
          <div className="absolute top-0 left-1/2 -translate-x-1/2 w-64 h-16 bg-lime-400/10 blur-3xl rounded-full pointer-events-none" />
          <div className="relative flex items-center gap-3 mb-1">
            <Trophy className="text-lime-400" size={20} />
            <h1 className="text-xl font-bold text-white" style={{ fontFamily: "'Space Grotesk', sans-serif" }}>
              {t(lang, 'leaderboardTitle')}
            </h1>
          </div>
          <p className="text-xs font-mono text-white/30">{t(lang, 'leaderboardSub')}</p>
        </div>

        <div className="flex gap-2 mb-4">
          <button
            onClick={() => setTab('tokens')}
            className={`flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-mono transition-all ${
              tab === 'tokens' ? 'bg-lime-400 text-black font-bold' : 'bg-white/5 text-white/40 hover:bg-white/10'
            }`}
          >
            <TrendingUp size={12} /> {t(lang, 'topTokens')}
          </button>
          <button
            onClick={() => setTab('traders')}
            className={`flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-mono transition-all ${
              tab === 'traders' ? 'bg-lime-400 text-black font-bold' : 'bg-white/5 text-white/40 hover:bg-white/10'
            }`}
          >
            <Zap size={12} /> {t(lang, 'topTraders')}
          </button>
        </div>

        <div className="rounded-2xl border border-white/10 bg-white/[0.03] overflow-hidden">
          <div className="grid grid-cols-12 text-[9px] font-mono text-white/20 tracking-widest px-5 py-3 border-b border-white/5">
            <span className="col-span-1">{t(lang, 'rank')}</span>
            <span className="col-span-5">{tab === 'tokens' ? t(lang, 'token') : t(lang, 'trader')}</span>
            <span className="col-span-3 text-right">{t(lang, 'volume')}</span>
            <span className="col-span-3 text-right">{t(lang, 'trades')}</span>
          </div>

          {loading ? (
            <div className="py-12 text-center text-white/30 text-xs font-mono">{t(lang, 'loading')}</div>
          ) : tab === 'tokens' ? (
            enrichedTokens.length === 0 ? (
              <div className="py-12 text-center text-white/20 text-xs font-mono">{t(lang, 'noData')}</div>
            ) : (
              enrichedTokens.map((token, i) => (
                <button
                  key={token.curveId}
                  onClick={() => navigate(`/token/${token.curveId}`)}
                  className="w-full grid grid-cols-12 items-center px-5 py-3.5 border-b border-white/[0.03] last:border-0 hover:bg-white/5 transition-colors text-left"
                >
                  <span className="col-span-1 flex items-center"><RankBadge rank={i + 1} /></span>
                  <div className="col-span-5 min-w-0">
                    <div className="text-xs font-mono font-bold text-white truncate">{token.name}</div>
                    <div className="text-[10px] font-mono text-white/30">${token.symbol}</div>
                    <div className="mt-1 h-1 bg-white/5 rounded-full overflow-hidden w-full max-w-[120px]">
                      <div
                        className="h-full bg-lime-400/60 rounded-full transition-all"
                        style={{ width: `${(token.volume / maxVolume) * 100}%` }}
                      />
                    </div>
                  </div>
                  <span className="col-span-3 text-right text-xs font-mono text-lime-400 font-bold">{fmt(token.volume)} SUI</span>
                  <span className="col-span-3 text-right text-xs font-mono text-white/30">{token.trades}</span>
                </button>
              ))
            )
          ) : (
            topTraders.length === 0 ? (
              <div className="py-12 text-center text-white/20 text-xs font-mono">{t(lang, 'noData')}</div>
            ) : (
              topTraders.map((trader, i) => (
                <div
                  key={trader.addr}
                  className="grid grid-cols-12 items-center px-5 py-3.5 border-b border-white/[0.03] last:border-0"
                >
                  <span className="col-span-1 flex items-center"><RankBadge rank={i + 1} /></span>
                  <div className="col-span-5 min-w-0">
                    <div className="text-xs font-mono text-white">{shortAddr(trader.addr)}</div>
                    <div className="mt-1 h-1 bg-white/5 rounded-full overflow-hidden w-full max-w-[120px]">
                      <div
                        className="h-full bg-lime-400/60 rounded-full"
                        style={{ width: `${(trader.volume / maxTraderVolume) * 100}%` }}
                      />
                    </div>
                  </div>
                  <span className="col-span-3 text-right text-xs font-mono text-lime-400 font-bold">{fmt(trader.volume)} SUI</span>
                  <span className="col-span-3 text-right text-xs font-mono text-white/30">{trader.trades}</span>
                </div>
              ))
            )
          )}
        </div>
      </div>
    </div>
  );
}
