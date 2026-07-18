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
`claim_protocol_fees`, `claim_airdrop_fees`, and the `enclave_registry`, plus
`claim_graduation_funds` / `record_graduation_pool` as a COLD BACKSTOP only - is
legitimate protocol authority that stays a disclosed centralization surface until the
`AdminCap`/`UpgradeCap` multisig migration. That migration is a MAINNET-BLOCKING gate
(CLAUDE.md). Two capability splits have made the cap F-14 must migrate strictly
SMALLER and, crucially, fully COLD-able:
- **E-1 (`PriceRelayerCap`, live):** the 5-minute price push runs off a separate hot
  cap, so the AdminCap no longer needs to be online for prices.
- **V14 (`GraduationCap`, built - commit `01d4c38d`):** graduation automation runs off
  a separate `GraduationCap`, so the AdminCap no longer needs to be online for
  graduation either (this was GRAD-1). After the V14 upgrade + operator key swap, NO
  server holds the AdminCap key.
So F-14 now migrates an AdminCap whose day-to-day powers are neither price nor
graduation automation - it can move cold to the multisig with nothing online depending
on it. F-14 is the standing tracker for that migration; accepted-until-mainnet, not a
code defect.

**Post-publish update (2026-07-17): F-14 now applies to the LIVE V13 caps.** V13
shipped as a FRESH PUBLISH (its own type identity, not a V10 upgrade; see the
Publish record in `SECURITY_REAUDIT_2026-07-17_PREPUBLISH.md`), so the live caps are:

- AdminCap V13 `0xb3d3155ca1bc153664143895928aa77384f5c70f752c306e10fa619f460e039d`
  - owned by the main wallet, and the target of the F-14 multisig migration. On testnet
  its key is currently `GRADUATION_SIGNER_KEY` on the graduation worker (GRAD-1); the
  V14 `GraduationCap` (commit `01d4c38d`) removes that need, and after the upgrade +
  operator key swap the AdminCap key must never appear in any server env again.
- PriceRelayerCap `0x818e0263bc28f5f6089ed6b120fa818cba61d0378897f197398ed2b860ad7510`
  - the E-1 price-only split, held by a SEPARATE hot relayer wallet
  `0xce53cb8f9befc490393d70528ef732bbcbe12d951ffcdd76a37af9b0f9624629`. Its entire
  power is `set_sui_price` within the clamped band. E-1 is therefore already LIVE
  on-chain: the always-online price key does not hold the AdminCap, so F-14 can
  migrate the cold AdminCap to multisig without touching the price cadence. The
  V10-lineage AdminCap
  `0x144d426960a9a6b8db63ce3426e06a9c41273a17e72ed0193cd8c8507d4f6ec5` still governs
  the frozen V4-V12 curves and is a separate F-14 item.

---

## GRAD-1 - graduation signer held the AdminCap key on a hot server (RESOLVED in V14)

**Status: RESOLVED in code by the V14 `GraduationCap` (commit `01d4c38d`); closes
on-chain at the V14 upgrade + `init_graduation` + the operator key swap below.** The
testnet interim (a separate `GRADUATION_SIGNER_KEY` carrying the main wallet key that
holds AdminCap V13) was an expedient reversing the earlier "manual graduation" plan;
it is NO LONGER the plan of record - V14 removes the need for it.

**The fix (V14 GraduationCap + rotation registry).** An additive (`compatible`)
upgrade via UpgradeCap V13
`0x79ebefc92e5da42720ff4b3e719a71e4ecd5428a9750d4ada8257f61e3556a19` adds:
- `GraduationCap` (key, store) whose ONLY powers are `claim_graduation_funds_with_cap`
  and `record_graduation_pool_with_cap`. Both delegate to the SAME private impls the
  AdminCap functions call, so there is zero duplicated economic logic (F-10's lesson).
- A shared `GraduationRegistry { active_cap_id }`. Every `_with_cap` call asserts
  `registry.active_cap_id == object::id(cap)` (`EGraduationCapRevoked`), so rotation is
  instant revocation.
- `rotate_graduation_cap(admin, registry)` - AdminCap-gated: mints a fresh cap and
  repoints the registry. The old cap is dead the moment the rotation tx lands (the
  same swap-to-revoke pattern as the CreatorCap CTO takeover). This is the whole
  reason the registry exists: a compromised hot graduation key must be killable from
  the cold AdminCap WITHOUT a package upgrade.
- `init_graduation` (one-shot via a marker on the AdminCap UID, mirroring
  `create_price_config`) bootstraps the cap+registry on the V13 upgrade; `init` does
  the same on any future fresh publish. Exactly one cap + one registry per package.

Verified additive (no existing public signature or struct layout changed) and covered
by 125/125 Move tests, zero warnings. This is the graduation analogue of the E-1
`PriceRelayerCap` split, and it RESTORES E-1's benefit: the AdminCap functions remain
as the cold backstop but are no longer needed on any server.

**Operator step that closes it on-chain:** run the V14 `sui client upgrade`
(UpgradeCap V13), call `init_graduation` with AdminCap V13, then set
`GRADUATION_SIGNER_KEY` on Render to a DEDICATED graduation wallet holding ONLY the
minted `GraduationCap` (never the AdminCap). After that, the AdminCap key is off every
server. The off-chain path is env-gated (`SUIPUMP_V14_PACKAGE` +
`SUIPUMP_GRADUATION_CAP` + `SUIPUMP_GRADUATION_REGISTRY`, commit `1d300530`): unset
keeps the AdminCap path, set switches to `_with_cap`.

**Signer separation (still enforced, still in code):** `GRADUATION_SIGNER_KEY` is read
ONLY by the graduation scripts; `SUI_PRIVATE_KEY` (price relayer wallet,
PriceRelayerCap) ONLY by the price publisher and CTO sweeper. Neither path reads the
other's key. Tracked as finding GRAD-1 in
`SECURITY_REAUDIT_2026-07-17_PREPUBLISH.md` (addenda 4 and 5).
