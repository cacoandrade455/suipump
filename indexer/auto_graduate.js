// auto_graduate.js — Auto-graduation watcher for SuiPump indexer
// Polls the DB every 30s for curves that have crossed the graduation threshold
// and fires the appropriate graduation script automatically.
//
// IMPORTANT: grpcClient is passed in from index.js which uses GrpcTransport
// (Node.js native @grpc/grpc-js). Do NOT create a new SuiGrpcClient here
// with GrpcWebFetchTransport (browser-only fetch) — that causes "fetch failed".

import { Transaction } from '@mysten/sui/transactions';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { fromBase64 } from '@mysten/sui/utils';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { pool } from './db.js';

// ── Config ────────────────────────────────────────────────────────────────────

const PACKAGES = {
  V4:   '0x2154486dcf503bd3e8feae4fb913e862f7e2bbf4489769aff63978f55d55b4a8',
  V5:   '0x785c0604cb6c60a8547501e307d2b0ca7a586ff912c8abff4edfb88db65b7236',
  V6:   '0x21d5b1284d5f1d4d14214654f414ffca20c757ee9f9db7701d3ffaaac62cd768',
  V7:   '0xfb8f3f3e4e8d53130ac140906eebea6b6740bfaf0c971aec607fbc723be951f0',
  V8_1: '0x145a1e79b83cc17680dbfe4f96839cd359c7db380ac15463ecb6dc30f9849b69',
  V8:   '0xbb4ee050239f59dfd983501ce101698ba27857f77aff2d437cec568fe0062546',
};

const ADMIN_CAPS = {
  [PACKAGES.V4]:   '0xfc80d40718e8e9d0bc1fddc1e47a74e46d0c89c3e1e36a2bc8f016efb6d51e0c',
  [PACKAGES.V5]:   '0xfc80d40718e8e9d0bc1fddc1e47a74e46d0c89c3e1e36a2bc8f016efb6d51e0c',
  [PACKAGES.V6]:   '0xfc80d40718e8e9d0bc1fddc1e47a74e46d0c89c3e1e36a2bc8f016efb6d51e0c',
  [PACKAGES.V7]:   '0x1dc44030adaa6e366666a8e095fc29a5a55c8ae614f04c5e93c062a85b475527',
  [PACKAGES.V8_1]: '0xdb22e067d9cf53cfab37bc6d4b626ff98c770bc59b8a192d007aca449e8f7103',
  [PACKAGES.V8]:   '0x9779a2466f2e30ca5e139f636cc9ca1c44e025da29203d781cc2645ebb62bb35',
};

const GRAD_THRESHOLD_MIST = 9_000n * 1_000_000_000n;
const POLL_INTERVAL_MS    = 30_000;

const inProgress = new Set();

// ── Keypair ───────────────────────────────────────────────────────────────────

function loadKeypair() {
  if (process.env.SUI_PRIVATE_KEY) {
    const raw  = fromBase64(process.env.SUI_PRIVATE_KEY);
    const seed = (raw.length === 33 || raw.length === 65) ? raw.slice(1) : raw;
    return Ed25519Keypair.fromSecretKey(seed);
  }
  const keystorePath = join(homedir(), '.sui', 'sui_config', 'sui.keystore');
  const keys = JSON.parse(readFileSync(keystorePath, 'utf-8'));
  const raw  = fromBase64(keys[0]);
  return Ed25519Keypair.fromSecretKey(raw[0] === 0x00 ? raw.slice(1) : raw);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function getSharedVersion(client, objectId) {
  const { object } = await client.core.getObject({ objectId, include: { owner: true } });
  return object?.owner?.$kind === 'Shared'
    ? object.owner.Shared.initialSharedVersion
    : undefined;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Step 1: graduate() ────────────────────────────────────────────────────────

async function callGraduate(client, curveId, tokenType, pkgId, keypair) {
  console.log(`  [auto-grad] graduate() → ${curveId.slice(0, 12)}…`);

  const sv = await getSharedVersion(client, curveId);
  const tx = new Transaction();

  if (pkgId === PACKAGES.V8 || pkgId === PACKAGES.V8_1) {
    const meta   = await client.core.getCoinMetadata({ coinType: tokenType });
    const metaId = meta?.id;
    if (!metaId) throw new Error(`CoinMetadata not found for ${tokenType}`);
    const metaSv = await getSharedVersion(client, metaId);
    tx.moveCall({
      target: `${pkgId}::bonding_curve::graduate`,
      typeArguments: [tokenType],
      arguments: [
        tx.sharedObjectRef({ objectId: curveId, initialSharedVersion: sv,     mutable: true }),
        tx.sharedObjectRef({ objectId: metaId,  initialSharedVersion: metaSv, mutable: true }),
      ],
    });
  } else if (pkgId === PACKAGES.V7) {
    const meta   = await client.core.getCoinMetadata({ coinType: tokenType });
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

  const res = await client.core.signAndExecuteTransaction({
    signer: keypair, transaction: tx, include: { effects: true },
  });
  if (res.effects?.status !== 'Success') {
    throw new Error(`graduate() failed: ${JSON.stringify(res.effects?.status)}`);
  }
  console.log(`  [auto-grad] ✓ graduated: ${res.digest}`);
  await sleep(3000);
}

// ── Step 2: claim_graduation_funds() ─────────────────────────────────────────

async function claimGraduationFunds(client, curveId, tokenType, pkgId, adminCapId, keypair) {
  console.log(`  [auto-grad] claim_graduation_funds()…`);

  const sv = await getSharedVersion(client, curveId);
  const tx = new Transaction();

  const [suiCoin] = tx.moveCall({
    target: `${pkgId}::bonding_curve::claim_graduation_funds`,
    typeArguments: [tokenType],
    arguments: [
      tx.object(adminCapId),
      tx.sharedObjectRef({ objectId: curveId, initialSharedVersion: sv, mutable: true }),
    ],
  });
  tx.transferObjects([suiCoin], keypair.toSuiAddress());

  const res = await client.core.signAndExecuteTransaction({
    signer: keypair, transaction: tx, include: { effects: true },
  });
  if (res.effects?.status !== 'Success') {
    throw new Error(`claim_graduation_funds() failed: ${JSON.stringify(res.effects?.status)}`);
  }
  console.log(`  [auto-grad] ✓ funds claimed: ${res.digest}`);
  await sleep(2000);
  return res;
}

// ── Step 3: DEX pool creation ─────────────────────────────────────────────────

async function createDexPool(client, curveId, tokenType, pkgId, graduationTarget, keypair) {
  const target = Number(graduationTarget ?? 0);

  if (target === 0) {
    console.log(`  [auto-grad] Cetus graduation — mainnet only, skipping DEX pool creation`);
    return null;
  }
  if (target === 2) {
    console.log(`  [auto-grad] Creating Turbos pool…`);
    try {
      const { graduateToTurbos } = await import('../graduation-test-turbos/graduate_turbos_full.js');
      return await graduateToTurbos({ curveId, tokenType, pkgId, keypair, client });
    } catch (err) {
      console.error(`  [auto-grad] Turbos pool creation failed:`, err.message);
      return null;
    }
  }
  if (target === 1) {
    console.log(`  [auto-grad] Creating DeepBook pool…`);
    try {
      const { graduateToDeepBook } = await import('../graduation-test/graduate_deepbook_full.js');
      return await graduateToDeepBook({ curveId, tokenType, pkgId, keypair, client });
    } catch (err) {
      console.error(`  [auto-grad] DeepBook pool creation failed:`, err.message);
      return null;
    }
  }
}

// ── Main graduation flow ──────────────────────────────────────────────────────

async function graduateCurve(client, curveId, curveData) {
  if (inProgress.has(curveId)) return;
  inProgress.add(curveId);

  const keypair    = loadKeypair();
  const pkgId      = curveData.package_id || PACKAGES.V8;
  const adminCapId = ADMIN_CAPS[pkgId];
  const tokenType  = curveData.token_type;
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
    await callGraduate(client, curveId, tokenType, pkgId, keypair);
    await claimGraduationFunds(client, curveId, tokenType, pkgId, adminCapId, keypair);
    await createDexPool(client, curveId, tokenType, pkgId, gradTarget, keypair);
    await pool.query(`UPDATE curves SET graduated = true WHERE curve_id = $1`, [curveId]);
    console.log(`  [auto-grad] ✓ ${curveData.name ?? curveId} fully graduated`);
  } catch (err) {
    console.error(`  [auto-grad] ✗ Graduation failed for ${curveId}:`, err.message);
  } finally {
    inProgress.delete(curveId);
  }
}

// ── Watcher loop ──────────────────────────────────────────────────────────────
// grpcClient is passed in from index.js (uses GrpcTransport, not GrpcWebFetchTransport)

export async function startGraduationWatcher(grpcClient) {
  console.log('  [auto-grad] Graduation watcher started — polling every 30s');

  await pool.query(`ALTER TABLE curves ADD COLUMN IF NOT EXISTS graduated BOOLEAN DEFAULT false`);

  while (true) {
    try {
      const res = await pool.query(`
        SELECT c.curve_id, c.name, c.token_type, c.package_id, c.graduation_target
        FROM curves c
        WHERE c.graduated = false OR c.graduated IS NULL
        LIMIT 50
      `);

      for (const row of res.rows) {
        if (inProgress.has(row.curve_id)) continue;

        try {
          const { object } = await grpcClient.core.getObject({
            objectId: row.curve_id,
            include: { content: true },
          });

          const fields = object?.asMoveObject?.contents?.fields;
          if (!fields) continue;

          if (fields.graduated === true) {
            await pool.query(`UPDATE curves SET graduated = true WHERE curve_id = $1`, [row.curve_id]);
            continue;
          }

          const suiReserve = BigInt(fields.sui_reserve ?? 0);
          if (suiReserve >= GRAD_THRESHOLD_MIST) {
            graduateCurve(grpcClient, row.curve_id, {
              ...row,
              token_type:        row.token_type        || fields.token_type,
              graduation_target: row.graduation_target ?? fields.graduation_target ?? 0,
            }).catch(err =>
              console.error(`  [auto-grad] graduateCurve error:`, err.message)
            );
          }
        } catch (err) {
          console.error(`  [auto-grad] getObject error for ${row.curve_id.slice(0, 12)}:`, err.message);
        }
      }
    } catch (err) {
      console.error('  [auto-grad] watcher loop error:', err.message);
    }

    await sleep(POLL_INTERVAL_MS);
  }
}
