// graduation-test/graduate_deepbook_full.js
// Graduates a SuiPump bonding curve to a DeepBook BalanceManager.
//
// DUAL-MODE:
//   - Exported function: graduateToDeepBook({ curveId, tokenType, pkgId, keypair, client })
//     Called by indexer/auto_graduate.js — all context passed in, no process.exit.
//
//   - Standalone CLI: node graduate_deepbook_full.js <CURVE_ID>
//     Uses env SUI_PRIVATE_KEY + SUI_RPC_URL, calls process.exit on failure.
//
// Steps:
//   1. Call graduate() on-chain (if not already graduated)
//   2. Claim graduation funds (SUI pool + LP tokens go to admin wallet)
//   3. Build BalanceManager, deposit TOKEN + SUI, transfer to curve.creator

import { Transaction } from '@mysten/sui/transactions';
import { SuiClient, getFullnodeUrl } from '@mysten/sui/client';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { DeepBookClient } from '@mysten/deepbook-v3';
import { fromBase64 } from '@mysten/sui/utils';

// ── Constants ─────────────────────────────────────────────────────────────────
const SUI_CLOCK_ID = '0x6';

// All AdminCap IDs by package version — kept in sync with auto_graduate.js
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

function fmtSui(mist) {
  return `${(Number(BigInt(mist)) / 1e9).toFixed(4)} SUI`;
}

function defaultClient() {
  return new SuiClient({ url: process.env.SUI_RPC_URL || getFullnodeUrl('testnet') });
}

function defaultKeypair() {
  const raw = process.env.SUI_PRIVATE_KEY;
  if (!raw) throw new Error('SUI_PRIVATE_KEY env var not set');
  const bytes = fromBase64(raw);
  // Strip flag byte if present (65 bytes → 64)
  const seed = bytes.length === 65 ? bytes.slice(1) : bytes;
  return Ed25519Keypair.fromSecretKey(seed);
}

async function getSharedVersion(client, objectId) {
  const obj = await client.getObject({ id: objectId, options: { showOwner: true } });
  return obj.data?.owner?.Shared?.initial_shared_version;
}

// ── Core exported function ────────────────────────────────────────────────────

/**
 * Graduates a SuiPump curve to DeepBook.
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
export async function graduateToDeepBook({ curveId, tokenType, pkgId, keypair, client }) {
  const address   = keypair.toSuiAddress();
  const adminCapId = ADMIN_CAPS[pkgId];
  if (!adminCapId) throw new Error(`No AdminCap for package ${pkgId}`);

  console.log(`  [deepbook] Graduating ${curveId.slice(0, 12)}… → DeepBook`);
  console.log(`  [deepbook] token: ${tokenType}`);
  console.log(`  [deepbook] pkg:   ${pkgId}`);

  // ── Step 1: graduate() ──────────────────────────────────────────────────────
  const curveObj = await client.getObject({ id: curveId, options: { showContent: true } });
  const fields   = curveObj.data?.content?.fields ?? {};

  if (!fields.graduated) {
    console.log(`  [deepbook] [1/3] Calling graduate()…`);

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
        target: `${pkgId}::bonding_curve::graduate`,
        typeArguments: [tokenType],
        arguments: [ref, metaRef],
      });
    } else {
      // Legacy packages (V4-V7) — no metadata arg
      tx.moveCall({
        target: `${pkgId}::bonding_curve::graduate`,
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
    console.log(`  [deepbook] ✓ graduate: ${r.digest}`);
    await sleep(3000);
  } else {
    console.log(`  [deepbook] [1/3] Already graduated — skipping`);
  }

  // ── Step 2: claim_graduation_funds() ───────────────────────────────────────
  const updated    = await client.getObject({ id: curveId, options: { showContent: true } });
  const poolSuiMist = BigInt(updated.data?.content?.fields?.sui_reserve ?? 0);
  const creator    = updated.data?.content?.fields?.creator ?? address;

  if (poolSuiMist === 0n) throw new Error('Pool SUI is 0 — already claimed or nothing to deposit');

  console.log(`  [deepbook] [2/3] Claiming ${fmtSui(poolSuiMist)} pool SUI…`);

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
  if (r2.effects.status.status !== 'success') {
    throw new Error(`claim_graduation_funds() failed: ${r2.effects.status.error}`);
  }
  console.log(`  [deepbook] ✓ claimed: ${r2.digest}`);
  await sleep(3000);

  // ── Step 3: DeepBook BalanceManager ────────────────────────────────────────
  console.log(`  [deepbook] [3/3] Building DeepBook BalanceManager…`);

  // Collect LP tokens (200M transferred to wallet in graduate())
  const lpCoins = await client.getCoins({ owner: address, coinType: tokenType });
  if (!lpCoins.data.length) throw new Error('No LP tokens found in admin wallet');

  const totalLp = lpCoins.data.reduce((s, c) => s + BigInt(c.balance), 0n);
  console.log(`  [deepbook]   LP tokens: ${(Number(totalLp) / 1e6).toLocaleString()}`);

  // Find a SUI coin large enough
  const suiCoins   = await client.getCoins({ owner: address, coinType: '0x2::sui::SUI' });
  const suiForDeposit = suiCoins.data
    .filter(c => BigInt(c.balance) >= poolSuiMist + 500_000_000n)
    .sort((a, b) => Number(BigInt(a.balance) - BigInt(b.balance)))[0];
  if (!suiForDeposit) throw new Error(`No SUI coin large enough — need ${fmtSui(poolSuiMist + 500_000_000n)}`);

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
    target: `${pkgId}::bonding_curve::record_graduation_pool`,
    typeArguments: [tokenType],
    arguments: [tx4.object(adminCapId), ref4, tx4.pure.id(poolId), tx4.pure.id(poolId)],
  });
  const r4 = await client.signAndExecuteTransaction({
    signer: keypair, transaction: tx4, options: { showEffects: true },
  });
  if (r4.effects.status.status !== 'success') {
    // Non-fatal — pool is created, just record failed
    console.warn(`  [deepbook] ⚠ record_graduation_pool failed: ${r4.effects.status.error}`);
  } else {
    console.log(`  [deepbook] ✓ recorded: ${r4.digest}`);
  }

  console.log(`  [deepbook] ✅ Done — BalanceManager: ${poolId}`);
  return { poolId, txDigest: r3.digest };
}

// ── Standalone CLI entry point ────────────────────────────────────────────────
if (process.argv[1] && process.argv[1].endsWith('graduate_deepbook_full.js')) {
  const curveId = process.argv[2];
  if (!curveId?.startsWith('0x')) {
    console.error('Usage: node graduate_deepbook_full.js <CURVE_ID>');
    process.exit(1);
  }

  const client  = defaultClient();
  const keypair = defaultKeypair();

  // Fetch curve to resolve pkgId + tokenType
  const obj    = await client.getObject({ id: curveId, options: { showContent: true, showType: true } });
  const fields = obj.data?.content?.fields ?? {};
  const tokenType = obj.data?.type?.match(/Curve<(.+)>$/)?.[1];
  if (!tokenType) { console.error('❌ Could not parse token type'); process.exit(1); }

  // Resolve pkgId from token type (first segment)
  const pkgId  = tokenType.split('::')[0];

  console.log('━'.repeat(60));
  console.log('  SUIPUMP — Graduate to DeepBook (standalone)');
  console.log('━'.repeat(60));
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
    console.error('❌', err.message);
    process.exit(1);
  }
}
