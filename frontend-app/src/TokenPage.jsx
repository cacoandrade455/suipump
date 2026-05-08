// TokenPage.jsx — individual token trading page
import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useCurrentAccount, useSuiClient, useSignAndExecuteTransaction } from '@mysten/dapp-kit';
import { Transaction } from '@mysten/sui/transactions';
import { ArrowLeft, Copy, Check, Share2, ExternalLink, TrendingUp, TrendingDown } from 'lucide-react';

import PriceChart from './PriceChart.jsx';
import TradeHistory from './TradeHistory.jsx';
import HolderList from './HolderList.jsx';
import Comments from './Comments.jsx';
import { PACKAGE_ID, DRAIN_SUI_APPROX, TOKEN_DECIMALS } from './constants.js';
import { mistToSui, priceMistPerToken, quoteBuy, quoteSell } from './curve.js';
import { paginateEvents } from './paginateEvents.js';

const TOTAL_SUPPLY_WHOLE = 1_000_000_000;

// ── helpers ─────────────────────────────────────────────────────────────────

function fmt(n, d = 2) {
  if (n == null) return '—';
  if (!Number.isFinite(n)) return '—';
  if (n >= 1e9) return (n / 1e9).toFixed(d) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(d) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(d) + 'k';
  return n.toFixed(d);
}

function fmtUsd(sui, suiUsd, d = 2) {
  if (sui == null || suiUsd == null) return '—';
  const usd = sui * suiUsd;
  if (usd >= 1e6) return '$' + (usd / 1e6).toFixed(d) + 'M';
  if (usd >= 1e3) return '$' + (usd / 1e3).toFixed(1) + 'k';
  if (usd >= 1) return '$' + usd.toFixed(d);
  return '$' + usd.toFixed(5);
}

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

function parseDescription(raw) {
  if (!raw) return { desc: '', twitter: '', telegram: '', website: '' };
  const parts = raw.split('||');
  return {
    desc: parts[0]?.trim() || '',
    twitter: parts[1]?.trim() || '',
    telegram: parts[2]?.trim() || '',
    website: parts[3]?.trim() || '',
  };
}

// ── main component ───────────────────────────────────────────────────────────

export default function TokenPage({ curveId, tokenType, onBack }) {
  const navigate = useNavigate();
  const account = useCurrentAccount();
  const client = useSuiClient();
  const { mutate: signAndExecute } = useSignAndExecuteTransaction();

  const [suiUsd, setSuiUsd] = useState(0);
  const [curveState, setCurveState] = useState(null);
  const [metadata, setMetadata] = useState(null);
  const [iconUrl, setIconUrl] = useState(null);

  // balances
  const [suiBalance, setSuiBalance] = useState(0); // SUI whole units
  const [tokenBalance, setTokenBalance] = useState(0); // token whole units

  // trade panel
  const [side, setSide] = useState('buy');
  const [amount, setAmount] = useState('');
  const [txStatus, setTxStatus] = useState(null); // null | 'pending' | 'success' | 'error'
  const [txMsg, setTxMsg] = useState('');

  // copy CA / share
  const [copied, setCopied] = useState(false);
  const [shared, setShared] = useState(false);


  // ── data loading ────────────────────────────────────────────────────────

  useEffect(() => {
    fetchSuiUsd().then(setSuiUsd);
    const t = setInterval(() => fetchSuiUsd().then(setSuiUsd), 30_000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (!curveId || !client) return;
    let cancelled = false;
    async function load() {
      try {
        const obj = await client.getObject({ id: curveId, options: { showContent: true } });
        if (!cancelled) setCurveState(obj.data?.content?.fields ?? null);
      } catch {}
    }
    load();
    const t = setInterval(load, 8_000);
    return () => { cancelled = true; clearInterval(t); };
  }, [curveId, client]);

  // Fetch wallet balances
  useEffect(() => {
    if (!account || !client) return;
    let cancelled = false;
    async function loadBalances() {
      try {
        // SUI balance
        const suiBal = await client.getBalance({ owner: account.address, coinType: '0x2::sui::SUI' });
        if (!cancelled) {
          const whole = Number(BigInt(suiBal.totalBalance)) / 1e9;
          setSuiBalance(whole);
        }
        // Token balance
        if (tokenType) {
          const tokBal = await client.getBalance({ owner: account.address, coinType: tokenType });
          if (!cancelled) {
            setTokenBalance(Number(BigInt(tokBal.totalBalance)) / (10 ** TOKEN_DECIMALS));
          }
        }
      } catch {}
    }
    loadBalances();
    const t = setInterval(loadBalances, 10_000);
    return () => { cancelled = true; clearInterval(t); };
  }, [account, client, tokenType]);

  useEffect(() => {
    if (!tokenType || !client) return;
    let cancelled = false;
    client.getCoinMetadata({ coinType: tokenType })
      .then(m => {
        if (!cancelled) {
          setMetadata(m);
          if (m?.iconUrl) setIconUrl(m.iconUrl);
        }
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [tokenType, client]);

  // ── derived state ────────────────────────────────────────────────────────

  const reserveMist = curveState ? BigInt(curveState.sui_reserve ?? 0) : 0n;
  const tokenReserve = curveState ? BigInt(curveState.token_reserve ?? 0) : 0n;
  const tokensSold = BigInt(800_000_000) * BigInt(10 ** TOKEN_DECIMALS) - tokenReserve;
  const graduated = curveState?.graduated ?? false;
  const creatorAddr = curveState?.creator ?? null;
  const creatorFeesMist = curveState ? BigInt(curveState.creator_fees ?? 0) : 0n;
  const isCreator = account && creatorAddr && account.address === creatorAddr;
  const progress = Math.min(100, (mistToSui(reserveMist) / DRAIN_SUI_APPROX) * 100);
  const priceMist = priceMistPerToken(reserveMist, tokensSold);
  const priceSui = Number(priceMist) / 1e9;
  const priceUsd = priceSui * suiUsd;
  const marketCapSui = priceSui * TOTAL_SUPPLY_WHOLE;
  const marketCapUsd = marketCapSui * suiUsd;

  const { desc, twitter, telegram, website } = parseDescription(curveState?.description);
  const name = metadata?.name || curveState?.name || '…';
  const symbol = metadata?.symbol || curveState?.symbol || '…';

  // ── handlers ────────────────────────────────────────────────────────────

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(curveId).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [curveId]);

  const handleShare = useCallback(async () => {
    const url = `${window.location.origin}/token/${curveId}`;
    const text = `Check out $${symbol} on SuiPump! 🚀\n${url}`;
    if (navigator.share) {
      try {
        await navigator.share({ title: `$${symbol} on SuiPump`, text, url });
        setShared(true);
        setTimeout(() => setShared(false), 2000);
      } catch {}
    } else {
      navigator.clipboard.writeText(url).then(() => {
        setShared(true);
        setTimeout(() => setShared(false), 2000);
      });
    }
  }, [curveId, symbol]);

  const quoteTrade = useCallback(() => {
    const a = parseFloat(amount);
    if (!a || a <= 0 || !curveState) return null;
    try {
      if (side === 'buy') {
        const suiInMist = BigInt(Math.floor(a * 1e9));
        const result = quoteBuy(suiInMist, reserveMist, tokensSold);
        return { tokensOut: Number(result.tokensOut) / (10 ** TOKEN_DECIMALS), clipped: result.clipped };
      } else {
        const tokensInSmallest = BigInt(Math.floor(a * (10 ** TOKEN_DECIMALS)));
        const result = quoteSell(tokensInSmallest, reserveMist, tokensSold);
        return { suiOut: Number(result.suiOut) / 1e9 };
      }
    } catch { return null; }
  }, [amount, side, curveState, reserveMist, tokensSold]);

  const executeTrade = useCallback(async () => {
    if (!account || !curveState) return;
    const a = parseFloat(amount);
    if (!a || a <= 0) return;

    setTxStatus('pending');
    setTxMsg('');

    try {
      const tx = new Transaction();
      // Fetch initialSharedVersion — required for sharedObjectRef with dapp-kit
      const objForRef = await client.getObject({ id: curveId, options: { showOwner: true } });
      const initialSharedVersion = objForRef.data?.owner?.Shared?.initial_shared_version;
      const curveRef = initialSharedVersion
        ? tx.sharedObjectRef({ objectId: curveId, initialSharedVersion, mutable: true })
        : tx.object(curveId); // fallback

      if (side === 'buy') {
        const suiMist = Math.floor(a * 1e9);
        const [coin] = tx.splitCoins(tx.gas, [tx.pure.u64(suiMist)]);
        const [tokens, refund] = tx.moveCall({
          target: `${PACKAGE_ID}::bonding_curve::buy`,
          typeArguments: [tokenType],
          arguments: [curveRef, coin, tx.pure.u64(0n)],
        });
        tx.transferObjects([tokens, refund], account.address);
      } else {
        const tokensIn = Math.floor(a * (10 ** TOKEN_DECIMALS));
        // Fetch token coins, merge if needed, split exact amount
        const coins = await client.getCoins({ owner: account.address, coinType: tokenType });
        if (!coins.data.length) throw new Error('No tokens to sell');
        const primary = tx.object(coins.data[0].coinObjectId);
        if (coins.data.length > 1) {
          tx.mergeCoins(primary, coins.data.slice(1).map(c => tx.object(c.coinObjectId)));
        }
        const [toSell] = tx.splitCoins(primary, [tx.pure.u64(tokensIn)]);
        const suiOut = tx.moveCall({
          target: `${PACKAGE_ID}::bonding_curve::sell`,
          typeArguments: [tokenType],
          arguments: [curveRef, toSell, tx.pure.u64(0)],
        });
        tx.transferObjects([suiOut], account.address);
      }

      signAndExecute(
        { transaction: tx },
        {
          onSuccess: () => {
            setTxStatus('success');
            setTxMsg(side === 'buy' ? 'Buy successful! 🎉' : 'Sell successful!');
            setAmount('');
            setTimeout(() => { setTxStatus(null); setTxMsg(''); }, 3000);
          },
          onError: (err) => {
            setTxStatus('error');
            setTxMsg(err.message || 'Transaction failed');
            setTimeout(() => { setTxStatus(null); setTxMsg(''); }, 4000);
          },
        }
      );
    } catch (err) {
      setTxStatus('error');
      setTxMsg(err.message || 'Transaction failed');
      setTimeout(() => { setTxStatus(null); setTxMsg(''); }, 4000);
    }
  }, [account, curveState, curveId, tokenType, side, amount, client, signAndExecute]);

  const quote = quoteTrade();

  // ── render ───────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen" style={{ fontFamily: "'JetBrains Mono', ui-monospace, monospace" }}>
      {/* Back */}
      <button
        onClick={onBack || (() => navigate('/'))}
        className="flex items-center gap-2 text-white/50 hover:text-lime-400 transition-colors text-xs font-mono mb-4 group"
      >
        <ArrowLeft size={14} className="group-hover:-translate-x-0.5 transition-transform" />
        BACK
      </button>

      {/* Graduation banner */}
      {graduated && (
        <div className="mb-4 px-4 py-3 bg-lime-400/10 border border-lime-400/30 rounded-xl text-xs font-mono text-lime-400 flex items-center gap-2">
          🎓 <span>This token has <strong>graduated</strong> to a Cetus CLMM pool. Liquidity is permanent and LP tokens are burned.</span>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-4">
        {/* Left column */}
        <div className="space-y-4">
          {/* Token header */}
          <div className="bg-white/[0.03] border border-white/10 rounded-xl p-4">
            <div className="flex items-start gap-3">
              {/* Icon */}
              <div className="w-12 h-12 rounded-xl overflow-hidden flex-shrink-0 bg-white/5 flex items-center justify-center text-xl">
                {iconUrl ? (
                  <img src={iconUrl} alt={symbol} className="w-full h-full object-cover" />
                ) : (
                  <span>{symbol?.slice(0, 2)}</span>
                )}
              </div>

              {/* Name + CA + social */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <h1 className="text-white font-bold text-lg">{name}</h1>
                  <span className="text-lime-400 text-sm font-mono">${symbol}</span>
                </div>

                {/* Contract address row */}
                <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
                  <span className="text-white/35 text-[10px] font-mono truncate max-w-[180px]">
                    {curveId ? `${curveId.slice(0, 8)}…${curveId.slice(-6)}` : '—'}
                  </span>
                  {/* Copy CA */}
                  <button
                    onClick={handleCopy}
                    title="Copy contract address"
                    className={`flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-mono border transition-all ${
                      copied
                        ? 'border-lime-400/50 text-lime-400 bg-lime-400/10'
                        : 'border-white/15 text-white/50 hover:text-white/80 hover:border-white/30'
                    }`}
                  >
                    {copied ? <Check size={10} /> : <Copy size={10} />}
                    {copied ? 'COPIED' : 'COPY CA'}
                  </button>
                  {/* Share */}
                  <button
                    onClick={handleShare}
                    title="Share token"
                    className={`flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-mono border transition-all ${
                      shared
                        ? 'border-lime-400/50 text-lime-400 bg-lime-400/10'
                        : 'border-white/15 text-white/50 hover:text-white/80 hover:border-white/30'
                    }`}
                  >
                    {shared ? <Check size={10} /> : <Share2 size={10} />}
                    {shared ? 'LINK COPIED' : 'SHARE'}
                  </button>
                </div>

                {/* Description */}
                {desc && (
                  <p className="text-white/50 text-xs mt-2 leading-relaxed">{desc}</p>
                )}

                {/* Social links */}
                <div className="flex items-center gap-3 mt-2">
                  {twitter && (
                    <a href={twitter.startsWith('http') ? twitter : `https://x.com/${twitter.replace('@', '')}`}
                      target="_blank" rel="noopener noreferrer"
                      className="text-white/40 hover:text-white/80 text-[10px] font-mono transition-colors flex items-center gap-1">
                      <ExternalLink size={9} /> X
                    </a>
                  )}
                  {telegram && (
                    <a href={telegram.startsWith('http') ? telegram : `https://t.me/${telegram.replace('@', '')}`}
                      target="_blank" rel="noopener noreferrer"
                      className="text-white/40 hover:text-white/80 text-[10px] font-mono transition-colors flex items-center gap-1">
                      <ExternalLink size={9} /> TG
                    </a>
                  )}
                  {website && (
                    <a href={website} target="_blank" rel="noopener noreferrer"
                      className="text-white/40 hover:text-white/80 text-[10px] font-mono transition-colors flex items-center gap-1">
                      <ExternalLink size={9} /> WEB
                    </a>
                  )}
                </div>
              </div>

              {/* Stats */}
              <div className="hidden sm:flex flex-col items-end gap-1 flex-shrink-0">
                <div className="text-right">
                  <div className="text-white text-sm font-mono font-bold">
                    {suiUsd > 0 ? fmtUsd(priceUsd / suiUsd, suiUsd, 5) : `${fmt(priceSui, 6)} SUI`}
                  </div>
                  <div className="text-white/35 text-[10px] font-mono">PRICE</div>
                </div>
                <div className="text-right">
                  <div className="text-white/70 text-xs font-mono">
                    {suiUsd > 0 ? fmtUsd(marketCapSui, suiUsd) : `${fmt(marketCapSui)} SUI`}
                  </div>
                  <div className="text-white/35 text-[10px] font-mono">MCAP</div>
                </div>
              </div>
            </div>

            {/* Progress bar */}
            <div className="mt-4">
              <div className="flex justify-between text-[10px] font-mono text-white/35 mb-1.5">
                <span>BONDING CURVE PROGRESS</span>
                <span className="text-lime-400">{progress.toFixed(1)}%</span>
              </div>
              <div className="h-2 bg-white/5 rounded-full overflow-hidden">
                <div
                  className="h-full bg-gradient-to-r from-lime-600 to-lime-400 rounded-full transition-all duration-500"
                  style={{ width: `${progress}%` }}
                />
              </div>
              <div className="flex justify-between text-[10px] font-mono text-white/25 mt-1">
                <span>{fmt(mistToSui(reserveMist))} SUI raised</span>
                <span>{fmt(DRAIN_SUI_APPROX)} SUI target</span>
              </div>
            </div>
          </div>

          {/* Block 1 — Chart */}
          <PriceChart curveId={curveId} tokenType={tokenType} suiUsd={suiUsd} />

          {/* Block 2 — Trades / Holders toggle */}
          <TradesHoldersBlock curveId={curveId} tokenType={tokenType} suiUsd={suiUsd} />

          {/* Block 3 — Comments */}
          <Comments curveId={curveId} />
        </div>

        {/* Right column — trade panel */}
        <div className="space-y-4">
          <TradePanelContent
            side={side}
            setSide={setSide}
            amount={amount}
            setAmount={setAmount}
            quote={quote}
            txStatus={txStatus}
            txMsg={txMsg}
            account={account}
            onExecute={executeTrade}
            priceSui={priceSui}
            priceUsd={priceUsd}
            suiUsd={suiUsd}
            symbol={symbol}
            graduated={graduated}
            suiBalance={suiBalance}
            tokenBalance={tokenBalance}
            isCreator={isCreator}
            creatorFeesMist={creatorFeesMist}
            curveId={curveId}
            tokenType={tokenType}
          />

          {/* Mobile stats */}
          <div className="sm:hidden bg-white/[0.03] border border-white/10 rounded-xl p-4 grid grid-cols-2 gap-3">
            <div>
              <div className="text-white/35 text-[10px] font-mono mb-0.5">PRICE</div>
              <div className="text-white text-sm font-mono font-bold">
                {suiUsd > 0 ? fmtUsd(priceSui, suiUsd, 5) : `${fmt(priceSui, 6)} SUI`}
              </div>
            </div>
            <div>
              <div className="text-white/35 text-[10px] font-mono mb-0.5">MCAP</div>
              <div className="text-white/70 text-sm font-mono">
                {suiUsd > 0 ? fmtUsd(marketCapSui, suiUsd) : `${fmt(marketCapSui)} SUI`}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Trade Panel ──────────────────────────────────────────────────────────────

function TradePanelContent({
  side, setSide, amount, setAmount, quote, txStatus, txMsg,
  account, onExecute, priceSui, priceUsd, suiUsd, symbol, graduated,
  suiBalance, tokenBalance,
  isCreator, creatorFeesMist, curveId: panelCurveId, tokenType: panelTokenType,
}) {
  const { mutate: signAndExecutePanel } = useSignAndExecuteTransaction();
  const client2 = useSuiClient();
  const [claiming, setClaiming] = useState(false);
  const [claimMsg, setClaimMsg] = useState('');
  const isPending = txStatus === 'pending';

  const handleClaim = async () => {
    if (!account || !panelCurveId || !panelTokenType || claiming) return;
    setClaiming(true);
    setClaimMsg('');
    try {
      // Find CreatorCap in wallet
      const ownedObjs = await client2.getOwnedObjects({
        owner: account.address,
        filter: { StructType: `${PACKAGE_ID}::bonding_curve::CreatorCap` },
        options: { showContent: true },
      });
      const capObj = ownedObjs.data?.[0];
      if (!capObj) throw new Error('CreatorCap not found in wallet');
      const capId = capObj.data?.objectId;

      const objForRef = await client2.getObject({ id: panelCurveId, options: { showOwner: true } });
      const initialSharedVersion = objForRef.data?.owner?.Shared?.initial_shared_version;
      const tx = new Transaction();
      const curveRef = initialSharedVersion
        ? tx.sharedObjectRef({ objectId: panelCurveId, initialSharedVersion, mutable: true })
        : tx.object(panelCurveId);
      const feeCoin = tx.moveCall({
        target: `${PACKAGE_ID}::bonding_curve::claim_creator_fees`,
        typeArguments: [panelTokenType],
        arguments: [tx.object(capId), curveRef],
      });
      tx.transferObjects([feeCoin], account.address);
      signAndExecutePanel(
        { transaction: tx },
        {
          onSuccess: () => { setClaimMsg('Fees claimed! 🎉'); setClaiming(false); setTimeout(() => setClaimMsg(''), 3000); },
          onError: (err) => { setClaimMsg(err.message || 'Claim failed'); setClaiming(false); setTimeout(() => setClaimMsg(''), 4000); },
        }
      );
    } catch (err) {
      setClaimMsg(err.message || 'Claim failed');
      setClaiming(false);
    }
  };

  return (
    <div className="bg-white/[0.03] border border-white/10 rounded-xl p-4 space-y-4">
      <div className="text-[10px] font-mono text-white/35 tracking-widest">TRADE</div>

      {graduated && (
        <div className="text-[10px] font-mono text-lime-400/70 bg-lime-400/5 border border-lime-400/20 rounded-lg px-3 py-2">
          Token graduated — trade on Cetus DEX
        </div>
      )}

      {/* Buy / Sell toggle */}
      <div className="flex rounded-lg overflow-hidden border border-white/10">
        <button
          onClick={() => setSide('buy')}
          className={`flex-1 py-2.5 text-xs font-mono font-bold transition-colors ${
            side === 'buy' ? 'bg-lime-400 text-black' : 'text-white/50 hover:text-white/80'
          }`}
        >
          BUY
        </button>
        <button
          onClick={() => setSide('sell')}
          className={`flex-1 py-2.5 text-xs font-mono font-bold transition-colors ${
            side === 'sell' ? 'bg-red-500 text-white' : 'text-white/50 hover:text-white/80'
          }`}
        >
          SELL
        </button>
      </div>

      {/* Amount input */}
      <div className="space-y-1.5">
        <div className="text-[10px] font-mono text-white/35">
          {side === 'buy' ? 'AMOUNT (SUI)' : `AMOUNT ($${symbol})`}
        </div>
        <div className="flex gap-2">
          <input
            type="number"
            min="0"
            step="any"
            value={amount}
            onChange={e => setAmount(e.target.value)}
            placeholder={side === 'buy' ? '0.00' : '0'}
            className="flex-1 bg-white/5 border border-white/10 rounded-lg px-3 py-2.5 text-sm font-mono text-white placeholder-white/20 focus:outline-none focus:border-lime-400/50 focus:bg-lime-400/5 transition-colors"
          />
          <button
            onClick={() => {
              if (side === 'buy') {
                // Leave 0.1 SUI for gas
                const max = Math.max(0, suiBalance - 0.1);
                setAmount(max > 0 ? max.toFixed(4) : '0');
              } else {
                setAmount(tokenBalance > 0 ? Math.floor(tokenBalance).toString() : '0');
              }
            }}
            className="px-2.5 py-2.5 text-[10px] font-mono text-white/35 hover:text-lime-400 border border-white/10 hover:border-lime-400/40 rounded-lg transition-colors"
          >
            MAX
          </button>
        </div>
      </div>

      {/* Quick amounts */}
      <div className="flex gap-2">
        {(side === 'buy' ? ['1', '10', '50', '100'] : ['100k', '500k', '1M']).map(v => (
          <button
            key={v}
            onClick={() => setAmount(v.replace('k', '000').replace('M', '000000'))}
            className="flex-1 py-1.5 text-[10px] font-mono text-white/35 hover:text-white/70 border border-white/10 hover:border-white/25 rounded-lg transition-colors"
          >
            {v}
          </button>
        ))}
      </div>

      {/* Quote preview */}
      {quote && (
        <div className="bg-white/[0.03] rounded-lg px-3 py-2.5 space-y-1.5 border border-white/5">
          {side === 'buy' && quote.tokensOut != null && (
            <div className="flex justify-between text-[11px] font-mono">
              <span className="text-white/35">You receive</span>
              <span className="text-lime-400">{fmt(quote.tokensOut, 0)} ${symbol}</span>
            </div>
          )}
          {side === 'sell' && quote.suiOut != null && (
            <div className="flex justify-between text-[11px] font-mono">
              <span className="text-white/35">You receive</span>
              <span className="text-lime-400">
                {suiUsd > 0 ? `$${(quote.suiOut * suiUsd).toFixed(2)}` : `${fmt(quote.suiOut)} SUI`}
              </span>
            </div>
          )}
          <div className="flex justify-between text-[10px] font-mono">
            <span className="text-white/25">Price impact</span>
            <span className="text-white/40">~1% fee</span>
          </div>
        </div>
      )}

      {/* Execute button */}
      <button
        onClick={onExecute}
        disabled={!account || isPending || !amount || parseFloat(amount) <= 0}
        className={`w-full py-3 rounded-xl text-sm font-mono font-bold transition-all ${
          !account
            ? 'bg-white/5 text-white/25 cursor-not-allowed'
            : isPending
              ? 'bg-white/10 text-white/50 cursor-wait'
              : side === 'buy'
                ? 'bg-lime-400 hover:bg-lime-300 text-black'
                : 'bg-red-500 hover:bg-red-400 text-white'
        }`}
      >
        {!account
          ? 'CONNECT WALLET'
          : isPending
            ? 'PROCESSING…'
            : side === 'buy' ? `BUY $${symbol}` : `SELL $${symbol}`}
      </button>

      {/* Tx status */}
      {txMsg && (
        <div className={`text-[11px] font-mono text-center px-3 py-2 rounded-lg ${
          txStatus === 'success'
            ? 'text-lime-400 bg-lime-400/10 border border-lime-400/20'
            : 'text-red-400 bg-red-400/10 border border-red-400/20'
        }`}>
          {txMsg}
        </div>
      )}

      {/* Claim creator fees */}
      {isCreator && (
        <div className="pt-3 border-t border-white/5 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-mono text-white/35 tracking-widest">CREATOR FEES</span>
            <span className="text-xs font-mono text-lime-400">
              {creatorFeesMist > 0n ? `${(Number(creatorFeesMist) / 1e9).toFixed(4)} SUI` : '0 SUI'}
            </span>
          </div>
          <button
            onClick={handleClaim}
            disabled={claiming || creatorFeesMist === 0n}
            className={`w-full py-2.5 rounded-xl text-xs font-mono font-bold transition-all ${
              creatorFeesMist === 0n
                ? 'bg-white/5 text-white/25 cursor-not-allowed'
                : claiming
                  ? 'bg-white/10 text-white/50 cursor-wait'
                  : 'bg-lime-400/15 hover:bg-lime-400/25 text-lime-400 border border-lime-400/30'
            }`}
          >
            {claiming ? 'CLAIMING…' : 'CLAIM FEES'}
          </button>
          {claimMsg && (
            <div className={`text-[10px] font-mono text-center ${claimMsg.includes('🎉') ? 'text-lime-400' : 'text-red-400'}`}>
              {claimMsg}
            </div>
          )}
        </div>
      )}

      {/* Price display */}
      <div className="grid grid-cols-2 gap-2 pt-1 border-t border-white/5">
        <div>
          <div className="text-[10px] font-mono text-white/35 mb-0.5">PRICE</div>
          <div className="text-white/70 text-xs font-mono">
            {suiUsd > 0 ? `$${priceUsd.toFixed(6)}` : `${fmt(priceSui, 6)} SUI`}
          </div>
        </div>
        <div>
          <div className="text-[10px] font-mono text-white/35 mb-0.5">IN SUI</div>
          <div className="text-white/50 text-xs font-mono">{fmt(priceSui, 6)} SUI</div>
        </div>
      </div>
    </div>
  );
}

// ── Trades / Holders toggle block ────────────────────────────────────────────

function TradesHoldersBlock({ curveId, tokenType, suiUsd }) {
  const [tab, setTab] = useState('trades');

  return (
    <div className="space-y-0">
      {/* Toggle header */}
      <div className="flex bg-white/[0.03] border border-white/10 rounded-t-xl overflow-hidden">
        <button
          onClick={() => setTab('trades')}
          className={`flex-1 py-3 text-xs font-mono font-bold tracking-wider transition-colors ${
            tab === 'trades'
              ? 'text-lime-400 bg-lime-400/5 border-b-2 border-lime-400'
              : 'text-white/40 hover:text-white/70'
          }`}
        >
          TRADES
        </button>
        <button
          onClick={() => setTab('holders')}
          className={`flex-1 py-3 text-xs font-mono font-bold tracking-wider transition-colors ${
            tab === 'holders'
              ? 'text-lime-400 bg-lime-400/5 border-b-2 border-lime-400'
              : 'text-white/40 hover:text-white/70'
          }`}
        >
          HOLDERS
        </button>
      </div>
      {/* Content — each component has its own card styling */}
      <div className="[&>div]:rounded-t-none [&>div]:border-t-0">
        {tab === 'trades'
          ? <TradeHistory curveId={curveId} suiUsd={suiUsd} />
          : <HolderList curveId={curveId} tokenType={tokenType} suiUsd={suiUsd} />
        }
      </div>
    </div>
  );
}
