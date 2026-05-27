// launch.js — Full two-transaction token launch (V9 active)
//
// Tx 1: Publish the patched coin_template bytecode.
//       V8 template: public_share_object(metadata) — NOT public_freeze_object.
//       This is what makes update_metadata() work for V8 tokens.
// Tx 2: create_and_return + optional dev-buy + optional lock + share_curve.
//
// Usage:
//   node launch.js
//   node launch.js --name "Moon Coin" --symbol MOON --buy 0.5
//   node launch.js --dex turbos --antibot 15 --lock-mode cliff --lock-dur 30d
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
const PACKAGE_ID_V7    = '0xfb8f3f3e4e8d53130ac140906eebea6b6740bfaf0c971aec607fbc723be951f0';
// PACKAGE_ID_V8: set this to the real V8 package ID after running:
//   cd contracts-v8 && sui client publish --gas-budget 100000000
// Then update VITE_PACKAGE_ID_V8 in Vercel env as well.
const PACKAGE_ID_V8    = process.env.PACKAGE_ID_V8 || '';
const PACKAGE_ID_V9    = '0x719698e5138582d78ee95317271e8bce05769569a4f58c940a7f1b424d90ffe2';

const SUI_CLOCK_ID     = '0x0000000000000000000000000000000000000000000000000000000000000006';
const LAUNCH_FEE_MIST  = 2_000_000_000n;

const isV4  = PACKAGE_ID === PACKAGE_ID_V4;
const isV7  = PACKAGE_ID === PACKAGE_ID_V7;
const isV8  = PACKAGE_ID_V8 ? PACKAGE_ID === PACKAGE_ID_V8 : false;
const isV9  = PACKAGE_ID === PACKAGE_ID_V9;

// Vesting (V7+) — must match bonding_curve.move
const VEST_MODE = { cliff: 0, linear: 1, monthly: 2 };
const VEST_DURATIONS_MS = {
  '7d':   7n   * 24n * 60n * 60n * 1000n,
  '30d':  30n  * 24n * 60n * 60n * 1000n,
  '180d': 180n * 24n * 60n * 60n * 1000n,
  '365d': 365n * 24n * 60n * 60n * 1000n,
};

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
  --dex        cetus|deepbook|turbos  (default: cetus)
  --antibot    0|15|30             (default: 0)
  --lock-mode  cliff|linear|monthly   lock the dev-buy tokens [V7/V8 only]
  --lock-dur   7d|30d|180d|365d       lock duration           [V7/V8 only]
               (monthly mode requires 30d or longer)

  Active package: ${PACKAGE_ID}
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
const lockModeArg  = get('--lock-mode', null);
const lockDurArg   = get('--lock-dur',  '30d');

// Validate
if (!/^[A-Z][A-Z0-9_]{0,4}$/.test(tokenSymbol)) {
  console.error(`Symbol "${tokenSymbol}" invalid — must be 1-5 uppercase letters/digits.`);
  process.exit(1);
}
if (![0, 15, 30].includes(antibotArg)) {
  console.error('--antibot must be 0, 15, or 30');
  process.exit(1);
}
if (!['cetus', 'deepbook', 'turbos'].includes(dexArg)) {
  console.error('--dex must be cetus, deepbook, or turbos');
  process.exit(1);
}

// Dev-buy lock validation (V7/V8 only)
let lockEnabled = false, lockMode = 0, lockDurationMs = 0n;
if (lockModeArg) {
  if (!isV7 && !isV8 && !isV9) {
    console.error('--lock-mode requires V7 or V8 or V9 package (vesting is V7+ only).');
    process.exit(1);
  }
  if (devBuySui <= 0) {
    console.error('--lock-mode set but --buy is 0 — there is nothing to lock.');
    process.exit(1);
  }
  if (!(lockModeArg in VEST_MODE)) {
    console.error('--lock-mode must be cliff, linear, or monthly');
    process.exit(1);
  }
  if (!(lockDurArg in VEST_DURATIONS_MS)) {
    console.error('--lock-dur must be 7d, 30d, 180d, or 365d');
    process.exit(1);
  }
  if (lockModeArg === 'monthly' && lockDurArg === '7d') {
    console.error('monthly vesting requires a duration of 30d or longer');
    process.exit(1);
  }
  lockEnabled    = true;
  lockMode       = VEST_MODE[lockModeArg];
  lockDurationMs = VEST_DURATIONS_MS[lockDurArg];
}

const graduationTarget = dexArg === 'deepbook' ? 1 : dexArg === 'turbos' ? 2 : 0;
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
// V8 template: built from coin-template/ (which now uses public_share_object)
// After V8 coin-template is deployed, run `cd coin-template && sui move build`
// to regenerate template.mv with the new behaviour.
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
  if (buf.length > 127) throw new Error(`Constant "${str.slice(0,30)}…" too long for single-byte ULEB128 (${buf.length} bytes)`);
  return Uint8Array.from([buf.length, ...buf]);
}

function bcs_vector_address(addrs) {
  const out = [addrs.length];
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

// ---------- Placeholder constants (must match template.move exactly) ----------
const PLACEHOLDER_NAME = 'Template Coin';
const PLACEHOLDER_SYM  = 'TMPL';
const PLACEHOLDER_DESC = 'Template description placeholder that is intentionally long to accommodate real token descriptions.';
const PLACEHOLDER_ICON = 'https://suipump.test/icon-placeholder.png';

// ---------- Print summary ----------
const pkgLabel = isV9 ? 'v9' : isV8 ? 'v8' : isV7 ? 'v7' : isV4 ? 'v4' : 'v5/v6';
console.log('━'.repeat(60));
console.log('  SUIPUMP — launch');
console.log('━'.repeat(60));
console.log(`  name:       ${tokenName}`);
console.log(`  symbol:     ${tokenSymbol}`);
console.log(`  module:     ${moduleName}`);
console.log(`  dex:        ${dexArg} (graduation_target=${graduationTarget})`);
console.log(`  anti-bot:   ${antiBotDelay}s`);
console.log(`  package:    ${PACKAGE_ID} (${pkgLabel})`);
console.log(`  payouts:    ${payoutAddrs.map((a, i) => `${a.slice(0,8)}… ${payoutBps[i] / 100}%`).join(', ')}`);
console.log(`  dev-buy:    ${devBuySui > 0 ? devBuySui + ' SUI' : 'none'}`);
if (lockEnabled) {
  console.log(`  dev lock:   ${lockModeArg} / ${lockDurArg} (immutable)`);
}
console.log(`  template:   ${templatePath}`);
console.log();

// ---------- Tx 1: Patch bytecode + publish ----------
console.log('  [1/2] Patching and publishing coin module…');

const { update_identifiers, update_constants } = bytecodeTemplate;

let patched = update_identifiers(new Uint8Array(templateBytes), {
  'TEMPLATE': tokenSymbol,
  'template': moduleName,
});

patched = update_constants(patched, bcsBytes(tokenSymbol),  bcsBytes(PLACEHOLDER_SYM),  'Vector(U8)');
patched = update_constants(patched, bcsBytes(tokenName),    bcsBytes(PLACEHOLDER_NAME), 'Vector(U8)');
patched = update_constants(patched, bcsBytes(tokenDesc),    bcsBytes(PLACEHOLDER_DESC), 'Vector(U8)');
patched = update_constants(patched, bcsBytes(tokenIcon),    bcsBytes(PLACEHOLDER_ICON), 'Vector(U8)');

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
const devBuyLabel = devBuySui > 0 ? ` + dev-buy ${devBuySui} SUI` : '';
const lockLabel   = lockEnabled    ? ' + lock tokens' : '';
console.log(`  [2/2] Configuring curve${devBuyLabel}${lockLabel}…`);

// Fetch treasury cap for Tx 2
await client.waitForTransaction({ digest: res1.digest });
const treasuryObj = await client.getObject({
  id: treasuryCapId,
  options: { showOwner: true, showType: true },
});

const tx2 = new Transaction();

// Coin args for launch fee + optional dev-buy
const launchFeeCoin = tx2.splitCoins(tx2.gas, [tx2.pure.u64(LAUNCH_FEE_MIST)]);

const treasuryRef = tx2.object(treasuryCapId);

// Dispatch by package version — V4 has legacy signature, V5+ and V7+ and V8+ share it
if (isV4) {
  // V4 create() — no launch fee, no anti-bot, no graduation target
  const [curve, cap] = tx2.moveCall({
    target: `${PACKAGE_ID}::bonding_curve::create_and_return`,
    typeArguments: [newTokenType],
    arguments: [
      treasuryRef,
      tx2.pure.string(tokenName),
      tx2.pure.string(tokenSymbol),
      address,
    ],
  });
  tx2.moveCall({
    target: `${PACKAGE_ID}::bonding_curve::share_curve`,
    typeArguments: [newTokenType],
    arguments: [curve],
  });
  tx2.transferObjects([cap], address);
} else {
  // V5 / V6 / V7 / V8 — create_and_return with full params
  const [curve, cap] = tx2.moveCall({
    target: `${PACKAGE_ID}::bonding_curve::create_and_return`,
    typeArguments: [newTokenType],
    arguments: [
      treasuryRef,
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

  if (devBuySui > 0) {
    const devBuyMist = BigInt(Math.floor(devBuySui * 1e9));
    const devBuyCoin = tx2.splitCoins(tx2.gas, [tx2.pure.u64(devBuyMist)]);
    const buyArgs = isV9
      ? [
          curve,
          devBuyCoin,
          tx2.pure.u64(0),              // min_tokens_out = 0
          tx2.pure.option('address', null), // referral = none
          tx2.object(SUI_CLOCK_ID),
          tx2.pure.u64(0),              // sui_price_scaled = 0 (use fallback threshold)
        ]
      : [
          curve,
          devBuyCoin,
          tx2.pure.u64(0),              // min_tokens_out = 0
          tx2.pure.option('address', null), // referral = none
          tx2.object(SUI_CLOCK_ID),
        ];
    const [tokens, refund] = tx2.moveCall({
      target: `${PACKAGE_ID}::bonding_curve::buy`,
      typeArguments: [newTokenType],
      arguments: buyArgs,
    });

    if (lockEnabled) {
      // Lock the dev-buy tokens immediately in the same PTB
      tx2.moveCall({
        target: `${PACKAGE_ID}::bonding_curve::lock_tokens`,
        typeArguments: [newTokenType],
        arguments: [
          curve,
          tokens,
          tx2.pure.u8(lockMode),
          tx2.pure.u64(lockDurationMs),
          tx2.object(SUI_CLOCK_ID),
        ],
      });
    } else {
      tx2.transferObjects([tokens], address);
    }
    tx2.transferObjects([refund], address);
  }

  tx2.moveCall({
    target: `${PACKAGE_ID}::bonding_curve::share_curve`,
    typeArguments: [newTokenType],
    arguments: [curve],
  });
  tx2.transferObjects([cap], address);
}

const res2 = await client.signAndExecuteTransaction({
  signer: keypair,
  transaction: tx2,
  options: { showEffects: true, showObjectChanges: true },
});

if (res2.effects.status.status !== 'success') {
  console.error('❌ Tx 2 failed:', res2.effects.status.error);
  console.error('  Stranded TreasuryCap:', treasuryCapId);
  process.exit(1);
}

console.log(`  ✓ curve created: ${res2.digest}`);

const curveObj = res2.objectChanges?.find(c =>
  c.type === 'created' && c.objectType?.includes('Curve<')
);
const capObj = res2.objectChanges?.find(c =>
  c.type === 'created' && c.objectType?.includes('CreatorCap')
);
const vestLockObj = lockEnabled
  ? res2.objectChanges?.find(c =>
      c.type === 'created' && c.objectType?.includes('VestingLock')
    )
  : null;

console.log();
console.log('━'.repeat(60));
console.log('  LAUNCH COMPLETE');
console.log('━'.repeat(60));
console.log(`  curve:      ${curveObj?.objectId ?? '(check explorer)'}`);
console.log(`  creator cap:${capObj?.objectId   ?? '(check explorer)'}`);
if (vestLockObj) {
  console.log(`  vest lock:  ${vestLockObj.objectId}`);
}
console.log(`  token type: ${newTokenType}`);
console.log(`  tx1:        https://suiexplorer.com/txblock/${res1.digest}?network=testnet`);
console.log(`  tx2:        https://suiexplorer.com/txblock/${res2.digest}?network=testnet`);
console.log();
