// curve.js
// Calling convention:
//   buyQuote(reserveMist, tokensRemaining, suiInMist, vSuiOverride?, vTokOverride?)
//   sellQuote(reserveMist, tokensRemaining, tokensInAtomic, vSuiOverride?, vTokOverride?)
//
// vSuiOverride / vTokOverride: pass per-token virtual reserves when v4 and v5
// tokens coexist. Defaults to constants.js values if not provided.

import {
  TRADE_FEE_BPS, CREATOR_SHARE_BPS, PROTOCOL_SHARE_BPS,
  VIRTUAL_SUI_V4, VIRTUAL_TOKENS_V4,
  VIRTUAL_SUI_V5, VIRTUAL_TOKENS_V5,
  MIST_PER_SUI, TOKEN_DECIMALS, CURVE_SUPPLY,
  PACKAGE_ID_V5,
} from './constants.js';

// Default to v4 in curve.js — TokenPage always passes explicit overrides
const DEFAULT_VIRTUAL_SUI    = VIRTUAL_SUI_V4;
const DEFAULT_VIRTUAL_TOKENS = VIRTUAL_TOKENS_V4;

function quoteOut(dx, x, y) {
  return (BigInt(y) * BigInt(dx)) / (BigInt(x) + BigInt(dx));
}

function splitFee(fee) {
  const creator  = (fee * BigInt(CREATOR_SHARE_BPS))  / 10_000n;
  const protocol = (fee * BigInt(PROTOCOL_SHARE_BPS)) / 10_000n;
  const lp       = fee - creator - protocol;
  return { creator, protocol, lp };
}

export function buyQuote(reserveMist, tokensRemaining, suiInMist, vSuiOverride, vTokOverride) {
  const suiIn = BigInt(suiInMist);
  const fee   = (suiIn * BigInt(TRADE_FEE_BPS)) / 10_000n;
  const fees  = splitFee(fee);
  const swap  = suiIn - fee;

  const vSuiSui = vSuiOverride ?? DEFAULT_VIRTUAL_SUI;
  const vSui    = BigInt(vSuiSui) * BigInt(MIST_PER_SUI);
  const x       = BigInt(reserveMist) + vSui;
  const y       = BigInt(tokensRemaining);

  const out     = quoteOut(swap, x, y);
  const clipped = out >= y;

  return {
    tokensOut:  clipped ? y : out,
    fee, fees,
    actualSwap: swap,
    refund:     0n,
    clipped,
    priceImpact: y > 0n ? Number((out * 10000n) / y) / 100 : 0,
  };
}

export function sellQuote(reserveMist, tokensRemaining, tokensInAtomic, vSuiOverride, vTokOverride) {
  const tokIn = BigInt(tokensInAtomic);

  const vSuiSui  = vSuiOverride ?? DEFAULT_VIRTUAL_SUI;
  const vTokTok  = vTokOverride ?? DEFAULT_VIRTUAL_TOKENS;
  const vSui     = BigInt(vSuiSui)  * BigInt(MIST_PER_SUI);
  const vTok     = BigInt(vTokTok)  * (10n ** BigInt(TOKEN_DECIMALS));

  const curveSup   = BigInt(CURVE_SUPPLY) * (10n ** BigInt(TOKEN_DECIMALS));
  const tokensSold = curveSup - BigInt(tokensRemaining);

  const x = vTok - tokensSold;
  const y = BigInt(reserveMist) + vSui;

  const gross = quoteOut(tokIn, x, y);
  const fee   = (gross * BigInt(TRADE_FEE_BPS)) / 10_000n;
  const fees  = splitFee(fee);
  const suiOut = gross - fee;

  return {
    suiOut,
    fee, fees,
    priceImpact: y > 0n ? Number((gross * 10000n) / y) / 100 : 0,
  };
}

export function priceMistPerToken(realSuiReserve, tokensSold, vSuiOverride, vTokOverride) {
  const vSuiSui = vSuiOverride ?? DEFAULT_VIRTUAL_SUI;
  const vTokTok = vTokOverride ?? DEFAULT_VIRTUAL_TOKENS;
  const vSui    = BigInt(vSuiSui)  * BigInt(MIST_PER_SUI);
  const vTok    = BigInt(vTokTok)  * (10n ** BigInt(TOKEN_DECIMALS));
  const x       = BigInt(realSuiReserve) + vSui;
  const y       = vTok - BigInt(tokensSold);
  if (y <= 0n) return 0n;
  return (x * 1_000_000n) / y;
}

export const mistToSui         = (m) => (m == null ? 0 : Number(BigInt(m)) / 1e9);
export const tokenUnitsToWhole = (u) => (u == null ? 0 : Number(BigInt(u)) / 1e6);

export const quoteBuy  = buyQuote;
export const quoteSell = sellQuote;
