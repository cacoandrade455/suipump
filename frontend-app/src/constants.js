// constants.js
// Multi-package support: v4-v8_1 (legacy), v8 (active)
// CRITICAL: ALL package IDs must stay in ALL_PACKAGE_IDS forever - old tokens
// must remain visible, tradeable, and counted in stats.

export const PACKAGE_ID_V4 =
  '0x2154486dcf503bd3e8feae4fb913e862f7e2bbf4489769aff63978f55d55b4a8';
export const PACKAGE_ID_V5 =
  '0x785c0604cb6c60a8547501e307d2b0ca7a586ff912c8abff4edfb88db65b7236';
export const PACKAGE_ID_V6 =
  '0x21d5b1284d5f1d4d14214654f414ffca20c757ee9f9db7701d3ffaaac62cd768';
export const PACKAGE_ID_V7 =
  '0xfb8f3f3e4e8d53130ac140906eebea6b6740bfaf0c971aec607fbc723be951f0';
// V8_1: first V8 publish - tokens still tradeable forever
export const PACKAGE_ID_V8_1 =
  '0x145a1e79b83cc17680dbfe4f96839cd359c7db380ac15463ecb6dc30f9849b69';
// V8: active - duplicate payout check, correct comment error codes, init_for_testing
export const PACKAGE_ID_V8 =
  '0xbb4ee050239f59dfd983501ce101698ba27857f77aff2d437cec568fe0062546';
// V9: sqrt-dampened oracle graduation threshold, buy() takes sui_price_scaled
export const PACKAGE_ID_V9 =
  '0x719698e5138582d78ee95317271e8bce05769569a4f58c940a7f1b424d90ffe2';
// V10: creator buyback+burn, CTO vote, holder-gated chat, recursive replies,
// protocol surcharge, AgentSession. buy()/sell() signatures identical to V9;
// claim_creator_fees()/update_payouts() gain clock; post_comment() gains
// holder_coin + parent_id.
export const PACKAGE_ID_V10 =
  '0x2deda2cade65cd5afd5ffbe799d48f2491debf08d3aef6fa11aa6e1c8afe1598';
// V11: UPGRADE of the V10 package (not a separate publish, unlike V4..V10).
// agent_session gains: net-exposure spend cap, TradeTicket universal trading
// (owner opt-in), expiry_ms==0 closed sentinel, SessionBuyV2/SessionSellV2
// events. bonding_curve republished byte-identical.
// UPGRADE SEMANTICS -- READ BEFORE DISPATCHING:
//   - Curve<T> and AgentSession TYPES keep their V10 defining ids forever, so
//     V11 NEVER appears as a curve-type package: version helpers below stay
//     keyed on V10 for the whole lineage, and V10-typed objects work with V11
//     code directly.
//   - Calls to the V10 address run OLD bytecode. All WRITE targets must use
//     PACKAGE_ID (= V11) to get V11 behavior.
//   - Events defined in V10 (SessionOpened etc.) keep V10-typed names even
//     when emitted by V11 code; only the NEW V2 events type under V11.
// The UpgradeCap (UPGRADE_CAP_V10) governs the whole lineage and is unchanged.
export const PACKAGE_ID_V11 =
  '0xc03817bce45ff492e5d0f40f9e46f5a075a952b50c5c6146b8fb38138bd699eb';
// V12: second upgrade of the V10 lineage. bonding_curve gains the creator
// comments toggle (set_comment_gate); NEW module enclave_registry (Nautilus
// Phase 2: native Nitro attestation -> chain-verified enclave keys);
// agent_session gains open_and_share_attested. Same upgrade semantics as V11:
// types define at V10, write targets move here.
export const PACKAGE_ID_V12 =
  '0xf5a3566ba920a3e3614e8b25da0ca3237879b6e22eb12f21ccf2bceb6520b9cd';
// V13: SEPARATE PUBLISHED LINEAGE (published 2026-07-17 as a FRESH PUBLISH, NOT an
// upgrade of V10). Sui's `compatible` upgrade policy rejected upgrading V10 because
// V13 changes public signatures (buy / buy_with_session: sui_price_scaled u64 ->
// &PriceConfig; post_comment 7 -> 6 params) and the CTO struct family; removing the
// caller-supplied price IS the F-2 fix, so a breaking change was unavoidable and a
// fresh publish was the only path. CONSEQUENCE: V13 has its OWN type identity - V13
// curves are <V13_package>::bonding_curve::Curve<T> and do NOT type as V10. Every
// "V13 is the third upgrade of the V10 lineage" assumption is now false.
// Env-only wiring: set VITE_SUIPUMP_V13_PACKAGE + VITE_SUIPUMP_PRICE_CONFIG on
// Vercel; while unset, PACKAGE_ID_V13 is null and V13 tokens are simply absent from
// read paths. NEVER hardcode these ids here.
export const PACKAGE_ID_V13 = (import.meta.env.VITE_SUIPUMP_V13_PACKAGE ?? '').toLowerCase() || null;
export const PRICE_CONFIG_ID = import.meta.env.VITE_SUIPUMP_PRICE_CONFIG || null;
export const V13_BUY_ENABLED = Boolean(PACKAGE_ID_V13 && PRICE_CONFIG_ID);

// -- Capabilities -------------------------------------------------------------
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
export const ADMIN_CAP_V10 =
  '0x144d426960a9a6b8db63ce3426e06a9c41273a17e72ed0193cd8c8507d4f6ec5';
export const UPGRADE_CAP_V10 =
  '0xb840fc9c54271c73f9c5e8f22f42ffda3c46f93914586bf671958ad9e754a274';

// -- Active package ------------------------------------------------------------
export const PACKAGE_ID = PACKAGE_ID_V12;
export const ADMIN_CAP  = ADMIN_CAP_V10;

// -- All package IDs - READ paths must cover every version --------------------
export const ALL_PACKAGE_IDS = [
  PACKAGE_ID_V4,
  PACKAGE_ID_V5,
  PACKAGE_ID_V6,
  PACKAGE_ID_V7,
  PACKAGE_ID_V8_1,
  PACKAGE_ID_V8,
  PACKAGE_ID_V9,
  PACKAGE_ID_V10,
  PACKAGE_ID_V11,
  PACKAGE_ID_V12,
  // V13 is a SEPARATE published lineage (not a V10 upgrade); READ paths must
  // include it once its env id is set. Conditional spread so a null id (env unset)
  // never enters the array.
  ...(PACKAGE_ID_V13 ? [PACKAGE_ID_V13] : []),
];

export const CURVE_ID    = '0xf7c137e90c5a5c9e716c91fdd3561d55e6ba3c11c37a9741b0bfde03dc9d812f';
export const TOKEN_TYPE  = `${PACKAGE_ID}::token_template::TOKEN_TEMPLATE`;

// -- Fee constants -------------------------------------------------------------
export const TRADE_FEE_BPS      = 100;
export const CREATOR_SHARE_BPS  = 4_000;
export const PROTOCOL_SHARE_BPS = 5_000;
export const LP_SHARE_BPS       = 1_000;
export const REFERRAL_SHARE_BPS = 1_000;
export const COMMENT_FEE_MIST   = 1_000_000;

// -- Curve supply --------------------------------------------------------------
export const CURVE_SUPPLY   = 800_000_000;
export const TOKEN_DECIMALS = 6;
export const MIST_PER_SUI   = 1_000_000_000;

// -- Curve shapes per version --------------------------------------------------
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

// -- Active virtual reserves ---------------------------------------------------
export const VIRTUAL_SUI      = VIRTUAL_SUI_V9;
export const VIRTUAL_TOKENS   = VIRTUAL_TOKENS_V9;
export const DRAIN_SUI_APPROX = DRAIN_SUI_V9;

// -- Per-package curve shape ---------------------------------------------------
// V13 is a SEPARATE published lineage, but its curve shape is UNCHANGED from V9+
// (VIRTUAL_SUI_RESERVE = 4_369, VIRTUAL_TOKEN_RESERVE = 1_073_000_000, confirmed vs
// contracts-v10/sources/bonding_curve.move:177-178). Every known package has an
// explicit branch; a truthy but UNRECOGNIZED id warns loudly and defaults to the
// current-lineage (V9) shape rather than silently rendering at the legacy V4 30k
// shape -- the guard the 2026-07 -20.2% price-badge incident lacked.
export function curveShapeFor(pkgId) {
  if (PACKAGE_ID_V13 && pkgId === PACKAGE_ID_V13) { // V13: separate lineage, V9 shape
    return { virtualSui: VIRTUAL_SUI_V9, virtualTokens: VIRTUAL_TOKENS_V9, drainSui: DRAIN_SUI_V9 };
  }
  if (pkgId === PACKAGE_ID_V12) { // defensive: lineage curves type as V10
    return { virtualSui: VIRTUAL_SUI_V9, virtualTokens: VIRTUAL_TOKENS_V9, drainSui: DRAIN_SUI_V9 };
  }
  if (pkgId === PACKAGE_ID_V11) { // defensive: lineage curves type as V10
    return { virtualSui: VIRTUAL_SUI_V9, virtualTokens: VIRTUAL_TOKENS_V9, drainSui: DRAIN_SUI_V9 };
  }
  if (pkgId === PACKAGE_ID_V10) {
    return { virtualSui: VIRTUAL_SUI_V9, virtualTokens: VIRTUAL_TOKENS_V9, drainSui: DRAIN_SUI_V9 };
  }
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
  if (pkgId === PACKAGE_ID_V4) {
    return { virtualSui: VIRTUAL_SUI_V4, virtualTokens: VIRTUAL_TOKENS_V4, drainSui: DRAIN_SUI_V4 };
  }
  // Genuinely unrecognized id: LOUD, and default to the current-lineage (V9) shape.
  if (pkgId) {
    console.warn(`[curveShapeFor] UNKNOWN package id ${pkgId} - no curve-shape branch matched; defaulting to current-lineage V9 shape (vSui 4369). Add a branch if this is a new lineage.`);
    return { virtualSui: VIRTUAL_SUI_V9, virtualTokens: VIRTUAL_TOKENS_V9, drainSui: DRAIN_SUI_V9 };
  }
  return { virtualSui: VIRTUAL_SUI_V4, virtualTokens: VIRTUAL_TOKENS_V4, drainSui: DRAIN_SUI_V4 };
}

// -- Package feature helpers ---------------------------------------------------
// V13 is a SEPARATE published lineage (fresh publish 2026-07-17), but functionally
// a SUPERSET of V12: it carries every V5..V12 feature plus the F-2 PriceConfig buy
// change and the escrow-CTO redesign. So every feature/version helper below must
// treat a V13 curve as "yes". Guarded (PACKAGE_ID_V13 != null) so that when the env
// var is unset - PACKAGE_ID_V13 is null - a null pkgId can never spuriously match.
// NOTE: the buy SHAPE dispatch is NOT one of these - a V13 curve needs the
// &PriceConfig arg and a V10/V11/V12 curve needs the u64 arg, and the two lineages
// are NOT interchangeable (V13 is not an upgrade of V10). That dispatch keys on
// pkgId === PACKAGE_ID_V13 exactly (see TokenPage useV13Buy), never on isV10OrLater.
const isV13Pkg = (pkgId) => PACKAGE_ID_V13 != null && pkgId === PACKAGE_ID_V13;

export function isNewCurve(pkgId) {
  return pkgId === PACKAGE_ID_V5 || pkgId === PACKAGE_ID_V6
      || pkgId === PACKAGE_ID_V7 || pkgId === PACKAGE_ID_V8_1
      || pkgId === PACKAGE_ID_V8
      || pkgId === PACKAGE_ID_V9 || pkgId === PACKAGE_ID_V10
      || pkgId === PACKAGE_ID_V11
      || pkgId === PACKAGE_ID_V12
      || isV13Pkg(pkgId);
}
export function isV5OrLater(pkgId) {
  return pkgId === PACKAGE_ID_V5 || pkgId === PACKAGE_ID_V6
      || pkgId === PACKAGE_ID_V7 || pkgId === PACKAGE_ID_V8_1
      || pkgId === PACKAGE_ID_V8 || pkgId === PACKAGE_ID_V9
      || pkgId === PACKAGE_ID_V10 || pkgId === PACKAGE_ID_V11
      || pkgId === PACKAGE_ID_V12
      || isV13Pkg(pkgId);
}
export function supportsMetadataUpdate(pkgId) {
  return pkgId === PACKAGE_ID_V6 || pkgId === PACKAGE_ID_V7
      || pkgId === PACKAGE_ID_V8_1 || pkgId === PACKAGE_ID_V8
      || pkgId === PACKAGE_ID_V9 || pkgId === PACKAGE_ID_V10
      || pkgId === PACKAGE_ID_V11
      || pkgId === PACKAGE_ID_V12
      || isV13Pkg(pkgId);
}
export function isV7OrLater(pkgId) {
  return pkgId === PACKAGE_ID_V7 || pkgId === PACKAGE_ID_V8_1
      || pkgId === PACKAGE_ID_V8 || pkgId === PACKAGE_ID_V9
      || pkgId === PACKAGE_ID_V10 || pkgId === PACKAGE_ID_V11
      || pkgId === PACKAGE_ID_V12
      || isV13Pkg(pkgId);
}
export function isV8OrLater(pkgId) {
  return pkgId === PACKAGE_ID_V8_1 || pkgId === PACKAGE_ID_V8
      || pkgId === PACKAGE_ID_V9 || pkgId === PACKAGE_ID_V10
      || pkgId === PACKAGE_ID_V11
      || pkgId === PACKAGE_ID_V12
      || isV13Pkg(pkgId);
}
export function isV9OrLater(pkgId) {
  return pkgId === PACKAGE_ID_V9 || pkgId === PACKAGE_ID_V10
      || pkgId === PACKAGE_ID_V11
      || pkgId === PACKAGE_ID_V12
      || isV13Pkg(pkgId);
}
export function isV10OrLater(pkgId) {
  return pkgId === PACKAGE_ID_V10 || pkgId === PACKAGE_ID_V11
      || pkgId === PACKAGE_ID_V12
      || isV13Pkg(pkgId);
}
export function isV11OrLater(pkgId) {
  return pkgId === PACKAGE_ID_V11 || pkgId === PACKAGE_ID_V12
      || isV13Pkg(pkgId);
}
export function isV12OrLater(pkgId) {
  return pkgId === PACKAGE_ID_V12
      || isV13Pkg(pkgId);
}

// -- Graduation targets --------------------------------------------------------
export const GRAD_TARGET_CETUS    = 0;
export const GRAD_TARGET_DEEPBOOK = 1;
export const GRAD_TARGET_TURBOS   = 2;

// -- Anti-bot ------------------------------------------------------------------
export const ANTI_BOT_NONE = 0;
export const ANTI_BOT_15S  = 15;
export const ANTI_BOT_30S  = 30;

// -- Clock ---------------------------------------------------------------------
export const SUI_CLOCK_ID =
  '0x0000000000000000000000000000000000000000000000000000000000000006';

// -- Epoch launch-with-site (testnet) ------------------------------------------
// PTB-level integration (no SuiPump contract change). A creator can attach an
// Epoch .epoch site to their launch; record_partner_launch routes the cut into
// Epoch's shared Treasury and emits a PartnerLaunch event we index.
// Swap EPOCH_PKG + EPOCH_TREASURY for mainnet when Steve sends them - call shape
// is identical.
export const EPOCH_PKG =
  '0xdf5905144e2895c5ac08a673234d9688e4cae97e9d2750aa864e75a5dc53a282';
export const EPOCH_TREASURY =
  '0x3dd2336c4a789aa2e10125e916ac56447055223fd9384cb16feb8097a89959b3';

// Epoch API base (Cloudflare worker, testnet) - serves /partner/check (public),
// and behind our server-side proxies /partner/session + /partner/registration.
export const EPOCH_API_BASE  = 'https://epoch-indexer.pupazzipunkapi.workers.dev';
export const EPOCH_NETWORK   = 'testnet';

// Public name-availability check (no auth - browser calls direct).
export const EPOCH_CHECK_URL = `${EPOCH_API_BASE}/partner/check`;

// Handoff / sign page (different host from the API base - Epoch's sign UI).
export const EPOCH_SIGN_URL  = 'https://names.epochsui.com/build';

// Our server-side proxy routes (hold the shared secret; never the browser).
export const EPOCH_SESSION_PROXY  = '/api/epoch-session';
export const EPOCH_RECOVERY_PROXY = '/api/epoch-recovery';

// Surcharge economics (MIST). Base launch fee stays LAUNCH_FEE_MIST = 2 SUI.
// Epoch launch = 2 base + 5 surcharge = 7 total: 3 -> Epoch, 2 -> protocol wallet.
export const EPOCH_CUT_MIST          = 3_000_000_000n; // -> Epoch treasury
export const PROTOCOL_SURCHARGE_MIST = 2_000_000_000n; // -> protocol/main wallet

// Destination for the +2 SUI protocol surcharge (main/control wallet).
export const PROTOCOL_WALLET =
  '0x0be9a8f56ba3b07f295e0c7526e7f47ca3a146649b9d864d2eb47bf3acd90c55';
