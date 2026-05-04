// LeaderboardPage.jsx
// Ranks all SuiPump tokens by trading volume, computed from on-chain events.
// Also shows top traders by total SUI spent.

import React, { useState, useEffect } from 'react';
import { useSuiClient } from '@mysten/dapp-kit';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, TrendingUp, Trophy, Zap } from 'lucide-react';
import { PACKAGE_ID } from './constants.js';
import { useTokenList } from './useTokenList.js';

const MIST_PER_SUI = 1e9;

function fmt(n, d = 2) {
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

export default function LeaderboardPage({ onBack }) {
  const client = useSuiClient();
  const navigate = useNavigate();
  const { tokens } = useTokenList();

  const [tokenVolumes, setTokenVolumes] = useState([]);
  const [topTraders, setTopTraders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState('tokens'); // 'tokens' | 'traders'

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const [buys, sells] = await Promise.all([
          client.queryEvents({
            query: { MoveEventType: `${PACKAGE_ID}::bonding_curve::TokensPurchased` },
            limit: 100,
            order: 'descending',
          }),
          client.queryEvents({
            query: { MoveEventType: `${PACKAGE_ID}::bonding_curve::TokensSold` },
            limit: 100,
            order: 'descending',
          }),
        ]);

        if (cancelled) return;

        // Aggregate volume by curve
        const volumeByCurve = {};
        const tradesByCurve = {};
        for (const e of buys.data) {
          const id = e.parsedJson?.curve_id;
          if (!id) continue;
          volumeByCurve[id] = (volumeByCurve[id] || 0) + Number(e.parsedJson.sui_in) / MIST_PER_SUI;
          tradesByCurve[id] = (tradesByCurve[id] || 0) + 1;
        }
        for (const e of sells.data) {
          const id = e.parsedJson?.curve_id;
          if (!id) continue;
          volumeByCurve[id] = (volumeByCurve[id] || 0) + Number(e.parsedJson.sui_out) / MIST_PER_SUI;
          tradesByCurve[id] = (tradesByCurve[id] || 0) + 1;
        }

        // Aggregate volume by trader
        const volumeByTrader = {};
        const tradesByTrader = {};
        for (const e of buys.data) {
          const addr = e.parsedJson?.buyer;
          if (!addr) continue;
          volumeByTrader[addr] = (volumeByTrader[addr] || 0) + Number(e.parsedJson.sui_in) / MIST_PER_SUI;
          tradesByTrader[addr] = (tradesByTrader[addr] || 0) + 1;
        }
        for (const e of sells.data) {
          const addr = e.parsedJson?.seller;
          if (!addr) continue;
          volumeByTrader[addr] = (volumeByTrader[addr] || 0) + Number(e.parsedJson.sui_out) / MIST_PER_SUI;
          tradesByTrader[addr] = (tradesByTrader[addr] || 0) + 1;
        }

        // Build sorted token list
        const sortedTokens = Object.entries(volumeByCurve)
          .map(([curveId, volume]) => ({
            curveId,
            volume,
            trades: tradesByCurve[curveId] || 0,
          }))
          .sort((a, b) => b.volume - a.volume);

        // Build sorted trader list
        const sortedTraders = Object.entries(volumeByTrader)
          .map(([addr, volume]) => ({
            addr,
            volume,
            trades: tradesByTrader[addr] || 0,
          }))
          .sort((a, b) => b.volume - a.volume)
          .slice(0, 20);

        if (!cancelled) {
          setTokenVolumes(sortedTokens);
          setTopTraders(sortedTraders);
          setLoading(false);
        }
      } catch {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => { cancelled = true; };
  }, [client]);

  // Merge token metadata from useTokenList
  const enrichedTokens = tokenVolumes.map(tv => {
    const meta = tokens.find(t => t.curveId === tv.curveId);
    return { ...tv, name: meta?.name || 'Unknown', symbol: meta?.symbol || '???', tokenType: meta?.tokenType };
  });

  // Max volume for progress bars
  const maxVolume = enrichedTokens[0]?.volume || 1;
  const maxTraderVolume = topTraders[0]?.volume || 1;

  return (
    <div>
      <button
        onClick={onBack}
        className="flex items-center gap-2 text-xs font-mono text-white/40 hover:text-white mb-6 transition-colors"
      >
        <ArrowLeft size={12} /> BACK TO HOME
      </button>

      <div className="max-w-2xl mx-auto">

        {/* Header */}
        <div className="rounded-3xl border border-white/10 bg-gradient-to-br from-lime-950/20 via-black to-black p-6 mb-6 relative overflow-hidden">
          <div className="absolute top-0 left-1/2 -translate-x-1/2 w-64 h-16 bg-lime-400/10 blur-3xl rounded-full pointer-events-none" />
          <div className="relative flex items-center gap-3 mb-1">
            <Trophy className="text-lime-400" size={20} />
            <h1 className="text-xl font-bold text-white" style={{ fontFamily: "'Space Grotesk', sans-serif" }}>
              LEADERBOARD
            </h1>
          </div>
          <p className="text-xs font-mono text-white/30">Ranked by total trading volume on SuiPump testnet.</p>
        </div>

        {/* Tabs */}
        <div className="flex gap-2 mb-4">
          <button
            onClick={() => setTab('tokens')}
            className={`flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-mono transition-all ${
              tab === 'tokens' ? 'bg-lime-400 text-black font-bold' : 'bg-white/5 text-white/40 hover:bg-white/10'
            }`}
          >
            <TrendingUp size={12} /> TOP TOKENS
          </button>
          <button
            onClick={() => setTab('traders')}
            className={`flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-mono transition-all ${
              tab === 'traders' ? 'bg-lime-400 text-black font-bold' : 'bg-white/5 text-white/40 hover:bg-white/10'
            }`}
          >
            <Zap size={12} /> TOP TRADERS
          </button>
        </div>

        {/* Content */}
        <div className="rounded-2xl border border-white/10 bg-white/[0.03] overflow-hidden">

          {/* Column headers */}
          <div className="grid grid-cols-12 text-[9px] font-mono text-white/20 tracking-widest px-5 py-3 border-b border-white/5">
            <span className="col-span-1">#</span>
            <span className="col-span-5">{tab === 'tokens' ? 'TOKEN' : 'WALLET'}</span>
            <span className="col-span-3 text-right">VOLUME</span>
            <span className="col-span-3 text-right">TRADES</span>
          </div>

          {loading && (
            <div className="space-y-px">
              {[...Array(6)].map((_, i) => (
                <div key={i} className="grid grid-cols-12 items-center px-5 py-4 gap-2 animate-pulse">
                  <div className="col-span-1 h-4 w-4 bg-white/5 rounded" />
                  <div className="col-span-5 h-3 bg-white/5 rounded w-24" />
                  <div className="col-span-3 h-3 bg-white/5 rounded ml-auto w-16" />
                  <div className="col-span-3 h-3 bg-white/5 rounded ml-auto w-12" />
                </div>
              ))}
            </div>
          )}

          {/* Token leaderboard */}
          {!loading && tab === 'tokens' && (
            <div>
              {enrichedTokens.length === 0 && (
                <div className="text-xs font-mono text-white/20 text-center py-10">
                  No trades yet.
                </div>
              )}
              {enrichedTokens.map((token, i) => (
                <button
                  key={token.curveId}
                  onClick={() => token.tokenType && navigate(`/token/${token.curveId}`)}
                  className="w-full grid grid-cols-12 items-center px-5 py-4 border-b border-white/[0.03] last:border-0 hover:bg-white/5 transition-colors group text-left"
                >
                  <div className="col-span-1 flex items-center">
                    <RankBadge rank={i + 1} />
                  </div>
                  <div className="col-span-5">
                    <div className="text-xs font-mono font-bold text-white group-hover:text-lime-400 transition-colors">
                      {token.name}
                    </div>
                    <div className="text-[10px] font-mono text-white/30">${token.symbol}</div>
                    {/* Volume bar */}
                    <div className="mt-1.5 h-1 bg-white/5 rounded-full overflow-hidden w-24">
                      <div
                        className="h-full bg-gradient-to-r from-lime-600 to-lime-400 rounded-full"
                        style={{ width: `${(token.volume / maxVolume) * 100}%` }}
                      />
                    </div>
                  </div>
                  <div className="col-span-3 text-right">
                    <div className="text-xs font-mono font-bold text-white">{fmt(token.volume, 2)} SUI</div>
                  </div>
                  <div className="col-span-3 text-right">
                    <div className="text-xs font-mono text-white/50">{token.trades}</div>
                  </div>
                </button>
              ))}
            </div>
          )}

          {/* Trader leaderboard */}
          {!loading && tab === 'traders' && (
            <div>
              {topTraders.length === 0 && (
                <div className="text-xs font-mono text-white/20 text-center py-10">
                  No trades yet.
                </div>
              )}
              {topTraders.map((trader, i) => (
                <a
                  key={trader.addr}
                  href={`https://testnet.suivision.xyz/account/${trader.addr}`}
                  target="_blank"
                  rel="noreferrer"
                  className="w-full grid grid-cols-12 items-center px-5 py-4 border-b border-white/[0.03] last:border-0 hover:bg-white/5 transition-colors group"
                >
                  <div className="col-span-1 flex items-center">
                    <RankBadge rank={i + 1} />
                  </div>
                  <div className="col-span-5">
                    <div className="text-xs font-mono font-bold text-white group-hover:text-lime-400 transition-colors">
                      {shortAddr(trader.addr)}
                    </div>
                    {/* Volume bar */}
                    <div className="mt-1.5 h-1 bg-white/5 rounded-full overflow-hidden w-24">
                      <div
                        className="h-full bg-gradient-to-r from-lime-600 to-lime-400 rounded-full"
                        style={{ width: `${(trader.volume / maxTraderVolume) * 100}%` }}
                      />
                    </div>
                  </div>
                  <div className="col-span-3 text-right">
                    <div className="text-xs font-mono font-bold text-white">{fmt(trader.volume, 2)} SUI</div>
                  </div>
                  <div className="col-span-3 text-right">
                    <div className="text-xs font-mono text-white/50">{trader.trades}</div>
                  </div>
                </a>
              ))}
            </div>
          )}
        </div>

        <div className="mt-4 text-[9px] font-mono text-white/15 text-center">
          TESTNET DATA ONLY · RESETS AT MAINNET LAUNCH
        </div>
      </div>
    </div>
  );
}
