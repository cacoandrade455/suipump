// config.js - graduation-test-turbos
// Ported to SuiGraphQLClient (mirrors graduation-test/config.js): the Sui
// Foundation public testnet JSON-RPC fullnode shut off the week of
// 2026-07-06, so new SuiClient({ url: getFullnodeUrl('testnet') }) is dead.
// The turbos-clmm-sdk itself still needs a v1 JSON-RPC SuiClient - that is
// constructed in graduate_turbos_full.js from an env-provided third-party
// endpoint, never from a public fullnode default.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fromB64 } from '@mysten/sui/utils';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { SuiGraphQLClient } from '@mysten/sui/graphql';

export const TEST_PACKAGE_ID   = '0xe3082c6b1162759098906327d201aeec4773d4fc10cdef68860bd2939860a7f7';
export const TEST_ADMIN_CAP_ID = '0x53a8dade04a74da53a9ba9cfc1230b57e531818bd4f6befae76a1bec294f156e';

export const client = new SuiGraphQLClient({
  url: process.env.SUI_GRAPHQL_URL || 'https://graphql.testnet.sui.io/graphql',
});

export function loadKeypair() {
  const keystorePath = join(homedir(), '.sui', 'sui_config', 'sui.keystore');
  const keys = JSON.parse(readFileSync(keystorePath, 'utf-8'));
  if (keys.length === 0) throw new Error('No keys in keystore');
  const raw = fromB64(keys[0]);
  if (raw[0] !== 0x00) throw new Error(`Unexpected key flag: ${raw[0]}`);
  return Ed25519Keypair.fromSecretKey(raw.slice(1));
}

export function fmtSui(mist) {
  return (Number(mist) / 1e9).toFixed(6) + ' SUI';
}
