// graduation-test-turbos/graduate_turbos_full.js
// Graduates a SuiPump bonding curve to a Turbos CLMM pool.
//
// DUAL-MODE:
//   - Exported function: graduateToTurbos({ curveId, tokenType, pkgId })
//     Called by indexer/auto_graduate.js. Callers pass PLAIN STRINGS ONLY.
//     THIS MODULE OWNS ITS CLIENT AND KEYPAIR: it is pinned to @mysten/sui
//     ^1.45.2 (v1, where SuiClient IS the JSON-RPC client) for turbos-clmm-sdk
//     compatibility, so its classes are NOT interchangeable with a caller's
//     SDK install - an injected v2 grpc/graphql client has different call
//     shapes (getObject({objectId}) vs getObject({id, options}), no
//     signAndExecuteTransaction({signer})), and keypair instances constructed
//     across node_modules boundaries fail internal checks. Client comes from
//     defaultClient() (env SUIPUMP_JSONRPC_URL / SUI_RPC_URL), keypair from
//     defaultKeypair() (env GRADUATION_SIGNER_KEY).  No process.exit.
//
//   SIGNER SEPARATION (do not conflate): the graduation signer reads
//   GRADUATION_SIGNER_KEY ONLY (the main wallet, which holds the AdminCap). It MUST
//   NEVER read SUI_PRIVATE_KEY - that is the PRICE RELAYER's key (a different
//   wallet). See the TESTNET-ONLY EXPEDIENT note in indexer/auto_graduate.js.
//
//   - Standalone CLI: node graduate_turbos_full.js <CURVE_ID>
//     Uses env GRADUATION_SIGNER_KEY + SUIPUMP_JSONRPC_URL (or SUI_RPC_URL), calls
//     process.exit on failure.
//
// Steps:
//   1. graduate()               - mark curve graduated, pay bonuses
//   2. claim_graduation_funds() - pull SUI reserve + LP tokens to admin wallet
//   3. Split 50/50              - creator half + protocol half
//   4. Create Turbos CLMM pool  - full tick range, 1% fee tier
//   5. Add both halves          - creator gets LP NFT, protocol keeps theirs
//   6. record_graduation_pool() - write pool_id on-chain

import { Transaction } from '@mysten/sui/transactions';
import { SuiClient } from '@mysten/sui/client';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { TurbosSdk, Network } from 'turbos-clmm-sdk';
import Decimal from 'decimal.js';
import { fromBase64 } from '@mysten/sui/utils';
import { LATEST_WRITE_PACKAGE, V13_PACKAGE, assertWriteTarget } from '../indexer/write_target.js';

// -- Constants -----------------------------------------------------------------
const SUI_TYPE     = '0x2::sui::SUI';
const MIN_TICK     = -443636;
const MAX_TICK     =  443636;
const TOKEN_DECIMALS = 6;
const SUI_DECIMALS   = 9;

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

// turbos-clmm-sdk@3.6.4 peer-depends on @mysten/sui ^1.x, whose JSON-RPC client
// is SuiClient itself (this dir pins v1; the v2 SuiJsonRpcClient import path
// does not exist here). The endpoint MUST come from env: the Sui Foundation
// public testnet JSON-RPC fullnode shut off the week of 2026-07-06, so a
// getFullnodeUrl default would be a dead endpoint. SUIPUMP_JSONRPC_URL is a
// third-party JSON-RPC endpoint; SUI_RPC_URL kept as the legacy alias.
// Exported so read-only tooling (scripts/dryrun_graduation_load.js) can build
// this module's own client flavor without duplicating the env handling.
export function defaultClient() {
  const url = process.env.SUIPUMP_JSONRPC_URL || process.env.SUI_RPC_URL;
  if (!url) {
    throw new Error(
      'SUIPUMP_JSONRPC_URL (or SUI_RPC_URL) env var not set - the public testnet ' +
      'JSON-RPC fullnode is dead; provide a third-party JSON-RPC endpoint for turbos-clmm-sdk'
    );
  }
  return new SuiClient({ url });
}

function defaultKeypair() {
  // GRADUATION signer only: the main wallet that holds the AdminCap. This MUST read
  // GRADUATION_SIGNER_KEY and NEVER SUI_PRIVATE_KEY - SUI_PRIVATE_KEY is the price
  // relayer's key (a different wallet with no AdminCap), and conflating the two
  // would make graduation sign with a wallet that cannot use the AdminCap.
  const raw = process.env.GRADUATION_SIGNER_KEY;
  if (!raw) throw new Error('GRADUATION_SIGNER_KEY env var not set (graduation signer; this is NOT SUI_PRIVATE_KEY, the price relayer key)');
  const bytes = fromBase64(raw);
  const seed  = bytes.length === 65 ? bytes.slice(1) : bytes;
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
 * Graduates a SuiPump curve to a Turbos CLMM pool.
 * Called by auto_graduate.js - never calls process.exit.
 *
 * Takes plain strings ONLY. The module builds its own client + keypair from
 * env (SUIPUMP_JSONRPC_URL / SUI_RPC_URL, SUI_PRIVATE_KEY): this dir's pinned
 * @mysten/sui ^1.45.2 classes are not interchangeable with the caller's SDK
 * install, so injected client/keypair objects are refused by design.
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
  const adminCapId = ADMIN_CAPS[pkgId];
  if (!adminCapId) throw new Error(`No AdminCap for package ${pkgId}`);

  // pkgId is the DEFINING package; graduate/claim/record must target the latest
  // upgrade that contains claim_graduation_funds.
  const writePkg = writePackageFor(pkgId);

  const sdk = new TurbosSdk(Network.testnet, client);

  console.log(`  [turbos] Graduating ${curveId} -> Turbos CLMM`);
  console.log(`  [turbos] token: ${tokenType}`);
  console.log(`  [turbos] pkg:   ${pkgId} (write ${writePkg})`);

  // -- Step 1: graduate() if needed -------------------------------------------
  const curveObj = await client.getObject({ id: curveId, options: { showContent: true } });
  let fields   = curveObj.data?.content?.fields ?? {};

  if (!fields.graduated) {
    console.log(`  [turbos] [1/5] Calling graduate()...`);

    const metadataId = await (async () => {
      try { const m = await client.getCoinMetadata({ coinType: tokenType }); return m?.id ?? null; }
      catch { return null; }
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
      tx.moveCall({
        target: `${writePkg}::bonding_curve::graduate`,
        typeArguments: [tokenType],
        arguments: [ref],
      });
    }

    const r = await client.signAndExecuteTransaction({
      signer: keypair, transaction: tx, options: { showEffects: true },
    });
    if (r.effects.status.status !== 'success') throw new Error(`graduate() failed: ${r.effects.status.error}`);
    console.log(`  [turbos] + graduate: ${r.digest}`);
    await sleep(3000);
    const after = await client.getObject({ id: curveId, options: { showContent: true } });
    fields = after.data?.content?.fields ?? {};
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

  const claimed = await isGradFundsClaimed({ client, writePkg, curveId, tokenType, sender: address });
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
        console.warn(`  [turbos] ! ${curveId} graduated below the F-2 min-reserve floor (likely oracle-manipulated / griefed) - skipping, needs manual review`);
        return { poolId: null, txDigest: null, skipped: true, reason: 'reserve-too-low' };
      }
      throw err;
    }
    if (r2.effects.status.status !== 'success') {
      if (isReserveTooLow(r2.effects.status.error)) {
        console.warn(`  [turbos] ! ${curveId} graduated below the F-2 min-reserve floor (likely oracle-manipulated / griefed) - skipping, needs manual review`);
        return { poolId: null, txDigest: null, skipped: true, reason: 'reserve-too-low' };
      }
      throw new Error(`claim_graduation_funds() failed: ${r2.effects.status.error}`);
    }
    console.log(`  [turbos] + claimed (SUI + LP): ${r2.digest}`);
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
    console.log(`  [turbos] [2/5] Already claimed - recovered ${fmtSui(poolSuiMist)} pool SUI from GraduationFundsClaimed event; using LP already in wallet`);
  }

  // -- Step 3: Compute 50/50 split --------------------------------------------
  // LP now arrives in the admin wallet from claim_graduation_funds() above
  // (graduate() no longer mints the 200M LP allocation).
  const lpCoins = await client.getCoins({ owner: address, coinType: tokenType });
  if (!lpCoins.data.length) throw new Error('No LP tokens in admin wallet');
  const totalLp = lpCoins.data.reduce((s, c) => s + BigInt(c.balance), 0n);
  const halfLp  = totalLp / 2n;
  const halfSui = poolSuiMist / 2n;

  console.log(`  [turbos] [3/5] Split: ${(Number(halfLp)/1e6).toLocaleString()} tokens + ${fmtSui(halfSui)} each half`);

  // -- Step 4: Turbos fee tier + sqrtPrice ------------------------------------
  console.log(`  [turbos] [4/5] Fetching Turbos config...`);
  const fees = await sdk.contract.getFees();
  const fee  = fees.find(f => f.fee === 10000) ?? fees[fees.length - 1];
  console.log(`  [turbos] Fee tier: ${fee.fee / 100}% (tickSpacing: ${fee.tickSpacing})`);

  // price = SUI per TOKEN (adjusted for decimals)
  const suiPerToken = (Number(halfSui) / 1e9) / (Number(halfLp) / 1e6);
  const sqrtPriceX64 = sdk.math.priceToSqrtPriceX64(
    new Decimal(suiPerToken),
    TOKEN_DECIMALS,
    SUI_DECIMALS,
  );

  const tickSpacing = fee.tickSpacing;
  const tickLower   = Math.ceil(MIN_TICK / tickSpacing) * tickSpacing;
  const tickUpper   = Math.floor(MAX_TICK / tickSpacing) * tickSpacing;

  // -- Step 5: Create Turbos pool + add creator half --------------------------
  console.log(`  [turbos] [5/5] Creating Turbos pool + adding creator liquidity...`);
  const poolTxb = await sdk.pool.createPool({
    fee,
    address,
    tickLower,
    tickUpper,
    sqrtPrice:  sqrtPriceX64,
    slippage:   0.05,
    coinTypeA:  tokenType,
    coinTypeB:  SUI_TYPE,
    amountA:    halfLp.toString(),
    amountB:    halfSui.toString(),
  });

  const poolResult = await client.signAndExecuteTransaction({
    signer: keypair, transaction: poolTxb,
    options: { showEffects: true, showObjectChanges: true },
  });
  if (poolResult.effects.status.status !== 'success') {
    throw new Error(`Turbos pool creation failed: ${poolResult.effects.status.error}`);
  }
  console.log(`  [turbos] + Pool created: ${poolResult.digest}`);
  await sleep(3000);

  // Find pool ID
  const poolObj = poolResult.objectChanges?.find(c =>
    c.type === 'created' && c.objectType?.includes('::pool::Pool<')
  );
  const poolId = poolObj?.objectId;
  if (!poolId) throw new Error('Could not find pool ID in object changes');

  // Find creator LP NFT - transfer to curve creator
  const creatorNft = poolResult.objectChanges?.find(c =>
    c.type === 'created' && c.objectType?.includes('::position::Position')
  );
  const creatorNftId = creatorNft?.objectId;
  if (creatorNftId && creator !== address) {
    const txTransfer = new Transaction();
    txTransfer.transferObjects([txTransfer.object(creatorNftId)], creator);
    const rTransfer = await client.signAndExecuteTransaction({
      signer: keypair, transaction: txTransfer, options: { showEffects: true },
    });
    if (rTransfer.effects.status.status === 'success') {
      console.log(`  [turbos] + LP NFT transferred to creator: ${rTransfer.digest}`);
    } else {
      console.warn(`  [turbos] ! LP NFT transfer failed: ${rTransfer.effects.status.error}`);
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
        const po = await client.getObject({ id: poolId, options: { showOwner: true } });
        poolSv = po.data?.owner?.Shared?.initial_shared_version;
        if (poolSv) break;
      } catch {}
      await sleep(3000);
    }

    if (poolSv) {
      const suiCoins2 = await client.getCoins({ owner: address, coinType: SUI_TYPE });
      const suiCoin2  = suiCoins2.data
        .filter(c => BigInt(c.balance) >= halfSui + 500_000_000n)
        .sort((a, b) => Number(BigInt(a.balance) - BigInt(b.balance)))[0];

      const lpCoins2 = await client.getCoins({ owner: address, coinType: tokenType });
      const totalLp2 = lpCoins2.data.reduce((s, c) => s + BigInt(c.balance), 0n);

      if (suiCoin2 && totalLp2 >= halfLp) {
        const addTxb = await sdk.pool.addLiquidity({
          pool:     { objectId: poolId, initialSharedVersion: poolSv },
          address,
          tickLower,
          tickUpper,
          slippage: 0.05,
          coinTypeA: tokenType,
          coinTypeB: SUI_TYPE,
          amountA:   halfLp.toString(),
          amountB:   halfSui.toString(),
        });
        const rAdd = await client.signAndExecuteTransaction({
          signer: keypair, transaction: addTxb, options: { showEffects: true },
        });
        if (rAdd.effects.status.status === 'success') {
          console.log(`  [turbos] + Protocol liquidity added: ${rAdd.digest}`);
        } else {
          console.warn(`  [turbos] ! Protocol liquidity failed: ${rAdd.effects.status.error}`);
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
  tx5.moveCall({
    target: `${writePkg}::bonding_curve::record_graduation_pool`,
    typeArguments: [tokenType],
    arguments: [
      tx5.object(adminCapId),
      ref5,
      tx5.pure.id(poolId),
      tx5.pure.id(creatorNftId ?? poolId),
    ],
  });
  const r5 = await client.signAndExecuteTransaction({
    signer: keypair, transaction: tx5, options: { showEffects: true },
  });
  if (r5.effects.status.status !== 'success') {
    console.warn(`  [turbos] ! record_graduation_pool failed: ${r5.effects.status.error}`);
  } else {
    console.log(`  [turbos] + recorded: ${r5.digest}`);
  }

  console.log(`  [turbos] OK Done - Pool: ${poolId}`);
  return { poolId, txDigest: poolResult.digest };
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
  try {
    await assertWriteTarget(client, requiredFns);
  } catch (err) {
    console.error('X', err.message);
    process.exit(1);
  }

  const obj     = await client.getObject({ id: curveId, options: { showContent: true, showType: true } });
  const fields  = obj.data?.content?.fields ?? {};
  const tokenType = obj.data?.type?.match(/Curve<(.+)>$/)?.[1];
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
    console.log();
    console.log(`  txDigest: ${result.txDigest}`);
    console.log(`  poolId:   ${result.poolId}`);
    console.log('  https://testnet.suivision.xyz/txblock/' + result.txDigest);
  } catch (err) {
    console.error('X', err.message);
    process.exit(1);
  }
}
