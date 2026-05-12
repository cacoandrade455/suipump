// launch_test.js
// Launches a test token against the throwaway suipump_test package.
// Buys 11 SUI worth automatically so the curve is ready to graduate.
//
// Usage:
//   node launch_test.js
//
// Prerequisites:
//   - deploy_test.js run and config.js filled in
//   - coin-template compiled (../coin-template/build/ exists)
//   - Wallet has ~20 SUI testnet balance

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Transaction } from '@mysten/sui/transactions';
import wasmInit, * as bytecodeTemplate from '@mysten/move-bytecode-template';
import { client, loadKeypair, TEST_PACKAGE_ID, fmtSui } from './config.js';

if (TEST_PACKAGE_ID === 'FILL_AFTER_DEPLOY') {
  console.error('❌ Fill in TEST_PACKAGE_ID in config.js first.');
  console.error('   Run: node deploy_test.js');
  process.exit(1);
}

const LAUNCH_FEE_MIST = 2_000_000_000n;
const DEV_BUY_SUI = 11;

const keypair = loadKeypair();
const address = keypair.toSuiAddress();

const __dir = dirname(fileURLToPath(import.meta.url));
const templatePath = join(__dir, '..', 'coin-template', 'build', 'coin_template', 'bytecode_modules', 'template.mv');

console.log('━'.repeat(60));
console.log('  SUIPUMP TEST — launch test token');
console.log('━'.repeat(60));
console.log(`  wallet:   ${address}`);
console.log(`  package:  ${TEST_PACKAGE_ID}`);
console.log(`  dev-buy:  ${DEV_BUY_SUI} SUI`);
console.log();

// WASM init — needed for move-bytecode-template in Node
// In Node the WASM module auto-initialises, but we call init explicitly to be safe
let wasmReady = false;
try {
  await wasmInit();
  wasmReady = true;
} catch {
  // Already initialised or not needed in this environment
  wasmReady = true;
}

// Load template bytecode
let templateBytes;
try {
  templateBytes = readFileSync(templatePath);
} catch {
  console.error(`❌ Template bytecode not found: ${templatePath}`);
  console.error('   Run: cd ../coin-template && sui move build');
  process.exit(1);
}

// BCS helpers
function uleb128(n) {
  const bytes = [];
  do {
    let byte = n & 0x7f;
    n >>>= 7;
    if (n !== 0) byte |= 0x80;
    bytes.push(byte);
  } while (n !== 0);
  return bytes;
}

function bcsBytes(str) {
  const buf = Buffer.from(str, 'utf8');
  return Uint8Array.from([...uleb128(buf.length), ...buf]);
}

function bcsVectorAddress(addrs) {
  const out = [addrs.length];
  for (const a of addrs) {
    const hex = a.replace('0x', '').padStart(64, '0');
    for (let i = 0; i < 64; i += 2) out.push(parseInt(hex.slice(i, i + 2), 16));
  }
  return new Uint8Array(out);
}

function bcsVectorU64(nums) {
  const buf = new DataView(new ArrayBuffer(1 + nums.length * 8));
  buf.setUint8(0, nums.length);
  nums.forEach((n, i) => buf.setBigUint64(1 + i * 8, BigInt(n), true));
  return new Uint8Array(buf.buffer);
}

// Patch bytecode — note dex:deepbook encoded in description
const PLACEHOLDER_NAME = 'Template Coin';
const PLACEHOLDER_SYM  = 'TMPL';
const PLACEHOLDER_DESC = 'Template description placeholder that is intentionally long to accommodate real token descriptions.';
const PLACEHOLDER_ICON = 'https://suipump.test/icon-placeholder.png';

const TOKEN_NAME = 'DeepBook Test';
const TOKEN_SYM  = 'DTEST';
const TOKEN_DESC = 'Throwaway token for DeepBook graduation test||{"dex":"deepbook"}';
const TOKEN_ICON = 'https://i.imgur.com/qS6SGc7.jpeg';

const safeName = TOKEN_NAME.slice(0, PLACEHOLDER_NAME.length).padEnd(PLACEHOLDER_NAME.length, ' ');
const safeSym  = TOKEN_SYM.slice(0, PLACEHOLDER_SYM.length).padEnd(PLACEHOLDER_SYM.length, ' ');
const safeDesc = TOKEN_DESC.slice(0, PLACEHOLDER_DESC.length).padEnd(PLACEHOLDER_DESC.length, ' ');
const safeIcon = TOKEN_ICON.slice(0, PLACEHOLDER_ICON.length).padEnd(PLACEHOLDER_ICON.length, ' ');

let patched = bytecodeTemplate.update_constants(templateBytes, bcsBytes(safeName), bcsBytes(PLACEHOLDER_NAME), 'Vector(U8)');
patched = bytecodeTemplate.update_constants(patched, bcsBytes(safeSym), bcsBytes(PLACEHOLDER_SYM), 'Vector(U8)');
patched = bytecodeTemplate.update_constants(patched, bcsBytes(safeDesc), bcsBytes(PLACEHOLDER_DESC), 'Vector(U8)');
patched = bytecodeTemplate.update_constants(patched, bcsBytes(safeIcon), bcsBytes(PLACEHOLDER_ICON), 'Vector(U8)');

// Tx 1: Publish coin module
console.log('  [1/2] Publishing coin module…');

const tx1 = new Transaction();
const [upgradeCap] = tx1.publish({ modules: [[...patched]], dependencies: ['0x1', '0x2'] });
tx1.transferObjects([upgradeCap], address);

const res1 = await client.signAndExecuteTransaction({
  signer: keypair,
  transaction: tx1,
  options: { showEffects: true, showObjectChanges: true },
});

if (res1.effects.status.status !== 'success') {
  console.error('❌ Tx1 failed:', res1.effects.status.error);
  process.exit(1);
}

const treasuryCapObj = res1.objectChanges?.find(c =>
  c.type === 'created' && c.objectType?.includes('TreasuryCap')
);
if (!treasuryCapObj) {
  console.error('❌ TreasuryCap not found in Tx1');
  process.exit(1);
}

const treasuryCapId = treasuryCapObj.objectId;
const newTokenType = treasuryCapObj.objectType.match(/<(.+)>/)?.[1];
console.log(`  ✓ published: ${res1.digest}`);
console.log(`  token type:  ${newTokenType}`);

// Wait for indexing
await new Promise(r => setTimeout(r, 3000));

// Tx 2: Create curve + buy 11 SUI
console.log();
console.log(`  [2/2] Creating curve + buying ${DEV_BUY_SUI} SUI…`);

const tx2 = new Transaction();
const [launchFee] = tx2.splitCoins(tx2.gas, [tx2.pure.u64(LAUNCH_FEE_MIST)]);

const [curve, cap] = tx2.moveCall({
  target: `${TEST_PACKAGE_ID}::bonding_curve_test::create_and_return`,
  typeArguments: [newTokenType],
  arguments: [
    tx2.object(treasuryCapId),
    launchFee,
    tx2.pure.string(TOKEN_NAME),
    tx2.pure.string(TOKEN_SYM),
    tx2.pure(bcsVectorAddress([address])),
    tx2.pure(bcsVectorU64([10000])),
  ],
});

const devBuyMist = BigInt(DEV_BUY_SUI) * 1_000_000_000n;
const [devPayment] = tx2.splitCoins(tx2.gas, [tx2.pure.u64(devBuyMist)]);
const [tokens, refund] = tx2.moveCall({
  target: `${TEST_PACKAGE_ID}::bonding_curve_test::buy`,
  typeArguments: [newTokenType],
  arguments: [curve, devPayment, tx2.pure.u64(0)],
});
tx2.transferObjects([tokens, refund], address);
tx2.moveCall({
  target: `${TEST_PACKAGE_ID}::bonding_curve_test::share_curve`,
  typeArguments: [newTokenType],
  arguments: [curve],
});
tx2.transferObjects([cap], address);

const res2 = await client.signAndExecuteTransaction({
  signer: keypair,
  transaction: tx2,
  options: { showEffects: true, showObjectChanges: true, showEvents: true },
});

if (res2.effects.status.status !== 'success') {
  console.error('❌ Tx2 failed:', res2.effects.status.error);
  process.exit(1);
}

const curveEvent = res2.events?.find(e => e.type?.includes('CurveCreated'));
const curveId = curveEvent?.parsedJson?.curve_id;

console.log(`  ✓ created: ${res2.digest}`);
console.log();
console.log('━'.repeat(60));
console.log('  ✓ READY TO GRADUATE');
console.log('━'.repeat(60));
console.log();
console.log(`  Curve ID:   ${curveId}`);
console.log(`  Token type: ${newTokenType}`);
console.log(`  Reserve:    ~${DEV_BUY_SUI} SUI (above 10 SUI threshold)`);
console.log();
console.log('  Next step:');
console.log();
console.log(`  node graduate_test.js ${curveId}`);
console.log('━'.repeat(60));
