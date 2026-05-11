// curve.js — bonding curve math helpers
// Mirrors the Move contract exactly.
// Calling convention (matches TokenPage.jsx):
//   buyQuote(realSuiReserve, tokensRemaining, suiInMist)
//   sellQuote(realSuiReserve, tokensRemaining, tokensInAtomic)

import {
  TRADE_FEE_BPS, CREATOR_SHARE_BPS, PROTOCOL_SHARE_BPS,
  CURVE_SUPPLY, VIRTUAL_SUI, VIRTUAL_TOKENS, MIST_PER_SUI, TOKEN_DECIMALS,
} from './constants.js';

// Constant-product: dy = y * dx / (x + dx)
function cpOut(dx, x, y) {
  return (BigInt(y) * BigInt(dx)) / (BigInt(x) + BigInt(dx));
}

export function splitFee(fee) {
  const creator  = (fee * BigInt(CREATOR_SHARE_BPS))  / 10_000n;
  const protocol = (fee * BigInt(PROTOCOL_SHARE_BPS)) / 10_000n;
  const lp       = fee - creator - protocol;
  return { creator, protocol, lp };
}

// buyQuote(realSuiReserve, tokensRemaining, suiInMist)
export function buyQuote(realSuiReserve, tokensRemaining, suiInMist) {
  const suiIn = BigInt(suiInMist);
  const fee   = (suiIn * BigInt(TRADE_FEE_BPS)) / 10_000n;
  const fees  = splitFee(fee);
  const swap  = suiIn - fee;

  const virtSuiMist = BigInt(VIRTUAL_SUI) * BigInt(MIST_PER_SUI);
  // x = SUI side (real + virtual), y = token side (remaining)
  const x = BigInt(realSuiReserve) + virtSuiMist;
  const y = BigInt(tokensRemaining);

  const naiveOut = cpOut(swap, x, y);

  if (naiveOut >= y) {
    // Clip to all remaining tokens, refund excess SUI
    const actualSwap = (x * y) / y; // simplified: won't happen cleanly, use full drain
    return {
      tokensOut:  y,
      fee, fees,
      actualSwap: swap,
      refund:     0n,
      clipped:    true,
    };
  }

  return {
    tokensOut:  naiveOut,
    fee, fees,
    actualSwap: swap,
    refund:     0n,
    clipped:    false,
  };
}

// sellQuote(realSuiReserve, tokensRemaining, tokensInAtomic)
export function sellQuote(realSuiReserve, tokensRemaining, tokensInAtomic) {
  const tokIn    = BigInt(tokensInAtomic);
  const virtSuiMist = BigInt(VIRTUAL_SUI) * BigInt(MIST_PER_SUI);

  // x = token side, y = SUI side
  const x = BigInt(tokensRemaining);
  const y = BigInt(realSuiReserve) + virtSuiMist;

  const grossOut = cpOut(tokIn, x, y);
  const fee      = (grossOut * BigInt(TRADE_FEE_BPS)) / 10_000n;
  const fees     = splitFee(fee);
  return { suiOut: grossOut - fee, fee, fees };
}

// priceMistPerToken(realSuiReserve, tokensSold)
export function priceMistPerToken(realSuiReserve, tokensSold) {
  const virtSuiMist = BigInt(VIRTUAL_SUI) * BigInt(MIST_PER_SUI);
  const virtTokAtomic = BigInt(VIRTUAL_TOKENS) * 10n ** BigInt(TOKEN_DECIMALS);
  const x = BigInt(realSuiReserve) + virtSuiMist;
  const y = virtTokAtomic - BigInt(tokensSold);
  if (y === 0n) return 0n;
  return (x * 1_000_000n) / y;
}

export const mistToSui = (m) => (m == null ? 0 : Number(BigInt(m)) / 1e9);
export const tokenUnitsToWhole = (u) => (u == null ? 0 : Number(BigInt(u)) / 10 ** TOKEN_DECIMALS);

// Both naming conventions work
export const quoteBuy  = buyQuote;
export const quoteSell = sellQuote;
