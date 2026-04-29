import React, { useState, useMemo } from 'react';
import {
  ConnectButton,
  useCurrentAccount,
  useSignAndExecuteTransaction,
  useSuiClient,
  useSuiClientQuery,
} from '@mysten/dapp-kit';
import { Transaction } from '@mysten/sui/transactions';
import {
  TrendingUp, TrendingDown, Crown, Flame, Rocket, Zap, ExternalLink,
} from 'lucide-react';

import {
  PACKAGE_ID, CURVE_ID, TOKEN_TYPE, DRAIN_SUI_APPROX, TOKEN_DECIMALS,
  MIST_PER_SUI,
} from './constants.js';
import {
  quoteBuy, quoteSell, splitFee, priceMistPerToken, mistToSui, tokenUnitsToWhole,
} from './curve.js';

// ---------- Formatters ----------
function fmt(n, d = 2) {
  if (!Number.isFinite(n)) return '—';
  if (n >= 1e9) return (n / 1e9).toFixed(d) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(d) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(d) + 'k';
  if (n !== 0 && Math.abs(n) < 0.0001) return n.toExponential(2);
  return n.toFixed(d);
}
const fmtSui = (mist) => fmt(mistToSui(mist ?? 0), 4);

// ---------- Hooks ----------
/** Read live curve state from chain. Refetches every 5s. */
function useCurveState() {
  return useSuiClientQuery(
    'getObject',
    { id: CURVE_ID, options: { showContent: true } },
    { refetchInterval: 5000 }
  );
}

/** Pick up the buyer's token balance (for sells). */
function useTokenBalance(owner) {
  return useSuiClientQuery(
    'getBalance',
    { owner, coinType: TOKEN_TYPE },
    { enabled: !!owner, refetchInterval: 5000 }
  );
}

// ---------- Main ----------
export default function App() {
  const account = useCurrentAccount();
  const curveQuery = useCurveState();
  const tokenBalance = useTokenBalance(account?.address);
  const client = useSuiClient();
  const { mutateAsync: signAndExecute, isPending } = useSignAndExecuteTransaction();

  const [amount, setAmount] = useState('');
  const [side, setSide] = useState('buy');
  const [status, setStatus] = useState(null); // {kind: 'success'|'error', msg, digest?}

  const fields = curveQuery.data?.data?.content?.fields;
  const reserveMist = fields ? BigInt(fields.sui_reserve) : 0n;
  const tokensRemaining = fields ? BigInt(fields.token_reserve) : 0n;
  const creatorFeesAccrued = fields ? BigInt(fields.creator_fees) : 0n;
  const protocolFeesAccrued = fields ? BigInt(fields.protocol_fees) : 0n;
  const graduated = fields?.graduated ?? false;
  const tokensSold = fields
    ? BigInt(800_000_000) * 10n ** BigInt(TOKEN_DECIMALS) - tokensRemaining
    : 0n;

  const reserveSui = mistToSui(reserveMist);
  const progress = Math.min(100, (reserveSui / DRAIN_SUI_APPROX) * 100);
  const priceMist = fields ? priceMistPerToken(reserveMist, tokensSold) : 0n;

  // Live quote for the current input.
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
    } catch {
      return null;
    }
  }, [amount, side, reserveMist, tokensSold, fields]);

  const execute = async () => {
    if (!account || !quote) return;
    setStatus(null);

    const tx = new Transaction();

    if (side === 'buy') {
      const mistAmount = BigInt(Math.floor(parseFloat(amount) * MIST_PER_SUI));
      const [payment] = tx.splitCoins(tx.gas, [tx.pure.u64(mistAmount)]);
      // 1% slippage floor
      const minOut = (quote.tokensOut * 99n) / 100n;
      const [tokens, refund] = tx.moveCall({
        target: `${PACKAGE_ID}::bonding_curve::buy`,
        typeArguments: [TOKEN_TYPE],
        arguments: [tx.object(CURVE_ID), payment, tx.pure.u64(minOut)],
      });
      tx.transferObjects([tokens, refund], account.address);
    } else {
      // Sell: need to locate a Coin<T> owned by us with enough balance.
      // Fetch coins, pick/merge as needed, then slice.
      const coins = await client.getCoins({ owner: account.address, coinType: TOKEN_TYPE });
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
        typeArguments: [TOKEN_TYPE],
        arguments: [tx.object(CURVE_ID), toSell, tx.pure.u64(minOut)],
      });
      tx.transferObjects([suiOut], account.address);
    }

    try {
      const result = await signAndExecute({ transaction: tx });
      setStatus({ kind: 'success', msg: 'Transaction confirmed', digest: result.digest });
      setAmount('');
      // Refetch curve + balance
      curveQuery.refetch();
      tokenBalance.refetch();
    } catch (err) {
      setStatus({ kind: 'error', msg: err.message || String(err) });
    }
  };

  const tokenBalanceWhole = tokenBalance.data
    ? tokenUnitsToWhole(tokenBalance.data.totalBalance)
    : 0;

  return (
    <div className="min-h-screen bg-black text-lime-100" style={{ fontFamily: "'JetBrains Mono', ui-monospace, monospace" }}>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;700&family=Space+Grotesk:wght@700&display=swap');`}</style>

      {/* Scanline grid */}
      <div className="fixed inset-0 pointer-events-none opacity-[0.04]" style={{
        backgroundImage: 'linear-gradient(rgba(132,204,22,0.8) 1px, transparent 1px), linear-gradient(90deg, rgba(132,204,22,0.8) 1px, transparent 1px)',
        backgroundSize: '40px 40px',
      }} />

      <header className="border-b border-lime-900/60 bg-black/80 backdrop-blur sticky top-0 z-40">
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="relative">
              <Flame className="text-lime-400" size={24} />
              <div className="absolute inset-0 blur-md bg-lime-400/50 -z-10" />
            </div>
            <div>
              <div className="text-lg font-bold tracking-tight" style={{ fontFamily: "'Space Grotesk', sans-serif" }}>
                SUIPUMP<span className="text-lime-400">.</span>
              </div>
              <div className="text-[9px] font-mono text-lime-700 tracking-[0.2em] -mt-1">
                TESTNET · LIVE
              </div>
            </div>
          </div>
          <ConnectButton />
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 py-6">
        {!account ? (
          <div className="border border-lime-900/50 bg-gradient-to-br from-lime-950/20 to-black p-10 text-center">
            <Flame className="text-lime-400 mx-auto mb-4" size={32} />
            <h1 className="text-3xl font-bold tracking-tight mb-2" style={{ fontFamily: "'Space Grotesk', sans-serif" }}>
              CONNECT WALLET TO BEGIN
            </h1>
            <p className="text-sm text-lime-600 font-mono">
              Install Sui Wallet, Suiet, or Slush — then click CONNECT above. Testnet SUI only.
            </p>
          </div>
        ) : curveQuery.isLoading ? (
          <div className="text-lime-600 font-mono text-sm">Loading curve…</div>
        ) : curveQuery.error ? (
          <div className="text-red-400 font-mono text-sm">Failed to load curve: {String(curveQuery.error)}</div>
        ) : (
          <div className="grid lg:grid-cols-3 gap-4">
            {/* Left: curve state */}
            <div className="lg:col-span-2 space-y-4">
              <div className="border border-lime-900/50 bg-black p-5">
                <div className="flex items-start justify-between mb-4">
                  <div className="flex items-center gap-4">
                    <div className="text-5xl">🔥</div>
                    <div>
                      <h2 className="text-2xl font-bold text-lime-100">{fields.name}</h2>
                      <div className="text-sm text-lime-600 font-mono">${fields.symbol}</div>
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
              </div>

              {/* Creator revenue */}
              <div className="border border-amber-900/50 bg-gradient-to-br from-amber-950/20 to-black p-5">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="flex items-center gap-2 text-xs font-mono tracking-widest text-amber-400 mb-2">
                      <Crown size={12} /> CREATOR REVENUE · 40% OF 1% FEES
                    </div>
                    <div className="text-xs font-mono text-amber-700 mb-1">CREATOR</div>
                    <div className="text-sm font-mono text-amber-200 break-all">
                      {fields.creator}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-xs font-mono text-amber-700">ACCRUED</div>
                    <div className="text-3xl font-bold text-amber-200 font-mono tabular-nums">
                      {fmtSui(creatorFeesAccrued)}
                    </div>
                    <div className="text-xs text-amber-600 font-mono">SUI</div>
                  </div>
                </div>
              </div>

              {/* Your balance */}
              <div className="border border-lime-900/50 bg-black p-4 flex items-center justify-between text-xs font-mono">
                <span className="text-lime-700 tracking-widest">YOUR ${fields.symbol} BALANCE</span>
                <span className="text-lime-200">{fmt(tokenBalanceWhole)} {fields.symbol}</span>
              </div>

              {/* Status / tx feedback */}
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

            {/* Right: trade */}
            <div className="border border-lime-500/60 bg-black p-5 h-fit sticky top-20">
              <div className="flex gap-2 mb-4">
                <button
                  onClick={() => setSide('buy')}
                  className={`flex-1 py-2 text-xs font-mono tracking-widest border ${
                    side === 'buy' ? 'bg-lime-400 text-black border-lime-400'
                    : 'bg-black text-lime-600 border-lime-900 hover:border-lime-600'
                  }`}
                >BUY</button>
                <button
                  onClick={() => setSide('sell')}
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
                    <button
                      key={pct}
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
                disabled={!quote || isPending || graduated}
                className={`w-full mt-4 py-3 font-mono tracking-widest text-sm ${
                  graduated
                    ? 'bg-lime-950 text-lime-800 cursor-not-allowed'
                    : quote && !isPending
                      ? side === 'buy'
                        ? 'bg-lime-400 text-black hover:bg-lime-300'
                        : 'bg-red-400 text-black hover:bg-red-300'
                      : 'bg-lime-950 text-lime-800 cursor-not-allowed'
                }`}
              >
                {graduated ? 'GRADUATED — TRADE ON DEX'
                  : isPending ? 'CONFIRMING…'
                  : !quote ? 'ENTER AMOUNT'
                  : `EXECUTE ${side.toUpperCase()}`}
              </button>

              <div className="mt-4 text-[10px] font-mono text-lime-800 leading-relaxed">
                TESTNET · SLIPPAGE 1% · FAIR LAUNCH · NO TEAM ALLOCATION
              </div>
            </div>
          </div>
        )}
      </main>

      <footer className="max-w-6xl mx-auto px-4 py-8 text-[10px] font-mono text-lime-800 text-center tracking-widest">
        SUIPUMP · TESTNET DEMO · CONTRACTS UNAUDITED · DYOR
      </footer>
    </div>
  );
}
