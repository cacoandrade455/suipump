// graduate_test.js
// Graduates a test curve to DeepBook on Sui testnet.
// Completely isolated from the live v4 package.
//
// Usage:
//   node graduate_test.js <CURVE_ID>
//
// Prerequisites:
//   - npm install run in this folder
//   - deploy_test.js run and config.js filled in
//   - launch_test.js run and curve has >= 10 SUI reserve

import { Transaction } from '@mysten/sui/transactions';
import { DeepBookClient } from '@mysten/deepbook-v3';
import { client, loadKeypair, TEST_PACKAGE_ID, TEST_ADMIN_CAP_ID, fmtSui } from './config.js';

if (TEST_PACKAGE_ID === 'FILL_AFTER_DEPLOY') {
  console.error('❌ Fill in TEST_PACKAGE_ID in config.js first.');
  process.exit(1);
}

const args = process.argv.slice(2);
const curveId = args[0];

if (!curveId || !curveId.startsWith('0x')) {
  console.error('Usage: node graduate_test.js <CURVE_ID>');
  process.exit(1);
}

const keypair = loadKeypair();
const address = keypair.toSuiAddress();

async function getSharedVersion(objectId) {
  const obj = await client.getObject({ id: objectId, options: { showOwner: true } });
  return obj.data?.owner?.Shared?.initial_shared_version;
}

console.log('━'.repeat(60));
console.log('  SUIPUMP TEST — graduate to DeepBook');
console.log('━'.repeat(60));
console.log(`  wallet:  ${address}`);
console.log(`  curve:   ${curveId}`);
console.log(`  package: ${TEST_PACKAGE_ID}`);
console.log();

// Fetch curve state
const curveRes = await client.getObject({
  id: curveId,
  options: { showContent: true, showType: true },
});

if (curveRes.error || !curveRes.data?.content?.fields) {
  console.error('❌ Could not fetch curve.');
  process.exit(1);
}

const fields = curveRes.data.content.fields;
const tokenType = curveRes.data.type?.match(/Curve<(.+)>$/)?.[1];

if (!tokenType) {
  console.error('❌ Could not parse token type');
  process.exit(1);
}

const suiReserve  = BigInt(fields.sui_reserve ?? 0);
const tokenReserve = BigInt(fields.token_reserve ?? 0);

console.log(`  token:        ${fields.name} ($${fields.symbol})`);
console.log(`  type:         ${tokenType}`);
console.log(`  graduated:    ${fields.graduated}`);
console.log(`  sui_reserve:  ${fmtSui(suiReserve)}`);
console.log();

// ── Step 1: Call graduate() if not already graduated ─────────────────────────

if (!fields.graduated) {
  const THRESHOLD = 10_000_000_000n;
  if (suiReserve < THRESHOLD && tokenReserve > 0n) {
    console.error(`❌ Not eligible. Need >= 10 SUI in reserve, have ${fmtSui(suiReserve)}`);
    process.exit(1);
  }

  console.log('  [1/3] Calling graduate()…');

  const gradTx = new Transaction();
  const sharedVersion = await getSharedVersion(curveId);
  const curveRef = gradTx.sharedObjectRef({
    objectId: curveId,
    initialSharedVersion: sharedVersion,
    mutable: true,
  });

  gradTx.moveCall({
    target: `${TEST_PACKAGE_ID}::bonding_curve_test::graduate`,
    typeArguments: [tokenType],
    arguments: [curveRef],
  });

  const gradResult = await client.signAndExecuteTransaction({
    signer: keypair,
    transaction: gradTx,
    options: { showEffects: true },
  });

  if (gradResult.effects.status.status !== 'success') {
    console.error('❌ graduate() failed:', gradResult.effects.status.error);
    process.exit(1);
  }

  console.log(`  ✓ graduated: ${gradResult.digest}`);
  console.log();
  await new Promise(r => setTimeout(r, 3000));
} else {
  console.log('  Curve already graduated — skipping graduate() call.');
  console.log();
}

// ── Step 2: Claim pool SUI ────────────────────────────────────────────────────

// Re-fetch to get updated reserve after graduation bonuses paid out
const updated = await client.getObject({ id: curveId, options: { showContent: true } });
const poolSui = BigInt(updated.data?.content?.fields?.sui_reserve ?? 0);

if (poolSui === 0n) {
  console.error('❌ Pool SUI is 0 — already claimed or nothing to deposit.');
  process.exit(1);
}

console.log(`  [2/3] Claiming ${fmtSui(poolSui)} pool SUI…`);

const claimTx = new Transaction();
const sharedVersion2 = await getSharedVersion(curveId);
const curveRef2 = claimTx.sharedObjectRef({
  objectId: curveId,
  initialSharedVersion: sharedVersion2,
  mutable: true,
});

const poolSuiCoin = claimTx.moveCall({
  target: `${TEST_PACKAGE_ID}::bonding_curve_test::claim_graduation_funds`,
  typeArguments: [tokenType],
  arguments: [claimTx.object(TEST_ADMIN_CAP_ID), curveRef2],
});

// Transfer to our wallet — we need it as an owned object for DeepBook deposit
claimTx.transferObjects([poolSuiCoin], address);

const claimResult = await client.signAndExecuteTransaction({
  signer: keypair,
  transaction: claimTx,
  options: { showEffects: true },
});

if (claimResult.effects.status.status !== 'success') {
  console.error('❌ claim_graduation_funds() failed:', claimResult.effects.status.error);
  process.exit(1);
}

console.log(`  ✓ claimed: ${claimResult.digest}`);
console.log();
await new Promise(r => setTimeout(r, 3000));

// ── Step 3: Deposit to DeepBook ───────────────────────────────────────────────

console.log('  [3/3] Depositing to DeepBook BalanceManager…');

// Collect LP tokens (200M transferred to curve.creator in graduate())
const lpCoins = await client.getCoins({ owner: address, coinType: tokenType });
if (lpCoins.data.length === 0) {
  console.error('❌ No LP tokens found in wallet.');
  console.error('   They should have been transferred to curve.creator in graduate().');
  process.exit(1);
}

const totalLp = lpCoins.data.reduce((s, c) => s + BigInt(c.balance), 0n);
console.log(`  LP tokens: ${(Number(totalLp) / 1e6).toLocaleString()}`);

// Collect the SUI coin we just claimed
const suiCoins = await client.getCoins({ owner: address, coinType: '0x2::sui::SUI' });
const suiForDeposit = suiCoins.data
  .filter(c => BigInt(c.balance) >= poolSui)
  .sort((a, b) => Number(BigInt(a.balance) - BigInt(b.balance)))[0];

if (!suiForDeposit) {
  console.error(`❌ No SUI coin large enough. Need ${fmtSui(poolSui)}`);
  process.exit(1);
}

// Init DeepBook client — network must be 'testnet' or 'mainnet' explicitly
const dbClient = new DeepBookClient({
  address,
  network: 'testnet',
  client,
});

console.log(`  DeepBook package: ${dbClient.config.DEEPBOOK_PACKAGE_ID}`);
console.log();

const tx = new Transaction();

// Create BalanceManager
const balanceManager = tx.moveCall({
  target: `${dbClient.config.DEEPBOOK_PACKAGE_ID}::balance_manager::new`,
  arguments: [],
});

// Deposit SUI
const [suiSplit] = tx.splitCoins(tx.object(suiForDeposit.coinObjectId), [tx.pure.u64(poolSui)]);
tx.moveCall({
  target: `${dbClient.config.DEEPBOOK_PACKAGE_ID}::balance_manager::deposit`,
  typeArguments: ['0x2::sui::SUI'],
  arguments: [balanceManager, suiSplit],
});

// Deposit LP tokens — merge if multiple coins
const lpCoinObjs = lpCoins.data.map(c => tx.object(c.coinObjectId));
if (lpCoinObjs.length > 1) {
  tx.mergeCoins(lpCoinObjs[0], lpCoinObjs.slice(1));
}
tx.moveCall({
  target: `${dbClient.config.DEEPBOOK_PACKAGE_ID}::balance_manager::deposit`,
  typeArguments: [tokenType],
  arguments: [balanceManager, lpCoinObjs[0]],
});

// Transfer BalanceManager to curve.creator (our wallet in this test)
const creatorAddress = fields.creator ?? address;
tx.transferObjects([balanceManager], creatorAddress);

const dbResult = await client.signAndExecuteTransaction({
  signer: keypair,
  transaction: tx,
  options: { showEffects: true, showObjectChanges: true },
});

if (dbResult.effects.status.status !== 'success') {
  console.error('❌ DeepBook deposit failed:', dbResult.effects.status.error);
  console.error('   Error:', dbResult.effects.status.error);
  process.exit(1);
}

const bmObj = dbResult.objectChanges?.find(c =>
  c.type === 'created' && c.objectType?.toLowerCase().includes('balancemanager')
);

console.log();
console.log('━'.repeat(60));
console.log('  ✓ GRADUATED TO DEEPBOOK');
console.log('━'.repeat(60));
console.log();
console.log(`  Digest:          ${dbResult.digest}`);
console.log(`  BalanceManager:  ${bmObj?.objectId ?? 'see object changes above'}`);
console.log(`  Owner:           ${creatorAddress}`);
console.log(`  SUI deposited:   ${fmtSui(poolSui)}`);
console.log(`  Tokens deposited: ${(Number(totalLp) / 1e6).toLocaleString()}`);
console.log();
console.log('  https://testnet.suivision.xyz/txblock/' + dbResult.digest);
console.log('━'.repeat(60));
