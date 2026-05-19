// constants.js
// Multi-package support: v4 (legacy), v5 (legacy), v6 (legacy), v7 (legacy), v8 (active)

// ── V4 (legacy — tokens still tradeable forever) ─────────────────────────────
export const PACKAGE_ID_V4 =
  '0x2154486dcf503bd3e8feae4fb913e862f7e2bbf4489769aff63978f55d55b4a8';

// ── V5 (legacy — tokens still tradeable forever) ─────────────────────────────
export const PACKAGE_ID_V5 =
  '0x785c0604cb6c60a8547501e307d2b0ca7a586ff912c8abff4edfb88db65b7236';

// ── V6 (legacy — tokens still tradeable forever) ─────────────────────────────
export const PACKAGE_ID_V6 =
  '0x21d5b1284d5f1d4d14214654f414ffca20c757ee9f9db7701d3ffaaac62cd768';

// ── V7 (legacy — tokens still tradeable, metadata permanently frozen) ────────
export const PACKAGE_ID_V7 =
  '0xfb8f3f3e4e8d53130ac140906eebea6b6740bfaf0c971aec607fbc723be951f0';

// ── V8 (active — shared metadata, update_metadata works) ─────────────────────
export const PACKAGE_ID_V8 =
  '0x145a1e79b83cc17680dbfe4f96839cd359c7db380ac15463ecb6dc30f9849b69';

// ── Capabilities ─────────────────────────────────────────────────────────────
export const ADMIN_CAP_V7 =
  '0x1dc44030adaa6e366666a8e095fc29a5a55c8ae614f04c5e93c062a85b475527';
export const UPGRADE_CAP_V7 =
  '0xfc3cbce835fa8a6990105e87c3cd6ea18482b1eadc435c8bf049a8d3fdbd20a4';
export const ADMIN_CAP_V8 =
  '0xdb22e067d9cf53cfab37bc6d4b626ff98c770bc59b8a192d007aca449e8f7103';
export const UPGRADE_CAP_V8 =
  '0xcc0c127866fbef958194d16d88ff35e626a13631938f398614914eba3b54547b';

// ── Active package (used for new launches + write txs) ───────────────────────
export const PACKAGE_ID = PACKAGE_ID_V8;

// ── Active admin cap ─────────────────────────────────────────────────────────
export const ADMIN_CAP = ADMIN_CAP_V8;

// ── All package IDs — queried for events (READ paths) ────────────────────────
export const ALL_PACKAGE_IDS = [
  PACKAGE_ID_V4,
  PACKAGE_ID_V5,
  PACKAGE_ID_V6,
  PACKAGE_ID_V7,
  PACKAGE_ID_V8,
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

// V7+ comment fee — 0.001 SUI in MIST
export const COMMENT_FEE_MIST = 1_000_000;

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

// ── V6 curve shape ────────────────────────────────────────────────────────────
export const VIRTUAL_SUI_V6    = 9_000;
export const VIRTUAL_TOKENS_V6 = 1_073_000_000;
export const DRAIN_SUI_V6      = 17_000;

// ── V7 curve shape ────────────────────────────────────────────────────────────
export const VIRTUAL_SUI_V7    = 3_500;
export const VIRTUAL_TOKENS_V7 = 1_073_000_000;
export const DRAIN_SUI_V7      = 9_000;

// ── V8 curve shape (identical economics to V7) ───────────────────────────────
export const VIRTUAL_SUI_V8    = 3_500;
export const VIRTUAL_TOKENS_V8 = 1_073_000_000;
export const DRAIN_SUI_V8      = 9_000;

// ── Active virtual reserves ───────────────────────────────────────────────────
export const VIRTUAL_SUI      = VIRTUAL_SUI_V8;
export const VIRTUAL_TOKENS   = VIRTUAL_TOKENS_V8;
export const DRAIN_SUI_APPROX = DRAIN_SUI_V8;

// ── Per-package curve shape lookup ───────────────────────────────────────────
export function curveShapeFor(pkgId) {
  if (pkgId === PACKAGE_ID_V8) {
    return { virtualSui: VIRTUAL_SUI_V8, virtualTokens: VIRTUAL_TOKENS_V8, drainSui: DRAIN_SUI_V8 };
  }
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
export function isNewCurve(pkgId) {
  return pkgId === PACKAGE_ID_V5 || pkgId === PACKAGE_ID_V6
      || pkgId === PACKAGE_ID_V7 || pkgId === PACKAGE_ID_V8;
}
export function isV5OrLater(pkgId) {
  return pkgId === PACKAGE_ID_V5 || pkgId === PACKAGE_ID_V6
      || pkgId === PACKAGE_ID_V7 || pkgId === PACKAGE_ID_V8;
}
export function supportsMetadataUpdate(pkgId) {
  return pkgId === PACKAGE_ID_V6 || pkgId === PACKAGE_ID_V7 || pkgId === PACKAGE_ID_V8;
}
export function isV7OrLater(pkgId) {
  return pkgId === PACKAGE_ID_V7 || pkgId === PACKAGE_ID_V8;
}
export function isV8OrLater(pkgId) {
  return pkgId === PACKAGE_ID_V8;
}

// ── Graduation targets ───────────────────────────────────────────────────────
export const GRAD_TARGET_CETUS    = 0;
export const GRAD_TARGET_DEEPBOOK = 1;
export const GRAD_TARGET_TURBOS   = 2;

// ── Anti-bot delay options (v5+) ─────────────────────────────────────────────
export const ANTI_BOT_NONE = 0;
export const ANTI_BOT_15S  = 15;
export const ANTI_BOT_30S  = 30;

// ── Clock ─────────────────────────────────────────────────────────────────────
export const SUI_CLOCK_ID =
  '0x0000000000000000000000000000000000000000000000000000000000000006';
