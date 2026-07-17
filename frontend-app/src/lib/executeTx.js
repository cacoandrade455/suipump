// executeTx.js - the ONE wallet-signed transaction execution path.
//
// WHY THIS EXISTS: the dAppKit one-shot sign+execute call is FORBIDDEN
// repo-wide (CLAUDE.md hard rule 1). It makes the Slush wallet build/serialize
// the PTB itself, and the wallet's SuiGrpcClient-backed build chokes on
// shared-object refs and crashes reading 'txSignatures' inside
// dapp-interface.js (proven 2026-07-09). The safe pattern - proven in
// AgentPage's userBuy flow - is:
//   1. build the tx bytes OURSELVES against the /api/rpc GraphQL proxy,
//   2. have the wallet ONLY sign (dAppKit.signTransaction signs already-built
//      bytes, it never builds),
//   3. execute the built bytes + signature through the same client.
//
// ALL wallet-signed tx-execution call sites in frontend-app/src must go
// through this helper - never call the dAppKit one-shot sign+execute method.
// (Server-side keypair signers like turnkey_signer.js are a different path
// and are out of scope here: they sign+execute with their own keypair via the
// Sui client, not dAppKit.)
//
// Returns the RAW executeTransaction result so call sites keep their existing
// handling: the shape is { $kind: 'Transaction', Transaction: { digest, ... } }
// on success or { $kind: 'FailedTransaction', FailedTransaction: { status,
// digest, ... } } on execution failure - the same shape the old dAppKit
// one-shot sign+execute call resolved with.

import { SuiGraphQLClient } from '@mysten/sui/graphql';

// dAppKit: the useDAppKit() instance (signs).
// client:  a SuiGraphQLClient to build/execute against, or null/undefined to
//          construct the standard one on the /api/rpc proxy.
// tx:      the Transaction. The sender MUST be set - either by the caller via
//          tx.setSender(...) beforehand, or by passing `sender` here.
// sender:  optional address; when provided, tx.setSender(sender) is called.
export async function executeTx(dAppKit, client, tx, sender) {
  const execClient = client ?? new SuiGraphQLClient({ url: '/api/rpc' });
  if (sender) tx.setSender(sender);
  const hasSender = typeof tx.getData === 'function' ? Boolean(tx.getData()?.sender) : true;
  if (!hasSender) {
    throw new Error('executeTx: transaction has no sender - pass the connected account address as the 4th argument or call tx.setSender(...) first');
  }
  const built = await tx.build({ client: execClient });
  const { signature } = await dAppKit.signTransaction({ transaction: tx });
  const res = await execClient.executeTransaction({ transaction: built, signatures: [signature] });
  if (res?.errors) throw new Error(Array.isArray(res.errors) ? (res.errors[0]?.message ?? JSON.stringify(res.errors)) : String(res.errors));
  return res;
}
