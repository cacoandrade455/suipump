// bridge.js — SuiPump execution bridge
// Thin Node.js HTTP server that receives commands from the Rust Nexus tools
// and executes them using the existing SuiPump PTB logic.
//
// Run: node bridge.js
// Port: 3030

import 'dotenv/config';
import http from 'node:http';
import { SuiClient, getFullnodeUrl } from '@mysten/sui/client';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';
import { fromB64 } from '@mysten/sui/utils';

const PORT = parseInt(process.env.BRIDGE_PORT || '3030');

// ── Keypair from env ──────────────────────────────────────────────────────────
function loadKeypair(privateKeyB64) {
  const raw = fromB64(privateKeyB64);
  return Ed25519Keypair.fromSecretKey(raw[0] === 0x00 ? raw.slice(1) : raw);
}

// ── SUI constants ─────────────────────────────────────────────────────────────
const PACKAGE_ID = process.env.SUIPUMP_PACKAGE_ID ||
  '0xbb4ee050239f59dfd983501ce101698ba27857f77aff2d437cec568fe0062546';
const CLOCK_ID = '0x0000000000000000000000000000000000000000000000000000000000000006';
const MIST = 1_000_000_000n;
const TOKEN_DECIMALS = 1_000_000n;

// ── Helpers ───────────────────────────────────────────────────────────────────
async function getSharedVersion(client, objectId) {
  const obj = await client.getObject({ id: objectId, options: { showOwner: true } });
  return obj.data?.owner?.Shared?.initial_shared_version;
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try { resolve(JSON.parse(body)); }
      catch (e) { reject(e); }
    });
  });
}

function jsonResp(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

// ── Handlers ──────────────────────────────────────────────────────────────────

async function handleBuy(body) {
  const { curveId, amountMist, slippageBps = 200, referrer, rpcUrl, privateKey } = body;
  const client = new SuiClient({ url: rpcUrl || getFullnodeUrl('testnet') });
  const keypair = loadKeypair(privateKey);

  const sv = await getSharedVersion(client, curveId);
  const tx = new Transaction();
  const payment = tx.splitCoins(tx.gas, [tx.pure.u64(BigInt(amountMist))]);
  const minTokens = 0n; // slippage handled by caller

  const [tokens, refund] = tx.moveCall({
    target: `${PACKAGE_ID}::bonding_curve::buy`,
    typeArguments: [], // filled dynamically — need token type
    arguments: [
      tx.sharedObjectRef({ objectId: curveId, initialSharedVersion: sv, mutable: true }),
      payment,
      tx.pure.u64(minTokens),
      referrer ? tx.pure.address(referrer) : tx.pure.option('address', null),
      tx.object(CLOCK_ID),
    ],
  });

  tx.transferObjects([tokens, refund], tx.pure.address(keypair.toSuiAddress()));

  const result = await client.signAndExecuteTransaction({
    signer: keypair, transaction: tx,
    options: { showEffects: true, showObjectChanges: true },
  });

  if (result.effects.status.status !== 'success') {
    throw new Error(`buy() failed: ${result.effects.status.error}`);
  }

  return {
    txDigest: result.digest,
    tokensReceived: 0, // TODO: parse from object changes
    suiSpent: amountMist / 1e9,
  };
}

async function handleSell(body) {
  const { curveId, tokenType, amountBase, slippageBps = 200, referrer, rpcUrl, privateKey } = body;
  const client = new SuiClient({ url: rpcUrl || getFullnodeUrl('testnet') });
  const keypair = loadKeypair(privateKey);

  // Get token coins for this wallet
  const coins = await client.getCoins({ owner: keypair.toSuiAddress(), coinType: tokenType });
  if (!coins.data.length) throw new Error('No token coins found in wallet');

  const sv = await getSharedVersion(client, curveId);
  const tx = new Transaction();

  // Merge all token coins into one if multiple
  let tokenCoin = tx.object(coins.data[0].coinObjectId);
  if (coins.data.length > 1) {
    tx.mergeCoins(tokenCoin, coins.data.slice(1).map(c => tx.object(c.coinObjectId)));
  }
  const [sellCoin] = tx.splitCoins(tokenCoin, [tx.pure.u64(BigInt(amountBase))]);

  const [sui, refund] = tx.moveCall({
    target: `${PACKAGE_ID}::bonding_curve::sell`,
    typeArguments: [tokenType],
    arguments: [
      tx.sharedObjectRef({ objectId: curveId, initialSharedVersion: sv, mutable: true }),
      sellCoin,
      tx.pure.u64(0n), // min SUI out
      referrer ? tx.pure.address(referrer) : tx.pure.option('address', null),
      tx.object(CLOCK_ID),
    ],
  });

  tx.transferObjects([sui, refund], tx.pure.address(keypair.toSuiAddress()));

  const result = await client.signAndExecuteTransaction({
    signer: keypair, transaction: tx,
    options: { showEffects: true },
  });

  if (result.effects.status.status !== 'success') {
    throw new Error(`sell() failed: ${result.effects.status.error}`);
  }

  return {
    txDigest: result.digest,
    suiReceived: 0, // TODO: parse from balance changes
  };
}

async function handleClaim(body) {
  const { curveId, tokenType, rpcUrl, privateKey } = body;
  const client = new SuiClient({ url: rpcUrl || getFullnodeUrl('testnet') });
  const keypair = loadKeypair(privateKey);

  // Find CreatorCap
  const objs = await client.getOwnedObjects({
    owner: keypair.toSuiAddress(),
    filter: { StructType: `${PACKAGE_ID}::bonding_curve::CreatorCap` },
    options: { showContent: true },
  });

  const cap = objs.data.find(o => o.data?.content?.fields?.curve_id === curveId);
  if (!cap) throw new Error(`No CreatorCap found for curve ${curveId}`);

  const sv = await getSharedVersion(client, curveId);
  const tx = new Transaction();

  const suiCoin = tx.moveCall({
    target: `${PACKAGE_ID}::bonding_curve::claim_creator_fees`,
    typeArguments: [tokenType],
    arguments: [
      tx.object(cap.data.objectId),
      tx.sharedObjectRef({ objectId: curveId, initialSharedVersion: sv, mutable: true }),
    ],
  });

  tx.transferObjects([suiCoin], tx.pure.address(keypair.toSuiAddress()));

  const result = await client.signAndExecuteTransaction({
    signer: keypair, transaction: tx,
    options: { showEffects: true, showBalanceChanges: true },
  });

  if (result.effects.status.status !== 'success') {
    throw new Error(`claim_creator_fees() failed: ${result.effects.status.error}`);
  }

  const suiChange = result.balanceChanges?.find(b =>
    b.owner?.AddressOwner === keypair.toSuiAddress() && b.coinType === '0x2::sui::SUI'
  );

  return {
    txDigest: result.digest,
    suiClaimed: suiChange ? Number(BigInt(suiChange.amount)) / 1e9 : 0,
  };
}

async function handleLaunch(body) {
  // Launch delegates to the existing launch.js script via child_process
  // This is the most complex PTB (bytecode patching + publish + create_with_launch_fee)
  // We shell out to Node to reuse the existing tested logic
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execFileAsync = promisify(execFile);

  const scriptPath = new URL(
    process.env.SUIPUMP_SCRIPTS_PATH || '../scripts/launch.js',
    import.meta.url
  ).pathname;

  const env = {
    ...process.env,
    LAUNCH_NAME: body.name,
    LAUNCH_SYMBOL: body.symbol,
    LAUNCH_DESCRIPTION: body.description || '',
    LAUNCH_ICON_URL: body.iconUrl || '',
    LAUNCH_DEV_BUY_MIST: String(body.devBuyMist || 0),
    LAUNCH_GRAD_TARGET: String(body.graduationTarget || 0),
    LAUNCH_ANTI_BOT: String(body.antiBotDelay || 0),
    SUI_RPC_URL: body.rpcUrl || process.env.SUI_RPC_URL || getFullnodeUrl('testnet'),
    SUI_PRIVATE_KEY: body.privateKey || process.env.SUI_PRIVATE_KEY,
  };

  const { stdout, stderr } = await execFileAsync('node', [scriptPath], { env });
  if (stderr && !stdout) throw new Error(stderr);

  const result = JSON.parse(stdout.trim().split('\n').pop());
  return result;
}

// ── Server ────────────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  if (req.method !== 'POST') {
    jsonResp(res, 405, { error: 'Method not allowed' });
    return;
  }

  try {
    const body = await parseBody(req);
    let result;

    switch (req.url) {
      case '/buy':    result = await handleBuy(body);    break;
      case '/sell':   result = await handleSell(body);   break;
      case '/claim':  result = await handleClaim(body);  break;
      case '/launch': result = await handleLaunch(body); break;
      default:
        jsonResp(res, 404, { error: 'Not found' });
        return;
    }

    jsonResp(res, 200, result);
  } catch (err) {
    console.error('Bridge error:', err.message);
    jsonResp(res, 500, { error: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`SuiPump bridge listening on port ${PORT}`);
});
