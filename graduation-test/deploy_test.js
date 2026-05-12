// deploy_test.js
// Deploys the throwaway suipump_test contract to Sui testnet.
// Run this first. Copy the output into config.js.
//
// Usage:
//   node deploy_test.js
//
// Prerequisites:
//   - npm install (run once in this folder)
//   - sui CLI on PATH
//   - contracts-test/ folder at ../contracts-test/ relative to suipump root
//   - Wallet funded (~0.5 SUI for gas)

import { execSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(fileURLToPath(import.meta.url));
// contracts-test is at suipump/contracts-test/
// graduation-test is at suipump/graduation-test/
// so go up one level
const contractsTestDir = join(__dir, '..', 'contracts-test');

console.log('━'.repeat(60));
console.log('  SUIPUMP TEST — deploy test contract');
console.log('━'.repeat(60));
console.log(`  contracts dir: ${contractsTestDir}`);
console.log();

console.log('  Building…');
try {
  execSync('sui move build', { cwd: contractsTestDir, stdio: 'inherit' });
} catch {
  console.error('❌ Build failed.');
  process.exit(1);
}
console.log();

console.log('  Publishing to testnet…');
let output;
try {
  output = execSync(
    'sui client publish --gas-budget 200000000 --json',
    { cwd: contractsTestDir }
  ).toString();
} catch (err) {
  console.error('❌ Publish failed:', err.message);
  process.exit(1);
}

let result;
try {
  result = JSON.parse(output);
} catch {
  console.error('❌ Could not parse output as JSON');
  console.error(output.slice(0, 500));
  process.exit(1);
}

if (result.effects?.status?.status !== 'success') {
  console.error('❌ Transaction failed:', result.effects?.status?.error);
  process.exit(1);
}

const published = result.objectChanges?.find(c => c.type === 'published');
const packageId = published?.packageId;

const adminCapObj = result.objectChanges?.find(c =>
  c.type === 'created' && c.objectType?.includes('AdminCap')
);
const adminCapId = adminCapObj?.objectId;

if (!packageId || !adminCapId) {
  console.error('❌ Could not extract IDs from output');
  result.objectChanges?.forEach(c =>
    console.error(' ', c.type, c.objectType ?? '', c.objectId ?? c.packageId ?? '')
  );
  process.exit(1);
}

console.log();
console.log('━'.repeat(60));
console.log('  ✓ DEPLOYED');
console.log('━'.repeat(60));
console.log();
console.log(`  Package ID:   ${packageId}`);
console.log(`  AdminCap ID:  ${adminCapId}`);
console.log(`  Digest:       ${result.digest}`);
console.log();
console.log('  Copy these into graduation-test/config.js:');
console.log();
console.log(`  TEST_PACKAGE_ID   = '${packageId}'`);
console.log(`  TEST_ADMIN_CAP_ID = '${adminCapId}'`);
console.log();
console.log('  Then run: node launch_test.js');
console.log('━'.repeat(60));
