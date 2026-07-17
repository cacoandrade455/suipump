# AUDIT_NOTES.md - Accepted findings and their rationale

Companion to SECURITY_AUDIT_2026-07-15.md. Records findings that are ACCEPTED
(not fixed) in the V13 change set, the founder decision behind each, and the
conditions attached. Auditors: read this before flagging the items below as open.

---

## F-3 - CTO vote double-count via balance shuffling

**Status: SUPERSEDED -- FIXED IN V13 by escrow-weighted voting (f5b80885).**

The CTO governance was redesigned to escrow-weighted voting. Vote weight now
comes from a `Coin<T>` LOCKED into the proposal's escrow -- `coin::into_balance`
consumes the coin at vote time -- rather than from a live transferable balance.
A locked coin physically cannot be moved to a second wallet to vote again, and
votes remain keyed per-voter address. Under Move linear typing the same token
cannot be counted twice: it is either escrowed here (weight added once) or held
elsewhere (weight not added), never both. Double-counting is not expressible.
Unvote returns the escrowed coin; resolve/reclaim are permissionless and return
each voter's escrow after the window. Regression coverage in
`contracts-v10/sources/bonding_curve_tests.move`:
`test_cto_f3_double_count_impossible` (coin escrowed, a second wallet cannot add
weight, each token counted once) plus the full CTO family (21 CTO tests:
propose/vote/unvote/resolve/reclaim/cooldown). Suite: `sui move test` = 103/103,
zero warnings.

The re-audit (2026-07-16) had already noted F-3 was mooted by F-AC-1 (the
proposal was never shared, so the flow F-3 presumes could not run); the V13
redesign both shares the proposal (see F-AC-1 below) and removes the
double-count vector physically.

**History (original ACCEPTED rationale, 2026-07-16 -- preserved for the trail;
no longer the disposition):**

> **Status: ACCEPTED AS-IS. Founder decision, 2026-07-16.**
>
> Vote weight reads a live transferable balance while `voted` is keyed by
> address, so coins can be shuffled to fresh wallets and re-voted within a single
> proposal window.
>
> Mitigations considered and rejected:
>
> - **Snapshot at proposal open.** Rejected: Sui has no holder registry; the
>   balance-at-proposal-open of a wallet that has not yet voted is not queryable
>   on-chain, so a snapshot scheme cannot be enforced in the contract.
> - **Vote escrow.** Rejected: locking coins for the duration of the vote window
>   is unacceptable UX for v1 (holders would be unable to trade while a CTO vote
>   is live).
>
> Revisit post-mainnet.

(The rejected "vote escrow" mitigation is exactly what V13 adopted; the UX
objection was resolved by making resolve and reclaim permissionless so escrow is
always recoverable after the window.)

---

## F-AC-1 - CTO governance dead-on-arrival (proposal never shared)

**Status: FIXED IN V13 by escrow-weighted CTO redesign (f5b80885).**

Re-audit 2026-07-16 (C, CONFIRMED): `TakeoverProposal` was `key`-only and was
returned by value from `propose_takeover` without ever being shared, so the
proposal could not survive its creating transaction and the whole CTO feature
could not execute on-chain. The re-audit noted this mooted the accepted F-3.

Resolution: `propose_takeover` now `transfer::share_object`s the proposal
(returns nothing), so it persists as a shared object across the proposer tx, the
voter txs over the window, and the resolver tx. `resolve_takeover` takes `&mut`
(the object persists) so escrow remains reclaimable. Regression coverage in
`contracts-v10/sources/bonding_curve_tests.move`:
`test_cto_shares_the_object` (take_shared in a later tx, exercising the cross-tx
share path the old tests could not), alongside the full CTO family. Suite:
`sui move test` = 103/103, zero warnings.

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

---

## F-9 - AdminCap centralization - price surface SPLIT OUT; remainder is the mainnet multisig gate (F-14)

**Status: PARTLY RESOLVED (price surface, 2026-07-17, commit 9fcbd6d5); the
remainder is the standing mainnet multisig gate, tracked as F-14.**

F-9 (SECURITY_AUDIT_2026-07-15.md, INFO) disclosed that a single `AdminCap`
gated pause, fee claims, graduation-pool recording, and the enclave registry.
The pre-publish re-audit (SECURITY_REAUDIT_2026-07-17_PREPUBLISH.md, E-1)
escalated this to HIGH once `set_sui_price` and `claim_graduation_funds` were
added to the same cap: the price relayer must hold a HOT key that pushes every
~5 min, and that key could therefore also drain every graduated reserve, mint
the 200M LP, pause any curve, and claim fees. A 2-of-3 multisig cannot co-sign a
push every 5 min, so the "multisig before mainnet" mitigation could not cover
the price surface.

**Resolution (E-1, commit 9fcbd6d5):** the price-publish authority is split into
its own capability, `PriceRelayerCap`, and `set_sui_price` is gated on it ALONE
(no AdminCap path; Move type-checks the argument, so there is no dual-path escape
hatch). The hot relayer key now holds only `PriceRelayerCap`, whose entire power
is to push a price already clamped to `[MIN,MAX]_PRICE_SCALED`. It can never
touch reserves, minting, fees, pause, or the enclave registry. Exactly one
`PriceRelayerCap` is minted per package (by `init` on a fresh publish, by
`create_price_config` on an upgrade), announced via `PriceRelayerCapIssued` for
the publish runbook. Regression: `test_price_relayer_cap_sets_price`,
`test_set_sui_price_gated_on_relayer_cap_only`,
`test_create_price_config_mints_relayer_cap`,
`test_admin_cap_still_pauses_after_relayer_split`.

**F-14 (OPEN until mainnet):** what remains under `AdminCap` - pause any curve,
`claim_graduation_funds` (drain a graduated reserve + mint the 200M LP),
`claim_protocol_fees`, `claim_airdrop_fees`, `record_graduation_pool`, and the
`enclave_registry` - is legitimate protocol authority that stays a disclosed
centralization surface until the `AdminCap`/`UpgradeCap` multisig migration.
That migration is a MAINNET-BLOCKING gate (CLAUDE.md). After the E-1 split the
cap no longer needs to be online for price pushes, so it CAN be held cold in the
multisig - which is exactly what E-1 makes possible. F-14 is the standing tracker
for that migration; it is accepted-until-mainnet, not a code defect.
