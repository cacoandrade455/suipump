// v17-indexer-claimall
// PortfolioPage.jsx
import React, { useState, useEffect, useMemo } from 'react';
import { useCurrentAccount, useSuiClient, useSignAndExecuteTransaction } from '@mysten/dapp-kit';
import { useNavigate } from 'react-router-dom';
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

function HoldingsTab({ account, tokens, client, lang, onTotalValue }) {
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
        // ── Indexer path ──────────────────────────────────────────────────
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

        const results = await Promise.all(
          tokens.filter(tk => tk.tokenType).map(async (token) => {
            try {
              const balance = await client.getBalance({ owner: account.address, coinType: token.tokenType });
              const rawBalance = BigInt(balance.totalBalance ?? '0');
              if (rawBalance === 0n) return null;

              let reserveMist = 0n, tokensRemaining = 0n, graduated = false;

              // Use indexer stats if available
              const idx = tokenStats[token.curveId];
              if (idx) {
                reserveMist = BigInt(Math.floor((idx.reserve_sui ?? 0) * MIST_PER_SUI));
              } else {
                const curveObj = await client.getObject({ id: token.curveId, options: { showContent: true } });
                const fields = curveObj.data?.content?.fields;
                if (fields) {
                  reserveMist = BigInt(fields.sui_reserve ?? 0);
                  tokensRemaining = BigInt(fields.token_reserve ?? 0);
                  graduated = fields.graduated ?? false;
                }
              }

              const tokensSold = BigInt(800_000_000) * 10n ** BigInt(TOKEN_DECIMALS) - tokensRemaining;
              const priceMist = priceMistPerToken(reserveMist, tokensSold);
              const valueInMist = (rawBalance * priceMist) / (10n ** BigInt(TOKEN_DECIMALS));
              const valueSui = Number(valueInMist) / MIST_PER_SUI;
              const balanceWhole = Number(rawBalance) / 10 ** TOKEN_DECIMALS;

              return { ...token, balance: balanceWhole, valueSui, graduated };
            } catch { return null; }
          })
        );

        if (cancelled) return;
        const valid = results.filter(Boolean).sort((a, b) => b.valueSui - a.valueSui);
        const total = valid.reduce((s, h) => s + h.valueSui, 0);
        setHoldings(valid);
        onTotalValue(total);

        // Load icons
        const icons = {};
        await Promise.all(valid.map(async (h) => {
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

function TradedTab({ account, tokens, client, lang }) {
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

        // ── Indexer path ──────────────────────────────────────────────────
        if (INDEXER_URL) {
          try {
            const res = await fetch(`${INDEXER_URL}/trader/${addr}`, { signal: AbortSignal.timeout(5000) });
            if (res.ok) {
              const rows = await res.json();
              if (rows.length > 0) {
                const enriched = rows.map(r => {
                  const meta = tokens.find(tk => tk.curveId === r.curve_id);
                  return {
                    curveId:      r.curve_id,
                    name:         meta?.name  || r.name  || 'Unknown',
                    symbol:       meta?.symbol || r.symbol || '???',
                    tokenType:    meta?.tokenType || null,
                    suiSpent:     r.sui_spent    ?? 0,
                    suiReceived:  r.sui_received ?? 0,
                    buys:         r.buys         ?? 0,
                    sells:        r.sells        ?? 0,
                    realizedPnl:  (r.sui_received ?? 0) - (r.sui_spent ?? 0),
                    isClosed:     (r.net_tokens ?? 0) <= 0.001,
                    avgEntryPrice: r.avg_entry_price ?? 0,
                  };
                }).sort((a, b) => (b.suiSpent + b.suiReceived) - (a.suiSpent + a.suiReceived));
                if (!cancelled) { setTradedTokens(enriched); setLoading(false); }

                // load icons
                const icons = {};
                await Promise.all(enriched.map(async (tk) => {
                  if (!tk.tokenType) return;
                  try { const m = await client.getCoinMetadata({ coinType: tk.tokenType }); if (m?.iconUrl) icons[tk.curveId] = m.iconUrl; } catch {}
                }));
                if (!cancelled) setIconUrls(icons);
                return;
              }
            }
          } catch {}
        }

        // ── RPC fallback ──────────────────────────────────────────────────
        const buyTypes  = ALL_PACKAGE_IDS.map(p => `${p}::bonding_curve::TokensPurchased`);
        const sellTypes = ALL_PACKAGE_IDS.map(p => `${p}::bonding_curve::TokensSold`);
        const eventMap  = await paginateMultipleEvents(client, [...buyTypes, ...sellTypes], { order: 'descending', maxPages: 50 });
        if (cancelled) return;

        const curveVolume = {};
        for (const bt of buyTypes) {
          for (const e of (eventMap[bt] || [])) {
            if (e.parsedJson?.buyer !== addr) continue;
            const id = e.parsedJson.curve_id;
            if (!curveVolume[id]) curveVolume[id] = { suiSpent: 0, suiReceived: 0, buys: 0, sells: 0, tokensBought: 0, tokensSold: 0 };
            curveVolume[id].suiSpent    += Number(e.parsedJson.sui_in    ?? 0) / MIST_PER_SUI;
            curveVolume[id].tokensBought += Number(e.parsedJson.tokens_out ?? 0) / 10**TOKEN_DECIMALS;
            curveVolume[id].buys += 1;
          }
        }
        for (const st of sellTypes) {
          for (const e of (eventMap[st] || [])) {
            if (e.parsedJson?.seller !== addr) continue;
            const id = e.parsedJson.curve_id;
            if (!curveVolume[id]) curveVolume[id] = { suiSpent: 0, suiReceived: 0, buys: 0, sells: 0, tokensBought: 0, tokensSold: 0 };
            curveVolume[id].suiReceived += Number(e.parsedJson.sui_out   ?? 0) / MIST_PER_SUI;
            curveVolume[id].tokensSold  += Number(e.parsedJson.tokens_in ?? 0) / 10**TOKEN_DECIMALS;
            curveVolume[id].sells += 1;
          }
        }

        const curveIds = Object.keys(curveVolume);
        if (!curveIds.length) { if (!cancelled) { setTradedTokens([]); setLoading(false); } return; }

        const enriched = curveIds.map(curveId => {
          const meta  = tokens.find(tk => tk.curveId === curveId);
          const stats = curveVolume[curveId];
          return {
            curveId,
            name:          meta?.name   || 'Unknown',
            symbol:        meta?.symbol || '???',
            tokenType:     meta?.tokenType || null,
            suiSpent:      stats.suiSpent,
            suiReceived:   stats.suiReceived,
            buys:          stats.buys,
            sells:         stats.sells,
            realizedPnl:   stats.suiReceived - stats.suiSpent,
            avgEntryPrice: stats.tokensBought > 0 ? stats.suiSpent / stats.tokensBought : 0,
            isClosed:      (stats.tokensBought - stats.tokensSold) <= 0.001,
          };
        }).sort((a, b) => (b.suiSpent + b.suiReceived) - (a.suiSpent + a.suiReceived));

        if (!cancelled) { setTradedTokens(enriched); setLoading(false); }

        const icons = {};
        await Promise.all(enriched.map(async (tk) => {
          if (!tk.tokenType) return;
          try { const m = await client.getCoinMetadata({ coinType: tk.tokenType }); if (m?.iconUrl) icons[tk.curveId] = m.iconUrl; } catch {}
        }));
        if (!cancelled) setIconUrls(icons);

      } catch { if (!cancelled) setLoading(false); }
    }
    load();
    return () => { cancelled = true; };
  }, [account?.address, tokens.length, client]);

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

function CreatedTab({ account, tokens, client, lang }) {
  const navigate = useNavigate();
  const { mutate: signAndExecute } = useSignAndExecuteTransaction();
  const [curveStats, setCurveStats]   = useState({});
  const [capMap, setCapMap]           = useState({}); // curveId → capId
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
        // Load curve stats (indexer first, RPC fallback)
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
          const tk  = createdTokens[i];
          if (!obj?.data?.content?.fields) continue;
          const fields = obj.data.content.fields;
          const reserveMist  = BigInt(fields.sui_reserve ?? 0);
          const reserveSui   = mistToSui(reserveMist);
          const progress     = Math.min(100, (reserveSui / DRAIN_SUI_APPROX) * 100);
          const creatorFeesSui = Number(BigInt(fields.creator_fees ?? 0)) / MIST_PER_SUI;
          stats[tk.curveId]  = { progress, reserveSui, creatorFeesSui, graduated: fields.graduated ?? false, tokenType: tk.tokenType, packageId: tk.packageId };
        }
        setCurveStats(stats);

        // Load CreatorCaps owned by this wallet
        const caps = {};
        await Promise.all(createdTokens.map(async (tk) => {
          try {
            const ownedObjs = await client.getOwnedObjects({
              owner: account.address,
              filter: { StructType: `${tk.packageId}::bonding_curve::CreatorCap` },
              options: { showContent: true },
            });
            const capObj = ownedObjs.data?.find(o => o.data?.content?.fields?.curve_id === tk.curveId)
              ?? ownedObjs.data?.[0];
            if (capObj?.data?.objectId) caps[tk.curveId] = capObj.data.objectId;
          } catch {}
        }));
        setCapMap(caps);

        const icons = {};
        for (const { curveId, iconUrl } of iconResults) { if (iconUrl) icons[curveId] = iconUrl; }
        setIconUrls(icons);
      } catch {}
      finally { if (!cancelled) setLoading(false); }
    }
    load();
    return () => { cancelled = true; };
  }, [createdTokens.length, client, account?.address]);

  // Total claimable fees
  const totalClaimableSui = useMemo(() => {
    return Object.values(curveStats).reduce((s, stat) => s + (stat.creatorFeesSui >= 0.001 ? stat.creatorFeesSui : 0), 0);
  }, [curveStats]);

  // Claim all fees in one PTB
  const handleClaimAll = async () => {
    const claimable = createdTokens.filter(tk => {
      const s = curveStats[tk.curveId];
      return s && s.creatorFeesSui >= 0.001 && capMap[tk.curveId];
    });
    if (!claimable.length) return;

    setClaimingAll(true);
    setClaimMsg('');
    try {
      // Verify on-chain fees before building PTB — avoids ENoFees abort
      const verified = await Promise.all(claimable.map(async (tk) => {
        try {
          const obj = await client.getObject({ id: tk.curveId, options: { showContent: true } });
          const f = obj.data?.content?.fields;
          // creator_fees is Balance<SUI> — serialized as { value: "123" } or plain string
          const raw = f?.creator_fees;
          const fees = typeof raw === 'object' ? Number(raw?.value ?? 0) : Number(raw ?? 0);
          return fees > 0 ? tk : null;
        } catch { return null; }
      }));
      const actualClaimable = verified.filter(Boolean);
      if (!actualClaimable.length) {
        setClaimMsg('No fees available on-chain');
        setClaimingAll(false);
        return;
      }
      const tx = new Transaction();
      for (const tk of actualClaimable) {
        const pkgId   = tk.packageId;
        const capId   = capMap[tk.curveId];
        const objForRef = await client.getObject({ id: tk.curveId, options: { showOwner: true } });
        const initVer   = objForRef.data?.owner?.Shared?.initial_shared_version;
        const curveRef  = initVer
          ? tx.sharedObjectRef({ objectId: tk.curveId, initialSharedVersion: initVer, mutable: true })
          : tx.object(tk.curveId);
        tx.moveCall({
          target: `${pkgId}::bonding_curve::claim_creator_fees`,
          typeArguments: [tk.tokenType],
          arguments: [tx.object(capId), curveRef],
        });
      }
      signAndExecute(
        { transaction: tx },
        {
          onSuccess: () => {
            setClaimMsg(`✅ Claimed fees from ${actualClaimable.length} token${actualClaimable.length !== 1 ? 's' : ''}`);
            setClaimingAll(false);
            setTimeout(() => setClaimMsg(''), 4000);
            // Refresh stats
            setCurveStats(prev => {
              const next = { ...prev };
              for (const tk of actualClaimable) next[tk.curveId] = { ...next[tk.curveId], creatorFeesSui: 0 };
              return next;
            });
          },
          onError: (err) => {
            setClaimMsg(err.message || 'Claim failed');
            setClaimingAll(false);
            setTimeout(() => setClaimMsg(''), 4000);
          },
        }
      );
    } catch (err) {
      setClaimMsg(err.message || 'Claim failed');
      setClaimingAll(false);
    }
  };

  if (!account) return <div className="text-xs font-mono text-white/30 text-center py-12">{t(lang, 'connectToView')}</div>;
  if (loading) return <div className="text-xs font-mono text-white/30 text-center py-12">Loading…</div>;
  if (!createdTokens.length) return <div className="text-xs font-mono text-white/20 text-center py-12">{t(lang, 'noCreated')}</div>;

  return (
    <>
      {/* ── Claim All banner ── */}
      <div className="px-5 py-3 border-b border-white/5 space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-[10px] font-mono text-white/30">
            {createdTokens.length} token{createdTokens.length !== 1 ? 's' : ''} launched
          </span>
          {totalClaimableSui > 0 && (
            <span className="text-[10px] font-mono text-lime-400/70">
              {fmt(totalClaimableSui, 4)} SUI claimable
            </span>
          )}
        </div>
        {totalClaimableSui > 0 && (
          <button
            onClick={handleClaimAll}
            disabled={claimingAll}
            className={`w-full py-2.5 rounded-xl text-xs font-mono font-bold tracking-widest transition-colors ${
              claimingAll
                ? 'bg-white/5 text-white/20 cursor-not-allowed'
                : 'bg-lime-400/10 border border-lime-400/30 text-lime-400 hover:bg-lime-400/20'
            }`}
          >
            {claimingAll ? 'CLAIMING…' : `CLAIM ALL FEES — ${fmt(totalClaimableSui, 4)} SUI`}
          </button>
        )}
        {claimMsg && (
          <div className={`text-[10px] font-mono text-center ${claimMsg.startsWith('✅') ? 'text-lime-400' : 'text-red-400'}`}>
            {claimMsg}
          </div>
        )}
      </div>

      {/* ── Token rows ── */}
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
                    {s.creatorFeesSui > 0 && <div className="text-[9px] font-mono text-lime-400">{fmt(s.creatorFeesSui, 3)} fees</div>}
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

// ── PNL Share Card (canvas) ───────────────────────────────────────────────────

function drawPnlCard({ canvas, name, symbol, pnlSui, pnlPct, spent, entryPrice, currentPrice, isClosed, mascotImg }) {
  const ctx = canvas.getContext('2d');
  const W = 800, H = 420;
  canvas.width = W; canvas.height = H;
  ctx.fillStyle = '#080808'; ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = 'rgba(132,204,22,0.04)'; ctx.lineWidth = 1;
  for (let x = 0; x < W; x += 40) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
  for (let y = 0; y < H; y += 40) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }
  const grd = ctx.createRadialGradient(0, 0, 0, 0, 0, 300);
  grd.addColorStop(0, 'rgba(132,204,22,0.12)'); grd.addColorStop(1, 'rgba(132,204,22,0)');
  ctx.fillStyle = grd; ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = 'rgba(132,204,22,0.25)'; ctx.lineWidth = 1.5; ctx.strokeRect(1, 1, W - 2, H - 2);
  const isPos = pnlSui >= 0;
  const accentColor = isPos ? '#84cc16' : '#f87171';
  ctx.font = 'bold 22px "JetBrains Mono", monospace'; ctx.fillStyle = 'rgba(255,255,255,0.9)'; ctx.fillText(name, 48, 64);
  ctx.font = '15px "JetBrains Mono", monospace'; ctx.fillStyle = '#84cc16'; ctx.fillText('$' + symbol, 48, 88);
  const pctText = (isPos ? '+' : '') + pnlPct.toFixed(2) + '%';
  ctx.font = 'bold 96px "JetBrains Mono", monospace'; ctx.fillStyle = accentColor;
  ctx.shadowColor = accentColor; ctx.shadowBlur = 32; ctx.fillText(pctText, 44, 210); ctx.shadowBlur = 0;
  const pnlText = (isPos ? '+' : '') + Math.abs(pnlSui).toFixed(3) + ' SUI ' + (isClosed ? 'REALIZED' : 'TOTAL PNL');
  ctx.font = '18px "JetBrains Mono", monospace'; ctx.fillStyle = 'rgba(255,255,255,0.5)'; ctx.fillText(pnlText, 48, 248);
  ctx.strokeStyle = 'rgba(255,255,255,0.07)'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(48, 272); ctx.lineTo(W - 48, 272); ctx.stroke();
  ctx.font = '13px "JetBrains Mono", monospace'; ctx.fillStyle = 'rgba(255,255,255,0.3)';
  ctx.fillText('INVESTED', 48, 300); ctx.fillText('ENTRY', 220, 300); ctx.fillText('CURRENT', 390, 300);
  ctx.fillStyle = 'rgba(255,255,255,0.7)'; ctx.font = '14px "JetBrains Mono", monospace';
  ctx.fillText(spent.toFixed(2) + ' SUI', 48, 320);
  ctx.fillText(entryPrice > 0 ? entryPrice.toFixed(8) : '—', 220, 320);
  ctx.fillText(currentPrice > 0 ? currentPrice.toFixed(8) : '—', 390, 320);
  ctx.font = 'bold 15px "JetBrains Mono", monospace'; ctx.fillStyle = '#84cc16'; ctx.fillText('SUIPUMP', 48, H - 32);
  ctx.font = '13px "JetBrains Mono", monospace'; ctx.fillStyle = 'rgba(255,255,255,0.2)'; ctx.fillText('suipump.org', 48, H - 14);
  const badge = isClosed ? 'CLOSED' : 'ACTIVE';
  ctx.fillStyle = isClosed ? 'rgba(255,255,255,0.1)' : 'rgba(132,204,22,0.15)';
  ctx.beginPath(); ctx.roundRect(W - 130, 44, 82, 26, 6); ctx.fill();
  ctx.font = 'bold 11px "JetBrains Mono", monospace';
  ctx.fillStyle = isClosed ? 'rgba(255,255,255,0.3)' : '#84cc16'; ctx.fillText(badge, W - 112, 62);
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

// ── Main ──────────────────────────────────────────────────────────────────────

export default function PortfolioPage({ onBack, lang = 'en' }) {
  const account    = useCurrentAccount();
  const client     = useSuiClient();
  const { tokens } = useTokenList();
  const [tab, setTab]               = useState('holdings');
  const [suiUsd, setSuiUsd]         = useState(0);
  const [totalValueSui, setTotalValueSui] = useState(0);

  React.useEffect(() => {
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

  const TABS = [
    { id: 'holdings', label: t(lang, 'holdings'), icon: <Wallet size={11} /> },
    { id: 'traded',   label: t(lang, 'traded'),   icon: <TrendingUp size={11} /> },
    { id: 'created',  label: t(lang, 'created'),  icon: <Plus size={11} /> },
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
            {account ? (
              <>
                <div className="text-[10px] font-mono text-white/35 break-all mb-3">{account.address}</div>
                {totalValueSui > 0 && (
                  <div className="flex items-baseline gap-2">
                    {suiUsd > 0 && (
                      <span className="text-2xl font-bold text-white" style={{ fontFamily: "'Space Grotesk', sans-serif" }}>
                        ${(totalValueSui * suiUsd).toLocaleString(undefined, { maximumFractionDigits: 2 })}
                      </span>
                    )}
                    <span className="text-sm font-mono text-white/40">{totalValueSui.toFixed(4)} SUI</span>
                  </div>
                )}
              </>
            ) : (
              <div className="text-sm font-mono text-white/30">{t(lang, 'connectToView')}</div>
            )}
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
          {tab === 'holdings' && <HoldingsTab account={account} tokens={tokens} client={client} lang={lang} onTotalValue={setTotalValueSui} />}
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
