// constants.js
// Multi-package support: v4 (live), v5 (deprecated), v6 (legacy), v7 (active)

// ── V4 (live testnet — keep forever for existing tokens) ─────────────────────
export const PACKAGE_ID_V4 =
  '0x2154486dcf503bd3e8feae4fb913e862f7e2bbf4489769aff63978f55d55b4a8';

// ── V5 (deprecated — tokens still tradeable, no new launches) ────────────────
export const PACKAGE_ID_V5 =
  '0x785c0604cb6c60a8547501e307d2b0ca7a586ff912c8abff4edfb88db65b7236';

// ── V6 (legacy — tokens still tradeable, no new launches) ────────────────────
export const PACKAGE_ID_V6 =
  '0x21d5b1284d5f1d4d14214654f414ffca20c757ee9f9db7701d3ffaaac62cd768';

// ── V7 (active — set after `sui client publish contracts-v7`) ────────────────
export const PACKAGE_ID_V7 =
  '0xfb8f3f3e4e8d53130ac140906eebea6b6740bfaf0c971aec607fbc723be951f0';

// ── V7 capabilities ──────────────────────────────────────────────────────────
export const ADMIN_CAP_V7 =
  '0x1dc44030adaa6e366666a8e095fc29a5a55c8ae614f04c5e93c062a85b475527';
export const UPGRADE_CAP_V7 =
  '0xfc3cbce835fa8a6990105e87c3cd6ea18482b1eadc435c8bf049a8d3fdbd20a4';

// ── Active package (used for new launches + write txs) ───────────────────────
export const PACKAGE_ID =
  PACKAGE_ID_V7 ?? PACKAGE_ID_V6 ?? PACKAGE_ID_V5 ?? PACKAGE_ID_V4;

// ── All package IDs — queried for events ─────────────────────────────────────
export const ALL_PACKAGE_IDS = [
  PACKAGE_ID_V4,
  PACKAGE_ID_V5,
  PACKAGE_ID_V6,
  ...(PACKAGE_ID_V7 ? [PACKAGE_ID_V7] : []),
];

// ── Example curve (v4) ───────────────────────────────────────────────────────
export const CURVE_ID =
  '0xf7c137e90c5a5c9e716c91fdd3561d55e6ba3c11c37a9741b0bfde03dc9d812f';

export const TOKEN_TYPE = `${PACKAGE_ID}::token_template::TOKEN_TEMPLATE`;

// ── Fee constants ─────────────────────────────────────────────────────────────
export const TRADE_FEE_BPS      = 100;
export const CREATOR_SHARE_BPS  = 4_000;
export const PROTOCOL_SHARE_BPS = 5_000;
export const LP_SHARE_BPS       = 1_000;
export const REFERRAL_SHARE_BPS = 1_000;

// V7 comment fee — 0.001 SUI in MIST
export const COMMENT_FEE_MIST   = 1_000_000;

// ── Curve supply ──────────────────────────────────────────────────────────────
export const CURVE_SUPPLY   = 800_000_000;
export const TOKEN_DECIMALS = 6;
export const MIST_PER_SUI   = 1_000_000_000;

// ── V4 curve shape ────────────────────────────────────────────────────────────
export const VIRTUAL_SUI_V4    = 30_000;
export const VIRTUAL_TOKENS_V4 = 1_073_000_000;
export const DRAIN_SUI_V4      = 35_000;

// ── V5 curve shape ────────────────────────────────────────────────────────────
export const VIRTUAL_SUI_V5    = 9_000;
export const VIRTUAL_TOKENS_V5 = 1_073_000_000;
export const DRAIN_SUI_V5      = 17_000;

// ── V6 curve shape (same economics as v5) ────────────────────────────────────
export const VIRTUAL_SUI_V6    = 9_000;
export const VIRTUAL_TOKENS_V6 = 1_073_000_000;
export const DRAIN_SUI_V6      = 17_000;

// ── V7 curve shape (recalibrated — ~$4k start mcap) ──────────────────────────
export const VIRTUAL_SUI_V7    = 3_500;
export const VIRTUAL_TOKENS_V7 = 1_073_000_000;
export const DRAIN_SUI_V7      = 9_000;

// ── Active virtual reserves (track the active package) ───────────────────────
export const VIRTUAL_SUI =
  PACKAGE_ID_V7 ? VIRTUAL_SUI_V7
  : PACKAGE_ID_V6 ? VIRTUAL_SUI_V6
  : VIRTUAL_SUI_V5;
export const VIRTUAL_TOKENS =
  PACKAGE_ID_V7 ? VIRTUAL_TOKENS_V7
  : PACKAGE_ID_V6 ? VIRTUAL_TOKENS_V6
  : VIRTUAL_TOKENS_V5;
export const DRAIN_SUI_APPROX =
  PACKAGE_ID_V7 ? DRAIN_SUI_V7
  : PACKAGE_ID_V6 ? DRAIN_SUI_V6
  : DRAIN_SUI_V5;

// ── Per-package curve shape lookup ───────────────────────────────────────────
// Returns { virtualSui, virtualTokens, drainSui } for a given package id.
export function curveShapeFor(pkgId) {
  if (pkgId === PACKAGE_ID_V7) {
    return { virtualSui: VIRTUAL_SUI_V7, virtualTokens: VIRTUAL_TOKENS_V7, drainSui: DRAIN_SUI_V7 };
  }
  if (pkgId === PACKAGE_ID_V6) {
    return { virtualSui: VIRTUAL_SUI_V6, virtualTokens: VIRTUAL_TOKENS_V6, drainSui: DRAIN_SUI_V6 };
  }
  if (pkgId === PACKAGE_ID_V5) {
    return { virtualSui: VIRTUAL_SUI_V5, virtualTokens: VIRTUAL_TOKENS_V5, drainSui: DRAIN_SUI_V5 };
  }
  return { virtualSui: VIRTUAL_SUI_V4, virtualTokens: VIRTUAL_TOKENS_V4, drainSui: DRAIN_SUI_V4 };
}

// ── Package feature helpers ───────────────────────────────────────────────────
// New curve economics (v5+): lower virtual reserves
export function isNewCurve(pkgId) {
  return pkgId === PACKAGE_ID_V5 || pkgId === PACKAGE_ID_V6 || pkgId === PACKAGE_ID_V7;
}
// V5+ features: referral, anti-bot, graduation target
export function isV5OrLater(pkgId) {
  return pkgId === PACKAGE_ID_V5 || pkgId === PACKAGE_ID_V6 || pkgId === PACKAGE_ID_V7;
}
// V6+ : instant one-time metadata update within 24h
export function supportsMetadataUpdate(pkgId) {
  return pkgId === PACKAGE_ID_V6 || pkgId === PACKAGE_ID_V7;
}
// V7+ : Turbos graduation, comment fee, sell-side referral, pause, airdrop bucket
export function isV7OrLater(pkgId) {
  return pkgId === PACKAGE_ID_V7;
}

// ── Graduation targets ───────────────────────────────────────────────────────
export const GRAD_TARGET_CETUS    = 0;
export const GRAD_TARGET_DEEPBOOK = 1;
export const GRAD_TARGET_TURBOS   = 2; // v7

// ── Anti-bot delay options (v5+) ─────────────────────────────────────────────
export const ANTI_BOT_NONE = 0;
export const ANTI_BOT_15S  = 15;
export const ANTI_BOT_30S  = 30;
