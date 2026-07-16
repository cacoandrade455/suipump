// graduation-test/graduate_deepbook_full.js
// Graduates a SuiPump bonding curve to a DeepBook BalanceManager.
//
// DUAL-MODE:
//   - Exported function: graduateToDeepBook({ curveId, tokenType, pkgId, keypair, client })
//     Called by indexer/auto_graduate.js - all context passed in, no process.exit.
//
//   - Standalone CLI: node graduate_deepbook_full.js <CURVE_ID>
//     Uses env SUI_PRIVATE_KEY + SUI_RPC_URL, calls process.exit on failure.
//
// Steps:
//   1. Call graduate() on-chain (if not already graduated)
//   2. Claim graduation funds (SUI pool + LP tokens go to admin wallet)
//   3. Build BalanceManager, deposit TOKEN + SUI, transfer to curve.creator

import { Transaction } from '@mysten/sui/transactions';
// This dir locks @mysten/sui 2.16.2: the v2 SDK moved the JSON-RPC client to
// '@mysten/sui/jsonRpc' as SuiJsonRpcClient ('@mysten/sui/client' no longer
// exports SuiClient/getFullnodeUrl - importing them rejects at module load,
// which also killed auto_graduate's dynamic import of this file).
import { SuiJsonRpcClient } from '@mysten/sui/jsonRpc';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { DeepBookClient } from '@mysten/deepbook-v3';
import { fromBase64 } from '@mysten/sui/utils';
import { LATEST_WRITE_PACKAGE, assertWriteTarget } from '../indexer/write_target.js';

// -- Constants -----------------------------------------------------------------
const SUI_CLOCK_ID = '0x6';

// V10-lineage package IDs (defining + upgrades). A curve's pkgId is its DEFINING
// package; graduate/claim/record WRITES target the latest upgrade below.
const PKG_V10 = '0x2deda2cade65cd5afd5ffbe799d48f2491debf08d3aef6fa11aa6e1c8afe1598';
const PKG_V11 = '0xc03817bce45ff492e5d0f40f9e46f5a075a952b50c5c6146b8fb38138bd699eb';
const PKG_V12 = '0xf5a3566ba920a3e3614e8b25da0ca3237879b6e22eb12f21ccf2bceb6520b9cd';

// LATEST_WRITE_PACKAGE is env-driven (SUIPUMP_LATEST_WRITE_PACKAGE) via
// ../indexer/write_target.js - after the V13 publish, Carlos flips the env var
// with no code change. Until then it defaults to V12, which genuinely lacks
// claim_graduation_funds, so claim writes abort until V13 ships.

// Remap a curve's DEFINING package -> latest upgrade that contains
// claim_graduation_funds. Non-lineage packages pass through unchanged.
const WRITE_PACKAGE = {
  [PKG_V10]: LATEST_WRITE_PACKAGE,
  [PKG_V11]: LATEST_WRITE_PACKAGE,
  [PKG_V12]: LATEST_WRITE_PACKAGE,
};
function writePackageFor(pkgId) {
  return WRITE_PACKAGE[pkgId] ?? pkgId;
}

// All AdminCap IDs by DEFINING package version - kept in sync with auto_graduate.js.
// The whole V10 lineage (V10/V11/V12+) shares one AdminCap
// (0x144d426960a9a6b8db63ce3426e06a9c41273a17e72ed0193cd8c8507d4f6ec5).
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
};

// -- Helpers -------------------------------------------------------------------
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function fmtSui(mist) {
  return `${(Number(BigInt(mist)) / 1e9).toFixed(4)} SUI`;
}

// The endpoint MUST come from env: the Sui Foundation public testnet JSON-RPC
// fullnode shut off the week of 2026-07-06, so a getFullnodeUrl-style default
// would be a dead endpoint. SUIPUMP_JSONRPC_URL is a third-party JSON-RPC
// endpoint; SUI_RPC_URL kept as the legacy alias.
function defaultClient() {
  const url = process.env.SUIPUMP_JSONRPC_URL || process.env.SUI_RPC_URL;
  if (!url) {
    throw new Error(
      'SUIPUMP_JSONRPC_URL (or SUI_RPC_URL) env var not set - the public testnet ' +
      'JSON-RPC fullnode is dead; provide a third-party JSON-RPC endpoint'
    );
  }
  return new SuiJsonRpcClient({ url });
}

function defaultKeypair() {
  const raw = process.env.SUI_PRIVATE_KEY;
  if (!raw) throw new Error('SUI_PRIVATE_KEY env var not set');
  const bytes = fromBase64(raw);
  // Strip flag byte if present (65 bytes -> 64)
  const seed = bytes.length === 65 ? bytes.slice(1) : bytes;
  return Ed25519Keypair.fromSecretKey(seed);
}

async function getSharedVersion(client, objectId) {
  const obj = await client.getObject({ id: objectId, options: { showOwner: true } });
  return obj.data?.owner?.Shared?.initial_shared_version;
}

// Extract the recorded pool_id (Option<ID>) from JSON-RPC content fields.
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

// Read the V13 grad_funds_claimed<T>(&Curve<T>): bool getter via devInspect
// (read-only dry run, same SuiClient transport). True once claim_graduation_funds
// has run (backed by a dynamic-field marker on the curve).
async function isGradFundsClaimed({ client, writePkg, curveId, tokenType, sender }) {
  const sv = await getSharedVersion(client, curveId);
  const tx = new Transaction();
  tx.moveCall({
    target: `${writePkg}::bonding_curve::grad_funds_claimed`,
    typeArguments: [tokenType],
    arguments: [tx.sharedObjectRef({ objectId: curveId, initialSharedVersion: sv, mutable: false })],
  });
  const res = await client.devInspectTransactionBlock({ sender, transactionBlock: tx });
  if (res?.effects?.status?.status !== 'success') {
    throw new Error(`grad_funds_claimed devInspect failed: ${res?.effects?.status?.error ?? 'unknown'}`);
  }
  const rv = res?.results?.[0]?.returnValues?.[0];
  const bytes = rv?.[0];
  return Array.isArray(bytes) && bytes[0] === 1;
}

// Recover the claimed pool SUI size from the GraduationFundsClaimed event
// { curve_id, sui_amount, lp_amount } (a V13 event, typed on writePkg). Used to
// re-size the pool when a prior run claimed but failed before creating the pool.
async function fetchClaimedSuiAmount({ client, writePkg, curveId }) {
  const eventType = `${writePkg}::bonding_curve::GraduationFundsClaimed`;
  let cursor = null;
  for (let page = 0; page < 40; page++) {
    const res = await client.queryEvents({
      query: { MoveEventType: eventType }, cursor, limit: 50, order: 'descending',
    });
    for (const ev of res?.data ?? []) {
      const pj = ev.parsedJson ?? {};
      if (pj.curve_id === curveId) return BigInt(pj.sui_amount ?? 0);
    }
    if (!res?.hasNextPage) break;
    cursor = res.nextCursor;
  }
  return null;
}

// Detect the F-2 backstop abort EReserveTooLow (code 52) from a Move status/error
// string - claim_graduation_funds aborts 52 when the graduated reserve is below
// the 1000 SUI floor (likely oracle-manipulated / griefed graduation).
function isReserveTooLow(msg) {
  const s = String(msg ?? '');
  return s.includes('EReserveTooLow') || /,\s*52\)/.test(s) || /MoveAbort\([^)]*\b52\b/.test(s);
}

// -- Core exported function ----------------------------------------------------

/**
 * Graduates a SuiPump curve to DeepBook.
 * Called by auto_graduate.js - all deps passed in, never calls process.exit.
 *
 * @param {object} opts
 * @param {string}   opts.curveId   - Shared curve object ID
 * @param {string}   opts.tokenType - Full Move type e.g. 0x...::template::TEMPLATE
 * @param {string}   opts.pkgId     - Package ID the curve was launched on
 * @param {object}   opts.keypair   - Ed25519Keypair (admin wallet)
 * @param {object}   opts.client    - SuiClient instance
 * @returns {Promise<{ poolId: string, txDigest: string }>}
 */
export async function graduateToDeepBook({ curveId, tokenType, pkgId, keypair, client }) {
  const address   = keypair.toSuiAddress();
  const adminCapId = ADMIN_CAPS[pkgId];
  if (!adminCapId) throw new Error(`No AdminCap for package ${pkgId}`);

  // pkgId is the DEFINING package; graduate/claim/record must target the latest
  // upgrade that contains claim_graduation_funds.
  const writePkg = writePackageFor(pkgId);

  console.log(`  [deepbook] Graduating ${curveId.slice(0, 12)}... -> DeepBook`);
  console.log(`  [deepbook] token: ${tokenType}`);
  console.log(`  [deepbook] pkg:   ${pkgId} (write ${writePkg})`);

  // -- Step 1: graduate() if needed -------------------------------------------
  const curveObj = await client.getObject({ id: curveId, options: { showContent: true } });
  let fields   = curveObj.data?.content?.fields ?? {};

  if (!fields.graduated) {
    console.log(`  [deepbook] [1/3] Calling graduate()...`);

    // V8+ graduate() takes &mut CoinMetadata<T>
    const metadataId = await (async () => {
      try {
        const meta = await client.getCoinMetadata({ coinType: tokenType });
        return meta?.id ?? null;
      } catch { return null; }
    })();

    const sv  = await getSharedVersion(client, curveId);
    const tx  = new Transaction();
    const ref = tx.sharedObjectRef({ objectId: curveId, initialSharedVersion: sv, mutable: true });

    if (metadataId) {
      const metaObj = await client.getObject({ id: metadataId, options: { showOwner: true } });
      const metaSv  = metaObj.data?.owner?.Shared?.initial_shared_version;
      const metaRef = metaSv
        ? tx.sharedObjectRef({ objectId: metadataId, initialSharedVersion: metaSv, mutable: true })
        : tx.object(metadataId);
      tx.moveCall({
        target: `${writePkg}::bonding_curve::graduate`,
        typeArguments: [tokenType],
        arguments: [ref, metaRef],
      });
    } else {
      // Legacy packages (V4-V7) - no metadata arg
      tx.moveCall({
        target: `${writePkg}::bonding_curve::graduate`,
        typeArguments: [tokenType],
        arguments: [ref],
      });
    }

    const r = await client.signAndExecuteTransaction({
      signer: keypair, transaction: tx, options: { showEffects: true },
    });
    if (r.effects.status.status !== 'success') {
      throw new Error(`graduate() failed: ${r.effects.status.error}`);
    }
    console.log(`  [deepbook] + graduate: ${r.digest}`);
    await sleep(3000);
    const after = await client.getObject({ id: curveId, options: { showContent: true } });
    fields = after.data?.content?.fields ?? {};
  } else {
    console.log(`  [deepbook] [1/3] Already graduated - skipping`);
  }

  const creator = fields.creator ?? address;

  // -- Step 2: 4-state machine (graduated + grad_funds_claimed + pool_id) ------
  //   A  !graduated                          -> not ready (watcher shouldn't send)
  //   B  graduated && !claimed               -> claim now, size pool from sui_reserve
  //   C  graduated && claimed && no pool_id  -> recover size from event, build pool
  //   D  graduated && pool_id present        -> already done
  if (!fields.graduated) {
    // State A
    console.warn(`  [deepbook] Curve not graduated - nothing to do, skipping`);
    return null;
  }

  const existingPool = extractPoolId(fields);
  if (existingPool) {
    // State D
    console.log(`  [deepbook] Pool already recorded (${existingPool}) - already done`);
    return { poolId: existingPool, txDigest: null };
  }

  const claimed = await isGradFundsClaimed({ client, writePkg, curveId, tokenType, sender: address });
  let poolSuiMist;

  if (!claimed) {
    // State B: reserve is full. Claim (both coins -> admin wallet); size from reserve.
    poolSuiMist = BigInt(fields.sui_reserve ?? 0);
    console.log(`  [deepbook] [2/3] Claiming ${fmtSui(poolSuiMist)} pool SUI + 200M LP...`);

    const sv2  = await getSharedVersion(client, curveId);
    const tx2  = new Transaction();
    const ref2 = tx2.sharedObjectRef({ objectId: curveId, initialSharedVersion: sv2, mutable: true });

    // claim_graduation_funds returns (Coin<SUI>, Coin<T>). BOTH returns must be
    // captured and transferred - the LP Coin<T> has no drop, so leaving it unused
    // fails the PTB.
    const [poolSuiCoin, lpCoin] = tx2.moveCall({
      target: `${writePkg}::bonding_curve::claim_graduation_funds`,
      typeArguments: [tokenType],
      arguments: [tx2.object(adminCapId), ref2],
    });
    tx2.transferObjects([poolSuiCoin, lpCoin], address);

    let r2;
    try {
      r2 = await client.signAndExecuteTransaction({
        signer: keypair, transaction: tx2, options: { showEffects: true },
      });
    } catch (err) {
      if (isReserveTooLow(err?.message)) {
        console.warn(`  [deepbook] ! ${curveId} graduated below the F-2 min-reserve floor (likely oracle-manipulated / griefed) - skipping, needs manual review`);
        return { poolId: null, txDigest: null, skipped: true, reason: 'reserve-too-low' };
      }
      throw err;
    }
    if (r2.effects.status.status !== 'success') {
      if (isReserveTooLow(r2.effects.status.error)) {
        console.warn(`  [deepbook] ! ${curveId} graduated below the F-2 min-reserve floor (likely oracle-manipulated / griefed) - skipping, needs manual review`);
        return { poolId: null, txDigest: null, skipped: true, reason: 'reserve-too-low' };
      }
      throw new Error(`claim_graduation_funds() failed: ${r2.effects.status.error}`);
    }
    console.log(`  [deepbook] + claimed (SUI + LP): ${r2.digest}`);
    await sleep(3000);
  } else {
    // State C: claimed in a prior run but pool creation failed. The SUI + 200M LP
    // are already in the admin wallet. Recover the pool SUI size from the
    // GraduationFundsClaimed event and rebuild the pool - do NOT throw.
    const recovered = await fetchClaimedSuiAmount({ client, writePkg, curveId });
    if (recovered == null || recovered === 0n) {
      throw new Error(`Claimed but GraduationFundsClaimed event not found for ${curveId} - cannot recover pool SUI size`);
    }
    poolSuiMist = recovered;
    console.log(`  [deepbook] [2/3] Already claimed - recovered ${fmtSui(poolSuiMist)} pool SUI from GraduationFundsClaimed event; using LP already in wallet`);
  }

  // -- Step 3: DeepBook BalanceManager ----------------------------------------
  console.log(`  [deepbook] [3/3] Building DeepBook BalanceManager...`);

  // Collect LP tokens - the 200M LP allocation arrives in the admin wallet from
  // claim_graduation_funds (graduate() no longer mints it); in State C it is
  // already there from the prior claim.
  const lpCoins = await client.getCoins({ owner: address, coinType: tokenType });
  if (!lpCoins.data.length) throw new Error('No LP tokens found in admin wallet');

  const totalLp = lpCoins.data.reduce((s, c) => s + BigInt(c.balance), 0n);
  console.log(`  [deepbook]   LP tokens: ${(Number(totalLp) / 1e6).toLocaleString()}`);

  // Find a SUI coin large enough
  const suiCoins   = await client.getCoins({ owner: address, coinType: '0x2::sui::SUI' });
  const suiForDeposit = suiCoins.data
    .filter(c => BigInt(c.balance) >= poolSuiMist + 500_000_000n)
    .sort((a, b) => Number(BigInt(a.balance) - BigInt(b.balance)))[0];
  if (!suiForDeposit) throw new Error(`No SUI coin large enough - need ${fmtSui(poolSuiMist + 500_000_000n)}`);

  // DeepBook client for package ID resolution
  const dbClient = new DeepBookClient({ address, network: 'testnet', client });
  const DB_PKG   = dbClient.config.DEEPBOOK_PACKAGE_ID;

  const tx3 = new Transaction();

  // Create BalanceManager
  const balanceManager = tx3.moveCall({
    target: `${DB_PKG}::balance_manager::new`,
    arguments: [],
  });

  // Deposit SUI
  const [suiSplit] = tx3.splitCoins(
    tx3.object(suiForDeposit.coinObjectId),
    [tx3.pure.u64(poolSuiMist)],
  );
  tx3.moveCall({
    target: `${DB_PKG}::balance_manager::deposit`,
    typeArguments: ['0x2::sui::SUI'],
    arguments: [balanceManager, suiSplit],
  });

  // Merge LP coins if needed, then deposit
  const lpObjs = lpCoins.data.map(c => tx3.object(c.coinObjectId));
  if (lpObjs.length > 1) tx3.mergeCoins(lpObjs[0], lpObjs.slice(1));
  tx3.moveCall({
    target: `${DB_PKG}::balance_manager::deposit`,
    typeArguments: [tokenType],
    arguments: [balanceManager, lpObjs[0]],
  });

  // Transfer BalanceManager to curve creator
  tx3.transferObjects([balanceManager], creator);

  const r3 = await client.signAndExecuteTransaction({
    signer: keypair, transaction: tx3,
    options: { showEffects: true, showObjectChanges: true },
  });
  if (r3.effects.status.status !== 'success') {
    throw new Error(`DeepBook deposit failed: ${r3.effects.status.error}`);
  }

  const bmObj = r3.objectChanges?.find(c =>
    c.type === 'created' && c.objectType?.toLowerCase().includes('balancemanager')
  );
  const poolId = bmObj?.objectId ?? 'unknown';

  // Record pool on-chain
  const sv4  = await getSharedVersion(client, curveId);
  const tx4  = new Transaction();
  const ref4 = tx4.sharedObjectRef({ objectId: curveId, initialSharedVersion: sv4, mutable: true });
  tx4.moveCall({
    target: `${writePkg}::bonding_curve::record_graduation_pool`,
    typeArguments: [tokenType],
    arguments: [tx4.object(adminCapId), ref4, tx4.pure.id(poolId), tx4.pure.id(poolId)],
  });
  const r4 = await client.signAndExecuteTransaction({
    signer: keypair, transaction: tx4, options: { showEffects: true },
  });
  if (r4.effects.status.status !== 'success') {
    // Non-fatal - pool is created, just record failed
    console.warn(`  [deepbook] ! record_graduation_pool failed: ${r4.effects.status.error}`);
  } else {
    console.log(`  [deepbook] + recorded: ${r4.digest}`);
  }

  console.log(`  [deepbook] OK Done - BalanceManager: ${poolId}`);
  return { poolId, txDigest: r3.digest };
}

// -- Standalone CLI entry point ------------------------------------------------
if (process.argv[1] && process.argv[1].endsWith('graduate_deepbook_full.js')) {
  const curveId = process.argv[2];
  if (!curveId?.startsWith('0x')) {
    console.error('Usage: node graduate_deepbook_full.js <CURVE_ID>');
    process.exit(1);
  }

  const client  = defaultClient();
  const keypair = defaultKeypair();

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
  try {
    await assertWriteTarget(client, requiredFns);
  } catch (err) {
    console.error('X', err.message);
    process.exit(1);
  }

  // Fetch curve to resolve pkgId + tokenType
  const obj    = await client.getObject({ id: curveId, options: { showContent: true, showType: true } });
  const fields = obj.data?.content?.fields ?? {};
  const tokenType = obj.data?.type?.match(/Curve<(.+)>$/)?.[1];
  if (!tokenType) { console.error('X Could not parse token type'); process.exit(1); }

  // Resolve pkgId from token type (first segment)
  const pkgId  = tokenType.split('::')[0];

  console.log('='.repeat(60));
  console.log('  SUIPUMP - Graduate to DeepBook (standalone)');
  console.log('='.repeat(60));
  console.log(`  curve:   ${curveId}`);
  console.log(`  token:   ${fields.name} ($${fields.symbol})`);
  console.log(`  type:    ${tokenType}`);
  console.log(`  pkg:     ${pkgId}`);
  console.log();

  try {
    const result = await graduateToDeepBook({ curveId, tokenType, pkgId, keypair, client });
    console.log();
    console.log(`  txDigest: ${result.txDigest}`);
    console.log(`  poolId:   ${result.poolId}`);
    console.log('  https://testnet.suivision.xyz/txblock/' + result.txDigest);
  } catch (err) {
    console.error('X', err.message);
    process.exit(1);
  }
}
