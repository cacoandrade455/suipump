// auto_graduate.js — Auto-graduation watcher for SuiPump indexer
// Polls the DB every 30s for curves that have crossed the 9,000 SUI threshold
// and fires the appropriate graduation script automatically.
//
// This runs as part of the indexer process — imported and called from index.js.
// It uses the admin keypair to sign graduation transactions.
//
// Graduation targets:
//   0 = Cetus    (mainnet only — skipped on testnet)
//   1 = DeepBook (uses graduate_deepbook_full logic)
//   2 = Turbos   (uses graduate_turbos_full logic)

import { Transaction } from '@mysten/sui/transactions';
import { SuiClient, getFullnodeUrl } from '@mysten/sui/client';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { fromB64 } from '@mysten/sui/utils';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { pool } from './db.js';

// ── Config ────────────────────────────────────────────────────────────────────
const RPC_URL = process.env.SUI_RPC_URL || getFullnodeUrl('testnet');
const client  = new SuiClient({ url: RPC_URL });

// All V8 package IDs — dispatcher uses the curve's own package
const PACKAGES = {
  V4: '0x2154486dcf503bd3e8feae4fb913e862f7e2bbf4489769aff63978f55d55b4a8',
  V5: '0x785c0604cb6c60a8547501e307d2b0ca7a586ff912c8abff4edfb88db65b7236',
  V6: '0x21d5b1284d5f1d4d14214654f414ffca20c757ee9f9db7701d3ffaaac62cd768',
  V7: '0xfb8f3f3e4e8d53130ac140906eebea6b6740bfaf0c971aec607fbc723be951f0',
  V8_1: '0x145a1e79b83cc17680dbfe4f96839cd359c7db380ac15463ecb6dc30f9849b69',
  V8:   '0xbb4ee050239f59dfd983501ce101698ba27857f77aff2d437cec568fe0062546',
};

// AdminCap IDs per package (needed for claim_graduation_funds + record_graduation_pool)
const ADMIN_CAPS = {
  [PACKAGES.V7]:   '0x1dc44030adaa6e366666a8e095fc29a5a55c8ae614f04c5e93c062a85b475527',
  [PACKAGES.V8_1]: '0xdb22e067d9cf53cfab37bc6d4b626ff98c770bc59b8a192d007aca449e8f7103',
  [PACKAGES.V8]:   '0x9779a2466f2e30ca5e139f636cc9ca1c44e025da29203d781cc2645ebb62bb35',
};

const SUI_CLOCK_ID = '0x0000000000000000000000000000000000000000000000000000000000000006';
const GRAD_THRESHOLD_MIST = 9_000n * 1_000_000_000n;
const POLL_INTERVAL_MS    = 30_000;

// Track curves currently being graduated to avoid double-firing
const inProgress = new Set();

// ── Keypair ───────────────────────────────────────────────────────────────────
function loadKeypair() {
  // Reads from SUI_PRIVATE_KEY env var (base64 keypair) or falls back to keystore
  if (process.env.SUI_PRIVATE_KEY) {
    const raw = fromB64(process.env.SUI_PRIVATE_KEY);
    return Ed25519Keypair.fromSecretKey(raw[0] === 0x00 ? raw.slice(1) : raw);
  }
  const keystorePath = join(homedir(), '.sui', 'sui_config', 'sui.keystore');
  const keys = JSON.parse(readFileSync(keystorePath, 'utf-8'));
  const raw  = fromB64(keys[0]);
  return Ed25519Keypair.fromSecretKey(raw[0] === 0x00 ? raw.slice(1) : raw);
}

// ── Helpers ───────────────────────────────────────────────────────────────────
async function getSharedVersion(objectId) {
  const obj = await client.getObject({ id: objectId, options: { showOwner: true } });
  return obj.data?.owner?.Shared?.initial_shared_version;
}

function resolvePackageId(tokenType) {
  for (const [, pkgId] of Object.entries(PACKAGES)) {
    if (tokenType.startsWith(pkgId)) return pkgId;
  }
  return PACKAGES.V8;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Step 1: graduate() ────────────────────────────────────────────────────────
async function callGraduate(curveId, tokenType, pkgId, keypair) {
  console.log(`  [auto-grad] graduate() → ${curveId.slice(0, 12)}…`);

  const sv  = await getSharedVersion(curveId);
  const tx  = new Transaction();

  // V8/V8_1: graduate() takes &mut CoinMetadata<T> as shared ref
  // V7: graduate() takes CoinMetadata<T> by value
  // V4-V6: graduate() takes no metadata
  if (pkgId === PACKAGES.V8 || pkgId === PACKAGES.V8_1) {
    const meta = await client.getCoinMetadata({ coinType: tokenType });
    const metaId = meta?.id;
    if (!metaId) throw new Error(`CoinMetadata not found for ${tokenType}`);
    const metaSv = await getSharedVersion(metaId);
    tx.moveCall({
      target: `${pkgId}::bonding_curve::graduate`,
      typeArguments: [tokenType],
      arguments: [
        tx.sharedObjectRef({ objectId: curveId, initialSharedVersion: sv, mutable: true }),
        tx.sharedObjectRef({ objectId: metaId, initialSharedVersion: metaSv, mutable: true }),
      ],
    });
  } else if (pkgId === PACKAGES.V7) {
    const meta = await client.getCoinMetadata({ coinType: tokenType });
    const metaId = meta?.id;
    if (!metaId) throw new Error(`CoinMetadata not found for ${tokenType}`);
    tx.moveCall({
      target: `${pkgId}::bonding_curve::graduate`,
      typeArguments: [tokenType],
      arguments: [
        tx.sharedObjectRef({ objectId: curveId, initialSharedVersion: sv, mutable: true }),
        tx.object(metaId),
      ],
    });
  } else {
    tx.moveCall({
      target: `${pkgId}::bonding_curve::graduate`,
      typeArguments: [tokenType],
      arguments: [
        tx.sharedObjectRef({ objectId: curveId, initialSharedVersion: sv, mutable: true }),
      ],
    });
  }

  const res = await client.signAndExecuteTransaction({
    signer: keypair, transaction: tx, options: { showEffects: true },
  });
  if (res.effects.status.status !== 'success') {
    throw new Error(`graduate() failed: ${res.effects.status.error}`);
  }
  console.log(`  [auto-grad] ✓ graduated: ${res.digest}`);
  await sleep(3000);
}

// ── Step 2: claim_graduation_funds() ─────────────────────────────────────────
async function claimGraduationFunds(curveId, tokenType, pkgId, adminCapId, keypair) {
  console.log(`  [auto-grad] claim_graduation_funds()…`);
  const sv = await getSharedVersion(curveId);
  const tx = new Transaction();
  const suiCoin = tx.moveCall({
    target: `${pkgId}::bonding_curve::claim_graduation_funds`,
    typeArguments: [tokenType],
    arguments: [
      tx.object(adminCapId),
      tx.sharedObjectRef({ objectId: curveId, initialSharedVersion: sv, mutable: true }),
    ],
  });
  tx.transferObjects([suiCoin], tx.pure.address(loadKeypair().toSuiAddress()));
  const res = await client.signAndExecuteTransaction({
    signer: keypair, transaction: tx, options: { showEffects: true, showObjectChanges: true },
  });
  if (res.effects.status.status !== 'success') {
    throw new Error(`claim_graduation_funds() failed: ${res.effects.status.error}`);
  }
  console.log(`  [auto-grad] ✓ funds claimed: ${res.digest}`);
  await sleep(2000);
  return res;
}

// ── DEX pool creation (stubs for Cetus, full calls for Turbos/DeepBook) ───────
async function createDexPool(curveId, tokenType, pkgId, graduationTarget, keypair) {
  const target = Number(graduationTarget ?? 0);

  if (target === 0) {
    // Cetus — mainnet only, skip on testnet
    console.log(`  [auto-grad] Cetus graduation — mainnet only, skipping DEX pool creation`);
    console.log(`  [auto-grad] ⚠ Notify admin to create Cetus pool manually for ${curveId}`);
    return null;
  }

  if (target === 2) {
    // Turbos — dynamically import and run full graduation
    console.log(`  [auto-grad] Creating Turbos pool…`);
    try {
      const { graduateToTurbos } = await import('../graduation-test-turbos/graduate_turbos_full.js');
      return await graduateToTurbos({ curveId, tokenType, pkgId, keypair, client });
    } catch (err) {
      console.error(`  [auto-grad] Turbos pool creation failed:`, err.message);
      console.error(`  [auto-grad] ⚠ Admin must create Turbos pool manually for ${curveId}`);
      return null;
    }
  }

  if (target === 1) {
    // DeepBook
    console.log(`  [auto-grad] Creating DeepBook pool…`);
    try {
      const { graduateToDeepBook } = await import('../graduation-test/graduate_deepbook_full.js');
      return await graduateToDeepBook({ curveId, tokenType, pkgId, keypair, client });
    } catch (err) {
      console.error(`  [auto-grad] DeepBook pool creation failed:`, err.message);
      console.error(`  [auto-grad] ⚠ Admin must create DeepBook pool manually for ${curveId}`);
      return null;
    }
  }
}

// ── Main graduation flow ──────────────────────────────────────────────────────
async function graduateCurve(curveId, curveData) {
  if (inProgress.has(curveId)) return;
  inProgress.add(curveId);

  const keypair   = loadKeypair();
  const pkgId     = curveData.package_id || PACKAGES.V8;
  const adminCapId = ADMIN_CAPS[pkgId];
  const tokenType = curveData.token_type;
  const gradTarget = curveData.graduation_target ?? 0;

  if (!tokenType) {
    console.error(`  [auto-grad] ✗ No token type for curve ${curveId} — skipping`);
    inProgress.delete(curveId);
    return;
  }
  if (!adminCapId) {
    console.error(`  [auto-grad] ✗ No AdminCap for package ${pkgId} — skipping`);
    inProgress.delete(curveId);
    return;
  }

  console.log(`\n  [auto-grad] 🎓 Graduating ${curveData.name ?? curveId} (target: ${['Cetus','DeepBook','Turbos'][gradTarget]})`);

  try {
    // 1. Mark as graduated on-chain
    await callGraduate(curveId, tokenType, pkgId, keypair);

    // 2. Claim SUI + LP tokens
    await claimGraduationFunds(curveId, tokenType, pkgId, adminCapId, keypair);

    // 3. Create DEX pool
    await createDexPool(curveId, tokenType, pkgId, gradTarget, keypair);

    // 4. Mark as graduated in DB so watcher ignores it
    await pool.query(
      `UPDATE curves SET graduated = true WHERE curve_id = $1`,
      [curveId]
    );
    console.log(`  [auto-grad] ✅ ${curveData.name ?? curveId} fully graduated`);

  } catch (err) {
    console.error(`  [auto-grad] ✗ Graduation failed for ${curveId}:`, err.message);
  } finally {
    inProgress.delete(curveId);
  }
}

// ── Watcher loop ─────────────────────────────────────────────────────────────
export async function startGraduationWatcher() {
  console.log('  [auto-grad] Graduation watcher started — polling every 30s');

  // Add graduated column to curves table if it doesn't exist
  await pool.query(`ALTER TABLE curves ADD COLUMN IF NOT EXISTS graduated BOOLEAN DEFAULT false`);

  while (true) {
    try {
      // Find curves that are at/above threshold but not yet graduated
      // We check token_stats for reserve — fall back to RPC if needed
      const res = await pool.query(`
        SELECT
          c.curve_id,
          c.name,
          c.token_type,
          c.package_id,
          c.graduation_target
        FROM curves c
        WHERE c.graduated = false
          OR c.graduated IS NULL
        LIMIT 50
      `);

      for (const row of res.rows) {
        if (inProgress.has(row.curve_id)) continue;

        // Check real-time reserve via RPC
        try {
          const obj = await client.getObject({
            id: row.curve_id,
            options: { showContent: true },
          });
          const fields = obj.data?.content?.fields;
          if (!fields) continue;

          // Already graduated on-chain
          if (fields.graduated === true) {
            await pool.query(`UPDATE curves SET graduated = true WHERE curve_id = $1`, [row.curve_id]);
            continue;
          }

          const suiReserve = BigInt(fields.sui_reserve ?? 0);
          if (suiReserve >= GRAD_THRESHOLD_MIST) {
            // Fire graduation asynchronously — don't await so watcher keeps running
            graduateCurve(row.curve_id, {
              ...row,
              token_type: row.token_type || fields.token_type,
              graduation_target: row.graduation_target ?? fields.graduation_target ?? 0,
            }).catch(err => console.error('[auto-grad] unhandled:', err.message));
          }
        } catch (err) {
          // RPC error for one curve — skip and continue
          if (!err.message?.includes('not found')) {
            console.error(`  [auto-grad] RPC error for ${row.curve_id.slice(0,12)}…:`, err.message);
          }
        }

        // Throttle RPC calls — 50ms between curve checks
        await sleep(50);
      }
    } catch (err) {
      console.error('  [auto-grad] Watcher poll error:', err.message);
    }

    await sleep(POLL_INTERVAL_MS);
  }
}
