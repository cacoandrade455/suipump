// claim_fees.js — uses indexer for all data, GQL only for signing
// Usage: node scripts/claim_fees.js [CURVE_ID]

import { SuiGraphQLClient } from '@mysten/sui/graphql';
import { Transaction } from '@mysten/sui/transactions';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { fromBase64 } from '@mysten/sui/utils';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const GRAPHQL_URL = process.env.SUI_GRAPHQL_URL  ?? 'https://graphql.testnet.sui.io/graphql';
const INDEXER_URL = process.env.INDEXER_URL       ?? 'https://suipump-62s2.onrender.com';

const client = new SuiGraphQLClient({ url: GRAPHQL_URL });

const ALL_PACKAGES = [
  { ver:'V4',   id:'0x2154486dcf503bd3e8feae4fb913e862f7e2bbf4489769aff63978f55d55b4a8', adminCap:'0xfc80d407147af9445d7042a6a538524b5a483cc995fdbf0c795ce7eab506b6f9' },
  { ver:'V5',   id:'0x785c0604cb6c60a8547501e307d2b0ca7a586ff912c8abff4edfb88db65b7236', adminCap:'0xfc80d407147af9445d7042a6a538524b5a483cc995fdbf0c795ce7eab506b6f9' },
  { ver:'V6',   id:'0x21d5b1284d5f1d4d14214654f414ffca20c757ee9f9db7701d3ffaaac62cd768', adminCap:'0xfc80d407147af9445d7042a6a538524b5a483cc995fdbf0c795ce7eab506b6f9' },
  { ver:'V7',   id:'0xfb8f3f3e4e8d53130ac140906eebea6b6740bfaf0c971aec607fbc723be951f0', adminCap:'0x1dc44030adaa6e366666a8e095fc29a5a55c8ae614f04c5e93c062a85b475527' },
  { ver:'V8_1', id:'0x145a1e79b83cc17680dbfe4f96839cd359c7db380ac15463ecb6dc30f9849b69', adminCap:'0x9779a2466f2e30ca5e139f636cc9ca1c44e025da29203d781cc2645ebb62bb35' },
  { ver:'V8',   id:'0xbb4ee050239f59dfd983501ce101698ba27857f77aff2d437cec568fe0062546', adminCap:'0x9779a2466f2e30ca5e139f636cc9ca1c44e025da29203d781cc2645ebb62bb35' },
  { ver:'V9',   id:'0x719698e5138582d78ee95317271e8bce05769569a4f58c940a7f1b424d90ffe2', adminCap:'0x2e0989604424ffa96f58618795285dac09d8eaf2fd0d35f4a7e9bbc22bea2bf7' },
];
const V7_PLUS = new Set(ALL_PACKAGES.slice(3).map(p => p.id));
// V9 changed the claim signature: claim_protocol_fees / claim_airdrop_fees no
// longer RETURN the Coin<SUI> — they transfer it to the tx sender internally
// (transfer::public_transfer(coin, sender)). So for V9 we must NOT collect or
// transfer their result (it has no return value); calling moveCall is enough.
// V4–V8 return the coin, so we still collect + transferObjects those.
const V9_SELF_TRANSFER = new Set([
  '0x719698e5138582d78ee95317271e8bce05769569a4f58c940a7f1b424d90ffe2', // V9
]);
function fmtSui(mist) { return (Number(mist)/1e9).toFixed(4)+' SUI'; }

function loadKeypair() {
  if (process.env.SUI_PRIVATE_KEY) {
    const raw = fromBase64(process.env.SUI_PRIVATE_KEY);
    return Ed25519Keypair.fromSecretKey(raw.length > 32 ? raw.slice(1) : raw);
  }
  const keys = JSON.parse(readFileSync(join(homedir(),'.sui','sui_config','sui.keystore'),'utf-8'));
  return Ed25519Keypair.fromSecretKey(fromBase64(keys[0]).slice(1));
}

function resolvePackage(typeStr) {
  return ALL_PACKAGES.find(p => typeStr?.includes(p.id)) ?? null;
}
function resolvePackage2(packageId) {
  return ALL_PACKAGES.find(p => p.id === packageId) ?? ALL_PACKAGES.at(-1);
}

async function fetchJson(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

// Get on-chain fees directly via raw GQL fetch (bypasses SDK wrapper).
// NOTE: the Sui GraphQL schema moved `type` under asMoveObject.contents and
// changed the Object shape — the old query (`type { repr }` + `owner` on the
// Object) now fails validation, returning data:null, which silently zeroed every
// fee. This query only uses fields the live schema actually exposes.
async function fetchOnChainFees(curveId) {
  const query = `{ object(address: "${curveId}") { asMoveObject { contents { type { repr } json } } } }`;
  const r = await fetch(GRAPHQL_URL, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }), signal: AbortSignal.timeout(10000),
  });
  const result = await r.json();
  if (result?.errors?.length) {
    // Surface the schema error instead of silently returning zeroes.
    throw new Error(`GraphQL: ${result.errors[0]?.message ?? 'query failed'}`);
  }
  const mo = result?.data?.object?.asMoveObject?.contents;
  if (!mo) return null;
  const json = mo.json ?? {};
  // Token type from the on-chain type repr — always accurate.
  const typeRepr = mo.type?.repr ?? '';
  const onChainTokenType = typeRepr.match(/Curve<(.+)>$/)?.[1] ?? null;
  return {
    protocolFees:     BigInt(json.protocol_fees ?? 0),
    airdropFees:      BigInt(json.airdrop_fees  ?? 0),
    name:             json.name   ?? '?',
    symbol:           json.symbol ?? '?',
    onChainTokenType,
    onChainTypeRepr:  typeRepr,
  };
}

// Fetch the curve's initialSharedVersion via a separate, schema-safe query.
// (Kept separate so a change to the owner shape can never null the fee read.)
async function fetchSharedVersion(curveId) {
  try {
    const query = `{ object(address: "${curveId}") { owner { __typename ... on Shared { initialSharedVersion } } } }`;
    const r = await fetch(GRAPHQL_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }), signal: AbortSignal.timeout(10000),
    });
    const result = await r.json();
    if (result?.errors?.length) return null;
    return result?.data?.object?.owner?.initialSharedVersion ?? null;
  } catch { return null; }
}

// ── Main ──────────────────────────────────────────────────────────────────────

const keypair = loadKeypair();
const address = keypair.toSuiAddress();
const specificCurve = process.argv[2] ?? null;

console.log('━'.repeat(60));
console.log('  SUIPUMP — collect protocol + airdrop fees');
console.log('━'.repeat(60));
console.log(`  wallet:  ${address}`);
console.log(`  indexer: ${INDEXER_URL}\n`);

// Get curve list from indexer
let tokens;
if (specificCurve) {
  // fetch single token info
  tokens = [await fetchJson(`${INDEXER_URL}/token/${specificCurve}`)];
} else {
  console.log('  Fetching all curves from indexer...');
  tokens = await fetchJson(`${INDEXER_URL}/tokens`);
  console.log(`  Found ${tokens.length} curves\n`);
}

let totalClaimed = 0n, claimCount = 0, skipped = 0;

for (const token of tokens) {
  const curveId   = token.curveId ?? token.curve_id;
  const packageId = token.packageId ?? token.package_id;
  const tokenType = token.tokenType ?? token.token_type;
  const isv       = token.initialSharedVersion ?? token.initial_shared_version ?? null;
  const name      = token.name ?? '?';
  const symbol    = token.symbol ?? '?';

  if (!curveId || !packageId || !tokenType) { skipped++; continue; }

  try {
    // Fetch real on-chain fees
    const fees = await fetchOnChainFees(curveId);
    if (!fees) { process.stdout.write('.'); continue; }

    const { protocolFees, airdropFees } = fees;
    const resolvedTokenType = fees.onChainTokenType ?? tokenType;
    // isv: prefer the indexer's value (already fetched), else a dedicated GQL read.
    const resolvedIsv = isv ?? await fetchSharedVersion(curveId);
    const pkg = resolvePackage(fees.onChainTypeRepr) ?? resolvePackage2(packageId);
    const claimAmt = protocolFees + (V7_PLUS.has(pkg.id) ? airdropFees : 0n);

    if (claimAmt === 0n) { process.stdout.write('.'); continue; }

    console.log(`\n  ${name} ($${symbol})`);
    console.log(`    protocol: ${fmtSui(protocolFees)}${V7_PLUS.has(pkg.id) ? `  airdrop: ${fmtSui(airdropFees)}` : ''}`);
    console.log(`    → claiming ${fmtSui(claimAmt)}...`);

    const tx = new Transaction();
    const curveRef = resolvedIsv
      ? tx.sharedObjectRef({ objectId: curveId, initialSharedVersion: Number(resolvedIsv), mutable: true })
      : tx.object(curveId);

    const isV9 = V9_SELF_TRANSFER.has(pkg.id);
    const coins = [];

    if (protocolFees > 0n) {
      const r = tx.moveCall({ target:`${pkg.id}::bonding_curve::claim_protocol_fees`, typeArguments:[resolvedTokenType], arguments:[tx.object(pkg.adminCap), curveRef] });
      // V9 transfers internally (no return); only collect for V4–V8 which return the coin.
      if (!isV9) coins.push(r);
    }
    if (V7_PLUS.has(pkg.id) && airdropFees > 0n) {
      const r = tx.moveCall({ target:`${pkg.id}::bonding_curve::claim_airdrop_fees`,  typeArguments:[resolvedTokenType], arguments:[tx.object(pkg.adminCap), curveRef] });
      if (!isV9) coins.push(r);
    }
    // Only transfer the returned coins (V4–V8). For V9 the contract already sent
    // the fees to the signer, so there is nothing to transfer here.
    if (coins.length > 0) tx.transferObjects(coins, address);

    tx.setSender(address);
    const builtTx = await tx.build({ client });
    const { signature } = await keypair.signTransaction(builtTx);
    const execRes = await client.executeTransaction({ transaction: builtTx, signatures: [signature] });

    if (execRes?.errors?.length) {
      console.log(`    ❌ ${execRes.errors[0]?.message}`);
    } else {
      const digest = execRes?.data?.executeTransaction?.digest ?? '?';
      console.log(`    ✓ ${digest}`);
      console.log(`    https://testnet.suivision.xyz/txblock/${digest}`);
      totalClaimed += claimAmt;
      claimCount++;
    }

    await new Promise(r => setTimeout(r, 400));

  } catch(e) {
    console.log(`\n  ❌ ${curveId?.slice(0,16)}...: ${e.message}`);
  }
}

console.log('\n'+'━'.repeat(60));
console.log(`  Done — ${claimCount} claimed · ${skipped} skipped · ${fmtSui(totalClaimed)} total`);
console.log('━'.repeat(60));
