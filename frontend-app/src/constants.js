// Deployed contract addresses on Sui testnet.
// Update these after each redeploy.

export const PACKAGE_ID =
  '0x22839b3e46129a42ebc2518013105bbf91f435e6664640cb922815659985d349';
export const CURVE_ID =
  '0xe69a7df93bc69c0273f33de152fe6c517ad6ed5ebef8199898d20037a9d258f9';
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
