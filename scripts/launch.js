// launch.js — full two-transaction token launch via Node
//
// Tx 1: Publish the patched coin_template bytecode. Template init runs,
//        mints TreasuryCap<NEW_TOKEN> and transfers it to sender.
// Tx 2: Configure — calls create_and_return<NEW_TOKEN> with payouts + 2 SUI
//        launch fee, optionally chains a dev-buy, then shares the curve.
//
// Usage:
//   node launch.js                          # launch with defaults
//   node launch.js --name "Moon Coin" --symbol MOON --buy 0.5
//   node launch.js --help

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Transaction } from '@mysten/sui/transactions';
import { fromHex, toHex } from '@mysten/sui/utils';
import * as bytecodeTemplate from '@mysten/move-bytecode-template';

import {
  client, loadKeypair, PACKAGE_ID, fmtSui, fmtTokens,
} from './config.js';

// ---------- CLI args ----------
const args = process.argv.slice(2);
const get = (flag, def) => {
  const i = args.indexOf(flag);
  return i !== -1 ? args[i + 1] : def;
};
if (args.includes('--help')) {
  console.log(`
  node launch.js [options]

  --name       "Token Name"        (default: "Test Launch")
  --symbol     SYMBOL              (default: "TEST") max 5 chars, uppercase
  --desc       "Description"       (default: generic)
  --icon       https://...         (default: placeholder)
  --buy        SUI amount          (default: 0, no dev-buy)
  --payout     address:bps,...     (default: 100% to your wallet)
               e.g. --payout 0xABC:7000,0xDEF:3000

  Costs: ~0.06 SUI gas (Tx1) + ~0.01 SUI gas (Tx2) + 2 SUI launch fee + dev-buy
`);
  process.exit(0);
}

const tokenName = get('--name', 'Test Launch');
const tokenSymbol = get('--symbol', 'TLAUNCH').toUpperCase();
const tokenDesc = get('--desc', `${tokenName} — launched on SuiPump`);
const tokenIcon = get('--icon', 'https://suipump.test/icon-placeholder.png');
const devBuySui = parseFloat(get('--buy', '0'));
const payoutArg = get('--payout', null);

// Validate symbol — must be 1-5 uppercase letters, valid Move identifier
if (!/^[A-Z][A-Z0-9_]{0,4}$/.test(tokenSymbol)) {
  console.error(`Symbol "${tokenSymbol}" invalid — must be 1-5 uppercase letters/digits.`);
  process.exit(1);
}

// Module name = lowercase symbol (used as Move module identifier)
const moduleName = tokenSymbol.toLowerCase();

const keypair = loadKeypair();
const address = keypair.toSuiAddress();

const LAUNCH_FEE_MIST = 2_000_000_000n;
const MIST_PER_SUI = 1_000_000_000n;

// ---------- Payout parsing ----------
function parsePayouts(arg, fallback) {
  if (!arg) return { addresses: [fallback], bps: [10_000] };
  const entries = arg.split(',').map(e => e.trim());
  const addresses = [], bps = [];
  for (const entry of entries) {
    const [addr, b] = entry.split(':');
    if (!addr || !b) throw new Error(`Bad payout entry: ${entry}`);
    addresses.push(addr.trim());
    bps.push(parseInt(b.trim(), 10));
  }
  const sum = bps.reduce((a, b) => a + b, 0);
  if (sum !== 10_000) throw new Error(`Payout bps sum to ${sum}, must be 10000`);
  return { addresses, bps };
}

const { addresses: payoutAddrs, bps: payoutBps } = parsePayouts(payoutArg, address);

// ---------- Load template bytecode ----------
const __dir = dirname(fileURLToPath(import.meta.url));
const templatePath = join(__dir, '..', 'coin-template', 'build',
  'coin_template', 'bytecode_modules', 'template.mv');

let templateBytes;
try {
  templateBytes = readFileSync(templatePath);
} catch {
  console.error(`
  Template bytecode not found at:
    ${templatePath}

  Run this first:
    cd C:\\Users\\User\\Desktop\\suipump\\coin-template
    sui move build
`);
  process.exit(1);
}

// ---------- BCS encode helpers for update_constants ----------
// Sui Move constants are stored as BCS-encoded values in the bytecode.
// update_constants takes: newValueBCS, existingValueBCS, type.
// For vector<u8>, the BCS encoding is: ULEB128(length) ++ bytes.
function bcsBytes(str) {
  const buf = Buffer.from(str, 'utf8');
  // ULEB128-encode the length (for strings ≤ 127 bytes, this is just the byte)
  if (buf.length > 127) throw new Error(`Constant "${str}" too long for single-byte ULEB128`);
  return Uint8Array.from([buf.length, ...buf]);
}

// DECIMALS is a u8 constant — BCS is just the byte value
function bcsU8(n) { return Uint8Array.from([n]); }

console.log('━'.repeat(60));
console.log('  SUIPUMP — launch');
console.log('━'.repeat(60));
console.log(`  name:     ${tokenName}`);
console.log(`  symbol:   ${tokenSymbol}`);
console.log(`  module:   ${moduleName}`);
console.log(`  payouts:  ${payoutAddrs.map((a, i) => `${a.slice(0,8)}... ${payoutBps[i] / 100}%`).join(', ')}`);
console.log(`  dev-buy:  ${devBuySui > 0 ? devBuySui + ' SUI' : 'none'}`);
console.log();

// ---------- Tx 1: Patch bytecode + publish ----------
console.log('  [1/2] Patching and publishing coin module…');

// In Node, the WASM module initialises automatically — no init() call needed.
// (init is only required in browser/bundler environments.)
const { update_identifiers, update_constants } = bytecodeTemplate;

// Patch identifiers: TEMPLATE → SYMBOL (uppercase), template → modulename (lowercase)
let patched = update_identifiers(new Uint8Array(templateBytes), {
  'TEMPLATE': tokenSymbol,
  'template': moduleName,
});

// Patch constants (existing values must match what's in the compiled template)
// Type string format: 'Vector(U8)' for vector<u8>, 'U8' for u8
patched = update_constants(patched,
  bcsBytes(tokenSymbol),
  bcsBytes('TMPL'),
  'Vector(U8)'
);
patched = update_constants(patched,
  bcsBytes(tokenName),
  bcsBytes('Template Coin'),
  'Vector(U8)'
);
patched = update_constants(patched,
  bcsBytes(tokenDesc),
  bcsBytes('Template description placeholder that is intentionally long to accommodate real token descriptions.'),
  'Vector(U8)'
);
patched = update_constants(patched,
  bcsBytes(tokenIcon),
  bcsBytes('https://suipump.test/icon-placeholder.png'),
  'Vector(U8)'
);

const tx1 = new Transaction();
const [upgradeCap] = tx1.publish({
  modules: [Array.from(patched)],
  dependencies: [
    '0x0000000000000000000000000000000000000000000000000000000000000001',
    '0x0000000000000000000000000000000000000000000000000000000000000002',
  ],
});
// UpgradeCap must be consumed — transfer to sender (or burn if immutable desired)
tx1.transferObjects([upgradeCap], address);

const res1 = await client.signAndExecuteTransaction({
  signer: keypair,
  transaction: tx1,
  options: { showEffects: true, showObjectChanges: true },
});

if (res1.effects.status.status !== 'success') {
  console.error('❌ Tx 1 failed:', res1.effects.status.error);
  process.exit(1);
}

console.log(`  ✓ published: ${res1.digest}`);

// Extract new package ID and TreasuryCap object ID from effects
const published = res1.objectChanges.find(c => c.type === 'published');
const newPackageId = published.packageId;
const newTokenType = `${newPackageId}::${moduleName}::${tokenSymbol}`;

const treasuryCapObj = res1.objectChanges.find(c =>
  c.type === 'created' &&
  c.objectType?.includes('TreasuryCap')
);

if (!treasuryCapObj) {
  console.error('❌ TreasuryCap not found in Tx 1 effects. Objects created:');
  res1.objectChanges.filter(c => c.type === 'created').forEach(c =>
    console.error('  ', c.objectType, c.objectId)
  );
  process.exit(1);
}

const treasuryCapId = treasuryCapObj.objectId;
console.log(`  package:     ${newPackageId}`);
console.log(`  token type:  ${newTokenType}`);
console.log(`  treasury:    ${treasuryCapId}`);
console.log();

// ---------- Tx 2: Configure curve ----------
console.log('  [2/2] Configuring curve (launch fee + payouts' +
  (devBuySui > 0 ? ` + ${devBuySui} SUI dev-buy` : '') + ')…');

// Wait briefly for Tx 1 to be indexed before referencing its outputs
await new Promise(r => setTimeout(r, 3000));

const tx2 = new Transaction();

// Split the launch fee coin from gas
const [launchFeeCoin] = tx2.splitCoins(tx2.gas, [tx2.pure.u64(LAUNCH_FEE_MIST)]);

// Call create_and_return — returns (Curve<T>, CreatorCap)
const [curve, cap] = tx2.moveCall({
  target: `${PACKAGE_ID}::bonding_curve::create_and_return`,
  typeArguments: [newTokenType],
  arguments: [
    tx2.object(treasuryCapId),
    launchFeeCoin,
    tx2.pure.string(tokenName),
    tx2.pure.string(tokenSymbol),
    tx2.pure(bcs_vector_address(payoutAddrs)),
    tx2.pure(bcs_vector_u64(payoutBps)),
  ],
});

// Dev-buy: buy directly on the unshared curve (more efficient — avoids
// shared-object sequence point; curve is still owned by this PTB)
let tokensResult = null;
if (devBuySui > 0) {
  const devBuyMist = BigInt(Math.floor(devBuySui * 1e9));
  const [devPayment] = tx2.splitCoins(tx2.gas, [tx2.pure.u64(devBuyMist)]);
  const [tokens, refund] = tx2.moveCall({
    target: `${PACKAGE_ID}::bonding_curve::buy`,
    typeArguments: [newTokenType],
    arguments: [curve, devPayment, tx2.pure.u64(0)],
  });
  tokensResult = tokens;
  tx2.transferObjects([refund], address);
  tx2.transferObjects([tokens], address);
}

// Share the curve — makes it publicly tradeable
tx2.moveCall({
  target: `${PACKAGE_ID}::bonding_curve::share_curve`,
  typeArguments: [newTokenType],
  arguments: [curve],
});

// Transfer CreatorCap to sender
tx2.transferObjects([cap], address);

const res2 = await client.signAndExecuteTransaction({
  signer: keypair,
  transaction: tx2,
  options: { showEffects: true, showObjectChanges: true, showEvents: true },
});

if (res2.effects.status.status !== 'success') {
  console.error('❌ Tx 2 failed:', res2.effects.status.error);
  console.error('  Your TreasuryCap is still in your wallet:', treasuryCapId);
  console.error('  You can retry Tx 2 manually.');
  process.exit(1);
}

console.log(`  ✓ configured: ${res2.digest}`);

// Find new curve ID from events
const curveEvent = res2.events?.find(e => e.type?.includes('CurveCreated'));
const newCurveId = curveEvent?.parsedJson?.curve_id;
const creatorCapObj = res2.objectChanges?.find(c =>
  c.type === 'created' && c.objectType?.includes('CreatorCap')
);

console.log();
console.log('━'.repeat(60));
console.log('  ✓ LAUNCH COMPLETE');
console.log('━'.repeat(60));
console.log(`  token:       ${tokenName} ($${tokenSymbol})`);
console.log(`  package:     ${newPackageId}`);
console.log(`  curve:       ${newCurveId ?? '(check Tx 2 effects)'}`);
console.log(`  creator cap: ${creatorCapObj?.objectId ?? '(check wallet)'}`);
console.log(`  tx1:         https://testnet.suivision.xyz/txblock/${res1.digest}`);
console.log(`  tx2:         https://testnet.suivision.xyz/txblock/${res2.digest}`);
console.log();
console.log('  Add to constants.js to trade this token:');
console.log(`    PACKAGE_ID = '${newPackageId}'`);
console.log(`    CURVE_ID   = '${newCurveId}'`);
console.log(`    TOKEN_TYPE = '${newTokenType}'`);

// ---------- BCS helpers ----------
// These encode JavaScript arrays into the BCS format that Move PTB expects
// for vector<address> and vector<u64> pure arguments.
function bcs_vector_address(addrs) {
  // vector<address>: ULEB128(length) ++ each address as 32 bytes
  const count = addrs.length;
  const out = [count]; // length (single byte for ≤127)
  for (const a of addrs) {
    const bytes = fromHex(a.replace('0x', '').padStart(64, '0'));
    out.push(...bytes);
  }
  return new Uint8Array(out);
}

function bcs_vector_u64(nums) {
  // vector<u64>: ULEB128(length) ++ each u64 as 8 bytes little-endian
  const count = nums.length;
  const buf = Buffer.alloc(1 + count * 8);
  buf[0] = count;
  for (let i = 0; i < count; i++) {
    buf.writeBigUInt64LE(BigInt(nums[i]), 1 + i * 8);
  }
  return new Uint8Array(buf);
}
