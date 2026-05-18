// graduate.js
// Executes the post-graduation DEX deposit for a SuiPump bonding curve.
//
// Flow:
//   1. Reads the curve object to confirm it's graduated
//   2. Reads graduation_target from on-chain field (v5/v6) or description (v4)
//   3. Routes to either graduateToCetus() or graduateToDeepBook()
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

// ── Known package IDs ─────────────────────────────────────────────────────────
const PACKAGE_ID_V4 = '0x2154486dcf503bd3e8feae4fb913e862f7e2bbf4489769aff63978f55d55b4a8';
const PACKAGE_ID_V5 = '0x785c0604cb6c60a8547501e307d2b0ca7a586ff912c8abff4edfb88db65b7236';
const PACKAGE_ID_V6 = '0x21d5b1284d5f1d4d14214654f414ffca20c757ee9f9db7701d3ffaaac62cd768';
const PACKAGE_ID_V7 = '0xfb8f3f3e4e8d53130ac140906eebea6b6740bfaf0c971aec607fbc723be951f0';

const SUI_CLOCK_ID  = '0x0000000000000000000000000000000000000000000000000000000000000006';

// graduation_target values (v5/v6/v7)
const GRAD_TARGET_CETUS    = 0;
const GRAD_TARGET_DEEPBOOK = 1;
const GRAD_TARGET_TURBOS   = 2; // v7

// ── Mainnet DEX constants ─────────────────────────────────────────────────────
const CETUS = {
  CLMM_PACKAGE:   '0x1eabed72c53feb3805120a081dc15963c204dc8d091542592abaf7a35689b2fb',
  GLOBAL_CONFIG:  '0xdaa46292632c3c4d8f31f23ea0f9b36a28ff3677e9684980e4438403a67a3d8f',
  POOLS_REGISTRY: '0xf699e7f2276f5c9a75944b37a0c5b5d9ddfd2471bf6242483b03ab2887d198d0',
  CLMMPOOL:       '0x75b2e9ecad34944b8d0c874e568c90db0cf9437f0d7392abfd4cb902972f3e40',
};

// ── Arg parsing ───────────────────────────────────────────────────────────────
const args    = process.argv.slice(2);
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

// v4: dex stored in description via || delimiter
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

// Resolve DEX from curve fields — v5/v6/v7 have graduation_target on-chain
function resolveDex(fields, descriptionDex) {
  if (fields.graduation_target !== undefined && fields.graduation_target !== null) {
    const target = Number(fields.graduation_target);
    if (target === GRAD_TARGET_DEEPBOOK) return 'deepbook';
    if (target === GRAD_TARGET_TURBOS)   return 'turbos';
    return 'cetus';
  }
  // v4: fall back to description parsing
  return descriptionDex || 'cetus';
}

// Determine which package this curve belongs to from its type string
function resolvePackageId(typeStr) {
  if (typeStr?.includes(PACKAGE_ID_V7)) return PACKAGE_ID_V7;
  if (typeStr?.includes(PACKAGE_ID_V6)) return PACKAGE_ID_V6;
  if (typeStr?.includes(PACKAGE_ID_V5)) return PACKAGE_ID_V5;
  if (typeStr?.includes(PACKAGE_ID_V4)) return PACKAGE_ID_V4;
  return PACKAGE_ID; // active package fallback
}

const isV7Package = (pkg) => pkg === PACKAGE_ID_V7;

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

const fields    = curveRes.data.content.fields;
const typeStr   = curveRes.data.type ?? '';
const tokenType = typeStr.match(/Curve<(.+)>$/)?.[1];
const pkgId     = resolvePackageId(typeStr);

if (!tokenType) {
  console.error('❌ Could not parse token type from curve');
  process.exit(1);
}

console.log(`  token:     ${fields.name} ($${fields.symbol})`);
console.log(`  type:      ${tokenType}`);
console.log(`  package:   ${pkgId}`);
console.log(`  graduated: ${fields.graduated}`);
console.log(`  pool SUI:  ${fmtSui(fields.sui_reserve)}`);

// Show graduation_target if v5/v6
if (fields.graduation_target !== undefined) {
  const targetLabel = Number(fields.graduation_target) === GRAD_TARGET_DEEPBOOK ? 'DeepBook' : 'Cetus';
  console.log(`  target:    ${targetLabel} (on-chain field)`);
}
console.log();

// Step 1b: If the curve has drained but graduate() hasn't been called, call it.
// V7 graduate() takes the CoinMetadata<T> by value (it gets frozen on-chain),
// so we must resolve and pass the metadata object. V4-V6 graduate() takes no
// metadata. This script only auto-graduates V7 curves; for legacy curves the
// graduate() call must already have happened.
if (!fields.graduated) {
  const tokenReserve = BigInt(fields.token_reserve ?? 0);
  if (tokenReserve > 0n) {
    console.error('❌ Curve has not drained. token_reserve must be 0 to graduate.');
    console.error(`   token_reserve = ${tokenReserve}`);
    process.exit(1);
  }

  if (!isV7Package(pkgId)) {
    console.error('❌ Curve is drained but not graduated, and is a legacy (V4-V6) package.');
    console.error('   Call graduate() with the legacy tooling for this version.');
    process.exit(1);
  }

  console.log('  Curve is drained but not yet graduated — calling graduate()…');

  // V7 graduate() needs the CoinMetadata<T> object id.
  let metadataId;
  try {
    const meta = await client.getCoinMetadata({ coinType: tokenType });
    metadataId = meta?.id;
  } catch {}
  if (!metadataId) {
    console.error('❌ Could not resolve CoinMetadata for', tokenType);
    console.error('   V7 graduate() freezes the metadata and requires the object.');
    process.exit(1);
  }

  const gradTx = new Transaction();
  const gradCurveVersion = await getSharedVersion(curveId);
  const gradCurveRef = gradTx.sharedObjectRef({
    objectId: curveId, initialSharedVersion: gradCurveVersion, mutable: true,
  });
  // graduate<T>(curve, metadata, clock) — metadata passed by value, frozen on-chain.
  gradTx.moveCall({
    target: `${pkgId}::bonding_curve::graduate`,
    typeArguments: [tokenType],
    arguments: [
      gradCurveRef,
      gradTx.object(metadataId),
      gradTx.object(SUI_CLOCK_ID),
    ],
  });

  const gradRes = await client.signAndExecuteTransaction({
    signer: keypair,
    transaction: gradTx,
    options: { showEffects: true },
  });

  if (gradRes.effects.status.status !== 'success') {
    console.error('❌ graduate() failed:', gradRes.effects.status.error);
    process.exit(1);
  }
  console.log(`  ✓ graduated: ${gradRes.digest}`);
  console.log();

  // Re-fetch the curve so downstream steps see graduated == true.
  const refetch = await client.getObject({
    id: curveId, options: { showContent: true, showType: true },
  });
  Object.assign(fields, refetch.data?.content?.fields ?? {});
}

if (!fields.graduated) {
  console.error('❌ Curve is still not graduated after graduate() call.');
  process.exit(1);
}

const poolSuiAmount = BigInt(fields.sui_reserve ?? 0);
if (poolSuiAmount === 0n) {
  console.error('❌ Pool SUI already claimed or zero. Nothing to deposit.');
  process.exit(1);
}

// Step 2: Resolve DEX — on-chain field takes priority over description
let dex = dexOverride;
if (!dex) {
  let descDex = 'cetus';
  try {
    const meta = await client.getCoinMetadata({ coinType: tokenType });
    descDex = parseDexFromDescription(meta?.description || '');
  } catch {}
  dex = resolveDex(fields, descDex);
}

const source = dexOverride ? 'overridden via CLI' :
  (fields.graduation_target !== undefined ? 'on-chain graduation_target' : 'description metadata');

console.log(`  dex target: ${dex.toUpperCase()} (${source})`);
console.log();

// Step 3: Route
if (dex === 'deepbook') {
  await graduateToDeepBook({ curveId, tokenType, fields, poolSuiAmount, address, keypair, pkgId });
} else if (dex === 'turbos') {
  await graduateToTurbos({ curveId, tokenType, fields, poolSuiAmount, address, keypair, pkgId });
} else {
  await graduateToCetus({ curveId, tokenType, fields, poolSuiAmount, address, keypair, pkgId });
}

// ── Cetus graduation (stub — mainnet only) ────────────────────────────────────
async function graduateToCetus({ curveId, tokenType, fields, poolSuiAmount, address, keypair, pkgId }) {
  console.log('  🌊 Graduating to Cetus CLMM…');
  console.log('  ⚠ STUB — implement before mainnet launch');
  console.log();
  console.log('  Will:');
  console.log('    1. claim_graduation_funds() → pool SUI');
  console.log('    2. Collect 200M LP tokens from creator wallet');
  console.log('    3. Split 50/50 SUI + tokens');
  console.log('    4. Open two Cetus CLMM full-range positions');
  console.log('    5. Transfer creator LP NFT → curve.creator');
  console.log('    6. record_graduation_pool(AdminCap, curve, pool_id, creator_lp_nft_id)  [v7]');
  console.log();
  console.log(`  Package to use: ${pkgId}`);
  if (isV7Package(pkgId)) {
    console.log('  V7 NOTE: after pool creation, call record_graduation_pool to store');
    console.log('  pool_id + creator_lp_nft_id on the curve (emits PoolRecorded).');
  }

  // ── Uncomment when implementing ───────────────────────────────────────────
  // const tx = new Transaction();
  // const curveSharedVersion = await getSharedVersion(curveId);
  // const curveRef = tx.sharedObjectRef({ objectId: curveId, initialSharedVersion: curveSharedVersion, mutable: true });
  // const poolSuiCoin = tx.moveCall({
  //   target: `${pkgId}::bonding_curve::claim_graduation_funds`,
  //   typeArguments: [tokenType],
  //   arguments: [tx.object(ADMIN_CAP_ID), curveRef],
  // });
  // ... Cetus CLMM PTB calls
}

// ── DeepBook graduation (stub) ────────────────────────────────────────────────
async function graduateToDeepBook({ curveId, tokenType, fields, poolSuiAmount, address, keypair, pkgId }) {
  console.log('  ⚡ Graduating to DeepBook…');
  console.log('  ⚠ STUB — implement before mainnet launch');
  console.log();
  console.log('  Will:');
  console.log('    1. claim_graduation_funds() → pool SUI');
  console.log('    2. Collect 200M LP tokens from creator wallet');
  console.log('    3. Mid-PTB SUI → DEEP swap for pool creation fee');
  console.log('    4. Create BalanceManager');
  console.log('    5. Create DeepBook TOKEN/SUI pool');
  console.log('    6. Deposit TOKEN + SUI into BalanceManager');
  console.log('    7. Transfer BalanceManager → curve.creator');
  console.log('    8. record_graduation_pool(AdminCap, curve, pool_id, creator_lp_nft_id)  [v7]');
  console.log();
  console.log(`  Package to use: ${pkgId}`);
  console.log('  Use env: "testnet" or "mainnet" in DeepBookClient constructor');
  if (isV7Package(pkgId)) {
    console.log('  V7 NOTE: after pool creation, call record_graduation_pool to store');
    console.log('  pool_id + creator_lp_nft_id on the curve (emits PoolRecorded).');
  }

  // ── Uncomment when implementing ───────────────────────────────────────────
  // import { DeepBookClient } from '@mysten/deepbook-v3';
  // const env = 'testnet';
  // const dbClient = new DeepBookClient({ address, env, client });
  // const tx = new Transaction();
  // const curveSharedVersion = await getSharedVersion(curveId);
  // const curveRef = tx.sharedObjectRef({ objectId: curveId, initialSharedVersion: curveSharedVersion, mutable: true });
  // const poolSuiCoin = tx.moveCall({
  //   target: `${pkgId}::bonding_curve::claim_graduation_funds`,
  //   typeArguments: [tokenType],
  //   arguments: [tx.object(ADMIN_CAP_ID), curveRef],
  // });
  // ... DeepBook PTB calls
}

// ── Turbos graduation (stub — v7 graduation_target = 2) ───────────────────────
async function graduateToTurbos({ curveId, tokenType, fields, poolSuiAmount, address, keypair, pkgId }) {
  console.log('  🐢 Graduating to Turbos…');
  console.log('  ⚠ STUB — implement before mainnet launch');
  console.log();
  console.log('  Will:');
  console.log('    1. claim_graduation_funds() → pool SUI');
  console.log('    2. Collect 200M LP tokens from creator wallet');
  console.log('    3. Split 50/50 SUI + tokens');
  console.log('    4. Open a Turbos CLMM full-range position');
  console.log('    5. Transfer creator LP NFT → curve.creator');
  console.log('    6. record_graduation_pool(AdminCap, curve, pool_id, creator_lp_nft_id)');
  console.log();
  console.log(`  Package to use: ${pkgId}`);
  console.log('  V7 NOTE: after pool creation, call record_graduation_pool to store');
  console.log('  pool_id + creator_lp_nft_id on the curve (emits PoolRecorded).');
}
