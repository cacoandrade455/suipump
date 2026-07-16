// suipump-nexus-tools/bridge.js
// HTTP bridge between Nexus Rust tool servers (port 8080) and the Sui blockchain.
// Nexus -> Rust (8080) -> this bridge (3030) -> Sui RPC
//
// Endpoints:
//   POST /session-buy           - buy on a curve from an AgentSession's escrow
//   POST /session-sell          - sell session-parked tokens back into escrow
//   POST /provision-session-key - mint a per-user Turnkey/enclave signing key
//   POST /sweep-session-gas     - return a closed session key's leftover gas
//   POST /status                - read curve state snapshot
//   POST /health                - liveness / config probe
//
// RETIRED (HTTP 410): /buy /sell /claim /launch. These signed with the SHARED
// agent wallet key (SUI_PRIVATE_KEY). The bridge no longer signs with that key
// on any execution path; the ONLY remaining use is the SUIPUMP_LEGACY_SIGNER=1
// gated drain of pre-existing fallback sessions via /session-sell.
//
// Environment:
//   SUI_PRIVATE_KEY        - base64WithFlag Ed25519 key (legacy drain ONLY;
//                            loadable solely behind SUIPUMP_LEGACY_SIGNER=1)
//   SUIPUMP_LEGACY_SIGNER  - '1' enables the legacy shared-key drain path
//   SUI_RPC_URL            - default: testnet fullnode
//   SUIPUMP_INDEXER_URL    - indexer base URL (for curve lookups)
//   PORT                   - default: 3030

import http from 'node:http';

import { SuiGraphQLClient } from '@mysten/sui/graphql';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';
import { fromBase64 } from '@mysten/sui/utils';
import pg from 'pg';
import {
  signAndExecute as signViaEnclave,
  suiAddressForPublicKeyHex,
  turnkeyConfigured,
  provisionEd25519Key,
  enclaveConfigured,
  enclavePublicKeyHex,
  enclaveAttestationHex,
} from './turnkey_signer.js';

const PORT          = parseInt(process.env.PORT ?? '3030', 10);
const INDEXER_URL   = process.env.SUIPUMP_INDEXER_URL ?? 'https://suipump-62s2.onrender.com';

// -- Write-endpoint auth -------------------------------------------------------
// The session endpoints mutate state (session escrow trades, key provisioning,
// gas sweeps). They must only be reachable by our own server-side callers (the
// Vercel agent proxy and the strategy brain), never by a random browser or a
// direct curl. We gate them behind a shared secret sent as `x-agent-key`. The
// key lives ONLY in the bridge env and in the callers' server-side envs - it is
// NEVER shipped to the browser. Reads (/status /health) stay open. If
// AGENT_API_KEY is unset the gate is OPEN (local dev) but we log a loud warning
// so it's never silently open in production.
const AGENT_API_KEY = process.env.AGENT_API_KEY ?? '';
const WRITE_ENDPOINTS = new Set(['/session-buy', '/session-sell', '/provision-session-key', '/sweep-session-gas']);

// -- Retired endpoints (HTTP 410) ------------------------------------------------
// These four endpoints signed transactions with the SHARED AGENT WALLET key.
// That execution path is removed: the bridge never signs with the shared key
// (except the SUIPUMP_LEGACY_SIGNER=1 gated /session-sell drain). Answered
// BEFORE the auth gate so retired callers get a clear retirement message even
// without a key.
const RETIRED_ENDPOINTS = {
  '/buy':    'this endpoint is retired - the bridge no longer signs with the shared agent wallet; use /session-buy with a provisioned per-user session key',
  '/sell':   'this endpoint is retired - the bridge no longer signs with the shared agent wallet; use /session-sell with a provisioned per-user session key',
  '/claim':  'this endpoint is retired - the bridge no longer signs with the shared agent wallet; creator-fee claims move to user-wallet-signed flows (the creator signs claim_creator_fees with their own wallet and CreatorCap)',
  '/launch': 'this endpoint is retired - the bridge no longer signs with the shared agent wallet; launch is user-funded and user-signed now (the launcher publishes and creates the curve from their own wallet)',
};

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
        console.log(`[bridge] ${label}: transient error (attempt ${attempt}/${tries}) - ${String(err?.message ?? err).slice(0, 120)}; retrying in ${delayMs}ms`);
        await new Promise(r => setTimeout(r, delayMs));
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

// -- Package IDs (all versions - read paths) -----------------------------------
const ALL_PACKAGE_IDS = [
  '0x2154486dcf503bd3e8feae4fb913e862f7e2bbf4489769aff63978f55d55b4a8', // V4
  '0x785c0604cb6c60a8547501e307d2b0ca7a586ff912c8abff4edfb88db65b7236', // V5
  '0x21d5b1284d5f1d4d14214654f414ffca20c757ee9f9db7701d3ffaaac62cd768', // V6
  '0xfb8f3f3e4e8d53130ac140906eebea6b6740bfaf0c971aec607fbc723be951f0', // V7
  '0x145a1e79b83cc17680dbfe4f96839cd359c7db380ac15463ecb6dc30f9849b69', // V8_1
  '0xbb4ee050239f59dfd983501ce101698ba27857f77aff2d437cec568fe0062546', // V8
  '0x719698e5138582d78ee95317271e8bce05769569a4f58c940a7f1b424d90ffe2', // V9
  '0x2deda2cade65cd5afd5ffbe799d48f2491debf08d3aef6fa11aa6e1c8afe1598', // V10
  // V11 -- UPGRADE of V10 (0xc03817bce45ff492e5d0f40f9e46f5a075a952b50c5c6146b8fb38138bd699eb): never appears as a curve TYPE package
  // (defining ids stay V10 for the lineage), listed per the read-path rule and
  // for the V2 event types that define under it.
  '0xc03817bce45ff492e5d0f40f9e46f5a075a952b50c5c6146b8fb38138bd699eb', // V11
  // V12 -- second upgrade of the V10 lineage: comments toggle, enclave
  // registry (Nautilus), attested session open. CommentGateSet and
  // SessionAttested event types define under this id.
  '0xf5a3566ba920a3e3614e8b25da0ca3237879b6e22eb12f21ccf2bceb6520b9cd', // V12
];

// -- Package upgrade targets ------------------------------------------------------
// Sui upgrades publish NEW addresses but object TYPES keep the ORIGINAL defining
// id -- and calls to the old address run OLD bytecode. So when a package id is
// derived from an object's type (resolveCurve / resolveSession), moveCall
// targets must be remapped to the newest version of that lineage or the upgrade
// never takes effect. Map: defining (original) package -> latest upgrade.
const PACKAGE_LATEST = {
  // V10 lineage -> V12 (V11: net-exposure cap, TradeTicket, closed sentinel,
  // V2 events; V12: comments toggle, enclave registry, attested open)
  '0x2deda2cade65cd5afd5ffbe799d48f2491debf08d3aef6fa11aa6e1c8afe1598':
    '0xf5a3566ba920a3e3614e8b25da0ca3237879b6e22eb12f21ccf2bceb6520b9cd',
};
function latestPackageFor(pkgId) {
  return PACKAGE_LATEST[String(pkgId).toLowerCase()] ?? pkgId;
}
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

// -- Result readback (deployed SDK shape) --------------------------------------
// signAndExecuteTransaction returns a discriminated union:
//   { $kind: 'Transaction',       Transaction:       { digest, status, balanceChanges, ... } }  // success
//   { $kind: 'FailedTransaction', FailedTransaction: { status: { error } } }                    // failure
// (Confirmed by logging the live result.) Earlier code read .data.executeTransaction.*,
// which is undefined here - that is why txDigest came back null and amounts "unknown".
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
// (balanceChangesOf/bcAddr/bcType/isSui helpers were removed with the retired
// shared-wallet handlers - they were their only consumers.)

// -- Helpers -------------------------------------------------------------------
// LEGACY SHARED SIGNER GATE. The shared agent wallet
// (0x877af0fae3fa4f8ea936943b59bcd66104f67cf1895302e97761a28b3c3a5906) is
// REMOVED from the bridge execution path. The ONLY remaining legitimate use of
// its key is draining PRE-EXISTING fallback sessions whose on-chain
// session_address IS the shared wallet - only that key can sign their
// /session-sell (the contract's sender == session_address check makes this
// safe). That drain path is dead unless SUIPUMP_LEGACY_SIGNER=1 is set in the
// env; loadKeypair is reachable ONLY through loadLegacyKeypair. Request-body
// privateKey overrides are gone entirely.
const LEGACY_SIGNER_ENABLED = process.env.SUIPUMP_LEGACY_SIGNER === '1';

function loadKeypair() {
  const raw = process.env.SUI_PRIVATE_KEY;
  if (!raw) throw new Error('No private key - set SUI_PRIVATE_KEY');
  const bytes = fromBase64(raw);
  const seed  = (bytes.length === 65 || bytes.length === 33) ? bytes.slice(1) : bytes;
  return Ed25519Keypair.fromSecretKey(seed);
}

function loadLegacyKeypair() {
  if (!LEGACY_SIGNER_ENABLED) {
    throw new Error('legacy shared signer disabled - set SUIPUMP_LEGACY_SIGNER=1 only to drain pre-existing fallback sessions');
  }
  return loadKeypair();
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
  // A read-only resolution - safe to retry. When buy runs immediately after a
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
        console.log(`[bridge] resolveCurve ${curveId}: not ready (attempt ${attempt}/${tries}) - ${String(err?.message ?? err)}`);
        await new Promise(r => setTimeout(r, delayMs));
      }
    }
  }
  throw lastErr ?? new Error(`Curve ${curveId} could not be resolved`);
}

// Resolve an AgentSession shared object - returns its package id, the session
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
        console.log(`[bridge] resolveSession ${sessionId}: not ready (attempt ${attempt}/${tries}) - ${String(err?.message ?? err)}`);
        await new Promise(r => setTimeout(r, delayMs));
      }
    }
  }
  throw lastErr ?? new Error(`Session ${sessionId} could not be resolved`);
}

// -- Per-session Turnkey signer store (Phase 1 trust minimization) ---------------
// Maps sessionId -> { signWith, publicKeyHex } so session trades are signed by
// that session's OWN enclave-held key instead of the shared SUI_PRIVATE_KEY.
// Two layers, checked in order:
//   1. TURNKEY_SESSION_KEYS env var - interim JSON map
//      { "<sessionId>": { "signWith": "...", "publicKeyHex": "..." } }.
//      Zero-infra path for manual testing; survives even without Postgres.
//   2. Postgres table session_signers (auto-created) - the scaling path. Rows
//      are inserted at provision time KEYED BY ADDRESS (the session does not
//      exist yet - its address is what open_and_share will authorize). The
//      sessionId column is bound LAZILY on first trade: we read the session
//      object's on-chain session_address field and match it to a stored row.
//      The CHAIN is the source of truth for the binding - no caller can point
//      an arbitrary sessionId at someone else's key, because the lookup only
//      succeeds if the session object itself names that key's address.
// Every failure path returns null -> NO SIGNER EXISTS for the session and the
// handler HARD-FAILS the request (loud, surfaced to the caller). There is no
// shared-keypair fallback: a DB or Turnkey outage fails trades instead of
// silently degrading to the shared agent wallet. (The one exception is the
// SUIPUMP_LEGACY_SIGNER=1 gated /session-sell drain for pre-existing fallback
// sessions - see loadLegacyKeypair.)
const { Pool } = pg;
let _pgPool = null;
let _signersTableReady = false;

function signerPool() {
  const url = process.env.DATABASE_URL;
  if (!url) return null;
  if (_pgPool) return _pgPool;
  // Render Postgres requires SSL; local dev does not. Decide from the URL so we
  // don't depend on NODE_ENV being set on this service.
  const useSsl = !/localhost|127\.0\.0\.1/.test(url);
  _pgPool = new Pool({ connectionString: url, ssl: useSsl ? { rejectUnauthorized: false } : false });
  return _pgPool;
}

async function ensureSignersTable(pool) {
  if (_signersTableReady) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS session_signers (
      sui_address    TEXT PRIMARY KEY,
      sign_with      TEXT NOT NULL,
      public_key_hex TEXT NOT NULL,
      owner_address  TEXT,
      session_id     TEXT UNIQUE,
      is_enclave     BOOLEAN DEFAULT false,
      created_at     TIMESTAMPTZ DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_session_signers_session ON session_signers (session_id);
  `);
  await pool.query(`ALTER TABLE session_signers ADD COLUMN IF NOT EXISTS is_enclave BOOLEAN DEFAULT false;`);
  _signersTableReady = true;
}

async function insertSessionSigner({ suiAddress, signWith, publicKeyHex, ownerAddress, isEnclave }) {
  const pool = signerPool();
  if (!pool) throw new Error('DATABASE_URL not set - cannot persist session signer mapping');
  await ensureSignersTable(pool);
  await pool.query(
    `INSERT INTO session_signers (sui_address, sign_with, public_key_hex, owner_address, is_enclave)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (sui_address) DO NOTHING`,
    [suiAddress.toLowerCase(), signWith, publicKeyHex, ownerAddress ?? null, !!isEnclave]
  );
}

function envMapKeyForSession(sessionId) {
  const raw = process.env.TURNKEY_SESSION_KEYS;
  if (!raw) return null;
  try {
    const map = JSON.parse(raw);
    const k = map?.[sessionId];
    return k?.signWith && k?.publicKeyHex ? { signWith: k.signWith, publicKeyHex: k.publicKeyHex } : null;
  } catch {
    console.warn('[turnkey] TURNKEY_SESSION_KEYS is not valid JSON - ignoring');
    return null;
  }
}

// Read the session object's own session_address field (the address the OWNER
// authorized in open_and_share). include:{json:true} adds object.json = the
// Move struct fields as JSON.
async function sessionAddressOf(client, sessionId) {
  const obj = await client.getObject({ objectId: sessionId, include: { json: true } });
  const addr = obj?.object?.json?.session_address;
  return typeof addr === 'string' ? addr.toLowerCase() : null;
}

// The GraphQL endpoint a raw query should hit - mirrors makeClient's url choice
// (honor a GraphQL rpcUrl, else the configured/default testnet GraphQL).
function graphqlUrlFor(rpcUrl) {
  const GQL_DEFAULT = process.env.SUI_GRAPHQL_URL ?? 'https://graphql.testnet.sui.io/graphql';
  return (typeof rpcUrl === 'string' && /graphql/i.test(rpcUrl)) ? rpcUrl : GQL_DEFAULT;
}

// sessionParkedAtomic - the ATOMIC balance of the session's parked Coin<tokenType>,
// read straight from chain. A session buy parks bought tokens as a dynamic OBJECT
// field on the session keyed by TypeName (park_tokens in agent_session.move), so
// the position is NOT at any address's coin balance - it lives inside the session
// object. This is what makes a whole-position session sell exact: /session-sell
// with sellAll resolves the true parked amount here, at execution time, so no
// plan-time/confirm-time drift and no leftover dust.
//
// Query shape verified on testnet (2026-07-08): object(address).dynamicFields.nodes[]
// where the parked coin node is a MoveObject whose contents.type.repr is
// 0x..2::coin::Coin<tokenType> and contents.json.balance is the atomic amount.
// The universal_trading marker rides as a separate bool MoveValue field and is
// skipped by requiring a ::coin::Coin< value carrying our tokenType. Address
// padding differs by node (0x000..2 vs short), so we match on the inner
// tokenType substring rather than an exact Coin<> repr. Returns a BigInt (0n if
// no parked coin of this type).
async function sessionParkedAtomic(sessionId, tokenType, rpcUrl) {
  const url = graphqlUrlFor(rpcUrl);
  // normalize the tokenType so a padded/short address inside the Coin<> still matches
  const wantType = String(tokenType).toLowerCase();
  const q = `{ object(address: "${sessionId}") { dynamicFields { nodes { value { __typename ... on MoveObject { contents { type { repr } json } } } } } } }`;
  const r = await fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: q }), signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) throw new Error(`graphql ${r.status} reading parked balance`);
  const d = await r.json();
  if (d.errors?.length) throw new Error(`graphql: ${d.errors[0].message}`);
  const nodes = d?.data?.object?.dynamicFields?.nodes ?? [];
  for (const n of nodes) {
    const c = n?.value?.contents;
    const repr = String(c?.type?.repr ?? '').toLowerCase();
    if (!repr.includes('::coin::coin<')) continue;      // not a parked coin (skips the bool marker)
    if (!repr.includes(wantType)) continue;             // different token type
    const bal = c?.json?.balance;
    if (bal == null) continue;
    return BigInt(bal);
  }
  return 0n;
}

async function turnkeyKeyForSession(client, sessionId) {
  // Without a configured backend NO session key is usable - returning one would
  // set the tx sender to that address while the fallback signs with the shared
  // keypair, guaranteeing an on-chain sender/signature mismatch.
  if (!turnkeyConfigured() && !enclaveConfigured()) return null;

  // Layer 1: interim env map.
  const envKey = envMapKeyForSession(sessionId);
  if (envKey) return envKey;

  // Layer 2: Postgres.
  const pool = signerPool();
  if (!pool) return null;
  try {
    await ensureSignersTable(pool);

    // Already bound?
    const bound = await pool.query(
      `SELECT sign_with, public_key_hex FROM session_signers WHERE session_id = $1`,
      [sessionId]
    );
    if (bound.rows[0]) {
      const row = bound.rows[0];
      return row.is_enclave
        ? { enclave: true, publicKeyHex: row.public_key_hex }
        : { signWith: row.sign_with, publicKeyHex: row.public_key_hex };
    }

    // Lazy bind: match the session's on-chain session_address to a provisioned
    // row, then record the binding. Chain-verified - the session object itself
    // names which address (and therefore which enclave key) may sign for it.
    const sessAddr = await sessionAddressOf(client, sessionId);
    if (!sessAddr) return null;
    const byAddr = await pool.query(
      `UPDATE session_signers SET session_id = $1
       WHERE sui_address = $2 AND (session_id IS NULL OR session_id = $1)
       RETURNING sign_with, public_key_hex, is_enclave`,
      [sessionId, sessAddr]
    );
    if (byAddr.rows[0]) {
      const row = byAddr.rows[0];
      console.log(`[signer] bound session ${sessionId} to ${row.is_enclave ? 'ENCLAVE' : 'turnkey'} key at ${sessAddr}`);
      return row.is_enclave
        ? { enclave: true, publicKeyHex: row.public_key_hex }
        : { signWith: row.sign_with, publicKeyHex: row.public_key_hex };
    }
    return null; // session_address is not a provisioned key (e.g. shared agent wallet)
  } catch (e) {
    console.warn(`[turnkey] signer lookup failed for ${sessionId} - the request will HARD-FAIL (no fallback signer exists): ${e.message}`);
    return null;
  }
}

// -- Session <-> curve version compatibility --------------------------------------
// Which bonding_curve Curve<T> does this session package's buy_with_session
// actually accept? Ask the CHAIN (getMoveFunction) instead of assuming.
// Move type identity survives package upgrades: V10
// (0x2deda2cade65cd5afd5ffbe799d48f2491debf08d3aef6fa11aa6e1c8afe1598) upgrades the
// V9 lineage, so curves launched through V10 still carry V9's defining id
// (0x719698e5138582d78ee95317271e8bce05769569a4f58c940a7f1b424d90ffe2) in their
// type - naive "curve pkg == session pkg" equality
// wrongly rejected every valid curve. Genuinely incompatible curves (V4-V8:
// separate publishes, therefore distinct Curve types) still fail with a clear
// error. Cached per session package; on introspection failure the guard is
// skipped and on-chain simulation gives the final answer.
const _sessionCurvePkg = new Map();
async function sessionCurvePackage(client, sessPkgId) {
  if (_sessionCurvePkg.has(sessPkgId)) return _sessionCurvePkg.get(sessPkgId);
  let curvePkg = null;
  try {
    const res = await client.getMoveFunction({
      packageId: sessPkgId, moduleName: 'agent_session', name: 'buy_with_session',
    });
    for (const p of res?.function?.parameters ?? []) {
      const tn = p?.body?.datatype?.typeName;
      if (typeof tn === 'string' && tn.endsWith('::bonding_curve::Curve')) {
        curvePkg = tn.split('::')[0].toLowerCase();
        break;
      }
    }
    if (curvePkg) console.log(`[bridge] agent_session at ${sessPkgId.slice(0, 12)}... accepts curves defined by ${curvePkg}`);
  } catch (e) {
    console.warn(`[bridge] could not introspect buy_with_session on ${sessPkgId.slice(0, 12)}...: ${e?.message ?? e} - version guard skipped`);
  }
  _sessionCurvePkg.set(sessPkgId, curvePkg); // cache misses too (avoid re-querying)
  return curvePkg;
}

function jsonResp(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    // CORS - the agent UI (suipump.org) calls these endpoints from the browser.
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

// Per-process identity - lets us tell if Render is running >1 bridge instance
// (if /health returns different bootIds across calls, more than one process is
// serving traffic).
const BRIDGE_BOOT_ID = Math.random().toString(36).slice(2, 10);
const BRIDGE_BOOT_TS = Date.now();

// -- RETIRED: /buy /sell /claim /launch ------------------------------------------
// The shared-agent-wallet handlers (handleBuy/executeBuy, handleSell,
// handleClaim, handleLaunch) and their buy-idempotency cache were DELETED when
// the shared signer was removed from the execution path. The routes answer
// HTTP 410 via RETIRED_ENDPOINTS above.
// -- Handler: /session-buy -----------------------------------------------------
// Buy on a curve using an AgentSession's escrow, signed by the SESSION key.
// No payment coin is split and no tokens are transferred: the contract draws
// `amount` SUI from escrow and parks bought tokens on the session.
// Body: { sessionId, curveId, amountMist | suiAmount, minTokensOut?, rpcUrl? }
//   SIGNER SELECTION (contract enforces sender == session_address):
//   - This session's session_address MUST map to a provisioned Turnkey/enclave
//     key (session_signers / TURNKEY_SESSION_KEYS); the tx is signed INSIDE
//     the enclave by that per-user key - the trust-minimized path.
//   - No mapped key -> HARD FAIL. There is no shared-keypair fallback for buys.
async function handleSessionBuy(body) {
  const { sessionId, curveId, amountMist, suiAmount, minTokensOut, rpcUrl } = body;
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
  // Per-session enclave key (Turnkey/Nautilus). The tx MUST be sent from (and
  // signed by) the session_address the owner authorized - the contract
  // enforces sender == session_address. Null means NO SIGNER EXISTS for this
  // session: fail loud, never degrade to the shared agent wallet.
  const sessionKey = await turnkeyKeyForSession(client, sessionId);
  if (!sessionKey) throw new Error('session key provisioning failed - no fallback signer exists');
  const address = suiAddressForPublicKeyHex(sessionKey.publicKeyHex);

  const { pkgId, tokenType, sharedVersion } = await resolveCurve(client, curveId);
  const { pkgId: sessPkgId, sharedVersion: sessVersion } = await resolveSession(client, sessionId);
  // Type-derived package = the lineage's DEFINING id; remap to the newest
  // upgrade so V11 behavior (net-exposure cap, sentinel, V2 events) executes.
  const sessTargetPkg = latestPackageFor(sessPkgId);

  // Version guard: buy_with_session only accepts the Curve<T> type it was
  // compiled against. That type's defining package is introspected from the
  // chain (see sessionCurvePackage) - NOT assumed equal to the session's own
  // package, because upgrades keep the original defining id.
  const compatPkg = await sessionCurvePackage(client, sessTargetPkg);
  // UNIVERSAL PATH DECISION: when the curve's Curve<T> type is NOT the one the
  // session module was compiled against (legacy V4-V9 publishes), route through
  // the V11 TradeTicket hot potato: borrow escrow SUI -> the curve's OWN
  // version-correct bonding_curve::buy -> settle back. Requires the OWNER to
  // have enabled universal trading on the session (Move aborts with
  // EUniversalTradingDisabled = 11 otherwise). Unknown packages still hard-fail.
  const universal = Boolean(compatPkg && compatPkg !== String(pkgId).toLowerCase());
  if (universal && !ALL_PACKAGE_IDS.includes(String(pkgId).toLowerCase())) {
    throw new Error(`curve ${curveId} is on unknown package ${pkgId} - not a SuiPump curve version`);
  }
  const minOut = BigInt(minTokensOut ?? 0);

  // Oracle price arg for V9+ buy() shapes (both the native V10-lineage path and
  // legacy V9 curves on the universal path). Fallback 0 -> stored BASE_GRAD.
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

  if (!universal) {
    // Native path: coins never leave module custody (V10 blast radius).
    // buy_with_session<T>(session, curve, amount, min_tokens_out, sui_price_scaled, clock, ctx)
    tx.moveCall({
      target: `${sessTargetPkg}::agent_session::buy_with_session`,
      typeArguments: [tokenType],
      arguments: [sessionRef, curveRef, tx.pure.u64(suiMist), tx.pure.u64(minOut), tx.pure.u64(suiPriceScaled), clockRef],
    });
  } else {
    // Universal path (owner opt-in): borrow -> legacy version-dispatched buy ->
    // settle. Every version V4-V10 returns (Coin<T>, Coin<SUI>) from buy()
    // (verified on-chain), so both results route into settle_buy: tokens park
    // on the session, refund rejoins escrow and credits the cap.
    const [funds, ticket] = tx.moveCall({
      target: `${sessTargetPkg}::agent_session::borrow_for_buy`,
      arguments: [sessionRef, tx.pure.u64(suiMist), clockRef],
    });
    // Exact per-version buy() dispatch, mirroring executeBuy:
    //   V9:   buy(curve, payment, min_out, referral, sui_price_scaled, clock)
    //   V5-8: buy(curve, payment, min_out, referral, clock)
    //   V4:   buy(curve, payment, min_out)
    let buyArgs;
    if (V9_PLUS.has(pkgId)) {
      buyArgs = [curveRef, funds, tx.pure.u64(minOut), tx.pure.option('address', null), tx.pure.u64(suiPriceScaled), clockRef];
    } else if (V5_PLUS.has(pkgId)) {
      buyArgs = [curveRef, funds, tx.pure.u64(minOut), tx.pure.option('address', null), clockRef];
    } else {
      buyArgs = [curveRef, funds, tx.pure.u64(minOut)];
    }
    const [tokens, refund] = tx.moveCall({
      target: `${pkgId}::bonding_curve::buy`,
      typeArguments: [tokenType],
      arguments: buyArgs,
    });
    tx.moveCall({
      target: `${sessTargetPkg}::agent_session::settle_buy`,
      typeArguments: [tokenType],
      arguments: [sessionRef, ticket, refund, tokens],
    });
  }

  let result;
  try {
    // Enclave/Turnkey path only - sessionKey is guaranteed non-null above, and
    // no fallbackKeypair is provided (signViaEnclave hard-throws if it would
    // ever need one).
    result = await signViaEnclave({
      client, transaction: tx, sessionKey,
      include: { balanceChanges: true },
    });
  } catch (e) {
    const detail = e?.cause?.message ?? e?.cause ?? e?.message ?? String(e);
    const text = typeof detail === 'string' ? detail : JSON.stringify(detail);
    // EUniversalTradingDisabled = abort code 11 in agent_session.
    if (universal && /agent_session/.test(text) && /(\b11\b|EUniversalTradingDisabled)/.test(text)) {
      throw new Error(`this token is on a legacy curve version - the session OWNER must enable Universal Trading on the Agent page before the agent can trade it (session ${sessionId})`);
    }
    throw new Error(`session buy simulate/execute failed: ${text}`);
  }

  if (!txOk(result)) {
    throw new Error(`buy_with_session() failed: ${txErrorOf(result) ?? 'transaction failed'}`);
  }

  return {
    txDigest:  txDigestOf(result),
    sessionId,
    suiSpent:  (Number(suiMist) / Number(MIST_PER_SUI)).toFixed(9),
    tokenType,
    path:      universal ? 'universal' : 'native',
    bootId:    BRIDGE_BOOT_ID,
  };
}

// -- Handler: /session-sell ----------------------------------------------------
// Sell session-held tokens of a curve back into the session's escrow, signed by
// the SESSION key. No coin sourcing: the contract sells from tokens already
// parked on the session by prior session-buys. Proceeds compound into escrow.
// Body: { sessionId, curveId, tokenAmount|sellAll, minSuiOut?, rpcUrl? }
//   tokenAmount is whole tokens (scaled by 1e6 to atomic on-chain) for a partial
//   sell; sellAll:true (or tokenAmount:"all"/"max") sells the WHOLE parked
//   position, resolved to the true parked balance at execution time. Signer
//   selection is the same as /session-buy (per-session Turnkey/enclave key,
//   hard-fail when none exists) with ONE gated exception: when
//   SUIPUMP_LEGACY_SIGNER=1, a session with no mapped key may be DRAINED by the
//   shared agent wallet keypair. Pre-existing fallback sessions were opened
//   with session_address == the shared agent wallet, so ONLY that key can sign
//   their sells; the contract's sender == session_address check makes this
//   safe. Unset SUIPUMP_LEGACY_SIGNER after draining.
async function handleSessionSell(body) {
  const { sessionId, curveId, tokenAmount, minSuiOut, rpcUrl } = body;
  if (!sessionId)   throw new Error('sessionId required');
  if (!curveId)     throw new Error('curveId required');
  // Whole-position sell: sellAll:true OR tokenAmount "all"/"max" (case-insensitive).
  // The contract splits an EXACT amount from the single parked coin (it has no
  // "sell the whole coin" entry), so "all" is resolved here to the true parked
  // balance at execution time - no plan/confirm drift, no leftover dust.
  const wantAll = body.sellAll === true
    || (typeof tokenAmount === 'string' && /^(all|max)$/i.test(tokenAmount.trim()));
  if (!wantAll && !tokenAmount) throw new Error('tokenAmount required (whole tokens, e.g. 1000) or sellAll:true / tokenAmount:"all"');

  const client  = makeClient(rpcUrl);
  // Same per-session enclave key selection as /session-buy (see comment there),
  // plus the SUIPUMP_LEGACY_SIGNER=1 drain exception documented above.
  const sessionKey = await turnkeyKeyForSession(client, sessionId);
  let address;
  let legacyKeypair = null;
  if (sessionKey) {
    address = suiAddressForPublicKeyHex(sessionKey.publicKeyHex);
  } else {
    if (!LEGACY_SIGNER_ENABLED) throw new Error('session key provisioning failed - no fallback signer exists');
    legacyKeypair = loadLegacyKeypair();
    address = legacyKeypair.toSuiAddress();
    console.warn(`[bridge] LEGACY DRAIN: /session-sell for session ${sessionId} will be signed by the SHARED agent wallet keypair (SUIPUMP_LEGACY_SIGNER=1)`);
  }

  const { pkgId, tokenType, sharedVersion } = await resolveCurve(client, curveId);
  const { pkgId: sessPkgId, sharedVersion: sessVersion } = await resolveSession(client, sessionId);
  const sessTargetPkg = latestPackageFor(sessPkgId);

  // Same introspected version guard / universal-path decision as /session-buy.
  const compatPkg = await sessionCurvePackage(client, sessTargetPkg);
  const universal = Boolean(compatPkg && compatPkg !== String(pkgId).toLowerCase());
  if (universal && !ALL_PACKAGE_IDS.includes(String(pkgId).toLowerCase())) {
    throw new Error(`curve ${curveId} is on unknown package ${pkgId} - not a SuiPump curve version`);
  }

  // Resolve the atomic amount to sell. sellAll -> read the true parked Coin<T>
  // balance on the session; partial -> the exact requested whole-token amount.
  let tokAtomic;
  if (wantAll) {
    tokAtomic = await sessionParkedAtomic(sessionId, tokenType, rpcUrl);
    if (tokAtomic <= 0n) throw new Error(`session holds no parked ${tokenType} to sell`);
  } else {
    tokAtomic = BigInt(Math.floor(parseFloat(tokenAmount) * 1e6));
    if (tokAtomic <= 0n) throw new Error('tokenAmount must be > 0');
  }
  const minOut = BigInt(minSuiOut ?? 0);

  const tx = new Transaction();
  tx.setSender(address);
  const sessionRef = tx.sharedObjectRef({ objectId: sessionId, initialSharedVersion: sessVersion, mutable: true });
  const curveRef   = tx.sharedObjectRef({ objectId: curveId,   initialSharedVersion: sharedVersion, mutable: true });
  const clockRef   = tx.sharedObjectRef({ objectId: SUI_CLOCK_ID, initialSharedVersion: 1, mutable: false });

  if (!universal) {
    // sell_with_session<T>(session, curve, token_amount, min_sui_out, clock, ctx)
    tx.moveCall({
      target: `${sessTargetPkg}::agent_session::sell_with_session`,
      typeArguments: [tokenType],
      arguments: [sessionRef, curveRef, tx.pure.u64(tokAtomic), tx.pure.u64(minOut), clockRef],
    });
  } else {
    // Universal path (owner opt-in): borrow parked tokens -> the curve's OWN
    // version-correct bonding_curve::sell -> settle proceeds back to escrow
    // (net-exposure credit). Legacy sell consumes the whole input coin and
    // returns a single Coin<SUI>, so leftover tokens are a fresh zero coin.
    const [toSell, ticket] = tx.moveCall({
      target: `${sessTargetPkg}::agent_session::borrow_tokens_for_sell`,
      typeArguments: [tokenType],
      arguments: [sessionRef, tx.pure.u64(tokAtomic), clockRef],
    });
    // Per-version sell() dispatch, mirroring handleSell:
    //   V7+: sell(curve, tokens, min_out, referral)   pre-V7: sell(curve, tokens, min_out)
    const sellArgs = V7_PLUS.has(pkgId)
      ? [curveRef, toSell, tx.pure.u64(minOut), tx.pure.option('address', null)]
      : [curveRef, toSell, tx.pure.u64(minOut)];
    const [suiOut] = tx.moveCall({
      target: `${pkgId}::bonding_curve::sell`,
      typeArguments: [tokenType],
      arguments: sellArgs,
    });
    const [zeroTokens] = tx.moveCall({
      target: '0x2::coin::zero',
      typeArguments: [tokenType],
      arguments: [],
    });
    tx.moveCall({
      target: `${sessTargetPkg}::agent_session::settle_sell`,
      typeArguments: [tokenType],
      arguments: [sessionRef, ticket, suiOut, zeroTokens],
    });
  }

  let result;
  try {
    // Enclave/Turnkey path when sessionKey is set; fallbackKeypair carries the
    // gate-approved legacy keypair ONLY on the drain path (null otherwise, and
    // signViaEnclave hard-throws rather than sign with nothing).
    result = await signViaEnclave({
      client, transaction: tx, sessionKey,
      fallbackKeypair: legacyKeypair ?? undefined,
      include: { balanceChanges: true },
    });
  } catch (e) {
    const detail = e?.cause?.message ?? e?.cause ?? e?.message ?? String(e);
    const text = typeof detail === 'string' ? detail : JSON.stringify(detail);
    if (universal && /agent_session/.test(text) && /(\b11\b|EUniversalTradingDisabled)/.test(text)) {
      throw new Error(`this token is on a legacy curve version - the session OWNER must enable Universal Trading on the Agent page before the agent can trade it (session ${sessionId})`);
    }
    throw new Error(`session sell simulate/execute failed: ${text}`);
  }

  if (!txOk(result)) {
    throw new Error(`sell_with_session() failed: ${txErrorOf(result) ?? 'transaction failed'}`);
  }

  return {
    txDigest:   txDigestOf(result),
    sessionId,
    tokensSold: (Number(tokAtomic) / 1e6).toFixed(6),
    tokenType,
    path:       universal ? 'universal' : 'native',
    bootId:     BRIDGE_BOOT_ID,
  };
}

// -- Handler: /provision-session-key ---------------------------------------------
// Create a per-user enclave key (Turnkey) BEFORE a session is opened. The
// returned sessionAddress is what the UI passes to open_and_share as
// session_address, so only this enclave-held key can ever sign that session's
// trades. Flow: create key in the enclave -> persist the address->key mapping
// (session id bound lazily on first trade, chain-verified). GAS is SELF-FUNDED:
// the owner's open PTB grants the session address its gas (skipGasFunding:true
// from the live frontend). Treasury gas funding from the bridge wallet is
// RETIRED - this handler never signs or spends anything.
//
// Body: { ownerAddress?, mode?, skipGasFunding? }
// Returns { configured:false, reason } when Turnkey or the DB is not set up -
// there is no shared-wallet fallback signer, so the caller must surface that
// sessions cannot be opened until provisioning is configured.
// Gated by AGENT_API_KEY (WRITE_ENDPOINTS): keys cost money to create, so only
// our Vercel proxy may call this.
async function handleProvisionSessionKey(body) {
  const { ownerAddress, mode, skipGasFunding } = body ?? {};

  if (!signerPool()) {
    return { configured: false, reason: 'database_url_unset' };
  }

  // Backend selection: mode:'enclave' provisions against the Nautilus enclave
  // (Phase 2, chain-attestable); otherwise Turnkey (Phase 1). The enclave holds
  // ONE key, so provisioning reads its public key rather than minting a new
  // one -- every enclave-mode session shares that attested key (isolation still
  // holds on-chain via each session's own caps/expiry/revoke; per-user key
  // isolation is the Turnkey path's property, chain-attestation is the
  // enclave path's). A future multi-key enclave can mint per session here.
  const useEnclave = mode === 'enclave';

  if (useEnclave) {
    if (!enclaveConfigured()) return { configured: false, reason: 'enclave_url_unset' };
  } else {
    if (!turnkeyConfigured()) return { configured: false, reason: 'turnkey_env_unset' };
  }

  // 1. Obtain the session key's address.
  let signWith = null;
  let publicKeyHex;
  let suiAddress;
  if (useEnclave) {
    publicKeyHex = await enclavePublicKeyHex();
    suiAddress   = suiAddressForPublicKeyHex(publicKeyHex);
  } else {
    const label = `suipump-session-${(ownerAddress ?? 'anon').slice(0, 16)}-${Date.now()}`;
    ({ signWith, publicKeyHex, suiAddress } = await provisionEd25519Key(label));
  }

  // 2. Persist the mapping FIRST (keyed by address; session_id bound lazily on
  // first trade). Harmless never-bound record if gas funding below fails.
  await insertSessionSigner({ suiAddress, signWith: signWith ?? suiAddress, publicKeyHex, ownerAddress, isEnclave: useEnclave });

  // 3. Gas funding. SELF-FUNDED flow (current frontend): the owner's open PTB
  // grants the session address its gas in the same transaction as the escrow
  // deposit, so the bridge spends NOTHING here. This removes the gas-treasury
  // dependency that caused the 2026-07-03 dry-treasury -> silent shared-wallet
  // fallback incident, and stops subsidizing gas that bots would farm.
  if (skipGasFunding === true) {
    console.log(`[signer] provisioned ${useEnclave ? 'ENCLAVE' : 'turnkey'} session key ${suiAddress} (owner ${ownerAddress ?? 'unknown'}), gas SELF-FUNDED by owner in the open PTB`);
    return {
      configured:     true,
      backend:        useEnclave ? 'enclave' : 'turnkey',
      sessionAddress: suiAddress,
      publicKeyHex,
      gasFundedMist:  '0',
      gasFundedBy:    'owner',
      bootId:         BRIDGE_BOOT_ID,
    };
  }

  // Treasury gas funding is RETIRED (it signed a transfer from the shared
  // agent wallet). Callers that did not send skipGasFunding:true still get the
  // provisioned key, UNFUNDED - the owner wallet must grant the session
  // address its gas (self-funded open PTB), exactly like the live frontend
  // flow does.
  console.log(`[signer] provisioned ${useEnclave ? 'ENCLAVE' : 'turnkey'} session key ${suiAddress} (owner ${ownerAddress ?? 'unknown'}) - caller did not send skipGasFunding; treasury gas funding is RETIRED, address left unfunded`);
  return {
    configured:     true,
    backend:        useEnclave ? 'enclave' : 'turnkey',
    sessionAddress: suiAddress,
    publicKeyHex,
    gasFunded:      false,
    gasFundedMist:  '0',
    note:           'treasury gas funding retired - fund the session address from the owner wallet (self-funded open)',
    bootId:         BRIDGE_BOOT_ID,
  };
}

// -- Handler: /sweep-session-gas -------------------------------------------------
// Return a closed/finished session key's LEFTOVER GAS to the session's OWNER.
// Self-funded sessions grant the dedicated key ~0.5 SUI at open; whatever it
// did not burn on trade gas is stranded there after close, because only the
// Turnkey-held key can move it. This signs ONE final transfer of the entire
// remaining SUI balance back to the owner recorded at provision time.
//
// Owner-directed BY CONSTRUCTION: funds always go to session_signers'
// owner_address - the caller cannot supply a recipient, so the worst a caller
// with the API key can do is return someone's own gas to them early.
//
// Refuses:
//   - enclave-backed sessions (ONE shared enclave address serves every enclave
//     session - sweeping it would strand gas for the live ones);
//   - addresses that are not provisioned session keys (never sweeps the shared
//     agent wallet or arbitrary addresses);
//   - rows with no recorded owner (nowhere safe to send).
// Dust guard: balances too small to cover the sweep's own gas return
// { swept:false, reason:'dust' } instead of failing.
//
// Body: { sessionId? , sessionAddress?, rpcUrl? }  (one of the two ids)
async function handleSweepSessionGas(body) {
  const { sessionId, sessionAddress, rpcUrl } = body ?? {};
  if (!sessionId && !sessionAddress) throw new Error('sessionId or sessionAddress required');

  const pool = signerPool();
  if (!pool) return { configured: false, reason: 'database_url_unset' };
  await ensureSignersTable(pool);

  const client = makeClient(rpcUrl);

  // Resolve the signer row: by bound session_id first (survives close), then by
  // address - reading the session object's session_address as a fallback for
  // rows that never lazily bound (a session that never traded).
  let row = null;
  if (sessionId) {
    const r = await pool.query(
      `SELECT sui_address, sign_with, public_key_hex, owner_address, is_enclave
       FROM session_signers WHERE session_id = $1`, [sessionId]);
    row = r.rows[0] ?? null;
  }
  if (!row) {
    let addr = typeof sessionAddress === 'string' ? sessionAddress.toLowerCase() : null;
    if (!addr && sessionId) {
      try { addr = await sessionAddressOf(client, sessionId); } catch { /* object gone */ }
    }
    if (addr) {
      const r = await pool.query(
        `SELECT sui_address, sign_with, public_key_hex, owner_address, is_enclave
         FROM session_signers WHERE sui_address = $1`, [addr]);
      row = r.rows[0] ?? null;
    }
  }
  if (!row)             throw new Error('no provisioned session key found for this session - nothing to sweep');
  if (row.is_enclave)   return { swept: false, reason: 'enclave_shared_address' };
  if (!row.owner_address) throw new Error('session key has no recorded owner - refusing to sweep');

  const address = row.sui_address;
  const owner   = row.owner_address;

  // Entire remaining SUI balance at the session key address.
  const coinsRes = await client.listCoins({ owner: address, coinType: '0x2::sui::SUI' });
  const coinList = coinsRes?.objects ?? coinsRes?.data ?? [];
  const totalMist = coinList.reduce((s, c) => s + BigInt(c.balance ?? c.coinBalance ?? 0), 0n);
  // Must cover its own gas with real margin (typical transfer ~1.1e6 MIST).
  if (totalMist < 3_000_000n) {
    return { swept: false, reason: 'dust', balanceMist: totalMist.toString() };
  }

  // transferObjects([tx.gas]) sends the ENTIRE gas coin (all SUI at the
  // sender, every coin merged) minus the fee - the canonical send-all.
  const tx = new Transaction();
  tx.setSender(address);
  tx.transferObjects([tx.gas], owner);

  const sessionKey = { signWith: row.sign_with, publicKeyHex: row.public_key_hex };
  // No fallbackKeypair: sessionKey is always set here, and signViaEnclave
  // hard-throws rather than sign with anything else.
  const result = await signViaEnclave({
    client, transaction: tx, sessionKey,
    include: { balanceChanges: true },
  });
  if (!txOk(result)) throw new Error(`gas sweep failed: ${txErrorOf(result) ?? 'transaction failed'}`);

  // Exact amount the owner received, from balanceChanges when available.
  let sweptMist = null;
  const changes = result?.balanceChanges ?? result?.effects?.balanceChanges ?? [];
  for (const ch of changes) {
    const chOwner = ch?.owner?.AddressOwner ?? ch?.owner;
    if (typeof chOwner === 'string' && chOwner.toLowerCase() === owner.toLowerCase()
        && String(ch?.coinType ?? '').includes('sui::SUI') && BigInt(ch?.amount ?? 0) > 0n) {
      sweptMist = BigInt(ch.amount).toString();
      break;
    }
  }
  if (sweptMist == null) sweptMist = totalMist.toString(); // gross-of-fee approximation

  console.log(`[signer] swept ${sweptMist} MIST leftover gas from session key ${address} back to owner ${owner}`);
  return {
    swept:     true,
    sweptMist,
    owner,
    sessionAddress: address,
    txDigest:  txDigestOf(result),
    bootId:    BRIDGE_BOOT_ID,
  };
}

// -- Handler: /status ---------------------------------------------------------
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

// -- HTTP server ---------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  // CORS preflight - browsers send OPTIONS before a cross-origin POST. Answer it
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
    jsonResp(res, 405, { error: 'Method not allowed - use POST' });
    return;
  }

  let body;
  try {
    body = await parseBody(req);
  } catch (e) {
    jsonResp(res, 400, { error: e.message });
    return;
  }

  // Retired shared-agent-wallet endpoints: answer 410 BEFORE the auth gate so
  // any lingering caller gets the retirement message, not an auth error.
  if (Object.prototype.hasOwnProperty.call(RETIRED_ENDPOINTS, req.url)) {
    jsonResp(res, 410, { ok: false, error: RETIRED_ENDPOINTS[req.url] });
    return;
  }

  try {
    let result;
    // Auth gate: write endpoints (session trades, provisioning, gas sweeps)
    // require the shared secret. Reads (/status /health) are open. The key is
    // sent by our own server-side callers only (Vercel proxy, brain), never
    // the browser.
    if (WRITE_ENDPOINTS.has(req.url)) {
      if (AGENT_API_KEY) {
        const provided = req.headers['x-agent-key'];
        if (provided !== AGENT_API_KEY) {
          jsonResp(res, 401, { ok: false, error: 'unauthorized' });
          return;
        }
      } else {
        console.warn(`[bridge] WARNING: AGENT_API_KEY unset - ${req.url} is OPEN to anyone. Set AGENT_API_KEY in env to lock write endpoints.`);
      }
    }
    switch (req.url) {
      case '/session-buy':  result = await handleSessionBuy(body);  break;
      case '/session-sell': result = await handleSessionSell(body); break;
      case '/provision-session-key': result = await handleProvisionSessionKey(body); break;
      case '/sweep-session-gas': result = await handleSweepSessionGas(body); break;
      case '/status': result = await handleStatus(body); break;
      case '/health': result = { status: 'ok', ts: Date.now(), bootId: BRIDGE_BOOT_ID, uptimeMs: Date.now() - BRIDGE_BOOT_TS, turnkey: turnkeyConfigured(), enclave: enclaveConfigured(), signerDb: !!process.env.DATABASE_URL, legacySigner: LEGACY_SIGNER_ENABLED }; break;
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
  console.log(`[bridge] Endpoints: /session-buy /session-sell /provision-session-key /sweep-session-gas /status /health (retired -> 410: /buy /sell /claim /launch)`);
  console.log(`[bridge] Turnkey: ${turnkeyConfigured() ? 'CONFIGURED' : 'not configured'}; Enclave: ${enclaveConfigured() ? 'CONFIGURED (' + process.env.ENCLAVE_SIGNER_URL + ')' : 'not configured'}; signer DB: ${process.env.DATABASE_URL ? 'set' : 'unset'}`);
  if (LEGACY_SIGNER_ENABLED) {
    console.warn('[bridge] *** SUIPUMP_LEGACY_SIGNER=1 - shared agent wallet key is LOADABLE for legacy fallback-session drain (/session-sell) - unset after draining ***');
  }
});

export { handleSessionBuy, handleSessionSell, handleProvisionSessionKey };
