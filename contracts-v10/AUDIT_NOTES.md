# AUDIT_NOTES.md - Accepted findings and their rationale

Companion to SECURITY_AUDIT_2026-07-15.md. Records findings that are ACCEPTED
(not fixed) in the V13 change set, the founder decision behind each, and the
conditions attached. Auditors: read this before flagging the items below as open.

---

## F-3 - CTO vote double-count via balance shuffling

**Status: ACCEPTED AS-IS. Founder decision, 2026-07-16.**

Vote weight reads a live transferable balance while `voted` is keyed by
address, so coins can be shuffled to fresh wallets and re-voted within a single
proposal window.

Mitigations considered and rejected:

- **Snapshot at proposal open.** Rejected: Sui has no holder registry; the
  balance-at-proposal-open of a wallet that has not yet voted is not queryable
  on-chain, so a snapshot scheme cannot be enforced in the contract.
- **Vote escrow.** Rejected: locking coins for the duration of the vote window
  is unacceptable UX for v1 (holders would be unable to trade while a CTO vote
  is live).

Revisit post-mainnet.

---

## F-6 - spend_cap net-exposure semantics (cap refresh via sell)

**Status: ACCEPTED, 2026-07-16 - CONDITIONAL on shared-signer fallback removal
shipped in the same change set (Task B of the V13 closeout).**

Since V11, `spend_cap` is net exposure: sells DECREMENT `spent` (clamped at
zero), so a buy -> rug -> sell loop can refresh headroom under the cap. It is
not a lifetime cumulative buy odometer.

Rationale for acceptance: exploiting the cap-refresh loop requires a
compromised session key. With per-user Turnkey/enclave session keys and NO
shared-wallet fallback signer, a key compromise is bounded to that single
user's escrow - the blast radius the cap exists to limit. The acceptance is
therefore conditional on the removal of the silent shared-agent-wallet fallback
(the one signer whose compromise would have spanned every fallback session),
which ships in the same change set:

- TURNKEY provisioning/key-lookup failures now hard-fail the request; no
  fallback signer exists.
- Bare non-session `/buy` `/sell` bridge endpoints signed by the shared key are
  retired (HTTP 410).
- The shared key is loadable only under `SUIPUMP_LEGACY_SIGNER=1`, and only for
  the close/sweep drain path of pre-existing fallback sessions.

Fallback-session census (B0), shared agent wallet
`0x877af0fae3fa4f8ea936943b59bcd66104f67cf1895302e97761a28b3c3a5906`:

<!-- TODO(carlos): paste the B0 census output here - total fallback sessions
     ever, live fallback sessions, escrow SUI parked. Command:
     see scripts/census_fallback_sessions.js header. This TODO is the only
     intentionally open item in this file. -->

Revisit if the census shows live fallback sessions with material escrow that
cannot be drained via the legacy path.
