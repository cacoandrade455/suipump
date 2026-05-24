// useTradeKey.js
// Manages a user's trading private key for autonomous strategy execution.
//
// Security model:
// - Key is encrypted with AES-256-GCM using the user's Slush wallet signature
//   as the encryption key. We never see the raw private key.
// - Encrypted key lives in localStorage ONLY — never sent to any server.
// - To decrypt: ask Slush to sign the same message again → derive key → decrypt.
// - If user clears localStorage they re-paste their key. Acceptable tradeoff.
//
// The signing message is deterministic so the same wallet always produces
// the same encryption key.

import { useState, useCallback, useEffect } from 'react';
import { useSignPersonalMessage, useCurrentAccount } from '@mysten/dapp-kit';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';

const SIGN_MESSAGE = 'Authorize SuiPump trading strategies v1';
const STORAGE_KEY  = (address) => `suipump_tradekey_${address}`;

// ── Crypto helpers (Web Crypto API — available in all modern browsers) ────────

async function deriveKeyFromSignature(signatureBytes) {
  // Use the first 32 bytes of the signature as raw key material
  const rawKey = signatureBytes.slice(0, 32);
  return crypto.subtle.importKey(
    'raw', rawKey,
    { name: 'AES-GCM' },
    false,
    ['encrypt', 'decrypt']
  );
}

async function encryptPrivateKey(privateKeyHex, signatureBytes) {
  const key = await deriveKeyFromSignature(signatureBytes);
  const iv  = crypto.getRandomValues(new Uint8Array(12));
  const enc = new TextEncoder();
  const ct  = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    enc.encode(privateKeyHex)
  );
  // Store iv + ciphertext as hex
  const ivHex = Array.from(iv).map(b => b.toString(16).padStart(2, '0')).join('');
  const ctHex = Array.from(new Uint8Array(ct)).map(b => b.toString(16).padStart(2, '0')).join('');
  return `${ivHex}:${ctHex}`;
}

async function decryptPrivateKey(encrypted, signatureBytes) {
  const [ivHex, ctHex] = encrypted.split(':');
  const iv = new Uint8Array(ivHex.match(/.{2}/g).map(b => parseInt(b, 16)));
  const ct = new Uint8Array(ctHex.match(/.{2}/g).map(b => parseInt(b, 16)));
  const key = await deriveKeyFromSignature(signatureBytes);
  const dec = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
  return new TextDecoder().decode(dec);
}

// ── Signature helper ──────────────────────────────────────────────────────────

function textToBytes(text) {
  return new TextEncoder().encode(text);
}

// ── Main hook ─────────────────────────────────────────────────────────────────

export function useTradeKey() {
  const account = useCurrentAccount();
  const { mutateAsync: signMessage } = useSignPersonalMessage();

  const [hasKey, setHasKey]       = useState(false);
  const [keypair, setKeypair]     = useState(null); // Ed25519Keypair | null
  const [status, setStatus]       = useState('idle'); // 'idle'|'signing'|'encrypting'|'decrypting'|'ready'|'error'
  const [error, setError]         = useState(null);

  // Check on mount if there's an encrypted key for this wallet
  useEffect(() => {
    if (!account?.address) { setHasKey(false); setKeypair(null); return; }
    const stored = localStorage.getItem(STORAGE_KEY(account.address));
    setHasKey(!!stored);
    setKeypair(null); // always require fresh decrypt on load
    setStatus('idle');
  }, [account?.address]);

  // ── Save (encrypt + store) ────────────────────────────────────────────────
  const saveKey = useCallback(async (privateKeyInput) => {
    if (!account?.address) throw new Error('Wallet not connected');
    setStatus('signing'); setError(null);

    try {
      // 1. Get signature from Slush
      const result = await signMessage({
        message: textToBytes(SIGN_MESSAGE),
        account,
      });
      const sigBytes = result.signature
        ? Uint8Array.from(atob(result.signature), c => c.charCodeAt(0))
        : new Uint8Array(result.bytes ?? []);

      setStatus('encrypting');

      // 2. Normalize private key input — accept hex or bech32
      let normalizedHex = privateKeyInput.trim();
      // Try to validate by building a keypair
      let kp;
      try {
        if (normalizedHex.startsWith('suiprivkey')) {
          kp = Ed25519Keypair.fromSecretKey(normalizedHex);
        } else {
          const raw = normalizedHex.startsWith('0x') ? normalizedHex.slice(2) : normalizedHex;
          kp = Ed25519Keypair.fromSecretKey(Uint8Array.from(raw.match(/.{2}/g).map(b => parseInt(b, 16))));
        }
      } catch {
        throw new Error('Invalid private key format. Paste the raw hex key from your wallet.');
      }

      // 3. Encrypt
      const encrypted = await encryptPrivateKey(normalizedHex, sigBytes);
      localStorage.setItem(STORAGE_KEY(account.address), encrypted);

      setKeypair(kp);
      setHasKey(true);
      setStatus('ready');
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
      // 1. Get signature from Slush (same message = same key)
      const result = await signMessage({
        message: textToBytes(SIGN_MESSAGE),
        account,
      });
      const sigBytes = result.signature
        ? Uint8Array.from(atob(result.signature), c => c.charCodeAt(0))
        : new Uint8Array(result.bytes ?? []);

      setStatus('decrypting');

      // 2. Decrypt
      const privateKeyHex = await decryptPrivateKey(stored, sigBytes);

      // 3. Build keypair
      const raw = privateKeyHex.startsWith('0x') ? privateKeyHex.slice(2) : privateKeyHex;
      let kp;
      if (privateKeyHex.startsWith('suiprivkey')) {
        kp = Ed25519Keypair.fromSecretKey(privateKeyHex);
      } else {
        kp = Ed25519Keypair.fromSecretKey(Uint8Array.from(raw.match(/.{2}/g).map(b => parseInt(b, 16))));
      }

      setKeypair(kp);
      setStatus('ready');
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
    setKeypair(null);
    setStatus('idle');
    setError(null);
  }, [account?.address]);

  return {
    hasKey,       // boolean — encrypted key exists in localStorage
    keypair,      // Ed25519Keypair | null — only set after loadKey()
    status,       // 'idle'|'signing'|'encrypting'|'decrypting'|'ready'|'error'
    error,
    saveKey,      // (privateKeyInput: string) => Promise<keypair>
    loadKey,      // () => Promise<keypair>
    removeKey,    // () => void
    isReady: status === 'ready' && !!keypair,
  };
}
