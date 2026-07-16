// auto_graduate.js — Auto-graduation watcher for SuiPump indexer
// Polls the DB every 30s for curves that have crossed the graduation threshold
// and fires the appropriate graduation script automatically.
//
// IMPORTANT: grpcClient is passed in from index.js which uses GrpcTransport
// (Node.js native @grpc/grpc-js). Do NOT create a new SuiGrpcClient here
// with GrpcWebFetchTransport (browser-only fetch) — that causes "fetch failed".

import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { fromBase64 } from '@mysten/sui/utils';
import { SuiGraphQLClient } from '@mysten/sui/graphql';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { pool } from './db.js';

const NETWORK     = process.env.NETWORK         ?? 'testnet';
const GRAPHQL_URL = process.env.SUI_GRAPHQL_URL ?? 'https://graphql.' + NETWORK + '.sui.io/graphql';
const graphqlClient = new SuiGraphQLClient({ url: GRAPHQL_URL });

// ── Config ────────────────────────────────────────────────────────────────────

const PACKAGES = {
  V4:   '0x2154486dcf503bd3e8feae4fb913e862f7e2bbf4489769aff63978f55d55b4a8',
  V5:   '0x785c0604cb6c60a8547501e307d2b0ca7a586ff912c8abff4edfb88db65b7236',
  V6:   '0x21d5b1284d5f1d4d14214654f414ffca20c757ee9f9db7701d3ffaaac62cd768',
  V7:   '0xfb8f3f3e4e8d53130ac140906eebea6b6740bfaf0c971aec607fbc723be951f0',
  V8_1: '0x145a1e79b83cc17680dbfe4f96839cd359c7db380ac15463ecb6dc30f9849b69',
  V8:   '0xbb4ee050239f59dfd983501ce101698ba27857f77aff2d437cec568fe0062546',
  V9:   '0x719698e5138582d78ee95317271e8bce05769569a4f58c940a7f1b424d90ffe2',
  V10:  '0x2deda2cade65cd5afd5ffbe799d48f2491debf08d3aef6fa11aa6e1c8afe1598',
  V11:  '0xc03817bce45ff492e5d0f40f9e46f5a075a952b50c5c6146b8fb38138bd699eb',
  V12:  '0xf5a3566ba920a3e3614e8b25da0ca3237879b6e22eb12f21ccf2bceb6520b9cd',
};

// AdminCap per DEFINING package. The whole V10 lineage (V10/V11/V12+) shares ONE
// AdminCap (0x144d...) — the V10 defining package governs all its upgrades.
const ADMIN_CAPS = {
  [PACKAGES.V4]:   '0xfc80d40718e8e9d0bc1fddc1e47a74e46d0c89c3e1e36a2bc8f016efb6d51e0c',
  [PACKAGES.V5]:   '0xfc80d40718e8e9d0bc1fddc1e47a74e46d0c89c3e1e36a2bc8f016efb6d51e0c',
  [PACKAGES.V6]:   '0xfc80d40718e8e9d0bc1fddc1e47a74e46d0c89c3e1e36a2bc8f016efb6d51e0c',
  [PACKAGES.V7]:   '0x1dc44030adaa6e366666a8e095fc29a5a55c8ae614f04c5e93c062a85b475527',
  [PACKAGES.V8_1]: '0xdb22e067d9cf53cfab37bc6d4b626ff98c770bc59b8a192d007aca449e8f7103',
  [PACKAGES.V8]:   '0x9779a2466f2e30ca5e139f636cc9ca1c44e025da29203d781cc2645ebb62bb35',
  [PACKAGES.V9]:   '0x2e0989604424ffa96f58618795285dac09d8eaf2fd0d35f4a7e9bbc22bea2bf7',
  [PACKAGES.V10]:  '0x144d426960a9a6b8db63ce3426e06a9c41273a17e72ed0193cd8c8507d4f6ec5',
  [PACKAGES.V11]:  '0x144d426960a9a6b8db63ce3426e06a9c41273a17e72ed0193cd8c8507d4f6ec5',
  [PACKAGES.V12]:  '0x144d426960a9a6b8db63ce3426e06a9c41273a17e72ed0193cd8c8507d4f6ec5',
};

// WRITE-target remap: a curve's package_id in the DB is its DEFINING package (V10
// for the whole lineage), but graduate/claim/record WRITES must target the LATEST
// upgrade that actually contains claim_graduation_funds. Types stay V10-defined.
// TODO(owner): bump LATEST_WRITE_PACKAGE to the V13 upgrade id once the
// claim_graduation_funds upgrade is published. claim_graduation_funds does NOT
// exist in the currently-deployed V10/V11/V12 — writes abort until V13 ships.
const LATEST_WRITE_PACKAGE = PACKAGES.V12;

const WRITE_PACKAGE = {
  [PACKAGES.V10]: LATEST_WRITE_PACKAGE,
  [PACKAGES.V11]: LATEST_WRITE_PACKAGE,
  [PACKAGES.V12]: LATEST_WRITE_PACKAGE,
};

function writePackageFor(pkgId) {
  return WRITE_PACKAGE[pkgId] ?? pkgId;
}

const POLL_INTERVAL_MS = 30_000;

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

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Robustly detect whether a curve already has a recorded DEX pool on-chain.
// pool_id is an Option<ID>: None serializes variously (null / empty vec), Some as
// an id string. Treat the zero address as absent.
function hasPool(fields) {
  const p = fields?.pool_id;
  if (p == null) return false;
  if (typeof p === 'string') return p.length > 0 && !/^0x0+$/.test(p);
  if (Array.isArray(p)) return p.length > 0;
  if (Array.isArray(p.vec)) return p.vec.length > 0;
  if (p.fields && Array.isArray(p.fields.vec)) return p.fields.vec.length > 0;
  return true;
}

// ── DEX pool creation ─────────────────────────────────────────────────────────

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
  const pkgId      = curveData.package_id || PACKAGES.V10; // DEFINING pkg; V10 lineage default, never silently V8
  const adminCapId = ADMIN_CAPS[pkgId];
  const tokenType  = curveData.token_type;
  const gradTarget = curveData.graduation_target ?? 0;

  if (!curveData.package_id) {
    console.warn(`  [auto-grad] ⚠ No package_id for ${curveId} — defaulting to V10 lineage`);
  }
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

  console.log(`\n  [auto-grad] 🎓 Graduating ${curveData.name ?? curveId} (target: ${['Cetus','DeepBook','Turbos'][gradTarget]}) — write pkg ${writePackageFor(pkgId)}`);

  try {
    // The full graduation script owns the ENTIRE on-chain flow:
    // graduate() -> claim_graduation_funds() -> create pool -> record_graduation_pool().
    // auto_graduate no longer graduates/claims itself — doing both here AND in the
    // full script caused a double claim whose second call aborted with
    // ELpAlreadyClaimed (code 51). This is now a thin watcher+dispatcher.
    const poolResult = await createDexPool(client, curveId, tokenType, pkgId, gradTarget, keypair);

    if (poolResult?.skipped) {
      // Terminal skip (e.g. EReserveTooLow / F-2 griefed graduation). Mark handled
      // so the watcher stops re-dispatching it — do NOT auto-retry; needs manual
      // review.
      console.warn(`  [auto-grad] ⚠ ${curveData.name ?? curveId} skipped (${poolResult.reason}) — marking handled to stop retry, NEEDS MANUAL REVIEW`);
      await pool.query(`UPDATE curves SET graduated = true WHERE curve_id = $1`, [curveId]);
    } else if (poolResult || Number(gradTarget ?? 0) === 0) {
      // Only mark done once a pool actually exists (or the target is a deliberate
      // testnet skip, e.g. Cetus/mainnet-only which returns null by design).
      await pool.query(`UPDATE curves SET graduated = true WHERE curve_id = $1`, [curveId]);
      console.log(`  [auto-grad] ✓ ${curveData.name ?? curveId} fully graduated`);
    } else {
      // Graduated-but-poolless (transient failure) stays eligible for retry.
      console.warn(`  [auto-grad] ⚠ ${curveData.name ?? curveId} graduated but no pool yet — will retry`);
    }
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
          const obj = await graphqlClient.getObject({ objectId: row.curve_id });
          const fields = obj?.object?.asMoveObject?.contents?.fields;
          if (!fields) continue;

          const isGraduated = fields.graduated === true;
          const poolCreated = hasPool(fields);

          // Trigger: the curve has GRADUATED (inline inside buy() at the dynamic
          // ~12305 SUI threshold, or via permissionless graduate()) but has NO DEX
          // pool yet. Driven off (graduated && !pool_id) — NOT off a static SUI
          // reserve threshold, which is dead for V9+ inline graduation.
          if (isGraduated && !poolCreated) {
            graduateCurve(grpcClient, row.curve_id, {
              ...row,
              token_type:        row.token_type        || fields.token_type,
              graduation_target: row.graduation_target ?? fields.graduation_target ?? 0,
            }).catch(err =>
              console.error(`  [auto-grad] graduateCurve error:`, err.message)
            );
          } else if (isGraduated && poolCreated) {
            // Already graduated with a pool on-chain — keep DB bookkeeping in sync.
            await pool.query(`UPDATE curves SET graduated = true WHERE curve_id = $1`, [row.curve_id]);
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
