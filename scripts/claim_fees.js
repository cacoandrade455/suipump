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

// All package versions — fees live on curves from every version.
const PACKAGE_ID_V4 = '0x2154486dcf503bd3e8feae4fb913e862f7e2bbf4489769aff63978f55d55b4a8';
const PACKAGE_ID_V5 = '0x785c0604cb6c60a8547501e307d2b0ca7a586ff912c8abff4edfb88db65b7236';
const PACKAGE_ID_V6 = '0x21d5b1284d5f1d4d14214654f414ffca20c757ee9f9db7701d3ffaaac62cd768';
const PACKAGE_ID_V7 = '0xfb8f3f3e4e8d53130ac140906eebea6b6740bfaf0c971aec607fbc723be951f0';
const ALL_PACKAGE_IDS = [PACKAGE_ID_V4, PACKAGE_ID_V5, PACKAGE_ID_V6, PACKAGE_ID_V7];

// V7+ has a separate airdrop fee bucket claimed via claim_airdrop_fees.
const isV7 = (pkg) => pkg === PACKAGE_ID_V7;

const keypair = loadKeypair();
const address = keypair.toSuiAddress();
const specificCurve = process.argv[2] ?? null;

console.log('━'.repeat(60));
console.log('  SUIPUMP — claim all protocol + airdrop fees');
console.log('━'.repeat(60));
console.log(`  wallet:     ${address}`);
console.log(`  admin cap:  ${ADMIN_CAP_ID}`);
console.log();

// --- Fetch all curve IDs from CurveCreated events across ALL packages ---
let curveIds = [];

if (specificCurve) {
  curveIds = [specificCurve];
  console.log(`  Mode: single curve`);
} else {
  console.log(`  Fetching all curves from CurveCreated events (V4-V7)...`);
  for (const pkg of ALL_PACKAGE_IDS) {
    try {
      const events = await client.queryEvents({
        query: { MoveEventType: `${pkg}::bonding_curve::CurveCreated` },
        limit: 1000,
        order: 'ascending',
      });
      const ids = events.data.map(e => e.parsedJson?.curve_id).filter(Boolean);
      curveIds.push(...ids);
    } catch {
      // package may have no events — skip
    }
  }
  // de-dup
  curveIds = [...new Set(curveIds)];
  console.log(`  Found ${curveIds.length} curve(s) across all versions`);
}

console.log();

// --- Check each curve for protocol + airdrop fees ---
let totalClaimed = 0n;
let claimCount = 0;

// Resolve which package a curve belongs to from its type string.
function resolvePackageId(typeStr) {
  if (typeStr?.includes(PACKAGE_ID_V7)) return PACKAGE_ID_V7;
  if (typeStr?.includes(PACKAGE_ID_V6)) return PACKAGE_ID_V6;
  if (typeStr?.includes(PACKAGE_ID_V5)) return PACKAGE_ID_V5;
  if (typeStr?.includes(PACKAGE_ID_V4)) return PACKAGE_ID_V4;
  return PACKAGE_ID;
}

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
    const typeStr = curveObj.data.type ?? '';
    const pkgId = resolvePackageId(typeStr);
    const protocolFees = BigInt(fields.protocol_fees ?? 0);
    // V7+ curves have a separate airdrop_fees balance.
    const airdropFees = BigInt(fields.airdrop_fees ?? 0);

    console.log(`  ${fields.name} ($${fields.symbol})`);
    console.log(`    curve:          ${curveId.slice(0, 20)}...`);
    console.log(`    package:        ${pkgId.slice(0, 10)}... (${isV7(pkgId) ? 'v7' : 'legacy'})`);
    console.log(`    protocol_fees:  ${fmtSui(protocolFees)}`);
    if (isV7(pkgId)) {
      console.log(`    airdrop_fees:   ${fmtSui(airdropFees)}`);
    }

    if (protocolFees === 0n && airdropFees === 0n) {
      console.log(`    → nothing to claim, skipping`);
      console.log();
      continue;
    }

    const match = typeStr.match(/Curve<(.+)>$/);
    if (!match) {
      console.log(`    ⚠ Could not parse token type — skipping`);
      console.log();
      continue;
    }
    const tokenType = match[1];

    // Single PTB: claim protocol fees, and (V7+) airdrop fees too.
    const tx = new Transaction();
    const coinsToTransfer = [];

    if (protocolFees > 0n) {
      const suiOut = tx.moveCall({
        target: `${pkgId}::bonding_curve::claim_protocol_fees`,
        typeArguments: [tokenType],
        arguments: [tx.object(ADMIN_CAP_ID), tx.object(curveId)],
      });
      coinsToTransfer.push(suiOut);
    }
    if (isV7(pkgId) && airdropFees > 0n) {
      const airdropOut = tx.moveCall({
        target: `${pkgId}::bonding_curve::claim_airdrop_fees`,
        typeArguments: [tokenType],
        arguments: [tx.object(ADMIN_CAP_ID), tx.object(curveId)],
      });
      coinsToTransfer.push(airdropOut);
    }

    const claimingNow = protocolFees + (isV7(pkgId) ? airdropFees : 0n);
    console.log(`    → claiming ${fmtSui(claimingNow)}...`);
    tx.transferObjects(coinsToTransfer, address);

    const result = await client.signAndExecuteTransaction({
      signer: keypair,
      transaction: tx,
      options: { showEffects: true },
    });

    if (result.effects.status.status === 'success') {
      console.log(`    ✓ Claimed! digest: ${result.digest}`);
      console.log(`    https://testnet.suivision.xyz/txblock/${result.digest}`);
      totalClaimed += claimingNow;
      claimCount++;
    } else {
      console.log(`    ❌ Failed: ${result.effects.status.error}`);
    }

    console.log();
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
