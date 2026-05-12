// v16-creator-check
// TokenPage.jsx
import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useCurrentAccount, useSignAndExecuteTransaction, useSuiClient } from '@mysten/dapp-kit';
import { Transaction } from '@mysten/sui/transactions';
import { ArrowLeft, Copy, Check, Share2, ExternalLink, Settings } from 'lucide-react';
import PriceChart from './PriceChart.jsx';
import TradeHistory from './TradeHistory.jsx';
import HolderList from './HolderList.jsx';
import Comments from './Comments.jsx';
import AIAnalysis from './AIAnalysis.jsx';
import { PACKAGE_ID, MIST_PER_SUI } from './constants.js';
import { buyQuote, sellQuote } from './curve.js';
import { t } from './i18n.js';

// ── constants ─────────────────────────────────────────────────────────────────
const TOKEN_DECIMALS = 6;
const TOTAL_SUPPLY_WHOLE = 1_000_000_000;
const DRAIN_SUI_APPROX = 87_900;
const VIRTUAL_SUI = 30_000;
const VIRTUAL_TOKENS = 1_073_000_000;

function mistToSui(mist) {
  if (mist == null) return 0;
  return Number(mist) / 1e9;
}

function priceMistPerToken(suiReserveMist, tokensSold) {
  const vSui = BigInt(VIRTUAL_SUI) * BigInt(MIST_PER_SUI);
  const vTok = BigInt(VIRTUAL_TOKENS) * 10n ** BigInt(TOKEN_DECIMALS);
  const realSui = BigInt(suiReserveMist);
  const realTok = BigInt(tokensSold);
  const numSui = vSui + realSui;
  const numTok = vTok - realTok;
  if (numTok === 0n) return 0n;
  return (numSui * 10n ** BigInt(TOKEN_DECIMALS)) / numTok;
}

function fmt(n, decimals = 4) {
  if (n == null) return '-';
  if (typeof n === 'bigint') n = Number(n);
  if (isNaN(n)) return '-';
  if (Math.abs(n) >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
  if (Math.abs(n) >= 1_000) return (n / 1_000).toFixed(2) + 'k';
  return n.toFixed(decimals);
}

function fmtUsd(suiAmt, suiUsd, decimals = 2) {
  if (suiAmt == null) return '-';
  const usd = Number(suiAmt) * suiUsd;
  if (usd >= 1_000_000) return `$${(usd / 1_000_000).toFixed(2)}M`;
  if (usd >= 1_000) return `$${(usd / 1_000).toFixed(1)}k`;
  if (usd >= 1) return `$${usd.toFixed(2)}`;
  return `$${usd.toFixed(decimals + 2)}`;
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
  const idx = raw.indexOf('||');
  if (idx === -1) return { desc: raw, twitter: '', telegram: '', website: '' };
  const descPart = raw.slice(0, idx);
  try {
    const links = JSON.parse(raw.slice(idx + 2));
    return {
      desc: descPart,
      twitter: links.twitter || '',
      telegram: links.telegram || '',
      website: links.website || '',
    };
  } catch {
    const parts = raw.split('||');
    return {
      desc: parts[0]?.trim() || '',
      twitter: parts[1]?.trim() || '',
      telegram: parts[2]?.trim() || '',
      website: parts[3]?.trim() || '',
    };
  }
}

const SLIPPAGE_PRESETS = ['0.5', '1', '2', '5'];

// ── main component ───────────────────────────────────────────────────────────

export default function TokenPage({ curveId, tokenType, onBack, lang = 'en' }) {
  const navigate = useNavigate();
  const account = useCurrentAccount();
  const client = useSuiClient();
  const { mutate: signAndExecute } = useSignAndExecuteTransaction();

  const [suiUsd, setSuiUsd] = useState(0);
  const [curveState, setCurveState] = useState(null);
  const [metadata, setMetadata] = useState(null);
  const [iconUrl, setIconUrl] = useState(null);

  // balances
  const [suiBalance, setSuiBalance] = useState(0);
  const [tokenBalance, setTokenBalance] = useState(0);

  // trade panel
  const [side, setSide] = useState('buy');
  const [amount, setAmount] = useState('');
  const [slippage, setSlippage] = useState('1');
  const [txStatus, setTxStatus] = useState(null);
  const [txMsg, setTxMsg] = useState('');

  // copy CA / share
  const [copied, setCopied] = useState(false);
  const [shared, setShared] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);

  // ── data loading ─────────────────────────────────────────────────────────

  useEffect(() => {
    fetchSuiUsd().then(setSuiUsd);
    const timer = setInterval(() => fetchSuiUsd().then(setSuiUsd), 30_000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!curveId || !client) return;
    let cancelled = false;
    async function load() {
      try {
        const obj = await client.getObject({ id: curveId, options: { showContent: true } });
        if (!cancelled) setCurveState(obj.data?.content?.fields ?? null);
      } catch { }
    }
    load();
    const timer = setInterval(load, 10_000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [curveId, client]);

  useEffect(() => {
    if (!tokenType) return;
    let cancelled = false;
    client.getCoinMetadata({ coinType: tokenType })
      .then(m => { if (!cancelled) { setMetadata(m); if (m?.iconUrl) setIconUrl(m.iconUrl); } })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [tokenType, client]);

  useEffect(() => {
    if (!account || !client) return;
    let cancelled = false;
    async function loadBalances() {
      try {
        const sui = await client.getBalance({ owner: account.address, coinType: '0x2::sui::SUI' });
        if (!cancelled) setSuiBalance(Number(sui.totalBalance) / 1e9);
        if (tokenType) {
          const tok = await client.getBalance({ owner: account.address, coinType: tokenType });
          if (!cancelled) setTokenBalance(Number(tok.totalBalance) / 10 ** TOKEN_DECIMALS);
        }
      } catch { }
    }
    loadBalances();
    const timer = setInterval(loadBalances, 15_000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [account, client, tokenType]);

  // ── derived state ─────────────────────────────────────────────────────────

  const reserveMist = curveState ? BigInt(curveState.sui_reserve) : 0n;
  const tokensRemaining = curveState ? BigInt(curveState.token_reserve) : 0n;
  const tokensSold = BigInt(800_000_000) * 10n ** BigInt(TOKEN_DECIMALS) - tokensRemaining;
  const progress = Math.min(100, (mistToSui(reserveMist) / DRAIN_SUI_APPROX) * 100);
  const priceMist = curveState ? priceMistPerToken(reserveMist, tokensSold) : 0n;
  const priceSui = Number(priceMist) / 1e9;
  const priceUsd = priceSui * suiUsd;
  const marketCapSui = priceSui * TOTAL_SUPPLY_WHOLE;
  const graduated = curveState?.graduated ?? false;
  const creatorFeesMist = curveState ? BigInt(curveState.creator_fees ?? 0) : 0n;

  // curveState has priority — always set correctly by the PTB
  // metadata can show "Template Coin" if bytecode patching failed
  const name = curveState?.name || metadata?.name || '';
  const symbol = curveState?.symbol || metadata?.symbol || '';
  const { desc, twitter, telegram, website } = parseDescription(
    curveState?.description || metadata?.description || ''
  );

  // Check creator by querying owned CreatorCap objects
  const [isCreator, setIsCreator] = React.useState(false);
  React.useEffect(() => {
    if (!account?.address || !curveId || !client) { setIsCreator(false); return; }
    let cancelled = false;
    client.getOwnedObjects({
      owner: account.address,
      filter: { StructType: `${PACKAGE_ID}::bonding_curve::CreatorCap` },
      options: { showContent: true },
    }).then(res => {
      if (cancelled) return;
      const found = res.data?.some(o => o.data?.content?.fields?.curve_id === curveId);
      setIsCreator(!!found);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [account?.address, curveId, client]);

  // ── actions ────────────────────────────────────────────────────────────

  const handleCopy = () => {
    if (curveId) { navigator.clipboard.writeText(curveId); setCopied(true); setTimeout(() => setCopied(false), 1500); }
  };

  const handleShare = () => {
    const url = `${window.location.origin}/token/${curveId}`;
    if (navigator.share) {
      navigator.share({ title: `${name} ($${symbol}) on SuiPump`, url });
    } else {
      navigator.clipboard.writeText(url);
    }
    setShared(true);
    setTimeout(() => setShared(false), 1500);
  };

  const handleCopyLink = () => {
    navigator.clipboard.writeText(`${window.location.origin}/token/${curveId}`);
    setLinkCopied(true);
    setTimeout(() => setLinkCopied(false), 1500);
  };

  const quoteTrade = useCallback(() => {
    if (!amount || parseFloat(amount) <= 0 || !curveState) return null;
    try {
      if (side === 'buy') {
        const suiIn = BigInt(Math.floor(parseFloat(amount) * Number(MIST_PER_SUI)));
        return buyQuote(reserveMist, tokensRemaining, suiIn);
      } else {
        const tokIn = BigInt(Math.floor(parseFloat(amount) * 10 ** TOKEN_DECIMALS));
        return sellQuote(reserveMist, tokensRemaining, tokIn);
      }
    } catch { return null; }
  }, [amount, side, curveState, reserveMist, tokensRemaining]);

  const executeTrade = useCallback(async () => {
    if (!account || !curveState || !curveId || !tokenType) return;
    const amtFloat = parseFloat(amount);
    if (!amtFloat || amtFloat <= 0) return;

    setTxStatus('pending');
    setTxMsg('');

    try {
      const objForRef = await client.getObject({ id: curveId, options: { showOwner: true } });
      const initialSharedVersion = objForRef.data?.owner?.Shared?.initial_shared_version;
      const tx = new Transaction();
      const curveRef = initialSharedVersion
        ? tx.sharedObjectRef({ objectId: curveId, initialSharedVersion, mutable: true })
        : tx.object(curveId);

      const slippageNum = parseFloat(slippage) || 0;

      if (side === 'buy') {
        const suiInMist = BigInt(Math.floor(amtFloat * Number(MIST_PER_SUI)));
        const [payment] = tx.splitCoins(tx.gas, [tx.pure.u64(suiInMist)]);
        const quote = buyQuote(reserveMist, tokensRemaining, suiInMist);
        const minOut = quote?.tokensOut != null
          ? BigInt(Math.floor(Number(quote.tokensOut) * (1 - slippageNum / 100)))
          : 0n;
        const [tokens, refund] = tx.moveCall({
          target: `${PACKAGE_ID}::bonding_curve::buy`,
          typeArguments: [tokenType],
          arguments: [curveRef, payment, tx.pure.u64(minOut)],
        });
        tx.transferObjects([tokens, refund], account.address);
      } else {
        const tokInAtomic = BigInt(Math.floor(amtFloat * 10 ** TOKEN_DECIMALS));
        const coins = await client.getCoins({ owner: account.address, coinType: tokenType });
        const coinObjs = coins.data.map(c => tx.object(c.coinObjectId));
        let tokenCoin;
        if (coinObjs.length === 0) throw new Error('No token balance');
        if (coinObjs.length === 1) {
          [tokenCoin] = tx.splitCoins(coinObjs[0], [tx.pure.u64(tokInAtomic)]);
        } else {
          tx.mergeCoins(coinObjs[0], coinObjs.slice(1));
          [tokenCoin] = tx.splitCoins(coinObjs[0], [tx.pure.u64(tokInAtomic)]);
        }
        const quote = sellQuote(reserveMist, tokensRemaining, tokInAtomic);
        const minOut = quote?.suiOut != null
          ? BigInt(Math.floor(Number(quote.suiOut) * (1 - slippageNum / 100)))
          : 0n;
        const [suiOut] = tx.moveCall({
          target: `${PACKAGE_ID}::bonding_curve::sell`,
          typeArguments: [tokenType],
          arguments: [curveRef, tokenCoin, tx.pure.u64(minOut)],
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
  }, [account, curveState, curveId, tokenType, side, amount, slippage, client, signAndExecute, reserveMist, tokensSold]);

  const quote = quoteTrade();

  // ── render ────────────────────────────────────────────────────────────────
  const scrollToTop = () => window.scrollTo({ top: 0, behavior: 'smooth' });

  return (
    <div className="min-h-screen" style={{ fontFamily: "'JetBrains Mono', ui-monospace, monospace" }}>
      {/* Back */}
      <button
        onClick={onBack || (() => navigate('/'))}
        className="flex items-center gap-2 text-white/50 hover:text-lime-400 transition-colors text-xs font-mono mb-4 group"
      >
        <ArrowLeft size={14} className="group-hover:-translate-x-0.5 transition-transform" />
        {t(lang, 'backToHome')}
      </button>

      {/* Graduation banner */}
      {graduated && (
        <div className="mb-4 px-4 py-3 bg-lime-400/10 border border-lime-400/30 rounded-xl text-xs font-mono text-lime-400 flex items-center gap-2">
          🎓 <span>{t(lang, 'tokenGraduated')}</span>
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
                  <img src={iconUrl} alt={symbol} className="w-full h-full object-cover"
                    onError={e => { e.target.style.display='none'; e.target.nextSibling.style.display='flex'; }} />
                ) : null}
                <span style={{ display: iconUrl ? 'none' : 'flex' }} className="text-2xl items-center justify-center w-full h-full">🔥</span>
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
                    {curveId ? `${curveId.slice(0, 6)}...${curveId.slice(-4)}` : ''}
                  </span>
                  <button
                    onClick={handleCopy}
                    className="text-white/35 hover:text-lime-400 transition-colors flex items-center gap-1 text-[10px] font-mono"
                  >
                    {copied ? <Check size={10} /> : <Copy size={10} />}
                    {copied ? t(lang, 'copied') : t(lang, 'copyCa')}
                  </button>
                  <button
                    onClick={handleShare}
                    className="text-white/35 hover:text-lime-400 transition-colors flex items-center gap-1 text-[10px] font-mono"
                  >
                    <svg width="9" height="9" viewBox="0 0 24 24" fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>
                    {shared ? t(lang, 'share') + '!' : t(lang, 'share')}
                  </button>
                  <button
                    onClick={handleCopyLink}
                    className="text-white/35 hover:text-lime-400 transition-colors flex items-center gap-1 text-[10px] font-mono"
                  >
                    {linkCopied ? <Check size={10} /> : <Share2 size={10} />}
                    {linkCopied ? t(lang, 'linkCopied') : t(lang, 'share') + ' LINK'}
                  </button>
                </div>

                {/* Social links */}
                <div className="flex items-center gap-3 mt-1.5 flex-wrap">
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
                    <a href={website.startsWith('http') ? website : `https://${website}`}
                      target="_blank" rel="noopener noreferrer"
                      className="text-white/40 hover:text-white/80 text-[10px] font-mono transition-colors flex items-center gap-1">
                      <ExternalLink size={9} /> WEB
                    </a>
                  )}
                </div>
              </div>

              {/* Price + mcap */}
              <div className="text-right hidden sm:block">
                <div className="text-white font-bold text-sm font-mono">
                  {suiUsd > 0 ? `$${priceUsd.toFixed(6)}` : `${fmt(priceSui, 6)} SUI`}
                </div>
                <div className="text-white/35 text-[10px] font-mono">{t(lang, 'price')}</div>
                <div className="text-white/70 text-xs font-mono mt-1">
                  {suiUsd > 0 ? fmtUsd(marketCapSui, suiUsd) : `${fmt(marketCapSui)} SUI`}
                </div>
                <div className="text-white/35 text-[10px] font-mono">{t(lang, 'mcap')}</div>
              </div>
            </div>

            {/* Description */}
            {desc && (
              <p className="mt-3 text-xs font-mono text-white/40 leading-relaxed">{desc}</p>
            )}

            {/* Progress bar */}
            <div className="mt-4">
              <div className="flex justify-between text-[10px] font-mono text-white/35 mb-1.5">
                <span>{t(lang, 'bondingCurveProgress')}</span>
                <span className="text-lime-400">{progress.toFixed(1)}%</span>
              </div>
              <div className="h-2 bg-white/5 rounded-full overflow-hidden">
                <div
                  className="h-full bg-gradient-to-r from-lime-600 to-lime-400 rounded-full transition-all duration-500"
                  style={{ width: `${progress}%` }}
                />
              </div>
              <div className="flex justify-between text-[10px] font-mono text-white/25 mt-1">
                <span>{fmt(mistToSui(reserveMist))} {t(lang, 'suiRaised')}</span>
                <span>{fmt(DRAIN_SUI_APPROX)} {t(lang, 'suiTarget')}</span>
              </div>
            </div>
          </div>

          {/* Block 1 — Chart */}
          <PriceChart curveId={curveId} tokenType={tokenType} suiUsd={suiUsd} />

          {/* Block 2 — Trades / Holders toggle */}
          <TradesHoldersBlock curveId={curveId} tokenType={tokenType} suiUsd={suiUsd} lang={lang} />

          {/* Block 3 — AI Analysis */}
          <AIAnalysis
            curveId={curveId}
            name={name}
            symbol={symbol}
            progress={progress}
            reserveSui={mistToSui(reserveMist)}
            creatorFeesSui={Number(creatorFeesMist) / 1e9}
            graduated={graduated}
          />

          {/* Block 4 — Comments */}
          <CommentsBlock curveId={curveId} lang={lang} />
        </div>

        {/* Right column — trade panel */}
        <div className="space-y-4">
          <TradePanelContent
            lang={lang}
            side={side}
            setSide={setSide}
            amount={amount}
            setAmount={setAmount}
            slippage={slippage}
            setSlippage={setSlippage}
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
              <div className="text-white/35 text-[10px] font-mono mb-0.5">{t(lang, 'price')}</div>
              <div className="text-white text-sm font-mono font-bold">
                {suiUsd > 0 ? `$${priceUsd.toFixed(6)}` : `${fmt(priceSui, 6)} SUI`}
              </div>
            </div>
            <div>
              <div className="text-white/35 text-[10px] font-mono mb-0.5">{t(lang, 'inSui')}</div>
              <div className="text-white/50 text-sm font-mono">{fmt(priceSui, 6)} SUI</div>
            </div>
            <div>
              <div className="text-white/35 text-[10px] font-mono mb-0.5">{t(lang, 'mcap')}</div>
              <div className="text-white/70 text-sm font-mono">
                {suiUsd > 0 ? fmtUsd(marketCapSui, suiUsd) : `${fmt(marketCapSui)} SUI`}
              </div>
            </div>
          </div>
        </div>
      </div>
      {/* Back to top — mobile only */}
      <div className="sm:hidden fixed bottom-6 right-4 z-50">
        <button
          onClick={scrollToTop}
          className="bg-white/10 hover:bg-white/20 border border-white/20 rounded-full p-3 text-white/60 hover:text-white transition-colors backdrop-blur-sm"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <polyline points="18 15 12 9 6 15"/>
          </svg>
        </button>
      </div>
    </div>
  );
}

// ── Trade Panel ───────────────────────────────────────────────────────────────

function TradePanelContent({
  lang,
  side, setSide, amount, setAmount,
  slippage, setSlippage,
  quote, txStatus, txMsg,
  account, onExecute, priceSui, priceUsd, suiUsd, symbol, graduated,
  suiBalance, tokenBalance,
  isCreator, creatorFeesMist, curveId: panelCurveId, tokenType: panelTokenType,
}) {
  const { mutate: signAndExecutePanel } = useSignAndExecuteTransaction();
  const client2 = useSuiClient();
  const [claiming, setClaiming] = useState(false);
  const [claimMsg, setClaimMsg] = useState('');
  const [showSlippage, setShowSlippage] = useState(false);
  const [customSlippage, setCustomSlippage] = useState('');
  const isPending = txStatus === 'pending';

  const slippageNum = parseFloat(slippage) || 0;
  const isCustom = !SLIPPAGE_PRESETS.includes(slippage);

  const handleSlippagePreset = (v) => {
    setSlippage(v);
    setCustomSlippage('');
  };

  const handleCustomSlippage = (v) => {
    const clean = v.replace(/[^0-9.]/g, '');
    setCustomSlippage(clean);
    const n = parseFloat(clean);
    if (!isNaN(n) && n >= 0 && n <= 50) setSlippage(clean);
  };

  const handleClaim = async () => {
    if (!account || !panelCurveId || !panelTokenType || claiming) return;
    setClaiming(true);
    setClaimMsg('');
    try {
      const ownedObjs = await client2.getOwnedObjects({
        owner: account.address,
        filter: { StructType: `${PACKAGE_ID}::bonding_curve::CreatorCap` },
        options: { showContent: true },
      });
      const capObj = ownedObjs.data?.find(o => {
        const fields = o.data?.content?.fields;
        return fields?.curve_id === panelCurveId;
      }) ?? ownedObjs.data?.[0];
      if (!capObj) throw new Error('CreatorCap not found in wallet');
      const capId = capObj.data?.objectId;

      const objForRef = await client2.getObject({ id: panelCurveId, options: { showOwner: true } });
      const initialSharedVersion = objForRef.data?.owner?.Shared?.initial_shared_version;
      const tx = new Transaction();
      const curveRef = initialSharedVersion
        ? tx.sharedObjectRef({ objectId: panelCurveId, initialSharedVersion, mutable: true })
        : tx.object(panelCurveId);
      tx.moveCall({
        target: `${PACKAGE_ID}::bonding_curve::claim_creator_fees`,
        typeArguments: [panelTokenType],
        arguments: [tx.object(capId), curveRef],
      });
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
      {/* Header row with slippage toggle */}
      <div className="flex items-center justify-between">
        <div className="text-[10px] font-mono text-white/35 tracking-widest">{t(lang, 'trade')}</div>
        <button
          onClick={() => setShowSlippage(s => !s)}
          className={`flex items-center gap-1.5 px-2 py-1 rounded-lg text-[10px] font-mono transition-colors ${
            showSlippage
              ? 'bg-lime-400/10 border border-lime-400/30 text-lime-400'
              : 'text-white/35 hover:text-white/60'
          }`}
        >
          <Settings size={10} />
          {slippageNum === 0 ? 'NO SLIPPAGE' : `${slippage}% ${t(lang, 'slippage')}`}
        </button>
      </div>

      {/* Slippage panel */}
      {showSlippage && (
        <div className="bg-white/[0.02] border border-white/10 rounded-lg p-3 space-y-2">
          <div className="text-[9px] font-mono text-white/35 tracking-widest">SLIPPAGE TOLERANCE</div>
          <div className="flex gap-1.5">
            {SLIPPAGE_PRESETS.map(v => (
              <button
                key={v}
                onClick={() => handleSlippagePreset(v)}
                className={`flex-1 py-1.5 text-[10px] font-mono rounded-lg border transition-colors ${
                  slippage === v && !isCustom
                    ? 'bg-lime-400/10 border-lime-400/30 text-lime-400'
                    : 'border-white/10 text-white/40 hover:border-white/25 hover:text-white/60'
                }`}
              >
                {v}%
              </button>
            ))}
            <input
              type="number"
              min="0"
              max="50"
              step="0.1"
              value={customSlippage}
              onChange={e => handleCustomSlippage(e.target.value)}
              placeholder="—"
              className={`w-14 py-1.5 text-[10px] font-mono rounded-lg border text-center bg-transparent transition-colors ${
                isCustom
                  ? 'border-lime-400/30 text-lime-400'
                  : 'border-white/10 text-white/40'
              } focus:outline-none focus:border-lime-400/50`}
            />
          </div>
        </div>
      )}

      {/* Graduated state */}
      {graduated ? (
        <div className="text-center py-4 text-xs font-mono text-lime-400/70">
          🎓 {t(lang, 'tokenGraduated')}
        </div>
      ) : (
        <>
          {/* Buy / Sell toggle */}
          <div className="flex rounded-lg overflow-hidden border border-white/10">
            <button
              onClick={() => setSide('buy')}
              className={`flex-1 py-2.5 text-xs font-mono font-bold transition-colors ${
                side === 'buy' ? 'bg-lime-400 text-black' : 'text-white/50 hover:text-white/80'
              }`}
            >
              {t(lang, 'buy')}
            </button>
            <button
              onClick={() => setSide('sell')}
              className={`flex-1 py-2.5 text-xs font-mono font-bold transition-colors ${
                side === 'sell' ? 'bg-red-500 text-white' : 'text-white/50 hover:text-white/80'
              }`}
            >
              {t(lang, 'sell')}
            </button>
          </div>

          {/* Amount input */}
          <div className="space-y-1.5">
            <div className="text-[10px] font-mono text-white/35">
              {side === 'buy' ? t(lang, 'amount') : `${t(lang, 'amount')} ($${symbol})`}
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
                    const max = Math.max(0, suiBalance - 0.1);
                    setAmount(max > 0 ? max.toFixed(4) : '0');
                  } else {
                    setAmount(tokenBalance > 0 ? Math.floor(tokenBalance).toString() : '0');
                  }
                }}
                className="px-2.5 py-2.5 text-[10px] font-mono text-white/35 hover:text-lime-400 border border-white/10 hover:border-lime-400/40 rounded-lg transition-colors"
              >
                {t(lang, 'max')}
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
                  <span className="text-white/35">{t(lang, 'youReceive')}</span>
                  <span className="text-lime-400">{(Number(quote.tokensOut) / 1e6).toLocaleString(undefined, {maximumFractionDigits: 0})} ${symbol}</span>
                </div>
              )}
              {side === 'sell' && quote.suiOut != null && (
                <div className="flex justify-between text-[11px] font-mono">
                  <span className="text-white/35">{t(lang, 'youReceive')}</span>
                  <span className="text-lime-400">
                    {suiUsd > 0
                      ? `$${(Number(quote.suiOut) / 1e9 * suiUsd).toFixed(2)}`
                      : `${fmt(quote.suiOut)} SUI`}
                  </span>
                </div>
              )}
              <div className="flex justify-between text-[10px] font-mono">
                <span className="text-white/25">{t(lang, 'priceImpact')}</span>
                <span className="text-white/40">~1% {t(lang, 'fee')}</span>
              </div>
              {!showSlippage && slippageNum > 0 && (
                <div className="flex justify-between text-[10px] font-mono border-t border-white/5 pt-1.5">
                  <span className="text-white/25">{t(lang, 'minReceived')} ({slippage}% {t(lang, 'slippage')})</span>
                  <span className="text-white/40">
                    {side === 'buy' && quote.tokensOut != null
                      ? `${(Number(quote.tokensOut) / 1e6 * (1 - slippageNum / 100)).toLocaleString(undefined, {maximumFractionDigits: 0})} $${symbol}`
                      : side === 'sell' && quote.suiOut != null
                        ? `${fmt(Number(quote.suiOut) / 1e9 * (1 - slippageNum / 100))} SUI`
                        : '—'}
                  </span>
                </div>
              )}
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
                    ? 'bg-lime-400 text-black hover:bg-lime-300'
                    : 'bg-red-500 text-white hover:bg-red-400'
            }`}
          >
            {isPending ? t(lang, 'confirming') : side === 'buy' ? t(lang, 'buy') : t(lang, 'sell')}
          </button>

          {/* Tx status */}
          {txMsg && (
            <div className={`text-[10px] font-mono text-center ${
              txStatus === 'success' ? 'text-lime-400' : 'text-red-400'
            }`}>
              {txMsg}
            </div>
          )}
        </>
      )}

      {/* Claim fees — creator only */}
      {isCreator && (
        <div className="pt-2 border-t border-white/5 space-y-2">
          <div className="flex justify-between text-[10px] font-mono text-white/35">
            <span>{t(lang, 'creatorFees')}</span>
            <span className="text-lime-400/70">
              {fmt(Number(creatorFeesMist) / 1e9)} SUI
            </span>
          </div>
          <button
            onClick={handleClaim}
            disabled={claiming || creatorFeesMist === 0n}
            className={`w-full py-2 rounded-lg text-[10px] font-mono font-bold transition-colors ${
              claiming || creatorFeesMist === 0n
                ? 'bg-white/5 text-white/20 cursor-not-allowed'
                : 'bg-lime-400/10 border border-lime-400/30 text-lime-400 hover:bg-lime-400/20'
            }`}
          >
            {claiming ? t(lang, 'claiming') : t(lang, 'claimFees')}
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
          <div className="text-[10px] font-mono text-white/35 mb-0.5">{t(lang, 'price')}</div>
          <div className="text-white/70 text-xs font-mono">
            {suiUsd > 0 ? `$${priceUsd.toFixed(6)}` : `${fmt(priceSui, 6)} SUI`}
          </div>
        </div>
        <div>
          <div className="text-[10px] font-mono text-white/35 mb-0.5">{t(lang, 'inSui')}</div>
          <div className="text-white/50 text-xs font-mono">{fmt(priceSui, 6)} SUI</div>
        </div>
      </div>
    </div>
  );
}

// ── Trades / Holders toggle block ─────────────────────────────────────────────

function TradesHoldersBlock({ curveId, tokenType, suiUsd, lang }) {
  const [tab, setTab] = useState('trades');

  return (
    <div className="space-y-0">
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
          {t(lang, 'holders')}
        </button>
      </div>
      <div className="[&>div]:rounded-t-none [&>div]:border-t-0">
        {tab === 'trades'
          ? <TradeHistory curveId={curveId} suiUsd={suiUsd} />
          : <HolderList curveId={curveId} tokenType={tokenType} suiUsd={suiUsd} />
        }
      </div>
    </div>
  );
}

// ── Comments wrapper ──────────────────────────────────────────────────────────

function CommentsBlock({ curveId, lang }) {
  return (
    <div>
      <div className="text-[10px] font-mono text-white/35 tracking-widest mb-2">{t(lang, 'comments')}</div>
      <Comments curveId={curveId} />
    </div>
  );
}
