// PortfolioPage.jsx
import React, { useState, useEffect, useMemo } from 'react';
import { useCurrentAccount, useSuiClient } from '@mysten/dapp-kit';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Wallet, TrendingUp, Flame, Plus, TrendingDown, Filter } from 'lucide-react';
import { useTokenList } from './useTokenList.js';
import { priceMistPerToken, mistToSui } from './curve.js';
import { TOKEN_DECIMALS, DRAIN_SUI_APPROX, PACKAGE_ID } from './constants.js';
import { paginateEvents, paginateMultipleEvents } from './paginateEvents.js';
import { t } from './i18n.js';

const MIST_PER_SUI = 1e9;

function fmt(n, d = 2) {
  if (n == null) return ' - ';
  if (!Number.isFinite(n) || n === 0) return '0';
  if (n >= 1e6) return (n / 1e6).toFixed(d) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(d) + 'k';
  return n.toFixed(d);
}

function fmtPnl(n, d = 3) {
  if (n == null || !Number.isFinite(n)) return ' - ';
  const abs = Math.abs(n);
  const str = abs >= 1e3 ? (abs/1e3).toFixed(1) + 'k' : abs.toFixed(d);
  return (n >= 0 ? '+' : '-') + str + ' SUI';
}

function shortAddr(a) {
  if (!a) return '';
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

function TokenRow({ token, iconUrl, right, onClick }) {
  return (
    <button
      onClick={onClick}
      className="w-full flex items-center gap-3 px-5 py-4 border-b border-white/[0.03] last:border-0 hover:bg-white/5 transition-colors group text-left"
    >
      <div className="w-9 h-9 rounded-full border border-white/10 overflow-hidden flex items-center justify-center bg-lime-950/30 shrink-0 group-hover:border-lime-400/30 transition-colors">
        {iconUrl
          ? <img src={iconUrl} alt={token.symbol} className="w-full h-full object-cover"
              onError={e => { e.target.style.display = 'none'; e.target.nextSibling.style.display = 'block'; }} />
          : null}
        <span className="text-base" style={{ display: iconUrl ? 'none' : 'block' }}>🔥</span>
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-xs font-mono font-bold text-white truncate group-hover:text-lime-400 transition-colors">
          {token.name || 'Unknown'}
        </div>
        <div className="text-[10px] font-mono text-white/30">${token.symbol || '???'}</div>
      </div>
      {right}
    </button>
  );
}

// ── HOLDINGS tab ─────────────────────────────────────────────────────────────

function HoldingsTab({ account, tokens, client, lang }) {
  const navigate = useNavigate();
  const [holdings, setHoldings] = useState([]);
  const [loading, setLoading] = useState(true);
  const [iconUrls, setIconUrls] = useState({});

  useEffect(() => {
    if (!account?.address || !tokens.length) { setLoading(false); return; }
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const results = await Promise.all(
          tokens.filter(tk => tk.tokenType).map(async (token) => {
            try {
              const [balance, curveObj] = await Promise.all([
                client.getBalance({ owner: account.address, coinType: token.tokenType }),
                client.getObject({ id: token.curveId, options: { showContent: true } }),
              ]);
              const rawBalance = BigInt(balance.totalBalance ?? '0');
              if (rawBalance === 0n) return null;
              const fields = curveObj.data?.content?.fields;
              const reserveMist = fields ? BigInt(fields.sui_reserve) : 0n;
              const tokensRemaining = fields ? BigInt(fields.token_reserve) : 0n;
              const tokensSold = BigInt(800_000_000) * 10n ** BigInt(TOKEN_DECIMALS) - tokensRemaining;
              const priceMist = priceMistPerToken(reserveMist, tokensSold);
              const valueInMist = (rawBalance * priceMist) / (10n ** BigInt(TOKEN_DECIMALS));
              const valueSui = Number(valueInMist) / MIST_PER_SUI;
              const balanceWhole = Number(rawBalance) / 10 ** TOKEN_DECIMALS;
              const graduated = fields?.graduated ?? false;
              const reserveSui = mistToSui(reserveMist);
              const progress = Math.min(100, (reserveSui / DRAIN_SUI_APPROX) * 100);
              return { ...token, balance: balanceWhole, valueSui, priceMist, progress, graduated };
            } catch { return null; }
          })
        );
        if (cancelled) return;
        const filtered = results.filter(Boolean).sort((a, b) => b.valueSui - a.valueSui);
        setHoldings(filtered);
        const icons = {};
        await Promise.all(filtered.map(async (h) => {
          try {
            const m = await client.getCoinMetadata({ coinType: h.tokenType });
            if (m?.iconUrl) icons[h.curveId] = m.iconUrl;
          } catch {}
        }));
        if (!cancelled) setIconUrls(icons);
      } catch {}
      finally { if (!cancelled) setLoading(false); }
    }
    load();
    return () => { cancelled = true; };
  }, [account?.address, tokens.length, client]);

  const totalValueSui = holdings.reduce((s, h) => s + h.valueSui, 0);

  if (!account) return <div className="text-xs font-mono text-white/30 text-center py-12">{t(lang, 'connectToView')}</div>;
  if (loading) return (
    <div className="space-y-px">
      {[...Array(4)].map((_, i) => (
        <div key={i} className="flex items-center gap-3 px-5 py-4 animate-pulse">
          <div className="w-9 h-9 rounded-full bg-white/5 shrink-0" />
          <div className="flex-1"><div className="h-3 bg-white/5 rounded w-20 mb-1.5" /><div className="h-2 bg-white/5 rounded w-14" /></div>
          <div className="h-3 bg-white/5 rounded w-16 ml-auto" />
        </div>
      ))}
    </div>
  );
  if (holdings.length === 0) return <div className="text-xs font-mono text-white/20 text-center py-12">{t(lang, 'noHoldings')}</div>;

  return (
    <>
      <div className="px-5 py-3 border-b border-white/5 flex items-center justify-between">
        <span className="text-[10px] font-mono text-white/30">{holdings.length} token{holdings.length !== 1 ? 's' : ''}</span>
        <span className="text-[10px] font-mono text-lime-400/70">~{fmt(totalValueSui, 4)} SUI total</span>
      </div>
      {holdings.map((h) => (
        <TokenRow key={h.curveId} token={h} iconUrl={iconUrls[h.curveId]}
          onClick={() => navigate(`/token/${h.curveId}`)}
          right={
            <div className="text-right shrink-0">
              <div className="text-xs font-mono font-bold text-lime-400">{fmt(h.valueSui, 4)} SUI</div>
              <div className="text-[10px] font-mono text-white/30">{fmt(h.balance, 0)} {h.symbol}</div>
              {h.graduated && <div className="text-[9px] font-mono text-emerald-400">GRAD</div>}
            </div>
          }
        />
      ))}
    </>
  );
}

// ── TRADED tab with PNL ───────────────────────────────────────────────────────

function TradedTab({ account, tokens, client, lang }) {
  const navigate = useNavigate();
  const [tradedTokens, setTradedTokens] = useState([]);
  const [currentPrices, setCurrentPrices] = useState({});
  const [loading, setLoading] = useState(true);
  const [iconUrls, setIconUrls] = useState({});
  const [filter, setFilter] = useState('all'); // 'all' | 'active' | 'closed'

  useEffect(() => {
    if (!account?.address) { setLoading(false); return; }
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const buyType  = `${PACKAGE_ID}::bonding_curve::TokensPurchased`;
        const sellType = `${PACKAGE_ID}::bonding_curve::TokensSold`;
        const eventMap = await paginateMultipleEvents(client, [buyType, sellType], { order: 'descending', maxPages: 20 });
        if (cancelled) return;
        const addr = account.address;
        const curveVolume = {};
        for (const e of eventMap[buyType]) {
          if (e.parsedJson?.buyer !== addr) continue;
          const id = e.parsedJson.curve_id;
          if (!curveVolume[id]) curveVolume[id] = { suiSpent: 0, suiReceived: 0, buys: 0, sells: 0, tokensBought: 0, tokensSold: 0 };
          const suiIn = Number(e.parsedJson.sui_in ?? 0) / MIST_PER_SUI;
          const tokOut = Number(e.parsedJson.tokens_out ?? 0) / 10 ** TOKEN_DECIMALS;
          curveVolume[id].suiSpent += suiIn;
          curveVolume[id].tokensBought += tokOut;
          curveVolume[id].buys += 1;
        }
        for (const e of eventMap[sellType]) {
          if (e.parsedJson?.seller !== addr) continue;
          const id = e.parsedJson.curve_id;
          if (!curveVolume[id]) curveVolume[id] = { suiSpent: 0, suiReceived: 0, buys: 0, sells: 0, tokensBought: 0, tokensSold: 0 };
          const suiOut = Number(e.parsedJson.sui_out ?? 0) / MIST_PER_SUI;
          const tokIn = Number(e.parsedJson.tokens_in ?? 0) / 10 ** TOKEN_DECIMALS;
          curveVolume[id].suiReceived += suiOut;
          curveVolume[id].tokensSold += tokIn;
          curveVolume[id].sells += 1;
        }
        const curveIds = Object.keys(curveVolume);
        if (!curveIds.length) { if (!cancelled) { setTradedTokens([]); setLoading(false); } return; }

        const enriched = curveIds.map(curveId => {
          const meta = tokens.find(tk => tk.curveId === curveId);
          const stats = curveVolume[curveId];
          const realizedPnl = stats.suiReceived - stats.suiSpent;
          const avgEntryPrice = stats.tokensBought > 0 ? stats.suiSpent / stats.tokensBought : 0;
          const netTokensHeld = stats.tokensBought - stats.tokensSold;
          return {
            curveId,
            name: meta?.name || 'Unknown',
            symbol: meta?.symbol || '???',
            tokenType: meta?.tokenType || null,
            suiSpent: stats.suiSpent,
            suiReceived: stats.suiReceived,
            buys: stats.buys,
            sells: stats.sells,
            realizedPnl,
            avgEntryPrice,
            netTokensHeld: Math.max(0, netTokensHeld),
            isClosed: netTokensHeld <= 0.001,
          };
        }).sort((a, b) => (b.suiSpent + b.suiReceived) - (a.suiSpent + a.suiReceived));

        if (!cancelled) { setTradedTokens(enriched); setLoading(false); }

        // Fetch current prices for unrealized PNL
        const prices = {};
        await Promise.all(enriched.filter(tk => !tk.isClosed && tk.tokenType).map(async (tk) => {
          try {
            const obj = await client.getObject({ id: tk.curveId, options: { showContent: true } });
            const fields = obj.data?.content?.fields;
            if (fields) {
              const reserveMist = BigInt(fields.sui_reserve);
              const tokensRemaining = BigInt(fields.token_reserve);
              const tokensSoldTotal = BigInt(800_000_000) * 10n ** BigInt(TOKEN_DECIMALS) - tokensRemaining;
              const priceMist = priceMistPerToken(reserveMist, tokensSoldTotal);
              prices[tk.curveId] = Number(priceMist) / MIST_PER_SUI; // SUI per token (whole)
            }
          } catch {}
        }));
        if (!cancelled) setCurrentPrices(prices);

        // Icons
        const icons = {};
        await Promise.all(enriched.map(async (tk) => {
          if (!tk.tokenType) return;
          try {
            const m = await client.getCoinMetadata({ coinType: tk.tokenType });
            if (m?.iconUrl) icons[tk.curveId] = m.iconUrl;
          } catch {}
        }));
        if (!cancelled) setIconUrls(icons);
      } catch { if (!cancelled) setLoading(false); }
    }
    load();
    return () => { cancelled = true; };
  }, [account?.address, tokens.length, client]);

  const filtered = useMemo(() => {
    if (filter === 'active') return tradedTokens.filter(tk => !tk.isClosed);
    if (filter === 'closed') return tradedTokens.filter(tk => tk.isClosed);
    return tradedTokens;
  }, [tradedTokens, filter]);

  const totalRealizedPnl = tradedTokens.reduce((s, tk) => s + tk.realizedPnl, 0);
  const totalUnrealizedPnl = tradedTokens.reduce((s, tk) => {
    if (tk.isClosed || !currentPrices[tk.curveId]) return s;
    const currentVal = tk.netTokensHeld * currentPrices[tk.curveId];
    const costBasis = tk.netTokensHeld * tk.avgEntryPrice;
    return s + (currentVal - costBasis);
  }, 0);

  if (!account) return <div className="text-xs font-mono text-white/30 text-center py-12">{t(lang, 'connectToView')}</div>;
  if (loading) return (
    <div className="space-y-px">
      {[...Array(4)].map((_, i) => (
        <div key={i} className="flex items-center gap-3 px-5 py-4 animate-pulse">
          <div className="w-9 h-9 rounded-full bg-white/5 shrink-0" />
          <div className="flex-1"><div className="h-3 bg-white/5 rounded w-20 mb-1.5" /><div className="h-2 bg-white/5 rounded w-14" /></div>
          <div className="h-3 bg-white/5 rounded w-16 ml-auto" />
        </div>
      ))}
    </div>
  );
  if (tradedTokens.length === 0) return <div className="text-xs font-mono text-white/20 text-center py-12">{t(lang, 'noTrades')}</div>;

  return (
    <>
      {/* PNL summary bar */}
      <div className="px-5 py-3 border-b border-white/5 grid grid-cols-2 gap-3">
        <div>
          <div className="text-[9px] font-mono text-white/25 tracking-widest mb-0.5">REALIZED PNL</div>
          <div className={`text-sm font-mono font-bold ${totalRealizedPnl >= 0 ? 'text-lime-400' : 'text-red-400'}`}>
            {fmtPnl(totalRealizedPnl)}
          </div>
        </div>
        <div>
          <div className="text-[9px] font-mono text-white/25 tracking-widest mb-0.5">UNREALIZED PNL</div>
          <div className={`text-sm font-mono font-bold ${totalUnrealizedPnl >= 0 ? 'text-lime-400' : 'text-red-400'}`}>
            {fmtPnl(totalUnrealizedPnl)}
          </div>
        </div>
      </div>

      {/* Filter tabs */}
      <div className="px-5 py-2 border-b border-white/5 flex gap-2">
        {['all', 'active', 'closed'].map(f => (
          <button key={f} onClick={() => setFilter(f)}
            className={`px-3 py-1 rounded-lg text-[9px] font-mono transition-all ${
              filter === f ? 'bg-lime-400 text-black font-bold' : 'bg-white/5 text-white/40 hover:bg-white/10'
            }`}>
            {f.toUpperCase()}
          </button>
        ))}
        <span className="ml-auto text-[9px] font-mono text-white/20 self-center">{filtered.length} tokens</span>
      </div>

      {filtered.map((tk) => {
        const currentPrice = currentPrices[tk.curveId] || 0;
        const currentVal = tk.netTokensHeld * currentPrice;
        const costBasis = tk.netTokensHeld * tk.avgEntryPrice;
        const unrealizedPnl = !tk.isClosed && currentPrice ? currentVal - costBasis : null;

        return (
          <button key={tk.curveId} onClick={() => navigate(`/token/${tk.curveId}`)}
            className="w-full px-5 py-4 border-b border-white/[0.03] last:border-0 hover:bg-white/5 transition-colors text-left">
            <div className="flex items-center gap-3 mb-2">
              <div className="w-9 h-9 rounded-full border border-white/10 overflow-hidden flex items-center justify-center bg-lime-950/30 shrink-0">
                {iconUrls[tk.curveId]
                  ? <img src={iconUrls[tk.curveId]} alt={tk.symbol} className="w-full h-full object-cover"
                      onError={e => { e.target.style.display='none'; e.target.nextSibling.style.display='block'; }} />
                  : null}
                <span className="text-base" style={{ display: iconUrls[tk.curveId] ? 'none' : 'block' }}>🔥</span>
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-mono font-bold text-white">{tk.name}</span>
                  <span className={`text-[9px] font-mono px-1.5 py-0.5 rounded ${tk.isClosed ? 'bg-white/5 text-white/30' : 'bg-lime-400/10 text-lime-400'}`}>
                    {tk.isClosed ? 'CLOSED' : 'ACTIVE'}
                  </span>
                </div>
                <div className="text-[10px] font-mono text-white/30">${tk.symbol}</div>
              </div>
              {/* Realized PNL */}
              <div className="text-right shrink-0">
                <div className={`text-xs font-mono font-bold ${tk.realizedPnl >= 0 ? 'text-lime-400' : 'text-red-400'}`}>
                  {fmtPnl(tk.realizedPnl)}
                </div>
                <div className="text-[9px] font-mono text-white/25">realized</div>
              </div>
            </div>

            {/* Detail row */}
            <div className="grid grid-cols-3 gap-2 pl-12 text-[9px] font-mono">
              <div>
                <div className="text-white/25 mb-0.5">SPENT</div>
                <div className="text-white/60">{fmt(tk.suiSpent, 3)} SUI</div>
              </div>
              <div>
                <div className="text-white/25 mb-0.5">RECEIVED</div>
                <div className="text-white/60">{fmt(tk.suiReceived, 3)} SUI</div>
              </div>
              {!tk.isClosed && unrealizedPnl !== null ? (
                <div>
                  <div className="text-white/25 mb-0.5">UNREALIZED</div>
                  <div className={unrealizedPnl >= 0 ? 'text-lime-400' : 'text-red-400'}>{fmtPnl(unrealizedPnl, 3)}</div>
                </div>
              ) : (
                <div>
                  <div className="text-white/25 mb-0.5">TRADES</div>
                  <div className="text-white/60">{tk.buys}B / {tk.sells}S</div>
                </div>
              )}
            </div>

            {/* Entry price */}
            {tk.avgEntryPrice > 0 && (
              <div className="pl-12 mt-1 flex items-center gap-3 text-[9px] font-mono text-white/20">
                <span>entry {tk.avgEntryPrice.toFixed(8)} SUI/tok</span>
                {currentPrice > 0 && !tk.isClosed && (
                  <span>now {currentPrice.toFixed(8)} SUI/tok</span>
                )}
              </div>
            )}
          </button>
        );
      })}
    </>
  );
}

// ── CREATED tab ───────────────────────────────────────────────────────────────

function CreatedTab({ account, tokens, client, lang }) {
  const navigate = useNavigate();
  const [curveStats, setCurveStats] = useState({});
  const [loading, setLoading] = useState(true);
  const [iconUrls, setIconUrls] = useState({});

  const createdTokens = useMemo(() => {
    if (!account?.address) return [];
    return tokens.filter(tk => tk.creator === account.address);
  }, [tokens, account?.address]);

  useEffect(() => {
    if (!createdTokens.length) { setLoading(false); return; }
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const curveObjs = await Promise.all(
          createdTokens.map(tk => client.getObject({ id: tk.curveId, options: { showContent: true } }).catch(() => null))
        );
        const iconResults = await Promise.all(
          createdTokens.map(async (tk) => {
            try { const m = await client.getCoinMetadata({ coinType: tk.tokenType }); return { curveId: tk.curveId, iconUrl: m?.iconUrl || null }; }
            catch { return { curveId: tk.curveId, iconUrl: null }; }
          })
        );
        if (cancelled) return;
        const stats = {};
        for (let i = 0; i < createdTokens.length; i++) {
          const obj = curveObjs[i];
          if (!obj?.data?.content?.fields) continue;
          const fields = obj.data.content.fields;
          const curveId = createdTokens[i].curveId;
          const reserveMist = BigInt(fields.sui_reserve ?? 0);
          const reserveSui = mistToSui(reserveMist);
          const progress = Math.min(100, (reserveSui / DRAIN_SUI_APPROX) * 100);
          const creatorFeesSui = Number(BigInt(fields.creator_fees ?? 0)) / MIST_PER_SUI;
          stats[curveId] = { progress, reserveSui, creatorFeesSui, graduated: fields.graduated ?? false };
        }
        setCurveStats(stats);
        const icons = {};
        for (const { curveId, iconUrl } of iconResults) { if (iconUrl) icons[curveId] = iconUrl; }
        setIconUrls(icons);
      } catch {}
      finally { if (!cancelled) setLoading(false); }
    }
    load();
    return () => { cancelled = true; };
  }, [createdTokens.length, client]);

  if (!account) return <div className="text-xs font-mono text-white/30 text-center py-12">{t(lang, 'connectToView')}</div>;
  if (createdTokens.length === 0) return <div className="text-xs font-mono text-white/20 text-center py-12">{t(lang, 'noCreated')}</div>;

  return (
    <>
      <div className="px-5 py-3 border-b border-white/5">
        <span className="text-[10px] font-mono text-white/30">{createdTokens.length} token{createdTokens.length !== 1 ? 's' : ''} launched</span>
      </div>
      {createdTokens.map((tk) => {
        const s = curveStats[tk.curveId];
        return (
          <TokenRow key={tk.curveId} token={tk} iconUrl={iconUrls[tk.curveId]}
            onClick={() => navigate(`/token/${tk.curveId}`)}
            right={
              <div className="text-right shrink-0 space-y-0.5">
                {s ? (
                  <>
                    <div className="text-xs font-mono font-bold text-white/70">{fmt(s.reserveSui, 1)} SUI</div>
                    <div className="text-[10px] font-mono text-lime-400/70">{s.progress.toFixed(1)}% filled</div>
                    {s.creatorFeesSui > 0 && <div className="text-[9px] font-mono text-lime-400/50">{fmt(s.creatorFeesSui, 3)} fees</div>}
                    {s.graduated && <div className="text-[9px] font-mono text-emerald-400">GRAD</div>}
                  </>
                ) : <div className="text-[10px] font-mono text-white/20"> - </div>}
              </div>
            }
          />
        );
      })}
    </>
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────

export default function PortfolioPage({ onBack, lang = 'en' }) {
  const account = useCurrentAccount();
  const client = useSuiClient();
  const { tokens } = useTokenList();
  const [tab, setTab] = useState('holdings');

  // Total portfolio value from holdings  -  passed down
  const TABS = [
    { id: 'holdings', label: t(lang, 'holdings'),  icon: <Wallet size={11} /> },
    { id: 'traded',   label: t(lang, 'traded'),    icon: <TrendingUp size={11} /> },
    { id: 'created',  label: t(lang, 'created'),   icon: <Plus size={11} /> },
  ];

  return (
    <div>
      <button onClick={onBack} className="flex items-center gap-2 text-xs font-mono text-white/40 hover:text-white mb-6 transition-colors">
        <ArrowLeft size={12} /> {t(lang, 'backToHome')}
      </button>

      <div className="max-w-2xl mx-auto space-y-4">
        {/* Header */}
        <div className="rounded-3xl border border-white/10 bg-gradient-to-br from-lime-950/20 via-black to-black p-6 relative overflow-hidden">
          <div className="absolute top-0 left-1/2 -translate-x-1/2 w-64 h-16 bg-lime-400/10 blur-3xl rounded-full pointer-events-none" />
          <div className="relative">
            <div className="flex items-center gap-3 mb-2">
              <Wallet className="text-lime-400" size={20} />
              <h1 className="text-xl font-bold text-white" style={{ fontFamily: "'Space Grotesk', sans-serif" }}>
                {t(lang, 'portfolioTitle')}
              </h1>
            </div>
            {account
              ? <div className="text-[10px] font-mono text-white/35 break-all">{account.address}</div>
              : <div className="text-sm font-mono text-white/30">{t(lang, 'connectToView')}</div>}
          </div>
        </div>

        {/* Tab toggle */}
        <div className="flex gap-2">
          {TABS.map(tk => (
            <button key={tk.id} onClick={() => setTab(tk.id)}
              className={`flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-mono transition-all ${
                tab === tk.id
                  ? 'bg-lime-400 text-black font-bold'
                  : 'bg-white/5 text-white/40 hover:bg-white/10 hover:text-white/70'
              }`}>
              {tk.icon} {tk.label}
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="rounded-2xl border border-white/10 bg-white/[0.03] overflow-hidden">
          {tab === 'holdings' && <HoldingsTab account={account} tokens={tokens} client={client} lang={lang} />}
          {tab === 'traded'   && <TradedTab   account={account} tokens={tokens} client={client} lang={lang} />}
          {tab === 'created'  && <CreatedTab  account={account} tokens={tokens} client={client} lang={lang} />}
        </div>

        <div className="text-[9px] font-mono text-white/15 text-center">
          {t(lang, 'valuesEstimate')}
        </div>
      </div>
    </div>
  );
}
