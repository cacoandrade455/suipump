// Pure math helpers. Mirror the Move contract exactly so previews match
// what the chain will actually execute.

import {
  TRADE_FEE_BPS, CREATOR_SHARE_BPS, PROTOCOL_SHARE_BPS, LP_SHARE_BPS,
  CURVE_SUPPLY, VIRTUAL_SUI, VIRTUAL_TOKENS, MIST_PER_SUI, TOKEN_DECIMALS,
} from './constants.js';

// Constant-product quote: dy = y*dx / (x + dx).
function quoteOut(dx, x, y) {
  return (BigInt(y) * BigInt(dx)) / (BigInt(x) + BigInt(dx));
}

export function splitFee(fee) {
  const creator = (fee * BigInt(CREATOR_SHARE_BPS)) / 10_000n;
  const protocol = (fee * BigInt(PROTOCOL_SHARE_BPS)) / 10_000n;
  const lp = fee - creator - protocol;
  return { creator, protocol, lp };
}

// All inputs/outputs in smallest units (MIST for SUI, 10^-6 for tokens).
// Returns BigInt to match Move's u64 semantics.
export function quoteBuy(suiInMist, realSuiReserve, tokensSold) {
  const suiIn = BigInt(suiInMist);
  const fee = (suiIn * BigInt(TRADE_FEE_BPS)) / 10_000n;
  const fees = splitFee(fee);
  const swap = suiIn - fee;

  const virtSui = BigInt(VIRTUAL_SUI) * BigInt(MIST_PER_SUI);
  const virtTok = BigInt(VIRTUAL_TOKENS) * 10n ** BigInt(TOKEN_DECIMALS);
  const curveCap = BigInt(CURVE_SUPPLY) * 10n ** BigInt(TOKEN_DECIMALS);

  const x = BigInt(realSuiReserve) + virtSui;
  const y = virtTok - (curveCap - BigInt(CURVE_SUPPLY) * 10n ** BigInt(TOKEN_DECIMALS) + BigInt(tokensSold));
  const naive = quoteOut(swap, x, y);

  const remaining = curveCap - BigInt(tokensSold);
  if (naive > remaining) {
    // Tail clip: buy exactly `remaining`, compute exact swap needed, refund the rest.
    const actualSwap = (x * remaining) / (y - remaining);
    return {
      tokensOut: remaining,
      fee, fees,
      actualSwap,
      refund: suiIn - fee - actualSwap,
      clipped: true,
    };
  }
  return {
    tokensOut: naive,
    fee, fees,
    actualSwap: swap,
    refund: 0n,
    clipped: false,
  };
}

export function quoteSell(tokensInSmallestUnit, realSuiReserve, tokensSold) {
  const tokensIn = BigInt(tokensInSmallestUnit);

  const virtSui = BigInt(VIRTUAL_SUI) * BigInt(MIST_PER_SUI);
  const virtTok = BigInt(VIRTUAL_TOKENS) * 10n ** BigInt(TOKEN_DECIMALS);

  const sold = BigInt(tokensSold);
  const x = virtTok - sold;
  const y = BigInt(realSuiReserve) + virtSui;
  const grossOut = quoteOut(tokensIn, x, y);

  const fee = (grossOut * BigInt(TRADE_FEE_BPS)) / 10_000n;
  const fees = splitFee(fee);
  const netOut = grossOut - fee;
  return { suiOut: netOut, fee, fees };
}

export function priceMistPerToken(realSuiReserve, tokensSold) {
  const virtSui = BigInt(VIRTUAL_SUI) * BigInt(MIST_PER_SUI);
  const virtTok = BigInt(VIRTUAL_TOKENS) * 10n ** BigInt(TOKEN_DECIMALS);
  const x = BigInt(realSuiReserve) + virtSui;
  const y = virtTok - BigInt(tokensSold);
  if (y === 0n) return 0n;
  return (x * 1_000_000n) / y;
}

// Convenience formatters for display.
export const mistToSui = (m) => m == null ? 0 : Number(BigInt(m)) / 1e9;
export const tokenUnitsToWhole = (u) => u == null ? 0 : Number(BigInt(u)) / 10 ** TOKEN_DECIMALS;
