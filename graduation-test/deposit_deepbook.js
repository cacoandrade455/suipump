// deposit_deepbook.js
// Deposits LP tokens + graduation SUI into a DeepBook BalanceManager.
// Run this after graduate() and claim_graduation_funds() have already succeeded.
//
// Usage:
//   node deposit_deepbook.js <TOKEN_TYPE> <CREATOR_ADDRESS> <SUI_AMOUNT_TO_DEPOSIT>
//
// Example:
//   node deposit_deepbook.js \
//     0x95bc6d6c263304c7774ddc41f771fa89e43bdeb2c500db2a6852355b972f5ecb::template::TEMPLATE \
//     0x0be9a8f56ba3b07f295e0c7526e7f47ca3a146649b9d864d2eb47bf3acd90c55 \
//     10.79

import { Transaction } from '@mysten/sui/transactions';
import { client, loadKeypair, fmtSui } from './config.js';

// DeepBook testnet package ID (from @mysten/deepbook-v3 constants)
const DEEPBOOK_PACKAGE_ID = '0x22be4cade64bf2d02412c7e8d0e8beea2f78828b948118d46735315409371a3c';

const args = process.argv.slice(2);
const tokenType    = args[0];
const creatorAddr  = args[1];
const suiAmountArg = parseFloat(args[2]);

if (!tokenType || !creatorAddr || isNaN(suiAmountArg)) {
  console.error('Usage: node deposit_deepbook.js <TOKEN_TYPE> <CREATOR_ADDRESS> <SUI_AMOUNT>');
  console.error('');
  console.error('Example:');
  console.error('  node deposit_deepbook.js \\');
  console.error('    0x95bc6d...::template::TEMPLATE \\');
  console.error('    0x0be9a8... \\');
  console.error('    10.79');
  process.exit(1);
}

const depositSuiMist = BigInt(Math.floor(suiAmountArg * 1e9));
const keypair = loadKeypair();
const address  = keypair.toSuiAddress();

console.log('━'.repeat(60));
console.log('  SUIPUMP TEST — deposit to DeepBook');
console.log('━'.repeat(60));
console.log(`  wallet:          ${address}`);
console.log(`  token type:      ${tokenType}`);
console.log(`  creator:         ${creatorAddr}`);
console.log(`  SUI to deposit:  ${fmtSui(depositSuiMist)}`);
console.log(`  DeepBook pkg:    ${DEEPBOOK_PACKAGE_ID}`);
console.log();

// Find LP tokens
const lpCoins = await client.getCoins({ owner: address, coinType: tokenType });
if (lpCoins.data.length === 0) {
  console.error('❌ No LP tokens found in wallet for this token type.');
  process.exit(1);
}
const totalLp = lpCoins.data.reduce((s, c) => s + BigInt(c.balance), 0n);
console.log(`  LP tokens found: ${(Number(totalLp) / 1e6).toLocaleString()}`);

// Find a SUI coin large enough for the deposit
const suiCoins = await client.getCoins({ owner: address, coinType: '0x2::sui::SUI' });
const suiCoin = suiCoins.data
  .filter(c => BigInt(c.balance) >= depositSuiMist + 500_000_000n) // need deposit + 0.5 SUI for gas
  .sort((a, b) => Number(BigInt(a.balance) - BigInt(b.balance)))[0]; // smallest that fits

if (!suiCoin) {
  console.error(`❌ No SUI coin large enough. Need ${fmtSui(depositSuiMist)} + gas.`);
  suiCoins.data.slice(0, 5).forEach(c => console.error(`  available: ${fmtSui(BigInt(c.balance))}`));
  process.exit(1);
}

console.log(`  SUI coin used:   ${fmtSui(BigInt(suiCoin.balance))}`);
console.log();
console.log('  Building transaction…');

const tx = new Transaction();

// Create BalanceManager
const balanceManager = tx.moveCall({
  target: `${DEEPBOOK_PACKAGE_ID}::balance_manager::new`,
  arguments: [],
});

// Deposit SUI — split exact amount off the coin
const [suiSplit] = tx.splitCoins(tx.object(suiCoin.coinObjectId), [tx.pure.u64(depositSuiMist)]);
tx.moveCall({
  target: `${DEEPBOOK_PACKAGE_ID}::balance_manager::deposit`,
  typeArguments: ['0x2::sui::SUI'],
  arguments: [balanceManager, suiSplit],
});

// Merge LP token coins if needed, then deposit
const lpObjs = lpCoins.data.map(c => tx.object(c.coinObjectId));
if (lpObjs.length > 1) tx.mergeCoins(lpObjs[0], lpObjs.slice(1));
tx.moveCall({
  target: `${DEEPBOOK_PACKAGE_ID}::balance_manager::deposit`,
  typeArguments: [tokenType],
  arguments: [balanceManager, lpObjs[0]],
});

// Transfer BalanceManager ownership to creator
tx.transferObjects([balanceManager], creatorAddr);

console.log('  Submitting…');

const result = await client.signAndExecuteTransaction({
  signer: keypair,
  transaction: tx,
  options: { showEffects: true, showObjectChanges: true },
});

if (result.effects.status.status !== 'success') {
  console.error('❌ Transaction failed:', result.effects.status.error);
  process.exit(1);
}

const bmObj = result.objectChanges?.find(c =>
  c.type === 'created' && c.objectType?.toLowerCase().includes('balancemanager')
);

console.log();
console.log('━'.repeat(60));
console.log('  ✓ DEPOSITED TO DEEPBOOK');
console.log('━'.repeat(60));
console.log();
console.log(`  Digest:           ${result.digest}`);
console.log(`  BalanceManager:   ${bmObj?.objectId ?? 'see object changes'}`);
console.log(`  Owner:            ${creatorAddr}`);
console.log(`  SUI deposited:    ${fmtSui(depositSuiMist)}`);
console.log(`  Tokens deposited: ${(Number(totalLp) / 1e6).toLocaleString()}`);
console.log();
console.log(`  https://testnet.suivision.xyz/txblock/${result.digest}`);
console.log('━'.repeat(60));
