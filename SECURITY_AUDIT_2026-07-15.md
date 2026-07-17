# Security Audit — SuiPump V10 lineage contracts + off-chain trust boundary

- **Scope:** `contracts-v10/sources/bonding_curve.move`, `contracts-v10/sources/agent_session.move`, `contracts-v10/sources/enclave_registry.move`, `coin-template/sources/template.move`, and the off-chain trust boundary (Class 12 / Pass E).
- **Commit:** `e54dbc06bcc4fe084d55b6d815d193f14005297d` (2026-07-14)
- **Date:** 2026-07-15
- **Auditor:** adversarial automated pass (Passes A–E), read-only.

---

## RESOLUTION LEDGER (added 2026-07-17)

This document is a POINT-IN-TIME audit of commit
`e54dbc06bcc4fe084d55b6d815d193f14005297d` (2026-07-14). Every finding below has
since been resolved or explicitly accepted; the original finding text is preserved
unchanged beneath this ledger for the historical record. Cross-references:
`contracts-v10/AUDIT_NOTES.md` (accepted-finding rationale), the two internal
re-audits `contracts-v10/SECURITY_REAUDIT_2026-07-16.md` and
`contracts-v10/SECURITY_REAUDIT_2026-07-17_PREPUBLISH.md`. As of 2026-07-17 the full
suite is `sui move test` = 115/115, zero warnings. Commit hashes are given in full.

**Deployment note (2026-07-17):** the fixes above shipped in V13, which was PUBLISHED
as a FRESH PUBLISH, not an upgrade of the V10 lineage. The `compatible` upgrade policy
forbids the public-signature changes that constitute the F-2 fix (`buy` /
`buy_with_session` `sui_price_scaled: u64` -> `&PriceConfig`, `post_comment` 7 -> 6
params) and the CTO struct changes, so a fresh publish was the only path. V13 therefore
has its own type identity (V13 curves are not V10-typed). The full live-id publish
record is in `SECURITY_REAUDIT_2026-07-17_PREPUBLISH.md`.

| ID | Sev | Status | Resolution (fixing commit + regression test) |
|----|-----|--------|----------------------------------------------|
| F-1 | CRITICAL | FIXED | `create_and_return` asserts `coin::total_supply(&treasury) == 0` (`EPreMintedSupply`) before minting, so no unbacked pre-mint can reach the curve. Commit `b0b5dd35d52c7fb4bb26c218d7ed52ffcacd5366` (V13 PriceConfig + graduation source changes). Test `test_f1_premint_aborts_launch`. |
| F-2 | HIGH | FIXED | The oracle price is no longer caller-supplied: `buy` reads a shared `PriceConfig` written only through a capability, bounded to `[MIN,MAX]_PRICE_SCALED` with a staleness fallback that never aborts; the standalone `graduate_impl` requires `current_grad_threshold > 0`, and `claim_graduation_funds` enforces the `MIN_GRAD_RESERVE_MIST` floor. Commits `b0b5dd35d52c7fb4bb26c218d7ed52ffcacd5366` (PriceConfig buy path) and `f610e257f992bce015bc58740e02c24dbcaf6304` (`create_price_config` bootstrap). Tests `test_set_sui_price_rejects_below_min`, `test_set_sui_price_rejects_above_max`, `test_published_price_dampens_threshold`, `test_graduate_rejects_zero_threshold_fresh_curve`, `test_claim_graduation_funds_rejects_trivial_reserve`. **Object-form variant (PREPUBLISH-2, 2026-07-17, commit `0ef9b03285408c12606b2369e41341663817b9c8`):** `init` originally left the one-shot marker unset, so a fresh publish could share a SECOND `PriceConfig` and - since `resolve_grad_threshold` does no identity check - a caller could reselect the threshold by choosing which config object to pass. `init` now sets the marker, guaranteeing exactly one `PriceConfig`/`PriceRelayerCap` per package on both publish paths. Tests `test_init_marks_price_config_created_fresh_publish`, `test_init_mints_exactly_one_relayer_cap` (see `contracts-v10/SECURITY_REAUDIT_2026-07-17_PREPUBLISH.md` addendum 2). |
| F-3 | HIGH | FIXED (was proposed ACCEPTED) | Redesigned to escrow-weighted voting: weight is a `Coin<T>` LOCKED into the shared proposal escrow (`coin::into_balance`), so the same token cannot be moved to a second wallet and counted twice under Move linear typing. Not accepted; genuinely fixed. Commit `f5b808857d2081b1fd9e6de5274286eaa2934c9f`. Test `test_cto_f3_double_count_impossible`. |
| F-4 | MEDIUM | FIXED | The spurious `/ 1_000` in `dampened_grad_threshold`'s denominator was removed (`den = isqrt(price_scaled * precision)`), so the sqrt-dampened threshold is correct (verified `$1` -> 9,000 SUI, `$100` -> 900 SUI). Commit `b0b5dd35d52c7fb4bb26c218d7ed52ffcacd5366`. Test `test_published_price_dampens_threshold`. |
| F-5 | MEDIUM | FIXED | `buy` now retains the LP fee in the reserve (`to_reserve = swap_amount + lp_fee`); the returned payment is exactly `tail_refund` and `lp_fees_accumulated` is backed by real SUI. Commit `b0b5dd35d52c7fb4bb26c218d7ed52ffcacd5366`. Tests `test_normal_buy_refund_is_zero_lp_fee_in_reserve`, `test_grad_clip_conservation`. |
| F-6 | MEDIUM | ACCEPTED (founder decision) | `spend_cap` is V11 NET exposure by design; accepted because a compromised session key is bounded to one user's escrow under per-user Turnkey/enclave keys and the retired shared-wallet fallback. Rationale and the fallback-session census are in `AUDIT_NOTES.md` (F-6). |
| F-7 | LOW | FIXED | `post_comment` emits `author = tx_context::sender(ctx)`; the spoofable caller-supplied `author` parameter was removed. Commit `7118c6ec8b5d754f414477fc91cfed680cd7d6be`. Test `test_comment_author_is_tx_sender`. |
| F-8 | LOW | SUPERSEDED (by F-2 fix) | Permissionless `graduate()` no longer reads a caller-poisonable threshold: the price cannot be caller-set (F-2), `current_grad_threshold` is a display cache never read back for the buy-path decision, and `graduate_impl` requires `current_grad_threshold > 0` so a fresh curve cannot be force-graduated. Commit `b0b5dd35d52c7fb4bb26c218d7ed52ffcacd5366`. Test `test_graduate_rejects_zero_threshold_fresh_curve`. |
| F-9 | INFO -> HIGH (E-1) | PARTLY RESOLVED; remainder OPEN-until-mainnet (F-14) | The price-publish surface is split into a dedicated `PriceRelayerCap` gating `set_sui_price` alone (no AdminCap path), so the hot relayer key can only push a clamped price and can never drain reserves, mint the 200M LP, pause, or claim fees. Commit `9fcbd6d5192ba15bc49b993c432bccdccabd77a2` (finding E-1 in the 2026-07-17 pre-publish re-audit). Tests `test_price_relayer_cap_sets_price`, `test_set_sui_price_gated_on_relayer_cap_only`, `test_create_price_config_mints_relayer_cap`, `test_admin_cap_still_pauses_after_relayer_split`. The remaining AdminCap powers (pause, `claim_graduation_funds`, fee claims, `record_graduation_pool`, enclave registry) stay a disclosed centralization surface pending the AdminCap/UpgradeCap multisig migration, tracked as F-14 and MAINNET-BLOCKING (see `AUDIT_NOTES.md` F-9/F-14). |
| F-10 | INFO | FIXED | `buy_for_testing` is now a zero-logic delegator to the production `buy()`, and `graduate_for_testing`/`graduate()` both route through `graduate_impl`; no test-only function carries fee/threshold/graduation arithmetic, so the green build now exercises the real path. Commit `f0c64c298c45bb74d7c9e850dcad9751b63cf57e`. |

Findings first surfaced in later passes (F-AC-1, the CTO-4.0/CTO-6.0 B findings,
E-1, PASS-C-1) are tracked in the re-audit reports and `AUDIT_NOTES.md`; E-1 and
PASS-C-1 were fixed 2026-07-17 (commits `9fcbd6d5192ba15bc49b993c432bccdccabd77a2`, `2b2d764dea07398403515998cff2b9a69e279889`).

---

## Summary

- **Modules audited:** 4 production Move modules (`bonding_curve`, `agent_session`, `enclave_registry`, `template`) + off-chain boundary review.
- **Public / entry functions counted:** 51 `public fun` in `bonding_curve.move` (of which ~24 read-only accessors, 4 `#[test_only]`), 24 `public fun` in `agent_session.move`, 6 `public fun` in `enclave_registry.move`, `template::init`. See Appendix A.
- **Money-movers (full adversarial treatment):** `create_and_return`, `buy`, `sell`, `graduate`/`do_graduate_inline`, `claim_creator_fees`, `claim_protocol_fees`, `claim_airdrop_fees`, `execute_buyback`, `collect_protocol_surcharge`, `resolve_takeover`, `lock_tokens`/`claim_vested` (bonding_curve); `open_session`, `top_up_session`, `buy_with_session`, `sell_with_session`, `borrow_for_buy`/`settle_buy`, `borrow_tokens_for_sell`/`settle_sell`, `close_session`, `expire_refund`, `sweep_token` (agent_session).

### Findings by severity

| Severity | Count | IDs |
|----------|-------|-----|
| CRITICAL | 1 | F-1 |
| HIGH     | 2 | F-2, F-3 |
| MEDIUM   | 3 | F-4, F-5, F-6 |
| LOW      | 2 | F-7, F-8 |
| INFO     | 2 | F-9, F-10 |

### Posture

The curve math avoids the Cetus class entirely — there is **no bit-shift operator anywhere in the contract source** (every `<<`/`>>` match is generic-type syntax `<Curve<T>>` in the test file), and the AMM `quote_out` widens to `u128` before multiplying. That is genuinely good. However, this pass found one CRITICAL supply-integrity flaw (unbacked pre-mint draining the curve reserve), two HIGH flaws (unbounded caller-supplied oracle price forcing premature graduation; a governance double-vote that makes hostile takeover nearly free), and a demonstrable ~31.6x scaling error in the graduation-threshold formula that the Move unit tests structurally cannot catch (they bypass `dampened_grad_threshold` via `set_grad_threshold_for_testing`/`buy_for_testing`).

**This is an automated first pass, not a substitute for a human audit. Cetus was audited by OtterSec, MoveBit and Zellic; all three missed the bug that cost $223M. Clean output here means nothing was found by this pass, not that the code is safe.**

---

## Not Verified

This pass did **not** verify, and a human audit must cover:

1. **The graduation → DEX-LP migration path.** These modules set `graduated=true`, pay 0.5%+0.5% bonuses, and `record_graduation_pool` only records IDs. There is **no on-chain function in scope that withdraws `sui_reserve` or `token_reserve`, and none that mints the "200M for LP" the comments reference.** Where/how the reserve and unsold tokens leave a graduated curve is unverified; if there is no such path, all post-graduation reserves are stranded on-chain (this materially worsens F-2). Locate and audit that module.
2. **Live behavior / runtime state.** No transactions were executed against testnet; all findings are static. BigInt/u64 boundary behavior at extreme (but reachable) inputs was reasoned, not run.
3. **The off-chain layer itself** (`suipump-nexus-tools/bridge.js`, `agent-runner/strategy.js`, `frontend-app/api/*`). I reviewed only what the CONTRACT guarantees independent of them (Pass E). The referenced PR #5 (/launch privateKey/devBuySui) and PR #6 (wallet-signed-auth) mitigations are frontend/proxy controls and were treated as **non-controls** per the methodology.
4. **`sui::nitro_attestation` native verifier semantics** — assumed correct (it is framework code). PCR-matching logic in `enclave_registry` was reviewed; the native COSE/root-CA verification was not.
5. **Upgrade-compatibility claims** (frozen struct layout, defining-version type pinning across V10→V11→V12). Asserted in comments; not independently diffed against on-chain bytecode.
6. **The `#[test_only]` `buy_for_testing`** ships in the source file; whether it is stripped from the published bytecode was not verified (if not stripped, it is a live entry that bypasses the oracle path — see F-10).
7. **Cross-package legacy V4–V9 curves** and the universal-trading DEX venues — out of these sources.

---

## Findings

### [CRITICAL] F-1 — Unbacked token pre-mint via retained `TreasuryCap` drains the curve reserve

**Module / location:** `coin_template::template::init` (`coin-template/sources/template.move:33-54`) + `suipump::bonding_curve::create_and_return` (`contracts-v10/sources/bonding_curve.move:534-566`).

**Description.** `template::init` hands the `TreasuryCap<T>` to the publisher (`transfer::public_transfer(treasury, tx_context::sender(ctx))`). `create_and_return<T>` accepts that cap by value and immediately mints `CURVE_SUPPLY` into the curve — but it **never asserts the incoming treasury has zero prior supply**. `sui::coin::mint` is a public function callable by any holder of the cap. Between publish and `create_and_return` (two transactions in the real launch flow, or via a custom coin module entirely), the creator fully controls the cap and can mint arbitrary unbacked tokens to themselves. Those tokens are then sellable into the curve via `sell<T>`, which pays out real SUI deposited by honest buyers. The core bonding-curve safety property — *fixed supply, all tokens flow through the curve* — is not enforced on-chain.

**Exploit path (attacker = malicious token creator):**
1. Publish a coin module of type `T` (the shipped template, or any custom module with a `TreasuryCap<T>`). `init` transfers the cap to the attacker; supply = 0.
2. `sui::coin::mint<T>(&mut cap, 800_000_000_000_000, attacker)` — mint a large unbacked balance to self (cap is attacker-owned).
3. `bonding_curve::create_and_return<T>(cap, 2 SUI, …)` — mints another `CURVE_SUPPLY` into `token_reserve`, shares the `Curve<T>`. The token now appears as a legitimate SuiPump curve (emits `CurveCreated`); the cap is now locked inside the curve.
4. Honest buyers call `buy<T>`, funding `curve.sui_reserve` with SUI.
5. Attacker calls `sell<T>` with the pre-minted tokens. `sell` pays `withdraw_amount = gross_sui_out - lp_fee` from `curve.sui_reserve` (line 913-919), draining honest buyers' SUI. Attacker can extract up to the amount others bought (the `effective_token_reserve` underflow guard at line 401 caps a single over-sell but not the theft).

**Attacker gain:** essentially the entire real `sui_reserve` funded by other buyers.

**Offending code:**
```
// template.move:53
transfer::public_transfer(treasury, tx_context::sender(ctx));
```
```
// bonding_curve.move:565-566   (no supply guard before the mint)
let token_supply = coin::mint(&mut treasury, CURVE_SUPPLY, ctx);
```

**Recommendation.** In `create_and_return<T>`, before minting, assert the treasury is virgin:
`assert!(coin::total_supply(&treasury) == 0, ESomeNewError);`
This is a clean, honest-launch-safe check (legitimate launches always have 0 supply at this point) and closes the unbacked-mint drain regardless of whether the launch is one PTB or two txs.

**Corpus reference:** economic-integrity / supply invariant (Part 3 §7 — "supply mints ONLY via the curve; TreasuryCap unreachable except through it"). The invariant is stated in the code's own comments but not enforced.

---

### [HIGH] F-2 — Unbounded caller-supplied `sui_price_scaled` forces premature graduation of any curve

**Module / location:** `suipump::bonding_curve::buy` → `resolve_grad_threshold` → `dampened_grad_threshold` (`bonding_curve.move:663-693`, `458-467`, `492-506`).

**Description.** `buy<T>` takes `sui_price_scaled: u64` directly from the caller and passes it, unbounded and unchecked, into `dampened_grad_threshold`. The resolved threshold scales as `~ BASE_GRAD_MIST * 1000 / sqrt(price_scaled)` (see F-4 for the exact form), so a **large** `price_scaled` drives the graduation SUI threshold arbitrarily low. There is no sanity bound, no oracle authentication, and the caller-chosen value is even **persisted** to `curve.current_grad_threshold` (line 693), poisoning subsequent fallback buys and the standalone `graduate()`. `buy` is `public` and the `Curve` is a shared object, so anyone can call it against anyone's curve.

**Exploit path (attacker = griefer):**
1. Target a freshly launched curve `C` (`sui_reserve == 0`, not graduated).
2. Call `buy<T>(C, payment ≈ 3 SUI, min_tokens_out = 0, none, sui_price_scaled = 18_400_000_000_000, clock, ctx)`. (`price_scaled` is bounded below the u64 overflow of `price_scaled * precision` at line 464, ~`1.8e13`.) `dampened_grad_threshold` returns ≈ **2.87 SUI** instead of the intended ≈12,305 SUI.
3. In `buy`, `sui_reserve_after_swap (≈3 SUI) >= grad_threshold (2.87 SUI)` → Path B clips the swap to hit the threshold, then `should_graduate` is true → `do_graduate_inline` runs and sets `graduated = true`.
4. The curve is now permanently frozen for bonding-curve trading (every `buy`/`sell` aborts on `assert!(!curve.graduated)`). ~99.98% of `CURVE_SUPPLY` remains unsold in `token_reserve`, and (per Not-Verified #1) with no on-chain reserve-migration path in scope, the reserve and unsold tokens are stranded.

**Attacker gain:** none direct (griefing); **victims lose** the ability to trade the curve and — pending the migration-path question — access to the stranded reserve/tokens. Cost to attacker ≈ 3 SUI + fee, versus the ~12,305 SUI a legitimate graduation requires. Every launch is force-graduatable on demand.

**Offending code:**
```
// bonding_curve.move:668  — caller-supplied, never bound-checked
sui_price_scaled: u64,    // v9: floor(sui_usd * 1000); 0 = use fallback
...
// 690-693
let (grad_threshold, new_stored_threshold) =
    resolve_grad_threshold(curve, sui_price_scaled);
curve.current_grad_threshold = new_stored_threshold;   // attacker value persisted
```

**Recommendation.** Do not trust a per-call caller-supplied price for a state-changing threshold. Either (a) read Pyth on-chain in the same PTB via a verified price object rather than a bare `u64`, or (b) clamp `sui_price_scaled` to a sane band (e.g. `MIN_PRICE_SCALED <= p <= MAX_PRICE_SCALED`) and reject out-of-band values, and (c) do not let a single buy's caller-supplied price permanently overwrite `current_grad_threshold` (bound the per-buy delta, or only accept an admin/oracle-signed update).

**Corpus reference:** Cetus 2.1 lens — "`sui_price_scaled` is caller-supplied input to `buy()` … Does `buy()` bound-check it at all, or trust the caller?" Answer: it does not.

---

### [HIGH] F-3 — CTO vote double-counting: transfer the same coins between votes to fabricate weight → nearly free hostile takeover

**Status: FIXED (this change set -- escrow-weighted CTO redesign, commit `f5b80885`).** Severity classification unchanged (originally HIGH); disposition is now resolved. Vote weight is no longer read from a live transferable balance: the CTO governance was redesigned so weight comes from a `Coin<T>` LOCKED into the proposal's escrow (`coin::into_balance` consumes the coin at vote time), with votes keyed per-voter address. A locked coin physically cannot be moved to a second wallet to re-vote, and under Move linear typing the same token cannot be counted twice. Regression coverage: `test_cto_f3_double_count_impossible` (coin escrowed, a second wallet cannot add weight, each token counted once) plus the full CTO family (21 CTO tests: propose/vote/unvote/resolve/reclaim/cooldown) in `contracts-v10/sources/bonding_curve_tests.move`. Suite: `sui move test` = 103/103, zero warnings. See `contracts-v10/AUDIT_NOTES.md` (F-3) and the re-audit addendum in `contracts-v10/SECURITY_REAUDIT_2026-07-16.md`. Original finding preserved below.

**Module / location:** `suipump::bonding_curve::vote_takeover` (`bonding_curve.move:1561-1586`), `resolve_takeover` (`1592-1641`).

**Description.** Vote weight is the **live** balance `coin::value(holder_coin)` at vote time, and the `voted` table is keyed by the **voter address** (`tx_context::sender`), not by the coins. Nothing locks, escrows, or snapshots the voting coins. An attacker can vote from address A1, transfer the same coins to A2, vote again from A2, and so on — counting one stake an unlimited number of times. This defeats the balance-weighted approval vote: `for_weight` (and `against_weight`) can be inflated to any value with an epsilon stake, so both the quorum (`total > 25% of snapshot_supply`) and the majority (`for > against`) conditions in `resolve_takeover` are attacker-controlled.

**Exploit path (attacker = hostile takeover, creator inactive ≥ 5 days):**
1. Wait for / target a curve whose `last_creator_activity_ms` is ≥ 5 days old (`propose_takeover` gate at line 1530). Acquire ≥ 1% of circulating (nominate threshold, line 1534-1535) — this can itself be the looped stake.
2. `propose_takeover<T>(curve, nominee=attacker, holder_coin, clock, ctx)` → `TakeoverProposal` (12h window).
3. Loop, using one wallet of coins with value `C`: `vote_takeover(support=true)` from A1; `transfer` the coins to A2; `vote_takeover(support=true)` from A2; … `N` times. `for_weight = N*C`, chosen to exceed `25% * snapshot_supply` and dominate any honest `against` votes.
4. After the window, `resolve_takeover` computes `passed = (total > quorum) && (for_weight > against_weight)` → true. A fresh `CreatorCap` is minted to the attacker, `curve.active_creator_cap_id` and `curve.creator` are swapped to the attacker.
5. Attacker calls `update_payouts` (100% to self), `claim_creator_fees` (all accrued), `set_buyback_config(burn=false)` (buybacks routed to self), and collects future creator fees and the graduation `creator_bonus`.

**Attacker gain:** control of the curve's entire creator-fee stream + accrued creator fees, obtained with ~epsilon capital instead of the ~25%-of-supply stake the mechanism assumes is required.

**Offending code:**
```
// bonding_curve.move:1572-1578
let who = tx_context::sender(ctx);
assert!(!table::contains(&proposal.voted, who), ECtoAlreadyVoted);
let w = coin::value(holder_coin);          // live balance, coins not locked
assert!(w > 0, ECtoZeroWeight);
table::add(&mut proposal.voted, who, true);// keyed by address, not by coins
if (support) { proposal.for_weight = proposal.for_weight + w; }
else { proposal.against_weight = proposal.against_weight + w; };
```

**Recommendation.** Weight must be tied to coins that cannot be re-used within the window: require voters to **escrow/lock** their voting coins into the proposal for the duration of the vote (return on resolve), or take a balance **snapshot** at proposal open and prove inclusion, or weight by a time-locked stake. Keying `voted` by address while reading a transferable live balance is unsound.

**Corpus reference:** economic-integrity / delegated-authority abuse; conceptually the SuiFrens "cooldown resettable by anyone" class (Part 2.4) applied to vote weight — the guard exists but binds the wrong thing.

---

### [MEDIUM] F-4 — `dampened_grad_threshold` precision scaling error (~31.6x); oracle-dampening feature is effectively dead

**Module / location:** `suipump::bonding_curve::dampened_grad_threshold` (`bonding_curve.move:458-467`).

**Description.** The intended formula (module header, lines 11-14) is `threshold = BASE_GRAD_MIST * sqrt(1000) / sqrt(price_scaled)`. The code computes `num = isqrt(1000 * precision)` and `den = isqrt(price_scaled * precision / 1_000)`. The extra `/ 1_000` inside `den` makes `den` a factor of `sqrt(1000) ≈ 31.6` too small, so `num/den = 1000/sqrt(price_scaled)` instead of `sqrt(1000)/sqrt(price_scaled)`. Result: at an honest `price_scaled = 1030` the threshold computes to ≈ **383,700 SUI** instead of the calibrated ≈12,305 SUI — a constant ~31.6x overshoot at all prices. The module's own worked example (comment line 456, "den=33015") corresponds to `isqrt(1090 * precision)` **without** the `/1000` — i.e. the comment's numbers describe the correct formula, but the code and the written formula both carry the spurious divisor.

**Impact.** Under honest oracle prices the SUI-threshold graduation path (Path B) never binds, because a curve drains all 800M tokens (Path A) at ~12,800 SUI of reserve long before reaching ~384,000 SUI. Graduation therefore always occurs via token-drain at a fixed ~12,800 SUI regardless of SUI price — the entire oracle price-responsiveness / sqrt-dampening feature is silent. Not a fund loss, but a value-bearing math error the tests cannot catch (see F-10). It also amplifies F-2 in the opposite direction (small price → threshold too high; large price → too low).

**Offending code:**
```
// bonding_curve.move:462-466
let precision: u64 = 1_000_000;
let num = isqrt(1_000u64 * precision);
let den = isqrt(price_scaled * precision / 1_000);   // spurious / 1_000
if (den == 0) return BASE_GRAD_MIST;
BASE_GRAD_MIST * num / den
```

**Recommendation.** Remove the `/ 1_000`: `let den = isqrt(price_scaled * precision);`. Verify: at 1030 → `isqrt(1.03e9)=32093`, `num/den=0.985`, threshold ≈ 12,125 SUI (matches calibration). Add a Move unit test that calls the real `buy`/`resolve_grad_threshold` path with a live `price_scaled` (not `set_grad_threshold_for_testing`) and asserts the graduation SUI reserve.

**Corpus reference:** Cetus 2.1 — "do not trust the name; compute the real boundary yourself." The scaling constant is wrong even though the guard structure looks reasonable.

---

### [MEDIUM] F-5 — `buy()` refunds the 10% LP fee to the buyer instead of retaining it; `lp_fees_accumulated` is a phantom counter

**Module / location:** `suipump::bonding_curve::buy` (`bonding_curve.move:794-805, 838-840`), contrast with `sell` (`913-919`).

**Description.** `split_fee_v7` computes `lp_fee` (10% of the trade fee), and `buy` increments the `lp_fees_accumulated` **counter** by it (line 794), but the corresponding SUI is never moved into a balance nor into the reserve. The coins split out of `payment` are `creator_fee + protocol_fee + airdrop_fee + buyback_amount + referral_fee + to_reserve(swap_amount)`, which sums to `effective_sui_in - lp_fee`. The remaining `payment` returned to the caller therefore equals `tail_refund + lp_fee` — so the LP fee is silently **refunded to the buyer** (the comment at 839 claiming "payment now holds exactly `tail_refund`" is off by `lp_fee`, and the header conservation identity listing `lp_fee` as a retained term is violated).

Traced example (`sui_in=1000`, no referral, no tail): fees creator=4, protocol=3, airdrop=2, lp=1, reserve=990; splits removed = 4+3+2+990 = 999; returned payment = 1 = `lp_fee`. Money is conserved (no theft from other buckets), but the LP allocation is not collected. `sell` does it correctly (`withdraw_amount = gross_sui_out - lp_fee` leaves the LP portion in the reserve, line 913).

**Impact.** The documented 10% LP fee is not collected on buys; over the curve's life the reserve is under-funded versus design by ~0.1% of buy volume, and `lp_fees_accumulated` overstates SUI that does not exist — dangerous if any off-chain LP-funding logic trusts that counter at graduation. Broken accounting, not direct theft.

**Offending code:**
```
// bonding_curve.move:794-804
curve.lp_fees_accumulated = curve.lp_fees_accumulated + lp_fee;   // counter only
...
let to_reserve   = swap_amount;                 // == effective - fee_amount; EXCLUDES lp_fee
let reserve_coin = coin::split(&mut payment, to_reserve, ctx);
balance::join(&mut curve.sui_reserve, coin::into_balance(reserve_coin));
// payment remainder returned = tail_refund + lp_fee  (line 840)
```

**Recommendation.** Retain the LP fee in the reserve on buys, mirroring `sell`: set `to_reserve = swap_amount + lp_fee` (equivalently, split the reserve coin as `effective_sui_in - fee_amount + lp_fee`), so the returned `payment` is exactly `tail_refund`. Then the header conservation identity holds and `lp_fees_accumulated` is backed by real SUI.

**Corpus reference:** Part 3 §7 — fee splits must sum to 100% and be actually collected; §2 rounding/accounting integrity.

---

### [MEDIUM] F-6 — Session blast radius exceeds the documented "churn only": foreign/attacker curves + net-exposure looping let a compromised session key drain escrow over time

**Module / location:** `suipump::agent_session::buy_with_session` / `sell_with_session` (`agent_session.move:284-364`), `credit_spent` (`256-259`).

**Description.** The module's trust model (lines 5-19) promises that a fully-compromised session key can, worst case, only "churn the user's escrow through legitimate buy/sell; SUI proceeds still land in the USER's escrow." Two facts break that bound even on the NARROW path (universal trading OFF):

1. **No curve/type binding.** `buy_with_session<T>(session, curve: &mut Curve<T>, …)` accepts **any** `Curve<T>` of any `T` — the session never records or asserts which curve(s) the owner authorized (Corpus 2.3 / foreign-curve). A compromised key can route escrow into an **attacker-created** curve and the attacker extracts value as that curve's creator (creator fees) and via price manipulation (attacker pre-buys, session buys the top, attacker dumps). Proceeds do **not** fully return to escrow — this is net extraction, not churn.
2. **Net-exposure cap does not bound cumulative loss.** `credit_spent` (correctly clamped, no underflow) decrements `spent` on every sell, so the cap only limits *instantaneous* exposure. A compromised key can loop buy→(attacker rug)→sell indefinitely; each cycle frees cap headroom, so total realized loss is bounded only by **expiry_ms**, not by `spend_cap`. The V11 net-exposure design (docs lines 56-62) explicitly enables this recycling for legitimate strategies; combined with (1) it also enables unbounded-until-expiry bleed.

**Exploit path (Pass E — bridge/session key compromised):**
1. Attacker (holding the session key) creates curve `X` of type `T_x` and pre-buys cheaply.
2. `buy_with_session<T_x>(session, X, amount=headroom, …)` — escrow SUI flows into `X`; `spent += amount`.
3. Attacker dumps their pre-bought `T_x` into `X`, extracting the reserve the session just deposited; attacker also earns `X`'s creator fees.
4. `sell_with_session<T_x>(session, X, …)` returns the now-depressed proceeds to escrow and **credits `spent` back down**, restoring headroom.
5. Repeat until expiry. Escrow is drained over time; `spend_cap` never trips.

**Attacker gain:** the owner's escrow, net of what little the manipulated sells return — bounded by expiry, not by the cap the UI presents as the safety lever.

**Recommendation.** Bind sessions to an owner-approved curve/venue allow-list (store authorized curve IDs on the session and assert on every trade), and/or track a **lifetime** deployed figure alongside net exposure so the cap can bound cumulative outflow. At minimum, correct the trust-model documentation and the A5 UI to state that a compromised key can, before expiry, cause net loss up to the full escrow via foreign curves — not merely "churn."

**Corpus reference:** Navi/Kuna 2.3 (type/curve param not bound to the authorizing object); Class 9 delegated authority (proceeds/scope guarantees).

---

### [LOW] F-7 — `post_comment` author is caller-supplied and unauthenticated → comment impersonation

**Module / location:** `suipump::bonding_curve::post_comment` (`bonding_curve.move:1188-1216`).

**Description.** `author: address` is taken as a parameter and emitted verbatim in the `Comment` event; there is no `assert!(author == tx_context::sender(ctx))` and no binding to the `holder_coin` owner. Any caller who pays the 1 000 000 MIST fee (and, if gated, holds ≥1 token) can post a comment attributed to **any** address. The indexer reconstructs the comment tree (and `parent_id` replies) from these events, so a griefer can impersonate arbitrary wallets (e.g. a project's control wallet or a known influencer) in the on-chain comment feed. No funds at risk.

**Offending code:**
```
// bonding_curve.move:1192,1210-1215
author:      address,               // caller-supplied, never checked
...
event::emit(Comment { curve_id: object::id(curve), author, text, parent_id });
```

**Recommendation.** Set `author = tx_context::sender(ctx)` internally and drop the parameter (or assert equality). For agent-posted comments, post as the session/owner address derived on-chain, not a caller-named one.

**Corpus reference:** Part 3 §1 — sender-choice ("does any path let the CALLER name who they are rather than deriving it from `ctx.sender()`?").

---

### [LOW] F-8 — `graduate()` is permissionless and reads the poisoned `current_grad_threshold`

**Module / location:** `suipump::bonding_curve::graduate` (`bonding_curve.move:970-987`).

**Description.** `graduate<T>` has no capability gate; anyone may call it once `token_reserve == 0` **or** `sui_reserve >= curve.current_grad_threshold`. Because `current_grad_threshold` is attacker-writable via F-2 (a prior `buy` with a large `sui_price_scaled` persists a tiny threshold), `graduate()` becomes trivially callable to force graduation without even needing the buy to cross the threshold inline. Standalone this is low impact (it only triggers the already-audited `do_graduate_inline`), but it compounds F-2. Permissionless graduation is presumably intended for the relayer; the risk is entirely inherited from the corrupted threshold.

**Recommendation.** Fix F-2 (bound/authenticate the price and stop persisting caller-supplied thresholds). Consider gating `graduate()` behind `AdminCap` or requiring the token-drain condition specifically.

---

### [INFO] F-9 — Centralization surface (AdminCap) and MEV on `execute_buyback`

**Module / location:** multiple.

- **AdminCap** gates `set_paused` (can freeze any curve's trading indefinitely — a liveness/censorship lever), `claim_protocol_fees`, `claim_airdrop_fees`, `record_graduation_pool`, and the entire `enclave_registry` (create/update PCRs, revoke keys). Per CLAUDE.md the AdminCap/UpgradeCap move to multisig is a mainnet gate; until then a single key can pause every curve and controls attestation measurements. Disclose plainly.
- **`execute_buyback`** is permissionless and buys at the current AMM price; it is sandwichable (front-run buy, buyback pumps, back-run sell). Buyback size is bounded by the carved fee bucket, so impact is small, but it is extractable at scale.

**Recommendation.** Complete the multisig migration before mainnet; document the pause power. Consider a slippage/min-out bound on `execute_buyback`.

---

### [INFO] F-10 — Test suite structurally cannot exercise the oracle graduation path; `buy_for_testing` ships in source

**Module / location:** `bonding_curve.move:989-1003, 1655-1786`.

**Description.** `buy_for_testing` and `set_grad_threshold_for_testing` set `current_grad_threshold` directly and never call `dampened_grad_threshold`/`resolve_grad_threshold`. Consequently the ~31.6x error in F-4 and the unbounded-price issue in F-2 pass all Move unit tests — the green build is not evidence for the oracle path. Additionally, confirm `#[test_only]` functions are stripped from the published bytecode; if `buy_for_testing` were reachable on-chain it would be a live buy entry bypassing the oracle threshold logic.

**Recommendation.** Add tests that drive `buy` with real `sui_price_scaled` values (including adversarial extremes) and assert the graduation reserve. Verify test-only stripping in the published package.

---

## Invariant Checklist

| Invariant | Status |
|-----------|--------|
| Supply mints ONLY via the curve; `TreasuryCap` unreachable except through it | **UNENFORCED → F-1** (`create_and_return` never checks `total_supply==0`; cap is publicly mintable pre-handoff). |
| Total supply fixed after creation | Post-`create_and_return` the cap is inside `Curve` and only `coin::burn` is reached (execute_buyback `1445`); enforced **after** creation, but F-1 defeats it before. |
| Trade fee splits sum to 100%, no caller-controlled slice | `split_fee_v7` sums to `fee` (`408-417`) — arithmetically correct; but **LP slice not actually collected on buys → F-5**. Referral slice is caller-named but bounded and `!= creator` (`677-679`). |
| Escrow exits only to the owner (sessions) | ENFORCED: `close_session` (`525`), `expire_refund` (`549` → `session.owner`), `sweep_token` (`558-561`). No caller-directed escrow exit. |
| `sender == session_address` on every session trade | ENFORCED in `assert_can_trade` (`agent_session.move:247`), called by all four trade entries. |
| `spend_cap` checked BEFORE the spend, underflow-safe, clamped | Checked before (`296-297`, `407-409`); `credit_spent` clamped, no underflow (`256-259`). But net-exposure ≠ cumulative bound → **F-6**. |
| `expiry_ms` / `revoked` honored every action | ENFORCED (`agent_session.move:248-249`); `sweep_token`/`close` are owner-only and intentionally exempt. |
| Graduation moves reserve exactly once / idempotent | ENFORCED: `!curve.graduated` guard in `buy` (`672`), `should_graduate` (`813-816`), `graduate` (`979`). Bonuses paid once. |
| Graduation TRIGGER authority / threshold integrity | **UNENFORCED → F-2/F-8** (caller-supplied price sets the threshold; `graduate()` permissionless). |
| A cap authorizes only its own curve (Corpus 2.5) | ENFORCED for CreatorCap via `assert_active_creator` (`425-429`: `cap.curve_id == object::id(curve)` AND `object::id(cap) == active_creator_cap_id`), applied in all 6 creator-gated fns. Stale-cap-after-takeover correctly rejected. |
| Parked-token DOF type validation | ENFORCED via `type_name::with_defining_ids<T>()` keying + typed `dof::borrow_mut`/`remove` (`agent_session.move:268, 341-342, 466-467, 559-560`). |
| TradeTicket bound to its session AND direction | ENFORCED: `settle_buy`/`settle_sell` assert `session_id == object::id(session)` and `kind` (`432-433, 487-488`); leftover credit clamped (`437`). |
| CTO governance weight sound | **ENFORCED (F-3 FIXED in V13, `f5b80885`)** -- weight is escrow-locked `Coin<T>` (`coin::into_balance`), keyed per voter; double-count not expressible under linear typing. Was UNENFORCED (transferable live-balance voting, no lock/snapshot). |
| Attested-open requires registered key | ENFORCED: `open_and_share_attested` asserts `is_registered` (`agent_session.move:217-220`); registry gates on native Nitro attestation + PCR match (`enclave_registry.move:119-137, 145-162`). |

## Centralization & Disclosure

- **AdminCap** (single key until multisig migration): pause/unpause any curve (`set_paused`), claim protocol & airdrop fees, record graduation pools, and full control of `EnclaveRegistry` (create/`update_pcrs`/`revoke_key`). Pause is an unbounded liveness lever over every curve.
- **UpgradeCap** (V10 lineage, `0xb840fc9c54271c73f9c5e8f22f42ffda3c46f93914586bf671958ad9e754a274`): can replace all module bytecode; types pinned at V10 defining version (asserted in comments, not verified here).
- **Shared agent wallet / bridge**: signs autonomous trades; Turnkey `open_and_share` trusts an off-chain claim that `session_address` is TEE-held (the attested path `open_and_share_attested` upgrades this to chain-verified). A compromised bridge is bounded by the session on-chain guards **except** as described in F-6.
- Per CLAUDE.md, moving AdminCap/UpgradeCap to multisig + a paid human audit are explicit mainnet gates. This report supports neither as a substitute.

## Appendix A: entry-function inventory with classification

**`bonding_curve.move`** (M=moves value, S=mutates shared state, R=read-only)
| Function | Line | Class | Gate |
|---|---|---|---|
| `init` | 196 | M (mints AdminCap) | one-time-witness |
| `create_and_return` | 534 | M | consumes TreasuryCap + 2 SUI fee (**F-1**) |
| `create_with_launch_fee` | 635 | M/S | wrapper |
| `share_curve` | 658 | S | none |
| `buy` | 663 | M/S | none (**F-2, F-5**) |
| `sell` | 883 | M/S | none |
| `set_paused` | 957 | S | AdminCap |
| `graduate` | 970 | M/S | none (**F-8**) |
| `record_graduation_pool` | 1006 | S | AdminCap |
| `update_metadata` | 1024 | S | active CreatorCap |
| `update_payouts` | 1072 | S | active CreatorCap |
| `claim_creator_fees` | 1089 | M | active CreatorCap |
| `claim_protocol_fees` | 1123 | M | AdminCap |
| `claim_airdrop_fees` | 1141 | M | AdminCap |
| `set_comment_gate` | 1164 | S | active CreatorCap |
| `post_comment` | 1188 | M/S | fee + holder (**F-7**) |
| `lock_tokens` | 1219 | M/S | none (self) |
| `claim_vested` | 1272 | M | beneficiary |
| `set_buyback_config` | 1396 | S | active CreatorCap |
| `execute_buyback` | 1419 | M/S | none (**F-9**) |
| `creator_heartbeat` | 1460 | S | active CreatorCap |
| `collect_protocol_surcharge` | 1479 | M/S | none (launch PTB) |
| `propose_takeover` | 1522 | S | ≥1% holder + inactivity |
| `vote_takeover` | 1561 | S | holder (**F-3**) |
| `resolve_takeover` | 1592 | M/S (mints cap) | window closed |
| `comments_holder_gated`, `sui_reserve`…`cto_circulating_supply` (24 accessors) | 1184, 1316-1650 | R | — |
| `graduate_for_testing`, `set_grad_threshold_for_testing`, `buy_for_testing`, `init_for_testing`, `lock_vested_at` | — | test_only | (**F-10**) |

**`agent_session.move`**
| Function | Line | Class | Gate |
|---|---|---|---|
| `open_session` / `open_and_share` | 159 / 191 | M | owner-signed |
| `open_and_share_attested` | 209 | M | owner + registry-attested key |
| `top_up_session` | 230 | M | owner |
| `buy_with_session` | 284 | M/S | session key + cap/expiry/revoke (**F-6**) |
| `sell_with_session` | 332 | M/S | session key (**F-6**) |
| `enable/disable_universal_trading` | 373 / 382 | S | owner |
| `borrow_for_buy` / `settle_buy` | 398 / 424 | M/S | session key + universal + ticket |
| `borrow_tokens_for_sell` / `settle_sell` | 458 / 479 | M/S | session key + universal + ticket |
| `revoke_session` | 511 | S | owner |
| `close_session` | 521 | M | owner |
| `expire_refund` | 538 | M | anyone after expiry → owner |
| `sweep_token` | 554 | M | owner |
| accessors (`owner`…`is_closed`) | 565-573 | R | — |

**`enclave_registry.move`**
| Function | Line | Class | Gate |
|---|---|---|---|
| `create_registry` | 68 | S | AdminCap |
| `update_pcrs` | 80 | S | AdminCap |
| `revoke_key` | 96 | S | AdminCap |
| `register_enclave_key` | 119 | S | permissionless, gated by native Nitro attestation + PCR match |
| `is_registered` | 140 | R | — |

**`template.move`**: `init` (33) — M (creates currency, shares metadata, transfers TreasuryCap to publisher; **F-1**).

## Appendix B: every scaling / fixed-point site, its guard, and the boundary verified

*No bit-shift (`<<`/`>>`) operators exist in the contract source (only generic-type syntax in tests).* Scaling / multiply-divide sites:

| Site | File:line | Widening / guard | Boundary verified |
|---|---|---|---|
| `quote_out` = `(y_u*dx_u)/(x_u+dx_u)` | bonding_curve:389-394 | operands cast to `u128` before `*` | `y,dx < 2^64 ⇒ product < 2^128`; safe. |
| Path-A reverse AMM `x*rem/(y-rem)` | 723-724, 1711-1712 | `u128` | safe; `y-rem` non-negative by construction (`rem` from token_reserve ≤ effective). |
| `fee = sui_in * TRADE_FEE_BPS / BPS` | 704, 759, 903 | `u64 *` | overflow only for `sui_in > ~1.8e17` MIST (aborts; not reachable). |
| `split_fee_v7` (creator/lp/referral/bucket) | 408-417 | `u64 * / ` | sums to `fee`; verified conserved. **LP slice not collected on buy → F-5.** |
| `buyback_amount = creator_full * buyback_bps / BPS` | 770, 908 | `buyback_bps ≤ BPS` (set_buyback_config:1405) | `≤ creator_full`, no underflow at `creator_fee = creator_full - buyback`. |
| `isqrt` (Babylonian) | 435-444 | u64 | converges; used only in F-4 path. |
| `dampened_grad_threshold` num/den | **458-467** | `price_scaled==0`/`den==0` guarded; `price_scaled` **NOT bound-checked** | **WRONG SCALING (~31.6x) → F-4; unbounded caller input → F-2.** `price_scaled*precision` overflows u64 at `price_scaled > ~1.8e13` (aborts). |
| grad bonuses `reserve * 50 / BPS` | 857-858 | `u64 *` | reserve ≪ 2^64; safe. |
| `vested_amount` linear/monthly `total*elapsed/duration` | 1298-1313 | `u128` widening | safe; `claimable` clamped `vested > claimed`. |
| CTO `circ * NOMINATE/QUORUM_BPS / BPS` | 1534, 1613 | `u64 *` | `circ ≤ CURVE_SUPPLY (8e14)`; safe. Weight sum unsound → **F-3**. |
| `credit_spent` clamp | agent_session:256-259 | `credit = min(amount, spent)` | underflow-safe; clamped at zero, verified. |
| `spent + amount ≤ spend_cap` | agent_session:296, 408 | pre-spend check | correct ordering; net-exposure caveat **F-6**. |

---

*End of report. Findings are static-analysis derived; none were executed on-chain. Re-verify F-1, F-2, and F-3 with concrete testnet transactions before relying on the severity assignments, and commission a paid human audit before mainnet as CLAUDE.md requires.*
