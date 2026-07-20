// cto_reclaim_sweeper.js - SuiPump V13 Community Takeover (CTO) escrow auto-sweep.
//
// WHAT IT DOES
//   After a TakeoverProposal resolves (succeeded or failed), every voter's
//   escrowed Coin<T> is still parked inside the proposal object until someone
//   calls reclaim_vote to return it. This loop finds resolved proposals and
//   fires reclaim_vote for every outstanding voter so nobody has to manually
//   reclaim their own stake.
//
// TRUST MODEL - why running this from a shared indexer key is SAFE
//   reclaim_vote<T>(proposal: &mut TakeoverProposal<T>, voter: address, ctx) is
//   PERMISSIONLESS: callable by ANYONE. It transfers the voter's escrowed
//   Coin<T> to the VOTER address recorded in the proposal's votes table - NEVER
//   to the caller/signer. It removes that voter's votes-table entry, aborts
//   ECtoNotResolved (58) if the proposal is not yet resolved, and aborts
//   ECtoNotVoter (57) if the voter has no entry (already reclaimed / never
//   voted). So a hostile signer running this call can do NOTHING but spend its
//   own gas: it cannot redirect, steal, or double-reclaim a single coin. The
//   signer here is a gas payer only.
//
// ARMING
//   Armed by index.js when SUIPUMP_V13_PACKAGE and SUI_PRIVATE_KEY are both set
//   (mirrors the price publisher's arming). Dormant otherwise.
//
// WRITE TARGET - lineage-latest, never hardcoded
//   The escrow CTO surface (TakeoverProposal<T>, reclaim_vote, the Takeover*/
//   VoteReclaimed events) FIRST EXISTS in V13: no V4-V12 package ever emits a
//   Takeover event, and events keep their DEFINING package id forever (V14
//   emissions still type under V13), so every sweepable proposal here is
//   necessarily V13-lineage. reclaim_vote must therefore run the LATEST bytecode
//   of the V13 lineage: V14 (SUIPUMP_V14_PACKAGE - a COMPATIBLE additive upgrade
//   of V13; V13 stays the proposals' type identity) when set, else the V13
//   package itself. NOT LATEST_WRITE_PACKAGE: that env var carries the
//   V10-lineage / new-launch write target and may legitimately differ.
//
// TRANSPORT
//   JSON-RPC is FORBIDDEN (no legacy fullnode client APIs). The SuiGraphQLClient is
//   PASSED IN from index.js - this module never constructs one. Build/sign/
//   execute uses the same proven SuiGraphQLClient shape as price_publisher.js:
//   bytes = tx.build({ client }); sig = keypair.signTransaction(bytes).signature;
//   client.executeTransaction({ transaction: bytes, signatures: [sig] }). NEVER
//   dAppKit.signAndExecuteTransaction.
//
// ATOMIC-BATCH / LEDGER-REPLAY RATIONALE (the core correctness argument)
//   A PTB is ATOMIC: if one reclaim_vote in a batched transaction aborts, the
//   WHOLE transaction reverts and NO voter in that batch gets reclaimed. So we
//   must fire reclaim_vote ONLY for voters who genuinely still have an
//   outstanding entry. We reconstruct that set by CHRONOLOGICAL LEDGER REPLAY of
//   this proposal's events (seed with the proposer, whose nominate stake is
//   escrowed but emits no TakeoverVoted; then apply Voted/Unvoted/Reclaimed in
//   timestamp+id order, because a voter can unvote then re-vote). Even so, a
//   voter can manually reclaim in the gap between our DB read and our tx landing
//   - that races the batch to an ECtoNotVoter abort. We therefore try the batch
//   first (cheap on the happy path) and, on ANY batch failure, fall back to one
//   reclaim_vote per PTB so a single stale voter cannot block the rest. The
//   empty-outstanding-set skip makes full re-scans idempotent.

import { Transaction } from '@mysten/sui/transactions';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { fromBase64 } from '@mysten/sui/utils';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { V13_PACKAGE, V14_PACKAGE } from './write_target.js';

// ---- Config -----------------------------------------------------------------

const POLL_INTERVAL_MS = 60 * 1000;   // 60s per tick
// reclaim_vote calls batched into one atomic PTB on the happy path. Kept modest
// so a single PTB stays well under the transaction command/gas ceiling.
const BATCH_SIZE = 20;

// reclaim_vote write target: the latest upgrade of the V13 lineage - V14 when
// SUIPUMP_V14_PACKAGE is set, else the V13 package (see the WRITE TARGET header
// note; every sweepable proposal is necessarily V13-lineage). Null only when
// V13_PACKAGE is unset, in which case startCtoReclaimSweeper refuses to start.
const RECLAIM_WRITE_PACKAGE = V14_PACKAGE ?? V13_PACKAGE;

// ---- Keypair (same pattern as price_publisher.js / auto_graduate.js) ---------

function loadKeypair() {
  if (process.env.SUI_PRIVATE_KEY) {
    const raw  = fromBase64(process.env.SUI_PRIVATE_KEY);
    const seed = (raw.length === 33 || raw.length === 65) ? raw.slice(1) : raw;
    return Ed25519Keypair.fromSecretKey(seed);
  }
  const keystorePath = join(homedir(), '.sui', 'sui_config', 'sui.keystore');
  const keys = JSON.parse(readFileSync(keystorePath, 'utf-8'));
  const raw  = fromBase64(keys[0]);
  return Ed25519Keypair.fromSecretKey(raw[0] === 0x00 ? raw.slice(1) : raw);
}

// ---- Chain reads ------------------------------------------------------------

// The proposal object's initialSharedVersion is owner metadata, not in any
// event - one narrow live GraphQL read (same query takeover_api.js uses). Null
// degrades to a tx.object(proposalId) fallback at build time.
async function fetchProposalSharedVersion(client, proposalId) {
  try {
    const result = await client.query({
      query: `query($id: SuiAddress!) { object(address: $id) { owner { ... on Shared { initialSharedVersion } } } }`,
      variables: { id: proposalId },
    });
    return result?.data?.object?.owner?.initialSharedVersion ?? null;
  } catch {
    return null;
  }
}

// ---- Ledger replay ----------------------------------------------------------

// Reconstruct the EXACT outstanding voter set for a resolved proposal by
// chronological replay. Returns { outstanding: string[], curveId: string|null }.
async function computeOutstanding(pool, proposalId, curveIdHint) {
  // Seed: the proposer's nominate stake is escrowed but emits NO TakeoverVoted,
  // so the proposer must be seeded present. Also recovers curve_id if the
  // resolved row lacked it.
  const proposedRes = await pool.query(
    `SELECT (data->>'proposer') AS proposer, (data->>'curve_id') AS curve_id
       FROM events
      WHERE event_type LIKE '%TakeoverProposed'
        AND (data->>'proposal_id') = $1
      ORDER BY timestamp_ms ASC NULLS LAST, id ASC
      LIMIT 1`,
    [proposalId]
  );
  const proposer = proposedRes.rows[0]?.proposer ?? null;
  const curveId  = curveIdHint ?? proposedRes.rows[0]?.curve_id ?? null;

  // present = Map<address, bool>. Ordering across the three event types matters:
  // a voter can unvote then re-vote, so replay strictly in (timestamp_ms, id).
  const present = new Map();
  if (proposer) present.set(proposer, true);

  const ledgerRes = await pool.query(
    `SELECT event_type, (data->>'voter') AS voter
       FROM events
      WHERE (data->>'proposal_id') = $1
        AND ( event_type LIKE '%TakeoverVoted'
           OR event_type LIKE '%TakeoverUnvoted'
           OR event_type LIKE '%VoteReclaimed' )
      ORDER BY timestamp_ms ASC NULLS LAST, id ASC`,
    [proposalId]
  );

  for (const row of ledgerRes.rows) {
    const voter = row.voter;
    if (!voter) continue;
    const et = String(row.event_type);
    // Check Unvoted before Voted (defensive; substrings do not collide but keep
    // the classification unambiguous). Unvoted/Reclaimed clear the entry; a
    // subsequent Voted re-adds it.
    if (et.includes('TakeoverUnvoted')) {
      present.set(voter, false);
    } else if (et.includes('VoteReclaimed')) {
      present.set(voter, false);
    } else if (et.includes('TakeoverVoted')) {
      present.set(voter, true);
    }
  }

  const outstanding = [];
  for (const [addr, v] of present) if (v === true) outstanding.push(addr);
  return { outstanding, curveId };
}

// Resolve <T> for a proposal the SAME way the rest of the indexer does: from the
// curve's token_type column (auto_graduate.js reads curves.token_type). Null ->
// caller SKIPS the proposal (never guess a type argument).
async function resolveTokenType(pool, curveId) {
  if (!curveId) return null;
  const res = await pool.query(
    `SELECT token_type FROM curves WHERE curve_id = $1`,
    [curveId]
  );
  return res.rows[0]?.token_type ?? null;
}

// ---- Write ------------------------------------------------------------------

// Fire reclaim_vote for a set of voters in ONE atomic PTB. Returns the digest or
// throws (FailedTransaction or build/execute error). All calls share the single
// proposal ref. Target is RECLAIM_WRITE_PACKAGE (lineage-latest, never hardcoded).
async function fireReclaimBatch(client, keypair, proposalId, isv, tokenType, voters) {
  const tx = new Transaction();
  const ref = (isv !== null && isv !== undefined)
    ? tx.sharedObjectRef({ objectId: proposalId, initialSharedVersion: isv, mutable: true })
    : tx.object(proposalId);

  for (const voter of voters) {
    tx.moveCall({
      target: `${RECLAIM_WRITE_PACKAGE}::bonding_curve::reclaim_vote`,
      typeArguments: [tokenType],
      arguments: [ref, tx.pure.address(voter)],
    });
  }
  tx.setSender(keypair.toSuiAddress());

  const bytes     = await tx.build({ client });
  const signature = (await keypair.signTransaction(bytes)).signature;
  const res = await client.executeTransaction({ transaction: bytes, signatures: [signature] });
  if (res?.$kind === 'FailedTransaction' || res?.FailedTransaction) {
    const errText = res?.FailedTransaction?.status?.error ?? 'FailedTransaction';
    throw new Error(`reclaim_vote failed: ${typeof errText === 'string' ? errText : JSON.stringify(errText)}`);
  }
  return res?.Transaction?.digest ?? res?.digest ?? 'unknown';
}

// Reclaim every outstanding voter: batched on the happy path, degrading to
// one-per-PTB on any batch failure (a manual reclaim in the read->land gap
// aborts the whole atomic batch with ECtoNotVoter). Returns the count actually
// reclaimed and pushes digests into the shared array.
async function reclaimAll(client, keypair, proposalId, isv, tokenType, voters, digests) {
  let count = 0;
  for (let i = 0; i < voters.length; i += BATCH_SIZE) {
    const batch = voters.slice(i, i + BATCH_SIZE);
    try {
      const digest = await fireReclaimBatch(client, keypair, proposalId, isv, tokenType, batch);
      digests.push(digest);
      count += batch.length;
      console.log(`  [cto-sweep] reclaimed ${batch.length} voter(s) for proposal ${proposalId} - ${digest}`);
    } catch (err) {
      // Not fatal: one stale voter aborts the whole atomic batch. Fall back to
      // firing each voter in its own PTB and skip only the ones that abort.
      console.warn(`  [cto-sweep] batch of ${batch.length} for proposal ${proposalId} failed (${err.message}) - falling back to one-per-tx`);
      for (const voter of batch) {
        try {
          const d = await fireReclaimBatch(client, keypair, proposalId, isv, tokenType, [voter]);
          digests.push(d);
          count += 1;
          console.log(`  [cto-sweep] reclaimed voter ${voter} for proposal ${proposalId} - ${d}`);
        } catch (innerErr) {
          console.warn(`  [cto-sweep] voter ${voter} for proposal ${proposalId} skipped (${innerErr.message})`);
        }
      }
    }
  }
  return count;
}

// ---- Tick -------------------------------------------------------------------

async function sweepTick(client, keypair, pool) {
  // All resolved proposals. The empty-outstanding-set skip below makes a full
  // re-scan self-idempotent, so no high-water mark is required.
  const resolvedRes = await pool.query(
    `SELECT DISTINCT (data->>'proposal_id') AS proposal_id,
                     (data->>'curve_id')    AS curve_id
       FROM events
      WHERE event_type LIKE '%TakeoverResolved'
        AND (data->>'proposal_id') IS NOT NULL`
  );

  let proposalsSwept = 0;
  let votersReclaimed = 0;
  const digests = [];

  for (const row of resolvedRes.rows) {
    const proposalId = row.proposal_id;
    if (!proposalId) continue;
    // Never let one proposal's failure stop the loop.
    try {
      const { outstanding, curveId } = await computeOutstanding(pool, proposalId, row.curve_id);
      if (outstanding.length === 0) continue; // already fully swept - idempotent

      const tokenType = await resolveTokenType(pool, curveId);
      if (!tokenType) {
        console.warn(`  [cto-sweep] no token type for proposal ${proposalId} (curve ${curveId ?? 'unknown'}) - skipping ${outstanding.length} voter(s)`);
        continue;
      }

      const isv = await fetchProposalSharedVersion(client, proposalId);
      const n = await reclaimAll(client, keypair, proposalId, isv, tokenType, outstanding, digests);
      votersReclaimed += n;
      if (n > 0) proposalsSwept += 1;
    } catch (err) {
      console.error(`  [cto-sweep] proposal ${proposalId} failed: ${err.message}`);
    }
  }

  if (proposalsSwept > 0 || votersReclaimed > 0) {
    console.log(`  [cto-sweep] tick: ${proposalsSwept} proposal(s) swept, ${votersReclaimed} voter(s) reclaimed${digests.length ? ' - digests ' + digests.join(' ') : ''}`);
  }
}

// ---- Loop -------------------------------------------------------------------

export async function startCtoReclaimSweeper(client, pool) {
  if (!V13_PACKAGE) {
    console.error('  [cto-sweep] SUIPUMP_V13_PACKAGE not set - reclaim sweeper NOT started');
    return;
  }

  const keypair = loadKeypair();
  console.log(`  [cto-sweep] reclaim sweeper started - every ${POLL_INTERVAL_MS / 1000}s from ${keypair.toSuiAddress()}`);
  console.log(`  [cto-sweep] write target ${RECLAIM_WRITE_PACKAGE} (V13-lineage latest: ${V14_PACKAGE ? 'V14 via SUIPUMP_V14_PACKAGE' : 'V13 - set SUIPUMP_V14_PACKAGE to run the latest bytecode'})`);

  while (true) {
    try {
      await sweepTick(client, keypair, pool);
    } catch (err) {
      // A failed tick is NOT fatal. Log and try again next interval.
      console.error(`  [cto-sweep] tick failed: ${err.message}`);
    }
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }
}
