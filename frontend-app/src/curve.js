// curve.js
// Calling convention matches TokenPage.jsx exactly:
//   buyQuote(reserveMist, tokensRemaining, suiInMist)
//   sellQuote(reserveMist, tokensRemaining, tokensInAtomic)
// All BigInt inputs, all BigInt outputs.

const VIRTUAL_SUI_SUI = 30000;
const VIRTUAL_TOKENS_WHOLE = 1073000000;
const TOKEN_DEC = 6;
const MIST = 1000000000n;
const TRADE_FEE = 100n;       // 1% = 100 bps
const CREATOR_BPS = 4000n;    // 40%
const PROTOCOL_BPS = 5000n;   // 50%
const SCALE = 10n ** 6n;      // 1e6 for price scaling

const VIRT_SUI_MIST = BigInt(VIRTUAL_SUI_SUI) * MIST;
const VIRT_TOK_ATOMIC = BigInt(VIRTUAL_TOKENS_WHOLE) * SCALE;

function splitFee(fee) {
  const creator = (fee * CREATOR_BPS) / 10000n;
  const protocol = (fee * PROTOCOL_BPS) / 10000n;
  const lp = fee - creator - protocol;
  return { creator, protocol, lp };
}

// dy = y * dx / (x + dx) — constant product
function cpOut(dx, x, y) {
  if (x + dx === 0n) return 0n;
  return (y * dx) / (x + dx);
}

export function buyQuote(reserveMist, tokensRemaining, suiInMist) {
  const suiIn = BigInt(suiInMist);
  const reserve = BigInt(reserveMist);
  const tokensLeft = BigInt(tokensRemaining);

  const fee = (suiIn * TRADE_FEE) / 10000n;
  const fees = splitFee(fee);
  const swap = suiIn - fee;

  const x = reserve + VIRT_SUI_MIST;
  const y = tokensLeft;

  const out = cpOut(swap, x, y);
  const clipped = out >= tokensLeft;

  return {
    tokensOut: clipped ? tokensLeft : out,
    fee,
    fees,
    actualSwap: swap,
    refund: 0n,
    clipped,
  };
}

export function sellQuote(reserveMist, tokensRemaining, tokensInAtomic) {
  const tokIn = BigInt(tokensInAtomic);
  const reserve = BigInt(reserveMist);
  const tokensLeft = BigInt(tokensRemaining);

  // x = token side, y = SUI side
  const x = tokensLeft;
  const y = reserve + VIRT_SUI_MIST;

  const gross = cpOut(tokIn, x, y);
  const fee = (gross * TRADE_FEE) / 10000n;
  const fees = splitFee(fee);
  return { suiOut: gross - fee, fee, fees };
}

export function priceMistPerToken(reserveMist, tokensSold) {
  const x = BigInt(reserveMist) + VIRT_SUI_MIST;
  const y = VIRT_TOK_ATOMIC - BigInt(tokensSold);
  if (y <= 0n) return 0n;
  return (x * SCALE) / y;
}

export function mistToSui(m) {
  if (m == null) return 0;
  return Number(BigInt(m)) / 1e9;
}

export function tokenUnitsToWhole(u) {
  if (u == null) return 0;
  return Number(BigInt(u)) / 1e6;
}

// Both naming conventions
export const quoteBuy = buyQuote;
export const quoteSell = sellQuote;
