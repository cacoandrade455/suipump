// suipump-nexus-tools/bridge.js
// HTTP bridge between Nexus Rust tool servers (port 8080) and the Sui blockchain.
// Nexus → Rust (8080) → this bridge (3030) → Sui RPC
//
// Endpoints:
//   POST /buy    — buy tokens on a bonding curve
//   POST /sell   — sell tokens on a bonding curve
//   POST /claim  — claim creator fees
//   POST /launch — launch a new token (delegates to scripts/launch.js logic)
//   POST /status — read curve state snapshot
//
// Environment:
//   SUI_PRIVATE_KEY      — base64WithFlag Ed25519 key for the agent wallet
//   SUI_RPC_URL          — default: testnet fullnode
//   SUIPUMP_INDEXER_URL  — indexer base URL (for curve lookups)
//   PORT                 — default: 3030

import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SuiClient, getFullnodeUrl } from '@mysten/sui/client';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';
import { fromBase64 } from '@mysten/sui/utils';

const __dirname     = path.dirname(fileURLToPath(import.meta.url));
const execFileAsync = promisify(execFile);
const PORT          = parseInt(process.env.PORT ?? '3030', 10);
const INDEXER_URL   = process.env.SUIPUMP_INDEXER_URL ?? 'https://suipump-62s2.onrender.com';

// ── Package IDs (all versions — read paths) ───────────────────────────────────
const ALL_PACKAGE_IDS = [
  '0x2154486dcf503bd3e8feae4fb913e862f7e2bbf4489769aff63978f55d55b4a8', // V4
  '0x785c0604cb6c60a8547501e307d2b0ca7a586ff912c8abff4edfb88db65b7236', // V5
  '0x21d5b1284d5f1d4d14214654f414ffca20c757ee9f9db7701d3ffaaac62cd768', // V6
  '0xfb8f3f3e4e8d53130ac140906eebea6b6740bfaf0c971aec607fbc723be951f0', // V7
  '0x145a1e79b83cc17680dbfe4f96839cd359c7db380ac15463ecb6dc30f9849b69', // V8_1
  '0xbb4ee050239f59dfd983501ce101698ba27857f77aff2d437cec568fe0062546', // V8
  // V9 added after upgrade deploy
];

// Packages that use V5+ buy() signature (with referral + clock)
const V5_PLUS = new Set([
  '0x785c0604cb6c60a8547501e307d2b0ca7a586ff912c8abff4edfb88db65b7236', // V5
  '0x21d5b1284d5f1d4d14214654f414ffca20c757ee9f9db7701d3ffaaac62cd768', // V6
  '0xfb8f3f3e4e8d53130ac140906eebea6b6740bfaf0c971aec607fbc723be951f0', // V7
  '0x145a1e79b83cc17680dbfe4f96839cd359c7db380ac15463ecb6dc30f9849b69', // V8_1
  '0xbb4ee050239f59dfd983501ce101698ba27857f77aff2d437cec568fe0062546', // V8
]);

// Packages that use V7+ sell() signature (with referral arg)
const V7_PLUS = new Set([
  '0xfb8f3f3e4e8d53130ac140906eebea6b6740bfaf0c971aec607fbc723be951f0', // V7
  '0x145a1e79b83cc17680dbfe4f96839cd359c7db380ac15463ecb6dc30f9849b69', // V8_1
  '0xbb4ee050239f59dfd983501ce101698ba27857f77aff2d437cec568fe0062546', // V8
]);

const SUI_CLOCK_ID = '0x6';
const MIST_PER_SUI = 1_000_000_000n;

// ── Helpers ───────────────────────────────────────────────────────────────────
function loadKeypair(privateKey) {
  const raw = privateKey ?? process.env.SUI_PRIVATE_KEY;
  if (!raw) throw new Error('No private key — set SUI_PRIVATE_KEY or pass privateKey in body');
  const bytes = fromBase64(raw);
  const seed  = (bytes.length === 65 || bytes.length === 33) ? bytes.slice(1) : bytes;
  return Ed25519Keypair.fromSecretKey(seed);
}

function makeClient(rpcUrl) {
  return new SuiClient({ url: rpcUrl ?? process.env.SUI_RPC_URL ?? getFullnodeUrl('testnet') });
}

async function resolveCurve(client, curveId) {
  const obj = await client.getObject({ id: curveId, options: { showContent: true, showType: true, showOwner: true } });
  if (!obj.data) throw new Error(`Curve ${curveId} not found`);
  const curveType = obj.data.type;
  const pkgId     = curveType?.split('::')[0];
  const tokenType = curveType?.match(/Curve<(.+)>$/)?.[1];
  if (!tokenType) throw new Error(`Could not parse token type from curve ${curveId}`);
  if (!pkgId)     throw new Error(`Could not parse package ID from curve ${curveId}`);
  const sharedVersion = obj.data.owner?.Shared?.initial_shared_version;
  if (!sharedVersion) throw new Error(`Curve ${curveId} is not a shared object`);
  return { pkgId, tokenType, fields: obj.data.content?.fields ?? {}, sharedVersion };
}

function jsonResp(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function parseBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); }
      catch { reject(new Error('Invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

// ── Handler: /buy ─────────────────────────────────────────────────────────────
// Body: { curveId, amountMist?, suiAmount?, minTokensOut?, referral?, privateKey?, rpcUrl? }
//
// FIELD RESOLUTION (accepts both for backwards compat):
//   amountMist  — u64 MIST integer sent by the Rust tool (buy.rs)
//   suiAmount   — float SUI sent by direct curl / manual calls
// At least one must be present.
async function handleBuy(body) {
  const { curveId, amountMist, suiAmount, minTokensOut, referral, privateKey, rpcUrl } = body;
  if (!curveId) throw new Error('curveId required');

  // Resolve spend amount to MIST bigint — accept either field
  let suiMist;
  if (amountMist != null) {
    // Rust sends this as a u64 integer representing MIST
    suiMist = BigInt(amountMist);
  } else if (suiAmount != null) {
    // Direct curl calls send float SUI
    suiMist = BigInt(Math.floor(parseFloat(suiAmount) * Number(MIST_PER_SUI)));
  } else {
    throw new Error('amountMist (u64 MIST) or suiAmount (float SUI) required');
  }

  if (suiMist <= 0n) throw new Error('Spend amount must be > 0');

  const client   = makeClient(rpcUrl);
  const keypair  = loadKeypair(privateKey);
  const address  = keypair.toSuiAddress();

  const { pkgId, tokenType, sharedVersion } = await resolveCurve(client, curveId);

  const minOut   = BigInt(minTokensOut ?? 0);
  const isV5Plus = V5_PLUS.has(pkgId);

  const tx       = new Transaction();
  const curveRef = tx.sharedObjectRef({ objectId: curveId, initialSharedVersion: sharedVersion, mutable: true });
  const [payment] = tx.splitCoins(tx.gas, [tx.pure.u64(suiMist)]);
  const clockRef = tx.sharedObjectRef({ objectId: SUI_CLOCK_ID, initialSharedVersion: 1, mutable: false });

  const buyArgs = isV5Plus
    ? [curveRef, payment, tx.pure.u64(minOut), tx.pure.option('address', referral ?? null), clockRef]
    : [curveRef, payment, tx.pure.u64(minOut)];

  if (isV5Plus) {
    const [tokens, refund] = tx.moveCall({
      target: `${pkgId}::bonding_curve::buy`,
      typeArguments: [tokenType],
      arguments: buyArgs,
    });
    tx.transferObjects([tokens, refund], address);
  } else {
    // V4: buy returns a single result tuple — transfer directly
    const results = tx.moveCall({
      target: `${pkgId}::bonding_curve::buy`,
      typeArguments: [tokenType],
      arguments: buyArgs,
    });
    tx.transferObjects([results], address);
  }

  const result = await client.signAndExecuteTransaction({
    signer: keypair, transaction: tx,
    options: { showEffects: true, showBalanceChanges: true },
  });

  if (result.effects.status.status !== 'success') {
    throw new Error(`buy() failed: ${result.effects.status.error}`);
  }

  const tokenChange = result.balanceChanges?.find(b =>
    b.owner?.AddressOwner === address && b.coinType !== '0x2::sui::SUI'
  );

  return {
    txDigest:       result.digest,
    suiSpent:       (Number(suiMist) / Number(MIST_PER_SUI)).toFixed(9),
    tokensReceived: tokenChange ? (Number(BigInt(tokenChange.amount)) / 1e6).toFixed(6) : 'unknown',
    tokenType,
  };
}

// ── Handler: /sell ────────────────────────────────────────────────────────────
// Body: { curveId, tokenAmount, minSuiOut?, referral?, privateKey?, rpcUrl? }
async function handleSell(body) {
  const { curveId, tokenAmount, minSuiOut, referral, privateKey, rpcUrl } = body;
  if (!curveId)     throw new Error('curveId required');
  if (!tokenAmount) throw new Error('tokenAmount required (in whole tokens, e.g. 1000)');

  const client   = makeClient(rpcUrl);
  const keypair  = loadKeypair(privateKey);
  const address  = keypair.toSuiAddress();

  const { pkgId, tokenType, sharedVersion } = await resolveCurve(client, curveId);

  const tokAtomic = BigInt(Math.floor(parseFloat(tokenAmount) * 1e6));
  const minOut    = BigInt(minSuiOut ?? 0);
  const isV5Plus  = V5_PLUS.has(pkgId);
  const isV7Plus  = V7_PLUS.has(pkgId);

  const coins    = await client.getCoins({ owner: address, coinType: tokenType });
  if (!coins.data.length) throw new Error(`No ${tokenType} balance in agent wallet`);

  const tx       = new Transaction();
  const curveRef = tx.sharedObjectRef({ objectId: curveId, initialSharedVersion: sharedVersion, mutable: true });
  const coinObjs = coins.data.map(c => tx.object(c.coinObjectId));

  let tokenCoin;
  if (coinObjs.length === 1) {
    [tokenCoin] = tx.splitCoins(coinObjs[0], [tx.pure.u64(tokAtomic)]);
  } else {
    tx.mergeCoins(coinObjs[0], coinObjs.slice(1));
    [tokenCoin] = tx.splitCoins(coinObjs[0], [tx.pure.u64(tokAtomic)]);
  }

  const sellArgs = isV7Plus
    ? [curveRef, tokenCoin, tx.pure.u64(minOut), tx.pure.option('address', referral ?? null)]
    : [curveRef, tokenCoin, tx.pure.u64(minOut)];

  const [suiOut] = tx.moveCall({
    target: `${pkgId}::bonding_curve::sell`,
    typeArguments: [tokenType],
    arguments: sellArgs,
  });
  tx.transferObjects([suiOut], address);

  const result = await client.signAndExecuteTransaction({
    signer: keypair, transaction: tx,
    options: { showEffects: true, showBalanceChanges: true },
  });

  if (result.effects.status.status !== 'success') {
    throw new Error(`sell() failed: ${result.effects.status.error}`);
  }

  const suiChange = result.balanceChanges?.find(b =>
    b.owner?.AddressOwner === address && b.coinType === '0x2::sui::SUI'
  );

  return {
    txDigest:    result.digest,
    tokensSold:  tokenAmount,
    suiReceived: suiChange ? (Number(BigInt(suiChange.amount)) / 1e9).toFixed(6) : 'unknown',
  };
}

// ── Handler: /claim ───────────────────────────────────────────────────────────
// Body: { curveId, privateKey?, rpcUrl? }
async function handleClaim(body) {
  const { curveId, privateKey, rpcUrl } = body;
  if (!curveId) throw new Error('curveId required');

  const client   = makeClient(rpcUrl);
  const keypair  = loadKeypair(privateKey);
  const address  = keypair.toSuiAddress();

  const { pkgId, tokenType, sharedVersion } = await resolveCurve(client, curveId);

  // Search all package versions for CreatorCap — curve may be on any version
  let cap = null;
  for (const pkg of ALL_PACKAGE_IDS) {
    const caps = await client.getOwnedObjects({
      owner: address,
      filter: { StructType: `${pkg}::bonding_curve::CreatorCap` },
      options: { showContent: true },
    });
    cap = caps.data.find(o => o.data?.content?.fields?.curve_id === curveId);
    if (cap) break;
  }
  if (!cap) throw new Error(`No CreatorCap found in agent wallet for curve ${curveId}`);

  const tx       = new Transaction();
  const curveRef = tx.sharedObjectRef({ objectId: curveId, initialSharedVersion: sharedVersion, mutable: true });

  tx.moveCall({
    target: `${pkgId}::bonding_curve::claim_creator_fees`,
    typeArguments: [tokenType],
    arguments: [tx.object(cap.data.objectId), curveRef],
  });

  const result = await client.signAndExecuteTransaction({
    signer: keypair, transaction: tx,
    options: { showEffects: true, showBalanceChanges: true },
  });

  if (result.effects.status.status !== 'success') {
    throw new Error(`claim_creator_fees() failed: ${result.effects.status.error}`);
  }

  const suiChange = result.balanceChanges?.find(b =>
    b.owner?.AddressOwner === address && b.coinType === '0x2::sui::SUI'
  );

  return {
    txDigest:   result.digest,
    suiClaimed: suiChange ? (Number(BigInt(suiChange.amount)) / 1e9).toFixed(6) : 'unknown',
  };
}

// ── Handler: /launch ──────────────────────────────────────────────────────────
// Body: { name, symbol, description?, iconUrl?, devBuySui?, graduationTarget?, antiBotDelay?, privateKey?, rpcUrl? }
async function handleLaunch(body) {
  const { name, symbol, description, iconUrl, devBuySui, graduationTarget, antiBotDelay, privateKey, rpcUrl } = body;
  if (!name)   throw new Error('name required');
  if (!symbol) throw new Error('symbol required');

  const pk = privateKey ?? process.env.SUI_PRIVATE_KEY;
  if (!pk) throw new Error('No private key — set SUI_PRIVATE_KEY or pass privateKey in body');

  const scriptPath = path.resolve(__dirname, '../scripts/launch.js');

  const dexMap = { 0: 'cetus', 1: 'deepbook', 2: 'turbos' };
  const dex    = dexMap[graduationTarget ?? 2] ?? 'turbos';

  const cliArgs = [
    '--name',    name,
    '--symbol',  symbol.toUpperCase(),
    '--dex',     dex,
    '--antibot', String(antiBotDelay ?? 0),
  ];
  if (description) cliArgs.push('--desc', description);
  if (iconUrl)     cliArgs.push('--icon', iconUrl);
  if (devBuySui && parseFloat(devBuySui) > 0) cliArgs.push('--buy', String(devBuySui));

  const env = {
    ...process.env,
    SUI_PRIVATE_KEY: pk,
    SUI_RPC_URL: rpcUrl ?? process.env.SUI_RPC_URL ?? getFullnodeUrl('testnet'),
  };

  console.log(`[bridge] /launch: ${symbol} via ${dex}`);

  const { stdout, stderr } = await execFileAsync(
    'node', [scriptPath, ...cliArgs],
    { env, timeout: 180_000 }
  );

  if (stderr && !stdout) throw new Error(stderr.trim());

  const lines  = stdout.trim().split('\n').filter(Boolean);

  let result = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    try { result = JSON.parse(lines[i]); break; } catch {}
  }

  if (!result) {
    const digestMatch = stdout.match(/digest[:\s]+([A-Za-z0-9]{40,})/i);
    const curveMatch  = stdout.match(/curve[:\s]+(0x[a-f0-9]{60,})/i);
    const typeMatch   = stdout.match(/token type[:\s]+(0x[^\s]+)/i);
    result = {
      txDigest:  digestMatch?.[1] ?? 'see logs',
      curveId:   curveMatch?.[1]  ?? 'see logs',
      tokenType: typeMatch?.[1]   ?? 'see logs',
      output:    lines.slice(-5).join('\n'),
    };
  }

  return result;
}

// ── Handler: /status ─────────────────────────────────────────────────────────
// Body: { curveId, rpcUrl? }
async function handleStatus(body) {
  const { curveId, rpcUrl } = body;
  if (!curveId) throw new Error('curveId required');

  const client = makeClient(rpcUrl);
  const obj = await client.getObject({ id: curveId, options: { showContent: true, showType: true } });
  if (!obj.data) throw new Error(`Curve ${curveId} not found`);

  const fields    = obj.data.content?.fields ?? {};
  const tokenType = obj.data.type?.match(/Curve<(.+)>$/)?.[1];
  const pkgId     = obj.data.type?.split('::')?.[0];

  const suiReserveMist     = BigInt(fields.sui_reserve    ?? 0);
  const tokenReserveAtomic = BigInt(fields.token_reserve  ?? 0);
  const creatorFeesMist    = BigInt(fields.creator_fees   ?? 0);
  const protocolFeesMist   = BigInt(fields.protocol_fees  ?? 0);
  const airdropFeesMist    = BigInt(fields.airdrop_fees   ?? 0);
  const graduated          = fields.graduated  ?? false;
  const paused             = fields.paused     ?? false;
  const gradTarget         = fields.graduation_target ?? 0;

  const VS_MIST            = 3_500n * MIST_PER_SUI;
  const VT_ATOMIC          = 1_000_000_000_000n; // 1M tokens * 1e6
  const GRAD_THRESHOLD_MIST = 9_000n * MIST_PER_SUI;

  const effectiveSui   = suiReserveMist + VS_MIST;
  const effectiveTok   = tokenReserveAtomic + VT_ATOMIC;
  const priceInSui     = effectiveTok > 0n
    ? Number(effectiveSui) / Number(effectiveTok)
    : 0;
  const totalSupply    = 1_000_000_000n * 1_000_000n; // 1B * 1e6
  const mcapSui        = priceInSui * Number(totalSupply);
  const gradPct        = suiReserveMist > 0n
    ? (Number(suiReserveMist) / Number(GRAD_THRESHOLD_MIST)) * 100
    : 0;

  const dexNames = { 0: 'Cetus', 1: 'DeepBook', 2: 'Turbos' };

  // Enrich from indexer (best-effort)
  let name = fields.name ?? null;
  let symbol = null;
  let tradeCount = null;
  try {
    const r = await fetch(`${INDEXER_URL}/token/${curveId}`);
    if (r.ok) {
      const d = await r.json();
      name       = d.name       ?? name;
      symbol     = d.symbol     ?? null;
      tradeCount = d.tradeCount ?? d.trade_count ?? null;
    }
  } catch {}

  return {
    curveId,
    tokenType,
    pkgId,
    name,
    symbol,
    graduated,
    paused,
    graduationTarget:    dexNames[gradTarget] ?? 'Unknown',
    suiReserveSui:       Number(suiReserveMist)     / 1e9,
    tokenRemainingHuman: Number(tokenReserveAtomic) / 1e6,
    creatorFeesSui:      Number(creatorFeesMist)    / 1e9,
    protocolFeesSui:     Number(protocolFeesMist)   / 1e9,
    airdropFeesSui:      Number(airdropFeesMist)    / 1e9,
    priceInSui:          priceInSui.toFixed(10),
    mcapSui:             mcapSui.toFixed(2),
    gradThresholdSui:    Number(GRAD_THRESHOLD_MIST) / 1e9,
    gradPercent:         gradPct.toFixed(2),
    tradeCount,
    checkedAtMs:         Date.now(),
  };
}

// ── HTTP server ───────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  if (req.method !== 'POST') {
    jsonResp(res, 405, { error: 'Method not allowed — use POST' });
    return;
  }

  let body;
  try {
    body = await parseBody(req);
  } catch (e) {
    jsonResp(res, 400, { error: e.message });
    return;
  }

  try {
    let result;
    switch (req.url) {
      case '/buy':    result = await handleBuy(body);    break;
      case '/sell':   result = await handleSell(body);   break;
      case '/claim':  result = await handleClaim(body);  break;
      case '/launch': result = await handleLaunch(body); break;
      case '/status': result = await handleStatus(body); break;
      case '/health': result = { status: 'ok', ts: Date.now() }; break;
      default:
        jsonResp(res, 404, { error: `Unknown endpoint: ${req.url}` });
        return;
    }
    jsonResp(res, 200, { ok: true, ...result });
  } catch (err) {
    console.error(`[bridge] ${req.url} error:`, err.message);
    jsonResp(res, 500, { ok: false, error: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`[bridge] SuiPump bridge listening on port ${PORT}`);
  console.log(`[bridge] Indexer: ${INDEXER_URL}`);
  console.log(`[bridge] Endpoints: /buy /sell /claim /launch /status /health`);
});

export { handleBuy, handleSell, handleClaim, handleLaunch };
