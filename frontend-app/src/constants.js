// constants.js
// Dual package ID support: v4 (deployed) + v5 (new deploy).
// After deploying v5, set PACKAGE_ID_V5 to the new package address.
// Before v5 deploy, set PACKAGE_ID_V5 = null — frontend gracefully skips it.

// ── V4 (live testnet) ────────────────────────────────────────────────────────
export const PACKAGE_ID_V4 =
  '0x2154486dcf503bd3e8feae4fb913e862f7e2bbf4489769aff63978f55d55b4a8';

// ── V5 (set after deploy) ────────────────────────────────────────────────────
export const PACKAGE_ID_V5 = null; // TODO: set after `sui client publish contracts-v5`

// ── Active package (used for new launches + write txs) ──────────────────────
export const PACKAGE_ID = PACKAGE_ID_V5 ?? PACKAGE_ID_V4;

// ── All package IDs — used for querying events across both versions ──────────
export const ALL_PACKAGE_IDS = [
  PACKAGE_ID_V4,
  ...(PACKAGE_ID_V5 ? [PACKAGE_ID_V5] : []),
];

// ── Example curve (v4) ───────────────────────────────────────────────────────
export const CURVE_ID =
  '0xf7c137e90c5a5c9e716c91fdd3561d55e6ba3c11c37a9741b0bfde03dc9d812f';

export const TOKEN_TYPE = `${PACKAGE_ID}::token_template::TOKEN_TEMPLATE`;

// ── Fee constants — must match bonding_curve.move exactly ───────────────────
export const TRADE_FEE_BPS       = 100;
export const CREATOR_SHARE_BPS   = 4_000;
export const PROTOCOL_SHARE_BPS  = 5_000;  // 4_000 when referral active
export const LP_SHARE_BPS        = 1_000;
export const REFERRAL_SHARE_BPS  = 1_000;  // v5 only

// ── Curve supply constants ────────────────────────────────────────────────────
export const CURVE_SUPPLY   = 800_000_000;
export const TOKEN_DECIMALS = 6;
export const MIST_PER_SUI   = 1_000_000_000;

// ── V4 curve shape ────────────────────────────────────────────────────────────
export const VIRTUAL_SUI_V4    = 30_000;
export const VIRTUAL_TOKENS_V4 = 1_073_000_000;
export const DRAIN_SUI_V4      = 35_000; // graduation threshold SUI

// ── V5 curve shape ────────────────────────────────────────────────────────────
export const VIRTUAL_SUI_V5    = 9_000;
export const VIRTUAL_TOKENS_V5 = 1_073_000_000; // unchanged
export const DRAIN_SUI_V5      = 17_000; // graduation threshold SUI (~$20k USD)

// ── Active virtual reserves (used by price calculations in frontend) ──────────
export const VIRTUAL_SUI    = PACKAGE_ID_V5 ? VIRTUAL_SUI_V5    : VIRTUAL_SUI_V4;
export const VIRTUAL_TOKENS = PACKAGE_ID_V5 ? VIRTUAL_TOKENS_V5 : VIRTUAL_TOKENS_V4;
export const DRAIN_SUI_APPROX = PACKAGE_ID_V5 ? DRAIN_SUI_V5    : DRAIN_SUI_V4;

// ── Graduation targets (v5) ───────────────────────────────────────────────────
export const GRAD_TARGET_CETUS    = 0;
export const GRAD_TARGET_DEEPBOOK = 1;

// ── Anti-bot delay options (v5) ───────────────────────────────────────────────
export const ANTI_BOT_NONE = 0;
export const ANTI_BOT_15S  = 15;
export const ANTI_BOT_30S  = 30;
