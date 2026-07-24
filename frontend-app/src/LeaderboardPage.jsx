// LeaderboardPage.jsx v2 - Terminal design (2f). Ledger C-1 split: the boards
// (AIRDROP POINTS / TOP TOKENS / TOP TRADERS) live here; the S1 counter, earn
// table, and timeline live on /airdrop. Data logic unchanged from v1; style
// ported from the 2f board card in the design HTML (exact values).
import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useCurrentAccount } from '@mysten/dapp-kit-react';
import { ArrowLeft, Trophy } from 'lucide-react';
import { ALL_PACKAGE_IDS } from './constants.js';
import { useTokenList } from './useTokenList.js';
import { t } from './i18n.js';
import BountyBoard from './BountyBoard.jsx';

const INDEXER_URL = import.meta.env.VITE_INDEXER_URL || '';
const MIST_PER_SUI = 1e9;

function fmt(n, d = 2) {
  if (n == null) return '-';
  if (!Number.isFinite(n)) return '-';
  if (n >= 1e6) return (n / 1e6).toFixed(d) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(d) + 'k';
  return n.toFixed(d);
}

// Signed PnL: keeps the +/- and the magnitude readable at k/M scale.
function fmtPnl(n, d = 2) {
  if (n == null || !Number.isFinite(n)) return '-';
  const sign = n >= 0 ? '+' : '-';
  const a = Math.abs(n);
  const mag = a >= 1e6 ? (a / 1e6).toFixed(d) + 'M' : a >= 1e3 ? (a / 1e3).toFixed(d) + 'k' : a.toFixed(d);
  return `${sign}${mag}`;
}

function shortAddr(addr) {
  if (!addr) return '-';
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

// Terminal rank column: colored number, 22px wide (design row spec).
const RANK_COLORS = { 1: 'text-yellow-400', 2: 'text-white/50', 3: 'text-amber-600' };
function Rank({ rank }) {
  return (
    <span className={`w-[22px] shrink-0 text-center text-xs font-mono font-semibold ${RANK_COLORS[rank] || 'text-white/25'}`}>
      {rank}
    </span>
  );
}

function YouBadge() {
  return (
    <span className="text-[8px] font-mono font-semibold text-violet-400 border border-violet-400/40 px-[5px] py-[2px] rounded shrink-0">
      YOU
    </span>
  );
}

export default function LeaderboardPage({ onBack, lang = 'en' }) {
  const navigate = useNavigate();
  const account  = useCurrentAccount();
  const myAddr   = account?.address ?? null;
  const { tokens } = useTokenList();
  const [tokenVolumes, setTokenVolumes] = useState([]);
  const [topTraders, setTopTraders] = useState([]);
  const [pointsLeaders, setPointsLeaders] = useState([]);
  const [pointsPerSui, setPointsPerSui] = useState(100);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState('points');
  const [traderSort, setTraderSort] = useState('volume'); // 'volume' | 'pnl'

  useEffect(() => {
    let cancelled = false;

    async function loadFromIndexer() {
      const [tokRes, trdRes, ptsRes] = await Promise.all([
        fetch(`${INDEXER_URL}/leaderboard/volume?limit=100`,  { signal: AbortSignal.timeout(5000) }),
        fetch(`${INDEXER_URL}/leaderboard/traders?limit=20`,  { signal: AbortSignal.timeout(5000) }),
        fetch(`${INDEXER_URL}/leaderboard/points?limit=100`,  { signal: AbortSignal.timeout(5000) }),
      ]);
      if (!tokRes.ok || !trdRes.ok) throw new Error('indexer not ok');
      const tokRows = await tokRes.json();
      const trdRows = await trdRes.json();
      // Points endpoint is newer - tolerate it being absent (older indexer) so
      // the rest of the leaderboard still loads. Shape: { pointsPerSui, leaders:[...] }.
      let ptsData = { pointsPerSui: 100, leaders: [] };
      if (ptsRes.ok) { try { ptsData = await ptsRes.json(); } catch {} }
      return {
        sortedTokens:  tokRows.map(r => ({ curveId: r.curve_id, volume: Number(r.volume_sui ?? 0), trades: Number(r.trades ?? 0) })),
        // /leaderboard/traders returns { address, sui_spent, sui_received, buys, sells }
        // - NOT wallet/volume_sui/trades. Mapping the wrong keys is why every row
        // read 0.00 SUI / 0 trades. Volume = spent + received; trades = buys + sells.
        sortedTraders: trdRows.map(r => ({
          addr:   r.address,
          volume: Number(r.sui_spent ?? 0) + Number(r.sui_received ?? 0),
          trades: Number(r.buys ?? 0) + Number(r.sells ?? 0),
          pnl:    Number(r.realized_pnl ?? 0),
        })),
        // /leaderboard/points returns { pointsPerSui, leaders:[{ rank, address,
        // points, buyVolumeSui, buys, distinctTokens }] }.
        pointsPerSui:  Number(ptsData.pointsPerSui ?? 100),
        pointsLeaders: Array.isArray(ptsData.leaders) ? ptsData.leaders.map(r => ({
          addr:           r.address,
          points:         Number(r.points ?? 0),
          buyVolumeSui:   Number(r.buyVolumeSui ?? 0),
          buys:           Number(r.buys ?? 0),
          distinctTokens: Number(r.distinctTokens ?? 0),
        })) : [],
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
        pointsPerSui:  100,
        pointsLeaders: [], // RPC fallback can't compute points (events come from indexer)
      };
    }

    async function load() {
      try {
        let data;
        if (INDEXER_URL) { try { data = await loadFromIndexer(); } catch { data = await loadFromRpc(); } }
        else { data = await loadFromRpc(); }
        if (!cancelled) {
          setTokenVolumes(data.sortedTokens);
          setTopTraders(data.sortedTraders);
          setPointsLeaders(data.pointsLeaders ?? []);
          setPointsPerSui(data.pointsPerSui ?? 100);
          setLoading(false);
        }
      } catch { if (!cancelled) setLoading(false); }
    }
    load();
    return () => { cancelled = true; };
  }, []);

  const enrichedTokens = tokenVolumes.map(tv => {
    const meta = tokens.find(tk => tk.curveId === tv.curveId);
    return { ...tv, name: meta?.name || 'Unknown', symbol: meta?.symbol || '???', iconUrl: meta?.iconUrl || null };
  });

  const rowClass = 'w-full flex items-center gap-3 px-4 py-3 border-b border-white/[0.04] last:border-0 hover:bg-white/[0.02] transition-colors text-left';

  return (
    <div>
      <button
        onClick={onBack || (() => navigate('/'))}
        className="flex items-center gap-2 text-xs font-mono text-white/40 hover:text-lime-400 mb-6 transition-colors group"
      >
        <ArrowLeft size={12} className="group-hover:-translate-x-0.5 transition-transform" />
        {t(lang, 'backToHome')}
      </button>

      <div className="max-w-3xl mx-auto space-y-4">

        {/* Header (Terminal card) */}
        <div className="rounded-2xl border border-white/[0.08] bg-white/[0.015] p-6 relative overflow-hidden">
          <div className="absolute top-0 left-1/2 -translate-x-1/2 w-80 h-24 bg-lime-400/[0.08] blur-3xl rounded-full pointer-events-none" />
          <div className="relative flex items-start justify-between gap-4">
            <div>
              <div className="flex items-center gap-3 mb-2">
                <Trophy className="text-lime-400" size={20} />
                <h1 className="text-lg font-extrabold font-mono tracking-tight text-white">{t(lang, 'leaderboard')}</h1>
              </div>
              <p className="text-[11px] font-mono text-white/35 max-w-md leading-relaxed">
                Airdrop points, top tokens, and top traders. Points feed the Season 1 distribution.
              </p>
            </div>
            <button
              onClick={() => navigate('/airdrop')}
              className="shrink-0 text-[10px] font-mono font-semibold px-[13px] py-2 rounded-[9px] border border-lime-400/30 bg-lime-400/[0.08] text-lime-400 hover:bg-lime-400/[0.14] transition-colors"
            >
              S1 POOL + HOW TO EARN {'->'}
            </button>
          </div>
        </div>

        {/* Board card (design 2f: tabs row + rows) */}
        <div className="rounded-2xl border border-white/[0.08] bg-white/[0.015] overflow-hidden">
          <div className="flex flex-wrap gap-1.5 px-4 py-3 border-b border-white/[0.06]">
            {[
              { id: 'points',  label: 'AIRDROP POINTS' },
              { id: 'tokens',  label: 'TOP TOKENS' },
              { id: 'traders', label: 'TOP TRADERS' },
              { id: 'bounty',  label: 'CONTENT BOUNTY' },
            ].map(tb => (
              <button
                key={tb.id}
                onClick={() => setTab(tb.id)}
                className={`text-[10px] font-mono px-[13px] py-2 rounded-[9px] transition-colors ${
                  tab === tb.id
                    ? 'font-bold bg-sp-pump text-sp-void'
                    : 'font-semibold border border-white/10 text-white/45 hover:text-white/70'
                }`}
              >
                {tb.label}
              </button>
            ))}
          </div>

          {tab === 'bounty' ? (
            <BountyBoard />
          ) : loading ? (
            <div className="py-12 text-center text-xs font-mono text-white/25">Loading…</div>
          ) : tab === 'points' ? (
            <div>
              <div className="px-4 pt-3 text-[9.5px] font-mono text-white/[0.32] leading-relaxed">
                Earn {pointsPerSui} points per SUI bought. Testnet points do not carry to mainnet - Season 1 points start fresh at mainnet launch. Testnet users are covered by a fixed 10% allocation of the S1 distribution instead.
              </div>
              {pointsLeaders.length === 0 ? (
                <div className="py-12 text-center text-xs font-mono text-white/25">No points yet - start trading to climb the board.</div>
              ) : (
                <div className="mt-2">
                  {pointsLeaders.map((pl, i) => (
                    <button key={pl.addr} onClick={() => navigate(`/portfolio/${pl.addr}`)} className={rowClass}>
                      <Rank rank={i + 1} />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-[7px]">
                          <span className="text-xs font-mono font-semibold text-white/80">{shortAddr(pl.addr)}</span>
                          {myAddr && pl.addr === myAddr && <YouBadge />}
                        </div>
                        <div className="text-[9.5px] font-mono text-white/[0.32] mt-[5px]">
                          {pl.distinctTokens} token{pl.distinctTokens === 1 ? '' : 's'} · {pl.buys} buy{pl.buys === 1 ? '' : 's'}
                        </div>
                      </div>
                      <div className="text-right shrink-0">
                        <div className="text-[12.5px] font-mono font-bold text-lime-400">{fmt(pl.points, 0)} pts</div>
                        <div className="text-[9.5px] font-mono text-white/[0.32] mt-[5px]">{fmt(pl.buyVolumeSui)} SUI bought</div>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          ) : tab === 'tokens' ? (
            <div>
              {enrichedTokens.length === 0 ? (
                <div className="py-12 text-center text-xs font-mono text-white/25">No trades yet.</div>
              ) : enrichedTokens.slice(0, 50).map((tk, i) => (
                <button key={tk.curveId} onClick={() => navigate(`/token/${tk.curveId}`)} className={rowClass}>
                  <Rank rank={i + 1} />
                  <div className="w-8 h-8 rounded-full bg-white/5 flex items-center justify-center shrink-0 overflow-hidden">
                    {tk.iconUrl
                      ? <img src={tk.iconUrl} alt={tk.symbol} className="w-full h-full object-cover" />
                      : <span className="text-[10px] font-mono text-white/30">{tk.symbol.slice(0, 1)}</span>}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-mono font-semibold text-white/80 truncate">{tk.name}</div>
                    <div className="text-[9.5px] font-mono text-lime-400/70 mt-[5px]">${tk.symbol}</div>
                  </div>
                  <div className="text-right shrink-0">
                    <div className="text-[12.5px] font-mono font-bold text-white">{fmt(tk.volume)} SUI</div>
                    <div className="text-[9.5px] font-mono text-white/[0.32] mt-[5px]">{tk.trades} trades</div>
                  </div>
                </button>
              ))}
            </div>
          ) : (
            <div>
              <div className="flex items-center justify-between px-4 pt-3">
                <div className="text-[9px] font-mono font-semibold text-white/35 tracking-[0.14em]">TOP TRADERS</div>
                <div className="flex gap-1.5">
                  {[
                    { id: 'volume', label: 'VOLUME' },
                    { id: 'pnl',    label: 'REALIZED PNL' },
                  ].map(s => (
                    <button
                      key={s.id}
                      onClick={() => setTraderSort(s.id)}
                      className={`text-[9px] font-mono font-bold px-2.5 py-1 rounded-[9px] transition-colors ${
                        traderSort === s.id
                          ? 'bg-lime-400/10 text-lime-400 border border-lime-400/30'
                          : 'text-white/30 hover:text-white/60 border border-transparent'
                      }`}
                    >
                      {s.label}
                    </button>
                  ))}
                </div>
              </div>
              {traderSort === 'pnl' && (
                <div className="px-4 pt-2 text-[9px] font-mono text-white/25 leading-relaxed">
                  Realized PnL only - proceeds minus average cost of tokens sold. Unsold holdings excluded.
                </div>
              )}
              {topTraders.length === 0 ? (
                <div className="py-12 text-center text-xs font-mono text-white/25">No traders yet.</div>
              ) : (
                <div className="mt-2">
                  {[...topTraders]
                    .sort((a, b) => traderSort === 'pnl'
                      ? (Number(b.pnl ?? -Infinity) - Number(a.pnl ?? -Infinity))
                      : (b.volume - a.volume))
                    .map((tr, i) => (
                    <button key={tr.addr} onClick={() => navigate(`/portfolio/${tr.addr}`)} className={rowClass}>
                      <Rank rank={i + 1} />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-[7px]">
                          <span className="text-xs font-mono font-semibold text-white/80">{shortAddr(tr.addr)}</span>
                          {myAddr && tr.addr === myAddr && <YouBadge />}
                        </div>
                      </div>
                      <div className="text-right shrink-0">
                        {traderSort === 'pnl' ? (
                          <>
                            <div className={`text-[12.5px] font-mono font-bold ${tr.pnl == null ? 'text-white/40' : tr.pnl >= 0 ? 'text-lime-400' : 'text-red-400'}`}>
                              {tr.pnl == null ? '-' : `${fmtPnl(tr.pnl)} SUI`}
                            </div>
                            <div className="text-[9.5px] font-mono text-white/[0.32] mt-[5px]">{fmt(tr.volume)} SUI vol</div>
                          </>
                        ) : (
                          <>
                            <div className="text-[12.5px] font-mono font-bold text-white">{fmt(tr.volume)} SUI</div>
                            <div className="text-[9.5px] font-mono text-white/[0.32] mt-[5px]">{tr.trades} trades</div>
                          </>
                        )}
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

      </div>
    </div>
  );
}
