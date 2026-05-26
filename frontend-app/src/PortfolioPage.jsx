// v18-holdings-fix
// PortfolioPage.jsx
import React, { useState, useEffect, useMemo } from 'react';
import { useCurrentAccount, useDAppKit } from '@mysten/dapp-kit-react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Wallet, TrendingUp, Plus } from 'lucide-react';
import { useTokenList } from './useTokenList.js';
import { priceMistPerToken, mistToSui } from './curve.js';
import { Transaction } from '@mysten/sui/transactions';
import { TOKEN_DECIMALS, DRAIN_SUI_APPROX, ALL_PACKAGE_IDS } from './constants.js';
import { paginateMultipleEvents } from './paginateEvents.js';
import { t } from './i18n.js';

const MIST_PER_SUI = 1e9;
const INDEXER_URL = import.meta.env.VITE_INDEXER_URL || '';

function fmt(n, d = 2) {
  if (n == null) return '-';
  if (!Number.isFinite(n) || n === 0) return '0';
  if (n >= 1e6) return (n / 1e6).toFixed(d) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(d) + 'k';
  return n.toFixed(d);
}

function fmtPnl(n, d = 3) {
  if (n == null || !Number.isFinite(n)) return '-';
  const abs = Math.abs(n);
  const str = abs >= 1e3 ? (abs/1e3).toFixed(1) + 'k' : abs.toFixed(d);
  return (n >= 0 ? '+' : '-') + str + ' SUI';
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

// ── Canvas PnL card helpers ───────────────────────────────────────────────────

function drawPnlCard({ canvas, name, symbol, pnlSui, pnlPct, spent, entryPrice, currentPrice, isClosed, mascotImg }) {
  const W = 800, H = 420;
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  const isUp = pnlSui >= 0;

  const bg = ctx.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, '#050505');
  bg.addColorStop(1, '#0d1a05');
  ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);

  ctx.strokeStyle = isUp ? '#84cc1630' : '#ef444430';
  ctx.lineWidth = 1;
  ctx.strokeRect(1, 1, W - 2, H - 2);

  ctx.font = 'bold 13px monospace'; ctx.fillStyle = '#84cc16';
  ctx.fillText('SUIPUMP.ORG', 40, 48);

  ctx.font = 'bold 32px monospace'; ctx.fillStyle = '#ffffff';
  ctx.fillText(name || 'Unknown', 40, 100);
  ctx.font = '16px monospace'; ctx.fillStyle = '#84cc1699';
  ctx.fillText(`$${symbol}`, 40, 128);

  const pnlColor = isUp ? '#84cc16' : '#ef4444';
  ctx.font = 'bold 72px monospace'; ctx.fillStyle = pnlColor;
  ctx.fillText(`${isUp ? '+' : ''}${pnlSui.toFixed(3)} SUI`, 40, 230);

  ctx.font = 'bold 28px monospace'; ctx.fillStyle = pnlColor + 'cc';
  ctx.fillText(`${isUp ? '▲' : '▼'} ${Math.abs(pnlPct).toFixed(1)}%`, 40, 278);

  ctx.font = '14px monospace'; ctx.fillStyle = '#ffffff55';
  ctx.fillText(`Spent: ${spent.toFixed(3)} SUI`, 40, 330);
  if (entryPrice > 0) ctx.fillText(`Entry: ${entryPrice.toFixed(8)} SUI/token`, 40, 354);
  if (currentPrice > 0) ctx.fillText(`Now:   ${currentPrice.toFixed(8)} SUI/token`, 40, 378);

  ctx.font = 'bold 13px monospace';
  ctx.fillStyle = isClosed ? '#ffffff40' : '#84cc16';
  const badge = isClosed ? 'CLOSED' : 'OPEN';
  ctx.fillText(badge, W - 112, 62);
  if (mascotImg) { ctx.globalCompositeOperation = 'screen'; ctx.drawImage(mascotImg, W - 320, H - 370, 310, 310); ctx.globalCompositeOperation = 'source-over'; }
}

function PnlShareButton({ tk, unrealizedPnl, currentPrice, mascotDataUrl }) {
  const handleShare = () => {
    const canvas = document.createElement('canvas');
    const totalPnl = (tk.realizedPnl || 0) + (unrealizedPnl || 0);
    const pnlPct = tk.suiSpent > 0 ? (totalPnl / tk.suiSpent) * 100 : 0;
    let mascotImg = null;
    if (mascotDataUrl) { mascotImg = new Image(); mascotImg.src = mascotDataUrl; }
    const draw = () => {
      drawPnlCard({ canvas, name: tk.name, symbol: tk.symbol, pnlSui: totalPnl, pnlPct, spent: tk.suiSpent, entryPrice: tk.avgEntryPrice, currentPrice: currentPrice || 0, isClosed: tk.isClosed, mascotImg });
      const link = document.createElement('a');
      link.download = `suipump-${tk.symbol}-pnl.png`;
      link.href = canvas.toDataURL('image/png');
      link.click();
    };
    if (mascotImg) { mascotImg.onload = draw; mascotImg.onerror = draw; } else { draw(); }
  };
  return (
    <button onClick={e => { e.stopPropagation(); handleShare(); }}
      className="flex items-center gap-1 px-2 py-1 rounded-lg bg-lime-400/10 border border-lime-400/20 text-lime-400 text-[9px] font-mono font-bold hover:bg-lime-400/20 transition-colors">
      SHARE PNL
    </button>
  );
}

// ── PFP storage ───────────────────────────────────────────────────────────────
function pfpKey(addr) { return `suipump_pfp_${addr}`; }
function getPfp(addr) { try { return localStorage.getItem(pfpKey(addr)) || ''; } catch { return ''; } }
function setPfp(addr, url) { try { localStorage.setItem(pfpKey(addr), url); } catch {} }

// ── HOLDINGS tab ──────────────────────────────────────────────────────────────

function HoldingsTab({ account, tokens, lang, onTotalValue }) {
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
        // Step 1: Fetch all curve stats — has correct last_price per curve
        let tokenStats = {};
        if (INDEXER_URL) {
          try {
            const res = await fetch(`${INDEXER_URL}/tokens/stats`, { signal: AbortSignal.timeout(5000) });
            if (res.ok) {
              const rows = await res.json();
              for (const r of rows) tokenStats[r.curve_id] = r;
            }
          } catch {}
        }

        // Step 2: Fetch trader positions — balance per token
        let results = [];
        if (INDEXER_URL) {
          try {
            // FIX: use account.address, not undefined `viewAddress`
            const tradRes = await fetch(`${INDEXER_URL}/trader/${account.address}`, { signal: AbortSignal.timeout(8000) });
            if (tradRes.ok) {
              const positions = await tradRes.json();
              results = positions
                .filter(p => p.balance > 0)
                .map(p => {
                  const token = tokens.find(t => t.curveId === p.curve_id);
                  if (!token) return null;

                  // FIX: use last_price from /tokens/stats — correct (vSui+reserve)/1B formula
                  // Fall back to priceMistPerToken only if stats missing
                  const stats = tokenStats[p.curve_id];
                  let valueSui = 0;
                  if (stats?.last_price && stats.last_price > 0) {
                    // last_price is in SUI per token (e.g. 0.0000035)
                    valueSui = p.balance * stats.last_price;
                  } else {
                    // Fallback: manual calc using reserve from indexer stats
                    const reserveSui = stats?.reserve_sui ?? 0;
                    const reserveMist = BigInt(Math.round(reserveSui * MIST_PER_SUI));
                    const tokensRemaining = BigInt(Math.round((stats?.token_reserve ?? 800_000_000) * 1e6));
                    const tokensSold = BigInt(800_000_000) * BigInt(1e6) - tokensRemaining;
                    const priceMist = priceMistPerToken(reserveMist, tokensSold);
                    const rawBalance = BigInt(Math.round(p.balance * 1e6));
                    const valueInMist = (rawBalance * priceMist) / BigInt(1e6);
                    valueSui = Number(valueInMist) / MIST_PER_SUI;
                  }

                  return {
                    ...token,
                    balance: p.balance,
                    valueSui,
                    graduated: p.graduated ?? false,
                  };
                })
                .filter(Boolean);
            }
          } catch {}
        }

        if (cancelled) return;
        const valid = results.sort((a, b) => b.valueSui - a.valueSui);
        const total = valid.reduce((s, h) => s + h.valueSui, 0);
        setHoldings(valid);
        onTotalValue(total);

        const icons = {};
        for (const h of valid) { if (h.iconUrl) icons[h.curveId] = h.iconUrl; }
        if (!cancelled) setIconUrls(icons);
      } catch {}
      finally { if (!cancelled) setLoading(false); }
    }

    load();
    return () => { cancelled = true; };
  }, [account?.address, tokens.length]);

  if (!account) return <div className="text-xs font-mono text-white/30 text-center py-12">{t(lang, 'connectToView')}</div>;
  if (loading) return <div className="text-xs font-mono text-white/30 text-center py-12">Loading…</div>;
  if (!holdings.length) return <div className="text-xs font-mono text-white/20 text-center py-12">{t(lang, 'noHoldings')}</div>;

  const totalValueSui = holdings.reduce((s, h) => s + h.valueSui, 0);

  return (
    <>
      <div className="px-5 py-3 border-b border-white/5 flex items-center gap-3">
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

// ── TRADED tab ────────────────────────────────────────────────────────────────

function TradedTab({ account, tokens, lang }) {
  const navigate = useNavigate();
  const [tradedTokens, setTradedTokens] = useState([]);
  const [loading, setLoading] = useState(true);
  const [iconUrls, setIconUrls] = useState({});

  useEffect(() => {
    if (!account?.address) { setLoading(false); return; }
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const addr = account.address;

        // Indexer path
        if (INDEXER_URL) {
          try {
            const res = await fetch(`${INDEXER_URL}/trader/${addr}`, { signal: AbortSignal.timeout(5000) });
            if (res.ok) {
              const rows = await res.json();
              if (rows.length > 0) {
                const enriched = rows.map(r => {
                  const meta = tokens.find(tk => tk.curveId === r.curve_id);
                  return {
                    curveId:       r.curve_id,
                    name:          meta?.name   || r.name   || 'Unknown',
                    symbol:        meta?.symbol || r.symbol || '???',
                    tokenType:     meta?.tokenType || null,
                    iconUrl:       meta?.iconUrl || null,
                    suiSpent:      r.sui_spent    ?? 0,
                    suiReceived:   r.sui_received ?? 0,
                    buys:          r.buys         ?? 0,
                    sells:         r.sells        ?? 0,
                    realizedPnl:   (r.sui_received ?? 0) - (r.sui_spent ?? 0),
                    isClosed:      (r.net_tokens  ?? 0) <= 0.001,
                    avgEntryPrice: r.avg_entry_price ?? 0,
                  };
                }).sort((a, b) => (b.suiSpent + b.suiReceived) - (a.suiSpent + a.suiReceived));

                if (!cancelled) { setTradedTokens(enriched); setLoading(false); }

                const icons = {};
                for (const tk of enriched) { if (tk.iconUrl) icons[tk.curveId] = tk.iconUrl; }
                if (!cancelled) setIconUrls(icons);
                return;
              }
            }
          } catch {}
        }

        // RPC fallback removed (CORS blocked) — empty state
        if (!cancelled) { setTradedTokens([]); setLoading(false); }
      } catch { if (!cancelled) setLoading(false); }
    }
    load();
    return () => { cancelled = true; };
  }, [account?.address, tokens.length]);

  if (!account) return <div className="text-xs font-mono text-white/30 text-center py-12">{t(lang, 'connectToView')}</div>;
  if (loading) return <div className="text-xs font-mono text-white/30 text-center py-12">Loading…</div>;
  if (!tradedTokens.length) return <div className="text-xs font-mono text-white/20 text-center py-12">{t(lang, 'noTrades')}</div>;

  return (
    <>
      <div className="px-5 py-3 border-b border-white/5">
        <span className="text-[10px] font-mono text-white/30">{tradedTokens.length} token{tradedTokens.length !== 1 ? 's' : ''} traded</span>
      </div>
      {tradedTokens.map((tk) => {
        const pnl = tk.realizedPnl;
        const isUp = pnl >= 0;
        return (
          <TokenRow key={tk.curveId} token={tk} iconUrl={iconUrls[tk.curveId]}
            onClick={() => navigate(`/token/${tk.curveId}`)}
            right={
              <div className="text-right shrink-0 space-y-0.5">
                <div className={`text-xs font-mono font-bold ${isUp ? 'text-lime-400' : 'text-red-400'}`}>{fmtPnl(pnl)}</div>
                <div className="text-[10px] font-mono text-white/30">{tk.buys}B / {tk.sells}S</div>
                {tk.isClosed && <div className="text-[9px] font-mono text-white/20">CLOSED</div>}
              </div>
            }
          />
        );
      })}
    </>
  );
}

// ── CREATED tab ───────────────────────────────────────────────────────────────

function CreatedTab({ account, tokens, lang }) {
  const navigate = useNavigate();
  const dAppKit = useDAppKit();
  const [curveStats, setCurveStats]   = useState({});
  const [capMap, setCapMap]           = useState({});
  const [loading, setLoading]         = useState(true);
  const [iconUrls, setIconUrls]       = useState({});
  const [claimingAll, setClaimingAll] = useState(false);
  const [claimMsg, setClaimMsg]       = useState('');

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
        let indexerStats = {};
        if (INDEXER_URL) {
          try {
            const res = await fetch(`${INDEXER_URL}/tokens/stats`, { signal: AbortSignal.timeout(5000) });
            if (res.ok) {
              const rows = await res.json();
              for (const r of rows) indexerStats[r.curve_id] = r;
            }
          } catch {}
        }

        const curveObjs = await Promise.all(
          createdTokens.map(tk =>
            fetch(`${INDEXER_URL}/token/${tk.curveId}`, { signal: AbortSignal.timeout(5000) })
              .then(r => r.ok ? r.json() : null)
              .catch(() => null)
          )
        );

        const statsMap = {};
        for (let i = 0; i < createdTokens.length; i++) {
          const tk = createdTokens[i];
          const obj = curveObjs[i];
          const idxStat = indexerStats[tk.curveId] ?? {};
          statsMap[tk.curveId] = {
            creatorFeesSui: obj?.stats?.creator_fees_sui ?? idxStat.creator_fees_sui ?? 0,
            volumeSui:      idxStat.volume_sui  ?? 0,
            trades:         idxStat.trades      ?? 0,
            progress:       idxStat.progress    ?? 0,
            graduated:      obj?.graduated      ?? idxStat.graduated ?? false,
          };
        }

        if (!cancelled) {
          setCurveStats(statsMap);
          const icons = {};
          for (const tk of createdTokens) { if (tk.iconUrl) icons[tk.curveId] = tk.iconUrl; }
          setIconUrls(icons);
          setLoading(false);
        }
      } catch { if (!cancelled) setLoading(false); }
    }
    load();
    return () => { cancelled = true; };
  }, [createdTokens.length, account?.address]);

  const totalClaimable = useMemo(() =>
    createdTokens.reduce((s, tk) => s + (curveStats[tk.curveId]?.creatorFeesSui ?? 0), 0),
    [createdTokens, curveStats]
  );

  const handleClaimAll = async () => {
    if (!account || claimingAll) return;
    setClaimingAll(true);
    setClaimMsg('');
    let claimed = 0;
    try {
      for (const tk of createdTokens) {
        const fees = curveStats[tk.curveId]?.creatorFeesSui ?? 0;
        if (fees < 0.001) continue;
        const capId = capMap[tk.curveId];
        if (!capId) continue;
        const tx = new Transaction();
        tx.moveCall({
          target: `${tk.packageId}::bonding_curve::claim_creator_fees`,
          typeArguments: [tk.tokenType],
          arguments: [
            tx.object(tk.curveId),
            tx.object(capId),
          ],
        });
        const result = await dAppKit.signAndExecuteTransaction({ transaction: tx });
        if (result.$kind === 'Transaction') claimed++;
      }
      setClaimMsg(claimed > 0 ? `Claimed from ${claimed} token${claimed !== 1 ? 's' : ''} ✓` : 'Nothing to claim');
    } catch (e) {
      setClaimMsg(e.message || 'Claim failed');
    } finally {
      setClaimingAll(false);
      setTimeout(() => setClaimMsg(''), 4000);
    }
  };

  if (!account) return <div className="text-xs font-mono text-white/30 text-center py-12">{t(lang, 'connectToView')}</div>;
  if (loading) return <div className="text-xs font-mono text-white/30 text-center py-12">Loading…</div>;
  if (!createdTokens.length) return <div className="text-xs font-mono text-white/20 text-center py-12">{t(lang, 'noCreated')}</div>;

  return (
    <>
      {totalClaimable > 0.001 && (
        <div className="px-5 py-3 border-b border-white/5 flex items-center justify-between">
          <span className="text-[10px] font-mono text-white/40">
            {fmt(totalClaimable, 4)} SUI claimable
          </span>
          <button
            onClick={handleClaimAll}
            disabled={claimingAll}
            className="text-[10px] font-mono text-lime-400 hover:text-lime-300 disabled:text-white/20 transition-colors"
          >
            {claimingAll ? 'Claiming…' : 'Claim all'}
          </button>
        </div>
      )}
      {claimMsg && (
        <div className="px-5 py-2 text-[10px] font-mono text-lime-400 border-b border-white/5">{claimMsg}</div>
      )}
      <div className="px-5 py-3 border-b border-white/5">
        <span className="text-[10px] font-mono text-white/30">{createdTokens.length} token{createdTokens.length !== 1 ? 's' : ''} launched</span>
      </div>
      {createdTokens.map((tk) => {
        const stats = curveStats[tk.curveId] ?? {};
        return (
          <TokenRow key={tk.curveId} token={tk} iconUrl={iconUrls[tk.curveId]}
            onClick={() => navigate(`/token/${tk.curveId}`)}
            right={
              <div className="text-right shrink-0 space-y-0.5">
                <div className="text-xs font-mono font-bold text-lime-400">{fmt(stats.volumeSui, 2)} SUI vol</div>
                <div className="text-[10px] font-mono text-white/30">{stats.trades ?? 0} trades</div>
                {stats.graduated
                  ? <div className="text-[9px] font-mono text-emerald-400">GRAD</div>
                  : <div className="text-[9px] font-mono text-white/20">{fmt(stats.progress, 1)}%</div>
                }
                {(stats.creatorFeesSui ?? 0) > 0.001 && (
                  <div className="text-[9px] font-mono text-lime-400/70">{fmt(stats.creatorFeesSui, 4)} claimable</div>
                )}
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
  const account    = useCurrentAccount();
  const { tokens } = useTokenList();
  const navigate   = useNavigate();
  const { walletAddress } = useParams();

  // walletAddress from URL params takes priority; fall back to connected wallet
  const viewAddress = walletAddress || account?.address;
  const isOwnWallet = !walletAddress || (account?.address && walletAddress.toLowerCase() === account.address.toLowerCase());

  // Fake account object so tabs work with any address
  const viewAccount = viewAddress ? { address: viewAddress } : null;

  const [tab, setTab]               = useState('holdings');
  const [suiUsd, setSuiUsd]         = useState(0);
  const [totalValueSui, setTotalValueSui] = useState(0);
  const [pfpUrl, setPfpUrl]         = useState('');
  const [editingPfp, setEditingPfp] = useState(false);
  const [pfpInput, setPfpInput]     = useState('');

  useEffect(() => {
    if (viewAddress) setPfpUrl(getPfp(viewAddress));
  }, [viewAddress]);

  useEffect(() => {
    async function fetchPrice() {
      try {
        const r = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=SUIUSDT');
        const j = await r.json();
        setSuiUsd(parseFloat(j.price) || 0);
      } catch {
        try {
          const r = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=sui&vs_currencies=usd');
          const j = await r.json();
          setSuiUsd(j?.sui?.usd || 0);
        } catch {}
      }
    }
    fetchPrice();
    const timer = setInterval(fetchPrice, 30_000);
    return () => clearInterval(timer);
  }, []);

  function savePfp() {
    const url = pfpInput.trim();
    if (url && viewAddress) { setPfp(viewAddress, url); setPfpUrl(url); }
    setEditingPfp(false);
    setPfpInput('');
  }

  const TABS = [
    { id: 'holdings', label: t(lang, 'holdings'), icon: <Wallet size={11} /> },
    { id: 'traded',   label: t(lang, 'traded'),   icon: <TrendingUp size={11} /> },
    { id: 'created',  label: t(lang, 'created'),  icon: <Plus size={11} /> },
  ];

  if (!viewAddress) {
    return (
      <div>
        <button onClick={onBack} className="flex items-center gap-2 text-xs font-mono text-white/40 hover:text-white mb-6 transition-colors">
          <ArrowLeft size={12} /> {t(lang, 'backToHome')}
        </button>
        <div className="max-w-2xl mx-auto">
          <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-8 text-center">
            <div className="text-sm font-mono text-white/30">{t(lang, 'connectToView')}</div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div>
      <button onClick={onBack} className="flex items-center gap-2 text-xs font-mono text-white/40 hover:text-white mb-6 transition-colors">
        <ArrowLeft size={12} /> {t(lang, 'backToHome')}
      </button>

      <div className="max-w-2xl mx-auto space-y-4">

        {/* Viewing someone else banner */}
        {!isOwnWallet && (
          <div className="rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3 text-[10px] font-mono text-white/40 text-center">
            Viewing portfolio for <span className="text-lime-400">{viewAddress.slice(0, 8)}…{viewAddress.slice(-6)}</span>
          </div>
        )}

        {/* Profile card */}
        <div className="rounded-2xl border border-white/10 bg-white/[0.03] overflow-hidden">
          <div className="px-5 py-4 border-b border-white/5 flex items-center gap-4">
            {/* PFP */}
            <div className="relative">
              <div className="w-14 h-14 rounded-full border border-white/10 overflow-hidden flex items-center justify-center bg-lime-950/30">
                {pfpUrl
                  ? <img src={pfpUrl} alt="pfp" className="w-full h-full object-cover" onError={() => setPfpUrl('')} />
                  : <div className="text-2xl">👤</div>
                }
              </div>
              {isOwnWallet && (
                <button
                  onClick={() => setEditingPfp(v => !v)}
                  className="absolute -bottom-1 -right-1 w-5 h-5 rounded-full bg-lime-400 text-black text-[8px] font-bold flex items-center justify-center hover:bg-lime-300 transition-colors"
                >✎</button>
              )}
            </div>

            <div className="flex-1 min-w-0">
              <div className="text-xs font-mono text-white/60 truncate">
                {viewAddress.slice(0, 16)}…{viewAddress.slice(-8)}
              </div>
              {suiUsd > 0 && totalValueSui > 0 && (
                <div className="text-sm font-mono font-bold text-lime-400 mt-0.5">
                  ~${(totalValueSui * suiUsd).toFixed(2)} USD
                </div>
              )}
            </div>

            {isOwnWallet && (
              <button
                onClick={() => { navigator.clipboard.writeText(viewAddress).catch(() => {}); }}
                className="text-[9px] font-mono text-white/30 hover:text-white/60 transition-colors"
              >
                COPY
              </button>
            )}
          </div>

          {/* PFP edit */}
          {editingPfp && isOwnWallet && (
            <div className="px-5 py-3 border-b border-white/5 flex gap-2">
              <input
                value={pfpInput}
                onChange={e => setPfpInput(e.target.value)}
                placeholder="Paste image URL…"
                className="flex-1 bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 text-xs font-mono text-white placeholder-white/20 focus:outline-none focus:border-lime-400/40"
                onKeyDown={e => e.key === 'Enter' && savePfp()}
              />
              <button onClick={savePfp} className="px-3 py-1.5 bg-lime-400 text-black text-xs font-mono font-bold rounded-lg hover:bg-lime-300 transition-colors">Save</button>
            </div>
          )}

          {/* Tab bar */}
          <div className="flex border-b border-white/5">
            {TABS.map(tb => (
              <button
                key={tb.id}
                onClick={() => setTab(tb.id)}
                className={`flex-1 flex items-center justify-center gap-1.5 py-3 text-[10px] font-mono font-bold tracking-wider transition-colors ${
                  tab === tb.id
                    ? 'text-lime-400 border-b-2 border-lime-400 bg-lime-400/5'
                    : 'text-white/30 hover:text-white/60'
                }`}
              >
                {tb.icon}
                {tb.label}
              </button>
            ))}
          </div>

          {/* Tab content */}
          <div>
            {tab === 'holdings' && (
              <HoldingsTab
                account={viewAccount}
                tokens={tokens}
                lang={lang}
                onTotalValue={setTotalValueSui}
              />
            )}
            {tab === 'traded' && (
              <TradedTab
                account={viewAccount}
                tokens={tokens}
                lang={lang}
              />
            )}
            {tab === 'created' && (
              <CreatedTab
                account={viewAccount}
                tokens={tokens}
                lang={lang}
              />
            )}
          </div>
        </div>

        <div className="text-[9px] font-mono text-white/15 text-center">
          {t(lang, 'valuesEstimate')}
        </div>
      </div>
    </div>
  );
}
