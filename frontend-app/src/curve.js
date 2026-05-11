// curve.js
// Calling convention matches TokenPage.jsx:
//   buyQuote(reserveMist, tokensRemaining, suiInMist)
//   sellQuote(reserveMist, tokensRemaining, tokensInAtomic)
// tokensRemaining = curve.token_reserve (real tokens left in curve)

import {
  TRADE_FEE_BPS, CREATOR_SHARE_BPS, PROTOCOL_SHARE_BPS,
  VIRTUAL_SUI, VIRTUAL_TOKENS, MIST_PER_SUI, TOKEN_DECIMALS, CURVE_SUPPLY,
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

// buyQuote(reserveMist, tokensRemaining, suiInMist)
// x = SUI side (virtual+real), y = token side (tokensRemaining = real tokens left)
export function buyQuote(reserveMist, tokensRemaining, suiInMist) {
  const suiIn = BigInt(suiInMist);
  const fee   = (suiIn * BigInt(TRADE_FEE_BPS)) / 10_000n;
  const fees  = splitFee(fee);
  const swap  = suiIn - fee;

  const vSui = BigInt(VIRTUAL_SUI) * BigInt(MIST_PER_SUI);
  const x    = BigInt(reserveMist) + vSui;   // effective SUI reserve
  const y    = BigInt(tokensRemaining);       // tokens available to buy

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

// sellQuote(reserveMist, tokensRemaining, tokensInAtomic)
// Mirror of Move: x = effective_token_reserve (virtual), y = effective_SUI_reserve
export function sellQuote(reserveMist, tokensRemaining, tokensInAtomic) {
  const tokIn = BigInt(tokensInAtomic);

  const vSui = BigInt(VIRTUAL_SUI)   * BigInt(MIST_PER_SUI);
  const vTok = BigInt(VIRTUAL_TOKENS) * (10n ** BigInt(TOKEN_DECIMALS));

  // tokensSold = CURVE_SUPPLY - tokensRemaining (in atomic units)
  const curveSup   = BigInt(CURVE_SUPPLY) * (10n ** BigInt(TOKEN_DECIMALS));
  const tokensSold = curveSup - BigInt(tokensRemaining);

  // effective reserves matching Move contract
  const x = vTok - tokensSold;              // effective token reserve
  const y = BigInt(reserveMist) + vSui;     // effective SUI reserve

  const gross = quoteOut(tokIn, x, y);
  const fee   = (gross * BigInt(TRADE_FEE_BPS)) / 10_000n;
  const fees  = splitFee(fee);
  return { suiOut: gross - fee, fee, fees };
}

export function priceMistPerToken(realSuiReserve, tokensSold) {
  const vSui  = BigInt(VIRTUAL_SUI)   * BigInt(MIST_PER_SUI);
  const vTok  = BigInt(VIRTUAL_TOKENS) * (10n ** BigInt(TOKEN_DECIMALS));
  const x     = BigInt(realSuiReserve) + vSui;
  const y     = vTok - BigInt(tokensSold);
  if (y <= 0n) return 0n;
  return (x * 1_000_000n) / y;
}

export const mistToSui      = (m) => (m == null ? 0 : Number(BigInt(m)) / 1e9);
export const tokenUnitsToWhole = (u) => (u == null ? 0 : Number(BigInt(u)) / 1e6);

export const quoteBuy  = buyQuote;
export const quoteSell = sellQuote;
