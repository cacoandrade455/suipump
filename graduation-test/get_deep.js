// get_deep.js
// Gets testnet DEEP by swapping SUI via the DEEP/SUI pool on DeepBook testnet.
// Uses a flash loan to bootstrap the DEEP fee, swaps SUI→DEEP, repays loan.
//
// Usage:
//   node get_deep.js          # tries to get as much DEEP as possible
//   node get_deep.js 100      # min 100 DEEP

import { Transaction } from '@mysten/sui/transactions';
import { client, loadKeypair, fmtSui } from './config.js';

const DEEPBOOK_PKG  = '0x22be4cade64bf2d02412c7e8d0e8beea2f78828b948118d46735315409371a3c';
const DEEP_SUI_POOL = '0x48c95963e9eac37a316b7ae04a0deb761bcdcc2b67912374d6036e7f0e9bae9f';
const DEEP_TYPE     = '0x36dbef866a1d62bf7328989a10fb2f07d769f4ee587c0de4a0a256e57e0a58a8::deep::DEEP';
const SUI_TYPE      = '0x2::sui::SUI';

// minOut = 1 DEEP — just ask for 1 and take whatever we get
// The pool has limited testnet liquidity
const MIN_DEEP_OUT  = 1_000_000n; // 1 DEEP with 6 decimals
const DEEP_FEE      = 1_000_000n; // 1 DEEP for flash loan fee

const keypair = loadKeypair();
const address  = keypair.toSuiAddress();

console.log('━'.repeat(50));
console.log('  Get testnet DEEP via SUI swap');
console.log('━'.repeat(50));
console.log(`  wallet: ${address}`);
console.log();

const deepBefore = await client.getCoins({ owner: address, coinType: DEEP_TYPE });
const deepBalBefore = deepBefore.data.reduce((s, c) => s + BigInt(c.balance), 0n);
console.log(`  DEEP before: ${(Number(deepBalBefore) / 1e6).toFixed(2)}`);

if (deepBalBefore >= 500_000_000n) {
  console.log(`  ✓ Already have 500+ DEEP. Ready for graduation.`);
  process.exit(0);
}

// First, check pool liquidity
console.log('  Checking pool liquidity…');
try {
  const poolObj = await client.getObject({
    id: DEEP_SUI_POOL,
    options: { showContent: true }
  });
  console.log(`  Pool fetched OK`);
} catch (e) {
  console.log(`  Could not fetch pool: ${e.message}`);
}

// Build the swap tx using flash loan pattern
// DEEP/SUI pool: DEEP=base, SUI=quote
// We borrow 1 DEEP (base) via flash loan, use it as fee for swap, get DEEP back
const tx = new Transaction();

// Borrow 1 DEEP from pool via flash loan
const [borrowedDeep, flashLoan] = tx.moveCall({
  target: `${DEEPBOOK_PKG}::pool::borrow_flashloan_base`,
  typeArguments: [DEEP_TYPE, SUI_TYPE],
  arguments: [
    tx.object(DEEP_SUI_POOL),
    tx.pure.u64(DEEP_FEE),
  ],
});

// Spend up to 10,000 SUI to get as much DEEP as possible
const SUI_SPEND = 10_000_000_000_000n; // 10,000 SUI
const [suiInput] = tx.splitCoins(tx.gas, [tx.pure.u64(SUI_SPEND)]);

// Swap SUI→DEEP using the borrowed DEEP as fee
// minOut = 1 DEEP (just need enough to repay + some extra)
const [deepOut, suiChange, deepFeeChange] = tx.moveCall({
  target: `${DEEPBOOK_PKG}::pool::swap_exact_quote_for_base`,
  typeArguments: [DEEP_TYPE, SUI_TYPE],
  arguments: [
    tx.object(DEEP_SUI_POOL),
    suiInput,
    borrowedDeep,
    tx.pure.u64(MIN_DEEP_OUT),
    tx.object('0x6'), // clock
  ],
});

// Split 1 DEEP from output to repay flash loan
const [deepRepay] = tx.splitCoins(deepOut, [tx.pure.u64(DEEP_FEE)]);

// Repay flash loan
tx.moveCall({
  target: `${DEEPBOOK_PKG}::pool::return_flashloan_base`,
  typeArguments: [DEEP_TYPE, SUI_TYPE],
  arguments: [
    tx.object(DEEP_SUI_POOL),
    deepRepay,
    flashLoan,
  ],
});

// Transfer everything back
tx.transferObjects([deepOut, suiChange, deepFeeChange], address);

console.log('  Submitting swap…');
try {
  const result = await client.signAndExecuteTransaction({
    signer: keypair,
    transaction: tx,
    options: { showEffects: true, showBalanceChanges: true },
  });

  if (result.effects.status.status !== 'success') {
    console.error('❌ Swap failed:', result.effects.status.error);
    process.exit(1);
  }

  await new Promise(r => setTimeout(r, 2000));
  const deepAfter = await client.getCoins({ owner: address, coinType: DEEP_TYPE });
  const deepBalAfter = deepAfter.data.reduce((s, c) => s + BigInt(c.balance), 0n);
  const gained = deepBalAfter - deepBalBefore;

  console.log();
  console.log('━'.repeat(50));
  if (deepBalAfter >= 500_000_000n) {
    console.log('  ✓ Got enough DEEP for pool creation!');
  } else {
    console.log(`  ⚠ Only got ${(Number(gained)/1e6).toFixed(2)} DEEP — pool has low liquidity`);
    console.log('  Need 500 DEEP total for pool creation.');
    console.log('  Run this script multiple times to accumulate.');
  }
  console.log('━'.repeat(50));
  console.log(`  Digest:      ${result.digest}`);
  console.log(`  DEEP before: ${(Number(deepBalBefore)/1e6).toFixed(2)}`);
  console.log(`  DEEP after:  ${(Number(deepBalAfter)/1e6).toFixed(2)}`);
  console.log(`  Gained:      ${(Number(gained)/1e6).toFixed(2)} DEEP`);
  console.log();

  if (deepBalAfter >= 500_000_000n) {
    console.log('  Now run: node launch_test.js');
    console.log('         : node graduate_deepbook_full.js <CURVE_ID>');
  } else {
    console.log('  Run again to get more DEEP, or get it manually:');
    console.log('  https://testnet.deepbookv3.cetus.zone');
  }
  console.log('━'.repeat(50));

} catch (e) {
  console.error('❌ Error:', e.message?.slice(0, 300));
  console.log();
  console.log('  The testnet DEEP/SUI pool may have insufficient liquidity.');
  console.log('  Get DEEP manually: https://testnet.deepbookv3.cetus.zone');
  console.log('  Or contact DeepBook team on Discord for testnet DEEP.');
}
