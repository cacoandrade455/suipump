// turnkey_signer.js -- per-session transaction signing for the bridge.
//
// PURPOSE
// Replaces the single shared env private key (SUI_PRIVATE_KEY) as the signer of
// session trades with a per-session key held inside Turnkey's secure enclaves.
// The private key is generated and used INSIDE the enclave and is never exposed
// to this process, to Render, or to anyone operating the box -- so compromising
// the bridge host no longer means compromising the signing key. On-chain, the
// AgentSession's spend_cap / expiry / revoke still bound what any signature can
// do; this module only changes WHO holds the key, not the trade limits.
//
// This is Phase 1 of the trust-minimization plan. Phase 2 (Nautilus attestation
// bound into the session contract, so the chain itself verifies the signer is
// enclave-held) is a separate V11 item and is NOT implemented here.
//
// DESIGN
// - Self-contained, imported by bridge.js. No change to how transactions are
//   BUILT -- only how they are SIGNED and EXECUTED.
// - Fallback-safe: if a session has no Turnkey key mapped (e.g. sessions opened
//   before this rolled out, or Turnkey env not configured), it falls back to the
//   local env keypair via the caller-provided loadKeypair, so nothing breaks
//   mid-migration. The fallback is logged (without key material) so operators
//   can see which path was taken.
//
// SUI SIGNING DETAIL (matches Turnkey's official Sui example)
// Sui verifies a signature over blake2b-256(intent_message_bytes), where the
// intent message is 3 intent bytes || bcs(TransactionData). The serialized
// signature Sui expects is: flag(1) || signature(64) || pubkey(32), base64.
// For Ed25519 the flag byte is 0x00. We build the tx to bytes, hash, ask
// Turnkey to sign the 32-byte digest, then hand Sui { bytes, signature }.
//
// ENV
//   TURNKEY_API_BASE_URL       default https://api.turnkey.com
//   TURNKEY_API_PUBLIC_KEY     API key stamper public key (P-256)
//   TURNKEY_API_PRIVATE_KEY    API key stamper private key (P-256)  [secret]
//   TURNKEY_ORGANIZATION_ID    the sub-org / org id that owns the wallets
// Per-session mapping (sessionId -> { signWith, publicKeyHex }) is supplied by
// the caller via a lookup function, so this module stays storage-agnostic.

import { Turnkey } from '@turnkey/sdk-server';
import { Ed25519PublicKey } from '@mysten/sui/keypairs/ed25519';
import { messageWithIntent } from '@mysten/sui/cryptography';
import { blake2b } from '@noble/hashes/blake2b';
import { toBase64, fromHex } from '@mysten/sui/utils';

// ---- Turnkey client (lazy singleton) ---------------------------------------

let _tk = null;
function turnkeyConfigured() {
  return !!(process.env.TURNKEY_API_PUBLIC_KEY
    && process.env.TURNKEY_API_PRIVATE_KEY
    && process.env.TURNKEY_ORGANIZATION_ID);
}
function getTurnkey() {
  if (_tk) return _tk;
  if (!turnkeyConfigured()) return null;
  _tk = new Turnkey({
    apiBaseUrl: process.env.TURNKEY_API_BASE_URL ?? 'https://api.turnkey.com',
    apiPublicKey: process.env.TURNKEY_API_PUBLIC_KEY,
    apiPrivateKey: process.env.TURNKEY_API_PRIVATE_KEY,
    defaultOrganizationId: process.env.TURNKEY_ORGANIZATION_ID,
  }).apiClient();
  return _tk;
}

// Serialize a raw 64-byte Ed25519 signature + public key into Sui's
// flag || sig || pk base64 form. Mirrors Turnkey's documented Sui helper.
function toSerializedSignature(rawSig64, pubKey) {
  const flag = new Uint8Array([0x00]); // Ed25519
  const pk = pubKey.toRawBytes();
  const out = new Uint8Array(flag.length + rawSig64.length + pk.length);
  out.set(flag, 0);
  out.set(rawSig64, flag.length);
  out.set(pk, flag.length + rawSig64.length);
  return toBase64(out);
}

// ---- Public API -------------------------------------------------------------

// signAndExecute: build-to-bytes, sign (Turnkey or local), execute.
//
// Params:
//   client         the bridge's SuiGraphQLClient (has .executeTransaction)
//   transaction    a @mysten/sui Transaction (already fully built, sender set)
//   sessionKey     { signWith, publicKeyHex } | null  -- Turnkey key for this
//                  session; null => use the local fallback keypair
//   fallbackKeypair an Ed25519Keypair (from the bridge's loadKeypair) used only
//                  when sessionKey is null or Turnkey is not configured
//   include        execute options (e.g. { balanceChanges: true })
//
// Returns the same result shape as client.signAndExecuteTransaction so the
// bridge's existing txOk / txDigestOf helpers keep working unchanged.
export async function signAndExecute({ client, transaction, sessionKey, fallbackKeypair, include }) {
  const tk = getTurnkey();

  // Fallback path: no per-session Turnkey key, or Turnkey not configured.
  // Identical behavior to the pre-Turnkey bridge -- local keypair signs.
  if (!tk || !sessionKey?.signWith || !sessionKey?.publicKeyHex) {
    if (!fallbackKeypair) {
      throw new Error('No Turnkey session key and no fallback keypair available to sign');
    }
    console.log(`[turnkey] signing via LOCAL fallback keypair${tk ? ' (no session key mapped)' : ' (Turnkey not configured)'}`);
    return await client.signAndExecuteTransaction({
      signer: fallbackKeypair, transaction, include,
    });
  }

  // Turnkey path: sign the intent digest inside the enclave.
  // 1. Build the transaction to canonical bytes against this client.
  const txBytes = await transaction.build({ client });

  // 2. Sui signs blake2b-256 over the intent message (intent || bcs(txData)).
  const intentMessage = messageWithIntent('TransactionData', txBytes);
  const digest = blake2b(intentMessage, { dkLen: 32 });

  // 3. Ask Turnkey to sign the 32-byte digest with the session's key. The
  //    private key never leaves the enclave. HASH_FUNCTION_NOT_APPLICABLE
  //    because we pre-hashed (Sui's external blake2b), exactly as Sui requires.
  const { r, s } = await tk.signRawPayload({
    signWith: sessionKey.signWith,
    payload: bytesToHex(digest),
    encoding: 'PAYLOAD_ENCODING_HEXADECIMAL',
    hashFunction: 'HASH_FUNCTION_NOT_APPLICABLE',
  });

  // 4. Ed25519 raw signature is r||s => 64 bytes.
  //    Turnkey's signRawPayload returns { r, s, v } -- fields named for ECDSA,
  //    but for an Ed25519 key r = first 32 bytes (R point), s = second 32 bytes
  //    (S scalar), and v is unused. Concatenating r||s yields the correct 64-byte
  //    Ed25519 signature. padStart guards a component returned with a stripped
  //    leading zero. The local verify in step 5 is the real safety net: if this
  //    reconstruction were ever wrong, it fails loud before broadcast. Do NOT
  //    treat this as ECDSA (no DER, no recovery id).
  const rawSig = new Uint8Array(64);
  rawSig.set(fromHex(r.padStart(64, '0')), 0);
  rawSig.set(fromHex(s.padStart(64, '0')), 32);

  const pubKey = new Ed25519PublicKey(fromHex(sessionKey.publicKeyHex));
  const serializedSignature = toSerializedSignature(rawSig, pubKey);

  // 5. Sanity: the signature must verify against the pubkey for this digest
  //    BEFORE we broadcast, so a malformed enclave response fails loud here
  //    rather than as an opaque on-chain rejection that still burned gas.
  const ok = await pubKey.verify(digest, rawSig).catch(() => false);
  if (!ok) {
    throw new Error('Turnkey signature failed local verification against session pubkey; refusing to broadcast');
  }

  console.log(`[turnkey] signing via enclave key ${sessionKey.signWith.slice(0, 10)}...`);

  // 6. Execute with the externally-produced signature.
  //    NOTE: SuiGraphQLClient.executeTransaction expects `signatures: string[]`
  //    (plural, array) per @mysten/sui ExecuteTransactionOptions -- NOT a
  //    singular `signature`. Passing the singular field silently leaves
  //    `signatures` undefined and the call fails. Verified against the installed
  //    type definition, do not "simplify" back to a singular string.
  return await client.executeTransaction({
    transaction: txBytes,
    signatures: [serializedSignature],
    include,
  });
}

// Derive the Sui address for a Turnkey-held public key, so the caller can name
// it as session_address when opening a session. Pure/local -- no network call.
export function suiAddressForPublicKeyHex(publicKeyHex) {
  const pk = new Ed25519PublicKey(fromHex(publicKeyHex));
  return pk.toSuiAddress();
}

// Small hex helper (avoid pulling another dep just for this).
function bytesToHex(bytes) {
  let h = '';
  for (const b of bytes) h += b.toString(16).padStart(2, '0');
  return h;
}
