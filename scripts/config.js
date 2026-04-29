// Shared deployment info + helpers.
// Your wallet's private key is loaded from ~/.sui/sui_config/sui.keystore by the CLI,
// and we reuse the same keystore so you don't paste keys into code.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fromB64 } from '@mysten/sui/utils';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { SuiClient, getFullnodeUrl } from '@mysten/sui/client';

export const PACKAGE_ID = '0x22839b3e46129a42ebc2518013105bbf91f435e6664640cb922815659985d349';
export const ADMIN_CAP_ID = '0x42e4c2b399cd09eec1248551fb6e762c1a06444093c061eef452f5bef6ffc340';
export const CURVE_ID = '0xe69a7df93bc69c0273f33de152fe6c517ad6ed5ebef8199898d20037a9d258f9';
export const TOKEN_TYPE = `${PACKAGE_ID}::token_template::TOKEN_TEMPLATE`;

export const client = new SuiClient({ url: getFullnodeUrl('testnet') });

export function loadKeypair() {
  // The Sui CLI stores keys as base64-encoded flag+seed pairs in this file.
  // First byte is the scheme flag (0x00 = ed25519), next 32 are the seed.
  const keystorePath = join(homedir(), '.sui', 'sui_config', 'sui.keystore');
  const keys = JSON.parse(readFileSync(keystorePath, 'utf-8'));
  if (keys.length === 0) throw new Error('No keys in keystore');

  // Just use the first key for now; matches the active address from `sui client active-address`.
  const raw = fromB64(keys[0]);
  if (raw[0] !== 0x00) {
    throw new Error(`Unexpected key scheme flag: ${raw[0]}. Expected ed25519 (0x00).`);
  }
  const seed = raw.slice(1);
  return Ed25519Keypair.fromSecretKey(seed);
}

export function fmtSui(mist) {
  return (Number(mist) / 1e9).toFixed(6) + ' SUI';
}

export function fmtTokens(amount, decimals = 6) {
  return (Number(amount) / 10 ** decimals).toLocaleString(undefined, { maximumFractionDigits: 2 });
}
