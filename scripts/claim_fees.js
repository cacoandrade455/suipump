// claim_fees.js
// Claims accumulated protocol fees from ALL SuiPump curves via AdminCap.
// Queries every CurveCreated event, checks each curve for protocol fees,
// and claims from any that have a non-zero balance.
//
// Usage:
//   node claim_fees.js              — claims from all curves
//   node claim_fees.js <CURVE_ID>   — claims from a specific curve only

import { client, loadKeypair, PACKAGE_ID, ADMIN_CAP_ID, fmtSui } from './config.js';
import { Transaction } from '@mysten/sui/transactions';

const keypair = loadKeypair();
const address = keypair.toSuiAddress();
const specificCurve = process.argv[2] ?? null;

console.log('━'.repeat(60));
console.log('  SUIPUMP — claim all protocol fees');
console.log('━'.repeat(60));
console.log(`  wallet:     ${address}`);
console.log(`  admin cap:  ${ADMIN_CAP_ID}`);
console.log();

// --- Fetch all curve IDs from CurveCreated events ---
let curveIds = [];

if (specificCurve) {
  curveIds = [specificCurve];
  console.log(`  Mode: single curve`);
} else {
  console.log(`  Fetching all curves from CurveCreated events...`);
  const events = await client.queryEvents({
    query: { MoveEventType: `${PACKAGE_ID}::bonding_curve::CurveCreated` },
    limit: 100,
    order: 'ascending',
  });
  curveIds = events.data.map(e => e.parsedJson?.curve_id).filter(Boolean);
  console.log(`  Found ${curveIds.length} curve(s)`);
}

console.log();

// --- Check each curve for protocol fees ---
let totalClaimed = 0n;
let claimCount = 0;

for (const curveId of curveIds) {
  try {
    const curveObj = await client.getObject({
      id: curveId,
      options: { showContent: true, showType: true },
    });

    if (curveObj.error || !curveObj.data?.content?.fields) {
      console.log(`  ⚠ Could not fetch curve ${curveId.slice(0, 12)}... — skipping`);
      continue;
    }

    const fields = curveObj.data.content.fields;
    const protocolFees = BigInt(fields.protocol_fees);

    console.log(`  ${fields.name} ($${fields.symbol})`);
    console.log(`    curve:          ${curveId.slice(0, 20)}...`);
    console.log(`    protocol_fees:  ${fmtSui(protocolFees)}`);

    if (protocolFees === 0n) {
      console.log(`    → nothing to claim, skipping`);
      console.log();
      continue;
    }

    // Extract token type from curve object type string
    const typeStr = curveObj.data.type ?? '';
    const match = typeStr.match(/Curve<(.+)>$/);
    if (!match) {
      console.log(`    ⚠ Could not parse token type — skipping`);
      console.log();
      continue;
    }
    const tokenType = match[1];

    console.log(`    → claiming ${fmtSui(protocolFees)}...`);

    // Build and execute claim transaction
    const tx = new Transaction();
    const suiOut = tx.moveCall({
      target: `${PACKAGE_ID}::bonding_curve::claim_protocol_fees`,
      typeArguments: [tokenType],
      arguments: [
        tx.object(ADMIN_CAP_ID),
        tx.object(curveId),
      ],
    });
    tx.transferObjects([suiOut], address);

    const result = await client.signAndExecuteTransaction({
      signer: keypair,
      transaction: tx,
      options: { showEffects: true },
    });

    if (result.effects.status.status === 'success') {
      console.log(`    ✓ Claimed! digest: ${result.digest}`);
      console.log(`    https://testnet.suivision.xyz/txblock/${result.digest}`);
      totalClaimed += protocolFees;
      claimCount++;
    } else {
      console.log(`    ❌ Failed: ${result.effects.status.error}`);
    }

    console.log();

    // Small delay between transactions to avoid rate limiting
    await new Promise(r => setTimeout(r, 1000));

  } catch (err) {
    console.log(`  ❌ Error on curve ${curveId.slice(0, 12)}...: ${err.message || String(err)}`);
    console.log();
  }
}

// --- Summary ---
console.log('━'.repeat(60));
console.log(`  DONE — claimed from ${claimCount} curve(s)`);
console.log(`  Total claimed: ${fmtSui(totalClaimed)}`);
console.log();

const newBalance = await client.getBalance({ owner: address });
console.log(`  Wallet balance: ${fmtSui(newBalance.totalBalance)}`);
console.log('━'.repeat(60));
