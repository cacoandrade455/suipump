// deep_farm.js
// 50 fresh wallets, swap SUI->DEEP, send DEEP directly to main in same tx.
// Saves all keypairs to burners.json FIRST. Run recover_burners.js if needed.
// Usage: node deep_farm.js  (place in graduation-test/)

import { Transaction } from '@mysten/sui/transactions';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { writeFileSync } from 'node:fs';
import { client, loadKeypair } from './config.js';

const DEEPBOOK_PKG  = '0x22be4cade64bf2d02412c7e8d0e8beea2f78828b948118d46735315409371a3c';
const DEEP_SUI_POOL = '0x48c95963e9eac37a316b7ae04a0deb761bcdcc2b67912374d6036e7f0e9bae9f';
const DEEP_TYPE     = '0x36dbef866a1d62bf7328989a10fb2f07d769f4ee587c0de4a0a256e57e0a58a8::deep::DEEP';
const SUI_TYPE      = '0x2::sui::SUI';
const MIN_DEEP_OUT  = 1_000_000n;
const DEEP_FEE      = 1_000_000n;
const SUI_SWAP      = 100_000_000_000n;
const FUND_AMOUNT   = 120_000_000_000n;
const DEEP_SCALAR   = 1_000_000n;
const MAIN_WALLET   = '0x0be9a8f56ba3b07f295e0c7526e7f47ca3a146649b9d864d2eb47bf3acd90c55';
const NUM_WALLETS   = 50;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Store only the 32-byte seed as hex
function toHex(kp) {
  const raw = kp.getSecretKey();
  return Buffer.from(raw.slice(0, 32)).toString('hex');
}
function fromHex(hex) {
  return Ed25519Keypair.fromSecretKey(Uint8Array.from(Buffer.from(hex, 'hex')));
}

async function getDeepBalance(address) {
  const coins = await client.getCoins({ owner: address, coinType: DEEP_TYPE });
  return coins.data.reduce((s, c) => s + BigInt(c.balance), 0n);
}

async function fundWallet(mainKeypair, targetAddress) {
  const tx = new Transaction();
  const [coin] = tx.splitCoins(tx.gas, [tx.pure.u64(FUND_AMOUNT)]);
  tx.transferObjects([coin], targetAddress);
  const res = await client.signAndExecuteTransaction({ signer: mainKeypair, transaction: tx, options: { showEffects: true } });
  return res.effects.status.status === 'success';
}

async function swapAndSend(burnerKeypair) {
  const address = burnerKeypair.toSuiAddress();
  const tx = new Transaction();
  const [borrowedDeep, flashLoan] = tx.moveCall({
    target: `${DEEPBOOK_PKG}::pool::borrow_flashloan_base`,
    typeArguments: [DEEP_TYPE, SUI_TYPE],
    arguments: [tx.object(DEEP_SUI_POOL), tx.pure.u64(DEEP_FEE)],
  });
  const [suiInput] = tx.splitCoins(tx.gas, [tx.pure.u64(SUI_SWAP)]);
  const [deepOut, suiChange, deepFeeChange] = tx.moveCall({
    target: `${DEEPBOOK_PKG}::pool::swap_exact_quote_for_base`,
    typeArguments: [DEEP_TYPE, SUI_TYPE],
    arguments: [tx.object(DEEP_SUI_POOL), suiInput, borrowedDeep, tx.pure.u64(MIN_DEEP_OUT), tx.object('0x6')],
  });
  const [deepRepay] = tx.splitCoins(deepOut, [tx.pure.u64(DEEP_FEE)]);
  tx.moveCall({
    target: `${DEEPBOOK_PKG}::pool::return_flashloan_base`,
    typeArguments: [DEEP_TYPE, SUI_TYPE],
    arguments: [tx.object(DEEP_SUI_POOL), deepRepay, flashLoan],
  });
  tx.transferObjects([deepOut], MAIN_WALLET);
  tx.transferObjects([suiChange, deepFeeChange], address);
  const res = await client.signAndExecuteTransaction({ signer: burnerKeypair, transaction: tx, options: { showEffects: true } });
  return res.effects.status.status === 'success';
}

const mainKeypair = loadKeypair();
console.log('='.repeat(60));
console.log('  DEEP FARM');
console.log('='.repeat(60));
console.log(`  Main: ${mainKeypair.toSuiAddress()}`);
console.log(`  Wallets: ${NUM_WALLETS}  |  Fund each: ${Number(FUND_AMOUNT)/1e9} SUI`);
console.log();

console.log('  Generating keypairs -> burners.json ...');
const burners = [];
for (let i = 0; i < NUM_WALLETS; i++) {
  const kp = Ed25519Keypair.generate();
  burners.push({ index: i + 1, address: kp.toSuiAddress(), privateKey: toHex(kp) });
}
writeFileSync('./burners.json', JSON.stringify(burners, null, 2));
console.log('  Saved. Run recover_burners.js if anything fails.');
console.log();

const startBalance = await getDeepBalance(MAIN_WALLET);
console.log(`  Starting DEEP: ${(Number(startBalance)/1e6).toFixed(2)}`);
console.log();

let succeeded = 0, failed = 0;
for (const b of burners) {
  const kp = fromHex(b.privateKey);
  process.stdout.write(`  [${String(b.index).padStart(2,'0')}/${NUM_WALLETS}] ${b.address.slice(0,16)}... `);

  try {
    const ok = await fundWallet(mainKeypair, b.address);
    if (!ok) { console.log('x fund failed'); failed++; continue; }
  } catch (e) { console.log(`x fund: ${e.message?.slice(0,60)}`); failed++; continue; }

  await sleep(800);

  try {
    const ok = await swapAndSend(kp);
    if (!ok) { console.log('x swap failed'); failed++; continue; }
  } catch (e) { console.log(`x swap: ${e.message?.slice(0,60)}`); failed++; continue; }

  succeeded++;
  console.log('ok');
  await sleep(600);
}

await sleep(2000);
const endBalance = await getDeepBalance(MAIN_WALLET);
const gained = endBalance - startBalance;
console.log();
console.log('='.repeat(60));
console.log(`  Succeeded: ${succeeded}/${NUM_WALLETS}  Failed: ${failed}`);
console.log(`  Gained: +${(Number(gained)/1e6).toFixed(2)} DEEP`);
console.log(`  Balance: ${(Number(endBalance)/1e6).toFixed(2)} DEEP`);
if (endBalance >= 500n * DEEP_SCALAR) {
  console.log('  500+ DEEP ready for graduation!');
} else {
  console.log(`  Need ${(Number(500n*DEEP_SCALAR-endBalance)/1e6).toFixed(0)} more DEEP`);
}
if (failed > 0) console.log(`  Run: node recover_burners.js`);
console.log('='.repeat(60));
