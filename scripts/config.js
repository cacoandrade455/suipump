// scripts/config.js — Shared deployment info + helpers.
// V9 active package (fill in PACKAGE_ID after upgrade deploy)

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fromB64, fromBase64 } from '@mysten/sui/utils';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { SuiClient, getFullnodeUrl } from '@mysten/sui/client';

// ── V8 (active until V9 upgrade) ─────────────────────────────────────────────
export const PACKAGE_ID   = '0xbb4ee050239f59dfd983501ce101698ba27857f77aff2d437cec568fe0062546';
export const ADMIN_CAP_ID = '0x9779a2466f2e30ca5e139f636cc9ca1c44e025da29203d781cc2645ebb62bb35';
export const CURVE_ID     = '0xf7c137e90c5a5c9e716c91fdd3561d55e6ba3c11c37a9741b0bfde03dc9d812f';
export const TOKEN_TYPE   = `${PACKAGE_ID}::token_template::TOKEN_TEMPLATE`;

export const client = new SuiClient({
  url: process.env.SUI_RPC_URL || getFullnodeUrl('testnet'),
});

/**
 * Load keypair — respects SUI_PRIVATE_KEY env var when set.
 * Falls back to ~/.sui/sui_config/sui.keystore for local dev.
 *
 * SUI_PRIVATE_KEY format: base64WithFlag (33 bytes: 1 flag + 32 seed)
 * or raw base64 seed (32 bytes). Both are handled.
 */
export function loadKeypair() {
  if (process.env.SUI_PRIVATE_KEY) {
    const raw  = fromBase64(process.env.SUI_PRIVATE_KEY);
    const seed = (raw.length === 33 || raw.length === 65) ? raw.slice(1) : raw;
    return Ed25519Keypair.fromSecretKey(seed);
  }

  // Fallback: local keystore
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
