// TokenPage.jsx
// Full trading UI for a single token. Receives curveId + tokenType as props
// from the router, fetches live curve state, and handles buy/sell.
// This is the existing App.jsx trading logic made generic.

import React, { useState, useMemo, useEffect } from 'react';
import {
  useCurrentAccount,
  useSignAndExecuteTransaction,
  useSuiClient,
  useSuiClientQuery,
} from '@mysten/dapp-kit';
import { Transaction } from '@mysten/sui/transactions';
import { Crown, Rocket, ExternalLink, ArrowLeft } from 'lucide-react';

import { PACKAGE_ID, DRAIN_SUI_APPROX, TOKEN_DECIMALS, MIST_PER_SUI } from './constants.js';
import { quoteBuy, quoteSell, priceMistPerToken, mistToSui, tokenUnitsToWhole } from './curve.js';
import PriceChart from './PriceChart.jsx';

function fmt(n, d = 2) {
  if (!Number.isFinite(n)) return '—';
  if (n >= 1e9) return (n / 1e9).toFixed(d) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(d) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(d) + 'k';
  if (n !== 0 && Math.abs(n) < 0.0001) return n.toExponential(2);
  return n.toFixed(d);
}
const fmtSui = (mist) => fmt(mistToSui(mist ?? 0), 4);

export default function TokenPage({ curveId, tokenType, onBack }) {
  const account = useCurrentAccount();
  const client = useSuiClient();
  const { mutateAsync: signAndExecute, isPending } = useSignAndExecuteTransaction();

  const [amount, setAmount] = useState('');
  const [side, setSide] = useState('buy');
  const [status, setStatus] = useState(null);
  const [metadata, setMetadata] = useState(null);
  const [chartRefresh, setChartRefresh] = useState(0);

  // Fetch CoinMetadata (description, iconUrl)
  useEffect(() => {
    let cancelled = false;
    client.getCoinMetadata({ coinType: tokenType }).then(m => {
      if (!cancelled) setMetadata(m);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [tokenType, client]);

  // Live curve state
  const curveQuery = useSuiClientQuery(
    'getObject',
    { id: curveId, options: { showContent: true } },
    { refetchInterval: 5000 }
  );

  // Token balance for sells
  const balanceQuery = useSuiClientQuery(
    'getBalance',
    { owner: account?.address, coinType: tokenType },
    { enabled: !!account?.address, refetchInterval: 5000 }
  );

  const fields = curveQuery.data?.data?.content?.fields;
  const reserveMist = fields ? BigInt(fields.sui_reserve) : 0n;
  const tokensRemaining = fields ? BigInt(fields.token_reserve) : 0n;
  const graduated = fields?.graduated ?? false;
  const tokensSold = fields
    ? BigInt(800_000_000) * 10n ** BigInt(TOKEN_DECIMALS) - tokensRemaining
    : 0n;

  const reserveSui = mistToSui(reserveMist);
  const progress = Math.min(100, (reserveSui / DRAIN_SUI_APPROX) * 100);
  const priceMist = fields ? priceMistPerToken(reserveMist, tokensSold) : 0n;
  const creatorFees = fields ? BigInt(fields.creator_fees) : 0n;
  const tokenBalanceWhole = balanceQuery.data
    ? tokenUnitsToWhole(balanceQuery.data.totalBalance)
    : 0;

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

    if (side === 'buy') {
      const mistAmount = BigInt(Math.floor(parseFloat(amount) * MIST_PER_SUI));
      const [payment] = tx.splitCoins(tx.gas, [tx.pure.u64(mistAmount)]);
      const minOut = (quote.tokensOut * 99n) / 100n;
      const [tokens, refund] = tx.moveCall({
        target: `${PACKAGE_ID}::bonding_curve::buy`,
        typeArguments: [tokenType],
        arguments: [tx.object(curveId), payment, tx.pure.u64(minOut)],
      });
      tx.transferObjects([tokens, refund], account.address);
    } else {
      const coins = await client.getCoins({ owner: account.address, coinType: tokenType });
      if (coins.data.length === 0) {
        setStatus({ kind: 'error', msg: 'No tokens to sell.' });
        return;
      }
      const primary = tx.object(coins.data[0].coinObjectId);
      if (coins.data.length > 1) {
        tx.mergeCoins(primary, coins.data.slice(1).map(c => tx.object(c.coinObjectId)));
      }
      const [toSell] = tx.splitCoins(primary, [tx.pure.u64(quote.tokensIn)]);
      const minOut = (quote.suiOut * 99n) / 100n;
      const suiOut = tx.moveCall({
        target: `${PACKAGE_ID}::bonding_curve::sell`,
        typeArguments: [tokenType],
        arguments: [tx.object(curveId), toSell, tx.pure.u64(minOut)],
      });
      tx.transferObjects([suiOut], account.address);
    }

    try {
      const result = await signAndExecute({ transaction: tx });
      setStatus({ kind: 'success', msg: 'Transaction confirmed', digest: result.digest });
      setAmount('');
      curveQuery.refetch();
      balanceQuery.refetch();
      setChartRefresh(r => r + 1);
    } catch (err) {
      setStatus({ kind: 'error', msg: err.message || String(err) });
    }
  };

  if (curveQuery.isLoading) {
    return <div className="text-lime-600 font-mono text-sm p-8">Loading curve…</div>;
  }

  if (!fields) {
    return <div className="text-red-400 font-mono text-sm p-8">Could not load curve data.</div>;
  }

  return (
    <div>
      {/* Back button */}
      <button
        onClick={onBack}
        className="flex items-center gap-2 text-xs font-mono text-lime-700 hover:text-lime-400 mb-6"
      >
        <ArrowLeft size={12} /> BACK TO ALL TOKENS
      </button>

      <div className="grid lg:grid-cols-3 gap-4">
        {/* Left: curve state */}
        <div className="lg:col-span-2 space-y-4">
          <div className="border border-lime-900/50 bg-black p-5">
            <div className="flex items-start justify-between mb-4">
              <div className="flex items-center gap-4">
                {metadata?.iconUrl ? (
                  <img src={metadata.iconUrl} alt={fields.symbol}
                    className="w-14 h-14 rounded-full object-cover border border-lime-900"
                    onError={e => { e.target.style.display='none'; }}
                  />
                ) : (
                  <div className="text-5xl">🔥</div>
                )}
                <div>
                  <h2 className="text-2xl font-bold text-lime-100">{fields.name}</h2>
                  <div className="text-sm text-lime-600 font-mono">${fields.symbol}</div>
                  {metadata?.description && (
                    <div className="text-xs text-lime-700 font-mono mt-1 max-w-xs">{metadata.description}</div>
                  )}
                </div>
              </div>
              <div className="text-right">
                <div className="text-xs text-lime-700 font-mono tracking-widest">PRICE</div>
                <div className="text-2xl font-bold text-lime-200 font-mono">
                  {(Number(priceMist) / 1e9).toFixed(9)}
                </div>
                <div className="text-xs text-lime-600 font-mono">SUI per token</div>
              </div>
            </div>

            <div className="border-t border-lime-950 pt-4">
              <div className="flex justify-between items-center mb-2">
                <div className="flex items-center gap-2 text-xs font-mono tracking-widest text-lime-400">
                  <Rocket size={12} /> BONDING CURVE {graduated ? '· GRADUATED' : ''}
                </div>
                <div className="text-xs font-mono text-lime-300">
                  {fmt(reserveSui)} / ~{fmt(DRAIN_SUI_APPROX)} SUI
                </div>
              </div>
              <div className="h-3 bg-lime-950 relative overflow-hidden">
                <div
                  className="h-full bg-gradient-to-r from-lime-600 via-lime-400 to-lime-200"
                  style={{ width: `${progress}%` }}
                />
              </div>
            </div>

            {/* Price chart */}
            <div className="border-t border-lime-950 pt-3 mt-3">
              <PriceChart curveId={curveId} refreshKey={chartRefresh} />
            </div>
          </div>

          {/* Creator */}
          <div className="border border-amber-900/50 bg-gradient-to-br from-amber-950/20 to-black p-5">
            <div className="flex items-center justify-between">
              <div>
                <div className="flex items-center gap-2 text-xs font-mono tracking-widest text-amber-400 mb-2">
                  <Crown size={12} /> CREATOR REVENUE · 40% OF 1% FEES
                </div>
                <div className="text-xs font-mono text-amber-700 mb-1">CREATOR</div>
                <div className="text-sm font-mono text-amber-200 break-all">{fields.creator}</div>
              </div>
              <div className="text-right">
                <div className="text-xs font-mono text-amber-700">ACCRUED</div>
                <div className="text-3xl font-bold text-amber-200 font-mono tabular-nums">
                  {fmtSui(creatorFees)}
                </div>
                <div className="text-xs text-amber-600 font-mono">SUI</div>
              </div>
            </div>
          </div>

          {/* Balance */}
          <div className="border border-lime-900/50 bg-black p-4 flex items-center justify-between text-xs font-mono">
            <span className="text-lime-700 tracking-widest">YOUR ${fields.symbol} BALANCE</span>
            <span className="text-lime-200">{fmt(tokenBalanceWhole)} {fields.symbol}</span>
          </div>

          {/* Status */}
          {status && (
            <div className={`border p-3 text-xs font-mono ${
              status.kind === 'success'
                ? 'border-lime-500 bg-lime-950/30 text-lime-300'
                : 'border-red-500 bg-red-950/30 text-red-300'
            }`}>
              {status.msg}
              {status.digest && (
                <a
                  href={`https://testnet.suivision.xyz/txblock/${status.digest}`}
                  target="_blank" rel="noreferrer"
                  className="ml-2 underline inline-flex items-center gap-1"
                >
                  view tx <ExternalLink size={10} />
                </a>
              )}
            </div>
          )}
        </div>

        {/* Right: trade panel */}
        <div className="border border-lime-500/60 bg-black p-5 h-fit sticky top-20">
          <div className="flex gap-2 mb-4">
            <button onClick={() => setSide('buy')}
              className={`flex-1 py-2 text-xs font-mono tracking-widest border ${
                side === 'buy' ? 'bg-lime-400 text-black border-lime-400'
                : 'bg-black text-lime-600 border-lime-900 hover:border-lime-600'
              }`}
            >BUY</button>
            <button onClick={() => setSide('sell')}
              className={`flex-1 py-2 text-xs font-mono tracking-widest border ${
                side === 'sell' ? 'bg-red-400 text-black border-red-400'
                : 'bg-black text-lime-600 border-lime-900 hover:border-red-600'
              }`}
            >SELL</button>
          </div>

          <div className="mb-1 text-[10px] font-mono text-lime-700 tracking-widest">
            {side === 'buy' ? 'YOU PAY (SUI)' : `YOU SELL (${fields.symbol})`}
          </div>
          <input
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0.0"
            className="w-full bg-lime-950/30 border border-lime-900 px-3 py-3 text-lime-100 font-mono text-xl focus:outline-none focus:border-lime-400"
          />

          {side === 'buy' && (
            <div className="flex gap-1 mt-2">
              {[0.1, 0.5, 1, 5].map((v) => (
                <button key={v} onClick={() => setAmount(String(v))}
                  className="flex-1 text-[10px] font-mono py-1 border border-lime-900 text-lime-600 hover:border-lime-400"
                >{v}</button>
              ))}
            </div>
          )}
          {side === 'sell' && tokenBalanceWhole > 0 && (
            <div className="flex gap-1 mt-2">
              {[25, 50, 100].map((pct) => (
                <button key={pct}
                  onClick={() => setAmount(String((tokenBalanceWhole * pct / 100).toFixed(TOKEN_DECIMALS)))}
                  className="flex-1 text-[10px] font-mono py-1 border border-lime-900 text-lime-600 hover:border-lime-400"
                >{pct}%</button>
              ))}
            </div>
          )}

          {quote && (
            <div className="mt-4 p-3 border border-lime-900 bg-lime-950/20 space-y-1 text-xs font-mono">
              <div className="flex justify-between">
                <span className="text-lime-700">YOU RECEIVE</span>
                <span className="text-lime-100">
                  {side === 'buy'
                    ? `${fmt(tokenUnitsToWhole(quote.tokensOut))} ${fields.symbol}`
                    : `${fmtSui(quote.suiOut)} SUI`}
                </span>
              </div>
              {side === 'buy' && quote.clipped && (
                <div className="flex justify-between">
                  <span className="text-amber-700">REFUND (TAIL CLIP)</span>
                  <span className="text-amber-400">{fmtSui(quote.refund)} SUI</span>
                </div>
              )}
              <div className="flex justify-between pt-1 border-t border-lime-950">
                <span className="text-lime-700">TOTAL FEE (1%)</span>
                <span className="text-lime-500">{fmtSui(quote.fee)} SUI</span>
              </div>
              <div className="flex justify-between pl-3">
                <span className="text-amber-700">├ CREATOR (0.40%)</span>
                <span className="text-amber-400">{fmtSui(quote.fees.creator)}</span>
              </div>
              <div className="flex justify-between pl-3">
                <span className="text-lime-700">├ PROTOCOL (0.50%)</span>
                <span className="text-lime-500">{fmtSui(quote.fees.protocol)}</span>
              </div>
              <div className="flex justify-between pl-3">
                <span className="text-cyan-700">└ LIQUIDITY (0.10%)</span>
                <span className="text-cyan-400">{fmtSui(quote.fees.lp)}</span>
              </div>
            </div>
          )}

          <button
            onClick={execute}
            disabled={!quote || isPending || graduated || !account}
            className={`w-full mt-4 py-3 font-mono tracking-widest text-sm ${
              graduated ? 'bg-lime-950 text-lime-800 cursor-not-allowed'
              : !account ? 'bg-lime-950 text-lime-800 cursor-not-allowed'
              : quote && !isPending
                ? side === 'buy'
                  ? 'bg-lime-400 text-black hover:bg-lime-300'
                  : 'bg-red-400 text-black hover:bg-red-300'
                : 'bg-lime-950 text-lime-800 cursor-not-allowed'
            }`}
          >
            {graduated ? 'GRADUATED — TRADE ON DEX'
              : !account ? 'CONNECT WALLET'
              : isPending ? 'CONFIRMING…'
              : !quote ? 'ENTER AMOUNT'
              : `EXECUTE ${side.toUpperCase()}`}
          </button>

          <div className="mt-4 text-[10px] font-mono text-lime-800 leading-relaxed">
            TESTNET · SLIPPAGE 1% · FAIR LAUNCH · NO TEAM ALLOCATION
          </div>
        </div>
      </div>
    </div>
  );
}
