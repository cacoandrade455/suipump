// register_enclave.js -- Nautilus Phase 2 chain registration (SDK v2).
//
// Two modes:
//
//   1) create-registry  (AdminCap-gated; run once)
//      PRIVATE_KEY=suiprivkey1... ADMIN_CAP=0x... \
//      PCR0=<96-hex> PCR1=<96-hex> PCR2=<96-hex> \
//        node register_enclave.js create-registry
//      -> prints the new REGISTRY_ID
//
//   2) register  (permissionless; needs the live enclave reachable)
//      PRIVATE_KEY=suiprivkey1... REGISTRY_ID=0x... ENCLAVE_URL=http://localhost:7746 \
//        node register_enclave.js register
//      -> fetches the live attestation, composes the two-command PTB
//         (0x2::nitro_attestation::load_nitro_attestation -> register_enclave_key),
//         prints the approved session_address
//
// Env:
//   PRIVATE_KEY  required; suiprivkey1... bech32 (Ed25519)
//   PACKAGE_ID   optional; defaults to the V12 package below
//   RPC_URL      optional; defaults to the testnet GraphQL endpoint
//
// SDK note: written for @mysten/sui v2 (SuiGraphQLClient). The JSON-RPC
// SuiClient was removed from the SDK ahead of the Jul 31 2026 shutdown.

import { SuiGraphQLClient } from '@mysten/sui/graphql';
import { Transaction } from '@mysten/sui/transactions';
import { Ed25519Keypair, Ed25519PublicKey } from '@mysten/sui/keypairs/ed25519';

const PACKAGE_ID = process.env.PACKAGE_ID
  ?? '0xf5a3566ba920a3e3614e8b25da0ca3237879b6e22eb12f21ccf2bceb6520b9cd';

const CLOCK_ID = '0x6';
const GAS_BUDGET = 100_000_000; // 0.1 SUI

function signer() {
  const pk = process.env.PRIVATE_KEY;
  if (!pk) throw new Error('PRIVATE_KEY required (suiprivkey1... bech32)');
  return Ed25519Keypair.fromSecretKey(pk);
}

function client() {
  return new SuiGraphQLClient({
    url: process.env.RPC_URL ?? 'https://sui-testnet.mystenlabs.com/graphql',
  });
}

function hexBytes(value, name) {
  if (!value) throw new Error(`${name} required (hex string)`);
  const hex = value.startsWith('0x') ? value.slice(2) : value;
  if (hex.length % 2 !== 0 || /[^0-9a-fA-F]/.test(hex)) {
    throw new Error(`${name} is not valid hex`);
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function unwrap(result) {
  if (result.$kind === 'Transaction') return result.Transaction;
  const failed = result.FailedTransaction;
  const reason = failed?.status?.error
    ? JSON.stringify(failed.status.error)
    : '(no error detail)';
  throw new Error(`transaction failed: ${reason} digest=${failed?.digest ?? '?'}`);
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`);
  return res.json();
}

async function createRegistry() {
  const adminCap = process.env.ADMIN_CAP;
  if (!adminCap) throw new Error('ADMIN_CAP required');
  const pcr0 = hexBytes(process.env.PCR0, 'PCR0');
  const pcr1 = hexBytes(process.env.PCR1, 'PCR1');
  const pcr2 = hexBytes(process.env.PCR2, 'PCR2');

  const tx = new Transaction();
  tx.moveCall({
    target: `${PACKAGE_ID}::enclave_registry::create_registry`,
    arguments: [
      tx.object(adminCap),
      tx.pure.vector('u8', Array.from(pcr0)),
      tx.pure.vector('u8', Array.from(pcr1)),
      tx.pure.vector('u8', Array.from(pcr2)),
    ],
  });
  tx.setGasBudget(GAS_BUDGET);

  const result = unwrap(await client().signAndExecuteTransaction({
    transaction: tx,
    signer: signer(),
    include: { effects: true, events: true },
  }));

  console.log('digest:', result.digest);

  const created = (result.effects?.changedObjects ?? [])
    .filter((c) => c.idOperation === 'Created');
  if (created.length === 1) {
    console.log('REGISTRY_ID:', created[0].objectId);
  } else if (created.length > 1) {
    console.log('multiple created objects (registry is the shared one):');
    for (const c of created) console.log(' -', c.objectId, JSON.stringify(c.outputOwner));
  } else {
    // Fallback: RegistryCreated event carries registry_id.
    const evt = (result.events ?? []).find((e) =>
      e.eventType?.endsWith('::enclave_registry::RegistryCreated'));
    console.log('REGISTRY_ID:', evt?.json?.registry_id ?? '(not found - check output)');
  }
}

async function register() {
  const registryId = process.env.REGISTRY_ID;
  if (!registryId) throw new Error('REGISTRY_ID required (from create-registry)');
  const enclaveUrl = (process.env.ENCLAVE_URL ?? '').replace(/\/+$/, '');
  if (!enclaveUrl) throw new Error('ENCLAVE_URL required (e.g. http://localhost:7746)');

  const { public_key: pubHex } = await fetchJson(`${enclaveUrl}/public_key`);
  if (!pubHex) throw new Error('enclave /public_key returned no public_key');
  const derived = new Ed25519PublicKey(hexBytes(pubHex, 'public_key')).toSuiAddress();
  console.log('enclave public_key:', pubHex);
  console.log('derived session_address (local):', derived);

  const { attestation } = await fetchJson(`${enclaveUrl}/attestation`);
  if (!attestation) throw new Error('enclave /attestation returned no attestation');
  const attBytes = hexBytes(attestation, 'attestation');
  console.log(`attestation fetched (${attBytes.length} bytes)`);

  const tx = new Transaction();
  const doc = tx.moveCall({
    target: '0x2::nitro_attestation::load_nitro_attestation',
    arguments: [
      tx.pure.vector('u8', Array.from(attBytes)),
      tx.object(CLOCK_ID),
    ],
  });
  tx.moveCall({
    target: `${PACKAGE_ID}::enclave_registry::register_enclave_key`,
    arguments: [tx.object(registryId), doc],
  });
  tx.setGasBudget(GAS_BUDGET);

  const result = unwrap(await client().signAndExecuteTransaction({
    transaction: tx,
    signer: signer(),
    include: { effects: true, events: true },
  }));

  console.log('digest:', result.digest);

  const evt = (result.events ?? []).find((e) =>
    e.eventType?.endsWith('::enclave_registry::EnclaveKeyRegistered'));
  const onchain = evt?.json?.session_address;
  console.log('session_address (on-chain event):', onchain ?? '(event not found)');
  if (onchain && onchain !== derived) {
    console.log('WARNING: on-chain address differs from locally derived address');
  }
}

const mode = process.argv[2];
const run = mode === 'create-registry' ? createRegistry
  : mode === 'register' ? register
  : null;

if (!run) {
  console.log('usage: node register_enclave.js <create-registry|register>');
  process.exit(2);
}

run().catch((err) => {
  console.error('ERROR:', err.message ?? err);
  process.exit(1);
});
