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
`0x877af0fae3fa4f8ea936943b59bcd66104f67cf1895302e97761a28b3c3a5906`,
run 2026-07-16 against the indexer Postgres + live testnet GraphQL
(scripts/census_fallback_sessions.js):

- TOTAL fallback sessions ever opened: 6
- LIVE fallback sessions: 0
- TOTAL escrow SUI parked in LIVE fallback sessions: 0 SUI (0 MIST)
- 5 sessions CLOSED (revoked / expiry_ms==0 sentinel):
  `0x010909d66b18ee11df7726a97f7b723f243ed581614de58564e156dddb1cf45c`
  `0x3ae830303506cf4717b7100e861096d4542d498222ccfbba9f4300293aecc271`
  `0x4761e88ce11847a0988fd4251b6c9a684b60ed8eedeed58d1e7518fff48f01fe`
  `0xa8e5453744c0ae18dfc738d81b9f82132baa388601866057cdb603c59e49e7e9`
  `0xe5a128767e7ee7552369071e1d0b2e0c5621fca25c0b0002c09b107e1b144e96`
- 1 session EXPIRED with 1 SUI (1000000000 MIST) escrow still parked:
  `0x309038535abb0ad478607baa2dd1de7558914bffb310ccf2694f74348db473ae`
  (owner `0xf9dca7a3207a06c75ceca8aab3ab84c6ce66fb420b9343cb594c2074b30df78d`).
  Recoverable WITHOUT the legacy signer: expire_refund is permissionless past
  expiry and always refunds escrow to session.owner.

Census verdict: with zero live fallback sessions and the only stranded escrow
recoverable permissionlessly, the SUIPUMP_LEGACY_SIGNER drain gate never needs
to be enabled. It ships defaulted OFF and should stay off; the shared key is
never constructed on any execution path.
