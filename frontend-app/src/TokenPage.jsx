// TokenPage.jsx
import React, { useState, useMemo, useEffect } from 'react';
import {
  useCurrentAccount,
  useSignAndExecuteTransaction,
  useSuiClient,
  useSuiClientQuery,
} from '@mysten/dapp-kit';
import { Transaction } from '@mysten/sui/transactions';
import { Crown, Rocket, ExternalLink, ArrowLeft, Trophy, Droplets, Globe, MessageCircle, Copy, Check } from 'lucide-react';

import { PACKAGE_ID, DRAIN_SUI_APPROX, TOKEN_DECIMALS, MIST_PER_SUI } from './constants.js';
import { quoteBuy, quoteSell, priceMistPerToken, mistToSui, tokenUnitsToWhole } from './curve.js';
import PriceChart from './PriceChart.jsx';
import HolderList from './HolderList.jsx';
import TradeHistory from './TradeHistory.jsx';
import Comments from './Comments.jsx';

function fmt(n, d = 2) {
  if (n == null) return '—';
  if (!Number.isFinite(n)) return '—';
  if (n >= 1e9) return (n / 1e9).toFixed(d) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(d) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(d) + 'k';
  if (n !== 0 && Math.abs(n) < 0.0001) return n.toExponential(2);
  return n.toFixed(d);
}
const fmtSui = (mist) => fmt(mistToSui(mist ?? 0), 4);

function parseDescriptionLinks(raw) {
  if (!raw) return { description: '', links: {} };
  const idx = raw.indexOf('||');
  if (idx === -1) return { description: raw, links: {} };
  const desc = raw.slice(0, idx);
  try {
    const links = JSON.parse(raw.slice(idx + 2));
    return { description: desc, links: links || {} };
  } catch {
    return { description: raw, links: {} };
  }
}

function XIcon({ size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/>
    </svg>
  );
}

function SocialLinks({ links }) {
  if (!links) return null;
  const items = [];
  if (links.telegram) items.push({ label: 'Telegram', url: links.telegram, icon: <MessageCircle size={12} /> });
  if (links.twitter) items.push({ label: 'X', url: links.twitter, icon: <XIcon size={12} /> });
  if (links.website) items.push({ label: 'Website', url: links.website, icon: <Globe size={12} /> });
  if (items.length === 0) return null;
  return (
    <div className="flex gap-2 mt-2">
      {items.map(({ label, url, icon }) => (
        <a key={label} href={url} target="_blank" rel="noreferrer"
          className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-white/10 text-[10px] font-mono text-white/40 hover:border-lime-400/40 hover:text-lime-400 transition-all">
          {icon} {label}
        </a>
      ))}
    </div>
  );
}

// (#5) Copy-to-clipboard button with checkmark feedback
function CopyButton({ text, label }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = (e) => {
    e.stopPropagation();
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }).catch(() => {});
  };
  return (
    <button onClick={handleCopy}
      className="flex items-center gap-1 text-[10px] font-mono text-white/30 hover:text-lime-400 transition-colors"
      title={`Copy ${label}`}>
      {copied ? <Check size={10} className="text-lime-400" /> : <Copy size={10} />}
      {copied ? 'COPIED' : label}
    </button>
  );
}

export default function TokenPage({ curveId, tokenType, onBack }) {
  const account = useCurrentAccount();
  const client = useSuiClient();
  const { mutateAsync: signAndExecute, isPending } = useSignAndExecuteTransaction();

  const [amount, setAmount] = useState('');
  const [side, setSide] = useState('buy');
  const [status, setStatus] = useState(null);
  const [metadata, setMetadata] = useState(null);
  const [chartRefresh, setChartRefresh] = useState(0);
  const [creatorCapId, setCreatorCapId] = useState(null);
  const [claiming, setClaiming] = useState(false);
  const [graduationData, setGraduationData] = useState(null);
  const [suiUsd, setSuiUsd] = useState(0);

  // Fetch SUI/USD price for USD display
  useEffect(() => {
    async function loadPrice() {
      try {
        const r = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=SUIUSDT');
        const j = await r.json();
        setSuiUsd(parseFloat(j.price) || 0);
      } catch {
        try {
          const r = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=sui&vs_currencies=usd');
          const j = await r.json();
          setSuiUsd(j?.sui?.usd || 0);
        } catch { setSuiUsd(0); }
      }
    }
    loadPrice();
    const t = setInterval(loadPrice, 30_000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (!account?.address) return;
    let cancelled = false;
    async function findCap() {
      try {
        const owned = await client.getOwnedObjects({
          owner: account.address,
          filter: { StructType: `${PACKAGE_ID}::bonding_curve::CreatorCap` },
          options: { showContent: true },
        });
        for (const obj of owned.data) {
          const capCurveId = obj.data?.content?.fields?.curve_id;
          if (capCurveId === curveId) { if (!cancelled) setCreatorCapId(obj.data.objectId); return; }
        }
        if (!cancelled) setCreatorCapId(null);
      } catch { }
    }
    findCap();
    return () => { cancelled = true; };
  }, [account?.address, curveId, client]);

  const claimFees = async () => {
    if (!creatorCapId || !account) return;
    setClaiming(true); setStatus(null);
    try {
      const tx = new Transaction();
      const curveObj = await client.getObject({ id: curveId, options: { showOwner: true } });
      const initialSharedVersion = curveObj.data?.owner?.Shared?.initial_shared_version;
      tx.moveCall({
        target: `${PACKAGE_ID}::bonding_curve::claim_creator_fees`,
        typeArguments: [tokenType],
        arguments: [
          tx.object(creatorCapId),
          tx.sharedObjectRef({ objectId: curveId, initialSharedVersion, mutable: true }),
        ],
      });
      const result = await signAndExecute({ transaction: tx });
      setStatus({ kind: 'success', msg: `Fees claimed!`, digest: result.digest });
      curveQuery.refetch();
    } catch (err) {
      setStatus({ kind: 'error', msg: err.message || String(err) });
    } finally { setClaiming(false); }
  };

  useEffect(() => {
    let cancelled = false;
    client.getCoinMetadata({ coinType: tokenType }).then(m => { if (!cancelled) setMetadata(m); }).catch(() => {});
    return () => { cancelled = true; };
  }, [tokenType, client]);

  useEffect(() => {
    let cancelled = false;
    async function loadGrad() {
      try {
        const events = await client.queryEvents({
          query: { MoveEventType: `${PACKAGE_ID}::bonding_curve::Graduated` },
          limit: 50, order: 'descending',
        });
        const match = events.data.find(e => e.parsedJson?.curve_id === curveId);
        if (!cancelled && match) {
          setGraduationData({
            finalReserve: Number(match.parsedJson.final_sui_reserve) / 1e9,
            creatorBonus: Number(match.parsedJson.creator_bonus) / 1e9,
            ts: Number(match.timestampMs),
            digest: match.id.txDigest,
          });
        }
      } catch { }
    }
    loadGrad();
    return () => { cancelled = true; };
  }, [curveId, client]);

  const curveQuery = useSuiClientQuery('getObject', { id: curveId, options: { showContent: true } }, { refetchInterval: 5000 });
  const balanceQuery = useSuiClientQuery('getBalance', { owner: account?.address, coinType: tokenType }, { enabled: !!account?.address, refetchInterval: 5000 });
  const suiBalanceQuery = useSuiClientQuery('getBalance', { owner: account?.address, coinType: '0x2::sui::SUI' }, { enabled: !!account?.address, refetchInterval: 5000 });

  const fields = curveQuery.data?.data?.content?.fields;
  const reserveMist = fields ? BigInt(fields.sui_reserve) : 0n;
  const tokensRemaining = fields ? BigInt(fields.token_reserve) : 0n;
  const graduated = fields?.graduated ?? false;
  const tokensSold = fields ? BigInt(800_000_000) * 10n ** BigInt(TOKEN_DECIMALS) - tokensRemaining : 0n;
  const reserveSui = mistToSui(reserveMist);
  const progress = Math.min(100, (reserveSui / DRAIN_SUI_APPROX) * 100);
  const priceMist = fields ? priceMistPerToken(reserveMist, tokensSold) : 0n;
  const priceUsd   = suiUsd > 0 ? (Number(priceMist) / 1e9) * suiUsd : null;
  const mcapUsd    = suiUsd > 0 ? (Number(priceMist) / 1e9) * suiUsd * 1_000_000_000 : null;
  const creatorFees = fields ? BigInt(fields.creator_fees) : 0n;
  const tokenBalanceWhole = balanceQuery.data ? tokenUnitsToWhole(balanceQuery.data.totalBalance) : 0;
  const suiBalanceSui = suiBalanceQuery.data ? Number(suiBalanceQuery.data.totalBalance) / 1e9 : 0;

  const { description: cleanDescription, links: socialLinks } = useMemo(
    () => parseDescriptionLinks(metadata?.description), [metadata?.description]
  );

  const quote = useMemo(() => {
    const a = parseFloat(amount);
    if (!a || a <= 0 || !fields) return null;
    try {
      if (side === 'buy') {
        const suiInMist = BigInt(Math.floor(a * MIST_PER_SUI));
        return { kind: 'buy', ...quoteBuy(suiInMist, reserveMist, tokensSold) };
      } else {
        const tokensInUnits = BigInt(Math.floor(a * 10 ** TOKEN_DECIMALS));
        return { kind: 'sell', tokensIn: tokensInUnits, ...quoteSell(tokensInUnits, reserveMist, tokensSold) };
      }
    } catch { return null; }
  }, [amount, side, reserveMist, tokensSold, fields]);

  const execute = async () => {
    if (!account || !quote) return;
    setStatus(null);
    const tx = new Transaction();
    const curveObj = await client.getObject({ id: curveId, options: { showOwner: true } });
    const initialSharedVersion = curveObj.data?.owner?.Shared?.initial_shared_version;
    const curveRef = tx.sharedObjectRef({ objectId: curveId, initialSharedVersion, mutable: true });

    if (side === 'buy') {
      const mistAmount = BigInt(Math.floor(parseFloat(amount) * MIST_PER_SUI));
      const [payment] = tx.splitCoins(tx.gas, [tx.pure.u64(mistAmount)]);
      const minOut = (quote.tokensOut * 99n) / 100n;
      const [tokens, refund] = tx.moveCall({
        target: `${PACKAGE_ID}::bonding_curve::buy`, typeArguments: [tokenType],
        arguments: [curveRef, payment, tx.pure.u64(minOut)],
      });
      tx.transferObjects([tokens, refund], account.address);
    } else {
      const coins = await client.getCoins({ owner: account.address, coinType: tokenType });
      if (coins.data.length === 0) { setStatus({ kind: 'error', msg: 'No tokens to sell.' }); return; }
      const primary = tx.object(coins.data[0].coinObjectId);
      if (coins.data.length > 1) tx.mergeCoins(primary, coins.data.slice(1).map(c => tx.object(c.coinObjectId)));
      const [toSell] = tx.splitCoins(primary, [tx.pure.u64(quote.tokensIn)]);
      const minOut = (quote.suiOut * 99n) / 100n;
      const suiOut = tx.moveCall({
        target: `${PACKAGE_ID}::bonding_curve::sell`, typeArguments: [tokenType],
        arguments: [curveRef, toSell, tx.pure.u64(minOut)],
      });
      tx.transferObjects([suiOut], account.address);
    }

    try {
      const result = await signAndExecute({ transaction: tx });
      setStatus({ kind: 'success', msg: 'Transaction confirmed', digest: result.digest });
      setAmount(''); curveQuery.refetch(); balanceQuery.refetch(); setChartRefresh(r => r + 1);
    } catch (err) { setStatus({ kind: 'error', msg: err.message || String(err) }); }
  };

  if (curveQuery.isLoading) {
    return (
      <div className="rounded-2xl border border-white/5 bg-white/[0.02] p-8 animate-pulse">
        <div className="h-4 bg-white/5 rounded w-48 mb-3" /><div className="h-3 bg-white/5 rounded w-32" />
      </div>
    );
  }

  if (!fields) return <div className="text-red-400 font-mono text-sm p-8">Could not load curve data.</div>;

  return (
    <div>
      <button onClick={onBack} className="flex items-center gap-2 text-xs font-mono text-white/40 hover:text-white mb-4 transition-colors">
        <ArrowLeft size={12} /> BACK TO ALL TOKENS
      </button>

      <div className="lg:grid lg:grid-cols-3 lg:gap-4">
        <div className="lg:col-span-2 space-y-4 mb-4 lg:mb-0">

          {/* Token header card */}
          <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
            <div className="flex items-start gap-3 mb-4">
              <div className="w-12 h-12 rounded-full overflow-hidden border-2 border-white/10 flex items-center justify-center bg-lime-950/30 shrink-0">
                {metadata?.iconUrl
                  ? <img src={metadata.iconUrl} alt={fields.symbol} className="w-full h-full object-cover"
                      onError={e => { e.target.style.display='none'; e.target.nextSibling.style.display='block'; }} />
                  : null}
                <span className="text-2xl" style={{ display: metadata?.iconUrl ? 'none' : 'block' }}>🔥</span>
              </div>
              <div className="flex-1 min-w-0">
                <h2 className="text-lg font-bold text-white truncate">{fields.name}</h2>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-lime-400/70 font-mono">${fields.symbol}</span>
                  {/* (#5) Copy CA button */}
                  <CopyButton text={curveId} label="CA" />
                </div>
                {cleanDescription && (
                  <div className="text-xs text-white/40 font-mono mt-0.5 line-clamp-2">{cleanDescription}</div>
                )}
                <SocialLinks links={socialLinks} />
              </div>
              <div className="text-right shrink-0">
                <div className="text-[9px] text-white/30 font-mono tracking-widest">PRICE</div>
                {priceUsd != null ? (
                  <>
                    <div className="text-base font-bold text-lime-400 font-mono">
                      {priceUsd >= 0.01
                        ? `$${priceUsd.toFixed(4)}`
                        : priceUsd >= 1e-6
                          ? `$${priceUsd.toFixed(8)}`
                          : `$${priceUsd.toPrecision(4)}`}
                    </div>
                    <div className="text-[10px] text-white/30 font-mono">
                      {Number.isFinite(Number(priceMist)) ? (Number(priceMist)/1e9).toFixed(9) : '0'} SUI
                    </div>
                  </>
                ) : (
                  <>
                    <div className="text-base font-bold text-white font-mono">
                      {Number.isFinite(Number(priceMist)) ? (Number(priceMist) / 1e9).toFixed(9) : '0.000000000'}
                    </div>
                    <div className="text-[10px] text-white/40 font-mono">SUI</div>
                  </>
                )}
              </div>
            </div>

            {/* Bonding curve progress */}
            <div className="border-t border-white/5 pt-3">
              <div className="flex justify-between items-center mb-2">
                <div className="flex items-center gap-2 text-xs font-mono tracking-widest text-lime-400">
                  <Rocket size={11} /> BONDING CURVE {graduated ? '· GRADUATED ✓' : ''}
                </div>
                <div className="text-xs font-mono text-white/50">{fmt(reserveSui)} / ~{fmt(DRAIN_SUI_APPROX)} SUI</div>
              </div>
              <div className="h-2 bg-white/5 rounded-full overflow-hidden">
                <div className="h-full bg-gradient-to-r from-lime-600 via-lime-400 to-lime-300 rounded-full transition-all duration-500"
                  style={{ width: `${Math.max(progress, 0.5)}%` }} />
              </div>
            </div>

            {/* Price chart */}
            <div className="border-t border-white/5 pt-4 mt-3">
              <PriceChart curveId={curveId} refreshKey={chartRefresh} />
            </div>
          </div>

          <TradeHistory curveId={curveId} symbol={fields.symbol} refreshKey={chartRefresh} />
          <Comments curveId={curveId} tokenType={tokenType} />

          {/* Creator revenue */}
          <div className="rounded-2xl border border-amber-500/20 bg-amber-950/10 p-4">
            <div className="flex items-center justify-between">
              <div className="flex-1 min-w-0 mr-4">
                <div className="flex items-center gap-2 text-xs font-mono tracking-widest text-amber-400 mb-2">
                  <Crown size={12} /> CREATOR REVENUE · 40% OF 1% FEES
                </div>
                <div className="text-[10px] font-mono text-white/30 mb-0.5">CREATOR</div>
                <div className="text-xs font-mono text-white/50 truncate">{fields.creator}</div>
              </div>
              <div className="text-right shrink-0">
                <div className="text-[10px] font-mono text-white/30 mb-0.5">ACCRUED</div>
                <div className="text-2xl font-bold text-amber-300 font-mono tabular-nums">{fmtSui(creatorFees)}</div>
                <div className="text-xs text-amber-600 font-mono mb-2">SUI</div>
                {creatorCapId && creatorFees > 0n && (
                  <button onClick={claimFees} disabled={claiming}
                    className="px-3 py-1.5 bg-amber-400 text-black text-xs font-mono tracking-widest hover:bg-amber-300 disabled:opacity-50 rounded-xl transition-colors">
                    {claiming ? 'CLAIMING…' : 'CLAIM FEES'}
                  </button>
                )}
                {creatorCapId && creatorFees === 0n && <div className="text-[10px] font-mono text-amber-900">NO FEES YET</div>}
              </div>
            </div>
          </div>

          <HolderList curveId={curveId} refreshKey={chartRefresh} />

          <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4 flex items-center justify-between text-xs font-mono mb-24 lg:mb-0">
            <span className="text-white/30 tracking-widest">YOUR ${fields.symbol}</span>
            <span className="text-white font-bold">{fmt(tokenBalanceWhole)} {fields.symbol}</span>
          </div>

          {status && (
            <div className={`rounded-2xl border p-3 text-xs font-mono ${
              status.kind === 'success' ? 'border-lime-500/30 bg-lime-950/20 text-lime-300' : 'border-red-500/30 bg-red-950/20 text-red-300'
            }`}>
              {status.msg}
              {status.digest && (
                <a href={`https://testnet.suivision.xyz/txblock/${status.digest}`} target="_blank" rel="noreferrer"
                  className="ml-2 underline inline-flex items-center gap-1">view tx <ExternalLink size={10} /></a>
              )}
            </div>
          )}
        </div>

        {/* Desktop trade panel */}
        <div className="hidden lg:block">
          {graduated ? (
            <div className="space-y-4 h-fit sticky top-20">
              <div className="rounded-2xl border border-emerald-400/20 bg-gradient-to-br from-emerald-950/30 to-black p-5 relative overflow-hidden">
                <div className="absolute top-0 left-1/2 -translate-x-1/2 w-48 h-16 bg-emerald-400/10 blur-3xl rounded-full pointer-events-none" />
                <div className="relative">
                  <div className="flex items-center gap-2 mb-3">
                    <Trophy className="text-emerald-400" size={16} />
                    <span className="text-xs font-mono font-bold text-emerald-400 tracking-widest">GRADUATED</span>
                  </div>
                  <p className="text-xs font-mono text-white/50 mb-4 leading-relaxed">This token has graduated. Permanent liquidity seeded on Cetus.</p>
                  {graduationData && (
                    <div className="rounded-xl border border-white/10 bg-white/5 p-3 space-y-2 text-xs font-mono mb-4">
                      <div className="flex justify-between"><span className="text-white/30">FINAL RESERVE</span><span className="text-white font-bold">{graduationData?.finalReserve?.toFixed(2) ?? '—'} SUI</span></div>
                      <div className="flex justify-between"><span className="text-white/30">CREATOR BONUS</span><span className="text-emerald-400">{graduationData?.creatorBonus?.toFixed(4) ?? '—'} SUI</span></div>
                    </div>
                  )}
                  <a href={`https://app.cetus.zone/swap?from=0x2::sui::SUI&to=${tokenType}`} target="_blank" rel="noreferrer"
                    className="flex items-center justify-center gap-2 w-full py-3 bg-emerald-400 text-black text-xs font-mono tracking-widest hover:bg-emerald-300 rounded-xl font-bold transition-colors">
                    <Droplets size={13} /> TRADE ON CETUS
                  </a>
                </div>
              </div>
              <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4 flex items-center justify-between text-xs font-mono">
                <span className="text-white/30 tracking-widest">YOUR ${fields.symbol}</span>
                <span className="text-white font-bold">{fmt(tokenBalanceWhole)} {fields.symbol}</span>
              </div>
            </div>
          ) : (
            <TradePanelContent side={side} setSide={setSide} amount={amount} setAmount={setAmount}
              fields={fields} quote={quote} account={account} isPending={isPending}
              graduated={graduated} execute={execute} tokenBalanceWhole={tokenBalanceWhole} suiBalanceSui={suiBalanceSui} />
          )}
        </div>
      </div>

      {!graduated && (
        <div className="lg:hidden fixed bottom-0 left-0 right-0 z-50 bg-black/95 border-t border-white/10 backdrop-blur-sm">
          <TradePanelContent side={side} setSide={setSide} amount={amount} setAmount={setAmount}
            fields={fields} quote={quote} account={account} isPending={isPending}
            graduated={graduated} execute={execute} tokenBalanceWhole={tokenBalanceWhole} suiBalanceSui={suiBalanceSui} mobile />
        </div>
      )}
      {graduated && (
        <div className="lg:hidden fixed bottom-0 left-0 right-0 z-50 bg-black/95 border-t border-white/10 p-3">
          <a href={`https://app.cetus.zone/swap?from=0x2::sui::SUI&to=${tokenType}`} target="_blank" rel="noreferrer"
            className="flex items-center justify-center gap-2 w-full py-3 bg-emerald-400 text-black text-sm font-mono tracking-widest hover:bg-emerald-300 rounded-xl font-bold transition-colors">
            <Droplets size={14} /> GRADUATED — TRADE ON CETUS
          </a>
        </div>
      )}
    </div>
  );
}

function TradePanelContent({ side, setSide, amount, setAmount, fields, quote, account, isPending, graduated, execute, tokenBalanceWhole, suiBalanceSui, mobile }) {
  return (
    <div className={`rounded-2xl border border-lime-400/20 bg-white/[0.03] ${mobile ? 'p-3' : 'p-5 h-fit sticky top-20'}`}>
      <div className="flex gap-2 mb-3">
        <button onClick={() => setSide('buy')}
          className={`flex-1 py-2.5 text-xs font-mono tracking-widest rounded-xl transition-all ${
            side === 'buy' ? 'bg-lime-400 text-black font-bold' : 'bg-white/5 text-white/50 hover:bg-white/10'
          }`}>BUY</button>
        <button onClick={() => setSide('sell')}
          className={`flex-1 py-2.5 text-xs font-mono tracking-widest rounded-xl transition-all ${
            side === 'sell' ? 'bg-red-400 text-black font-bold' : 'bg-white/5 text-white/50 hover:bg-white/10'
          }`}>SELL</button>
      </div>
      <div className="flex items-center justify-between mb-1">
        <div className="text-[10px] font-mono text-white/30 tracking-widest">
          {side === 'buy' ? 'YOU PAY (SUI)' : `YOU SELL (${fields.symbol})`}
        </div>
        {side === 'buy' && suiBalanceSui > 0 && (
          <div className="text-[10px] font-mono text-white/20">BAL: {suiBalanceSui.toFixed(2)} SUI</div>
        )}
        {side === 'sell' && tokenBalanceWhole > 0 && (
          <div className="text-[10px] font-mono text-white/20">BAL: {fmt(tokenBalanceWhole, 0)} {fields.symbol}</div>
        )}
      </div>
      <input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.0"
        className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2.5 text-white font-mono text-lg focus:outline-none focus:border-lime-400/50 transition-colors" />
      {side === 'buy' && (
        <div className="flex gap-1 mt-2">
          {[1, 5, 10, 50].map((v) => (
            <button key={v} onClick={() => setAmount(String(v))}
              className="flex-1 text-[10px] font-mono py-1.5 rounded-lg bg-white/5 border border-white/10 text-white/50 hover:border-lime-400/40 hover:text-lime-400 transition-all">{v}</button>
          ))}
          {suiBalanceSui > 0 && (
            <button onClick={() => setAmount(String(Math.max(0, suiBalanceSui - 0.1).toFixed(4)))}
              className="flex-1 text-[10px] font-mono py-1.5 rounded-lg bg-lime-400/10 border border-lime-400/30 text-lime-400 font-bold hover:bg-lime-400/20 transition-all">MAX</button>
          )}
        </div>
      )}
      {side === 'sell' && tokenBalanceWhole > 0 && (
        <div className="flex gap-1 mt-2">
          {[25, 50, 75].map((pct) => (
            <button key={pct} onClick={() => setAmount(String((tokenBalanceWhole * pct / 100).toFixed(TOKEN_DECIMALS)))}
              className="flex-1 text-[10px] font-mono py-1.5 rounded-lg bg-white/5 border border-white/10 text-white/50 hover:border-red-400/40 hover:text-red-400 transition-all">{pct}%</button>
          ))}
          <button onClick={() => setAmount(String(tokenBalanceWhole.toFixed(TOKEN_DECIMALS)))}
            className="flex-1 text-[10px] font-mono py-1.5 rounded-lg bg-red-400/10 border border-red-400/30 text-red-400 font-bold hover:bg-red-400/20 transition-all">MAX</button>
        </div>
      )}
      {!mobile && quote && (
        <div className="mt-3 p-3 rounded-xl border border-white/10 bg-white/5 space-y-1 text-xs font-mono">
          <div className="flex justify-between">
            <span className="text-white/40">YOU RECEIVE</span>
            <span className="text-white font-bold">
              {side === 'buy' ? `${fmt(tokenUnitsToWhole(quote.tokensOut))} ${fields.symbol}` : `${fmtSui(quote.suiOut)} SUI`}
            </span>
          </div>
          {side === 'buy' && quote.clipped && (
            <div className="flex justify-between"><span className="text-amber-500/70">REFUND</span><span className="text-amber-400">{fmtSui(quote.refund)} SUI</span></div>
          )}
          <div className="flex justify-between pt-1 border-t border-white/5">
            <span className="text-white/30">FEE (1%)</span><span className="text-white/50">{fmtSui(quote.fee)} SUI</span>
          </div>
        </div>
      )}
      {mobile && quote && (
        <div className="mt-2 flex justify-between text-xs font-mono">
          <span className="text-white/30">YOU RECEIVE</span>
          <span className="text-white font-bold">
            {side === 'buy' ? `${fmt(tokenUnitsToWhole(quote.tokensOut))} ${fields.symbol}` : `${fmtSui(quote.suiOut)} SUI`}
          </span>
        </div>
      )}
      <button onClick={execute} disabled={!quote || isPending || graduated || !account}
        className={`w-full mt-3 py-3 font-mono tracking-widest text-sm rounded-xl transition-all ${
          !account ? 'bg-white/5 text-white/20 cursor-not-allowed'
          : quote && !isPending
            ? side === 'buy' ? 'bg-lime-400 text-black hover:bg-lime-300 font-bold shadow-lg shadow-lime-400/20' : 'bg-red-400 text-black hover:bg-red-300 font-bold'
            : 'bg-white/5 text-white/20 cursor-not-allowed'
        }`}>
        {!account ? 'CONNECT WALLET' : isPending ? 'CONFIRMING…' : !quote ? 'ENTER AMOUNT' : `EXECUTE ${side.toUpperCase()}`}
      </button>
      {!mobile && <div className="mt-3 text-[10px] font-mono text-white/20 text-center">TESTNET · SLIPPAGE 1% · FAIR LAUNCH · NO TEAM ALLOCATION</div>}
    </div>
  );
}
