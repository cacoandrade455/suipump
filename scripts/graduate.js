// graduate.js
// Executes the post-graduation DEX deposit for a SuiPump bonding curve.
//
// Flow:
//   1. Reads the curve object to confirm it's graduated
//   2. Reads the graduation_target from the encoded description metadata
//   3. Claims the pool SUI + LP tokens via claim_graduation_funds()
//   4. Routes to either graduateToCetus() or graduateToDeepBook()
//
// Usage:
//   node graduate.js <CURVE_ID>
//   node graduate.js <CURVE_ID> --dex cetus      (override stored dex choice)
//   node graduate.js <CURVE_ID> --dex deepbook
//
// Prerequisites:
//   - Your wallet must hold the AdminCap (protocol owner)
//   - The curve must be graduated (token_reserve == 0, graduated == true)
//   - For Cetus: mainnet only (no testnet deployment)
//   - For DeepBook: testnet + mainnet supported via @mysten/deepbook-v3 SDK

import { Transaction } from '@mysten/sui/transactions';
import { client, loadKeypair, PACKAGE_ID, ADMIN_CAP_ID, fmtSui } from './config.js';

// ── Mainnet DEX constants ─────────────────────────────────────────────────────
// These are mainnet addresses. For testnet DeepBook, the SDK resolves them
// automatically via env: 'testnet'. Cetus has no testnet deployment.

const CETUS = {
  // Cetus CLMM package and shared objects (mainnet)
  // Source: https://github.com/CetusProtocol/cetus-clmm-interface
  CLMM_PACKAGE:   '0x1eabed72c53feb3805120a081dc15963c204dc8d091542592abaf7a35689b2fb',
  GLOBAL_CONFIG:  '0xdaa46292632c3c4d8f31f23ea0f9b36a28ff3677e9684980e4438403a67a3d8f',
  POOLS_REGISTRY: '0xf699e7f2276f5c9a75944b37a0c5b5d9ddfd2471bf6242483b03ab2887d198d0',
  CLMMPOOL:       '0x75b2e9ecad34944b8d0c874e568c90db0cf9437f0d7392abfd4cb902972f3e40',
};

// ── Arg parsing ───────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const curveId = args[0];

if (!curveId || !curveId.startsWith('0x')) {
  console.error('Usage: node graduate.js <CURVE_ID> [--dex cetus|deepbook]');
  process.exit(1);
}

const dexOverride = (() => {
  const i = args.indexOf('--dex');
  return i !== -1 ? args[i + 1] : null;
})();

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseDexFromDescription(description) {
  if (!description) return 'cetus';
  const idx = description.indexOf('||');
  if (idx === -1) return 'cetus';
  try {
    const links = JSON.parse(description.slice(idx + 2));
    return links.dex || 'cetus';
  } catch {
    return 'cetus';
  }
}

async function getSharedVersion(objectId) {
  const obj = await client.getObject({ id: objectId, options: { showOwner: true } });
  return obj.data?.owner?.Shared?.initial_shared_version;
}

// ── Main ──────────────────────────────────────────────────────────────────────

const keypair = loadKeypair();
const address = keypair.toSuiAddress();

console.log('━'.repeat(60));
console.log('  SUIPUMP — graduate to DEX');
console.log('━'.repeat(60));
console.log(`  wallet:    ${address}`);
console.log(`  curve:     ${curveId}`);
console.log();

// Step 1: Fetch curve state
const curveRes = await client.getObject({
  id: curveId,
  options: { showContent: true, showType: true },
});

if (curveRes.error || !curveRes.data?.content?.fields) {
  console.error('❌ Could not fetch curve');
  process.exit(1);
}

const fields = curveRes.data.content.fields;
const tokenType = curveRes.data.type?.match(/Curve<(.+)>$/)?.[1];

if (!tokenType) {
  console.error('❌ Could not parse token type from curve');
  process.exit(1);
}

console.log(`  token:     ${fields.name} ($${fields.symbol})`);
console.log(`  type:      ${tokenType}`);
console.log(`  graduated: ${fields.graduated}`);
console.log(`  pool SUI:  ${fmtSui(fields.sui_reserve)}`);
console.log();

if (!fields.graduated) {
  console.error('❌ Curve is not yet graduated. token_reserve must be 0.');
  process.exit(1);
}

const poolSuiAmount = BigInt(fields.sui_reserve ?? 0);
if (poolSuiAmount === 0n) {
  console.error('❌ Pool SUI already claimed or zero. Nothing to deposit.');
  process.exit(1);
}

// Step 2: Read coin metadata to get description → dex choice
let dex = dexOverride;
if (!dex) {
  try {
    const meta = await client.getCoinMetadata({ coinType: tokenType });
    dex = parseDexFromDescription(meta?.description || '');
  } catch {
    dex = 'cetus';
  }
}

console.log(`  dex target: ${dex.toUpperCase()}${dexOverride ? ' (overridden)' : ' (from metadata)'}`);
console.log();

// Step 3: Route to the correct graduation function
if (dex === 'deepbook') {
  await graduateToDeepBook({ curveId, tokenType, fields, poolSuiAmount, address, keypair });
} else {
  await graduateToCetus({ curveId, tokenType, fields, poolSuiAmount, address, keypair });
}

// ── Cetus graduation ──────────────────────────────────────────────────────────
//
// Architecture (50/50 LP split per handoff session 18):
//   - Pool SUI split in half: ~half to creator LP, ~half to protocol LP
//   - 200M LP tokens split in half: 100M to each position
//   - Creator LP NFT transferred to curve.creator
//   - Protocol LP NFT held by admin wallet
//
// PTB outline (mainnet only — Cetus has no testnet):
//   Tx 1: claim_graduation_funds(AdminCap, curve) → poolSuiCoin
//         Claim LP tokens from creator wallet (they were transferred in graduate())
//   Tx 2: open_position(clmm_pool, price_lower, price_upper) → position_nft_creator
//         add_liquidity(position_nft_creator, sui_half, token_half_creator)
//         open_position(clmm_pool, ...) → position_nft_protocol
//         add_liquidity(position_nft_protocol, sui_half, token_half_protocol)
//         transfer position_nft_creator → curve.creator
//         keep position_nft_protocol in admin wallet

async function graduateToCetus({ curveId, tokenType, fields, poolSuiAmount, address, keypair }) {
  console.log('  🌊 Graduating to Cetus CLMM…');
  console.log();

  // TODO: Uncomment and fill in when building for mainnet
  // Requires:
  //   npm install @cetusprotocol/cetus-sui-clmm-sdk
  //   Cetus CLMM interface: { git = "https://github.com/CetusProtocol/cetus-clmm-interface", subdir = "sui/clmm", rev = "mainnet-v1.49.0" }

  console.log('  ⚠ STUB — Cetus graduation not yet implemented');
  console.log('  This function will:');
  console.log('    1. Call claim_graduation_funds() to pull pool SUI from curve');
  console.log('    2. Collect 200M LP tokens from creator wallet');
  console.log('    3. Split SUI 50/50 and tokens 50/50');
  console.log('    4. Open two Cetus CLMM positions (full range)');
  console.log('    5. Add liquidity to both positions');
  console.log('    6. Transfer creator LP NFT → curve.creator');
  console.log('    7. Keep protocol LP NFT in admin wallet');
  console.log();
  console.log('  Cetus constants needed:');
  console.log(`    CLMM_PACKAGE:   ${CETUS.CLMM_PACKAGE}`);
  console.log(`    GLOBAL_CONFIG:  ${CETUS.GLOBAL_CONFIG}`);
  console.log(`    POOLS_REGISTRY: ${CETUS.POOLS_REGISTRY}`);
  console.log();
  console.log('  ❌ Skipping — implement before mainnet launch');

  // ── When ready, implementation goes here ──────────────────────────────────
  //
  // const tx = new Transaction();
  //
  // // Claim pool SUI from curve
  // const curveSharedVersion = await getSharedVersion(curveId);
  // const curveRef = tx.sharedObjectRef({ objectId: curveId, initialSharedVersion: curveSharedVersion, mutable: true });
  // const poolSuiCoin = tx.moveCall({
  //   target: `${PACKAGE_ID}::bonding_curve::claim_graduation_funds`,
  //   typeArguments: [tokenType],
  //   arguments: [tx.object(ADMIN_CAP_ID), curveRef],
  // });
  //
  // // Split SUI and tokens 50/50
  // const halfSui = poolSuiAmount / 2n;
  // const [suiForCreator] = tx.splitCoins(poolSuiCoin, [tx.pure.u64(halfSui)]);
  // // suiForProtocol = remainder of poolSuiCoin
  //
  // // Collect LP tokens from creator wallet
  // // ... (query owned Coin<T> objects for curve.creator address)
  //
  // // Open Cetus positions and add liquidity
  // // ... (Cetus CLMM PTB calls)
  //
  // const result = await client.signAndExecuteTransaction({ signer: keypair, transaction: tx, options: { showEffects: true } });
  // console.log(`  ✓ Graduated to Cetus! digest: ${result.digest}`);
}

// ── DeepBook graduation ───────────────────────────────────────────────────────
//
// Architecture:
//   - Create a BalanceManager (owned by admin, transferable to protocol multisig)
//   - Deposit token + SUI into BalanceManager
//   - Create a new DeepBook pool for TOKEN/SUI pair
//   - Place limit orders spanning a wide price range (market making)
//   - Transfer BalanceManager ownership to curve.creator (or split per 50/50 design)
//
// Key difference from Cetus: no LP NFT, no passive fee accrual.
// Creator gets BalanceManager ownership — they can withdraw/manage orders.
//
// Uses @mysten/deepbook-v3 SDK which handles testnet/mainnet addresses
// automatically via env parameter.

async function graduateToDeepBook({ curveId, tokenType, fields, poolSuiAmount, address, keypair }) {
  console.log('  ⚡ Graduating to DeepBook…');
  console.log();

  // TODO: Uncomment and fill in when building
  // Requires:
  //   npm install @mysten/deepbook-v3
  //
  // The DeepBookClient handles testnet vs mainnet package IDs automatically:
  //   const dbClient = new DeepBookClient({ address, env: 'testnet', client });
  //   const dbClient = new DeepBookClient({ address, env: 'mainnet', client });

  console.log('  ⚠ STUB — DeepBook graduation not yet implemented');
  console.log('  This function will:');
  console.log('    1. Call claim_graduation_funds() to pull pool SUI from curve');
  console.log('    2. Collect 200M LP tokens from creator wallet');
  console.log('    3. Create a BalanceManager for the token pair');
  console.log('    4. Deposit TOKEN + SUI into the BalanceManager');
  console.log('    5. Create a new DeepBook pool for TOKEN/SUI');
  console.log('       (requires DEEP tokens for pool creation fee — see note below)');
  console.log('    6. Place limit orders across a wide price range');
  console.log('    7. Transfer BalanceManager ownership to curve.creator');
  console.log();
  console.log('  ⚠ DEEP token requirement:');
  console.log('    Pool creation on DeepBook requires DEEP tokens for fees.');
  console.log('    Planned solution: mid-PTB swap (SUI → DEEP on DeepBook DEEP/SUI pool)');
  console.log('    before calling createPool, so creator never needs to hold DEEP.');
  console.log();
  console.log('  Testnet: use env: "testnet" in DeepBookClient constructor');
  console.log('  Mainnet: use env: "mainnet" in DeepBookClient constructor');
  console.log('  Same code works for both — SDK resolves addresses automatically.');
  console.log();
  console.log('  ❌ Skipping — implement before mainnet launch');

  // ── When ready, implementation goes here ──────────────────────────────────
  //
  // import { DeepBookClient } from '@mysten/deepbook-v3';
  //
  // const env = 'testnet'; // or 'mainnet'
  // const dbClient = new DeepBookClient({ address, env, client });
  //
  // const tx = new Transaction();
  //
  // // Claim pool SUI from curve
  // const curveSharedVersion = await getSharedVersion(curveId);
  // const curveRef = tx.sharedObjectRef({ objectId: curveId, initialSharedVersion: curveSharedVersion, mutable: true });
  // const poolSuiCoin = tx.moveCall({
  //   target: `${PACKAGE_ID}::bonding_curve::claim_graduation_funds`,
  //   typeArguments: [tokenType],
  //   arguments: [tx.object(ADMIN_CAP_ID), curveRef],
  // });
  //
  // // Step 1: Swap some SUI → DEEP to pay pool creation fee (mid-PTB)
  // // ... (DeepBook swap call on DEEP/SUI pool)
  //
  // // Step 2: Create BalanceManager
  // // const balanceManager = dbClient.createBalanceManager(tx);
  //
  // // Step 3: Deposit TOKEN + SUI
  // // dbClient.depositIntoManager(tx, balanceManager, poolSuiCoin, tokenCoin);
  //
  // // Step 4: Create pool
  // // dbClient.createPool(tx, { baseCoin: tokenType, quoteCoin: '0x2::sui::SUI', ... });
  //
  // // Step 5: Place orders across price range
  // // ... (limit order placements)
  //
  // // Step 6: Transfer BalanceManager to creator
  // // tx.transferObjects([balanceManager], fields.creator);
  //
  // const result = await client.signAndExecuteTransaction({ signer: keypair, transaction: tx, options: { showEffects: true } });
  // console.log(`  ✓ Graduated to DeepBook! digest: ${result.digest}`);
}
