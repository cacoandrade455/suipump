// volume_sim.js — upgraded stress test
// 20 wallets, 50 SUI per trade, 6 hours, staggered delays to avoid 429s
//
// Usage:
//   node volume_sim.js              — full run
//   node volume_sim.js --sweep      — recover funds to main wallet
//   node volume_sim.js --status     — print wallet balances
//   node volume_sim.js --fund       — fund wallets only (no trading)

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Transaction } from '@mysten/sui/transactions';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { client, loadKeypair, PACKAGE_ID, ADMIN_CAP_ID, fmtSui } from './config.js';

const __dir = dirname(fileURLToPath(import.meta.url));
const WALLETS_FILE = join(__dir, 'sim_wallets.json');

// ── Config ────────────────────────────────────────────────────────────────────

const CURVES = [
  '0x79b38f61975f3ff9cd48dfe7e4635a134234c6063dc55706deec3f358f3219fc', // $FIX
  '0x3bd5a648382edd67d888859548de2d7787899f3563ff327d32ffe2a7173608ed', // $NOCAP
  '0x4e03652d75f85b11ae5f899a434527165df5840991e18ce73ba23aadb4f99441', // $EASY
  '0x711779a31ff0018981494ff957f150e23df580bff7b390ef472d5cf77a1c8580', // $CETUS
  '0xead3b3143ae4eb2a05691c1d43af8141c4c0d7717c44939887fe84bc64fcd951', // $TKN
];

const NUM_WALLETS      = 20;
const TRADE_SUI        = 50;
const TRADE_MIST       = BigInt(TRADE_SUI) * 1_000_000_000n;
const FUND_PER_WALLET  = 700;                    // SUI per sim wallet
const FUND_MIST        = BigInt(FUND_PER_WALLET) * 1_000_000_000n;
const RUN_DURATION_MS  = 6 * 60 * 60 * 1_000;   // 6 hours
const CYCLE_DELAY_MS   = 30_000;                 // 30s between cycles
const MAX_STAGGER_MS   = 15_000;                 // random 0-15s stagger per wallet
const RETRY_DELAY_MS   = 5_000;                  // wait 5s on 429 before retry
const MAX_RETRIES      = 3;                      // retries per trade

const mainKeypair = loadKeypair();
const mainAddress = mainKeypair.toSuiAddress();

// ── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function randInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }

async function getSharedVersion(objectId) {
  const obj = await client.getObject({ id: objectId, options: { showOwner: true } });
  return obj.data?.owner?.Shared?.initial_shared_version;
}

async function getCurveTokenType(curveId) {
  const obj = await client.getObject({ id: curveId, options: { showType: true } });
  return obj.data?.type?.match(/Curve<(.+)>$/)?.[1];
}

// ── Wallet management ─────────────────────────────────────────────────────────

function generateWallets(n) {
  const wallets = [];
  for (let i = 0; i < n; i++) {
    const kp = new Ed25519Keypair();
    wallets.push({ address: kp.toSuiAddress(), privateKey: kp.getSecretKey() });
  }
  writeFileSync(WALLETS_FILE, JSON.stringify(wallets, null, 2));
  console.log(`  ✓ Generated ${n} wallets → sim_wallets.json`);
  return wallets;
}

function loadWallets() {
  if (!existsSync(WALLETS_FILE)) return null;
  return JSON.parse(readFileSync(WALLETS_FILE, 'utf-8'));
}

function walletKeypair(w) {
  return Ed25519Keypair.fromSecretKey(w.privateKey);
}

// ── Fund wallets — batch in groups of 10 to avoid tx size limits ──────────────

async function fundWallets(wallets) {
  console.log(`  Funding ${wallets.length} wallets with ${FUND_PER_WALLET} SUI each…`);
  console.log(`  Total: ${wallets.length * FUND_PER_WALLET} SUI from main wallet`);

  // Fund in batches of 10
  const BATCH = 10;
  for (let i = 0; i < wallets.length; i += BATCH) {
    const batch = wallets.slice(i, i + BATCH);
    const tx = new Transaction();
    const coins = batch.map(() => {
      const [coin] = tx.splitCoins(tx.gas, [tx.pure.u64(FUND_MIST)]);
      return coin;
    });
    batch.forEach((w, j) => tx.transferObjects([coins[j]], w.address));

    const result = await client.signAndExecuteTransaction({
      signer: mainKeypair,
      transaction: tx,
      options: { showEffects: true },
    });

    if (result.effects.status.status !== 'success') {
      console.error(`❌ Funding batch ${i / BATCH + 1} failed:`, result.effects.status.error);
      process.exit(1);
    }
    console.log(`  ✓ Batch ${Math.floor(i / BATCH) + 1} funded: ${result.digest}`);
    await sleep(2000);
  }
  await sleep(3000);
}

// ── Sweep all funds back to main wallet ───────────────────────────────────────

async function sweepWallets(wallets) {
  console.log();
  console.log('  Sweeping all funds back to main wallet…');
  let totalRecovered = 0n;

  for (let i = 0; i < wallets.length; i++) {
    const w = wallets[i];
    try {
      const kp = walletKeypair(w);
      const balance = await client.getBalance({ owner: w.address });
      const total = BigInt(balance.totalBalance);

      if (total < 2_000_000n) {
        console.log(`  W${i + 1} — dust, skipping`);
        continue;
      }

      // Get token balances too
      const allCoins = await client.getAllCoins({ owner: w.address });
      const tokenCoins = allCoins.data.filter(c => c.coinType !== '0x2::sui::SUI');

      const tx = new Transaction();

      // Transfer token coins
      if (tokenCoins.length > 0) {
        const byType = {};
        for (const c of tokenCoins) {
          if (!byType[c.coinType]) byType[c.coinType] = [];
          byType[c.coinType].push(c.coinObjectId);
        }
        for (const [, ids] of Object.entries(byType)) {
          const objs = ids.map(id => tx.object(id));
          if (objs.length > 1) tx.mergeCoins(objs[0], objs.slice(1));
          tx.transferObjects([objs[0]], mainAddress);
        }
      }

      // Transfer all SUI
      tx.transferObjects([tx.gas], mainAddress);

      const result = await client.signAndExecuteTransaction({
        signer: kp,
        transaction: tx,
        options: { showEffects: true },
      });

      if (result.effects.status.status === 'success') {
        console.log(`  W${i + 1} ✓ swept ~${fmtSui(total)}`);
        totalRecovered += total;
      } else {
        console.log(`  W${i + 1} ⚠ failed: ${result.effects.status.error?.slice(0, 60)}`);
      }
      await sleep(500);
    } catch (err) {
      console.log(`  W${i + 1} ⚠ ${err.message?.slice(0, 60)}`);
    }
  }

  console.log(`  Total recovered: ~${fmtSui(totalRecovered)}`);
}

// ── Single trade with retry on 429 ───────────────────────────────────────────

async function buyThenSell(keypair, address, curveId, tokenType, walletNum) {
  const sharedVersion = await getSharedVersion(curveId);

  // BUY with retry
  let buyResult;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const buyTx = new Transaction();
      const curveRef = buyTx.sharedObjectRef({ objectId: curveId, initialSharedVersion: sharedVersion, mutable: true });
      const [payment] = buyTx.splitCoins(buyTx.gas, [buyTx.pure.u64(TRADE_MIST)]);
      const [tokens, refund] = buyTx.moveCall({
        target: `${PACKAGE_ID}::bonding_curve::buy`,
        typeArguments: [tokenType],
        arguments: [curveRef, payment, buyTx.pure.u64(0)],
      });
      buyTx.transferObjects([tokens, refund], address);

      buyResult = await client.signAndExecuteTransaction({
        signer: keypair,
        transaction: buyTx,
        options: { showEffects: true },
      });

      if (buyResult.effects.status.status !== 'success') {
        throw new Error('Buy failed: ' + buyResult.effects.status.error);
      }
      break;
    } catch (err) {
      if (err.message?.includes('429') && attempt < MAX_RETRIES) {
        await sleep(RETRY_DELAY_MS * attempt);
        continue;
      }
      throw err;
    }
  }

  await sleep(2000);

  // SELL with retry
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const coins = await client.getCoins({ owner: address, coinType: tokenType });
      if (coins.data.length === 0) throw new Error('No tokens after buy');

      const totalTokens = coins.data.reduce((s, c) => s + BigInt(c.balance), 0n);
      const sellTx = new Transaction();
      const curveRef2 = sellTx.sharedObjectRef({ objectId: curveId, initialSharedVersion: sharedVersion, mutable: true });

      const coinObjs = coins.data.map(c => sellTx.object(c.coinObjectId));
      if (coinObjs.length > 1) sellTx.mergeCoins(coinObjs[0], coinObjs.slice(1));
      const [tokenToSell] = sellTx.splitCoins(coinObjs[0], [sellTx.pure.u64(totalTokens)]);

      const [suiOut] = sellTx.moveCall({
        target: `${PACKAGE_ID}::bonding_curve::sell`,
        typeArguments: [tokenType],
        arguments: [curveRef2, tokenToSell, sellTx.pure.u64(0)],
      });
      sellTx.transferObjects([suiOut], address);

      const sellResult = await client.signAndExecuteTransaction({
        signer: keypair,
        transaction: sellTx,
        options: { showEffects: true },
      });

      if (sellResult.effects.status.status !== 'success') {
        throw new Error('Sell failed: ' + sellResult.effects.status.error);
      }
      return { buyDigest: buyResult.digest, sellDigest: sellResult.digest };
    } catch (err) {
      if (err.message?.includes('429') && attempt < MAX_RETRIES) {
        await sleep(RETRY_DELAY_MS * attempt);
        continue;
      }
      throw err;
    }
  }
}

// ── Status ────────────────────────────────────────────────────────────────────

async function printStatus(wallets) {
  console.log('  Wallet balances:');
  let total = 0n;
  for (let i = 0; i < wallets.length; i++) {
    const bal = await client.getBalance({ owner: wallets[i].address });
    const b = BigInt(bal.totalBalance);
    total += b;
    if (b > 1_000_000n) console.log(`  W${String(i + 1).padStart(2, '0')} ${fmtSui(b)}`);
  }
  console.log(`  Sim total: ${fmtSui(total)}`);
  const mainBal = await client.getBalance({ owner: mainAddress });
  console.log(`  Main:      ${fmtSui(BigInt(mainBal.totalBalance))}`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

if (args.includes('--status')) {
  const wallets = loadWallets();
  if (!wallets) { console.error('No sim_wallets.json found.'); process.exit(1); }
  await printStatus(wallets);
  process.exit(0);
}

if (args.includes('--sweep')) {
  const wallets = loadWallets();
  if (!wallets) { console.error('No sim_wallets.json found.'); process.exit(1); }
  await sweepWallets(wallets);
  process.exit(0);
}

if (args.includes('--fund')) {
  let wallets = loadWallets();
  if (!wallets) wallets = generateWallets(NUM_WALLETS);
  await fundWallets(wallets);
  process.exit(0);
}

// ── Full run ──────────────────────────────────────────────────────────────────

console.log('━'.repeat(60));
console.log('  SUIPUMP — volume stress test');
console.log('━'.repeat(60));
console.log(`  main wallet:   ${mainAddress}`);
console.log(`  wallets:       ${NUM_WALLETS}`);
console.log(`  trade size:    ${TRADE_SUI} SUI`);
console.log(`  duration:      6 hours`);
console.log(`  stagger:       random 0-${MAX_STAGGER_MS / 1000}s per wallet`);
console.log(`  retry on 429:  yes (${MAX_RETRIES}x with backoff)`);
console.log();

// Generate or load wallets
let wallets = loadWallets();
if (!wallets || wallets.length < NUM_WALLETS) {
  console.log('  Generating fresh wallets…');
  wallets = generateWallets(NUM_WALLETS);
} else {
  console.log(`  Loaded ${wallets.length} wallets from sim_wallets.json`);
}

// Check funding
const firstBal = await client.getBalance({ owner: wallets[0].address });
if (BigInt(firstBal.totalBalance) < 100_000_000_000n) {
  await fundWallets(wallets);
} else {
  console.log(`  Wallets already funded`);
}

// Pre-fetch token types
console.log();
console.log('  Fetching token types…');
const tokenTypes = {};
for (const curveId of CURVES) {
  tokenTypes[curveId] = await getCurveTokenType(curveId);
}
console.log(`  ✓ ${Object.keys(tokenTypes).length} curves ready`);
console.log();

// Check main wallet balance before starting
const mainBalBefore = await client.getBalance({ owner: mainAddress });
console.log(`  Main wallet before: ${fmtSui(BigInt(mainBalBefore.totalBalance))}`);
console.log();

console.log('  Starting stress test — Ctrl+C to abort');
console.log('  Run: node volume_sim.js --sweep to recover funds if aborted');
console.log();

const startTime = Date.now();
let totalTrades = 0;
let totalVolume = 0;
let totalErrors = 0;
let cycle = 0;

while (Date.now() - startTime < RUN_DURATION_MS) {
  cycle++;
  const elapsed = Math.floor((Date.now() - startTime) / 1000);
  const remaining = Math.floor((RUN_DURATION_MS - (Date.now() - startTime)) / 1000);
  const hrs = String(Math.floor(remaining / 3600)).padStart(2, '0');
  const mins = String(Math.floor((remaining % 3600) / 60)).padStart(2, '0');
  const secs = String(remaining % 60).padStart(2, '0');

  console.log(`  Cycle ${cycle} — elapsed: ${elapsed}s, remaining: ${hrs}:${mins}:${secs}, trades: ${totalTrades}, volume: ${totalVolume} SUI, errors: ${totalErrors}`);

  // Each wallet gets a random stagger delay so they don't all fire simultaneously
  const promises = wallets.map(async (w, i) => {
    // Stagger: wallet i waits a random 0-15s before trading
    await sleep(randInt(0, MAX_STAGGER_MS));

    const curveId = CURVES[(cycle + i) % CURVES.length];
    const tokenType = tokenTypes[curveId];
    if (!tokenType) return;

    const kp = walletKeypair(w);
    try {
      const { buyDigest, sellDigest } = await buyThenSell(kp, w.address, curveId, tokenType, i + 1);
      console.log(`    W${String(i + 1).padStart(2, '0')} ✓ buy ${buyDigest.slice(0, 10)}… sell ${sellDigest.slice(0, 10)}…`);
      totalTrades += 2;
      totalVolume += TRADE_SUI;
    } catch (err) {
      console.log(`    W${String(i + 1).padStart(2, '0')} ⚠ ${err.message?.slice(0, 50)}`);
      totalErrors++;
    }
  });

  await Promise.allSettled(promises);

  // Wait before next cycle
  if (Date.now() - startTime < RUN_DURATION_MS - CYCLE_DELAY_MS) {
    await sleep(CYCLE_DELAY_MS);
  }
}

// Summary
const totalSecs = Math.floor((Date.now() - startTime) / 1000);
console.log();
console.log('━'.repeat(60));
console.log('  ✓ STRESS TEST COMPLETE');
console.log('━'.repeat(60));
console.log(`  Duration:      ${Math.floor(totalSecs / 3600)}h ${Math.floor((totalSecs % 3600) / 60)}m`);
console.log(`  Total trades:  ${totalTrades}`);
console.log(`  Gross volume:  ${totalVolume} SUI`);
console.log(`  Errors:        ${totalErrors}`);
console.log(`  Error rate:    ${((totalErrors / (totalTrades + totalErrors)) * 100).toFixed(1)}%`);
console.log();

// Sweep funds
await sweepWallets(wallets);

// Claim fees
console.log();
console.log('  Claiming all fees…');
try {
  const { execSync } = await import('node:child_process');
  execSync('node claim_fees.js', { stdio: 'inherit', cwd: __dir });
} catch {
  console.log('  ⚠ Run manually: node scripts/claim_fees.js');
}

const mainBalAfter = await client.getBalance({ owner: mainAddress });
console.log();
console.log(`  Main wallet after: ${fmtSui(BigInt(mainBalAfter.totalBalance))}`);
console.log('━'.repeat(60));
