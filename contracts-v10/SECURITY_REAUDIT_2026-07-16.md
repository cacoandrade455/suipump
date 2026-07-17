# SECURITY_REAUDIT_2026-07-16.md - Internal adversarial re-audit of the assembled V13 package

Scope: the FULL assembled `contracts-v10` package as it stands after the V13
closeout + Phase 1 preflight fixes + Phase 2 F-10 (real-path tests):
`bonding_curve.move`, `agent_session.move`, `enclave_registry.move`, and their
interaction surface. State at audit time: `sui move test` = 84/84, zero
warnings.

Companion to `AUDIT_NOTES.md` (accepted findings F-3, F-6) and
`SECURITY_AUDIT_2026-07-15.md`. F-3 and F-6 were NOT re-reported; the CTO
finding below (F-AC-1 / SP-02) is why F-3 is currently moot - see note there.

## Method

Five independent reviewers over distinct attack surfaces (upgrade-semantics,
economic/math, access-control/capabilities, session/agent layer,
DoS/events/misc), each producing structured findings. Every finding of
severity A/B/C was then handed to a SEPARATE adversarial verifier instructed to
REFUTE it (read the real source; default to skepticism). Severities below are
POST-VERIFICATION.

Severity scale: A critical (reachable fund loss / theft / permanent brick),
B high (fund loss behind a precondition, or serious invariant break),
C medium, D low, E informational.

## Result ledger (post-verification)

| Severity | Count | IDs |
|---|---|---|
| A | 0 | - |
| B | 0 | - |
| C | 1 | F-AC-1 (CONFIRMED) |
| D | 7 | F-U1, F-U2, ECON-1, ECON-2, SP-01, AS-1, F-AC-3 |
| E | 7 | F-U3, F-U4, F-AC-2, AS-2, AS-3, SP-03, SP-04 |
| FALSE POSITIVE | 1 | SP-02 (refuted: unreachable, same root as F-AC-1) |

**Zero A and zero B findings.** Per the phase rules, nothing was code-fixed in
this phase (A/B only are fixed here; the mechanical-safety exception had nothing
to act on). Every C-and-below item is documented below with a recommendation;
none was fixed, and the decision to defer each is listed as a deviation in the
final report. Two findings originally raised at A/C (F-U1, ECON-1) were
downgraded to D by the adversarial verifier - the reasoning is recorded so the
downgrade is auditable, not silent.

---

## C - CONFIRMED

### F-AC-1 - Community-takeover (CTO) governance is dead-on-arrival

- Location: `bonding_curve.move:1712` (struct `TakeoverProposal`), `1736-1773`
  (`propose_takeover`), `1806-1814` (`resolve_takeover`).
- Defect: `TakeoverProposal` has ability `key` only - no `store`, no `drop`.
  `propose_takeover` RETURNS it by value and the module never shares it (grep:
  the only `transfer::share_object` calls are for `PriceConfig`, `Curve`, and
  the vesting lock). A real takeover needs the proposal to persist as a shared
  object across the proposer tx, many voter txs over the 12h window, and a
  resolver tx. A `key`-only, no-`drop` return value cannot be settled in any
  production PTB: `public_share_object`/`public_transfer`/`TransferObjects`
  require `store`; the non-public `transfer::share_object` is verifier-limited
  to the defining module and no wrapper exists; the only by-value consumer,
  `resolve_takeover`, aborts `ECtoVoteStillOpen` in the same tx (`closes_ms =
  now + 12h`). With `key` and no `drop`, the unused value fails the tx. So
  every real `propose_takeover` transaction fails to build - the whole CTO
  feature cannot execute on-chain. The frontend call at `TokenPage.jsx:1595`
  aborts on this too.
- Reachability / impact: fails SAFE - incumbent creator keeps control, no fund
  loss, no attacker gain. It is a broken-feature / self-DoS, not an exploit.
  But it kills the only recovery mechanism for an abandoned token, and it
  renders the accepted finding F-3 (CTO vote double-count) currently moot -
  the flow F-3 presumes cannot run at all.
- Why the tests missed it: `bonding_curve_tests.move:2468` / `2509` hold the
  proposal as a local value inside a single test flow with a rewindable test
  clock, never crossing a tx boundary or a share/settlement point.
- Recommended fix (mechanical, but it ENABLES a governance feature, so it is a
  founder decision, not an autonomous mechanical patch): inside
  `propose_takeover`, `transfer::share_object(proposal)` (legal in the defining
  module without `store`) and drop the return; then add an integration test
  using `ts::next_tx` between propose / vote / resolve so the share path is
  actually exercised.
- Status: NOT fixed in this phase (severity C; and enabling CTO interacts with
  the accepted F-3 vote-double-count finding - Carlos should decide whether to
  ship CTO at all for v1, or leave it inert).

---

## D - low (documented, not fixed)

### F-U1 - Legacy-package `buy()` bypasses the V13 F-2 price fix (downgraded A -> D)

- Location: `bonding_curve.move:791-799` (V13 `buy` takes `&PriceConfig`);
  overstated "deleted at the root" comments at `187-192` / `236-239`; enabler =
  no `assert_package_version` anywhere (grep-confirmed).
- Mechanism (real): a Sui upgrade publishes new bytecode at a NEW address but
  never disables the old versions. `Curve<T>` is defined at the V10 address and
  its shared objects are the SAME regardless of which package version is
  called. V9-V12 `buy<T>(curve, ..., sui_price_scaled: u64, clock, ctx)` still
  exists and still takes an UNBOUNDED caller-supplied price. Calling an old
  package's `buy()` with a huge `sui_price_scaled` collapses the dampened
  threshold to sub-SUI and force-triggers graduation on any live curve
  (`graduated = true` permanently disables buy/sell); for curves under
  `MIN_GRAD_RESERVE_MIST` (500 SUI) `claim_graduation_funds` also aborts
  `EReserveTooLow`, permanently stranding holders.
- Why downgraded to D: the exploit requires the vulnerable OLD packages to be
  published on the SAME network as the target curves. That is true only on
  TESTNET (worthless test SUI - griefing, not fund loss). MAINNET is a FRESH
  single publish: a testnet package cannot be cross-chain "upgraded" onto
  mainnet, `init` runs and creates the `PriceConfig`, and there is no
  unbounded-price `buy()` to call. So the critical exploit is NOT reachable
  against real funds in the audited change set. The residual is a real latent
  design gap: once mainnet is live and later upgraded (V14+), the then-old
  `buy()` re-opens the brick vector against real-fund curves, and no assert can
  retroactively disable already-published bytecode.
- Recommendation: (1) deploy mainnet as a FRESH single V13 publish (no prior
  versions) - this is already the stated mainnet plan; (2) before the FIRST
  mainnet upgrade, add an `assert_package_version`-style version marker to
  `Curve` and gate mutating entrypoints on it, so future old bytecode is
  fenced; (3) soften the `187-192` "deleted at the root" comment to note it
  holds only for a fresh publish.

### F-U2 - `buy()` / `buy_with_session()` accept ANY `&PriceConfig`, not pinned to the canonical config

- Location: `bonding_curve.move:796`, `623-628` (`resolve_grad_threshold`),
  two distinct `share_object(PriceConfig)` sites (`274` init, `324`
  create_price_config).
- Defect: `buy()` never asserts the passed `price_cfg` is THE canonical config.
  If more than one `PriceConfig` ever exists (see F-AC-2 for how a fresh publish
  can produce two), a buyer can choose which price reference applies - e.g. pass
  a stale/never-updated config to force the BASE_GRAD fallback instead of the
  live dampened threshold. Bounded impact (the fallback is an intended state),
  but it removes the relayer's control over the threshold for that trade.
- Recommendation (mechanical): pin the config identity - store the canonical
  `PriceConfig` id (e.g. a df on the AdminCap or a package singleton) at
  creation and assert `object::id(price_cfg) == expected` in `buy()` /
  `buy_with_session()`. Also resolves F-AC-2 / F-U3 as a class.

### ECON-1 - Buyer self-referral redirects 10%-of-fee to the trader (downgraded C -> D)

- Location: `bonding_curve.move:805-807` (buy) / `1031-1033` (sell); split at
  `917-920` / `1069-1072`; `split_fee_v7` `546-555`.
- Defect: `referral: Option<address>` is caller-supplied and only asserted
  `!= curve.creator`. `referral == tx_context::sender` is not blocked, so a
  trader self-refers and routes the 10%-of-fee referral share (0.1% of trade)
  out of the protocol+airdrop buckets back to themselves.
- Why downgraded to D: the referral parameter is Sybil-unpreventable - a
  `referral != sender` assert is defeated by passing a second wallet the trader
  controls, or mutual bot referral, for the identical siphon at the cost of one
  address. The protocol's guaranteed fee floor was always the with-referral
  split (25/25 -> 20/20); the no-referral 25/25 is upside from unsophisticated
  flow, not protected revenue. No fund loss, conservation holds.
- Recommendation: adding `assert!(*option::borrow(&referral) !=
  tx_context::sender(ctx), ESelfReferral)` after `806` and `1032` is still
  worth doing - free, mirrors the existing creator guard, removes the
  zero-setup single-tx path - but it MITIGATES rather than closes an inherent
  property of a permissionless referral program. Deferred as it touches the
  fee-split path; founder call.

### ECON-2 - `execute_buyback` can push reserve past the graduation threshold without graduating

- Location: `bonding_curve.move:1633-1671`; no `should_graduate` /
  `do_graduate_inline` after the reserve join at `~1651`.
- Defect: `execute_buyback()` is permissionless and joins the entire
  `buyback_fees` bucket into `sui_reserve` and removes bought tokens, but unlike
  `buy()` it never evaluates graduation. If the reserve was just below
  `current_grad_threshold`, a buyback can carry it above threshold while
  `graduated` stays false; the curve keeps trading above its graduation point.
- Recommendation (mechanical, but graduation-adjacent): after the buyback SUI
  join, mirror the `buy()` tail - `if (token_reserve == 0 || (new_reserve >=
  current_grad_threshold && current_grad_threshold > 0)) do_graduate_inline(...)`.
  Deferred: it changes when graduation fires, so founder should confirm the
  intended buyback/graduation interaction before shipping.

### SP-01 - `execute_buyback` lacks the `!paused` guard that buy/sell enforce

- Location: `bonding_curve.move:1637`.
- Defect: `buy()` (`801`) and `sell()` (`1027`) both assert `!curve.paused`;
  `execute_buyback` asserts only `!curve.graduated`. When the AdminCap pauses a
  curve for incident response, anyone can still call `execute_buyback` while
  `buyback_fees > 0`, mutating live AMM state (reserve + token_reserve) during
  the pause.
- Recommendation (clean mechanical marker-guard): add `assert!(!curve.paused,
  EPaused)` at the top of `execute_buyback`. This is the most clear-cut
  mechanical safety fix in the report; deferred only because it is severity D
  and the phase rules fix A/B only - recommend applying in a follow-up.

### AS-1 - `settle_sell<T>` does not bind the ticket's token type

- Location: `agent_session.move:129-133` (`TradeTicket`), `458-475`
  (`borrow_tokens_for_sell`), `479-494` (`settle_sell`).
- Defect: on the universal-trading sell path the hot-potato `TradeTicket`
  carries `{session_id, borrowed, kind:SELL}` but NO `TypeName`.
  `borrow_tokens_for_sell<ValuableToken>` hands out a `Coin<ValuableToken>` and
  a ticket; the potato can be consumed via `settle_sell<JunkToken>` (kind and
  session_id match) while the attacker keeps the valuable coin. Requires
  universal trading ENABLED on the session AND a compromised session key - so
  bounded by the accepted F-6 blast radius (single user's own session), which
  is why it is D not higher; but it lets a compromised key extract a parked
  coin for near-zero settlement rather than merely churning escrow.
- Recommendation (mechanical): add `token_type: TypeName` to `TradeTicket`, set
  it in `borrow_tokens_for_sell` via `type_name::with_defining_ids<T>()`, and
  assert equality at the top of `settle_sell<T>`. Same treatment for the buy
  path for symmetry. Deferred (touches the TradeTicket struct + settle logic);
  worth doing before universal trading is enabled in the UI (it is currently
  `UNIVERSAL_TRADING_ENABLED=false`).

### F-AC-3 - Module docs overstate escrow safety under key compromise

- Location: `agent_session.move:12-18` (trust-model comment).
- Defect: the docs claim a compromised session key can at worst "churn the
  user's escrow through legitimate buy/sell; SUI proceeds still land in the
  USER's escrow." A compromised key holder also controls their own wallet and
  can sandwich a thin curve they created to route the spread out - within the
  accepted F-6 spend_cap bound, but the escrow up to the cap CAN be lost to the
  attacker, not merely churned.
- Recommendation (doc-only mechanical): correct `agent_session.move:12-18` to
  state that on key compromise the full escrow up to `spend_cap` can be lost.
  No contract change (an authorized-curve allowlist per session would be an
  economic/design change, out of scope).

---

## E - informational (documented, not fixed)

- **F-U3** (`bonding_curve.move:321-329`): the `create_price_config` one-shot
  marker is keyed on the AdminCap UID, so the "single PriceConfig" guarantee is
  per-cap, not global. Sound TODAY (exactly one AdminCap, no minting path), a
  latent hazard only if a second AdminCap is ever introduced. Fix folds into
  F-U2's pin-the-canonical-id recommendation.
- **F-U4** (`321-329` / `274` / `791-799`): no on-chain guarantee that
  `create_price_config` ran before the first post-upgrade buy - it is a manual
  bootstrap step. Until it runs, no `buy()` can be constructed (no `&PriceConfig`
  to reference), so trading is simply down, not unsafe. Recommendation: make it
  a verified step in the deploy runbook; optionally emit an event from
  `create_price_config` (it currently emits none) so the indexer can confirm it.
- **F-AC-2** (`274-278` / `321-329`): a FRESH publish can end with TWO shared
  `PriceConfig` objects - `init` shares one but does not set the marker on the
  AdminCap, so the admin can still call `create_price_config` once more.
  Recommendation: in `init`, set `PRICE_CONFIG_CREATED_KEY` on the AdminCap so
  `create_price_config` aborts `EPriceConfigExists` on a fresh publish too.
  Purely defensive.
- **AS-2** (`agent_session.move:521-533` / `538-551`): `close_session` /
  `expire_refund` sweep only SUI escrow; parked `Coin<T>` DOFs are left on the
  closed session (NOT locked - `sweep_token<T>` recovers each, but the owner
  must remember every `T`). Recommendation: emit parked `TypeName`s in an event
  at park time so the owner/relayer can enumerate outstanding `sweep_token<T>`
  calls.
- **AS-3** (`agent_session.move:230-243` / `373-379`): `top_up_session` and
  `enable_universal_trading` have no closed/revoked guard. Owner-gated and
  harmless (trading still impossible; owner can re-close to reclaim), cosmetic.
  Recommendation: assert `!is_closed && !revoked` on both.
- **SP-03** (`bonding_curve.move:1423`): `post_comment` `parent_id` is an
  unvalidated caller-supplied address emitted verbatim; the indexer reply tree
  is forgeable (attacker pays the 1 SUI fee to attach a reply under any
  comment). On-chain validation is impractical (parents are tx digests).
  Recommendation: indexer rejects/flags a `parent_id` that does not resolve to a
  prior Comment on the SAME curve, and drops cycles; document `parent_id` as
  advisory.
- **SP-04** (`bonding_curve.move:81-82`): abort code 23 is shared by
  `EMetadataWindowClosed` and `ENoMetadataFields`, both firing in
  `update_metadata` - ambiguous retry signal. Pre-existing, predates V13.
  Recommendation: give `ENoMetadataFields` a distinct unused code; confirm no
  off-chain code pattern-matches 23 for the no-fields case first.

## Refuted (false positive)

- **SP-02** - "CTO cooldown can be perpetually griefed." REFUTED: the entire
  CTO lifecycle is unreachable on-chain (same root as F-AC-1), so
  `cto_cooldown_until_ms` can never be set and the griefing loop has no
  executable first step. Even counterfactually (if sharing worked), the cooldown
  is checked only at propose time and lapses >= 12h each attacker cycle, so it
  would be a delay nuisance, not a permanent disable.

## Clean surfaces (no findings above E)

Verified clean by the reviewers, for the record:
- Admin-gated money-movers all take `&AdminCap` (`set_paused`,
  `claim_protocol_fees`, `claim_airdrop_fees`, `record_graduation_pool`,
  `claim_graduation_funds`, `set_sui_price`). `create_price_config` correctly
  takes `&mut AdminCap` (needs the UID for the marker).
- `claim_graduation_funds` one-shot marker (`GRAD_CLAIMED_KEY`) is sound: it
  asserts `graduated`, asserts the marker absent, adds it BEFORE minting, and
  checks `MIN_GRAD_RESERVE_MIST` - no double-claim, no claim on a
  non-graduated curve.
- Curve math conservation holds numerically on all three buy paths (drain /
  grad-clip / normal), the sell path, and the claim path; the F-5
  `to_reserve = swap_amount + lp_fee` fix is confirmed present in production
  `buy()`.
- F-10 shadow path is genuinely closed: `buy_for_testing` is a zero-logic
  delegator to production `buy()`; `graduate_for_testing` and production
  `graduate()` both route through `graduate_impl`; no `*_for_testing` function
  contains fee/threshold/graduation arithmetic.
- Session sender enforcement (`sender == session_address`), `expiry_ms == 0`
  closed sentinel, `revoked` gating, and parked-coin DOF custody by
  `TypeName` key are correct on the NARROW (non-universal) path.
- `post_comment` author is `tx_context::sender` (F-7) - no residual spoof.

## Phase 4 gate status (for the founder)

- `sui move test`: 84/84, zero warnings. Vite build: green.
- Severity A open: 0. Severity B open: 0.
- Highest open finding: F-AC-1 (C, CONFIRMED) - CTO governance is
  non-functional. Fails safe, but it is a real broken feature and it moots the
  accepted F-3. Recommend a founder decision (fix-and-ship CTO, or leave inert
  and note it) BEFORE the main merge.
- All D/E items are documented above with recommendations; none fixed this
  phase (phase rule: fix A/B only). Applying SP-01 (`!paused` on
  `execute_buyback`) and F-AC-2/F-U2 (canonical PriceConfig pin) as a small
  mechanical follow-up is recommended before mainnet.

---

## Addendum 2026-07-17 -- F-AC-1 RESOLVED (escrow-weighted CTO redesign)

F-AC-1 (CTO governance dead-on-arrival -- `TakeoverProposal` was `key`-only and
never shared, so the proposal could not survive its creating transaction and the
whole CTO feature could not execute on-chain) is RESOLVED by commit `f5b80885`
("feat(move): escrow-weighted CTO - shared proposal, vote/unvote escrow,
permissionless resolve+reclaim (fixes F-AC-1, F-3) + full cross-tx test
family").

What changed:

- The proposal is now a SHARED object: `propose_takeover` calls
  `transfer::share_object(proposal)` (legal in the defining module without
  `store`) and returns nothing, so the proposal persists across the proposer tx,
  the voter txs over the window, and the resolver tx. `resolve_takeover` takes
  `&mut` so the object persists and escrow stays reclaimable.
- The CTO is now ESCROW-WEIGHTED: vote weight comes from a `Coin<T>` locked into
  the proposal's escrow (`coin::into_balance` consumes the coin), keyed per voter
  and returned on unvote/resolve. This also fixes the accepted finding F-3 (CTO
  vote double-count) that F-AC-1 had mooted: a locked coin cannot be moved to a
  second wallet to vote again, and under Move linear typing the same token cannot
  be counted twice.

Regression coverage (cross-tx, `contracts-v10/sources/bonding_curve_tests.move`):
`test_cto_shares_the_object` (F-AC-1 regression -- `take_shared` in a later tx,
exercising the cross-tx share/settlement path the original tests could not reach)
and `test_cto_f3_double_count_impossible` (F-3 regression -- coin escrowed, a
second wallet cannot add weight, each token counted once), plus 19 more across
the full CTO family (propose/vote/unvote/resolve/reclaim/cooldown; 21 CTO tests
total). Suite: `sui move test` = 103/103, zero warnings.

Result-ledger effect: the "Highest open finding: F-AC-1 (C, CONFIRMED)" line in
the Phase 4 gate status above is now CLEARED -- F-AC-1 is resolved and F-3 is no
longer accepted (both fixed by `f5b80885`). The original re-audit body above is
unchanged; this addendum only records the subsequent resolution.
