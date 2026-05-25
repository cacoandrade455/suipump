// useTradeKey.js
// Manages a user's trading private key for autonomous strategy execution.
//
// Security model:
// - Key is encrypted with AES-256-GCM using the user's Slush wallet signature
//   as the encryption key. We never see the raw private key.
// - Encrypted key lives in localStorage ONLY — never sent to any server.
// - To decrypt: ask Slush to sign the same message again → derive key → decrypt.
//
// The keypair is stored in a ref so it survives re-renders and is only
// cleared when the wallet address actually changes to a different address.

import { useState, useCallback, useEffect, useRef } from 'react';
import { useSignPersonalMessage, useCurrentAccount } from '@mysten/dapp-kit';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';

const SIGN_MESSAGE = 'Authorize SuiPump trading strategies v1';
const STORAGE_KEY  = (address) => `suipump_tradekey_${address}`;

// ── Crypto helpers ────────────────────────────────────────────────────────────

async function deriveKeyFromSignature(signatureBytes) {
  const rawKey = signatureBytes.slice(0, 32);
  return crypto.subtle.importKey('raw', rawKey, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

async function encryptPrivateKey(privateKeyHex, signatureBytes) {
  const key = await deriveKeyFromSignature(signatureBytes);
  const iv  = crypto.getRandomValues(new Uint8Array(12));
  const enc = new TextEncoder();
  const ct  = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(privateKeyHex));
  const ivHex = Array.from(iv).map(b => b.toString(16).padStart(2, '0')).join('');
  const ctHex = Array.from(new Uint8Array(ct)).map(b => b.toString(16).padStart(2, '0')).join('');
  return `${ivHex}:${ctHex}`;
}

async function decryptPrivateKey(encrypted, signatureBytes) {
  const [ivHex, ctHex] = encrypted.split(':');
  const iv  = new Uint8Array(ivHex.match(/.{2}/g).map(b => parseInt(b, 16)));
  const ct  = new Uint8Array(ctHex.match(/.{2}/g).map(b => parseInt(b, 16)));
  const key = await deriveKeyFromSignature(signatureBytes);
  const dec = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
  return new TextDecoder().decode(dec);
}

function textToBytes(text) {
  return new TextEncoder().encode(text);
}

function buildKeypair(privateKeyHex) {
  if (privateKeyHex.startsWith('suiprivkey')) {
    return Ed25519Keypair.fromSecretKey(privateKeyHex);
  }
  const raw = privateKeyHex.startsWith('0x') ? privateKeyHex.slice(2) : privateKeyHex;
  return Ed25519Keypair.fromSecretKey(Uint8Array.from(raw.match(/.{2}/g).map(b => parseInt(b, 16))));
}

// ── Main hook ─────────────────────────────────────────────────────────────────

export function useTradeKey() {
  const account = useCurrentAccount();
  const { mutateAsync: signMessage } = useSignPersonalMessage();

  // keypair lives in a ref — immune to re-renders, only reset on wallet change
  const keypairRef   = useRef(null);
  const prevAddr     = useRef(null);

  const [hasKey,  setHasKey]  = useState(false);
  const [status,  setStatus]  = useState('idle');
  const [error,   setError]   = useState(null);
  // Trigger re-renders when keypair changes
  const [, forceUpdate]       = useState(0);

  // Only reset keypair when wallet address actually changes to a different one
  useEffect(() => {
    const addr = account?.address ?? null;
    if (addr === prevAddr.current) return; // same address — don't reset
    prevAddr.current = addr;

    if (!addr) {
      setHasKey(false);
      keypairRef.current = null;
      setStatus('idle');
      forceUpdate(n => n + 1);
      return;
    }

    const stored = localStorage.getItem(STORAGE_KEY(addr));
    setHasKey(!!stored);
    // Only clear keypair if we're switching to a DIFFERENT address
    // (not on re-renders with same address)
    keypairRef.current = null;
    setStatus('idle');
    forceUpdate(n => n + 1);
  }, [account?.address]);

  // ── Save ──────────────────────────────────────────────────────────────────
  const saveKey = useCallback(async (privateKeyInput) => {
    if (!account?.address) throw new Error('Wallet not connected');
    setStatus('signing'); setError(null);
    try {
      const result = await signMessage({ message: textToBytes(SIGN_MESSAGE), account });
      const sigBytes = result.signature
        ? Uint8Array.from(atob(result.signature), c => c.charCodeAt(0))
        : new Uint8Array(result.bytes ?? []);

      setStatus('encrypting');

      let kp;
      try { kp = buildKeypair(privateKeyInput.trim()); }
      catch { throw new Error('Invalid private key format. Paste the raw hex key from your wallet.'); }

      const encrypted = await encryptPrivateKey(privateKeyInput.trim(), sigBytes);
      localStorage.setItem(STORAGE_KEY(account.address), encrypted);

      keypairRef.current = kp;
      setHasKey(true);
      setStatus('ready');
      forceUpdate(n => n + 1);
      return kp;
    } catch (e) {
      setError(e.message || 'Failed to save key');
      setStatus('error');
      throw e;
    }
  }, [account, signMessage]);

  // ── Load (decrypt) ────────────────────────────────────────────────────────
  const loadKey = useCallback(async () => {
    if (!account?.address) throw new Error('Wallet not connected');
    const stored = localStorage.getItem(STORAGE_KEY(account.address));
    if (!stored) throw new Error('No trading key saved');

    setStatus('signing'); setError(null);
    try {
      const result = await signMessage({ message: textToBytes(SIGN_MESSAGE), account });
      const sigBytes = result.signature
        ? Uint8Array.from(atob(result.signature), c => c.charCodeAt(0))
        : new Uint8Array(result.bytes ?? []);

      setStatus('decrypting');

      const privateKeyHex = await decryptPrivateKey(stored, sigBytes);
      const kp = buildKeypair(privateKeyHex);

      keypairRef.current = kp;
      setStatus('ready');
      forceUpdate(n => n + 1);
      return kp;
    } catch (e) {
      setError(e.message || 'Failed to decrypt key');
      setStatus('error');
      throw e;
    }
  }, [account, signMessage]);

  // ── Remove ────────────────────────────────────────────────────────────────
  const removeKey = useCallback(() => {
    if (!account?.address) return;
    localStorage.removeItem(STORAGE_KEY(account.address));
    setHasKey(false);
    keypairRef.current = null;
    setStatus('idle');
    setError(null);
    forceUpdate(n => n + 1);
  }, [account?.address]);

  const keypair = keypairRef.current;

  return {
    hasKey,
    keypair,
    status,
    error,
    saveKey,
    loadKey,
    removeKey,
    isReady: status === 'ready' && !!keypair,
  };
}
