// Execute a real buy on the curve. Uses 0.1 SUI by default.
// Usage: node buy.js [sui_amount]
//   sui_amount: whole SUI to spend, e.g. 0.5. Defaults to 0.1.

import { Transaction } from '@mysten/sui/transactions';
import {
  client, loadKeypair, PACKAGE_ID, CURVE_ID, TOKEN_TYPE, fmtSui, fmtTokens
} from './config.js';

const keypair = loadKeypair();
const address = keypair.toSuiAddress();

const suiAmount = parseFloat(process.argv[2] ?? '0.1');
if (!Number.isFinite(suiAmount) || suiAmount <= 0) {
  console.error('Invalid amount. Example: node buy.js 0.5');
  process.exit(1);
}
const mistAmount = Math.floor(suiAmount * 1e9);

console.log('━'.repeat(60));
console.log(`  SUIPUMP — buying with ${suiAmount} SUI`);
console.log('━'.repeat(60));
console.log(`  wallet:   ${address}`);
console.log(`  curve:    ${CURVE_ID}`);
console.log();

const tx = new Transaction();

// 1. Split the exact amount we want to spend off the gas coin.
//    Sui's programmable transactions let us slice coins mid-tx — no need
//    to merge/split ahead of time.
const [paymentCoin] = tx.splitCoins(tx.gas, [tx.pure.u64(mistAmount)]);

// 2. Call buy(). Returns (Coin<T>, Coin<SUI>) — tokens + refund.
const [tokens, refund] = tx.moveCall({
  target: `${PACKAGE_ID}::bonding_curve::buy`,
  typeArguments: [TOKEN_TYPE],
  arguments: [
    tx.object(CURVE_ID),
    paymentCoin,
    tx.pure.u64(0),  // min_tokens_out = 0 (no slippage protection for this test)
  ],
});

// 3. Transfer both returned coins to ourselves.
tx.transferObjects([tokens, refund], address);

console.log('  Submitting transaction...');
const result = await client.signAndExecuteTransaction({
  signer: keypair,
  transaction: tx,
  options: {
    showEffects: true,
    showEvents: true,
    showBalanceChanges: true,
    showObjectChanges: true,
  },
});

if (result.effects.status.status !== 'success') {
  console.error('❌ Transaction failed:');
  console.error(result.effects.status.error);
  process.exit(1);
}

console.log(`  ✓ success`);
console.log(`  digest:   ${result.digest}`);
console.log(`  explorer: https://testnet.suivision.xyz/txblock/${result.digest}`);
console.log();

// --- Decode the TokensPurchased event ---
const evt = result.events.find(e => e.type.endsWith('::bonding_curve::TokensPurchased'));
if (evt) {
  const p = evt.parsedJson;
  console.log('  TokensPurchased event:');
  console.log(`    sui_in:         ${fmtSui(p.sui_in)}`);
  console.log(`    tokens_out:     ${fmtTokens(p.tokens_out)}`);
  console.log(`    creator_fee:    ${fmtSui(p.creator_fee)}  (0.40% of volume)`);
  console.log(`    protocol_fee:   ${fmtSui(p.protocol_fee)}  (0.50% of volume)`);
  console.log(`    lp_fee:         ${fmtSui(p.lp_fee)}  (0.10% of volume, stays in curve)`);
  console.log(`    new reserve:    ${fmtSui(p.new_sui_reserve)}`);
  console.log(`    new tokens left:${fmtTokens(p.new_token_reserve)}`);
}
console.log();

// --- Gas + balance changes ---
const gas = result.effects.gasUsed;
const gasCost = BigInt(gas.computationCost) + BigInt(gas.storageCost) - BigInt(gas.storageRebate);
console.log(`  gas cost: ${fmtSui(gasCost.toString())}`);
