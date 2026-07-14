// src/authSign.js - client half of the wallet-signed ownership proof for the
// money-mover API routes (create-order, cancel-order, sweep-session-gas,
// agent-bridge /session-sell, agent-claim-all).
//
// Builds the SAME canonical message the server rebuilds from the request
// body (lib/authCanonical.js is the single shared canonicalization - never
// duplicate it) and signs it as a personal message with the connected
// wallet. The request then carries { signature, ts } alongside its normal
// fields; the server strips those two, re-derives the canonical message from
// the rest, verifies the signature, and compares the recovered signer to the
// owner it derives from its own data. Never import lib/verifyOwner.js here -
// that file is server trust logic.

import { dAppKit } from './dapp-kit.js';
import { canonicalAuthMessage } from '../lib/authCanonical.js';

// Sign `fields` (the exact object about to be sent, WITHOUT signature/ts)
// for `route`. Returns { signature, ts } to spread into the request body.
// Throws if the wallet declines or returns nothing - callers treat that as
// the action being cancelled.
export async function signOwnerAuth(route, fields) {
  const ts = Date.now();
  const message = canonicalAuthMessage(route, ts, fields);
  const result = await dAppKit.signPersonalMessage({
    message: new TextEncoder().encode(message),
  });
  if (!result?.signature) throw new Error('wallet did not return a signature');
  return { signature: result.signature, ts };
}
