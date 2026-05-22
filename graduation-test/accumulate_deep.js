// accumulate_deep.js
// Repeatedly swaps SUI→DEEP via flash loan until we have 500+ DEEP.
// Gets 20 DEEP per run, loops until target reached.
//
// Usage:
//   node accumulate_deep.js          # loop until 500 DEEP
//   node accumulate_deep.js 1000     # loop until 1000 DEEP

import { Transaction } from '@mysten/sui/transactions';
import { client, loadKeypair } from './config.js';

const DEEPBOOK_PKG  = '0x22be4cade64bf2d02412c7e8d0e8beea2f78828b948118d46735315409371a3c';
const DEEP_SUI_POOL = '0x48c95963e9eac37a316b7ae04a0deb761bcdcc2b67912374d6036e7f0e9bae9f';
const DEEP_TYPE     = '0x36dbef866a1d62bf7328989a10fb2f07d769f4ee587c0de4a0a256e57e0a58a8::deep::DEEP';
const SUI_TYPE      = '0x2::sui::SUI';
const DEEP_SCALAR   = 1_000_000n;
const DEEP_FEE      = 1_000_000n;
const MIN_DEEP_OUT  = 1_000_000n;

const TARGET = BigInt(process.argv[2] ?? 600) * DEEP_SCALAR;

const keypair = loadKeypair();
const address  = keypair.toSuiAddress();

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function getDeepBalance() {
  const coins = await client.getCoins({ owner: address, coinType: DEEP_TYPE });
  return coins.data.reduce((s, c) => s + BigInt(c.balance), 0n);
}

async function swapOnce() {
  const tx = new Transaction();

  const [borrowedDeep, flashLoan] = tx.moveCall({
    target: `${DEEPBOOK_PKG}::pool::borrow_flashloan_base`,
    typeArguments: [DEEP_TYPE, SUI_TYPE],
    arguments: [tx.object(DEEP_SUI_POOL), tx.pure.u64(DEEP_FEE)],
  });

  const [suiInput] = tx.splitCoins(tx.gas, [tx.pure.u64(10_000_000_000_000n)]);

  const [deepOut, suiChange, deepFeeChange] = tx.moveCall({
    target: `${DEEPBOOK_PKG}::pool::swap_exact_quote_for_base`,
    typeArguments: [DEEP_TYPE, SUI_TYPE],
    arguments: [
      tx.object(DEEP_SUI_POOL),
      suiInput,
      borrowedDeep,
      tx.pure.u64(MIN_DEEP_OUT),
      tx.object('0x6'),
    ],
  });

  const [deepRepay] = tx.splitCoins(deepOut, [tx.pure.u64(DEEP_FEE)]);

  tx.moveCall({
    target: `${DEEPBOOK_PKG}::pool::return_flashloan_base`,
    typeArguments: [DEEP_TYPE, SUI_TYPE],
    arguments: [tx.object(DEEP_SUI_POOL), deepRepay, flashLoan],
  });

  tx.transferObjects([deepOut, suiChange, deepFeeChange], address);

  const result = await client.signAndExecuteTransaction({
    signer: keypair,
    transaction: tx,
    options: { showEffects: true },
  });

  return result.effects.status.status === 'success';
}

console.log('━'.repeat(50));
console.log('  Accumulating testnet DEEP');
console.log(`  Target: ${Number(TARGET) / 1e6} DEEP`);
console.log('━'.repeat(50));

let balance = await getDeepBalance();
console.log(`  Starting balance: ${(Number(balance) / 1e6).toFixed(2)} DEEP`);
console.log();

let attempt = 0;
let failures = 0;

while (balance < TARGET) {
  attempt++;
  process.stdout.write(`  [${attempt}] Swapping… `);

  try {
    const ok = await swapOnce();
    if (ok) {
      await sleep(1500);
      balance = await getDeepBalance();
      console.log(`✓ ${(Number(balance) / 1e6).toFixed(2)} DEEP`);
      failures = 0;
    } else {
      console.log('✗ failed');
      failures++;
    }
  } catch (e) {
    console.log(`✗ ${e.message?.slice(0, 60)}`);
    failures++;
  }

  if (failures >= 3) {
    console.log();
    console.log('  ⚠ 3 consecutive failures — pool may be dry');
    break;
  }

  // Small delay between swaps
  await sleep(2000);
}

balance = await getDeepBalance();
console.log();
console.log('━'.repeat(50));
if (balance >= TARGET) {
  console.log(`  ✓ Done! ${(Number(balance) / 1e6).toFixed(2)} DEEP ready`);
  console.log();
  console.log('  Now run:');
  console.log('    node launch_test.js');
  console.log('    node graduate_deepbook_full.js <CURVE_ID>');
} else {
  console.log(`  Got ${(Number(balance) / 1e6).toFixed(2)} / ${Number(TARGET) / 1e6} DEEP`);
  console.log('  Pool appears dry — wait for DeepBook Discord response');
}
console.log('━'.repeat(50));
