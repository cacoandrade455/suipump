// launch.js — full two-transaction token launch via Node
//
// Tx 1: Publish the patched coin_template bytecode.
// Tx 2: Configure — calls create_and_return with all v6 params + optional dev-buy.
//
// Usage:
//   node launch.js                          # launch with defaults
//   node launch.js --name "Moon Coin" --symbol MOON --buy 0.5
//   node launch.js --dex deepbook --antibot 30
//   node launch.js --help

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Transaction } from '@mysten/sui/transactions';
import { fromHex } from '@mysten/sui/utils';
import * as bytecodeTemplate from '@mysten/move-bytecode-template';

import {
  client, loadKeypair, PACKAGE_ID, fmtSui, fmtTokens,
} from './config.js';

const PACKAGE_ID_V4    = '0x2154486dcf503bd3e8feae4fb913e862f7e2bbf4489769aff63978f55d55b4a8';
const SUI_CLOCK_ID     = '0x0000000000000000000000000000000000000000000000000000000000000006';
const LAUNCH_FEE_MIST  = 2_000_000_000n;
const isV4             = PACKAGE_ID === PACKAGE_ID_V4;

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
  --symbol     SYMBOL              (default: "TLAUNCH") max 5 chars, uppercase
  --desc       "Description"       (default: generic)
  --icon       https://...         (default: placeholder)
  --buy        SUI amount          (default: 0, no dev-buy)
  --payout     address:bps,...     (default: 100% to your wallet)
               e.g. --payout 0xABC:7000,0xDEF:3000
  --dex        cetus|deepbook      (default: cetus) [v5/v6 only]
  --antibot    0|15|30             (default: 0)     [v5/v6 only]

  Costs: ~0.06 SUI gas (Tx1) + ~0.01 SUI gas (Tx2) + 2 SUI launch fee + dev-buy
`);
  process.exit(0);
}

const tokenName    = get('--name',    'Test Launch');
const tokenSymbol  = get('--symbol',  'TLAUNCH').toUpperCase();
const tokenDesc    = get('--desc',    `${tokenName} — launched on SuiPump`);
const tokenIcon    = get('--icon',    'https://suipump.test/icon-placeholder.png');
const devBuySui    = parseFloat(get('--buy', '0'));
const payoutArg    = get('--payout',  null);
const dexArg       = get('--dex',     'cetus');
const antibotArg   = parseInt(get('--antibot', '0'));

// Validate
if (!/^[A-Z][A-Z0-9_]{0,4}$/.test(tokenSymbol)) {
  console.error(`Symbol "${tokenSymbol}" invalid — must be 1-5 uppercase letters/digits.`);
  process.exit(1);
}
if (![0, 15, 30].includes(antibotArg)) {
  console.error('--antibot must be 0, 15, or 30');
  process.exit(1);
}

const graduationTarget = dexArg === 'deepbook' ? 1 : 0; // 0=Cetus, 1=DeepBook
const antiBotDelay     = antibotArg;
const moduleName       = tokenSymbol.toLowerCase();
const keypair          = loadKeypair();
const address          = keypair.toSuiAddress();

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

// ---------- BCS helpers ----------
function bcsBytes(str) {
  const buf = Buffer.from(str, 'utf8');
  if (buf.length > 127) throw new Error(`Constant "${str}" too long for single-byte ULEB128`);
  return Uint8Array.from([buf.length, ...buf]);
}

function bcs_vector_address(addrs) {
  const count = addrs.length;
  const out = [count];
  for (const a of addrs) {
    const bytes = fromHex(a.replace('0x', '').padStart(64, '0'));
    out.push(...bytes);
  }
  return new Uint8Array(out);
}

function bcs_vector_u64(nums) {
  const count = nums.length;
  const buf = Buffer.alloc(1 + count * 8);
  buf[0] = count;
  for (let i = 0; i < count; i++) {
    buf.writeBigUInt64LE(BigInt(nums[i]), 1 + i * 8);
  }
  return new Uint8Array(buf);
}

// ---------- Print summary ----------
console.log('━'.repeat(60));
console.log('  SUIPUMP — launch');
console.log('━'.repeat(60));
console.log(`  name:       ${tokenName}`);
console.log(`  symbol:     ${tokenSymbol}`);
console.log(`  module:     ${moduleName}`);
console.log(`  dex:        ${dexArg} (graduation_target=${graduationTarget})`);
console.log(`  anti-bot:   ${antiBotDelay}s`);
console.log(`  package:    ${PACKAGE_ID} (${isV4 ? 'v4' : 'v5/v6'})`);
console.log(`  payouts:    ${payoutAddrs.map((a, i) => `${a.slice(0,8)}... ${payoutBps[i] / 100}%`).join(', ')}`);
console.log(`  dev-buy:    ${devBuySui > 0 ? devBuySui + ' SUI' : 'none'}`);
console.log();

// ---------- Tx 1: Patch bytecode + publish ----------
console.log('  [1/2] Patching and publishing coin module…');

const { update_identifiers, update_constants } = bytecodeTemplate;

let patched = update_identifiers(new Uint8Array(templateBytes), {
  'TEMPLATE': tokenSymbol,
  'template': moduleName,
});

patched = update_constants(patched, bcsBytes(tokenSymbol),  bcsBytes('TMPL'),         'Vector(U8)');
patched = update_constants(patched, bcsBytes(tokenName),    bcsBytes('Template Coin'), 'Vector(U8)');
patched = update_constants(patched, bcsBytes(tokenDesc),
  bcsBytes('Template description placeholder that is intentionally long to accommodate real token descriptions.'),
  'Vector(U8)');
patched = update_constants(patched, bcsBytes(tokenIcon),    bcsBytes('https://suipump.test/icon-placeholder.png'), 'Vector(U8)');

const tx1 = new Transaction();
const [upgradeCap] = tx1.publish({
  modules: [Array.from(patched)],
  dependencies: [
    '0x0000000000000000000000000000000000000000000000000000000000000001',
    '0x0000000000000000000000000000000000000000000000000000000000000002',
  ],
});
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

const published      = res1.objectChanges.find(c => c.type === 'published');
const newPackageId   = published.packageId;
const newTokenType   = `${newPackageId}::${moduleName}::${tokenSymbol}`;
const treasuryCapObj = res1.objectChanges.find(c =>
  c.type === 'created' && c.objectType?.includes('TreasuryCap')
);

if (!treasuryCapObj) {
  console.error('❌ TreasuryCap not found in Tx 1 effects.');
  process.exit(1);
}

const treasuryCapId = treasuryCapObj.objectId;
console.log(`  package:    ${newPackageId}`);
console.log(`  token type: ${newTokenType}`);
console.log(`  treasury:   ${treasuryCapId}`);
console.log();

// ---------- Tx 2: Configure curve ----------
console.log('  [2/2] Configuring curve' +
  (devBuySui > 0 ? ` + ${devBuySui} SUI dev-buy` : '') + '…');

await new Promise(r => setTimeout(r, 3000));

const tx2 = new Transaction();
const [launchFeeCoin] = tx2.splitCoins(tx2.gas, [tx2.pure.u64(LAUNCH_FEE_MIST)]);

let curve, cap;

if (isV4) {
  // V4: create_and_return(treasury, payment, name, symbol, payout_addresses, payout_bps)
  [curve, cap] = tx2.moveCall({
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
} else {
  // V5/V6: create_and_return(treasury, payment, name, symbol, description,
  //          payout_addresses, payout_bps, graduation_target, anti_bot_delay, clock)
  [curve, cap] = tx2.moveCall({
    target: `${PACKAGE_ID}::bonding_curve::create_and_return`,
    typeArguments: [newTokenType],
    arguments: [
      tx2.object(treasuryCapId),
      launchFeeCoin,
      tx2.pure.string(tokenName),
      tx2.pure.string(tokenSymbol),
      tx2.pure.string(tokenDesc),
      tx2.pure(bcs_vector_address(payoutAddrs)),
      tx2.pure(bcs_vector_u64(payoutBps)),
      tx2.pure.u8(graduationTarget),
      tx2.pure.u8(antiBotDelay),
      tx2.object(SUI_CLOCK_ID),
    ],
  });
}

// Dev-buy
if (devBuySui > 0) {
  const devBuyMist = BigInt(Math.floor(devBuySui * 1e9));
  const [devPayment] = tx2.splitCoins(tx2.gas, [tx2.pure.u64(devBuyMist)]);

  const buyArgs = isV4
    ? [curve, devPayment, tx2.pure.u64(0)]
    : [curve, devPayment, tx2.pure.u64(0), tx2.pure.option('address', null), tx2.object(SUI_CLOCK_ID)];

  const [tokens, refund] = tx2.moveCall({
    target: `${PACKAGE_ID}::bonding_curve::buy`,
    typeArguments: [newTokenType],
    arguments: buyArgs,
  });
  tx2.transferObjects([refund], address);
  tx2.transferObjects([tokens], address);
}

tx2.moveCall({
  target: `${PACKAGE_ID}::bonding_curve::share_curve`,
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
  console.error('❌ Tx 2 failed:', res2.effects.status.error);
  console.error('  TreasuryCap still in wallet:', treasuryCapId);
  process.exit(1);
}

console.log(`  ✓ configured: ${res2.digest}`);

const curveEvent    = res2.events?.find(e => e.type?.includes('CurveCreated'));
const newCurveId    = curveEvent?.parsedJson?.curve_id;
const creatorCapObj = res2.objectChanges?.find(c =>
  c.type === 'created' && c.objectType?.includes('CreatorCap')
);

console.log();
console.log('━'.repeat(60));
console.log('  ✓ LAUNCH COMPLETE');
console.log('━'.repeat(60));
console.log(`  token:        ${tokenName} ($${tokenSymbol})`);
console.log(`  package:      ${newPackageId}`);
console.log(`  curve:        ${newCurveId ?? '(check Tx 2 effects)'}`);
console.log(`  creator cap:  ${creatorCapObj?.objectId ?? '(check wallet)'}`);
console.log(`  dex:          ${dexArg}`);
console.log(`  anti-bot:     ${antiBotDelay}s`);
console.log(`  tx1:          https://testnet.suivision.xyz/txblock/${res1.digest}`);
console.log(`  tx2:          https://testnet.suivision.xyz/txblock/${res2.digest}`);
console.log();
console.log('  Add to constants.js to trade this token:');
console.log(`    PACKAGE_ID = '${newPackageId}'`);
console.log(`    CURVE_ID   = '${newCurveId}'`);
console.log(`    TOKEN_TYPE = '${newTokenType}'`);
