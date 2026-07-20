// graduation-test-turbos/graduate_turbos_full.js
// Graduates a SuiPump bonding curve to a Turbos CLMM pool.
//
// GRAPHQL-ONLY (JSON-RPC purge, 2026-07-20): this module runs on the v2
// SuiGraphQLClient exclusively. The turbos-clmm-sdk dependency is GONE - it was
// JSON-RPC-internal (its 3.6.4 release peer-pinned @mysten/sui v1, whose
// default client speaks only JSON-RPC), so its two on-chain writes are now
// hand-built PTB moveCalls that reproduce the SDK's exact call shapes:
//   pool_factory::deploy_pool_and_mint  (create pool + first liquidity + NFT)
//   position_manager::mint              (add protocol-half liquidity)
// The Turbos deployment ids (PackageId, PoolConfig, Positions, Versioned, fee
// tier objects) come from the SAME runtime source the SDK used:
// https://s3.amazonaws.com/app.turbos.finance/sdk/contract.json - fetched per
// run, never hardcoded, so a Turbos package upgrade needs no code change here.
//
// DUAL-MODE:
//   - Exported function: graduateToTurbos({ curveId, tokenType, pkgId })
//     Called by indexer/auto_graduate.js. Callers pass PLAIN STRINGS ONLY.
//     THIS MODULE OWNS ITS CLIENT AND KEYPAIR: the graduation dirs pin their
//     own @mysten/sui installs, and client/keypair instances constructed
//     across node_modules boundaries fail internal checks - so injected
//     client objects are refused by design. Client comes from defaultClient()
//     (env SUI_GRAPHQL_URL, bridge.js-style default), keypair from
//     defaultKeypair() (env GRADUATION_SIGNER_KEY).  No process.exit.
//
//   SIGNER SEPARATION (do not conflate): the graduation signer reads
//   GRADUATION_SIGNER_KEY ONLY. In GraduationCap mode (SUIPUMP_V14_PACKAGE +
//   SUIPUMP_GRADUATION_CAP + SUIPUMP_GRADUATION_REGISTRY set) that key is the
//   DEDICATED graduation wallet
//   0x7334d47632af5386d9b16326ade55be642fc8a569a1672b0cbaaf4d0e7e6180a (owns only
//   the GraduationCap; the AdminCap key stays cold). In the pre-V14 AdminCap
//   fallback it is the main wallet holding the AdminCap - TESTNET-ONLY EXPEDIENT,
//   see indexer/write_target.js. It MUST NEVER read SUI_PRIVATE_KEY - that is the
//   PRICE RELAYER's key (a different wallet).
//
//   - Standalone CLI: node graduate_turbos_full.js <CURVE_ID>
//     Uses env GRADUATION_SIGNER_KEY + SUI_GRAPHQL_URL (optional; defaults to
//     the public testnet GraphQL endpoint), calls process.exit on failure.
//
// Steps:
//   1. graduate()               - mark curve graduated, pay bonuses
//   2. claim_graduation_funds() - pull SUI reserve + LP tokens to admin wallet
//   3. Split 50/50              - creator half + protocol half
//   4. Create Turbos CLMM pool  - full tick range, 1% fee tier
//   5. Add both halves          - creator gets LP NFT, protocol keeps theirs
//   6. record_graduation_pool() - write pool_id on-chain

import { Transaction } from '@mysten/sui/transactions';
import { SuiGraphQLClient } from '@mysten/sui/graphql';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import Decimal from 'decimal.js';
import { fromBase64 } from '@mysten/sui/utils';
import { LATEST_WRITE_PACKAGE, V13_PACKAGE, V14_PACKAGE, assertWriteTarget, graduationAuthority } from '../indexer/write_target.js';

// -- Constants -----------------------------------------------------------------
const SUI_TYPE     = '0x2::sui::SUI';
const MIN_TICK     = -443636;
const MAX_TICK     =  443636;
const TOKEN_DECIMALS = 6;
const SUI_DECIMALS   = 9;
const SUI_CLOCK_ID   = '0x6';

// Same network convention as indexer/auto_graduate.js (the worker that imports
// this module). Drives both the GraphQL default endpoint and which section of
// the Turbos contract.json is used. Default preserves the previous hardcoded
// Network.testnet behavior exactly.
const NETWORK = process.env.NETWORK ?? 'testnet';

// The runtime source of the Turbos deployment ids - the SAME URL the retired
// turbos-clmm-sdk fetched internally (verified against sdk 3.6.4 and 4.0.0
// sources), so behavior is unchanged: ids track Turbos upgrades with no code
// change here.
const TURBOS_CONTRACT_JSON_URL = 'https://s3.amazonaws.com/app.turbos.finance/sdk/contract.json';

// SDK-parity trade parameters. Slippage is in PERCENT (turbos-clmm-sdk
// getMinimumAmountBySlippage divides by 100): 0.05 = 0.05%, exactly what the
// previous sdk.pool.createPool({ slippage: 0.05 }) calls sent on-chain.
const SLIPPAGE_PCT = 0.05;
const DEADLINE_MS  = 60_000;

// V10-lineage package IDs (defining + upgrades). A curve's pkgId is its DEFINING
// package; graduate/claim/record WRITES target the latest upgrade below.
const PKG_V10 = '0x2deda2cade65cd5afd5ffbe799d48f2491debf08d3aef6fa11aa6e1c8afe1598';
const PKG_V11 = '0xc03817bce45ff492e5d0f40f9e46f5a075a952b50c5c6146b8fb38138bd699eb';
const PKG_V12 = '0xf5a3566ba920a3e3614e8b25da0ca3237879b6e22eb12f21ccf2bceb6520b9cd';

// LATEST_WRITE_PACKAGE is env-driven (SUIPUMP_LATEST_WRITE_PACKAGE) via
// ../indexer/write_target.js - Carlos flips the env var with no code change.

// Remap a curve's DEFINING package -> the latest upgrade of ITS OWN lineage
// (calls to an old package address run OLD bytecode; types stay defined by the
// defining package). Unmapped packages pass through unchanged.
const WRITE_PACKAGE = {
  [PKG_V10]: LATEST_WRITE_PACKAGE,
  [PKG_V11]: LATEST_WRITE_PACKAGE,
  [PKG_V12]: LATEST_WRITE_PACKAGE,
  // V13 lineage: V14 is its latest COMPATIBLE (additive) upgrade - V13 stays the
  // curves' type identity forever; WRITES run the newest bytecode. Env-gated,
  // null-safe conditional spread: with either id unset, V13 passes through to
  // itself (pre-V14 behavior).
  ...(V13_PACKAGE && V14_PACKAGE ? { [V13_PACKAGE]: V14_PACKAGE } : {}),
};
function writePackageFor(pkgId) {
  return WRITE_PACKAGE[pkgId] ?? pkgId;
}

// V13 (SEPARATE lineage) AdminCap - held on the MAIN wallet (GRADUATION_SIGNER_KEY).
// TESTNET-ONLY EXPEDIENT - see the module header + indexer/auto_graduate.js.
const ADMIN_CAP_V13 = '0xb3d3155ca1bc153664143895928aa77384f5c70f752c306e10fa619f460e039d';

// AdminCap IDs by DEFINING package version - kept in sync with auto_graduate.js.
// The whole V10 lineage (V10/V11/V12+) shares one AdminCap
// (0x144d426960a9a6b8db63ce3426e06a9c41273a17e72ed0193cd8c8507d4f6ec5). V13 is its
// OWN lineage with its OWN AdminCap (env-gated key so the V13 package id is not
// hardcoded; the cap value follows the existing per-version literal pattern).
const ADMIN_CAPS = {
  '0x2154486dcf503bd3e8feae4fb913e862f7e2bbf4489769aff63978f55d55b4a8': '0xfc80d40718e8e9d0bc1fddc1e47a74e46d0c89c3e1e36a2bc8f016efb6d51e0c',
  '0x785c0604cb6c60a8547501e307d2b0ca7a586ff912c8abff4edfb88db65b7236': '0xfc80d40718e8e9d0bc1fddc1e47a74e46d0c89c3e1e36a2bc8f016efb6d51e0c',
  '0x21d5b1284d5f1d4d14214654f414ffca20c757ee9f9db7701d3ffaaac62cd768': '0xfc80d40718e8e9d0bc1fddc1e47a74e46d0c89c3e1e36a2bc8f016efb6d51e0c',
  '0xfb8f3f3e4e8d53130ac140906eebea6b6740bfaf0c971aec607fbc723be951f0': '0x1dc44030adaa6e366666a8e095fc29a5a55c8ae614f04c5e93c062a85b475527',
  '0x145a1e79b83cc17680dbfe4f96839cd359c7db380ac15463ecb6dc30f9849b69': '0xdb22e067d9cf53cfab37bc6d4b626ff98c770bc59b8a192d007aca449e8f7103',
  '0xbb4ee050239f59dfd983501ce101698ba27857f77aff2d437cec568fe0062546': '0x9779a2466f2e30ca5e139f636cc9ca1c44e025da29203d781cc2645ebb62bb35',
  [PKG_V10]: '0x144d426960a9a6b8db63ce3426e06a9c41273a17e72ed0193cd8c8507d4f6ec5',
  [PKG_V11]: '0x144d426960a9a6b8db63ce3426e06a9c41273a17e72ed0193cd8c8507d4f6ec5',
  [PKG_V12]: '0x144d426960a9a6b8db63ce3426e06a9c41273a17e72ed0193cd8c8507d4f6ec5',
  ...(V13_PACKAGE ? { [V13_PACKAGE]: ADMIN_CAP_V13 } : {}),
};

// -- Helpers -------------------------------------------------------------------
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function fmtSui(mist) { return `${(Number(BigInt(mist)) / 1e9).toFixed(4)} SUI`; }

// The v2 SuiGraphQLClient - same env + default as suipump-nexus-tools/bridge.js
// makeClient and indexer/auto_graduate.js. SUIPUMP_JSONRPC_URL / SUI_RPC_URL
// (the retired JSON-RPC endpoint vars) are DEPRECATED and ignored: JSON-RPC is
// forbidden repo-wide (hard shutdown 2026-07-31) and this module no longer
// speaks it. Exported so read-only tooling (scripts/dryrun_graduation_load.js)
// can build this module's own client flavor without duplicating the env
// handling.
export function defaultClient() {
  if ((process.env.SUIPUMP_JSONRPC_URL || process.env.SUI_RPC_URL) && !process.env.SUI_GRAPHQL_URL) {
    console.warn('  [turbos] SUIPUMP_JSONRPC_URL / SUI_RPC_URL are deprecated and IGNORED (JSON-RPC is retired) - set SUI_GRAPHQL_URL to override the GraphQL endpoint');
  }
  const url = process.env.SUI_GRAPHQL_URL ?? 'https://graphql.' + NETWORK + '.sui.io/graphql';
  return new SuiGraphQLClient({ url });
}

function defaultKeypair() {
  // GRADUATION signer only. GraduationCap mode (V14 env triplet set): the
  // DEDICATED graduation wallet
  // 0x7334d47632af5386d9b16326ade55be642fc8a569a1672b0cbaaf4d0e7e6180a, owner of
  // the GraduationCap
  // 0xe1eeaf7620fe62bc4e0d207821760c69a84758c757c47000790292f1a8d905ee (the
  // AdminCap key stays cold). AdminCap fallback: the main wallet that holds the
  // AdminCap - TESTNET-ONLY EXPEDIENT. Either way this MUST read
  // GRADUATION_SIGNER_KEY and NEVER SUI_PRIVATE_KEY - SUI_PRIVATE_KEY is the price
  // relayer's key (a different wallet holding neither cap), and conflating the two
  // would make graduation sign with a wallet that cannot use either capability.
  const raw = process.env.GRADUATION_SIGNER_KEY;
  if (!raw) throw new Error('GRADUATION_SIGNER_KEY env var not set (graduation signer; this is NOT SUI_PRIVATE_KEY, the price relayer key)');
  const bytes = fromBase64(raw);
  const seed  = bytes.length === 65 ? bytes.slice(1) : bytes;
  return Ed25519Keypair.fromSecretKey(seed);
}

// v2 getObject shape: ({ objectId }) -> result.object.owner.Shared.initialSharedVersion
// (never the JSON-RPC { id, options } shape).
async function getSharedVersion(client, objectId) {
  const obj = await client.getObject({ objectId });
  return obj?.object?.owner?.Shared?.initialSharedVersion;
}

// Read a Move object's struct fields as JSON (v2: include.json puts them on
// result.object.json - the equivalent of the old showContent fields).
async function getObjectJson(client, objectId) {
  const obj = await client.getObject({ objectId, include: { json: true } });
  return { type: obj?.object?.type ?? null, fields: obj?.object?.json ?? {} };
}

// -- Execution result readback (v2 discriminated union) ------------------------
// executeTransaction returns the same shape bridge.js/price_publisher.js consume:
//   { $kind: 'Transaction',       Transaction:       { digest, status, ... } }
//   { $kind: 'FailedTransaction', FailedTransaction: { digest, status: { error } } }
function txOk(result) {
  return result?.$kind === 'Transaction' || result?.Transaction?.status?.success === true;
}
function txErrorOf(result) {
  return result?.FailedTransaction?.status?.error
      ?? result?.Transaction?.status?.error
      ?? null;
}
function txDigestOf(result) {
  return result?.Transaction?.digest
      ?? result?.FailedTransaction?.digest
      ?? null;
}
// status.error is a structured object ({ $kind, message, MoveAbort? }) on the v2
// client; render it for logs/throws.
function errText(err) {
  if (err == null) return 'transaction failed';
  if (typeof err === 'string') return err;
  if (typeof err.message === 'string') return err.message;
  return JSON.stringify(err, (_k, v) => typeof v === 'bigint' ? v.toString() : v);
}

// Build/sign/execute - the repo's proven SuiGraphQLClient shape (mirrors
// indexer/price_publisher.js pushPrice): tx.build({ client }) -> keypair
// signTransaction -> executeTransaction({ transaction: bytes, signatures: [sig] }).
// NEVER signAndExecuteTransaction, never a JSON-RPC client.
async function signExecute(client, keypair, tx, include) {
  tx.setSender(keypair.toSuiAddress());
  const bytes     = await tx.build({ client });
  const signature = (await keypair.signTransaction(bytes)).signature;
  return client.executeTransaction({ transaction: bytes, signatures: [signature], include });
}

// Created objects of an executed tx. Requires include { effects: true,
// objectTypes: true }: effects.changedObjects carries idOperation 'Created',
// objectTypes maps objectId -> full type string.
function createdObjectsOf(result) {
  const t = result?.Transaction ?? result?.FailedTransaction;
  const types = t?.objectTypes ?? {};
  return (t?.effects?.changedObjects ?? [])
    .filter(c => c.idOperation === 'Created')
    .map(c => ({ objectId: c.objectId, type: types[c.objectId] ?? null }));
}

// Extract the recorded pool_id (Option<ID>) from the curve's JSON fields.
// None serializes variously (null / empty vec); Some as an id string. The zero
// address counts as absent. Returns the id string or null.
function extractPoolId(fields) {
  const p = fields?.pool_id;
  if (p == null) return null;
  if (typeof p === 'string') return (p.length === 0 || /^0x0+$/.test(p)) ? null : p;
  if (Array.isArray(p)) return p.length ? p[0] : null;
  if (Array.isArray(p.vec)) return p.vec.length ? p.vec[0] : null;
  if (p.fields && Array.isArray(p.fields.vec)) return p.fields.vec.length ? p.fields.vec[0] : null;
  return null;
}

// Mirror of the on-chain V13 getter grad_funds_claimed<T>(&Curve<T>): bool,
// which is df::exists(&curve.id, b"grad_funds_claimed") in bonding_curve.move.
// Instead of a devInspect (JSON-RPC-only surface), read the curve's dynamic
// fields directly and look for that exact marker: name type vector<u8>, name
// BCS = uleb length prefix + the key bytes. A plain read - retry-safe, and
// definitive absence needs no error classification.
const GRAD_CLAIMED_KEY = 'grad_funds_claimed';
async function isGradFundsClaimed({ client, curveId }) {
  const keyBytes = new TextEncoder().encode(GRAD_CLAIMED_KEY);
  let cursor = null;
  do {
    const page = await client.listDynamicFields({ parentId: curveId, cursor });
    for (const f of page?.dynamicFields ?? []) {
      if (f?.name?.type !== 'vector<u8>') continue;
      const bcs = f.name.bcs; // Uint8Array: [len, ...bytes] (len < 128 -> single ULEB byte)
      if (!bcs || bcs.length !== keyBytes.length + 1 || bcs[0] !== keyBytes.length) continue;
      let match = true;
      for (let i = 0; i < keyBytes.length; i++) {
        if (bcs[i + 1] !== keyBytes[i]) { match = false; break; }
      }
      if (match) return true;
    }
    cursor = page?.hasNextPage ? page.cursor : null;
  } while (cursor);
  return false;
}

// GraphQL events connection - the exact query shape indexer/index.js uses for
// its backfill (client.query + events(filter: { type })).
const EVENTS_QUERY = `
  query TurbosGradEvents($type: String!, $after: String, $first: Int!) {
    events(filter: { type: $type } first: $first after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes { contents { json } }
    }
  }
`;

// Recover the claimed pool SUI size from the GraduationFundsClaimed event
// { curve_id, sui_amount, lp_amount }. Used to re-size the pool when a prior run
// claimed but failed before creating the pool. eventPkg is the curve's DEFINING
// package (V13 for the V13 lineage): events keep their defining ids forever, even
// when emitted by upgraded V14 bytecode (claim_graduation_funds_with_cap), so the
// event TYPE must NOT track the write package. Pagination is ascending (GraphQL
// connection order); the event is emitted at most once per curve, so scan order
// does not matter.
async function fetchClaimedSuiAmount({ client, eventPkg, curveId }) {
  const eventType = `${eventPkg}::bonding_curve::GraduationFundsClaimed`;
  const want = String(curveId).toLowerCase();
  let cursor = null;
  for (let page = 0; page < 40; page++) {
    const result = await client.query({
      query: EVENTS_QUERY,
      variables: { type: eventType, after: cursor, first: 50 },
    });
    if (result.errors?.length) throw new Error(result.errors.map(e => e.message).join('; '));
    for (const node of result.data?.events?.nodes ?? []) {
      const pj = node?.contents?.json ?? {};
      if (String(pj.curve_id ?? '').toLowerCase() === want) return BigInt(pj.sui_amount ?? 0);
    }
    const pi = result.data?.events?.pageInfo;
    if (!pi?.hasNextPage || !pi?.endCursor) break;
    cursor = pi.endCursor;
  }
  return null;
}

// Detect the F-2 backstop abort EReserveTooLow (code 52) - claim_graduation_funds
// aborts 52 when the graduated reserve is below the 1000 SUI floor (likely
// oracle-manipulated / griefed graduation). Accepts either a thrown Error /
// string or the v2 structured status.error ({ $kind: 'MoveAbort', message,
// MoveAbort: { abortCode } }).
function isReserveTooLow(err) {
  if (err == null) return false;
  const code = err?.MoveAbort?.abortCode ?? err?.abortCode;
  if (code != null && Number(code) === 52) return true;
  const s = errText(err);
  return s.includes('EReserveTooLow')
    || /abort code:\s*52\b/.test(s)
    || /,\s*52\)/.test(s)
    || /MoveAbort\([^)]*\b52\b/.test(s);
}

// -- Turbos deployment config --------------------------------------------------

// Fetch the Turbos deployment ids for this network - the SAME runtime JSON the
// retired SDK read. Returns { contract: { PackageId, PoolConfig, Positions,
// Versioned, ... }, fee: { '10000bps': '0x...', ... } }.
async function fetchTurbosConfig() {
  const res = await fetch(TURBOS_CONTRACT_JSON_URL + '?t=' + Date.now(), {
    method: 'GET', signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Turbos contract.json HTTP ${res.status}`);
  const json = await res.json();
  const net = json?.[NETWORK];
  if (!net?.contract?.PackageId) throw new Error(`Turbos contract.json has no ${NETWORK} deployment`);
  return net;
}

// Resolve the fee-tier objects on-chain: each is a shared
// {PackageIdOriginal}::fee::Fee<FEE_TYPE> whose json fields are { fee,
// tick_spacing } and whose FEE_TYPE type parameter is the third type argument
// of every pool call (sdk.contract.getFees parity).
async function fetchTurbosFees(client, feeIdMap) {
  const fees = [];
  for (const objectId of Object.values(feeIdMap ?? {})) {
    try {
      const obj = await client.getObject({ objectId, include: { json: true } });
      const typeStr = obj?.object?.type ?? '';
      const inner = typeStr.includes('<') ? typeStr.split('<')[1].slice(0, -1) : null;
      const j = obj?.object?.json ?? {};
      if (!inner || j.fee == null) continue;
      fees.push({ objectId, type: inner, fee: Number(j.fee), tickSpacing: Number(j.tick_spacing) });
    } catch (err) {
      console.warn(`  [turbos] ! fee object ${objectId} unreadable: ${err.message}`);
    }
  }
  if (!fees.length) throw new Error('No Turbos fee tiers resolvable on-chain');
  return fees;
}

// -- SDK math parity -----------------------------------------------------------

// sqrtPriceX64 = floor(sqrt(price * 10^(decimalsB - decimalsA)) * 2^64) -
// a verbatim port of turbos-clmm-sdk math.priceToSqrtPriceX64 (same Decimal
// library, same default precision). Returns a decimal string for tx.pure.u128.
function priceToSqrtPriceX64(price, decimalsA, decimalsB) {
  return new Decimal(price)
    .mul(Decimal.pow(10, decimalsB - decimalsA))
    .sqrt()
    .mul(Decimal.pow(2, 64))
    .floor()
    .toFixed(0);
}

// amount * (1 - slippagePct/100), floored - a verbatim port of the SDK's
// getMinimumAmountBySlippage (slippage is in PERCENT). Takes a BigInt.
function minAmountBySlippage(amount, slippagePct) {
  const ratio = new Decimal(1).minus(new Decimal(slippagePct).div(100));
  if (ratio.lte(0) || ratio.gt(1)) throw new Error('invalid slippage range');
  return new Decimal(amount.toString()).mul(ratio).toFixed(0);
}

// -- Coin sourcing (SDK selectTradeCoins/convertTradeCoins parity) --------------

// All Coin<coinType> objects owned by `owner` (paginated). Returns
// [{ objectId, balance: BigInt }].
async function listAllCoins(client, owner, coinType) {
  const out = [];
  let cursor = null;
  do {
    const page = await client.listCoins({ owner, coinType, cursor });
    for (const c of page?.objects ?? []) {
      out.push({ objectId: c.objectId, balance: BigInt(c.balance ?? 0) });
    }
    cursor = page?.hasNextPage ? page.cursor : null;
  } while (cursor);
  return out;
}

// vector<Coin<T>> holding EXACTLY `amount`, SDK convertTradeCoins parity:
//   SUI   -> split from gas (the SDK did txb.splitCoins(txb.gas, [amount]))
//   other -> merge every owned coin into the first, split the exact amount
function exactCoinVec(tx, coinType, coinIds, amount) {
  if (coinType === SUI_TYPE) {
    const [exact] = tx.splitCoins(tx.gas, [tx.pure.u64(amount)]);
    return tx.makeMoveVec({ elements: [exact] });
  }
  const [first, ...rest] = coinIds;
  const primary = tx.object(first);
  if (rest.length) tx.mergeCoins(primary, rest.map(id => tx.object(id)));
  const [exact] = tx.splitCoins(primary, [tx.pure.u64(amount)]);
  return tx.makeMoveVec({ elements: [exact] });
}

// -- Turbos PTB builders (hand-rolled, SDK call-shape parity) -------------------

// pool_factory::deploy_pool_and_mint<CoinA, CoinB, FeeType> - argument order
// verified against turbos-clmm-sdk 3.6.4 pool.createPool (and unchanged in 4.0.0):
// pool_config, fee_object, sqrt_price: u128, positions, vector<Coin<A>>,
// vector<Coin<B>>, |tick_lower|: u32, tick_lower_is_neg: bool, |tick_upper|: u32,
// tick_upper_is_neg: bool, amount_a: u64, amount_b: u64, amount_a_min: u64,
// amount_b_min: u64, recipient: address, deadline: u64, clock, versioned.
function buildDeployPoolAndMint({ tx, turbos, fee, coinTypeA, coinTypeB, coinVecA, coinVecB, tickLower, tickUpper, sqrtPrice, amountA, amountB, recipient }) {
  tx.moveCall({
    target: `${turbos.contract.PackageId}::pool_factory::deploy_pool_and_mint`,
    typeArguments: [coinTypeA, coinTypeB, fee.type],
    arguments: [
      tx.object(turbos.contract.PoolConfig),
      tx.object(fee.objectId),
      tx.pure.u128(sqrtPrice),
      tx.object(turbos.contract.Positions),
      coinVecA,
      coinVecB,
      tx.pure.u32(Math.abs(tickLower)),
      tx.pure.bool(tickLower < 0),
      tx.pure.u32(Math.abs(tickUpper)),
      tx.pure.bool(tickUpper < 0),
      tx.pure.u64(amountA),
      tx.pure.u64(amountB),
      tx.pure.u64(minAmountBySlippage(amountA, SLIPPAGE_PCT)),
      tx.pure.u64(minAmountBySlippage(amountB, SLIPPAGE_PCT)),
      tx.pure.address(recipient),
      tx.pure.u64(Date.now() + DEADLINE_MS),
      tx.sharedObjectRef({ objectId: SUI_CLOCK_ID, initialSharedVersion: 1, mutable: false }),
      tx.object(turbos.contract.Versioned),
    ],
  });
}

// position_manager::mint<CoinA, CoinB, FeeType> - argument order verified
// against turbos-clmm-sdk 3.6.4 pool.addLiquidity: pool, positions,
// vector<Coin<A>>, vector<Coin<B>>, ticks (same 4-arg encoding), amounts,
// mins, recipient, deadline, clock, versioned.
function buildAddLiquidity({ tx, turbos, fee, poolId, poolSharedVersion, coinTypeA, coinTypeB, coinVecA, coinVecB, tickLower, tickUpper, amountA, amountB, recipient }) {
  tx.moveCall({
    target: `${turbos.contract.PackageId}::position_manager::mint`,
    typeArguments: [coinTypeA, coinTypeB, fee.type],
    arguments: [
      tx.sharedObjectRef({ objectId: poolId, initialSharedVersion: poolSharedVersion, mutable: true }),
      tx.object(turbos.contract.Positions),
      coinVecA,
      coinVecB,
      tx.pure.u32(Math.abs(tickLower)),
      tx.pure.bool(tickLower < 0),
      tx.pure.u32(Math.abs(tickUpper)),
      tx.pure.bool(tickUpper < 0),
      tx.pure.u64(amountA),
      tx.pure.u64(amountB),
      tx.pure.u64(minAmountBySlippage(amountA, SLIPPAGE_PCT)),
      tx.pure.u64(minAmountBySlippage(amountB, SLIPPAGE_PCT)),
      tx.pure.address(recipient),
      tx.pure.u64(Date.now() + DEADLINE_MS),
      tx.sharedObjectRef({ objectId: SUI_CLOCK_ID, initialSharedVersion: 1, mutable: false }),
      tx.object(turbos.contract.Versioned),
    ],
  });
}

// -- Core exported function ----------------------------------------------------

/**
 * Graduates a SuiPump curve to a Turbos CLMM pool.
 * Called by auto_graduate.js - never calls process.exit.
 *
 * Takes plain strings ONLY. The module builds its own client + keypair from
 * env (SUI_GRAPHQL_URL, GRADUATION_SIGNER_KEY): this dir pins its own
 * @mysten/sui install, so injected client/keypair objects are refused by
 * design (classes across node_modules boundaries fail internal checks).
 *
 * @param {object} opts
 * @param {string}   opts.curveId   - Shared curve object ID
 * @param {string}   opts.tokenType - Full Move type e.g. 0x...::template::TEMPLATE
 * @param {string}   opts.pkgId     - Package ID the curve was launched on
 * @returns {Promise<{ poolId: string, txDigest: string }>}
 */
export async function graduateToTurbos({ curveId, tokenType, pkgId }) {
  // Module-owned client + keypair (env-driven) - see module header.
  const client  = defaultClient();
  const keypair = defaultKeypair();

  const address    = keypair.toSuiAddress();
  // V14 (GRAD-1): resolve the graduation authority FIRST. In 'cap' mode the
  // AdminCap is never passed on-chain, so a missing ADMIN_CAPS entry (e.g. a V13
  // curve while SUIPUMP_V13_PACKAGE is unset in this process) must not block the
  // GraduationCap path; in 'admin' mode a missing AdminCap is still fatal.
  const gradAuth   = graduationAuthority();
  const adminCapId = ADMIN_CAPS[pkgId];
  if (gradAuth.mode !== 'cap' && !adminCapId) throw new Error(`No AdminCap for package ${pkgId}`);

  // pkgId is the DEFINING package; graduate/claim/record must target the latest
  // upgrade of its lineage that contains claim_graduation_funds.
  const writePkg = writePackageFor(pkgId);

  console.log(`  [turbos] Graduating ${curveId} -> Turbos CLMM`);
  console.log(`  [turbos] token: ${tokenType}`);
  console.log(`  [turbos] pkg:   ${pkgId} (write ${writePkg})`);
  // V14 (GRAD-1): state which graduation authority is active, with full ids.
  console.log(gradAuth.mode === 'cap'
    ? `  [turbos] auth:  GraduationCap ${gradAuth.cap} (registry ${gradAuth.registry}, pkg ${gradAuth.pkg})`
    : `  [turbos] auth:  AdminCap ${adminCapId} (pre-V14 path; set SUIPUMP_V14_PACKAGE+SUIPUMP_GRADUATION_CAP+SUIPUMP_GRADUATION_REGISTRY to use the GraduationCap)`);

  // -- Step 1: graduate() if needed -------------------------------------------
  let { fields } = await getObjectJson(client, curveId);

  if (!fields.graduated) {
    console.log(`  [turbos] [1/5] Calling graduate()...`);

    const metadataId = await (async () => {
      try { const m = await client.getCoinMetadata({ coinType: tokenType }); return m?.coinMetadata?.id ?? null; }
      catch { return null; }
    })();

    const sv  = await getSharedVersion(client, curveId);
    const tx  = new Transaction();
    const ref = tx.sharedObjectRef({ objectId: curveId, initialSharedVersion: sv, mutable: true });

    if (metadataId) {
      const metaSv  = await getSharedVersion(client, metadataId);
      const metaRef = metaSv
        ? tx.sharedObjectRef({ objectId: metadataId, initialSharedVersion: metaSv, mutable: true })
        : tx.object(metadataId);
      tx.moveCall({
        target: `${writePkg}::bonding_curve::graduate`,
        typeArguments: [tokenType],
        arguments: [ref, metaRef],
      });
    } else {
      tx.moveCall({
        target: `${writePkg}::bonding_curve::graduate`,
        typeArguments: [tokenType],
        arguments: [ref],
      });
    }

    const r = await signExecute(client, keypair, tx, { effects: true });
    if (!txOk(r)) throw new Error(`graduate() failed: ${errText(txErrorOf(r))}`);
    console.log(`  [turbos] + graduate: ${txDigestOf(r)}`);
    await sleep(3000);
    ({ fields } = await getObjectJson(client, curveId));
  } else {
    console.log(`  [turbos] [1/5] Already graduated - skipping`);
  }

  const creator = fields.creator ?? address;

  // -- Step 2: 4-state machine (graduated + grad_funds_claimed + pool_id) ------
  //   A  !graduated                          -> not ready (watcher shouldn't send)
  //   B  graduated && !claimed               -> claim now, size pool from sui_reserve
  //   C  graduated && claimed && no pool_id  -> recover size from event, build pool
  //   D  graduated && pool_id present        -> already done
  if (!fields.graduated) {
    // State A
    console.warn(`  [turbos] Curve not graduated - nothing to do, skipping`);
    return null;
  }

  const existingPool = extractPoolId(fields);
  if (existingPool) {
    // State D
    console.log(`  [turbos] Pool already recorded (${existingPool}) - already done`);
    return { poolId: existingPool, txDigest: null };
  }

  const claimed = await isGradFundsClaimed({ client, curveId });
  let poolSuiMist;

  if (!claimed) {
    // State B: reserve is full. Claim (both coins -> admin wallet); size from reserve.
    poolSuiMist = BigInt(fields.sui_reserve ?? 0);
    console.log(`  [turbos] [2/5] Claiming ${fmtSui(poolSuiMist)} + 200M LP...`);
    const sv2  = await getSharedVersion(client, curveId);
    const tx2  = new Transaction();
    const ref2 = tx2.sharedObjectRef({ objectId: curveId, initialSharedVersion: sv2, mutable: true });
    // claim_graduation_funds returns (Coin<SUI>, Coin<T>). BOTH returns must be
    // captured and transferred - the LP Coin<T> has no drop, so leaving it unused
    // fails the PTB.
    // V14 (GRAD-1): prefer the narrow GraduationCap path when the V14 env is set,
    // so the AdminCap key can stay cold. Falls back to the AdminCap path unchanged.
    const grad2 = graduationAuthority();
    const [poolSuiCoin, lpCoin] = tx2.moveCall({
      target: grad2.mode === 'cap'
        ? `${grad2.pkg}::bonding_curve::claim_graduation_funds_with_cap`
        : `${writePkg}::bonding_curve::claim_graduation_funds`,
      typeArguments: [tokenType],
      arguments: grad2.mode === 'cap'
        ? [tx2.object(grad2.cap), tx2.object(grad2.registry), ref2]
        : [tx2.object(adminCapId), ref2],
    });
    tx2.transferObjects([poolSuiCoin, lpCoin], address);
    let r2;
    try {
      r2 = await signExecute(client, keypair, tx2, { effects: true });
    } catch (err) {
      if (isReserveTooLow(err)) {
        console.warn(`  [turbos] ! ${curveId} graduated below the F-2 min-reserve floor (likely oracle-manipulated / griefed) - skipping, needs manual review`);
        return { poolId: null, txDigest: null, skipped: true, reason: 'reserve-too-low' };
      }
      throw err;
    }
    if (!txOk(r2)) {
      const e2 = txErrorOf(r2);
      if (isReserveTooLow(e2)) {
        console.warn(`  [turbos] ! ${curveId} graduated below the F-2 min-reserve floor (likely oracle-manipulated / griefed) - skipping, needs manual review`);
        return { poolId: null, txDigest: null, skipped: true, reason: 'reserve-too-low' };
      }
      throw new Error(`claim_graduation_funds() failed: ${errText(e2)}`);
    }
    console.log(`  [turbos] + claimed (SUI + LP): ${txDigestOf(r2)}`);
    await sleep(3000);
  } else {
    // State C: claimed in a prior run but pool creation failed. The SUI + 200M LP
    // are already in the admin wallet. Recover the pool SUI size from the
    // GraduationFundsClaimed event and rebuild the pool - do NOT throw.
    const recovered = await fetchClaimedSuiAmount({ client, eventPkg: pkgId, curveId });
    if (recovered == null || recovered === 0n) {
      throw new Error(`Claimed but GraduationFundsClaimed event not found for ${curveId} - cannot recover pool SUI size`);
    }
    poolSuiMist = recovered;
    console.log(`  [turbos] [2/5] Already claimed - recovered ${fmtSui(poolSuiMist)} pool SUI from GraduationFundsClaimed event; using LP already in wallet`);
  }

  // -- Step 3: Compute 50/50 split --------------------------------------------
  // LP now arrives in the admin wallet from claim_graduation_funds() above
  // (graduate() no longer mints the 200M LP allocation). GraphQL object
  // indexing can lag the claim by a beat - retry the read before giving up.
  let lpCoins = [];
  for (let i = 0; i < 10; i++) {
    lpCoins = await listAllCoins(client, address, tokenType);
    if (lpCoins.length) break;
    await sleep(3000);
  }
  if (!lpCoins.length) throw new Error('No LP tokens in admin wallet');
  const totalLp = lpCoins.reduce((s, c) => s + c.balance, 0n);
  const halfLp  = totalLp / 2n;
  const halfSui = poolSuiMist / 2n;

  console.log(`  [turbos] [3/5] Split: ${(Number(halfLp)/1e6).toLocaleString()} tokens + ${fmtSui(halfSui)} each half`);

  // -- Step 4: Turbos fee tier + sqrtPrice ------------------------------------
  console.log(`  [turbos] [4/5] Fetching Turbos config...`);
  const turbos = await fetchTurbosConfig();
  const fees   = await fetchTurbosFees(client, turbos.fee);
  const fee    = fees.find(f => f.fee === 10000) ?? fees[fees.length - 1];
  // Turbos fee units are hundredths of a bip: 10000 = 1%.
  console.log(`  [turbos] Fee tier: ${fee.fee / 10000}% (tickSpacing: ${fee.tickSpacing})`);

  // price = SUI per TOKEN (adjusted for decimals)
  const suiPerToken  = (Number(halfSui) / 1e9) / (Number(halfLp) / 1e6);
  const sqrtPriceX64 = priceToSqrtPriceX64(suiPerToken, TOKEN_DECIMALS, SUI_DECIMALS);

  const tickSpacing = fee.tickSpacing;
  const tickLower   = Math.ceil(MIN_TICK / tickSpacing) * tickSpacing;
  const tickUpper   = Math.floor(MAX_TICK / tickSpacing) * tickSpacing;

  // -- Step 5: Create Turbos pool + add creator half --------------------------
  console.log(`  [turbos] [5/5] Creating Turbos pool + adding creator liquidity...`);
  const poolTx = new Transaction();
  buildDeployPoolAndMint({
    tx: poolTx, turbos, fee,
    coinTypeA: tokenType,
    coinTypeB: SUI_TYPE,
    coinVecA:  exactCoinVec(poolTx, tokenType, lpCoins.map(c => c.objectId), halfLp),
    coinVecB:  exactCoinVec(poolTx, SUI_TYPE, [], halfSui),
    tickLower, tickUpper,
    sqrtPrice: sqrtPriceX64,
    amountA:   halfLp,
    amountB:   halfSui,
    recipient: address,
  });

  const poolResult = await signExecute(client, keypair, poolTx, { effects: true, objectTypes: true });
  if (!txOk(poolResult)) {
    throw new Error(`Turbos pool creation failed: ${errText(txErrorOf(poolResult))}`);
  }
  console.log(`  [turbos] + Pool created: ${txDigestOf(poolResult)}`);
  await sleep(3000);

  // Find pool ID
  const created = createdObjectsOf(poolResult);
  const poolId  = created.find(c => c.type?.includes('::pool::Pool<'))?.objectId;
  if (!poolId) throw new Error('Could not find pool ID in created objects');

  // Find creator LP NFT - transfer to curve creator
  const creatorNftId = created.find(c => c.type?.includes('::position::Position'))?.objectId;
  if (creatorNftId && creator !== address) {
    const txTransfer = new Transaction();
    txTransfer.transferObjects([txTransfer.object(creatorNftId)], creator);
    const rTransfer = await signExecute(client, keypair, txTransfer, { effects: true });
    if (txOk(rTransfer)) {
      console.log(`  [turbos] + LP NFT transferred to creator: ${txDigestOf(rTransfer)}`);
    } else {
      console.warn(`  [turbos] ! LP NFT transfer failed: ${errText(txErrorOf(rTransfer))}`);
    }
    await sleep(2000);
  }

  // Add protocol half to the same pool
  await sleep(3000);
  console.log(`  [turbos]   Adding protocol liquidity...`);
  try {
    let poolSv = null;
    for (let i = 0; i < 5; i++) {
      try {
        poolSv = await getSharedVersion(client, poolId);
        if (poolSv) break;
      } catch {}
      await sleep(3000);
    }

    if (poolSv) {
      const suiCoins2 = await listAllCoins(client, address, SUI_TYPE);
      const totalSui2 = suiCoins2.reduce((s, c) => s + c.balance, 0n);
      const lpCoins2  = await listAllCoins(client, address, tokenType);
      const totalLp2  = lpCoins2.reduce((s, c) => s + c.balance, 0n);

      // The SUI half is split from gas, so the check is on the TOTAL balance
      // (build merges owned SUI coins into the gas coin): half + 0.5 SUI headroom.
      if (totalSui2 >= halfSui + 500_000_000n && totalLp2 >= halfLp) {
        const addTx = new Transaction();
        buildAddLiquidity({
          tx: addTx, turbos, fee,
          poolId, poolSharedVersion: poolSv,
          coinTypeA: tokenType,
          coinTypeB: SUI_TYPE,
          coinVecA:  exactCoinVec(addTx, tokenType, lpCoins2.map(c => c.objectId), halfLp),
          coinVecB:  exactCoinVec(addTx, SUI_TYPE, [], halfSui),
          tickLower, tickUpper,
          amountA:   halfLp,
          amountB:   halfSui,
          recipient: address,
        });
        const rAdd = await signExecute(client, keypair, addTx, { effects: true });
        if (txOk(rAdd)) {
          console.log(`  [turbos] + Protocol liquidity added: ${txDigestOf(rAdd)}`);
        } else {
          console.warn(`  [turbos] ! Protocol liquidity failed: ${errText(txErrorOf(rAdd))}`);
        }
      } else {
        console.warn(`  [turbos] ! Insufficient balance for protocol half - skipped`);
      }
    }
  } catch (err) {
    console.warn(`  [turbos] ! Protocol liquidity step failed: ${err.message}`);
  }

  // -- Step 6: record_graduation_pool() ---------------------------------------
  const sv5  = await getSharedVersion(client, curveId);
  const tx5  = new Transaction();
  const ref5 = tx5.sharedObjectRef({ objectId: curveId, initialSharedVersion: sv5, mutable: true });
  const grad5 = graduationAuthority();
  tx5.moveCall({
    target: grad5.mode === 'cap'
      ? `${grad5.pkg}::bonding_curve::record_graduation_pool_with_cap`
      : `${writePkg}::bonding_curve::record_graduation_pool`,
    typeArguments: [tokenType],
    arguments: grad5.mode === 'cap'
      ? [
          tx5.object(grad5.cap),
          tx5.object(grad5.registry),
          ref5,
          tx5.pure.id(poolId),
          tx5.pure.id(creatorNftId ?? poolId),
        ]
      : [
          tx5.object(adminCapId),
          ref5,
          tx5.pure.id(poolId),
          tx5.pure.id(creatorNftId ?? poolId),
        ],
  });
  const r5 = await signExecute(client, keypair, tx5, { effects: true });
  if (!txOk(r5)) {
    console.warn(`  [turbos] ! record_graduation_pool failed: ${errText(txErrorOf(r5))}`);
  } else {
    console.log(`  [turbos] + recorded: ${txDigestOf(r5)}`);
  }

  console.log(`  [turbos] OK Done - Pool: ${poolId}`);
  return { poolId, txDigest: txDigestOf(poolResult) };
}

// -- Standalone CLI entry point ------------------------------------------------
if (process.argv[1] && process.argv[1].endsWith('graduate_turbos_full.js')) {
  const curveId = process.argv[2];
  if (!curveId?.startsWith('0x')) {
    console.error('Usage: node graduate_turbos_full.js <CURVE_ID>');
    process.exit(1);
  }

  // CLI-local client for the startup assert + curve metadata fetch;
  // graduateToTurbos builds its own client + keypair internally.
  const client = defaultClient();

  // Startup assert (CLI path only - the library export is covered by
  // auto_graduate's startup assert): the write target must expose the
  // functions this script invokes. claim_graduation_funds/grad_funds_claimed
  // first exist in V13; the default V12 target genuinely lacks them, so they
  // are required only once SUIPUMP_LATEST_WRITE_PACKAGE is set (post-publish).
  const requiredFns = [
    ['bonding_curve', 'graduate'],
    ['bonding_curve', 'record_graduation_pool'],
  ];
  if (process.env.SUIPUMP_LATEST_WRITE_PACKAGE) {
    requiredFns.push(['bonding_curve', 'claim_graduation_funds']);
    requiredFns.push(['bonding_curve', 'grad_funds_claimed']);
  }
  // V14 (GRAD-1): when the GraduationCap triplet is armed, this script calls the
  // _with_cap entrypoints on the V14 package - assert them THERE via the per-pair
  // package override (they do not exist on pre-V14 lineage packages).
  const cliGradAuth = graduationAuthority();
  if (cliGradAuth.mode === 'cap') {
    requiredFns.push(['bonding_curve', 'claim_graduation_funds_with_cap', cliGradAuth.pkg]);
    requiredFns.push(['bonding_curve', 'record_graduation_pool_with_cap', cliGradAuth.pkg]);
  }
  try {
    await assertWriteTarget(client, requiredFns);
  } catch (err) {
    console.error('X', err.message);
    process.exit(1);
  }

  const { type, fields } = await getObjectJson(client, curveId);
  const tokenType = type?.match(/Curve<(.+)>$/)?.[1];
  if (!tokenType) { console.error('X Could not parse token type'); process.exit(1); }
  const pkgId = tokenType.split('::')[0];

  console.log('='.repeat(60));
  console.log('  SUIPUMP - Graduate to Turbos CLMM (standalone)');
  console.log('='.repeat(60));
  console.log(`  curve:   ${curveId}`);
  console.log(`  token:   ${fields.name} ($${fields.symbol})`);
  console.log(`  type:    ${tokenType}`);
  console.log(`  pkg:     ${pkgId}`);
  console.log();

  try {
    const result = await graduateToTurbos({ curveId, tokenType, pkgId });
    if (!result) {
      console.error('X Curve not ready (not graduated) - nothing claimed');
      process.exit(1);
    }
    console.log();
    console.log(`  txDigest: ${result.txDigest}`);
    console.log(`  poolId:   ${result.poolId}`);
    console.log('  https://testnet.suivision.xyz/txblock/' + result.txDigest);
  } catch (err) {
    console.error('X', err.message);
    process.exit(1);
  }
}
