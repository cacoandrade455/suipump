// suipump-nexus-tools/bridge.js
// HTTP bridge between Nexus Rust tool servers (port 8080) and the Sui blockchain.
// Nexus → Rust (8080) → this bridge (3030) → Sui RPC
//
// Endpoints:
//   POST /buy    — buy tokens on a bonding curve
//   POST /sell   — sell tokens on a bonding curve
//   POST /claim  — claim creator fees
//   POST /launch — launch a new token (native two-tx flow: publish + create_and_return)
//   POST /status — read curve state snapshot
//
// Environment:
//   SUI_PRIVATE_KEY      — base64WithFlag Ed25519 key for the agent wallet
//   SUI_RPC_URL          — default: testnet fullnode
//   SUIPUMP_INDEXER_URL  — indexer base URL (for curve lookups)
//   PORT                 — default: 3030

import http from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SuiGraphQLClient } from '@mysten/sui/graphql';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';
import { bcs } from '@mysten/sui/bcs';
import { fromBase64 } from '@mysten/sui/utils';
import * as bytecodeTemplate from '@mysten/move-bytecode-template';

const __dirname     = path.dirname(fileURLToPath(import.meta.url));
const PORT          = parseInt(process.env.PORT ?? '3030', 10);
const INDEXER_URL   = process.env.SUIPUMP_INDEXER_URL ?? 'https://suipump-62s2.onrender.com';

// ── Write-endpoint auth ───────────────────────────────────────────────────────
// /buy /sell /launch /claim mutate state and SPEND THE AGENT WALLET'S SUI. They
// must only be reachable by our own server-side callers (the Vercel agent proxy
// and the strategy brain), never by a random browser or a direct curl. We gate
// them behind a shared secret sent as `x-agent-key`. The key lives ONLY in the
// bridge env and in the callers' server-side envs — it is NEVER shipped to the
// browser. Reads (/status /health) stay open. If AGENT_API_KEY is unset the gate
// is OPEN (local dev) but we log a loud warning so it's never silently open in
// production.
const AGENT_API_KEY = process.env.AGENT_API_KEY ?? '';
const WRITE_ENDPOINTS = new Set(['/buy', '/sell', '/launch', '/claim', '/session-buy', '/session-sell']);

// ── Active package for NEW launches (V10) ─────────────────────────────────────
const ACTIVE_PACKAGE_ID = process.env.ACTIVE_PACKAGE_ID
  ?? '0x2deda2cade65cd5afd5ffbe799d48f2491debf08d3aef6fa11aa6e1c8afe1598'; // V10
const LAUNCH_FEE_MIST   = 2_000_000_000n; // 2 SUI

// Compiled coin template bytecode — force-included in repo for the bridge.
// Override with TEMPLATE_MV_PATH if the build path differs on the host.
const TEMPLATE_MV_PATH = process.env.TEMPLATE_MV_PATH
  ?? path.resolve(__dirname, '../coin-template/build/coin_template/bytecode_modules/template.mv');

// Placeholders baked into coin-template/sources/template.move — must match EXACTLY.
const PLACEHOLDER_NAME = 'Template Coin';
const PLACEHOLDER_SYM  = 'TMPL';
const PLACEHOLDER_DESC = 'Template description placeholder that is intentionally long to accommodate real token descriptions.';
const PLACEHOLDER_ICON = 'https://suipump.test/icon-placeholder.png';

// BCS-encode a string as vector<u8> for update_constants — matches scripts/launch.js.
// Single-byte ULEB128 length prefix (values are short; assert < 128 bytes).
function bcsBytes(str) {
  const buf = new TextEncoder().encode(str);
  if (buf.length > 127) throw new Error(`Constant "${str.slice(0, 30)}…" too long for single-byte length (${buf.length} bytes)`);
  return Uint8Array.from([buf.length, ...buf]);
}

let _wasmReady = false;
async function ensureWasm() {
  if (_wasmReady) return;
  // @mysten/move-bytecode-template exposes a default init() that loads the WASM.
  if (typeof bytecodeTemplate.default === 'function') {
    await bytecodeTemplate.default();
  } else if (typeof bytecodeTemplate.init === 'function') {
    await bytecodeTemplate.init();
  }
  _wasmReady = true;
}

// Retry transient node/GraphQL failures (simulate/build/index races on public testnet).
function isTransient(err) {
  const m = String(err?.message ?? err);
  return m.includes('simulateTransaction did not return')
      || m.includes('not found')
      || m.includes('fetch failed')
      || m.includes('timeout')
      || m.includes('ECONN')
      || m.includes('503')
      || m.includes('502')
      || m.includes('429');
}

async function withRetry(label, fn, { tries = 4, delayMs = 2500 } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < tries && isTransient(err)) {
        console.log(`[bridge] ${label}: transient error (attempt ${attempt}/${tries}) — ${String(err?.message ?? err).slice(0, 120)}; retrying in ${delayMs}ms`);
        await new Promise(r => setTimeout(r, delayMs));
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

// ── Package IDs (all versions — read paths) ───────────────────────────────────
const ALL_PACKAGE_IDS = [
  '0x2154486dcf503bd3e8feae4fb913e862f7e2bbf4489769aff63978f55d55b4a8', // V4
  '0x785c0604cb6c60a8547501e307d2b0ca7a586ff912c8abff4edfb88db65b7236', // V5
  '0x21d5b1284d5f1d4d14214654f414ffca20c757ee9f9db7701d3ffaaac62cd768', // V6
  '0xfb8f3f3e4e8d53130ac140906eebea6b6740bfaf0c971aec607fbc723be951f0', // V7
  '0x145a1e79b83cc17680dbfe4f96839cd359c7db380ac15463ecb6dc30f9849b69', // V8_1
  '0xbb4ee050239f59dfd983501ce101698ba27857f77aff2d437cec568fe0062546', // V8
  '0x719698e5138582d78ee95317271e8bce05769569a4f58c940a7f1b424d90ffe2', // V9
  '0x2deda2cade65cd5afd5ffbe799d48f2491debf08d3aef6fa11aa6e1c8afe1598', // V10
];
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
  '0x2deda2cade65cd5afd5ffbe799d48f2491debf08d3aef6fa11aa6e1c8afe1598', // V10
]);

// Packages that use V9+ buy() signature (adds sui_price_scaled: u64 arg)
const V9_PLUS = new Set([
  '0x719698e5138582d78ee95317271e8bce05769569a4f58c940a7f1b424d90ffe2', // V9
  '0x2deda2cade65cd5afd5ffbe799d48f2491debf08d3aef6fa11aa6e1c8afe1598', // V10
]);

// Packages that use V10+ claim_creator_fees() signature (adds clock: &Clock arg)
const V10_PLUS = new Set([
  '0x2deda2cade65cd5afd5ffbe799d48f2491debf08d3aef6fa11aa6e1c8afe1598', // V10
]);

const SUI_CLOCK_ID = '0x6';
const MIST_PER_SUI = 1_000_000_000n;

// ── Result readback (deployed SDK shape) ──────────────────────────────────────
// signAndExecuteTransaction returns a discriminated union:
//   { $kind: 'Transaction',       Transaction:       { digest, status, balanceChanges, ... } }  // success
//   { $kind: 'FailedTransaction', FailedTransaction: { status: { error } } }                    // failure
// (Confirmed by logging the live result.) Earlier code read .data.executeTransaction.*,
// which is undefined here — that is why txDigest came back null and amounts "unknown".
function txOk(result) {
  return result?.$kind === 'Transaction' || result?.Transaction?.status?.success === true;
}
function txErrorOf(result) {
  return result?.FailedTransaction?.status?.error
      ?? result?.Transaction?.status?.error
      ?? (result?.errors?.length ? result.errors[0]?.message ?? JSON.stringify(result.errors) : null)
      ?? null;
}
function txDigestOf(result) {
  return result?.Transaction?.digest
      ?? result?.FailedTransaction?.digest
      ?? result?.transaction?.digest
      ?? result?.digest
      ?? result?.data?.executeTransaction?.digest
      ?? null;
}
function balanceChangesOf(result) {
  return result?.Transaction?.balanceChanges
      ?? result?.transaction?.balanceChanges
      ?? result?.balanceChanges
      ?? result?.data?.executeTransaction?.effects?.balanceChanges
      ?? [];
}
// BalanceChange is flat { address, coinType, amount } here; tolerate nested too.
const bcAddr = b => (typeof b.address === 'string' ? b.address : b.address?.address) ?? null;
const bcType = b => (typeof b.coinType === 'string' ? b.coinType : b.coinType?.repr) ?? null;
// SUI's coinType may be the short '0x2::sui::SUI' or the zero-padded
// '0x0000...0002::sui::SUI'. Match either so token vs SUI changes aren't confused.
const isSui = t => typeof t === 'string' && /^0x0*2::sui::SUI$/.test(t);

// ── Helpers ───────────────────────────────────────────────────────────────────
function loadKeypair(privateKey) {
  const raw = privateKey ?? process.env.SUI_PRIVATE_KEY;
  if (!raw) throw new Error('No private key — set SUI_PRIVATE_KEY or pass privateKey in body');
  const bytes = fromBase64(raw);
  const seed  = (bytes.length === 65 || bytes.length === 33) ? bytes.slice(1) : bytes;
  return Ed25519Keypair.fromSecretKey(seed);
}

function makeClient(rpcUrl) {
  const GQL_DEFAULT = process.env.SUI_GRAPHQL_URL ?? 'https://graphql.testnet.sui.io/graphql';
  // The Nexus Rust tools pass rpcUrl as a JSON-RPC fullnode URL
  // (e.g. https://fullnode.testnet.sui.io). A SuiGraphQLClient pointed at a
  // JSON-RPC endpoint cannot simulate ("simulateTransaction did not return
  // resolved transaction data"). Only honor rpcUrl if it's a GraphQL endpoint.
  const looksGraphQL = typeof rpcUrl === 'string' && /graphql/i.test(rpcUrl);
  const url = looksGraphQL ? rpcUrl : GQL_DEFAULT;
  return new SuiGraphQLClient({ url });
}

async function resolveCurve(client, curveId, { tries = 6, delayMs = 2000 } = {}) {
  // A read-only resolution — safe to retry. When buy runs immediately after a
  // launch (DAG launch->buy edge), the brand-new curve may not be resolvable
  // via GraphQL yet, so getObject returns nothing and buy would error. Retrying
  // the READ (never a transaction) lets the just-created curve settle.
  let lastErr;
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
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
    } catch (err) {
      lastErr = err;
      if (attempt < tries) {
        console.log(`[bridge] resolveCurve ${curveId}: not ready (attempt ${attempt}/${tries}) — ${String(err?.message ?? err)}`);
        await new Promise(r => setTimeout(r, delayMs));
      }
    }
  }
  throw lastErr ?? new Error(`Curve ${curveId} could not be resolved`);
}

// Resolve an AgentSession shared object — returns its package id, the session
// owner, and the initialSharedVersion needed to build a sharedObjectRef. Read-
// only, retryable (a freshly opened session may lag GraphQL by a beat).
async function resolveSession(client, sessionId, { tries = 6, delayMs = 2000 } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      const obj = await client.getObject({ objectId: sessionId });
      if (!obj?.object) throw new Error(`Session ${sessionId} not found`);
      const sType = obj.object.type ?? '';
      const pkgId = sType.split('::')[0];
      if (!sType.includes('::agent_session::AgentSession')) {
        throw new Error(`Object ${sessionId} is not an AgentSession`);
      }
      const sharedVersion = obj.object.owner?.Shared?.initialSharedVersion;
      if (!sharedVersion) throw new Error(`Session ${sessionId} is not a shared object`);
      return { pkgId, sharedVersion };
    } catch (err) {
      lastErr = err;
      if (attempt < tries) {
        console.log(`[bridge] resolveSession ${sessionId}: not ready (attempt ${attempt}/${tries}) — ${String(err?.message ?? err)}`);
        await new Promise(r => setTimeout(r, delayMs));
      }
    }
  }
  throw lastErr ?? new Error(`Session ${sessionId} could not be resolved`);
}


  res.writeHead(status, {
    'Content-Type': 'application/json',
    // CORS — the agent UI (suipump.org) calls these endpoints from the browser.
    // Without these headers the browser blocks the response and fetch() throws
    // "Failed to fetch" even when the bridge settled the trade server-side.
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  });
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

// ── Buy idempotency (kills the Leader retry-after-timeout double-fire) ─────────
// The Nexus Leader uses at-least-once delivery: if the buy tool responds slowly or
// the response fails verification, the Leader re-invokes the buy tool, which POSTs
// a SECOND identical /buy to this bridge -> a second real on-chain tx (two distinct
// digests). buy.rs forwards no Nexus executionId, so we dedupe on the request
// identity { address, curveId, amountMist, referral } within a short TTL window.
//
//   - In-flight: a duplicate that arrives while the first buy is still running
//     awaits the SAME promise and returns the SAME digest (no second tx).
//   - Recently-completed: a duplicate within BUY_IDEMPOTENCY_TTL_MS returns the
//     cached result (no second tx).
//   - After the TTL expires the key is dropped, so a genuinely new buy of the same
//     amount/curve later is NOT blocked (legitimate repeat buys still work).
//
// The double-fires are seconds apart (retry signature), so a short TTL is correct.
const BUY_IDEMPOTENCY_TTL_MS = Number(process.env.BUY_IDEMPOTENCY_TTL_MS ?? 90_000);
const _buyInflight  = new Map(); // key -> Promise<result>
const _buyCompleted = new Map(); // key -> { result, ts }

// Per-process identity — lets us tell if Render is running >1 bridge instance
// (in-memory dedupe only works within a single process; if /health returns
// different bootIds across calls, the dedupe MUST move to a shared store).
const BRIDGE_BOOT_ID = Math.random().toString(36).slice(2, 10);
const BRIDGE_BOOT_TS = Date.now();

function buyIdemKey({ address, curveId, amountMist, referral }) {
  return `buy:${address}:${curveId}:${String(amountMist)}:${referral ?? ''}`;
}

function _sweepBuyCache() {
  const now = Date.now();
  for (const [k, v] of _buyCompleted) {
    if (now - v.ts > BUY_IDEMPOTENCY_TTL_MS) _buyCompleted.delete(k);
  }
}

// ── Handler: /buy ─────────────────────────────────────────────────────────────
// Body: { curveId, amountMist?, suiAmount?, minTokensOut?, referral?, privateKey?, rpcUrl? }
//
// FIELD RESOLUTION (accepts both for backwards compat):
//   amountMist  — u64 MIST integer sent by the Rust tool (buy.rs)
//   suiAmount   — float SUI sent by direct curl / manual calls
// At least one must be present.
//
// handleBuy is the idempotency gate; executeBuy holds the unchanged buy logic.
async function handleBuy(body) {
  const { curveId, amountMist, suiAmount, referral, privateKey, rpcUrl } = body;
  if (!curveId) throw new Error('curveId required');

  // Resolve spend amount to MIST for the key (mirrors executeBuy's resolution).
  let keyMist;
  if (amountMist != null)      keyMist = BigInt(amountMist);
  else if (suiAmount != null)  keyMist = BigInt(Math.floor(parseFloat(suiAmount) * Number(MIST_PER_SUI)));
  else throw new Error('amountMist (u64 MIST) or suiAmount (float SUI) required');

  // Address is needed for the key; derive it the same way executeBuy does.
  const address = loadKeypair(privateKey).toSuiAddress();
  const key     = buyIdemKey({ address, curveId, amountMist: keyMist, referral });

  _sweepBuyCache();

  // Recently-completed duplicate -> return cached result, do NOT fire again.
  const done = _buyCompleted.get(key);
  if (done && Date.now() - done.ts <= BUY_IDEMPOTENCY_TTL_MS) {
    console.log(`[bridge] /buy idempotent HIT (completed) key=${key} -> returning cached digest ${done.result?.txDigest}`);
    return { ...done.result, idempotent: 'cached' };
  }

  // In-flight duplicate -> await the SAME promise, do NOT fire again.
  const inflight = _buyInflight.get(key);
  if (inflight) {
    console.log(`[bridge] /buy idempotent HIT (in-flight) key=${key} -> awaiting original`);
    const result = await inflight;
    return { ...result, idempotent: 'inflight' };
  }

  // First-seen -> execute, record in-flight, cache on completion.
  const promise = executeBuy(body)
    .then(result => {
      _buyCompleted.set(key, { result, ts: Date.now() });
      return result;
    })
    .finally(() => {
      _buyInflight.delete(key);
    });

  _buyInflight.set(key, promise);
  return promise;
}

async function executeBuy(body) {
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
    // V4: buy(curve, payment, min_out) returns (Coin<T>, Coin<SUI>) — TWO values,
    // same as V5+/V9 (verified on-chain via sui_getNormalizedMoveFunction). The
    // earlier code passed the whole result as a single object to transferObjects,
    // which Sui rejects with "expected a single result but found multiple".
    // Destructure both and transfer both, exactly like the V5+/V9 branch.
    const [tokens, refund] = tx.moveCall({
      target: `${pkgId}::bonding_curve::buy`,
      typeArguments: [tokenType],
      arguments: buyArgs,
    });
    tx.transferObjects([tokens, refund], address);
  }

  const result = await (async () => {
    try {
      return await client.signAndExecuteTransaction({
        signer: keypair, transaction: tx,
        include: { balanceChanges: true },
      });
    } catch (e) {
      // The SDK wraps simulation failures as a generic "Failed to simulate
      // transaction". Surface the underlying Move/validation reason (abort code,
      // insufficient gas/balance, slippage, version) so the real cause is visible.
      const detail = e?.cause?.message ?? e?.cause ?? e?.message ?? String(e);
      throw new Error(`buy simulate/execute failed: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
    }
  })();

  if (!txOk(result)) {
    throw new Error(`buy() failed: ${txErrorOf(result) ?? 'transaction failed'}`);
  }

  const balChanges = balanceChangesOf(result);
  const tokenChange = balChanges.find(b =>
    bcAddr(b) === address && !isSui(bcType(b))
  );

  return {
    txDigest:       txDigestOf(result),
    suiSpent:       (Number(suiMist) / Number(MIST_PER_SUI)).toFixed(9),
    tokensReceived: tokenChange ? (Number(BigInt(tokenChange.amount)) / 1e6).toFixed(6) : 'unknown',
    tokenType,
    bootId:         BRIDGE_BOOT_ID,
  };
}

// ── Handler: /sell ────────────────────────────────────────────────────────────
// Body: { curveId, tokenAmount, minSuiOut?, referral?, privateKey?, rpcUrl? }
async function handleSell(body) {
  const { curveId, tokenAmount, minSuiOut, referral, privateKey, rpcUrl, sellAll } = body;
  if (!curveId) throw new Error('curveId required');

  // Sell-all is requested via sellAll:true OR tokenAmount:"all"/"max" (case-insensitive).
  const wantAll = sellAll === true
    || (typeof tokenAmount === 'string' && /^(all|max)$/i.test(tokenAmount.trim()));
  if (!wantAll && !tokenAmount) {
    throw new Error('tokenAmount required (whole tokens, e.g. 1000) or sellAll:true / tokenAmount:"all"');
  }

  const client   = makeClient(rpcUrl);
  const keypair  = loadKeypair(privateKey);
  const address  = keypair.toSuiAddress();

  const { pkgId, tokenType, sharedVersion } = await resolveCurve(client, curveId);

  const minOut    = BigInt(minSuiOut ?? 0);
  const isV5Plus  = V5_PLUS.has(pkgId);
  const isV7Plus  = V7_PLUS.has(pkgId);

  // Source token coins via client.listCoins(...).objects — the exact call your own
  // working frontend uses on this deployed SDK (TokenPage.jsx, useCopyTrade.js,
  // useRebalance.js: "SuiGraphQLClient 2.x: listCoins, result.objects, c.objectId").
  // The bridge was calling client.getCoins(...), which does not exist on this client
  // ("is not a function") -> sell threw before the Move call -> dry sell. Buys are
  // unaffected: they split payment from tx.gas and never query coins.
  const coinsRes = await client.listCoins({ owner: address, coinType: tokenType });
  const coinList = coinsRes?.objects ?? coinsRes?.data ?? [];
  if (!coinList.length) throw new Error(`No ${tokenType} balance in agent wallet`);

  // Total atomic balance across all coins (CoinResponse.balance is a string of atomic units).
  const totalAtomic = coinList.reduce((s, c) => s + BigInt(c.balance ?? c.coinBalance ?? 0), 0n);

  // Partial sell amount (whole tokens -> atomic). For sell-all we ignore this and
  // sell the entire merged coin, so the on-chain balance and the sold amount can
  // never drift (no dust left, no rounding mismatch).
  const tokAtomic = wantAll ? totalAtomic : BigInt(Math.floor(parseFloat(tokenAmount) * 1e6));
  if (tokAtomic <= 0n) throw new Error(`No ${tokenType} balance to sell`);
  if (!wantAll && tokAtomic > totalAtomic) {
    throw new Error(`Insufficient balance: requested ${tokenAmount} but wallet holds ${(Number(totalAtomic) / 1e6).toFixed(6)} whole tokens`);
  }

  const tx       = new Transaction();
  tx.setSender(address);
  const curveRef = tx.sharedObjectRef({ objectId: curveId, initialSharedVersion: sharedVersion, mutable: true });
  const coinObjs = coinList.map(c => tx.object(c.objectId ?? c.id ?? c.coinObjectId));

  // Merge all coins into the first so we have a single coin to work with.
  if (coinObjs.length > 1) tx.mergeCoins(coinObjs[0], coinObjs.slice(1));

  // Sell-all: pass the entire merged coin by value (sell consumes its full balance).
  // Partial: split off the exact amount and sell that.
  let tokenCoin;
  if (wantAll) {
    tokenCoin = coinObjs[0];
  } else {
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

  let result;
  try {
    result = await client.signAndExecuteTransaction({
      signer: keypair, transaction: tx,
      include: { balanceChanges: true },
    });
  } catch (e) {
    // The SDK wraps simulation failures as a generic "Failed to simulate transaction".
    // Surface the underlying Move/validation reason so the real cause is visible.
    const detail = e?.cause?.message ?? e?.cause ?? e?.message ?? String(e);
    throw new Error(`sell simulate/execute failed: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
  }

  if (!txOk(result)) {
    throw new Error(`sell() failed: ${txErrorOf(result) ?? 'transaction failed'}`);
  }

  const balChangesSell = balanceChangesOf(result);
  const suiChange = balChangesSell.find(b =>
    bcAddr(b) === address && isSui(bcType(b))
  );

  return {
    txDigest:    txDigestOf(result),
    tokensSold:  (Number(tokAtomic) / 1e6).toFixed(6),
    suiReceived: suiChange ? (Number(BigInt(suiChange.amount)) / 1e9).toFixed(6) : 'unknown',
  };
}

// ── Handler: /session-buy ─────────────────────────────────────────────────────
// Buy on a curve using an AgentSession's escrow, signed by the SESSION key.
// Unlike /buy, no payment coin is split and no tokens are transferred: the
// contract draws `amount` SUI from escrow and parks bought tokens on the session.
// Body: { sessionId, curveId, amountMist | suiAmount, minTokensOut?, privateKey, rpcUrl? }
//   privateKey here is the SESSION keypair (sender == session_address), not the
//   protocol agent wallet. The session must authorize this address on-chain.
async function handleSessionBuy(body) {
  const { sessionId, curveId, amountMist, suiAmount, minTokensOut, privateKey, rpcUrl } = body;
  if (!sessionId) throw new Error('sessionId required');
  if (!curveId)   throw new Error('curveId required');

  let suiMist;
  if (amountMist != null) {
    suiMist = BigInt(amountMist);
  } else if (suiAmount != null) {
    suiMist = BigInt(Math.floor(parseFloat(suiAmount) * Number(MIST_PER_SUI)));
  } else {
    throw new Error('amountMist (u64 MIST) or suiAmount (float SUI) required');
  }
  if (suiMist <= 0n) throw new Error('Spend amount must be > 0');

  const client  = makeClient(rpcUrl);
  const keypair = loadKeypair(privateKey);
  const address = keypair.toSuiAddress();

  const { pkgId, tokenType, sharedVersion } = await resolveCurve(client, curveId);
  const { sharedVersion: sessVersion }      = await resolveSession(client, sessionId);
  const minOut = BigInt(minTokensOut ?? 0);

  // buy_with_session<T>(session, curve, amount, min_tokens_out, sui_price_scaled, clock, ctx)
  // Always the V9+ shape — V10 is the only package with sessions, and it carries
  // the oracle price arg. Fetch live SUI price (fallback 0 -> stored BASE_GRAD).
  let suiPriceScaled = 0n;
  try {
    const pr = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=SUIUSDT', { signal: AbortSignal.timeout(2000) });
    if (pr.ok) { const pd = await pr.json(); const p = parseFloat(pd.price ?? '0'); if (p > 0) suiPriceScaled = BigInt(Math.floor(p * 1000)); }
  } catch {}

  const tx = new Transaction();
  tx.setSender(address);
  const sessionRef = tx.sharedObjectRef({ objectId: sessionId, initialSharedVersion: sessVersion, mutable: true });
  const curveRef   = tx.sharedObjectRef({ objectId: curveId,   initialSharedVersion: sharedVersion, mutable: true });
  const clockRef   = tx.sharedObjectRef({ objectId: SUI_CLOCK_ID, initialSharedVersion: 1, mutable: false });

  tx.moveCall({
    target: `${pkgId}::agent_session::buy_with_session`,
    typeArguments: [tokenType],
    arguments: [sessionRef, curveRef, tx.pure.u64(suiMist), tx.pure.u64(minOut), tx.pure.u64(suiPriceScaled), clockRef],
  });

  let result;
  try {
    result = await client.signAndExecuteTransaction({
      signer: keypair, transaction: tx,
      include: { balanceChanges: true },
    });
  } catch (e) {
    const detail = e?.cause?.message ?? e?.cause ?? e?.message ?? String(e);
    throw new Error(`session buy simulate/execute failed: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
  }

  if (!txOk(result)) {
    throw new Error(`buy_with_session() failed: ${txErrorOf(result) ?? 'transaction failed'}`);
  }

  return {
    txDigest:  txDigestOf(result),
    sessionId,
    suiSpent:  (Number(suiMist) / Number(MIST_PER_SUI)).toFixed(9),
    tokenType,
    bootId:    BRIDGE_BOOT_ID,
  };
}

// ── Handler: /session-sell ────────────────────────────────────────────────────
// Sell session-held tokens of a curve back into the session's escrow, signed by
// the SESSION key. No coin sourcing: the contract sells from tokens already
// parked on the session by prior session-buys. Proceeds compound into escrow.
// Body: { sessionId, curveId, tokenAmount, minSuiOut?, privateKey, rpcUrl? }
//   tokenAmount is whole tokens (scaled by 1e6 to atomic on-chain).
async function handleSessionSell(body) {
  const { sessionId, curveId, tokenAmount, minSuiOut, privateKey, rpcUrl } = body;
  if (!sessionId)   throw new Error('sessionId required');
  if (!curveId)     throw new Error('curveId required');
  if (!tokenAmount) throw new Error('tokenAmount required (whole tokens, e.g. 1000)');

  const client  = makeClient(rpcUrl);
  const keypair = loadKeypair(privateKey);
  const address = keypair.toSuiAddress();

  const { pkgId, tokenType, sharedVersion } = await resolveCurve(client, curveId);
  const { sharedVersion: sessVersion }      = await resolveSession(client, sessionId);

  const tokAtomic = BigInt(Math.floor(parseFloat(tokenAmount) * 1e6));
  if (tokAtomic <= 0n) throw new Error('tokenAmount must be > 0');
  const minOut = BigInt(minSuiOut ?? 0);

  const tx = new Transaction();
  tx.setSender(address);
  const sessionRef = tx.sharedObjectRef({ objectId: sessionId, initialSharedVersion: sessVersion, mutable: true });
  const curveRef   = tx.sharedObjectRef({ objectId: curveId,   initialSharedVersion: sharedVersion, mutable: true });
  const clockRef   = tx.sharedObjectRef({ objectId: SUI_CLOCK_ID, initialSharedVersion: 1, mutable: false });

  // sell_with_session<T>(session, curve, token_amount, min_sui_out, clock, ctx)
  tx.moveCall({
    target: `${pkgId}::agent_session::sell_with_session`,
    typeArguments: [tokenType],
    arguments: [sessionRef, curveRef, tx.pure.u64(tokAtomic), tx.pure.u64(minOut), clockRef],
  });

  let result;
  try {
    result = await client.signAndExecuteTransaction({
      signer: keypair, transaction: tx,
      include: { balanceChanges: true },
    });
  } catch (e) {
    const detail = e?.cause?.message ?? e?.cause ?? e?.message ?? String(e);
    throw new Error(`session sell simulate/execute failed: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
  }

  if (!txOk(result)) {
    throw new Error(`sell_with_session() failed: ${txErrorOf(result) ?? 'transaction failed'}`);
  }

  return {
    txDigest:   txDigestOf(result),
    sessionId,
    tokensSold: (Number(tokAtomic) / 1e6).toFixed(6),
    tokenType,
    bootId:     BRIDGE_BOOT_ID,
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

  // Find the CreatorCap this wallet holds for this curve. The curve may be on
  // any package version, so we match the CreatorCap struct type across all
  // versions AND the cap's curve_id field.
  //
  // SDK NOTES (verified against @mysten/sui types):
  //  • This client is a SuiGraphQLClient — the method is `listOwnedObjects`, NOT
  //    `getOwnedObjects` (JSON-RPC only; calling it threw "is not a function"
  //    and claim never settled — same class of bug fixed earlier for sell).
  //  • listOwnedObjects returns 20 objects PER PAGE; this wallet holds ~188
  //    objects incl. 44 CreatorCaps, so we MUST paginate via `res.cursor` /
  //    `res.hasNextPage` until the cap is found.
  //  • By default the response carries only objectId/version/digest/owner/type —
  //    NO struct fields. To read `curve_id` we pass `include: { json: true }`,
  //    which adds `object.json` = the Move struct fields as JSON. So the cap's
  //    curve id is at `o.json.curve_id`.
  let capObjectId = null;
  let cursor = null;
  for (let page = 0; page < 200 && !capObjectId; page++) {
    const ownedRes = await client.listOwnedObjects(
      cursor
        ? { owner: address, include: { json: true }, cursor }
        : { owner: address, include: { json: true } }
    );
    const owned = ownedRes?.objects ?? ownedRes?.data ?? [];
    for (const o of owned) {
      const type = o.type ?? '';
      if (!type.includes('::bonding_curve::CreatorCap')) continue;
      // CreatorCap matched by type — confirm it is THIS curve's cap.
      const cid = o.json?.curve_id ?? o.json?.curveId ?? null;
      if (cid === curveId) { capObjectId = o.objectId ?? null; break; }
    }
    cursor = ownedRes?.cursor ?? null;
    const hasNext = ownedRes?.hasNextPage ?? false;
    if (!hasNext || !cursor) break;
  }
  if (!capObjectId) throw new Error(`No CreatorCap found in agent wallet for curve ${curveId}`);

  const tx       = new Transaction();
  const curveRef = tx.sharedObjectRef({ objectId: curveId, initialSharedVersion: sharedVersion, mutable: true });

  // V10 added clock: &Clock to claim_creator_fees(cap, curve, clock, ctx).
  // V4-V9: claim_creator_fees(cap, curve, ctx).
  const claimArgs = V10_PLUS.has(pkgId)
    ? [tx.object(capObjectId), curveRef, tx.object(SUI_CLOCK_ID)]
    : [tx.object(capObjectId), curveRef];

  tx.moveCall({
    target: `${pkgId}::bonding_curve::claim_creator_fees`,
    typeArguments: [tokenType],
    arguments: claimArgs,
  });

  const result = await client.signAndExecuteTransaction({
    signer: keypair, transaction: tx,
    include: { balanceChanges: true },
  });

  if (!txOk(result)) {
    throw new Error(`claim_creator_fees() failed: ${txErrorOf(result) ?? 'transaction failed'}`);
  }

  const balChangesClaim = balanceChangesOf(result);
  const suiChangeClaim = balChangesClaim.find(b =>
    bcAddr(b) === address && isSui(bcType(b))
  );

  return {
    txDigest:   txDigestOf(result),
    suiClaimed: suiChangeClaim ? (Number(BigInt(suiChangeClaim.amount)) / 1e9).toFixed(6) : 'unknown',
  };
}

// ── Handler: /launch ──────────────────────────────────────────────────────────
// Body: { name, symbol, description?, iconUrl?, devBuySui?, graduationTarget?, antiBotDelay?, privateKey?, rpcUrl? }
async function handleLaunch(body) {
  const { name, symbol, description, iconUrl, devBuySui, graduationTarget, antiBotDelay, privateKey, rpcUrl } = body;
  if (!name)   throw new Error('name required');
  if (!symbol) throw new Error('symbol required');

  const client   = makeClient(rpcUrl);
  const keypair  = loadKeypair(privateKey);
  const address  = keypair.toSuiAddress();

  const pkgId        = ACTIVE_PACKAGE_ID;            // new launches always on the active (V10) package
  const isV9         = V9_PLUS.has(pkgId);           // V10 ∈ V9_PLUS — buy() uses sui_price_scaled arg
  const gradTarget   = Number(graduationTarget ?? 2); // 0=Cetus 1=DeepBook 2=Turbos
  const antiBot      = Number(antiBotDelay ?? 0);
  const tokenName    = String(name).trim();
  const tokenSymbol  = String(symbol).trim().toUpperCase();
  const moduleName   = tokenSymbol.toLowerCase();    // identifier: module is lowercased symbol, witness is TEMPLATE→symbol
  // Description is BCS-patched into a fixed constant; keep within the placeholder's length budget.
  const rawDesc      = String(description ?? `${tokenName} — launched via SuiPump agent`).trim();
  const tokenDesc    = rawDesc.slice(0, PLACEHOLDER_DESC.length);
  const tokenIcon    = String(iconUrl ?? PLACEHOLDER_ICON).slice(0, PLACEHOLDER_ICON.length);
  const devBuyMist   = devBuySui && parseFloat(devBuySui) > 0
    ? BigInt(Math.floor(parseFloat(devBuySui) * Number(MIST_PER_SUI)))
    : 0n;

  console.log(`[bridge] /launch: ${tokenSymbol} (grad=${gradTarget}, antibot=${antiBot}, devBuy=${devBuyMist})`);

  // ── Patch the coin template bytecode ────────────────────────────────────────
  await ensureWasm();
  const templateBytes = new Uint8Array(readFileSync(TEMPLATE_MV_PATH));

  let patched = bytecodeTemplate.update_identifiers(templateBytes, {
    'TEMPLATE':  tokenSymbol,
    'template':  moduleName,
  });
  patched = bytecodeTemplate.update_constants(patched, bcsBytes(tokenSymbol), bcsBytes(PLACEHOLDER_SYM),  'Vector(U8)');
  patched = bytecodeTemplate.update_constants(patched, bcsBytes(tokenName),   bcsBytes(PLACEHOLDER_NAME), 'Vector(U8)');
  patched = bytecodeTemplate.update_constants(patched, bcsBytes(tokenDesc),   bcsBytes(PLACEHOLDER_DESC), 'Vector(U8)');
  patched = bytecodeTemplate.update_constants(patched, bcsBytes(tokenIcon),   bcsBytes(PLACEHOLDER_ICON), 'Vector(U8)');

  // ── Tx 1: publish patched coin module ───────────────────────────────────────
  const tx1 = new Transaction();
  const [upgradeCap] = tx1.publish({
    modules: [Array.from(patched)],
    dependencies: ['0x1', '0x2'],
  });
  tx1.transferObjects([upgradeCap], address);

  // NOTE: the observed transient errors ("simulateTransaction did not return…",
  // CRITICAL: publish is NOT idempotent — every call mints a brand-new package
  // (new CA). It must run EXACTLY ONCE. Retrying it on a transient *response*
  // error (e.g. the tx succeeds on-chain but waitForTransaction/index read
  // times out) re-publishes and mints duplicate tokens. This was the cause of
  // one /launch call producing 5 tokens. Submit once; never retry a publish.
  const exec1 = await client.signAndExecuteTransaction({
    signer: keypair, transaction: tx1,
    include: { objectTypes: true },
  });
  // This client returns { $kind:'Transaction', Transaction:{ digest, status, objectTypes } }
  // or { $kind:'FailedTransaction', FailedTransaction:{ status } }.
  if (exec1?.$kind === 'FailedTransaction') {
    throw new Error(`Tx1 (publish) failed: ${exec1.FailedTransaction?.status?.error ?? 'unknown'}`);
  }
  const tx1Digest = exec1?.Transaction?.digest;
  if (!tx1Digest) {
    throw new Error(`Tx1 (publish) returned no digest. raw=${JSON.stringify(exec1).slice(0, 800)}`);
  }
  if (exec1?.Transaction?.status?.success === false) {
    throw new Error(`Tx1 (publish) reverted: ${exec1.Transaction.status.error ?? 'unknown'}`);
  }

  // objectTypes is a map { objectId: typeString }.
  const objectTypes1 = exec1?.Transaction?.objectTypes ?? {};

  let newPackageId = null, treasuryCapId = null, newTokenType = null, metadataId = null;
  for (const [objId, typeStr] of Object.entries(objectTypes1)) {
    if (!typeStr) continue;
    if (typeStr.includes('TreasuryCap')) {
      treasuryCapId = objId;
      newTokenType  = typeStr.match(/<(.+)>/)?.[1] ?? null;
    } else if (typeStr.includes('CoinMetadata')) {
      metadataId = objId;
    }
  }
  if (newTokenType) newPackageId = newTokenType.split('::')[0];
  if (!treasuryCapId || !newTokenType) {
    throw new Error(`Tx1 published but TreasuryCap/token type not found. objectTypes=${JSON.stringify(objectTypes1).slice(0, 800)}`);
  }

  // Wait until Tx1's new objects (TreasuryCap, metadata, package) are indexed and
  // resolvable, otherwise Tx2 referencing treasuryCapId fails with "Object not found".
  try { await client.waitForTransaction({ digest: tx1Digest }); } catch {}
  // Extra settle margin for the GraphQL indexer.
  await new Promise(r => setTimeout(r, 2500));

  // ── Tx 2: create_and_return + optional dev-buy + share_curve ────────────────
  const tx2 = new Transaction();
  const [launchFeeCoin] = tx2.splitCoins(tx2.gas, [tx2.pure.u64(LAUNCH_FEE_MIST)]);

  // Single payout: 100% to the agent wallet.
  const payoutAddrs = bcs.vector(bcs.Address).serialize([address]).toBytes();
  const payoutBps   = bcs.vector(bcs.u64()).serialize([10000]).toBytes();

  const [curve, cap] = tx2.moveCall({
    target: `${pkgId}::bonding_curve::create_and_return`,
    typeArguments: [newTokenType],
    arguments: [
      tx2.object(treasuryCapId),
      launchFeeCoin,
      tx2.pure.string(tokenName),
      tx2.pure.string(tokenSymbol),
      tx2.pure.string(tokenDesc),
      tx2.pure(payoutAddrs),
      tx2.pure(payoutBps),
      tx2.pure.u8(gradTarget),
      tx2.pure.u8(antiBot),
      tx2.object(SUI_CLOCK_ID),
    ],
  });

  if (devBuyMist > 0n) {
    const [devPayment] = tx2.splitCoins(tx2.gas, [tx2.pure.u64(devBuyMist)]);
    // V9 buy(curve, payment, min_out, referral, sui_price_scaled, clock)
    const buyArgs = isV9
      ? [curve, devPayment, tx2.pure.u64(0), tx2.pure.option('address', null), tx2.pure.u64(0), tx2.object(SUI_CLOCK_ID)]
      : [curve, devPayment, tx2.pure.u64(0), tx2.pure.option('address', null), tx2.object(SUI_CLOCK_ID)];
    const [tokens, refund] = tx2.moveCall({
      target: `${pkgId}::bonding_curve::buy`,
      typeArguments: [newTokenType],
      arguments: buyArgs,
    });
    tx2.transferObjects([tokens, refund], address);
  }

  tx2.moveCall({
    target: `${pkgId}::bonding_curve::share_curve`,
    typeArguments: [newTokenType],
    arguments: [curve],
  });
  tx2.transferObjects([cap], address);

  // CRITICAL: create_and_return is NOT idempotent — it consumes the launch fee
  // and runs the dev-buy. Retrying on a transient response error would create a
  // second curve and double-charge. Submit once; never retry.
  const exec2 = await client.signAndExecuteTransaction({
    signer: keypair, transaction: tx2,
    include: { objectTypes: true },
  });
  if (exec2?.$kind === 'FailedTransaction') {
    throw new Error(`Tx2 (create_and_return) failed: ${exec2.FailedTransaction?.status?.error ?? 'unknown'} — stranded TreasuryCap ${treasuryCapId}`);
  }
  const tx2Digest = exec2?.Transaction?.digest;
  if (!tx2Digest) throw new Error(`Tx2 returned no digest. raw=${JSON.stringify(exec2).slice(0, 800)}`);
  if (exec2?.Transaction?.status?.success === false) {
    throw new Error(`Tx2 reverted: ${exec2.Transaction.status.error ?? 'unknown'} — stranded TreasuryCap ${treasuryCapId}`);
  }

  // Find the shared Curve object id from Tx2 objectTypes map.
  const objectTypes2 = exec2?.Transaction?.objectTypes ?? {};
  let curveId = null;
  for (const [objId, typeStr] of Object.entries(objectTypes2)) {
    if (typeStr?.includes('::bonding_curve::Curve<')) { curveId = objId; break; }
  }
  if (!curveId) {
    throw new Error(`Tx2 succeeded but Curve object not found. objectTypes=${JSON.stringify(objectTypes2).slice(0, 800)}`);
  }

  // Best-effort: tell the indexer about the metadata ISV so the token renders correctly.
  if (metadataId) {
    try {
      await fetch(`${INDEXER_URL}/internal/store-metadata-isv`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ curveId, metadataObjectId: metadataId, initialSharedVersion: null }),
        signal: AbortSignal.timeout(5000),
      });
    } catch {}
  }

  return {
    txDigest:  tx2Digest,
    tx1Digest,
    curveId,
    tokenType: newTokenType,
    packageId: newPackageId,
  };
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
  // CORS preflight — browsers send OPTIONS before a cross-origin POST. Answer it
  // with 204 + the allow headers, otherwise the real POST never fires and the
  // UI shows "Failed to fetch".
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
    });
    res.end();
    return;
  }

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
    // Auth gate: write endpoints (which spend the agent wallet) require the
    // shared secret. Reads (/status /health) are open. The key is sent by our
    // own server-side callers only (Vercel proxy, brain), never the browser.
    if (WRITE_ENDPOINTS.has(req.url)) {
      if (AGENT_API_KEY) {
        const provided = req.headers['x-agent-key'];
        if (provided !== AGENT_API_KEY) {
          jsonResp(res, 401, { ok: false, error: 'unauthorized' });
          return;
        }
      } else {
        console.warn(`[bridge] WARNING: AGENT_API_KEY unset — ${req.url} is OPEN to anyone. Set AGENT_API_KEY in env to lock write endpoints.`);
      }
    }
    switch (req.url) {
      case '/buy':    result = await handleBuy(body);    break;
      case '/sell':   result = await handleSell(body);   break;
      case '/session-buy':  result = await handleSessionBuy(body);  break;
      case '/session-sell': result = await handleSessionSell(body); break;
      case '/claim':  result = await handleClaim(body);  break;
      case '/launch': result = await handleLaunch(body); break;
      case '/status': result = await handleStatus(body); break;
      case '/health': result = { status: 'ok', ts: Date.now(), bootId: BRIDGE_BOOT_ID, uptimeMs: Date.now() - BRIDGE_BOOT_TS, buyCacheSize: _buyCompleted.size, buyInflight: _buyInflight.size }; break;
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

export { handleBuy, handleSell, handleClaim, handleLaunch, handleSessionBuy, handleSessionSell };
