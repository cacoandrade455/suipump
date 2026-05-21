// graduation-test-turbos/graduate_turbos_full.js
// Graduates a SuiPump bonding curve to a Turbos CLMM pool.
//
// DUAL-MODE:
//   - Exported function: graduateToTurbos({ curveId, tokenType, pkgId, keypair, client })
//     Called by indexer/auto_graduate.js — all context passed in, no process.exit.
//
//   - Standalone CLI: node graduate_turbos_full.js <CURVE_ID>
//     Uses env SUI_PRIVATE_KEY + SUI_RPC_URL, calls process.exit on failure.
//
// Steps:
//   1. graduate()               — mark curve graduated, pay bonuses
//   2. claim_graduation_funds() — pull SUI reserve + LP tokens to admin wallet
//   3. Split 50/50              — creator half + protocol half
//   4. Create Turbos CLMM pool  — full tick range, 1% fee tier
//   5. Add both halves          — creator gets LP NFT, protocol keeps theirs
//   6. record_graduation_pool() — write pool_id on-chain

import { Transaction } from '@mysten/sui/transactions';
import { SuiClient, getFullnodeUrl } from '@mysten/sui/client';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { TurbosSdk, Network } from 'turbos-clmm-sdk';
import Decimal from 'decimal.js';
import { fromBase64 } from '@mysten/sui/utils';

// ── Constants ─────────────────────────────────────────────────────────────────
const SUI_TYPE     = '0x2::sui::SUI';
const MIN_TICK     = -443636;
const MAX_TICK     =  443636;
const TOKEN_DECIMALS = 6;
const SUI_DECIMALS   = 9;

const ADMIN_CAPS = {
  '0x2154486dcf503bd3e8feae4fb913e862f7e2bbf4489769aff63978f55d55b4a8': '0xfc80d40718e8e9d0bc1fddc1e47a74e46d0c89c3e1e36a2bc8f016efb6d51e0c',
  '0x785c0604cb6c60a8547501e307d2b0ca7a586ff912c8abff4edfb88db65b7236': '0xfc80d40718e8e9d0bc1fddc1e47a74e46d0c89c3e1e36a2bc8f016efb6d51e0c',
  '0x21d5b1284d5f1d4d14214654f414ffca20c757ee9f9db7701d3ffaaac62cd768': '0xfc80d40718e8e9d0bc1fddc1e47a74e46d0c89c3e1e36a2bc8f016efb6d51e0c',
  '0xfb8f3f3e4e8d53130ac140906eebea6b6740bfaf0c971aec607fbc723be951f0': '0x1dc44030adaa6e366666a8e095fc29a5a55c8ae614f04c5e93c062a85b475527',
  '0x145a1e79b83cc17680dbfe4f96839cd359c7db380ac15463ecb6dc30f9849b69': '0xdb22e067d9cf53cfab37bc6d4b626ff98c770bc59b8a192d007aca449e8f7103',
  '0xbb4ee050239f59dfd983501ce101698ba27857f77aff2d437cec568fe0062546': '0x9779a2466f2e30ca5e139f636cc9ca1c44e025da29203d781cc2645ebb62bb35',
};

// ── Helpers ───────────────────────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function fmtSui(mist) { return `${(Number(BigInt(mist)) / 1e9).toFixed(4)} SUI`; }

function defaultClient() {
  return new SuiClient({ url: process.env.SUI_RPC_URL || getFullnodeUrl('testnet') });
}

function defaultKeypair() {
  const raw = process.env.SUI_PRIVATE_KEY;
  if (!raw) throw new Error('SUI_PRIVATE_KEY env var not set');
  const bytes = fromBase64(raw);
  const seed  = bytes.length === 65 ? bytes.slice(1) : bytes;
  return Ed25519Keypair.fromSecretKey(seed);
}

async function getSharedVersion(client, objectId) {
  const obj = await client.getObject({ id: objectId, options: { showOwner: true } });
  return obj.data?.owner?.Shared?.initial_shared_version;
}

// ── Core exported function ────────────────────────────────────────────────────

/**
 * Graduates a SuiPump curve to a Turbos CLMM pool.
 * Called by auto_graduate.js — all deps passed in, never calls process.exit.
 *
 * @param {object} opts
 * @param {string}   opts.curveId   - Shared curve object ID
 * @param {string}   opts.tokenType - Full Move type e.g. 0x...::template::TEMPLATE
 * @param {string}   opts.pkgId     - Package ID the curve was launched on
 * @param {object}   opts.keypair   - Ed25519Keypair (admin wallet)
 * @param {object}   opts.client    - SuiClient instance
 * @returns {Promise<{ poolId: string, txDigest: string }>}
 */
export async function graduateToTurbos({ curveId, tokenType, pkgId, keypair, client }) {
  const address    = keypair.toSuiAddress();
  const adminCapId = ADMIN_CAPS[pkgId];
  if (!adminCapId) throw new Error(`No AdminCap for package ${pkgId}`);

  const sdk = new TurbosSdk(Network.testnet, client);

  console.log(`  [turbos] Graduating ${curveId.slice(0, 12)}… → Turbos CLMM`);
  console.log(`  [turbos] token: ${tokenType}`);
  console.log(`  [turbos] pkg:   ${pkgId}`);

  // ── Step 1: graduate() ──────────────────────────────────────────────────────
  const curveObj = await client.getObject({ id: curveId, options: { showContent: true } });
  const fields   = curveObj.data?.content?.fields ?? {};

  if (!fields.graduated) {
    console.log(`  [turbos] [1/5] Calling graduate()…`);

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
        target: `${pkgId}::bonding_curve::graduate`,
        typeArguments: [tokenType],
        arguments: [ref, metaRef],
      });
    } else {
      tx.moveCall({
        target: `${pkgId}::bonding_curve::graduate`,
        typeArguments: [tokenType],
        arguments: [ref],
      });
    }

    const r = await client.signAndExecuteTransaction({
      signer: keypair, transaction: tx, options: { showEffects: true },
    });
    if (r.effects.status.status !== 'success') throw new Error(`graduate() failed: ${r.effects.status.error}`);
    console.log(`  [turbos] ✓ graduate: ${r.digest}`);
    await sleep(3000);
  } else {
    console.log(`  [turbos] [1/5] Already graduated — skipping`);
  }

  // ── Step 2: claim_graduation_funds() ───────────────────────────────────────
  const updated     = await client.getObject({ id: curveId, options: { showContent: true } });
  const poolSuiMist = BigInt(updated.data?.content?.fields?.sui_reserve ?? 0);
  const creator     = updated.data?.content?.fields?.creator ?? address;
  if (poolSuiMist === 0n) throw new Error('Pool SUI is 0 — already claimed');

  console.log(`  [turbos] [2/5] Claiming ${fmtSui(poolSuiMist)}…`);
  const sv2  = await getSharedVersion(client, curveId);
  const tx2  = new Transaction();
  const ref2 = tx2.sharedObjectRef({ objectId: curveId, initialSharedVersion: sv2, mutable: true });
  const poolSuiCoin = tx2.moveCall({
    target: `${pkgId}::bonding_curve::claim_graduation_funds`,
    typeArguments: [tokenType],
    arguments: [tx2.object(adminCapId), ref2],
  });
  tx2.transferObjects([poolSuiCoin], address);
  const r2 = await client.signAndExecuteTransaction({
    signer: keypair, transaction: tx2, options: { showEffects: true },
  });
  if (r2.effects.status.status !== 'success') throw new Error(`claim_graduation_funds() failed: ${r2.effects.status.error}`);
  console.log(`  [turbos] ✓ claimed: ${r2.digest}`);
  await sleep(3000);

  // ── Step 3: Compute 50/50 split ────────────────────────────────────────────
  const lpCoins = await client.getCoins({ owner: address, coinType: tokenType });
  if (!lpCoins.data.length) throw new Error('No LP tokens in admin wallet');
  const totalLp = lpCoins.data.reduce((s, c) => s + BigInt(c.balance), 0n);
  const halfLp  = totalLp / 2n;
  const halfSui = poolSuiMist / 2n;

  console.log(`  [turbos] [3/5] Split: ${(Number(halfLp)/1e6).toLocaleString()} tokens + ${fmtSui(halfSui)} each half`);

  // ── Step 4: Turbos fee tier + sqrtPrice ────────────────────────────────────
  console.log(`  [turbos] [4/5] Fetching Turbos config…`);
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

  // ── Step 5: Create Turbos pool + add creator half ──────────────────────────
  console.log(`  [turbos] [5/5] Creating Turbos pool + adding creator liquidity…`);
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
  console.log(`  [turbos] ✓ Pool created: ${poolResult.digest}`);
  await sleep(3000);

  // Find pool ID
  const poolObj = poolResult.objectChanges?.find(c =>
    c.type === 'created' && c.objectType?.includes('::pool::Pool<')
  );
  const poolId = poolObj?.objectId;
  if (!poolId) throw new Error('Could not find pool ID in object changes');

  // Find creator LP NFT — transfer to curve creator
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
      console.log(`  [turbos] ✓ LP NFT transferred to creator: ${rTransfer.digest}`);
    } else {
      console.warn(`  [turbos] ⚠ LP NFT transfer failed: ${rTransfer.effects.status.error}`);
    }
    await sleep(2000);
  }

  // Add protocol half to the same pool
  await sleep(3000);
  console.log(`  [turbos]   Adding protocol liquidity…`);
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
          console.log(`  [turbos] ✓ Protocol liquidity added: ${rAdd.digest}`);
        } else {
          console.warn(`  [turbos] ⚠ Protocol liquidity failed: ${rAdd.effects.status.error}`);
        }
      } else {
        console.warn(`  [turbos] ⚠ Insufficient balance for protocol half — skipped`);
      }
    }
  } catch (err) {
    console.warn(`  [turbos] ⚠ Protocol liquidity step failed: ${err.message}`);
  }

  // ── Step 6: record_graduation_pool() ───────────────────────────────────────
  const sv5  = await getSharedVersion(client, curveId);
  const tx5  = new Transaction();
  const ref5 = tx5.sharedObjectRef({ objectId: curveId, initialSharedVersion: sv5, mutable: true });
  tx5.moveCall({
    target: `${pkgId}::bonding_curve::record_graduation_pool`,
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
    console.warn(`  [turbos] ⚠ record_graduation_pool failed: ${r5.effects.status.error}`);
  } else {
    console.log(`  [turbos] ✓ recorded: ${r5.digest}`);
  }

  console.log(`  [turbos] ✅ Done — Pool: ${poolId}`);
  return { poolId, txDigest: poolResult.digest };
}

// ── Standalone CLI entry point ────────────────────────────────────────────────
if (process.argv[1] && process.argv[1].endsWith('graduate_turbos_full.js')) {
  const curveId = process.argv[2];
  if (!curveId?.startsWith('0x')) {
    console.error('Usage: node graduate_turbos_full.js <CURVE_ID>');
    process.exit(1);
  }

  const client  = defaultClient();
  const keypair = defaultKeypair();
  const obj     = await client.getObject({ id: curveId, options: { showContent: true, showType: true } });
  const fields  = obj.data?.content?.fields ?? {};
  const tokenType = obj.data?.type?.match(/Curve<(.+)>$/)?.[1];
  if (!tokenType) { console.error('❌ Could not parse token type'); process.exit(1); }
  const pkgId = tokenType.split('::')[0];

  console.log('━'.repeat(60));
  console.log('  SUIPUMP — Graduate to Turbos CLMM (standalone)');
  console.log('━'.repeat(60));
  console.log(`  curve:   ${curveId}`);
  console.log(`  token:   ${fields.name} ($${fields.symbol})`);
  console.log(`  type:    ${tokenType}`);
  console.log(`  pkg:     ${pkgId}`);
  console.log();

  try {
    const result = await graduateToTurbos({ curveId, tokenType, pkgId, keypair, client });
    console.log();
    console.log(`  txDigest: ${result.txDigest}`);
    console.log(`  poolId:   ${result.poolId}`);
    console.log('  https://testnet.suivision.xyz/txblock/' + result.txDigest);
  } catch (err) {
    console.error('❌', err.message);
    process.exit(1);
  }
}
