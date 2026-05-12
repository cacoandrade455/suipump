// upgrade.js
// Upgrades the live SuiPump v4 package.
// Uses `sui client upgrade` which handles digest computation automatically.
//
// What changes:
//   graduation triggers at sui_reserve >= 35k SUI OR token_reserve == 0
//
// What stays the same:
//   Package ID, all function signatures, all struct layouts, all existing objects.
//
// Usage:
//   node scripts/upgrade.js

import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const UPGRADE_CAP_ID = '0xc85c5786edc0c0736c3a540131b40af0955e38493ecc601ed5fb93c9c81986d2';
const PACKAGE_ID     = '0x2154486dcf503bd3e8feae4fb913e862f7e2bbf4489769aff63978f55d55b4a8';

const __dir = dirname(fileURLToPath(import.meta.url));
const contractsDir = join(__dir, '..', 'contracts');

console.log('━'.repeat(60));
console.log('  SUIPUMP — upgrade v4 contract');
console.log('━'.repeat(60));
console.log(`  package:     ${PACKAGE_ID}`);
console.log(`  upgrade cap: ${UPGRADE_CAP_ID}`);
console.log(`  change:      graduation threshold → 35,000 SUI`);
console.log();

// Build first
console.log('  [1/2] Building…');
try {
  execSync('sui move build', { cwd: contractsDir, stdio: 'inherit' });
} catch {
  console.error('❌ Build failed.');
  process.exit(1);
}
console.log();

// Upgrade
console.log('  [2/2] Publishing upgrade…');
let output;
try {
  output = execSync(
    `sui client upgrade --upgrade-capability ${UPGRADE_CAP_ID} --gas-budget 200000000 --json`,
    { cwd: contractsDir }
  ).toString();
} catch (err) {
  console.error('❌ Upgrade command failed:', err.message);
  process.exit(1);
}

let result;
try {
  result = JSON.parse(output);
} catch {
  console.error('❌ Could not parse output:', output.slice(0, 300));
  process.exit(1);
}

if (result.effects?.status?.status !== 'success') {
  console.error('❌ Upgrade failed:', result.effects?.status?.error);
  process.exit(1);
}

console.log();
console.log('━'.repeat(60));
console.log('  ✓ UPGRADED');
console.log('━'.repeat(60));
console.log();
console.log(`  Digest:  ${result.digest}`);
console.log(`  Package: ${PACKAGE_ID} (same ID — upgrade applied in place)`);
console.log();
console.log('  Graduation threshold is now 35,000 SUI.');
console.log('  Any curve with >= 35k SUI in reserve can now be graduated.');
console.log('  Existing tokens, trades, fees — all unaffected.');
console.log();
console.log(`  https://testnet.suivision.xyz/txblock/${result.digest}`);
console.log('━'.repeat(60));
