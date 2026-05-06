// Shared deployment info + helpers.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fromB64 } from '@mysten/sui/utils';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { SuiClient, getFullnodeUrl } from '@mysten/sui/client';

export const PACKAGE_ID  = '0x2154486dcf503bd3e8feae4fb913e862f7e2bbf4489769aff63978f55d55b4a8';
export const ADMIN_CAP_ID = '0xfc80d407147af9445d7042a6a538524b5a483cc995fdbf0c795ce7eab506b6f9';
export const CURVE_ID    = '0xf7c137e90c5a5c9e716c91fdd3561d55e6ba3c11c37a9741b0bfde03dc9d812f';
export const TOKEN_TYPE  = `${PACKAGE_ID}::token_template::TOKEN_TEMPLATE`;

export const client = new SuiClient({ url: getFullnodeUrl('testnet') });

export function loadKeypair() {
  const keystorePath = join(homedir(), '.sui', 'sui_config', 'sui.keystore');
  const keys = JSON.parse(readFileSync(keystorePath, 'utf-8'));
  if (keys.length === 0) throw new Error('No keys in keystore');
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
