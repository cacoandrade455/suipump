// recover_burners.js — sweeps all SUI + DEEP from burners.json back to main
// Usage: node recover_burners.js  (place in graduation-test/)

import { Transaction } from '@mysten/sui/transactions';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { readFileSync } from 'node:fs';
import { client } from './config.js';

const DEEP_TYPE   = '0x36dbef866a1d62bf7328989a10fb2f07d769f4ee587c0de4a0a256e57e0a58a8::deep::DEEP';
const SUI_TYPE    = '0x2::sui::SUI';
const MAIN_WALLET = '0x0be9a8f56ba3b07f295e0c7526e7f47ca3a146649b9d864d2eb47bf3acd90c55';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function fromHex(hex) {
  return Ed25519Keypair.fromSecretKey(Uint8Array.from(Buffer.from(hex, 'hex')));
}

let burners;
try {
  burners = JSON.parse(readFileSync('./burners.json', 'utf-8'));
} catch {
  console.error('burners.json not found');
  process.exit(1);
}

console.log('='.repeat(60));
console.log(`  RECOVER BURNERS — ${burners.length} wallets`);
console.log('='.repeat(60));

let recovered = 0, empty = 0, failed = 0;

for (const b of burners) {
  const kp = fromHex(b.privateKey);
  process.stdout.write(`  [${String(b.index).padStart(2,'0')}] ${b.address.slice(0,16)}... `);

  try {
    const [suiCoins, deepCoins] = await Promise.all([
      client.getCoins({ owner: b.address, coinType: SUI_TYPE }),
      client.getCoins({ owner: b.address, coinType: DEEP_TYPE }),
    ]);

    const suiBal  = suiCoins.data.reduce((s,c) => s + BigInt(c.balance), 0n);
    const deepBal = deepCoins.data.reduce((s,c) => s + BigInt(c.balance), 0n);

    if (suiBal < 10_000_000n && deepBal === 0n) { console.log('empty'); empty++; continue; }

    const tx = new Transaction();

    if (deepCoins.data.length > 0) {
      const objs = deepCoins.data.map(c => tx.object(c.coinObjectId));
      if (objs.length > 1) tx.mergeCoins(objs[0], objs.slice(1));
      tx.transferObjects([objs[0]], MAIN_WALLET);
    }

    // Transfer gas coin remainder to main (SDK sends leftover after fees)
    tx.transferObjects([tx.gas], MAIN_WALLET);

    const res = await client.signAndExecuteTransaction({ signer: kp, transaction: tx, options: { showEffects: true } });
    if (res.effects.status.status === 'success') {
      recovered++;
      console.log(`ok  ${(Number(suiBal)/1e9).toFixed(2)} SUI  ${(Number(deepBal)/1e6).toFixed(2)} DEEP`);
    } else {
      console.log('x tx failed'); failed++;
    }
  } catch (e) {
    console.log(`x ${e.message?.slice(0,60)}`); failed++;
  }

  await sleep(400);
}

console.log();
console.log('='.repeat(60));
console.log(`  Recovered: ${recovered}  Empty: ${empty}  Failed: ${failed}`);
console.log('='.repeat(60));
