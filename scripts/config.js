// Shared deployment info + helpers.
// Your wallet's private key is loaded from ~/.sui/sui_config/sui.keystore by the CLI,
// and we reuse the same keystore so you don't paste keys into code.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fromB64 } from '@mysten/sui/utils';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { SuiClient, getFullnodeUrl } from '@mysten/sui/client';

export const PACKAGE_ID  = '0xf91acdd7456381110d6a15d380dfd99fc126e59ffbf7a818c118e53765fa54c5';
export const ADMIN_CAP_ID = '0xc48452ed7e3c0a7bd0fb3e66ba37f15ccb6a9d090a87f7b53a451e3716ddeb6d';
export const CURVE_ID    = '0xdd84ca597b0f6ecdddc3909465353c6786320b20a99416d92a6709f444e089fc';
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
