// withdraw_deepbook.js
// Withdraws SUI and tokens from a DeepBook BalanceManager back to your wallet.
// Only works if you are the owner of the BalanceManager.
//
// Usage:
//   node withdraw_deepbook.js <BALANCE_MANAGER_ID> <TOKEN_TYPE>
//
// Example:
//   node withdraw_deepbook.js \
//     0x0655d1ca7f5142ed16cb47d294cfaaa5d450106fc4d3416b7aaa1f11a909b06a \
//     0x95bc6d6c263304c7774ddc41f771fa89e43bdeb2c500db2a6852355b972f5ecb::template::TEMPLATE

import { Transaction } from '@mysten/sui/transactions';
import { client, loadKeypair, fmtSui } from './config.js';

const DEEPBOOK_PACKAGE_ID = '0x22be4cade64bf2d02412c7e8d0e8beea2f78828b948118d46735315409371a3c';

const args = process.argv.slice(2);
const balanceManagerId = args[0];
const tokenType        = args[1];

if (!balanceManagerId || !tokenType) {
  console.error('Usage: node withdraw_deepbook.js <BALANCE_MANAGER_ID> <TOKEN_TYPE>');
  process.exit(1);
}

const keypair = loadKeypair();
const address = keypair.toSuiAddress();

console.log('━'.repeat(60));
console.log('  SUIPUMP TEST — withdraw from DeepBook BalanceManager');
console.log('━'.repeat(60));
console.log(`  wallet:          ${address}`);
console.log(`  balanceManager:  ${balanceManagerId}`);
console.log(`  token type:      ${tokenType}`);
console.log();

const tx = new Transaction();
const bm = tx.object(balanceManagerId);

// Withdraw all SUI
const suiOut = tx.moveCall({
  target: `${DEEPBOOK_PACKAGE_ID}::balance_manager::withdraw_all`,
  typeArguments: ['0x2::sui::SUI'],
  arguments: [bm],
});
tx.transferObjects([suiOut], address);

// Withdraw all tokens
const tokenOut = tx.moveCall({
  target: `${DEEPBOOK_PACKAGE_ID}::balance_manager::withdraw_all`,
  typeArguments: [tokenType],
  arguments: [bm],
});
tx.transferObjects([tokenOut], address);

console.log('  Submitting…');

const result = await client.signAndExecuteTransaction({
  signer: keypair,
  transaction: tx,
  options: { showEffects: true, showBalanceChanges: true },
});

if (result.effects.status.status !== 'success') {
  console.error('❌ Failed:', result.effects.status.error);
  process.exit(1);
}

console.log();
console.log('━'.repeat(60));
console.log('  ✓ WITHDRAWN');
console.log('━'.repeat(60));
console.log();
console.log(`  Digest: ${result.digest}`);
console.log(`  https://testnet.suivision.xyz/txblock/${result.digest}`);
console.log('━'.repeat(60));
