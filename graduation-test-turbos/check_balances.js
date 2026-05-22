import { client, loadKeypair } from './config.js';

const kp = loadKeypair();
const addr = kp.toSuiAddress();
console.log('wallet:', addr);

const coins = await client.getAllCoins({ owner: addr });
for (const c of coins.data) {
  const bal = Number(BigInt(c.balance)) / 1e9;
  if (bal > 0.001) console.log(c.coinType.slice(0, 60), bal.toFixed(6));
}
