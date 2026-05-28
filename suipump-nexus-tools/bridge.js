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

import { SuiGraphQLClient } from '@mysten/sui/graphql';
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
  '0x719698e5138582d78ee95317271e8bce05769569a4f58c940a7f1b424d90ffe2', // V9
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
  '0x719698e5138582d78ee95317271e8bce05769569a4f58c940a7f1b424d90ffe2', // V9
]);

// Packages that use V9+ buy() signature (adds sui_price_scaled: u64 arg)
const V9_PLUS = new Set([
  '0x719698e5138582d78ee95317271e8bce05769569a4f58c940a7f1b424d90ffe2', // V9
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
  return new SuiGraphQLClient({ url: rpcUrl ?? process.env.SUI_GRAPHQL_URL ?? 'https://graphql.testnet.sui.io/graphql' });
}

async function resolveCurve(client, curveId) {
  // v2: objectId (not id), result at obj.object.* (not obj.data.*)
  const obj = await client.getObject({ objectId: curveId });
  if (!obj?.object) throw new Error(`Curve ${curveId} not found`);
  const curveType     = obj.object.type ?? '';
  const pkgId         = curveType.split('::')[0];
  const tokenType     = curveType.match(/Curve<(.+)>$/)?.[1];
  if (!tokenType) throw new Error(`Could not parse token type from curve ${curveId}`);
  if (!pkgId)     throw new Error(`Could not parse package ID from curve ${curveId}`);
  const sharedVersion = obj.object.owner?.Shared?.initialSharedVersion;
  if (!sharedVersion) throw new Error(`Curve ${curveId} is not a shared object`);
  return { pkgId, tokenType, sharedVersion };
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
  const isV9Plus = V9_PLUS.has(pkgId);
  const isV5Plus = V5_PLUS.has(pkgId);

  const tx       = new Transaction();
  const curveRef = tx.sharedObjectRef({ objectId: curveId, initialSharedVersion: sharedVersion, mutable: true });
  const [payment] = tx.splitCoins(tx.gas, [tx.pure.u64(suiMist)]);
  const clockRef = tx.sharedObjectRef({ objectId: SUI_CLOCK_ID, initialSharedVersion: 1, mutable: false });

  // V9: buy(curve, payment, min_out, referral, sui_price_scaled, clock)
  // V5-V8: buy(curve, payment, min_out, referral, clock)
  // V4: buy(curve, payment, min_out)
  let buyArgs;
  if (isV9Plus) {
    // Fetch live SUI price for oracle — fallback to 0 (uses stored BASE_GRAD)
    let suiPriceScaled = 0n;
    try {
      const pr = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=SUIUSDT', { signal: AbortSignal.timeout(2000) });
      if (pr.ok) { const pd = await pr.json(); const p = parseFloat(pd.price ?? '0'); if (p > 0) suiPriceScaled = BigInt(Math.floor(p * 1000)); }
    } catch {}
    buyArgs = [curveRef, payment, tx.pure.u64(minOut), tx.pure.option('address', referral ?? null), tx.pure.u64(suiPriceScaled), clockRef];
  } else if (isV5Plus) {
    buyArgs = [curveRef, payment, tx.pure.u64(minOut), tx.pure.option('address', referral ?? null), clockRef];
  } else {
    buyArgs = [curveRef, payment, tx.pure.u64(minOut)];
  }

  if (isV5Plus || isV9Plus) {
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
    include: { balanceChanges: true },
  });

  if (result.errors?.length) {
    throw new Error(`buy() failed: ${result.errors[0]?.message ?? JSON.stringify(result.errors)}`);
  }

  const balChanges = result.data?.executeTransaction?.effects?.balanceChanges ?? [];
  const normalAddr = b => b.address?.address ?? b.address;
  const normalType = b => b.coinType?.repr    ?? b.coinType;
  const tokenChange = balChanges.find(b =>
    normalAddr(b) === address && normalType(b) !== '0x2::sui::SUI'
  );

  return {
    txDigest:       result.data?.executeTransaction?.digest,
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
    include: { balanceChanges: true },
  });

  if (result.errors?.length) {
    throw new Error(`sell() failed: ${result.errors[0]?.message ?? JSON.stringify(result.errors)}`);
  }

  const balChangesSell = result.data?.executeTransaction?.effects?.balanceChanges ?? [];
  const normAddrS = b => b.address?.address ?? b.address;
  const normTypeS = b => b.coinType?.repr    ?? b.coinType;
  const suiChange = balChangesSell.find(b =>
    normAddrS(b) === address && normTypeS(b) === '0x2::sui::SUI'
  );

  return {
    txDigest:    result.data?.executeTransaction?.digest,
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
    include: { balanceChanges: true },
  });

  if (result.errors?.length) {
    throw new Error(`claim_creator_fees() failed: ${result.errors[0]?.message ?? JSON.stringify(result.errors)}`);
  }

  const balChangesClaim = result.data?.executeTransaction?.effects?.balanceChanges ?? [];
  const normAddrC = b => b.address?.address ?? b.address;
  const normTypeC = b => b.coinType?.repr    ?? b.coinType;
  const suiChangeClaim = balChangesClaim.find(b =>
    normAddrC(b) === address && normTypeC(b) === '0x2::sui::SUI'
  );

  return {
    txDigest:   result.data?.executeTransaction?.digest,
    suiClaimed: suiChangeClaim ? (Number(BigInt(suiChangeClaim.amount)) / 1e9).toFixed(6) : 'unknown',
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
    SUI_GRAPHQL_URL: rpcUrl ?? process.env.SUI_GRAPHQL_URL ?? 'https://graphql.testnet.sui.io/graphql',
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

  // v2: objectId (not id), result at obj.object.*
  const obj = await client.getObject({ objectId: curveId });
  if (!obj?.object) throw new Error(`Curve ${curveId} not found`);
  const curveTypeStatus = obj.object.type ?? '';
  const tokenType = curveTypeStatus.match(/Curve<(.+)>$/)?.[1];
  const pkgId     = curveTypeStatus.split('::')[0];

  // Fetch curve fields from indexer stats (avoids GQL content query complexity)
  let fields = {};
  try {
    const statsRes = await fetch(`${INDEXER_URL}/token/${curveId}/stats`);
    if (statsRes.ok) {
      const s = await statsRes.json();
      fields = {
        sui_reserve:    String(Math.round((s.reserve_sui   ?? 0) * 1e9)),
        token_reserve:  String(Math.round((s.token_reserve ?? 0) * 1e6)),
        creator_fees:   String(Math.round((s.creator_fees_sui ?? 0) * 1e9)),
        protocol_fees:  '0',
        airdrop_fees:   '0',
        graduated:      false,
        paused:         false,
        graduation_target: 0,
      };
    }
  } catch {}

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
