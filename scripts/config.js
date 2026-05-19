// config.js — Shared deployment info + helpers.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fromB64 } from '@mysten/sui/utils';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { SuiClient, getFullnodeUrl } from '@mysten/sui/client';

// ── V8 (active) ───────────────────────────────────────────────────────────────
export const PACKAGE_ID   = '0xbb4ee050239f59dfd983501ce101698ba27857f77aff2d437cec568fe0062546';
export const ADMIN_CAP_ID = '0x9779a2466f2e30ca5e139f636cc9ca1c44e025da29203d781cc2645ebb62bb35';
export const CURVE_ID     = '0xf7c137e90c5a5c9e716c91fdd3561d55e6ba3c11c37a9741b0bfde03dc9d812f';
export const TOKEN_TYPE   = `${PACKAGE_ID}::token_template::TOKEN_TEMPLATE`;

export const client = new SuiClient({ url: getFullnodeUrl('testnet') });

export function loadKeypair() {
  const keystorePath = join(homedir(), '.sui', 'sui_config', 'sui.keystore');
  const keys = JSON.parse(readFileSync(keystorePath, 'utf-8'));
  if (keys.length === 0) throw new Error('No keys in keystore');
  const raw = fromB64(keys[0]);
  if (raw[0] !== 0x00) throw new Error(`Unexpected key scheme flag: ${raw[0]}`);
  return Ed25519Keypair.fromSecretKey(raw.slice(1));
}

export function fmtSui(mist) {
  return (Number(mist) / 1e9).toFixed(6) + ' SUI';
}

export function fmtTokens(amount, decimals = 6) {
  return (Number(amount) / 10 ** decimals).toLocaleString(undefined, { maximumFractionDigits: 2 });
}
