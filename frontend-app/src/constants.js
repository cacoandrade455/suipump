// constants.js
// Multi-package support: v4-v8_1 (legacy), v8 (active)
// CRITICAL: ALL package IDs must stay in ALL_PACKAGE_IDS forever — old tokens
// must remain visible, tradeable, and counted in stats.

export const PACKAGE_ID_V4 =
  '0x2154486dcf503bd3e8feae4fb913e862f7e2bbf4489769aff63978f55d55b4a8';
export const PACKAGE_ID_V5 =
  '0x785c0604cb6c60a8547501e307d2b0ca7a586ff912c8abff4edfb88db65b7236';
export const PACKAGE_ID_V6 =
  '0x21d5b1284d5f1d4d14214654f414ffca20c757ee9f9db7701d3ffaaac62cd768';
export const PACKAGE_ID_V7 =
  '0xfb8f3f3e4e8d53130ac140906eebea6b6740bfaf0c971aec607fbc723be951f0';
// V8_1: first V8 publish — tokens still tradeable forever
export const PACKAGE_ID_V8_1 =
  '0x145a1e79b83cc17680dbfe4f96839cd359c7db380ac15463ecb6dc30f9849b69';
// V8: active — duplicate payout check, correct comment error codes, init_for_testing
export const PACKAGE_ID_V8 =
  '0xbb4ee050239f59dfd983501ce101698ba27857f77aff2d437cec568fe0062546';
// V9: sqrt-dampened oracle graduation threshold, buy() takes sui_price_scaled
export const PACKAGE_ID_V9 =
  '0x719698e5138582d78ee95317271e8bce05769569a4f58c940a7f1b424d90ffe2';

// ── Capabilities ─────────────────────────────────────────────────────────────
export const ADMIN_CAP_V7 =
  '0x1dc44030adaa6e366666a8e095fc29a5a55c8ae614f04c5e93c062a85b475527';
export const UPGRADE_CAP_V7 =
  '0xfc3cbce835fa8a6990105e87c3cd6ea18482b1eadc435c8bf049a8d3fdbd20a4';
export const ADMIN_CAP_V8 =
  '0x9779a2466f2e30ca5e139f636cc9ca1c44e025da29203d781cc2645ebb62bb35';
export const UPGRADE_CAP_V8 =
  '0xb2b30793fbee200c3aa2352d266fcf07499363a15392b84b1ca722891f4a3599';
export const ADMIN_CAP_V9 =
  '0x2e0989604424ffa96f58618795285dac09d8eaf2fd0d35f4a7e9bbc22bea2bf7';
export const UPGRADE_CAP_V9 =
  '0xb3d8067ef98271c7edc58843e46f2e4cf2c12dad6537a3a1f1008f057db41e0e';

// ── Active package ────────────────────────────────────────────────────────────
export const PACKAGE_ID = PACKAGE_ID_V9;
export const ADMIN_CAP  = ADMIN_CAP_V9;

// ── All package IDs — READ paths must cover every version ────────────────────
export const ALL_PACKAGE_IDS = [
  PACKAGE_ID_V4,
  PACKAGE_ID_V5,
  PACKAGE_ID_V6,
  PACKAGE_ID_V7,
  PACKAGE_ID_V8_1,
  PACKAGE_ID_V8,
  PACKAGE_ID_V9,
];

export const CURVE_ID    = '0xf7c137e90c5a5c9e716c91fdd3561d55e6ba3c11c37a9741b0bfde03dc9d812f';
export const TOKEN_TYPE  = `${PACKAGE_ID}::token_template::TOKEN_TEMPLATE`;

// ── Fee constants ─────────────────────────────────────────────────────────────
export const TRADE_FEE_BPS      = 100;
export const CREATOR_SHARE_BPS  = 4_000;
export const PROTOCOL_SHARE_BPS = 5_000;
export const LP_SHARE_BPS       = 1_000;
export const REFERRAL_SHARE_BPS = 1_000;
export const COMMENT_FEE_MIST   = 1_000_000;

// ── Curve supply ──────────────────────────────────────────────────────────────
export const CURVE_SUPPLY   = 800_000_000;
export const TOKEN_DECIMALS = 6;
export const MIST_PER_SUI   = 1_000_000_000;

// ── Curve shapes per version ──────────────────────────────────────────────────
export const VIRTUAL_SUI_V4    = 30_000;
export const VIRTUAL_TOKENS_V4 = 1_073_000_000;
export const DRAIN_SUI_V4      = 35_000;

export const VIRTUAL_SUI_V5    = 9_000;
export const VIRTUAL_TOKENS_V5 = 1_073_000_000;
export const DRAIN_SUI_V5      = 17_000;

export const VIRTUAL_SUI_V6    = 9_000;
export const VIRTUAL_TOKENS_V6 = 1_073_000_000;
export const DRAIN_SUI_V6      = 17_000;

export const VIRTUAL_SUI_V7    = 3_500;
export const VIRTUAL_TOKENS_V7 = 1_073_000_000;
export const DRAIN_SUI_V7      = 9_000;

export const VIRTUAL_SUI_V8    = 3_500;
export const VIRTUAL_TOKENS_V8 = 1_073_000_000;
export const DRAIN_SUI_V8      = 9_000;

export const VIRTUAL_SUI_V9    = 4_369;
export const VIRTUAL_TOKENS_V9 = 1_073_000_000;
export const DRAIN_SUI_V9      = 12_305;

// ── Active virtual reserves ───────────────────────────────────────────────────
export const VIRTUAL_SUI      = VIRTUAL_SUI_V9;
export const VIRTUAL_TOKENS   = VIRTUAL_TOKENS_V9;
export const DRAIN_SUI_APPROX = DRAIN_SUI_V9;

// ── Per-package curve shape ───────────────────────────────────────────────────
export function curveShapeFor(pkgId) {
  if (pkgId === PACKAGE_ID_V9) {
    return { virtualSui: VIRTUAL_SUI_V9, virtualTokens: VIRTUAL_TOKENS_V9, drainSui: DRAIN_SUI_V9 };
  }
  if (pkgId === PACKAGE_ID_V8 || pkgId === PACKAGE_ID_V8_1) {
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
      || pkgId === PACKAGE_ID_V7 || pkgId === PACKAGE_ID_V8_1
      || pkgId === PACKAGE_ID_V8
      || pkgId === PACKAGE_ID_V9;
}
export function isV5OrLater(pkgId) {
  return pkgId === PACKAGE_ID_V5 || pkgId === PACKAGE_ID_V6
      || pkgId === PACKAGE_ID_V7 || pkgId === PACKAGE_ID_V8_1
      || pkgId === PACKAGE_ID_V8 || pkgId === PACKAGE_ID_V9;
}
export function supportsMetadataUpdate(pkgId) {
  return pkgId === PACKAGE_ID_V6 || pkgId === PACKAGE_ID_V7
      || pkgId === PACKAGE_ID_V8_1 || pkgId === PACKAGE_ID_V8
      || pkgId === PACKAGE_ID_V9;
}
export function isV7OrLater(pkgId) {
  return pkgId === PACKAGE_ID_V7 || pkgId === PACKAGE_ID_V8_1
      || pkgId === PACKAGE_ID_V8 || pkgId === PACKAGE_ID_V9;
}
export function isV8OrLater(pkgId) {
  return pkgId === PACKAGE_ID_V8_1 || pkgId === PACKAGE_ID_V8
      || pkgId === PACKAGE_ID_V9;
}
export function isV9OrLater(pkgId) {
  return pkgId === PACKAGE_ID_V9;
}

// ── Graduation targets ────────────────────────────────────────────────────────
export const GRAD_TARGET_CETUS    = 0;
export const GRAD_TARGET_DEEPBOOK = 1;
export const GRAD_TARGET_TURBOS   = 2;

// ── Anti-bot ──────────────────────────────────────────────────────────────────
export const ANTI_BOT_NONE = 0;
export const ANTI_BOT_15S  = 15;
export const ANTI_BOT_30S  = 30;

// ── Clock ─────────────────────────────────────────────────────────────────────
export const SUI_CLOCK_ID =
  '0x0000000000000000000000000000000000000000000000000000000000000006';

// ── Epoch launch-with-site (testnet) ──────────────────────────────────────────
// PTB-level integration (no SuiPump contract change). A creator can attach an
// Epoch .epoch site to their launch; record_partner_launch routes the cut into
// Epoch's shared Treasury and emits a PartnerLaunch event we index.
// Swap EPOCH_PKG + EPOCH_TREASURY for mainnet when Steve sends them — call shape
// is identical.
export const EPOCH_PKG =
  '0xdf5905144e2895c5ac08a673234d9688e4cae97e9d2750aa864e75a5dc53a282';
export const EPOCH_TREASURY =
  '0x3dd2336c4a789aa2e10125e916ac56447055223fd9384cb16feb8097a89959b3';

// Epoch API base (Cloudflare worker, testnet) — serves /partner/check (public),
// and behind our server-side proxies /partner/session + /partner/registration.
export const EPOCH_API_BASE  = 'https://epoch-indexer.pupazzipunkapi.workers.dev';
export const EPOCH_NETWORK   = 'testnet';

// Public name-availability check (no auth — browser calls direct).
export const EPOCH_CHECK_URL = `${EPOCH_API_BASE}/partner/check`;

// Handoff / sign page (different host from the API base — Epoch's sign UI).
export const EPOCH_SIGN_URL  = 'https://names.epochsui.com/sign/register';

// Our server-side proxy routes (hold the shared secret; never the browser).
export const EPOCH_SESSION_PROXY  = '/api/epoch-session';
export const EPOCH_RECOVERY_PROXY = '/api/epoch-recovery';

// Surcharge economics (MIST). Base launch fee stays LAUNCH_FEE_MIST = 2 SUI.
// Epoch launch = 2 base + 5 surcharge = 7 total: 3 → Epoch, 2 → protocol wallet.
export const EPOCH_CUT_MIST          = 3_000_000_000n; // → Epoch treasury
export const PROTOCOL_SURCHARGE_MIST = 2_000_000_000n; // → protocol/main wallet

// Destination for the +2 SUI protocol surcharge (main/control wallet).
export const PROTOCOL_WALLET =
  '0x0be9a8f56ba3b07f295e0c7526e7f47ca3a146649b9d864d2eb47bf3acd90c55';
