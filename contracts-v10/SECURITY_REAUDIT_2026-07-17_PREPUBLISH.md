# SECURITY_REAUDIT_2026-07-17_PREPUBLISH.md - Full pre-publish adversarial re-audit of the assembled V13 package

- **Scope:** the COMPLETE assembled `contracts-v10` package as it stands on
  `wip-graduation-v13` @ `bebc6eda` (CTO vote window 72h), read as one integrated
  system, not as a base plus bolt-ons:
  - `contracts-v10/sources/bonding_curve.move` (2000 lines: curve math, 5-way fee
    split, buyback, oracle-priced graduation, the graduation exit path
    `claim_graduation_funds`, and the escrow-weighted community-takeover surface)
  - `contracts-v10/sources/agent_session.move` (session escrow, V11 net-exposure
    spend cap, universal-trading `TradeTicket`, parked-coin dynamic object fields)
  - `contracts-v10/sources/enclave_registry.move` (Nautilus Nitro attestation +
    PCR match)
  - `coin-template/sources/template.move` (the coin publish path)
  - the off-chain trust boundary (what the CONTRACT guarantees independent of the
    bridge / runner / indexer / frontend)
- **Date:** 2026-07-17
- **Baseline gate:** `sui move test` = 106/106, zero warnings, before and after
  this pass (no code was changed by this pass; see Dispositions).
- **Method:** five independent adversarial persona passes (A Arithmetic Attacker,
  B Capability Forger, C Economic Attacker, D Griefer, E Integrator), each finding
  of severity A/B/C then handed to a SEPARATE adversarial verifier instructed to
  REFUTE it against the real source before acceptance. Severities below are
  POST-VERIFICATION. Passes were run as an orchestrated multi-agent workflow; the
  two surviving substantive findings (E-1, PASS-C-1) were each refuted by a
  dedicated verifier that read the real call graph.

---

## Summary

- **Modules audited:** 4 production Move modules + off-chain boundary.
- **Money-movers given full adversarial treatment:** `create_and_return`, `buy`,
  `sell`, `do_graduate_inline` / `graduate` / `graduate_impl`,
  `claim_graduation_funds`, `claim_creator_fees`, `claim_protocol_fees`,
  `claim_airdrop_fees`, `execute_buyback`, `collect_protocol_surcharge`,
  `propose_takeover` / `vote_takeover` / `unvote_takeover` / `resolve_takeover` /
  `reclaim_vote`, `lock_tokens` / `claim_vested` (bonding_curve); `open_session`
  family, `buy_with_session`, `sell_with_session`, `borrow_for_buy` / `settle_buy`,
  `borrow_tokens_for_sell` / `settle_sell`, `close_session`, `expire_refund`,
  `sweep_token` (agent_session); `register_enclave_key` (enclave_registry).

### Findings by severity (post-verification)

| Severity | Count | IDs |
|----------|-------|-----|
| A critical | 0 | - |
| B high     | 1 | E-1 (CONFIRMED, DISPOSITION: reported to Carlos - fix is a cap-semantics change) |
| C medium   | 1 | PASS-C-1 (CONFIRMED) |
| D low      | 1 | PASS-D-1 (refines accepted ECON-2) |
| E info     | 1 | PA-1 (documentation accuracy) |

**Zero A findings. One B finding (E-1), whose only real fix changes capability
semantics (splitting a dedicated price-relayer capability out of `AdminCap`), which
under the phase rules is STOPPED and reported to Carlos rather than applied
autonomously.** No A/B contract-logic bug was found: E-1 is a centralization /
trust-boundary finding conditional on off-chain key compromise, not a bug any
anonymous on-chain caller can trigger.

### Posture

The prior audit surface is holding. Every A/B finding from
`SECURITY_AUDIT_2026-07-15.md` and the two `SECURITY_REAUDIT_2026-07-16.md` passes
is closed in this assembled package and the closures were re-verified line-by-line
(see Reconfirmed closures). The curve avoids the Cetus class structurally: there is
**no bit-shift operator anywhere in the contract source** (grep-confirmed; every
`<<`/`>>` match is generic-type syntax in the test file), and all value math widens
to `u128` before multiplying or divides by compile-time constants. Fee conservation
was re-derived symbolically on all three buy paths and the sell path and holds
exactly. Escrow conservation holds for both sessions and takeover votes. The two
new findings this pass surfaces are (B) a centralization gap where the always-online
price relayer must hold the same `AdminCap` that can drain graduated reserves and
mint the 200M LP, and (C) a near-free griefing denial of the community-takeover
recovery mechanism via an unguarded proposer un-vote. Both are described with a
concrete call sequence below.

**This is an automated first pass, not a substitute for a human audit. Cetus was
audited by OtterSec, MoveBit and Zellic; all three missed the bug that cost $223M.
Clean output here means nothing was found by this pass, not that the code is safe.**

---

## Not Verified (the risk surface this pass did NOT cover)

1. **The graduation -> DEX-LP migration itself.** `claim_graduation_funds` mints the
   200M LP and returns it plus the drained reserve to the AdminCap holder; where and
   how the relayer seeds the actual DEX pool (Cetus/DeepBook/Turbos), and whether the
   LP NFT custody is correct, is off-chain and out of scope here.
2. **Live/on-chain behavior.** No transactions were executed against testnet; all
   findings are static. u64 boundary behavior at extreme-but-reachable inputs was
   reasoned, not run.
3. **The off-chain layer** (`bridge.js`, `strategy.js`, `frontend-app/api/*`,
   `census_fallback_sessions.js`). Only the contract's guarantees independent of them
   were assessed (Pass E). The B0 fallback-session census and the
   `SUIPUMP_LEGACY_SIGNER` posture (AUDIT_NOTES F-6) were taken as reported, not
   re-run.
4. **`sui::nitro_attestation` native verifier semantics** (COSE chain to the AWS
   Nitro root, document freshness) - framework code, assumed correct. Only the
   module's PCR-match and address-derivation logic were reviewed.
5. **Upgrade-compatibility of struct layouts** across the V10->V11->V12->V13 lineage
   (frozen `Curve`/`AgentSession` layouts, defining-version type pinning). Asserted
   in comments and in AUDIT_NOTES; not diffed against on-chain bytecode. Note the
   latent cross-version hazard F-U1 (legacy-package `buy()` reachability) remains a
   real consideration for the FIRST mainnet upgrade, not the fresh publish.
6. **Test coverage of the session and registry modules is thin.** The 106-test suite
   is overwhelmingly `bonding_curve`; `agent_session` has 2 direct tests
   (`test_agent_session_open_and_buy`, `test_agent_session_wrong_key_rejected`) and
   `enclave_registry` has none. The session and attestation logic was audited by
   reading, not by exercised tests.

---

## Findings

### [B - HIGH] E-1 - The always-online price relayer must hold the same `AdminCap` that drains graduated reserves and mints the 200M LP; the planned multisig mitigation cannot cover the price surface

- **Module / location:** `bonding_curve::set_sui_price` (`bonding_curve.move:299-315`)
  sharing the single `AdminCap` type (`243`) with `claim_graduation_funds`
  (`1198-1230`), `set_paused` (`1102-1109`), `claim_protocol_fees` (`1339-1354`),
  `claim_airdrop_fees` (`1357-1372`), `record_graduation_pool` (`1166-1181`), and the
  entire `enclave_registry` (`create_registry`/`update_pcrs`/`revoke_key`).
- **Description.** Exactly one `AdminCap` is minted, in `init` (`276`). A single
  `AdminCap` type gates every privileged action. The oracle price must be republished
  roughly every 5 minutes (`PRICE_MAX_AGE_MS = 30 min`, `208`; a stale price silently
  falls back to the static `BASE_GRAD_MIST`, `635`), so the relayer's signing key must
  keep an `AdminCap`-reachable, always-online HOT key. That same capability can drain
  the full reserve of every graduated curve and mint a fresh 200,000,000-token LP
  allocation (`lp_supply = TOTAL_SUPPLY - CURVE_SUPPLY`, `1218`) to the caller, pause
  every curve, and claim all protocol/airdrop fees. The documented mitigation
  ("AdminCap -> 2-of-3 multisig before mainnet") cannot autonomously co-sign a push
  every 5 minutes, so on mainnet either a hot single key still holds the aggregated
  cap (the multisig never actually protects `set_sui_price`, and therefore never
  protects the SAME cap's `claim_graduation_funds`), or prices are pushed rarely and
  the sqrt-dampener is effectively dead.
- **Exploit path (Pass E - off-chain relayer key compromise):**
  1. The attacker steals the hot relayer signing key (the key that must reach the
     `AdminCap` to push prices every 5 minutes).
  2. For each already-graduated `Curve<T>`: call `claim_graduation_funds<T>(cap, curve)`
     -> receive a `Coin<SUI>` draining the entire remaining `sui_reserve`
     (`balance::withdraw_all`, `1213`) AND a freshly minted `Coin<T>` of 200M tokens
     (`coin::mint_balance`, `1220`), both returned to the attacker as caller, not to a
     fixed protocol address. Transfer both anywhere.
  3. `set_paused(cap, curve, true)` on every live curve - freeze all trading.
  4. `claim_protocol_fees` / `claim_airdrop_fees` on every curve (proceeds go to
     `tx_context::sender`, `1349`/`1367`).
  5. `update_pcrs` to weaken the attestation registry.
- **Attacker gain:** the drained reserve of every graduated curve plus a 200M-token
  mint per graduated curve, plus all claimable fees, plus a protocol-wide pause.
- **Why B (HIGH), not CRITICAL, and not the previously-settled INFO:** the exploit is
  NOT reachable by an anonymous on-chain caller - it requires off-chain compromise of
  a privileged operator key, so it is a centralization / trust-boundary finding, which
  the methodology rates below the "anyone can drain" Critical bar. It sits at HIGH
  rather than the old F-9 INFO because (a) the reserve-drain + 200M-mint power
  (`claim_graduation_funds` did not exist when F-9 was written) is the single largest
  blast radius in the package and is bound to the same cap, and (b) the structural
  argument that the 5-minute cadence forces that cap to stay hot voids the "multisig
  before mainnet fixes it" acceptance for the price surface specifically. There is a
  graceful-degradation escape that keeps this below Critical: keep `AdminCap` cold in
  multisig, do NOT run the relayer, and accept the stale-price fallback to the static
  `BASE_GRAD_MIST` (`buy()` never aborts on a stale price, `633-635`) - the dampener
  goes quiet but nothing breaks and no key is hot.
- **Offending code:**
  ```
  // bonding_curve.move:299  - the 5-min-cadence hot-key surface ...
  public fun set_sui_price(_cap: &AdminCap, cfg: &mut PriceConfig, price_scaled: u64, clock: &Clock) { ... }
  // ... shares its &AdminCap with, e.g., 1198:
  public fun claim_graduation_funds<T>(_cap: &AdminCap, curve: &mut Curve<T>, ctx): (Coin<SUI>, Coin<T>) {
      ... let sui_out = coin::from_balance(balance::withdraw_all(&mut curve.sui_reserve), ctx);
      let lp_supply = TOTAL_SUPPLY - CURVE_SUPPLY;                        // 200,000,000 * 1e6
      let lp_out = coin::from_balance(coin::mint_balance(&mut curve.treasury, lp_supply), ctx);
      (sui_out, lp_out) }                                                 // both returned to the caller
  ```
- **Recommendation (a cap-semantics change - founder decision, NOT applied by this
  pass):** split the price-push authority out of `AdminCap` into a dedicated,
  minimally-privileged capability (e.g. `PriceRelayerCap`) that gates ONLY
  `set_sui_price`. Mint it in `init` alongside `AdminCap` and hand it to the hot
  relayer key; keep `AdminCap` (graduation drain/mint, pause, fee claims, enclave
  registry) cold in the 2-of-3 multisig. Then the always-online key that gets
  compromised in this scenario can at worst push an in-band price (bounded
  `[MIN,MAX]_PRICE_SCALED`, impact limited to shifted graduation timing within the
  ~900..~28,460 SUI threshold band), never a drain, mint, pause, or fee grab. This is
  the only way to make the documented multisig mitigation actually hold once
  `set_sui_price` requires a hot signer.
- **Disposition:** CONFIRMED by an adversarial verifier that checked all four
  load-bearing claims against the real source. NOT fixed by this pass: the fix changes
  capability semantics (new cap type, `set_sui_price` signature change, an extra mint
  in `init`), which the phase rules route to Carlos. It aligns with, and sharpens, the
  existing CLAUDE.md position that the `AdminCap`/`UpgradeCap` multisig migration is
  MAINNET-BLOCKING - E-1 says that migration is necessary but, for the price surface,
  not sufficient without the capability split.
- **Corpus reference:** Class 10 (upgrade & governance / centralization surface) and
  Class 12 (off-chain trust boundary; a privileged always-online key). Escalation of
  the 2026-07-15 F-9 (AdminCap centralization, INFO), which enumerated neither
  `set_sui_price` nor `claim_graduation_funds`.

---

### [C - MEDIUM] PASS-C-1 - CTO nominate bond is reclaimable mid-window via `unvote_takeover` while the live-proposal marker persists -> near-free perpetual denial of community takeover

- **Module / location:** `bonding_curve::unvote_takeover` (`1848-1867`) interacting
  with `propose_takeover` (`1760-1811`; votes-table insert `1788`, marker add `1803`,
  gate `1769`) and `resolve_takeover` (`1874-1914`; marker remove `1894`, failure
  cooldown `1906`).
- **Description.** `propose_takeover` inserts the proposer into the `votes` table with
  their full nominate stake and sets the `CTO_LIVE_PROPOSAL_KEY` marker on the curve,
  which blocks any second proposal (`assert !df::exists(... CTO_LIVE_PROPOSAL_KEY)`,
  `1769`). `unvote_takeover` lets any voter withdraw before the deadline; its only
  guards are `!resolved`, `now < deadline`, and `table::contains(votes, sender)`. The
  proposer satisfies all three, so the proposer can withdraw their own nominate bond in
  the transaction after proposing - `table::remove` returns the full escrow to the
  caller and drops `total_weight` toward 0 - while the marker stays set (it is removed
  only in `resolve_takeover`, `1894`). The proposal is now a live-but-empty ghost that
  blocks every competing proposal until someone pays to `resolve_takeover` after the
  72h deadline, which on failure stamps a fresh 3-day cooldown from resolve time
  (`1906`) that also blocks proposing.
- **Exploit path (Pass C / D - griefer holding 1% of circulating):**
  1. Target an abandoned curve C (`last_creator_activity_ms >= 5 days`, cooldown clear)
     - exactly the scenario CTO exists to rescue. Own >= 1% of circulating (the
     nominate threshold, `1780`) - freely tradeable inventory, not locked.
  2. Tx1: `propose_takeover<T>(C, stake)`. Escrows the stake, snapshots `quorum_target`,
     sets the marker, shares the proposal (deadline now + 72h).
  3. Tx2: `unvote_takeover<T>(proposal)`. `now < deadline` and the proposer is in the
     table, so the full escrow returns to the attacker and `total_weight` -> 0. The
     proposal stays live; the marker stays on the curve.
  4. For the next 72h no competing proposal can open (`propose` aborts `ECtoProposalLive`).
     After the deadline, `resolve` fails (weight 0 < quorum) and stamps a 3-day cooldown.
     The attacker re-proposes the instant cooldown lapses, cycling roughly every 5.5 days
     at gas-only cost with ZERO capital locked beyond one transaction gap.
- **Attacker gain:** none direct - this is griefing. **Victims lose** the only
  community-recovery mechanism for abandoned tokens: the accrued `creator_fees` and
  future fee stream of any abandoned curve can be denied to legitimate takeover
  indefinitely. If the community tries to reach quorum by voting into the ghost
  proposal, success mints the fresh `CreatorCap` to `proposal.proposer` (`1902-1904`) -
  i.e. it enthrones the griefer, so it is not a rescue.
- **Why C (MEDIUM):** no fund loss, no quorum bypass, no unauthorized takeover absent
  community error, and it only bites already-abandoned curves - but it is a near-free,
  sustainable denial of a shipped safety valve, above the D floor.
- **Offending code:**
  ```
  // bonding_curve.move:1848 - no proposer guard, no total_weight floor, marker untouched
  public fun unvote_takeover<T>(proposal: &mut TakeoverProposal<T>, clock: &Clock, ctx: &mut TxContext) {
      assert!(!proposal.resolved, ECtoAlreadyResolved);
      assert!(clock::timestamp_ms(clock) < proposal.deadline_ms, ECtoVoteClosed);
      let who = tx_context::sender(ctx);
      assert!(table::contains(&proposal.votes, who), ECtoNotVoter);
      let amt = table::remove(&mut proposal.votes, who);
      proposal.total_weight = proposal.total_weight - amt;
      let bal = balance::split(&mut proposal.escrow, amt);
      transfer::public_transfer(coin::from_balance(bal, ctx), who);   // proposer reclaims bond mid-window
  }
  ```
- **Recommendation (CTO governance mechanics - founder decision, NOT applied by this
  pass):** bind the anti-spam nominate bond so it cannot be withdrawn while the proposal
  blocks others. Any one of: (a) forbid the proposer from `unvote_takeover` while they
  are the last remaining voter (require `total_weight` to stay `>= threshold` after any
  unvote); (b) in `unvote_takeover`, if the removal drops `total_weight` below the
  nominate threshold, immediately mark the proposal resolved+failed and remove the
  `CTO_LIVE_PROPOSAL_KEY` marker so a fresh legitimate proposal can open at once; or (c)
  base the post-failure cooldown on `proposal.deadline_ms` rather than resolve time
  (the CTO-2.1 recommendation) so a griefed proposal's cooldown expires on schedule.
- **Disposition:** CONFIRMED by an adversarial verifier that checked all six mechanical
  claims against the real source. NOT fixed by this pass: the fix changes CTO
  governance mechanics, historically a founder decision, and adjacent to the locked
  quorum/window semantics the phase rules protect. This escalates and voids the
  D-rating of the accepted CTO-2.1, whose D severity rested on "the attacker must keep
  1% of circulating locked for the entire blackout (`reclaim_vote` requires
  `resolved`)" - true of `reclaim_vote` (`1925`) but not of `unvote_takeover`, which
  returns the bond mid-window.
- **Corpus reference:** Class 11 (DoS / griefing without direct loss) applied to a
  governance safety valve; the SuiFrens "guard binds the wrong thing" shape.

---

### [D - LOW] PASS-D-1 - `execute_buyback` overshoot bricks `buy()` (Path B computes 0 tokens out) until anyone calls `graduate()`; refines accepted ECON-2

- **Module / location:** `bonding_curve::execute_buyback` (`1644-1682`; reserve join at
  `1662` with no graduation evaluation) composing with `buy()` Path B (`865-888`).
- **Description.** `execute_buyback` is permissionless and joins the whole
  `buyback_fees` bucket into `sui_reserve` but, unlike `buy()`, never evaluates
  graduation. If that push carries `sui_reserve` to `R >= grad_threshold G` without
  graduating, every subsequent `buy()` takes Path B (`sui_reserve_after_swap >= G`),
  computes `needed_swap = 0` because `R >= G`, so `used_swap = 0`,
  `clipped_tokens = quote_out(0) = 0`, `tokens_out = 0`, and aborts `EInsufficientTokens`
  (`888`) before reaching the inline-graduation block. `buy()` is DoS'd for that curve.
- **Impact / self-heal:** pure grief, no attacker gain, no funds locked. It self-heals
  because `graduate_impl` (`1132-1151`) passes (`current_grad_threshold > 0` and
  `sui_reserve >= current_grad_threshold`), so anyone can permissionlessly call
  `graduate<T>` to graduate the curve (which at `R >= G` it is entitled to anyway);
  `buy()` then aborts `EAlreadyGraduated` by design and `sell()` is unaffected. Net:
  buys revert until a `graduate()` tx lands. This is the same root cause as accepted
  ECON-2 (missing graduation evaluation in `execute_buyback`); the only refinement is
  that the prior write-up said the curve "keeps trading above its graduation point"
  whereas the actual behavior is that buys REVERT.
- **Recommendation:** apply the ECON-2 fix - after the reserve join in
  `execute_buyback`, mirror `buy()`'s graduation tail:
  `if (token_reserve == 0 || (current_grad_threshold > 0 && sui_reserve >= current_grad_threshold)) do_graduate_inline(...)`.
  Bundle with the SP-01 mechanical fix (`assert !paused` at the top of
  `execute_buyback`). Deferred as it changes when graduation fires (founder should
  confirm the intended buyback/graduation interaction), consistent with ECON-2's
  original deferral.
- **Disposition:** NOT new (refines accepted ECON-2). NOT fixed (graduation-timing
  semantics, founder decision).

---

### [E - INFO] PA-1 - The graduation clip lands the reserve slightly ABOVE the threshold, not exactly on it; the "clip to exactly hit the threshold" comments overstate precision (protocol-favorable, not exploitable)

- **Module / location:** `bonding_curve::buy` Path A/B (`856-886`) and the fee recompute
  (`895-950`).
- **Description.** The header and inline comments say Path B clips "to exactly hit the
  threshold; refund the overshoot." In fact the reserve receives
  `to_reserve = swap_amount + lp_fee` while `tokens_out` is quoted on
  `used_swap = needed_swap`, so the reserve overshoots `grad_threshold` by a fee-scaled
  amount (~0.1-1% of `sui_in`). Graduation still always fires (`should_graduate` checks
  `new_reserve >= grad_threshold`, `958-961`). The deviation is strictly
  buyer-unfavorable / protocol-favorable (the buyer contributes more SUI to reserve than
  the token payout justifies), money is fully conserved (payment remainder =
  `tail_refund` exactly), and it cannot be steered to pay less than `needed_swap`
  (that would require `needed_swap > 1.09 * sui_in`, impossible since
  `needed_swap <= 0.99 * sui_in`). Not a fund risk.
- **Recommendation:** documentation only - soften the "clip to exactly hit the
  threshold" comments to note the reserve overshoots by a fee-scaled, protocol-favorable
  amount and that graduation firing is guaranteed by `should_graduate`, not by an exact
  landing. Optionally add a real-path test asserting `final sui_reserve >= grad_threshold`
  (not `==`) after a Path-B clip buy.
- **Disposition:** NOT fixed (documentation nicety, no safety impact).

---

## Reconfirmed closures (prior A/B findings, re-verified line-by-line in this package)

Each was traced against the current source, not taken on faith from the prior reports:

- **F-1 (CRITICAL, unbacked pre-mint):** CLOSED. `create_and_return` asserts
  `coin::total_supply(&treasury) == 0` before minting `CURVE_SUPPLY`
  (`bonding_curve.move:702`, `EPreMintedSupply`). Under Move, `total_supply == 0`
  <=> no coins of `T` exist, and the cap is then consumed into the curve, so no
  unbacked pile can be created. Regression: `test_f1_premint_aborts_launch`.
- **F-2 (HIGH, unbounded caller-supplied oracle price):** CLOSED. The price is no
  longer a caller argument; `buy` reads a shared `PriceConfig` written only by
  `set_sui_price` (AdminCap-gated, bounded `[MIN,MAX]_PRICE_SCALED`, `305-308`), with a
  staleness fallback that never aborts (`632-637`). `current_grad_threshold` is a
  display cache, never read back for the decision (`828-830`). Standalone `graduate_impl`
  additionally requires `current_grad_threshold > 0` (`1144-1149`), and the mint-site
  floor `MIN_GRAD_RESERVE_MIST` bounds the OUTPUT independent of any oracle bug
  (`1207-1208`). Regressions: `test_set_sui_price_rejects_below_min` / `_above_max`,
  `test_graduate_rejects_zero_threshold_fresh_curve`,
  `test_claim_graduation_funds_rejects_trivial_reserve`.
- **F-4 (MEDIUM, 31.6x threshold scaling error):** CLOSED. The spurious `/ 1_000` is
  gone; `den = isqrt(price_scaled * precision)` (`617`). Verified numerically: `$1` ->
  9,000 SUI, `$100` -> 900 SUI, matching the calibration table. Regression:
  `test_published_price_dampens_threshold`.
- **F-5 (MEDIUM, LP fee refunded to buyer):** CLOSED. `to_reserve = swap_amount + lp_fee`
  (`948`); the returned payment is exactly `tail_refund`, and `lp_fees_accumulated` is
  now backed by real SUI. Regressions: `test_normal_buy_refund_is_zero_lp_fee_in_reserve`,
  `test_grad_clip_conservation`.
- **F-7 (LOW, comment author spoof):** CLOSED. `post_comment` emits
  `author: tx_context::sender(ctx)` (`1430`); the caller-supplied `author` parameter is
  removed. Regression: `test_comment_author_is_tx_sender`.
- **F-10 (INFO, test shadow path):** CLOSED. `buy_for_testing` is a zero-logic delegator
  to production `buy()` (`1988-1999`); `graduate_for_testing` and `graduate()` both route
  through `graduate_impl`. No `*_for_testing` function carries fee/threshold/graduation
  arithmetic.
- **F-3 (HIGH, CTO vote double-count) + F-AC-1 (CTO dead-on-arrival):** CLOSED by the
  escrow-weighted redesign. Weight is a `Coin<T>` locked into the shared proposal's
  escrow (`coin::into_balance`, `1795`/`1828`); the same token cannot be counted twice
  under linear typing, and the proposal is a shared object reachable across txs.
  Regressions: `test_cto_f3_double_count_impossible`, `test_cto_shares_the_object`.
- **CTO-4.0 (B, circ==0 free takeover):** CLOSED. `propose_takeover` asserts `circ > 0`
  and `amount > 0` (`1776`/`1779`, `ECtoZeroCirculating`); `resolve_takeover` treats
  `quorum == 0` and a zero tally as automatic FAIL (`1890`). Regressions:
  `test_cto_propose_zero_circulating_aborts`, `test_cto_propose_zero_stake_aborts`.
- **CTO-6.0 (B, live-quorum manipulation):** CLOSED. `quorum_target` is snapshotted at
  propose time (`1784`/`1798`) and `resolve` compares `total_weight` against the frozen
  snapshot, not live `circulating_supply` (`1889`). Regression:
  `test_cto_quorum_snapshot_survives_supply_inflation`.

---

## Invariant checklist

Each invariant: ENFORCED with the enforcing line, or the finding it maps to.

| Invariant | Status |
|-----------|--------|
| **Supply conservation** - tokens mint ONLY via the curve; `TreasuryCap` unreachable except through it | ENFORCED. `create_and_return` requires `total_supply == 0` then mints `CURVE_SUPPLY` and locks the cap into the curve (`702-723`). The only post-launch mint is `claim_graduation_funds` minting `TOTAL_SUPPLY - CURVE_SUPPLY` = 200M once (guarded by `GRAD_CLAIMED_KEY`, `1205-1210`). Total minted over the curve life = `CURVE_SUPPLY + 200M = TOTAL_SUPPLY`, exactly. |
| **Fee conservation** - splits sum to 100%, every slice actually collected, no caller-controlled slice beyond bounded referral | ENFORCED. `split_fee_v7` sums to `fee` exactly (`555-564`); the buyback carve is taken from the creator slice so the identity is preserved (`907-908`); `to_reserve = swap_amount + lp_fee` collects the LP slice (F-5 fix, `948`); sell retains LP in reserve (`withdraw_amount = gross - lp`, `1058`). Symbolically re-derived on all three buy paths + sell: total removed = `effective_sui_in`, remainder = `tail_refund`. Referral is bounded and `!= creator` (`814-816`); self-referral-by-second-wallet is the accepted ECON-1. |
| **Escrow conservation (sessions)** - escrow exits only to the owner | ENFORCED. `close_session` returns to caller==owner (`521-533`), `expire_refund` transfers to `session.owner` not the caller (`549`), `sweep_token` is owner-only to owner (`554-562`). No caller-directed escrow exit. `credit_spent` clamps net exposure at zero (`256-259`); the cap is checked before every spend (`296-297`, `407-409`). |
| **Escrow conservation (takeover votes)** - `escrow == sum(votes)` on every path; each voter reclaims exactly their stake | ENFORCED. Propose escrows the stake and records it (`1788`/`1795`); vote joins escrow and adds the table entry by the same amount (`1828-1836`); unvote removes the entry and splits the same amount out (`1858-1861`); reclaim removes and splits the same amount to the voter, never the caller (`1927-1929`). `total_weight` is a frozen tally after resolve and is intentionally not changed by reclaim. The invariant holds; PASS-C-1 is a governance-liveness grief, not a conservation break. |
| **Threshold integrity** - graduation trigger/threshold cannot be set by an untrusted caller | ENFORCED for the buy path (oracle price is AdminCap-only and bounded; F-2 closed). The remaining threshold-adjacent risk is centralization: the price is protocol-published (E-1 / disclosed centralization), and `execute_buyback` can cross the threshold without graduating (PASS-D-1 / ECON-2). |
| **Cap authority** - a capability authorizes only its own curve; a taken-over creator's stale cap is dead everywhere | ENFORCED. `assert_active_creator` requires `cap.curve_id == object::id(curve)` AND `object::id(cap) == curve.active_creator_cap_id` (`572-576`), and all six creator-gated functions call it (`update_metadata` `1251`, `update_payouts` `1296`, `claim_creator_fees` `1311`, `set_comment_gate` `1387`, `set_buyback_config` `1629`, `creator_heartbeat` `1691`). `resolve_takeover` mints a fresh cap and swaps `active_creator_cap_id`, invalidating the old cap on every gated function (`1897-1904`); `proposal.curve_id == object::id(curve)` is asserted (`1880`) so a proposal for curve A cannot swap curve B's cap. |
| **Graduation idempotence / reserve moves once** | ENFORCED. `!graduated` guards `buy`/`sell`/`execute_buyback`/`graduate_impl`; bonuses paid once in `do_graduate_inline`; `claim_graduation_funds` one-shot via `GRAD_CLAIMED_KEY` set before the mint/drain (`1205-1210`). Regressions: `test_cannot_graduate_twice`, `test_claim_graduation_funds_twice_aborts`. |
| **Session sender binding** - `sender == session_address` on every trade | ENFORCED in `assert_can_trade` (`247`), called by all four trade entries; `revoked` and `expiry_ms` checked; `expiry_ms == 0` closed sentinel; the universal-trading flag is owner-only so a compromised session key cannot self-escalate (`373-379`). |
| **Parked-coin DOF type binding** | ENFORCED. `park_tokens`/`sweep_token`/`sell_with_session`/`borrow_tokens_for_sell` key by `type_name::with_defining_ids<T>()` with typed `dof` ops (`268`, `341-342`, `466-467`, `559-560`). Residual: `settle_sell` does not bind the ticket's token type (accepted AS-1, universal trading off). |
| **TradeTicket bound to its session and direction** | ENFORCED. `settle_buy`/`settle_sell` assert `session_id == object::id(session)` and `kind` (`431-433`, `486-488`); leftover credit clamped to `borrowed` (`437`). |
| **Attested open requires a chain-verified key** | ENFORCED. `open_and_share_attested` asserts `is_registered` (`217-220`); `register_enclave_key` is permissionless but gated by a native-verified `NitroAttestationDocument` + strict PCR0/1/2 match + 32-byte ed25519 check + address derivation (`enclave_registry.move:119-137`, `145-162`). |

---

## Centralization & disclosure

- **`AdminCap` (single key until multisig migration):** pauses any curve, drains any
  graduated reserve and mints the 200M LP (`claim_graduation_funds`), publishes the
  oracle price (`set_sui_price`), claims protocol/airdrop fees, records graduation
  pools, and fully controls the `EnclaveRegistry`. Exactly one is minted. **E-1 (B)
  above** is the sharpened disclosure: because the price must be pushed every ~5
  minutes, this cap cannot be both hot-enough to relay prices and cold-enough to be
  multisig-protected without the capability split. Route to Carlos as a
  mainnet-blocking decision.
- **`UpgradeCap` (V10 lineage):** can replace all module bytecode; types pinned at the
  V10 defining version (asserted in comments, not diffed here). The FIRST mainnet
  upgrade re-opens the latent cross-version `buy()` reachability (F-U1) unless a version
  marker is added before then.
- **Price relayer:** the graduation threshold is computed from a protocol-published
  number; every write emits `SuiPriceUpdated` as an audit trail. The number is bounded
  at the setter, so a fat-finger cannot write garbage, but the relayer is a trusted
  oracle.
- Per CLAUDE.md, moving `AdminCap`/`UpgradeCap` to multisig plus a paid human audit are
  explicit mainnet gates. This report supports neither as a substitute, and E-1 shows
  the multisig gate needs the capability split to actually cover the price surface.

---

## Appendix A: reaffirmed clean surfaces

Verified clean by the passes (each independently checked against source):

**Arithmetic (Pass A):** no bit-shift operators exist in source; `quote_out` widens to
`u128` and rounds down (protocol-favorable) with a non-zero denominator via the virtual
reserve; `dampened_grad_threshold` overflow-safe (`BASE * num = 2.85e17 < u64::MAX`,
price bounded so `price*1e6 <= 1e11`); `isqrt` converges, no DoS; `do_graduate_inline`
bonuses and `vested_amount` (u128) safe; `credit_spent` underflow-safe and clamped;
CTO BPS math has ~9x headroom (`circ*2500 <= 2e18`); `effective_token_reserve` cannot
underflow (`token_reserve <= CURVE_SUPPLY`); all threshold comparisons (`expiry`, CTO
deadline `<` vs `>=`, metadata/anti-bot/cooldown windows) are non-overlapping
partitions; `fee = amount * BPS / 10000` overflows only for self-griefing
~1.8e17-mist trades (aborts, not extractable).

**Capabilities (Pass B):** `assert_active_creator` applied on all six gated functions;
CTO cap swap correct and old cap invalidated everywhere; single-live-proposal marker
lifecycle sound (one add, one remove, no cross-curve strip); `TradeTicket` binds
session + kind with clamped leftover credit; session sender binding on all four trade
entries; session authority only ever narrows (revoked=true / expiry_ms=0, owner or
post-expiry); escrow exits only to owner; parked-coin DOFs keyed by defining type;
`AdminCap` surface enumerated; no `public fun` returns `&mut` to sensitive state, no
`friend`/`public(package)`/`entry` declarations; `PriceConfig` is `key`-only and not
forgeable by non-admin; `post_comment` author is the tx sender.

**Integrator (Pass E):** narrow-path session custody has no path to an arbitrary
address under key compromise; `enable_universal_trading` is owner-only so a compromised
key stays confined to `suipump::bonding_curve` with proceeds returning to escrow;
`PriceConfig` has no permissionless writer; session trades hardcode `option::none`
referral; Move events cannot be fabricated by a compromised indexer; the 200M-LP mint
has three independent barriers; `credit_spent` clamps at zero; `register_enclave_key`
is gated by the native attestation verifier. (The parent_id reply tree is
indexer-forgeable - accepted SP-03.)

## Appendix B: every scaling / fixed-point site and the boundary verified

*No bit-shift (`<<`/`>>`) operators exist in the contract source.*

| Site | File:line | Widening / guard | Boundary verified |
|------|-----------|------------------|-------------------|
| `quote_out = (y*dx)/(x+dx)` | bonding_curve:536-541 | `u128` before multiply | `y,dx < 2^64 => product < 2^128`; denom > 0 via virtual reserve; rounds down. |
| Path-A reverse AMM `x*rem/(y-rem)` | 860-861 | `u128` | `y - rem = VIRTUAL_TOKEN_RESERVE - CURVE_SUPPLY = 273M` constant > 0. |
| `fee = sui_in * BPS / 10000` | 841, 896, 1048 | `u64` | overflow only > ~1.8e17 mist (aborts). |
| `split_fee_v7` | 555-564 | `u64` | sums to `fee`; LP slice collected (F-5). |
| buyback carve `creator_full * bps / BPS` | 907, 1053 | `bps <= BPS` (guard 1630) | `<= creator_full`, no underflow. |
| `isqrt` | 582-591 | `u64` | converges; inputs <= 1e11. |
| `dampened_grad_threshold` num/den | 613-620 | `price==0`/`den==0` guarded; price in `[100,100000]` | F-4 fixed; output `[900, 28460]` SUI; no overflow. |
| grad bonuses `reserve * 50 / BPS` | 1002-1003 | `u64` | reserve << 2^64; paid once. |
| `claim_graduation_funds` mint | 1218-1220 | one-shot + reserve floor | `lp_supply = 200M*1e6`; supply conserved to `TOTAL_SUPPLY`. |
| `vested_amount` linear/monthly | 1521-1536 | `u128` | divisors > 0 by enum; claimable clamped. |
| CTO `circ * BPS / 10000` | 1777, 1784, 1825 | `u64` | `circ*2500 <= 2e18`; quorum snapshot; circ>0/amount>0 guards. |
| `credit_spent` clamp | agent_session:256-259 | `min(amount, spent)` | underflow-safe, clamped at zero. |
| `spent + amount <= spend_cap` | agent_session:296, 408 | pre-spend | correct ordering; net-exposure caveat is accepted F-6. |

---

*End of report. Findings are static-analysis derived and verified against source;
none were executed on-chain. E-1 and PASS-C-1 are the two new items requiring a
founder decision before mainnet; both fixes change locked semantics (capability
authority / CTO governance) and were therefore reported, not applied. Commission the
paid human audit (MoveBit) and complete the AdminCap/UpgradeCap multisig migration -
with the E-1 capability split - before mainnet, as CLAUDE.md requires.*
