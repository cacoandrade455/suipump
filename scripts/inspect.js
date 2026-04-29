// Read-only inspection of the curve. Run this first to confirm everything is wired up.
// Usage: node inspect.js

import { client, loadKeypair, PACKAGE_ID, CURVE_ID, TOKEN_TYPE, fmtSui, fmtTokens } from './config.js';
import { Transaction } from '@mysten/sui/transactions';
import { bcs } from '@mysten/sui/bcs';

const keypair = loadKeypair();
const address = keypair.toSuiAddress();

console.log('━'.repeat(60));
console.log('  SUIPUMP — curve inspection');
console.log('━'.repeat(60));
console.log(`  wallet:   ${address}`);
console.log(`  package:  ${PACKAGE_ID}`);
console.log(`  curve:    ${CURVE_ID}`);
console.log();

// --- Wallet balance ---
const balance = await client.getBalance({ owner: address });
console.log(`  balance:  ${fmtSui(balance.totalBalance)}`);
console.log();

// --- Curve object state ---
const curveObj = await client.getObject({
  id: CURVE_ID,
  options: { showContent: true, showType: true },
});

if (curveObj.error) {
  console.error('❌ Could not fetch curve:', curveObj.error);
  process.exit(1);
}

const fields = curveObj.data.content.fields;
console.log('  Curve state:');
console.log(`    name:            ${fields.name}`);
console.log(`    symbol:          ${fields.symbol}`);
console.log(`    creator:         ${fields.creator}`);
console.log(`    graduated:       ${fields.graduated}`);
console.log(`    sui_reserve:     ${fmtSui(fields.sui_reserve)}`);
console.log(`    token_reserve:   ${fmtTokens(fields.token_reserve)} ${fields.symbol}`);
console.log(`    creator_fees:    ${fmtSui(fields.creator_fees)}`);
console.log(`    protocol_fees:   ${fmtSui(fields.protocol_fees)}`);
console.log();

// --- Live price via devInspect (simulates a Move call without gas) ---
const tx = new Transaction();
tx.moveCall({
  target: `${PACKAGE_ID}::bonding_curve::current_price`,
  typeArguments: [TOKEN_TYPE],
  arguments: [tx.object(CURVE_ID)],
});

const result = await client.devInspectTransactionBlock({
  transactionBlock: tx,
  sender: address,
});

if (result.effects.status.status === 'success') {
  const returnBytes = new Uint8Array(result.results[0].returnValues[0][0]);
  const priceMist = Number(bcs.u64().parse(returnBytes));
  // Price is in MIST per whole-token (6-decimals), so per-smallest-unit is priceMist / 1e6.
  console.log(`  current price:   ${priceMist} MIST per whole token`);
  console.log(`                   (${(priceMist / 1e9).toFixed(9)} SUI per token)`);
} else {
  console.log('  (could not fetch price via devInspect)');
}
console.log();
console.log('  ✓ curve is live and readable');
