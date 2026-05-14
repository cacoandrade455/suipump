// buy.js — Execute a real buy on the curve.
// Automatically detects v4 vs v5/v6 package and passes correct args.
//
// Usage: node buy.js [sui_amount] [curve_id]
//   sui_amount: whole SUI to spend, e.g. 0.5. Defaults to 0.1.
//   curve_id:   optional — overrides CURVE_ID from config

import { Transaction } from '@mysten/sui/transactions';
import {
  client, loadKeypair, PACKAGE_ID, CURVE_ID, TOKEN_TYPE, fmtSui, fmtTokens
} from './config.js';

// V4 package ID — buy() on v4 has no referral/clock args
const PACKAGE_ID_V4 = '0x2154486dcf503bd3e8feae4fb913e862f7e2bbf4489769aff63978f55d55b4a8';
const SUI_CLOCK_ID  = '0x0000000000000000000000000000000000000000000000000000000000000006';

const keypair = loadKeypair();
const address = keypair.toSuiAddress();

const suiAmount = parseFloat(process.argv[2] ?? '0.1');
const curveIdArg = process.argv[3] ?? CURVE_ID;

if (!Number.isFinite(suiAmount) || suiAmount <= 0) {
  console.error('Invalid amount. Example: node buy.js 0.5');
  process.exit(1);
}

const mistAmount = Math.floor(suiAmount * 1e9);
const isV4 = PACKAGE_ID === PACKAGE_ID_V4;

console.log('━'.repeat(60));
console.log(`  SUIPUMP — buying with ${suiAmount} SUI`);
console.log('━'.repeat(60));
console.log(`  wallet:   ${address}`);
console.log(`  curve:    ${curveIdArg}`);
console.log(`  package:  ${PACKAGE_ID} (${isV4 ? 'v4' : 'v5/v6'})`);
console.log();

// Fetch curve object for sharedObjectRef
const curveObj = await client.getObject({ id: curveIdArg, options: { showOwner: true } });
const initialSharedVersion = curveObj.data?.owner?.Shared?.initial_shared_version;
if (!initialSharedVersion) {
  console.error('❌ Could not fetch curve shared version');
  process.exit(1);
}

const tx = new Transaction();

const curveRef = tx.sharedObjectRef({
  objectId: curveIdArg,
  initialSharedVersion,
  mutable: true,
});

const [paymentCoin] = tx.splitCoins(tx.gas, [tx.pure.u64(mistAmount)]);

// Build args based on package version
// v4: buy(curve, payment, min_tokens_out)
// v5/v6: buy(curve, payment, min_tokens_out, referral: Option<address>, clock)
const buyArgs = isV4
  ? [curveRef, paymentCoin, tx.pure.u64(0)]
  : [curveRef, paymentCoin, tx.pure.u64(0), tx.pure.option('address', null), tx.object(SUI_CLOCK_ID)];

const [tokens, refund] = tx.moveCall({
  target: `${PACKAGE_ID}::bonding_curve::buy`,
  typeArguments: [TOKEN_TYPE],
  arguments: buyArgs,
});

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

const evt = result.events.find(e => e.type.endsWith('::bonding_curve::TokensPurchased'));
if (evt) {
  const p = evt.parsedJson;
  console.log('  TokensPurchased event:');
  console.log(`    sui_in:          ${fmtSui(p.sui_in)}`);
  console.log(`    tokens_out:      ${fmtTokens(p.tokens_out)}`);
  console.log(`    creator_fee:     ${fmtSui(p.creator_fee)}`);
  console.log(`    protocol_fee:    ${fmtSui(p.protocol_fee)}`);
  console.log(`    lp_fee:          ${fmtSui(p.lp_fee)}`);
  console.log(`    referral_fee:    ${fmtSui(p.referral_fee ?? 0)}`);
  console.log(`    new reserve:     ${fmtSui(p.new_sui_reserve)}`);
  console.log(`    new tokens left: ${fmtTokens(p.new_token_reserve)}`);
}
console.log();

const gas = result.effects.gasUsed;
const gasCost = BigInt(gas.computationCost) + BigInt(gas.storageCost) - BigInt(gas.storageRebate);
console.log(`  gas cost: ${fmtSui(gasCost.toString())}`);
