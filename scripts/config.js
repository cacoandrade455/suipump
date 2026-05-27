// scripts/config.js — Shared deployment info + helpers.
// V9 active package (fill in PACKAGE_ID after upgrade deploy)

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fromB64, fromBase64 } from '@mysten/sui/utils';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { SuiGraphQLClient } from '@mysten/sui/graphql';

// ── V9 (active) ──────────────────────────────────────────────────────────────
export const PACKAGE_ID   = '0x719698e5138582d78ee95317271e8bce05769569a4f58c940a7f1b424d90ffe2';
export const ADMIN_CAP_ID = '0x2e0989604424ffa96f58618795285dac09d8eaf2fd0d35f4a7e9bbc22bea2bf7';
export const CURVE_ID     = '0xf7c137e90c5a5c9e716c91fdd3561d55e6ba3c11c37a9741b0bfde03dc9d812f';
export const TOKEN_TYPE   = `${PACKAGE_ID}::token_template::TOKEN_TEMPLATE`;

export const client = new SuiGraphQLClient({
  url: process.env.SUI_GRAPHQL_URL || 'https://graphql.testnet.sui.io/graphql',
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
