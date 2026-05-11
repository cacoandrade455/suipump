// curve.js
import {
  TRADE_FEE_BPS, CREATOR_SHARE_BPS, PROTOCOL_SHARE_BPS,
  CURVE_SUPPLY, VIRTUAL_SUI, VIRTUAL_TOKENS, MIST_PER_SUI, TOKEN_DECIMALS,
} from './constants.js';

function quoteOut(dx, x, y) {
  return (BigInt(y) * BigInt(dx)) / (BigInt(x) + BigInt(dx));
}

function splitFee(fee) {
  const creator  = (fee * BigInt(CREATOR_SHARE_BPS))  / 10_000n;
  const protocol = (fee * BigInt(PROTOCOL_SHARE_BPS)) / 10_000n;
  const lp       = fee - creator - protocol;
  return { creator, protocol, lp };
}

// TokenPage.jsx calls: buyQuote(reserveMist, tokensRemaining, suiInMist)
export function buyQuote(reserveMist, tokensRemaining, suiInMist) {
  const suiIn  = BigInt(suiInMist);
  const fee    = (suiIn * BigInt(TRADE_FEE_BPS)) / 10_000n;
  const fees   = splitFee(fee);
  const swap   = suiIn - fee;

  const vSui = BigInt(VIRTUAL_SUI) * BigInt(MIST_PER_SUI);
  const x    = BigInt(reserveMist) + vSui;
  const y    = BigInt(tokensRemaining);

  const out     = quoteOut(swap, x, y);
  const clipped = out >= y;

  return {
    tokensOut:  clipped ? y : out,
    fee, fees,
    actualSwap: swap,
    refund:     0n,
    clipped,
  };
}

// TokenPage.jsx calls: sellQuote(reserveMist, tokensRemaining, tokensInAtomic)
export function sellQuote(reserveMist, tokensRemaining, tokensInAtomic) {
  const tokIn = BigInt(tokensInAtomic);
  const vSui  = BigInt(VIRTUAL_SUI) * BigInt(MIST_PER_SUI);

  const x       = BigInt(tokensRemaining);
  const y       = BigInt(reserveMist) + vSui;
  const gross   = quoteOut(tokIn, x, y);
  const fee     = (gross * BigInt(TRADE_FEE_BPS)) / 10_000n;
  const fees    = splitFee(fee);
  return { suiOut: gross - fee, fee, fees };
}

export function priceMistPerToken(realSuiReserve, tokensSold) {
  const vSui  = BigInt(VIRTUAL_SUI) * BigInt(MIST_PER_SUI);
  const vTok  = BigInt(VIRTUAL_TOKENS) * (10n ** BigInt(TOKEN_DECIMALS));
  const x     = BigInt(realSuiReserve) + vSui;
  const y     = vTok - BigInt(tokensSold);
  if (y <= 0n) return 0n;
  return (x * 1_000_000n) / y;
}

export const mistToSui = (m) => (m == null ? 0 : Number(BigInt(m)) / 1e9);
export const tokenUnitsToWhole = (u) => (u == null ? 0 : Number(BigInt(u)) / 1e6);

export const quoteBuy  = buyQuote;
export const quoteSell = sellQuote;
