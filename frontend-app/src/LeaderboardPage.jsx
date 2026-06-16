// LeaderboardPage.jsx
import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useCurrentAccount } from '@mysten/dapp-kit-react';
import { ArrowLeft, TrendingUp, Trophy, Zap } from 'lucide-react';
import { ALL_PACKAGE_IDS } from './constants.js';
import { useTokenList } from './useTokenList.js';
import { paginateMultipleEvents } from './paginateEvents.js';
import { t } from './i18n.js';

const INDEXER_URL = import.meta.env.VITE_INDEXER_URL || '';
const MIST_PER_SUI = 1e9;

function fmt(n, d = 2) {
  if (n == null) return '—';
  if (!Number.isFinite(n)) return '—';
  if (n >= 1e6) return (n / 1e6).toFixed(d) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(d) + 'k';
  return n.toFixed(d);
}

// Signed PnL: keeps the +/- and the magnitude readable at k/M scale.
function fmtPnl(n, d = 2) {
  if (n == null || !Number.isFinite(n)) return '—';
  const sign = n >= 0 ? '+' : '−';
  const a = Math.abs(n);
  const mag = a >= 1e6 ? (a / 1e6).toFixed(d) + 'M' : a >= 1e3 ? (a / 1e3).toFixed(d) + 'k' : a.toFixed(d);
  return `${sign}${mag}`;
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
  const navigate = useNavigate();
  const account  = useCurrentAccount();
  const myAddr   = account?.address ?? null;
  const { tokens } = useTokenList();
  const [tokenVolumes, setTokenVolumes] = useState([]);
  const [topTraders, setTopTraders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState('tokens');
  const [traderSort, setTraderSort] = useState('volume'); // 'volume' | 'pnl'

  useEffect(() => {
    let cancelled = false;

    async function loadFromIndexer() {
      const [tokRes, trdRes] = await Promise.all([
        fetch(`${INDEXER_URL}/leaderboard/volume?limit=100`,  { signal: AbortSignal.timeout(5000) }),
        fetch(`${INDEXER_URL}/leaderboard/traders?limit=20`,  { signal: AbortSignal.timeout(5000) }),
      ]);
      if (!tokRes.ok || !trdRes.ok) throw new Error('indexer not ok');
      const tokRows = await tokRes.json();
      const trdRows = await trdRes.json();
      return {
        sortedTokens:  tokRows.map(r => ({ curveId: r.curve_id, volume: Number(r.volume_sui ?? 0), trades: Number(r.trades ?? 0) })),
        // /leaderboard/traders returns { address, sui_spent, sui_received, buys, sells }
        // — NOT wallet/volume_sui/trades. Mapping the wrong keys is why every row
        // read 0.00 SUI / 0 trades. Volume = spent + received; trades = buys + sells.
        sortedTraders: trdRows.map(r => ({
          addr:   r.address,
          volume: Number(r.sui_spent ?? 0) + Number(r.sui_received ?? 0),
          trades: Number(r.buys ?? 0) + Number(r.sells ?? 0),
          pnl:    Number(r.realized_pnl ?? 0),
        })),
      };
    }

    async function loadFromRpc() {
      const buyTypes  = ALL_PACKAGE_IDS.map(p => `${p}::bonding_curve::TokensPurchased`);
      const sellTypes = ALL_PACKAGE_IDS.map(p => `${p}::bonding_curve::TokensSold`);
      const eventMap = {}; // RPC fallback removed (CORS blocked)
      const buysData  = buyTypes.flatMap(t => eventMap[t] ?? []);
      const sellsData = sellTypes.flatMap(t => eventMap[t] ?? []);
      const volumeByCurve = {}, tradesByCurve = {}, volumeByTrader = {}, tradesByTrader = {};
      for (const e of buysData) {
        const j = e.parsedJson || {};
        const sui = Number(j.sui_in ?? 0) / MIST_PER_SUI;
        if (j.curve_id) { volumeByCurve[j.curve_id] = (volumeByCurve[j.curve_id] || 0) + sui; tradesByCurve[j.curve_id] = (tradesByCurve[j.curve_id] || 0) + 1; }
        if (j.buyer)    { volumeByTrader[j.buyer] = (volumeByTrader[j.buyer] || 0) + sui; tradesByTrader[j.buyer] = (tradesByTrader[j.buyer] || 0) + 1; }
      }
      for (const e of sellsData) {
        const j = e.parsedJson || {};
        const sui = Number(j.sui_out ?? 0) / MIST_PER_SUI;
        if (j.curve_id) { volumeByCurve[j.curve_id] = (volumeByCurve[j.curve_id] || 0) + sui; tradesByCurve[j.curve_id] = (tradesByCurve[j.curve_id] || 0) + 1; }
        if (j.seller)   { volumeByTrader[j.seller] = (volumeByTrader[j.seller] || 0) + sui; tradesByTrader[j.seller] = (tradesByTrader[j.seller] || 0) + 1; }
      }
      return {
        sortedTokens:  Object.entries(volumeByCurve).map(([curveId, volume]) => ({ curveId, volume, trades: tradesByCurve[curveId] || 0 })).sort((a, b) => b.volume - a.volume),
        sortedTraders: Object.entries(volumeByTrader).map(([addr, volume]) => ({ addr, volume, trades: tradesByTrader[addr] || 0, pnl: null })).sort((a, b) => b.volume - a.volume).slice(0, 20),
      };
    }

    async function load() {
      try {
        let data;
        if (INDEXER_URL) { try { data = await loadFromIndexer(); } catch { data = await loadFromRpc(); } }
        else { data = await loadFromRpc(); }
        if (!cancelled) { setTokenVolumes(data.sortedTokens); setTopTraders(data.sortedTraders); setLoading(false); }
      } catch { if (!cancelled) setLoading(false); }
    }
    load();
    return () => { cancelled = true; };
  }, []);

  const enrichedTokens = tokenVolumes.map(tv => {
    const meta = tokens.find(tk => tk.curveId === tv.curveId);
    return { ...tv, name: meta?.name || 'Unknown', symbol: meta?.symbol || '???', iconUrl: meta?.iconUrl || null };
  });

  return (
    <div className="min-h-screen" style={{ fontFamily: "'JetBrains Mono', ui-monospace, monospace" }}>
      <button onClick={onBack || (() => navigate('/'))} className="flex items-center gap-2 text-white/50 hover:text-lime-400 transition-colors text-xs font-mono mb-6 group">
        <ArrowLeft size={14} className="group-hover:-translate-x-0.5 transition-transform" />
        {t(lang, 'backToHome')}
      </button>
      <div className="flex items-center gap-3 mb-6">
        <Trophy size={20} className="text-lime-400" />
        <h1 className="text-xl font-bold text-white font-mono">{t(lang, 'leaderboard')}</h1>
      </div>
      <div className="flex gap-2 mb-6">
        {['tokens', 'traders'].map(tabId => (
          <button key={tabId} onClick={() => setTab(tabId)}
            className={`px-4 py-2 rounded-xl text-xs font-mono font-bold transition-colors ${tab === tabId ? 'bg-lime-400 text-black' : 'bg-white/5 text-white/40 hover:text-white/70'}`}>
            {tabId === 'tokens' ? 'TOP TOKENS' : 'TOP TRADERS'}
          </button>
        ))}
      </div>
      {loading ? (
        <div className="text-center text-white/20 text-xs font-mono py-12">Loading…</div>
      ) : tab === 'tokens' ? (
        <div className="space-y-2">
          {enrichedTokens.slice(0, 50).map((tk, i) => (
            <button key={tk.curveId} onClick={() => navigate(`/token/${tk.curveId}`)}
              className="w-full flex items-center gap-3 bg-white/[0.03] border border-white/10 rounded-xl px-4 py-3 hover:border-lime-400/30 transition-colors text-left">
              <RankBadge rank={i + 1} />
              <div className="w-8 h-8 rounded-full bg-white/5 flex items-center justify-center shrink-0 overflow-hidden">
                {tk.iconUrl ? <img src={tk.iconUrl} alt={tk.symbol} className="w-full h-full object-cover" /> : <span className="text-base">🔥</span>}
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-xs font-mono font-bold text-white truncate">{tk.name}</div>
                <div className="text-[10px] font-mono text-lime-400/70">${tk.symbol}</div>
              </div>
              <div className="text-right">
                <div className="text-xs font-mono font-bold text-white">{fmt(tk.volume)} SUI</div>
                <div className="text-[10px] font-mono text-white/30">{tk.trades} trades</div>
              </div>
            </button>
          ))}
        </div>
      ) : (
        <div className="space-y-2">
          <div className="flex items-center justify-between mb-1">
            <div className="text-[10px] font-mono text-white/30 tracking-widest">SORT BY</div>
            <div className="flex gap-1.5">
              {[
                { id: 'volume', label: 'VOLUME' },
                { id: 'pnl',    label: 'REALIZED PNL' },
              ].map(s => (
                <button key={s.id} onClick={() => setTraderSort(s.id)}
                  className={`px-2.5 py-1 rounded-lg text-[9px] font-mono font-bold transition-colors ${traderSort === s.id ? 'bg-lime-400/10 text-lime-400 border border-lime-400/30' : 'text-white/30 hover:text-white/60 border border-transparent'}`}>
                  {s.label}
                </button>
              ))}
            </div>
          </div>
          {traderSort === 'pnl' && (
            <div className="text-[9px] font-mono text-white/20 pb-1">Realized PnL only — proceeds minus average cost of tokens sold. Unsold holdings excluded.</div>
          )}
          {[...topTraders]
            .sort((a, b) => traderSort === 'pnl'
              ? (Number(b.pnl ?? -Infinity) - Number(a.pnl ?? -Infinity))
              : (b.volume - a.volume))
            .map((tr, i) => (
            <button key={tr.addr} onClick={() => navigate(`/portfolio/${tr.addr}`)}
              className="w-full flex items-center gap-3 bg-white/[0.03] border border-white/10 rounded-xl px-4 py-3 hover:border-lime-400/30 transition-colors text-left">
              <RankBadge rank={i + 1} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5">
                  <div className="text-xs font-mono text-white/70">{shortAddr(tr.addr)}</div>
                  {myAddr && tr.addr === myAddr && <span className="text-[8px] font-mono text-violet-400 border border-violet-400/40 px-1 rounded">YOU</span>}
                </div>
              </div>
              <div className="text-right">
                {traderSort === 'pnl' ? (
                  <>
                    <div className={`text-xs font-mono font-bold ${tr.pnl == null ? 'text-white/40' : tr.pnl >= 0 ? 'text-lime-400' : 'text-red-400'}`}>
                      {tr.pnl == null ? '—' : `${fmtPnl(tr.pnl)} SUI`}
                    </div>
                    <div className="text-[10px] font-mono text-white/30">{fmt(tr.volume)} SUI vol</div>
                  </>
                ) : (
                  <>
                    <div className="text-xs font-mono font-bold text-white">{fmt(tr.volume)} SUI</div>
                    <div className="text-[10px] font-mono text-white/30">{tr.trades} trades</div>
                  </>
                )}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
