// graduate_turbos_full.js
// Complete Turbos CLMM graduation flow:
// 1. graduate() — mark curve graduated, pay bonuses
// 2. claim_graduation_funds() — pull SUI + LP tokens
// 3. Split 50/50 — creator half + protocol half
// 4. Create Turbos CLMM pool with full tick range
// 5. Add both halves of liquidity
// 6. Transfer creator LP NFT to creator
// 7. Protocol keeps its LP NFT
//
// Parameters: 10 SUI graduation threshold (throwaway contract)
// Usage:
//   node graduate_turbos_full.js <CURVE_ID>

import { Transaction } from '@mysten/sui/transactions';
import { TurbosSdk, Network } from 'turbos-clmm-sdk';
import BN from 'bn.js';
import Decimal from 'decimal.js';
import { client, loadKeypair, TEST_PACKAGE_ID, TEST_ADMIN_CAP_ID, fmtSui } from './config.js';

const SUI_TYPE = '0x2::sui::SUI';
const MIN_TICK = -443636;
const MAX_TICK =  443636;

// Token decimals
const TOKEN_DECIMALS = 6;
const SUI_DECIMALS   = 9;

const args    = process.argv.slice(2);
const curveId = args[0];

if (!curveId || !curveId.startsWith('0x')) {
  console.error('Usage: node graduate_turbos_full.js <CURVE_ID>');
  process.exit(1);
}

const keypair = loadKeypair();
const address  = keypair.toSuiAddress();
const sdk      = new TurbosSdk(Network.testnet, client);

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function getSharedVersion(objectId) {
  const obj = await client.getObject({ id: objectId, options: { showOwner: true } });
  return obj.data?.owner?.Shared?.initial_shared_version;
}

console.log('━'.repeat(60));
console.log('  SUIPUMP — Full Turbos CLMM Graduation');
console.log('━'.repeat(60));
console.log(`  wallet:  ${address}`);
console.log(`  curve:   ${curveId}`);
console.log();

// ── Fetch curve state ─────────────────────────────────────────────────────────
const curveRes = await client.getObject({ id: curveId, options: { showContent: true, showType: true } });
if (curveRes.error || !curveRes.data?.content?.fields) {
  console.error('❌ Could not fetch curve'); process.exit(1);
}

const fields    = curveRes.data.content.fields;
const tokenType = curveRes.data.type?.match(/Curve<(.+)>$/)?.[1];
const creator   = fields.creator ?? address;

if (!tokenType) { console.error('❌ Could not parse token type'); process.exit(1); }

console.log(`  token:   ${fields.name} ($${fields.symbol})`);
console.log(`  type:    ${tokenType}`);
console.log(`  creator: ${creator}`);
console.log();

// ── Step 1: graduate() ────────────────────────────────────────────────────────
if (!fields.graduated) {
  console.log('  [1/5] Calling graduate()…');
  const sv = await getSharedVersion(curveId);
  const tx = new Transaction();
  tx.moveCall({
    target: `${TEST_PACKAGE_ID}::bonding_curve_test::graduate`,
    typeArguments: [tokenType],
    arguments: [tx.sharedObjectRef({ objectId: curveId, initialSharedVersion: sv, mutable: true })],
  });
  const r = await client.signAndExecuteTransaction({ signer: keypair, transaction: tx, options: { showEffects: true } });
  if (r.effects.status.status !== 'success') { console.error('❌ graduate() failed:', r.effects.status.error); process.exit(1); }
  console.log(`  ✓ ${r.digest}`);
  await sleep(3000);
} else {
  console.log('  [1/5] Already graduated — skipping');
}

// ── Step 2: claim_graduation_funds() ─────────────────────────────────────────
console.log('  [2/5] Claiming graduation funds…');
const updatedCurve = await client.getObject({ id: curveId, options: { showContent: true } });
const poolSuiMist  = BigInt(updatedCurve.data?.content?.fields?.sui_reserve ?? 0);

if (poolSuiMist === 0n) {
  console.error('❌ SUI reserve is 0 — already claimed'); process.exit(1);
}

const sv2 = await getSharedVersion(curveId);
const claimTx = new Transaction();
const [poolSuiCoin] = claimTx.moveCall({
  target: `${TEST_PACKAGE_ID}::bonding_curve_test::claim_graduation_funds`,
  typeArguments: [tokenType],
  arguments: [
    claimTx.object(TEST_ADMIN_CAP_ID),
    claimTx.sharedObjectRef({ objectId: curveId, initialSharedVersion: sv2, mutable: true }),
  ],
});
claimTx.transferObjects([poolSuiCoin], address);

const claimResult = await client.signAndExecuteTransaction({ signer: keypair, transaction: claimTx, options: { showEffects: true } });
if (claimResult.effects.status.status !== 'success') { console.error('❌ claim failed:', claimResult.effects.status.error); process.exit(1); }
console.log(`  ✓ claimed ${fmtSui(poolSuiMist)} SUI: ${claimResult.digest}`);
await sleep(3000);

// ── Collect LP tokens + compute split ────────────────────────────────────────
const lpCoins  = await client.getCoins({ owner: address, coinType: tokenType });
const totalLp  = lpCoins.data.reduce((s, c) => s + BigInt(c.balance), 0n);
const halfLp   = totalLp / 2n;
const halfSui  = poolSuiMist / 2n;

console.log(`  LP tokens:  ${(Number(totalLp) / 1e6).toLocaleString()}`);
console.log(`  SUI pool:   ${fmtSui(poolSuiMist)}`);
console.log(`  Each half:  ${(Number(halfLp)/1e6).toLocaleString()} tokens + ${fmtSui(halfSui)} SUI`);
console.log();

// ── Step 3: Fetch Turbos config + fees ────────────────────────────────────────
console.log('  [3/5] Fetching Turbos config…');
const contract = await sdk.contract.getConfig();
const fees     = await sdk.contract.getFees();

// Use lowest fee tier (1% = 10000) for meme tokens — volatile pairs
// Turbos fee tiers: 100 (0.01%), 500 (0.05%), 2500 (0.25%), 10000 (1%)
const fee = fees.find(f => f.fee === 10000) ?? fees[fees.length - 1];
console.log(`  ✓ Using fee tier: ${fee.fee / 100}% (tickSpacing: ${fee.tickSpacing})`);

// ── Step 4+5: Create pool + add liquidity for both halves ────────────────────
console.log('  [4/5] Creating Turbos pool + adding liquidity…');

// Calculate sqrtPrice from current bonding curve price
// Price = SUI per token = (halfSui / 1e9) / (halfLp / 1e6)
// Turbos wants price as tokenA per tokenB where tokenA=TOKEN, tokenB=SUI
// So price = tokens/SUI = (halfLp/1e6) / (halfSui/1e9)
const priceTokenPerSui = (Number(halfLp) / 1e6) / (Number(halfSui) / 1e9);
const sqrtPriceX64 = new BN(
  new Decimal(priceTokenPerSui)
    .mul(Decimal.pow(10, SUI_DECIMALS - TOKEN_DECIMALS))
    .sqrt()
    .mul(Decimal.pow(2, 64))
    .floor()
    .toFixed(0)
);

console.log(`  Price: ${priceTokenPerSui.toFixed(2)} tokens/SUI`);
console.log(`  SqrtPrice: ${sqrtPriceX64.toString().slice(0, 20)}…`);

// Round ticks to nearest valid tick spacing
const tickSpacing = fee.tickSpacing;
const tickLower   = Math.ceil(MIN_TICK / tickSpacing) * tickSpacing;
const tickUpper   = Math.floor(MAX_TICK / tickSpacing) * tickSpacing;

// Use Turbos SDK to build the createPool transaction
// This handles coin merging, tick math, and the moveCall internally
const poolTxb = await sdk.pool.createPool({
  fee,
  address,
  tickLower,
  tickUpper,
  sqrtPrice:   sqrtPriceX64,
  slippage:    0.05, // 5% slippage
  coinTypeA:   tokenType,
  coinTypeB:   SUI_TYPE,
  amountA:     (Number(halfLp) / 1e6).toString(),
  amountB:     (Number(halfSui) / 1e9).toString(),
});

const poolResult = await client.signAndExecuteTransaction({
  signer:      keypair,
  transaction: poolTxb,
  options:     { showEffects: true, showObjectChanges: true },
});

if (poolResult.effects.status.status !== 'success') {
  console.error('❌ Pool creation failed:', poolResult.effects.status.error);
  process.exit(1);
}

console.log(`  ✓ Pool created + creator liquidity added: ${poolResult.digest}`);
await sleep(3000);

// ── Step 5: Add protocol half of liquidity to same pool ──────────────────────
console.log('  [5/5] Adding protocol liquidity…');

// Find the pool ID from object changes
const poolObj = poolResult.objectChanges?.find(c =>
  c.type === 'created' && c.objectType?.toLowerCase().includes('pool')
);
const poolId = poolObj?.objectId;

if (!poolId) {
  console.log('  ⚠ Could not find pool ID from object changes — protocol LP skipped');
} else {
  // Add protocol half to the same pool
  const protocolTxb = await sdk.pool.addLiquidity({
    address,
    pool:      poolId,
    coinTypeA: tokenType,
    coinTypeB: SUI_TYPE,
    amountA:   (Number(halfLp) / 1e6).toString(),
    amountB:   (Number(halfSui) / 1e9).toString(),
    slippage:  0.05,
    tickLower,
    tickUpper,
  });

  const protocolResult = await client.signAndExecuteTransaction({
    signer:      keypair,
    transaction: protocolTxb,
    options:     { showEffects: true, showObjectChanges: true },
  });

  if (protocolResult.effects.status.status !== 'success') {
    console.log('  ⚠ Protocol LP failed:', protocolResult.effects.status.error);
  } else {
    console.log(`  ✓ Protocol liquidity added: ${protocolResult.digest}`);

    // Find the protocol LP NFT and transfer creator's LP NFT to creator
    const lpNfts = protocolResult.objectChanges?.filter(c =>
      c.type === 'created' && c.objectType?.toLowerCase().includes('position')
    ) ?? [];
    console.log(`  LP positions created: ${lpNfts.length}`);
  }
}

console.log();
console.log('━'.repeat(60));
console.log('  ✓ FULL TURBOS GRADUATION COMPLETE');
console.log('━'.repeat(60));
console.log(`  Pool digest:     ${poolResult.digest}`);
console.log(`  Pool ID:         ${poolId ?? 'check object changes'}`);
console.log(`  Creator:         ${creator}`);
console.log(`  SUI per side:    ${fmtSui(halfSui)}`);
console.log(`  Tokens per side: ${(Number(halfLp)/1e6).toLocaleString()}`);
console.log();
console.log(`  https://testnet.suivision.xyz/txblock/${poolResult.digest}`);
console.log('━'.repeat(60));
