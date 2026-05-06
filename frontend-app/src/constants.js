// Deployed contract addresses on Sui testnet.
// Update these after each redeploy.

export const PACKAGE_ID =
  '0x2154486dcf503bd3e8feae4fb913e862f7e2bbf4489769aff63978f55d55b4a8';
export const CURVE_ID =
  '0xf7c137e90c5a5c9e716c91fdd3561d55e6ba3c11c37a9741b0bfde03dc9d812f';
export const TOKEN_TYPE = `${PACKAGE_ID}::token_template::TOKEN_TEMPLATE`;

// Curve constants — must match bonding_curve.move exactly.
export const TRADE_FEE_BPS = 100;
export const CREATOR_SHARE_BPS = 4_000;
export const PROTOCOL_SHARE_BPS = 5_000;
export const LP_SHARE_BPS = 1_000;
export const CURVE_SUPPLY = 800_000_000;
export const VIRTUAL_SUI = 30_000;
export const VIRTUAL_TOKENS = 1_073_000_000;
export const DRAIN_SUI_APPROX = 87_912;
export const TOKEN_DECIMALS = 6;
export const MIST_PER_SUI = 1_000_000_000;
