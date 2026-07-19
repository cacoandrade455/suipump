# Security Audit - SuiPump (Full Adversarial Pass)

- Scope: `contracts-v10/sources/{bonding_curve,agent_session,enclave_registry}.move`, `coin-template/sources/template.move`, and the off-chain trust boundary (`suipump-nexus-tools/bridge.js`, `indexer/{price_publisher,auto_graduate,cto_reclaim_sweeper,write_target}.js`, `frontend-app/src/AgentPage.jsx`).
- Branch: `security-audit-full`, cut from `main` at commit `7ab9639ed6b815f3c3a47638b61c808b972e308c`.
- Deployment state audited: V13 fresh publish + V14 GraduationCap additive upgrade, both live on testnet.
- Date: 2026-07-18.
- Method: the multi-pass adversarial persona protocol (Pass A Arithmetic Attacker, Pass B Capability Forger, Pass C Economic Attacker, Pass D Griefer, Pass E Integrator), each followed by an adversarial verifier that attempts to REFUTE every finding before acceptance, plus an independent lead read of all four Move modules and the off-chain layer.

## Summary

- Modules audited: 4 Move modules (`bonding_curve.move` 2281 lines, `agent_session.move` 574 lines, `enclave_registry.move` 176 lines, `template.move` 55 lines).
- Public/entry money-movers classified: 21 value-moving or shared-state-mutating public functions in `bonding_curve.move`, 15 in `agent_session.move`, 4 in `enclave_registry.move` (full inventory in Appendix A).
- Raw candidate findings across all five passes: 11. After adversarial verification: 8 accepted, 3 refuted.
- Findings by severity (post-verifier): CRITICAL 0, HIGH 0, MEDIUM 0, LOW 3, INFO 5 (one LOW and one INFO describe the same CTO griefing mechanism found independently by Pass C and Pass D; they are merged into finding D-1 below, so the distinct-finding count is 3 LOW + 4 INFO = 7).
- Shift-overflow surface (the Cetus `checked_shlw` class): NONE. There is not a single `<<` or `>>` operator anywhere in the four modules; all scaled math uses `isqrt` and `u128`-widened multiply-before-divide, both of which abort on overflow.

Honest posture: this pass found no unauthorized-theft, unbounded-mint, reserve-drain, ownership-bypass, arithmetic-overflow, capability-confusion, or conservation-violation defect that is reachable on-chain. The prior finding ledger (F-1..F-10, E-1, PREPUBLISH-2, GRAD-1) is confirmed still closed at the source level, each by a contract-level `assert!`/type-gate rather than an off-chain check. Every accepted finding is either a documented, contract-bounded centralization/custody disclosure (AdminCap/UpgradeCap, relayer, graduation signer, universal trading) or a LOW-severity governance-liveness/economic nuance in the Community Takeover (CTO) mechanism that costs the attacker capital and yields no fund theft. The single most consequential item is not a code bug at all: the co-located AdminCap + UpgradeCap on one cold key (finding E-2) is a total-protocol-compromise surface bounded today only by the key being offline, not by any Move `assert!` - this is the F-14 mainnet-blocking gap and it must become an object-level multisig/timelock before mainnet.

MANDATORY LINE: This is an automated first pass, not a substitute for a human audit. Cetus was audited by OtterSec, MoveBit and Zellic; all three missed the bug that cost $223M. Clean output here means nothing was found by this pass, not that the code is safe.

## Not Verified

The following surfaces were NOT covered, or were covered only partially, and must not be read as cleared:

- Deployed bytecode. `#[test_only]` stripping (including `new_admin_cap_for_testing`, `buy_for_testing`, `graduate_for_testing`) is confirmed at the SOURCE level only. This pass did not disassemble the on-chain V13/V14 package bytes to prove no test-only item shipped. A bytecode-level confirmation is recommended.
- The Sui framework and its native primitives (`sui::coin`, `sui::balance`, `sui::table`, `sui::dynamic_field`/`dynamic_object_field`, `sui::nitro_attestation`). Their correctness is assumed. The Zellic verifier-bypass and Numen/HackenProof validator-DoS platform issues (SKILL 2.6) are out of scope.
- The `compatible` upgrade policy's exact body-replacement semantics. This audit reasons that function BODIES can be redirected by an upgrade even with frozen struct layouts (the basis of finding E-2); the precise on-chain enforcement of Sui's compatibility checker was not exercised.
- Live on-chain object state. Object ownership of the four custody wallets, whether any `AgentSession` currently names the retired shared-agent address as `session_address`, and the actual `active_cap_id` of the live `GraduationRegistry` were not queried. The custody analysis is by source semantics, not by reading current chain state.
- Off-chain code paths beyond the specific claims cross-checked (the 410 gate, the legacy-signer flag, the price-publisher cap-only usage, the graduation `_with_cap` path, the CTO reclaim sweeper). Full review of `bridge.js`, `strategy.js`, the indexer, and the frontend build/execute helpers as programs was out of scope; per SKILL rule 5 none of them is a security control regardless.
- Economic/game-theoretic modeling at scale (MEV, cross-curve, cross-protocol composition after graduation into a live DEX pool) beyond the single-PTB sequences constructed here.

## Findings

Severity buckets: A CRITICAL, B HIGH, C MEDIUM, D LOW, E INFO.

### A. CRITICAL - none.

### B. HIGH - none.

### C. MEDIUM - none.

---

### [LOW] D-1. CTO recovery is grief-deniable: single live-proposal slot + global fail-cooldown + proposer-only beneficiary

- Module/function: `bonding_curve::propose_takeover` / `bonding_curve::resolve_takeover`
- File:line: `contracts-v10/sources/bonding_curve.move:2028` (one-live-proposal gate), `:2027` (global cooldown gate), `:2187` (cooldown set on failure), `:2177-2185` (success installs `proposal.proposer` only)
- Passes: independently surfaced by Pass C (Economic, rated MEDIUM -> verifier DOWNGRADED to LOW) and Pass D (Griefer, rated LOW -> verifier DOWNGRADED to INFO). Merged and reported at the higher severity per the SKILL convergence rule.

Description. The Community Takeover is the only on-chain path to recover an abandoned curve (creator fee share, buyback config, comment gate, metadata) after 5 days of creator inactivity. Three properties combine into a liveness grief the documented PASS-C-1 proposer-bond fix does not address (that fix closed only the propose+immediate-unvote variant):

1. `propose_takeover` sets a one-live-proposal marker (`CTO_LIVE_PROPOSAL_KEY`) that blocks EVERY competing proposal on the curve for the 72h window (`:2028`, `:2064`).
2. `resolve_takeover` on success mints the fresh `CreatorCap` to `proposal.proposer` ONLY (`:2177-2185`). Voters can only add support weight toward that fixed proposer; there is no competing-candidate mechanism, so the honest community cannot co-opt a griefer's live proposal without handing the griefer the cap.
3. `resolve_takeover` on failure arms a curve-wide 3-day cooldown (`:2187`) that blocks all proposers, not just the one that failed.

A griefer holding >= 1% of circulating supply opens a deliberately-doomed proposal, waits out the 72h window, lets it fail (arming the 3-day cooldown), reclaims the full nominate bond via the permissionless `reclaim_vote` (escrow always routes to the voter), and re-proposes when the cooldown expires - a ~6-day cycle at gas cost plus a returnable 72h lock of 1% of circulating supply.

Exploit path (griefing; attacker net gain = 0). Precondition: creator inactive >= 5 days (`CTO_INACTIVITY_MS`), attacker holds >= 1% circulating `Coin<T>`.
1. At the eligibility boundary the griefer submits `propose_takeover(curve, stake = 1% circ, clock)` - the one-live marker is set, competing proposals blocked for 72h.
2. The community declines to vote (voting it to 25% quorum would install the griefer as creator).
3. After the deadline anyone calls `resolve_takeover` -> `succeeded = false` -> `cto_cooldown_until_ms = now + 3 days`.
4. `reclaim_vote(proposal, griefer)` returns the full 1% bond.
5. At cooldown expiry the griefer re-runs step 1, ideally before any honest proposer wins the `propose()` race.
Result: legitimate recovery of an abandoned token is denied across repeated ~6-day cycles; the attacker gains nothing and pays gas plus a returnable capital lock. The denial is NOT a hard permanent lock - proposal ordering on Sui is validator-sequenced with no guaranteed front-run, so the cooldown-expiry `propose()` race is genuinely contestable and an honest holder (or a symmetric community bot) can win any single cycle.

Offending code (verbatim):
```
    public fun propose_takeover<T>(
        curve: &mut Curve<T>,
        stake: Coin<T>,
        clock: &Clock,
        ctx:   &mut TxContext,
    ) {
        let now = clock::timestamp_ms(clock);
        assert!(now - curve.last_creator_activity_ms >= CTO_INACTIVITY_MS, ECreatorStillActive);
        assert!(now >= curve.cto_cooldown_until_ms, ECtoOnCooldown);
        assert!(!df::exists(&curve.id, CTO_LIVE_PROPOSAL_KEY), ECtoProposalLive);
```
```
        if (succeeded) {
            let new_cap = CreatorCap {
                id:       object::new(ctx),
                curve_id: object::id(curve),
            };
            curve.active_creator_cap_id    = object::id(&new_cap);
            curve.creator                  = proposal.proposer;
            curve.last_creator_activity_ms = now;
            transfer::public_transfer(new_cap, proposal.proposer);
        } else {
            curve.cto_cooldown_until_ms = now + CTO_COOLDOWN_MS;
        };
```

Why LOW and not higher: no user funds, trading, escrow, or reserves are affected; escrow is always drainable via the permissionless `reclaim_vote`. Only CreatorCap governance recovery on an already-abandoned (>= 5-day-inactive) token is denied. The attacker gains nothing and bears real, recurring, price-exposed capital cost (the PASS-C-1 bond lock forces >= 1% of circulating supply to stay locked for the full 72h window each cycle - `:2052`, `:2128-2135`). The denial is a contestable validator-ordering race, not a guaranteed lock.

Recommendation (routed to Carlos - this changes governance/economic semantics and MUST NOT be auto-applied): decouple the failure cooldown from the honest path. Options: (a) make the 3-day cooldown proposer-scoped (record the failed proposer, apply the cooldown only to that address); (b) allow a competing proposal to open while one is live if it stakes a strictly larger bond; (c) make the nominate bond partially forfeit on a failed proposal so repeated griefing carries a real, non-returnable cost; (d) let the winning beneficiary be the address that contributed the majority of escrowed weight rather than strictly the proposer, so the community can co-opt a griefer's proposal. Any change must preserve the F-3/F-4/F-6 escrow-weighting and quorum-snapshot invariants. Track as a hardening item, not a mainnet blocker.

Corpus reference: SKILL Part 3 class 11 (DoS/griefing - permanent locks with no attacker gain), adjacent to SuiFrens (2.4, a permissionless state reset abused for denial).

---

### [LOW] D-2. CTO takeover seizes the previous creator's already-accrued unclaimed `creator_fees`, not just future control

- Module/function: `bonding_curve::resolve_takeover` / `bonding_curve::claim_creator_fees`
- File:line: `contracts-v10/sources/bonding_curve.move:2182-2183` (cap + creator swap), `:1552-1557` (claim gated by `assert_active_creator` on the single `creator_fees` pool), `:668` (activity stamp), `:2026` (5-day gate), `:2163` (resolve blocked until deadline)
- Pass: Pass C (Economic, rated MEDIUM -> verifier DOWNGRADED to LOW).

Description. On a successful takeover, `resolve_takeover` swaps `curve.active_creator_cap_id` to a fresh cap and sets `curve.creator = proposal.proposer` (`:2182-2183`). `claim_creator_fees` is gated by `assert_active_creator` (`:1552`), which requires `object::id(cap) == curve.active_creator_cap_id`, and it drains the ENTIRE `curve.creator_fees` balance (`:1553`). Because `creator_fees` is a single pooled balance and the old creator's cap now fails `ENotActiveCreator`, every unit of creator fee the prior creator earned but had not yet claimed becomes claimable only by the takeover winner. The documented CTO intent is transfer of FUTURE creator control; seizure of PAST, already-earned, unclaimed revenue is a broader consequence.

Exploit path. Precondition: a curve whose creator has taken no CreatorCap-gated action for >= 5 days AND remains absent for the entire subsequent ~72h window despite the public `TakeoverProposed` event, while sitting on a large unclaimed `creator_fees` pool; attacker can assemble >= 25% of circulating supply.
1. `propose_takeover` with >= 1% stake.
2. Attacker self-funds `vote_takeover` calls (all reclaimable) until `proposal.total_weight >= quorum_target`.
3. After the deadline, `resolve_takeover` succeeds, minting a fresh `CreatorCap` to the attacker and setting `curve.creator = attacker`.
4. `claim_creator_fees(newCap, curve, clock)` drains the full accrued `creator_fees` pool to the attacker.
5. `reclaim_vote` returns the attacker's entire escrow.
Attacker net gain = the accrued unclaimed `creator_fees` (plus the future creator fee stream and graduation creator bonus); cost = gas + a 72h price-exposed lock of >= 25% of circulating supply (returned in full).

Contract-enforced creator defense (why this is LOW, not MEDIUM): the cap swap happens only at resolve, which is gated behind `now >= proposal.deadline_ms` (`:2163`, a full ~72h). Throughout the window the previous creator's cap is STILL active, and `propose_takeover` emits `TakeoverProposed` (`:2065`) as public on-chain notice at open. So the creator has a contract-provided, permissionless escape: call `claim_creator_fees` any time during the >= 72h window to extract 100% of the accrued pool before any swap. Moreover any single claim stamps `last_creator_activity_ms = now` (`:668`), resetting the 5-day inactivity clock that `propose_takeover` requires (`:2026`) - so a minimally-attentive creator both keeps their fees and blocks the takeover. For the accrued pool to be simultaneously large and seizable, the creator must ignore the token for the 5-day pre-propose window AND the full ~72h noticed window (>= 8 days of total absence) - i.e. a genuinely abandoned curve, which is the intended CTO target.

Offending code (verbatim):
```
        if (succeeded) {
            let new_cap = CreatorCap {
                id:       object::new(ctx),
                curve_id: object::id(curve),
            };
            curve.active_creator_cap_id    = object::id(&new_cap);
            curve.creator                  = proposal.proposer;
            curve.last_creator_activity_ms = now;
            transfer::public_transfer(new_cap, proposal.proposer);
```

Recommendation (routed to Carlos - changes economic semantics of the takeover; do not auto-apply): if only future control is meant to transfer, snapshot/settle the outgoing creator's accrued `creator_fees` to the prior `curve.creator` inside `resolve_takeover` before swapping the cap. If the accrued-fee transfer is intended, document it explicitly so the acceptance analysis reflects that a takeover captures past unclaimed earnings, and advise creators to claim promptly on any `TakeoverProposed` event.

Corpus reference: SKILL 2.5 (capability-swap authority scope - here the swap correctly invalidates the stale cap; the finding is the economic side effect of a single pooled balance following the active cap).

---

### [LOW] D-3. Drained graduation reserves + the 200M LP mint have no on-chain destination binding (accepted GRAD-1 residual, confirmed correctly scoped)

- Module/function: `bonding_curve::claim_graduation_funds_impl` (reached via `claim_graduation_funds_with_cap`)
- File:line: `contracts-v10/sources/bonding_curve.move:1320-1351` (impl return), `:1456-1464` (with-cap wrapper), `:1462`/`:1476` (active-cap assert), `:1434` (rotation)
- Pass: Pass E (Integrator, LOW -> verifier CONFIRMED at LOW).

Description. `claim_graduation_funds_impl` withdraws the ENTIRE `sui_reserve` (`balance::withdraw_all`, `:1334`) and mints the 200M LP allocation (`coin::mint_balance`, `:1341`, `lp_supply = TOTAL_SUPPLY - CURVE_SUPPLY = 1_000_000_000e6 - 800_000_000e6 = 200_000_000e6`), returning both `Coin<SUI>` and `Coin<T>` to the PTB caller, who chooses the destination. There is no on-chain assert binding the recipient - the DEX-seeding sink is enforced only off-chain in `auto_graduate.js`. Therefore a compromised graduation signer (the wallet holding the active `GraduationCap`) can drain the reserve AND take the 200M LP mint of every curve that has graduated but not yet been drained, and keep both instead of seeding the pool.

The three on-chain barriers that DO hold bound the blast radius: (1) `assert!(curve.graduated, ENotGraduated)` (`:1324`) - cannot touch a live curve; (2) one-shot `GRAD_CLAIMED_KEY` set before the mint (`:1326`, `:1331`) - cannot double-claim; (3) `MIN_GRAD_RESERVE_MIST = 500` SUI floor (`:1329`). This exactly matches the documented GRAD-1 accepted property in the module header (`:1376-1382`): "a compromised GraduationCap can drain the reserves of curves that have already graduated but not yet been drained, and NOTHING else." The verifier confirmed the "nothing else" is accurate (it cannot mint on a live curve, claim twice, pause, claim fees, publish a price, or touch the registry - all different cap types) and that the 200M LP is unrealizable value in the very window the attacker creates by not seeding the pool, so true impact does not exceed the documented impact. The acceptance stands.

Exploit path (residual, not a new class). Graduation key leaks -> attacker enumerates curves where `graduated() == true && grad_funds_claimed() == false && sui_reserve() >= 500e9` -> for each, submit `claim_graduation_funds_with_cap(cap, registry, curve)` -> receives `(Coin<SUI> = full reserve up to the ~12,803 SUI curve ceiling, Coin<T> = 200M)` and transfers to self, skipping DEX seeding. Bounded to graduated-not-drained curves in the window before the cold AdminCap calls `rotate_graduation_cap`.

Offending code (verbatim):
```
    fun claim_graduation_funds_impl<T>(
        curve: &mut Curve<T>,
        ctx:   &mut TxContext,
    ): (Coin<SUI>, Coin<T>) {
        assert!(curve.graduated, ENotGraduated);
        // Barrier 1: explicit one-shot marker, checked before any mint.
        assert!(!df::exists(&curve.id, GRAD_CLAIMED_KEY), ELpAlreadyClaimed);
        // Barrier 2 (F-2): refuse to mint the 200M LP against a trivial reserve.
        let sui_amount = balance::value(&curve.sui_reserve);
        assert!(sui_amount >= MIN_GRAD_RESERVE_MIST, EReserveTooLow);
        // Mark claimed BEFORE minting/draining so nothing can re-enter the mint.
        df::add(&mut curve.id, GRAD_CLAIMED_KEY, true);

        let sui_out = coin::from_balance(
            balance::withdraw_all(&mut curve.sui_reserve), ctx
        );

        // The only mint after launch. Raises max supply CURVE_SUPPLY (800M) ->
        // TOTAL_SUPPLY (1B). Mirrors V8: lp_supply = TOTAL_SUPPLY - CURVE_SUPPLY.
        let lp_supply = TOTAL_SUPPLY - CURVE_SUPPLY;
        let lp_out    = coin::from_balance(
            coin::mint_balance(&mut curve.treasury, lp_supply), ctx
        );

        event::emit(GraduationFundsClaimed {
            curve_id:   object::id(curve),
            sui_amount,
            lp_amount:  lp_supply,
        });

        (sui_out, lp_out)
    }
```

Recommendation: no contract change is required; the acceptance is valid and on-chain revocation (`rotate_graduation_cap`) is the correct control. Operationally: (a) keep `auto_graduate.js`'s claim-and-seed atomic (claim + DEX seed + `record_graduation_pool_with_cap` in one signer flow) so a leaked key has minimal standing drainable set; (b) monitor `GraduationFundsClaimed` vs `PoolRecorded` divergence as the tripwire to trigger rotation; (c) include the graduation signer in the F-14 mainnet key-management review. A future hardening (not shippable under the `compatible` policy because it is a signature change) would bind the reserve/LP recipient inside the claim rather than returning coins to the PTB.

Corpus reference: SKILL Part 3 class 12 (off-chain trust boundary - a privileged key whose destination is not bound on-chain) and class 10 (delegated authority / disclosure).

---

### E. INFO

### [INFO] E-1. `buy()` comment mislabels `current_grad_threshold` as a "display cache only", but `graduate_impl` reads it as the standalone-graduation gate

- Module/function: `bonding_curve::buy` / `bonding_curve::graduate_impl`
- File:line: `contracts-v10/sources/bonding_curve.move:922-925` (write + false claim), `:1239-1244` (read as gate)
- Pass: Pass A (Arithmetic, INFO -> verifier CONFIRMED at INFO).

Description. `buy()` sets `curve.current_grad_threshold = resolve_grad_threshold(price_cfg, clock)` every call, with a comment asserting the field "is now a DISPLAY CACHE ONLY; it is never read back for the graduation decision, so no poison (F-8)." That cross-function claim is literally false: `graduate_impl` (the standalone-graduation path) reads `curve.current_grad_threshold` as the actual gate. Not exploitable in current code: `set_sui_price` clamps `price_scaled` to `[100, 100000]` or 0, so `buy()` only ever writes a bounded legitimate threshold into the field; every threshold-lowering buy also runs the inline `should_graduate` check in the same transaction with the same value; and a fresh curve has `current_grad_threshold == 0`, which the `> 0` backstop rejects. The finding is the documentation/intent contradiction itself - a future refactor that trusts the "display cache only" comment (repurposing or removing the field, or letting `buy()` write an unbounded value) would silently convert the standalone graduation gate into a controllable trigger.

Offending code (verbatim):
```
        // V13: threshold from the protocol-published price. Recomputed from live
        // state every buy. current_grad_threshold is now a DISPLAY CACHE ONLY;
        // it is never read back for the graduation decision, so no poison (F-8).
        let grad_threshold = resolve_grad_threshold(price_cfg, clock);
        curve.current_grad_threshold = grad_threshold;
```
```
        assert!(
            balance::value(&curve.token_reserve) == 0 ||
            (curve.current_grad_threshold > 0 &&
             balance::value(&curve.sui_reserve) >= curve.current_grad_threshold),
            ENotGraduated,
        );
```

Recommendation: correct the `buy()` comment to state that `current_grad_threshold` IS read back by `graduate_impl` as the standalone-graduation gate (not display-only). Add an explicit invariant note that `buy()` must only ever write a threshold produced by `resolve_grad_threshold` (bounded by the `set_sui_price` clamp), and add a regression test asserting `graduate_impl`'s gate uses the same bounded value, so a future field repurposing cannot silently weaken the gate.

Corpus reference: SKILL 1.2/2.2-adjacent (a load-bearing field mislabeled by a comment - the class of latent bug where the next refactor trusts the wrong invariant).

---

### [INFO] E-2. Centralization surface: AdminCap (broad) and UpgradeCap (dominant, contract-unbounded) co-located on one cold key - the F-14 gate

- Module/function: `suipump::bonding_curve` (multiple AdminCap entrypoints) + `suipump::enclave_registry`; plus the framework UpgradeCap governing the V13 lineage.
- File:line: `bonding_curve.move:420, 1197, 1265, 1309, 1416, 1434, 1580, 1598`; `enclave_registry.move:68, 80, 96`.
- Pass: Pass B (Capability, INFO disclosure -> verifier CONFIRMED at INFO). Elevated in the custody analysis because the UpgradeCap dominates.

Description. Exactly one AdminCap is minted in `init` (`bonding_curve.move:327`) and held by the cold main wallet `0x0be9a8f56ba3b07f295e0c7526e7f47ca3a146649b9d864d2eb47bf3acd90c55`. Its complete gated surface, verified by reading each body: `create_price_config` (`:420`, one-shot), `set_paused` (`:1197`), `record_graduation_pool` (`:1265`), `claim_graduation_funds` (`:1309`), `init_graduation` (`:1416`, one-shot), `rotate_graduation_cap` (`:1434`), `claim_protocol_fees` (`:1580`), `claim_airdrop_fees` (`:1598`), and cross-module `enclave_registry::create_registry` (`:68`), `update_pcrs` (`:80`), `revoke_key` (`:96`). Type identity binds each AdminCap to its own lineage (a V13 AdminCap cannot act on a V10-typed `Curve`). No forgery/escalation path into this surface exists: AdminCap is module-private, minted only in `init`, and `set_sui_price` no longer accepts it (the E-1 split), so there is no dual-path.

The dominant power is the co-located UpgradeCap `0x79ebefc92e5da42720ff4b3e719a71e4ecd5428a9750d4ada8257f61e3556a19`. Under Sui's `compatible` upgrade policy struct layouts are frozen, but function BODIES can be redirected. An upgrade publishing malicious `buy`/`sell`/`claim_graduation_funds`/`claim_protocol_fees` bodies - or new functions - would execute against every existing shared `Curve` and, if a session function body is rewritten, every `AgentSession` escrow and parked-token holding. That is effectively unbounded theft across the entire V13 lineage and dwarfs the AdminCap. There is NO contract-enforced multisig or timelock on either cap today; the only control is that the key is offline (an operational control, not a Move `assert!`).

Offending code (verbatim, representative - the AdminCap drains a full fee balance to the caller with no second-signer gate):
```
public fun claim_protocol_fees<T>(
        _cap:  &AdminCap,
        curve: &mut Curve<T>,
        ctx:   &mut TxContext,
    ) {
        let total = balance::value(&curve.protocol_fees);
        assert!(total > 0, ENoFees);
        let coin = coin::from_balance(
            balance::split(&mut curve.protocol_fees, total), ctx
        );
        transfer::public_transfer(coin, tx_context::sender(ctx));
```

Recommendation: keep the F-14 2-of-3 multisig migration as a HARD mainnet gate for all AdminCap entrypoints AND the UpgradeCap. Publish the admin-function matrix for disclosure (the protocol can pause trading and claim protocol/airdrop fees and graduation LP). Consider an object-level timelock on `set_paused` unpause and on the `claim_*` drains to bound a compromised-key window, and confirm the multisig also holds `enclave_registry` admin (same AdminCap type). This is the single most important item in this report.

Corpus reference: SKILL Part 3 class 10 (upgrade & governance - enumerate all admin powers as disclosure surface; multisig vs single key).

---

### [INFO] E-3. `set_sui_price` enforces only the `[100, 100000]` band on-chain; a compromised relayer can force mass premature (or delayed) graduation timing

- Module/function: `bonding_curve::set_sui_price` / `bonding_curve::resolve_grad_threshold`
- File:line: `contracts-v10/sources/bonding_curve.move:378-394` (set), `:727-732` (resolve), `:924-925` / `:960-981` / `:1053-1060` (buy uses it)
- Pass: Pass E (Integrator, LOW -> verifier DOWNGRADED to INFO).

Description. The contract's only guarantee on the published price is the band assert (`:384-387`). Every off-chain guard in `price_publisher.js` (three sources Binance/Coinbase/Kraken, >= 2 responsive, <= 5% spread, publish the median) is NOT a security control - a compromised relayer bypasses all of them and writes any value in `[100, 100000]` each push. Consequence analysis, verified against the math (`threshold = BASE_GRAD_MIST(9000 SUI) * sqrt(1000)/sqrt(price_scaled)`): (a) freeze buys - impossible (`resolve_grad_threshold` never aborts; no in-band price makes `buy()` abort); (b) permanent lock - impossible (at price 100 -> threshold ~28,460 SUI above the ~12,803 SUI ceiling, but the token-drain graduation branch `balance::value(&curve.token_reserve) == 0` still graduates, so it is delay-only); (c) mass premature graduation - reachable (at price 100000 -> threshold = 900 SUI; every curve already at `sui_reserve >= 900` SUI graduates on its next buy of any size, forcing early DEX migration at ~10x-low reserve); (d) self-drain - not reachable by the relayer alone (graduating does not let the relayer claim; the claim needs the separate GraduationCap). `price_scaled` feeds ONLY the graduation threshold - `VS`/`VTR` are compile-time constants, so an in-band price cannot skew any `quote_out` trade output or fee. No relayer profit path exists; every effect is reversible by the next legitimate push. This is the documented E-1 accepted "bounded wrong price" risk; the mass-premature-graduation operational effect is surfaced for the F-14/mainnet decision but stays within the documented mechanism and yields no attacker gain.

Offending code (verbatim):
```
    public fun set_sui_price(
        _cap:         &PriceRelayerCap,
        cfg:          &mut PriceConfig,
        price_scaled: u64,
        clock:        &Clock,
    ) {
        assert!(
            price_scaled >= MIN_PRICE_SCALED && price_scaled <= MAX_PRICE_SCALED,
            EPriceOutOfBand,
        );
        cfg.sui_price_scaled = price_scaled;
        cfg.updated_at_ms    = clock::timestamp_ms(clock);
        event::emit(SuiPriceUpdated {
            price_scaled,
            updated_at_ms: cfg.updated_at_ms,
        });
    }
```

Recommendation: acceptance is valid; document that the on-chain guarantee is ONLY the `[100, 100000]` band and that the median/spread/source-count logic is availability/quality tooling, not a security control. To narrow the griefing window at mainnet, consider a per-update rate-of-change clamp inside `set_sui_price` (reject a new price more than N% from the stored price unless the stored price is stale), which caps how fast a leaked relayer key can swing the graduation threshold without adding an oracle dependency. Include the relayer key in the F-14 review; the E-1 split from AdminCap already bounds the blast radius correctly.

Corpus reference: SKILL Part 3 class 12 (off-chain oracle/relayer trust boundary) and SKILL 2.1 SuiPump-exposure note (graduation threshold driven by a published price).

---

### [INFO] E-4. Universal-trading raw-coin egress lets a compromised bridge exfiltrate up to spend-cap headroom + borrowed parked tokens, but only after owner-signed opt-in (accepted, confirmed gated)

- Module/function: `agent_session::borrow_for_buy` / `settle_buy` / `borrow_tokens_for_sell`
- File:line: `contracts-v10/sources/agent_session.move:398-418` (`borrow_for_buy`), `:458-475` (`borrow_tokens_for_sell`), `:424-455` (`settle_buy`), `:373-379` (enable gate)
- Pass: Pass E (Integrator, INFO -> verifier CONFIRMED at INFO).

Description. For the NARROW path the contract fully bounds a compromised bridge: `buy_with_session`/`sell_with_session` keep coins inside module custody, refunds and proceeds route to `session.escrow` (owner-owned), and every trade passes `assert_can_trade` (`sender == session_address`, `!revoked`, `now < expiry`, `:246-250`) plus the spend-cap check (`:295-297`). A fully compromised bridge signing as the session key can only churn escrow through legitimate buys/sells; it cannot withdraw to an arbitrary address. The one WIDER path is universal trading: `borrow_for_buy` hands a raw `Coin<SUI>` to the PTB (`:411`) and `borrow_tokens_for_sell` hands raw parked `Coin<T>` (`:468`), so a compromised key can route those coins anywhere and settle with a zero-value leftover - exfiltrating up to the remaining spend-cap headroom in SUI plus any parked tokens it borrows. This is correctly bounded on-chain: (1) `borrow_for_buy` charges the FULL amount against the cap immediately and asserts `spent + amount <= spend_cap` (`:407-410`), so combined borrows in one PTB can never exceed the cap; (2) `settle_buy` clamps the returned credit to `borrowed` from the hot-potato ticket (`:437`), and `TradeTicket` has no abilities so the tx cannot commit without settling - an oversized leftover cannot mint headroom; (3) the whole path is unreachable unless the OWNER (`sender == session.owner`, `:374`) has called `enable_universal_trading` (the sole installer of `UNIVERSAL_TRADING_KEY`). Bridge compromise alone, without a prior owner opt-in, cannot reach it. Matches the documented module-header exception (`:21-31`); true impact does not exceed documented impact.

Offending code (verbatim):
```
    public fun borrow_for_buy(
        session: &mut AgentSession,
        amount:  u64,
        clock:   &Clock,
        ctx:     &mut TxContext,
    ): (Coin<SUI>, TradeTicket) {
        assert_can_trade(session, clock, ctx);
        assert!(universal_trading_enabled(session), EUniversalTradingDisabled);
        assert!(balance::value(&session.escrow) >= amount, EInsufficientEscrow);
        if (session.spend_cap > 0) {
            assert!(session.spent + amount <= session.spend_cap, ESpendCapExceeded);
        };
        session.spent = session.spent + amount;
        let funds = coin::from_balance(balance::split(&mut session.escrow, amount), ctx);
        let ticket = TradeTicket {
            session_id: object::id(session),
            borrowed:   amount,
            kind:       TICKET_BUY,
        };
        (funds, ticket)
    }
```

Recommendation: no change needed; the on-chain owner-opt-in gate and the ticket clamp are the correct controls and hold. Keep the mandatory A5 UI disclosure of the universal-trading tradeoff, and default `spend_cap > 0` with a short expiry so the exfiltration envelope stays small. Ensure the UI never silently enables universal trading (it must be an explicit owner-signed action, which the contract enforces via `sender == owner`).

Corpus reference: SKILL Part 3 class 9 (delegated authority / session model) and class 12 (off-chain trust boundary).

---

### Refuted candidates (surfaced then rejected by the adversarial verifier)

- Pass B: "GraduationCap has no per-curve binding and pays proceeds to the caller." Refuted as a distinct HIGH: it only affects graduated-but-unclaimed curves and is the accepted GRAD-1 residual, captured at LOW in finding D-3. No per-curve binding is needed because the one-shot `GRAD_CLAIMED_KEY` and the `graduated` gate bound it, and rotation revokes it instantly.
- Pass C: "`execute_buyback` is permissionless and its full spend is public, making it sandwichable/timeable." Refuted: bounded and not profitably exploitable at real bucket sizes; the destination (burn or creator) is fixed by config, so there is no caller-controlled slice and no extractable gain.
- Pass C: "`collect_protocol_surcharge` is permissionless with no amount bound and callable on any shared curve." Refuted: the function can only ADD SUI to a curve's `protocol_fees` (a donation); the only claimant is the AdminCap holder. There is no path to caller gain, price manipulation (it does not touch `sui_reserve`), or griefing beyond giving money away.

## Invariant Checklist

All 8 invariants ENFORCED / VERIFIED on-chain (8 PASS, 0 FAIL). Each row cites the enforcing site.

| # | Invariant | Result | Enforcing site(s) | Justification |
|---|-----------|--------|-------------------|---------------|
| 1 | Supply mints ONLY via curve; TreasuryCap otherwise unreachable | PASS / ENFORCED | `bonding_curve.move:797` (`assert! coin::total_supply==0, EPreMintedSupply`), `:798` (curve mint 800M), `:1324/1326/1329/1331/1341` (LP 200M mint behind graduated + one-shot marker + reserve floor + marker-before-mint) | Only two mint sites. Pre-launch mint gated by the F-1 `total_supply==0` check; the single post-launch 200M LP mint sits behind a one-shot dynamic-field marker set before the mint. `TreasuryCap<T>` lives inside the shared `Curve` (`:442`); no `public fun` returns it or a `&mut` to it. `execute_buyback` only burns. |
| 2 | Fee slices sum to exactly the fee; no mist created/lost | PASS / ENFORCED | `split_fee_v7:648-656`; buy accounting `:990-1045` (F-5 fix `to_reserve = swap_amount + lp_fee` at `:1043`); sell `:1143-1176`; buyback carve `:1002-1003` | `bucket = fee - creator - lp - referral`; `protocol = bucket - airdrop`, so creator+protocol+airdrop+lp+referral == fee identically (remainder construction, no rounding leak). Buyback is carved FROM the creator slice, preserving the identity. In `buy()`, coins split out sum to `effective_sui_in`; the residual returned to the caller equals `tail_refund` exactly. The F-5 LP-slice leak is closed at `:1043`. |
| 3 | Session escrow exits only to owner; sum in == sum out; sweep/refund to owner | PASS / ENFORCED (with documented universal-trading widening) | `close_session:525/:530`, `expire_refund:549` (`transfer::public_transfer(out, session.owner)`), `sweep_token:558/:561` | The three pure-exit paths all deliver to `session.owner`; escrow is a `Balance<SUI>` (split/join conserve). CAVEAT (not a new finding): `borrow_for_buy:411` hands raw escrow SUI to the PTB (universal path), destination caller-controlled, bounded by spend_cap/expiry/revoke and gated by the owner-only `enable_universal_trading:374`, off by default. |
| 4 | Vote-escrow: sum of reclaims == sum of votes, on BOTH outcomes | PASS / ENFORCED | `propose:2047/2056/2058`, `vote:2089/2093-2097`, `unvote:2135-2141`, `resolve` (flags only, escrow untouched) `:2172-2188`, `reclaim_vote:2206-2210` | `escrow: Balance<T>` equals the sum of the `votes` table on every mutating path (unvote decrements weight and escrow in lockstep; the proposer bond stays locked but stays counted). `resolve_takeover` never consumes escrow, so both outcomes leave escrow fully reclaimable. `reclaim_vote` pays the `voter` param (not the caller), removes the table entry (no double-reclaim), and the shared proposal persists so escrow can never strand. |
| 5 | Grad threshold deterministic; stale/zero -> 9000 floor; fresh curve un-grief-graduatable | PASS / ENFORCED | `resolve_grad_threshold:727-732`, `set_sui_price:384-387` band-clamp, `graduate_impl:1239-1244` (`current_grad_threshold > 0`), buy uses locally-resolved threshold `:1053-1056` | Threshold recomputed from live `PriceConfig` each buy; the stored value is a display cache never read on the buy path (F-8 closed). Standalone `graduate()` reads the stored value and the `> 0` backstop blocks graduating a fresh curve. Shift-free math; overflow headroom verified (`9e12 * 31,622 = 2.85e17 < u64::MAX 1.8e19`). |
| 6 | Per-cap authority bounded (relayer/graduation/creator/admin) | PASS / ENFORCED | PriceRelayerCap: only `set_sui_price:378-394`. GraduationCap: only `:1456`+`:1469`, both `assert! registry.active_cap_id==object::id(cap)`. CreatorCap: `assert_active_creator:665-669` on every creator fn. AdminCap enumerated in E-2. | PriceRelayerCap shifts graduation timing only. GraduationCap drains only graduated-unclaimed reserves + records pools, instantly revocable. CreatorCap is bound to its own curve AND `active_creator_cap_id`, so a post-CTO stale cap fails everywhere (F-AC-1 / SKILL 2.5 closed). AdminCap surface is the enumerable F-14 centralization. |
| 7 | No test_only logic in published bytecode | PASS / VERIFIED (source-level) | `#[test_only]` on `graduate_for_testing:1252`, `comment_author:1679`, `lock_vested_at:1813`, `init_for_testing:1819`, `new_admin_cap_for_testing:1829`, `set_grad_threshold_for_testing:2250`, `buy_for_testing:2269` | Every test hook carries `#[test_only]` immediately above it; none is reachable from a non-test entry. The compiler strips these from published modules. Caveat: source-level, not bytecode-disassembly (see Not Verified). |
| 8 | No shadow/parallel economic logic | PASS / ENFORCED | `buy_for_testing:2279 -> buy`; `graduate_for_testing:1257 + graduate:1220 -> graduate_impl:1227`; `claim_graduation_funds:1314 + _with_cap:1463 -> claim_graduation_funds_impl:1320`; `record_graduation_pool:1271 + _with_cap:1477 -> record_graduation_pool_impl:1275` | Every test wrapper and every dual (AdminCap/GraduationCap) entrypoint delegates to one shared private `_impl`; the economic decision exists in exactly one place. This is the F-10 fix that removed the parallel `buy_for_testing` which once hid the 31.6x F-4 error. |

## Regression Checklist (prior findings still closed)

Every listed prior finding is STILL CLOSED against the actual code; no new exploit path re-opens any. Enforcement is contract-level in every case.

| finding | status | enforcing file:line |
|---|---|---|
| F-1 unbacked pre-mint via publisher-held TreasuryCap | STILL CLOSED | `bonding_curve.move:797` `assert!(coin::total_supply(&treasury) == 0, EPreMintedSupply)` before the single 800M mint at `:798` |
| F-2 caller-supplied `sui_price_scaled` collapses grad threshold | STILL CLOSED | `buy` signature `:900` `price_cfg: &PriceConfig`; threshold `:924`; setter bounds `:384-387`. No non-admin `PriceConfig` constructor exists, so config substitution is unreachable (uniqueness via one-shot markers) |
| F-3 + F-AC-1 double-count votes / unreachable proposal | STILL CLOSED | escrow-locked weight `:2056`/`:2089`; shared proposal `:2071`; snapshot quorum `:2043`+`:2170`; wrong-curve guard `:2161`; proposer-bond lock `:2128-2136` |
| F-4 asymmetric isqrt num/den (31.6x error) | STILL CLOSED | `dampened_grad_threshold:708-715` symmetric `precision`; overflow re-verified; no `<<`/`>>` in curve math anywhere |
| F-5 buy leaks LP slice to buyer | STILL CLOSED | `buy:1043` `let to_reserve = swap_amount + lp_fee;` then split+join to reserve; residual returned == `tail_refund` |
| F-6 accepted (founder decision) | STILL CLOSED (accepted) | n/a; no impact escalation observed |
| F-7 forgeable comment `author` | STILL CLOSED | `post_comment:1648-1674` no `author` param; event author is `tx_context::sender(ctx)` at `:1671` |
| F-8 poisoned persisted grad threshold | STILL CLOSED | `buy:922-925` cache overwritten every buy; `graduate_impl:1239-1244` requires `> 0` AND `sui_reserve >= threshold` (see finding E-1 on the misleading comment) |
| F-9 / F-14 single-key admin | STILL CLOSED (tracked, disclosure) | AdminCap surface enumerated in E-2; F-14 multisig is the mainnet gate; E-1 + GRAD-1 carved the two hot powers off so AdminCap can go cold |
| F-10 test wrappers as shadow implementations | STILL CLOSED | all `_for_testing` carry `#[test_only]` and delegate to real `_impl`/`buy`; `set_grad_threshold_for_testing` feeds only the standalone-graduate gate |
| E-1 relayer key = admin blast radius | STILL CLOSED | `set_sui_price:378-379` takes `&PriceRelayerCap` only; separate struct `:268`; minted only at `init:339` / `create_price_config:423`; Move type-checks the arg (no AdminCap dual-path) |
| PREPUBLISH-2 exactly one PriceConfig + PriceRelayerCap per package | STILL CLOSED | fresh publish `init:328/333/339/347` pre-sets markers; upgrade `create_price_config:421-422` asserts+sets marker; mutually exclusive, single canonical config |
| GRAD-1 graduation signer needed hot AdminCap | STILL CLOSED | GraduationCap/Registry `:1389/:1396`; `_with_cap` `:1456-1463`/`:1469-1478` assert `active_cap_id == object::id(cap)`; rotation `:1434`; one-shot `init_graduation:1417` (see finding D-3 for the accepted residual) |

## Centralization and Disclosure (Custody Model As-Audited)

Judged only by Move `assert!`/`abort`/type-gates. `agent_session.move` contains ZERO references to AdminCap/PriceRelayerCap/GraduationCap - no admin/relayer/graduation key can reach a user session.

- Key 1 - PRICE RELAYER `0xce53cb8f9befc490393d70528ef732bbcbe12d951ffcdd76a37af9b0f9624629` (PriceRelayerCap). COULD: shift every curve's graduation threshold within the clamped `[$0.10, $100]` band (threshold 900..~28,460 SUI), forcing premature graduation (down to 900 SUI reserve) or delaying reserve-triggered graduation (token-drain still graduates). COULD NOT: write an out-of-band price; alter any trade's token output or fee (`PriceConfig` is not an input to `quote_out`); drain reserves, claim any fees, mint LP, pause, rotate a cap, or touch the registry (none accept `&PriceRelayerCap`); touch any `AgentSession`. Matches the E-1 acceptance (bounded wrong price, timing only). See finding E-3.
- Key 2 - GRADUATION SIGNER `0x7334d47632af5386d9b16326ade55be642fc8a569a1672b0cbaaf4d0e7e6180a` (GraduationCap). COULD: drain the full reserve and mint the 200M LP of any curve that is `graduated == true`, unclaimed, and `sui_reserve >= 500` SUI (finding D-3). COULD NOT: claim on a non-graduated curve (`:1324`); force graduation; mint on a live curve, pause, claim protocol/airdrop/creator fees, set the price, or govern; survive revocation (`rotate_graduation_cap:1434` repoints `active_cap_id`; the next `_with_cap` call aborts `EGraduationCapRevoked` at `:1462`); touch any `AgentSession`. Matches the GRAD-1 acceptance; blast radius real but narrow and instantly revocable.
- Key 3 - MAIN / COLD `0x0be9a8f56ba3b07f295e0c7526e7f47ca3a146649b9d864d2eb47bf3acd90c55` (AdminCap `0xb3d3155ca1bc153664143895928aa77384f5c70f752c306e10fa619f460e039d` + UpgradeCap `0x79ebefc92e5da42720ff4b3e719a71e4ecd5428a9750d4ada8257f61e3556a19`). AdminCap COULD: pause/unpause any curve (protocol-wide DoS), claim any curve's entire `protocol_fees` and `airdrop_fees` to itself, drain+mint any graduated-unclaimed curve, rotate the GraduationCap. AdminCap COULD NOT: set the SUI price (type-gated to PriceRelayerCap), claim CREATOR fees (CreatorCap-gated), mint on / drain a LIVE curve (no admin path reaches `Curve.treasury`/`sui_reserve` except `claim_graduation_funds_impl`, which asserts `graduated` and the 500-SUI floor), touch any `AgentSession`, or bypass the one-shot markers. UpgradeCap COULD: publish a lineage upgrade redirecting function BODIES - effectively unbounded theft across every V13-lineage curve and session (finding E-2), bounded today only by the key being offline. UpgradeCap COULD NOT: act invisibly (upgrades are observable txs) or affect the frozen V10 lineage (governed by the separate `UPGRADE_CAP_V10 0xb840fc9c54271c73f9c5e8f22f42ffda3c46f93914586bf671958ad9e754a274`). Assessment: AdminCap + UpgradeCap co-located on one key = total loss on compromise; nothing in the contract bounds it. This IS F-14 and MUST become an object-level multisig/timelock before mainnet.
- Key 4 - RETIRED SHARED AGENT `0x877af0fae3fa4f8ea936943b59bcd66104f67cf1895302e97761a28b3c3a5906` (plain EOA, holds no capability type). COULD: call permissionless entrypoints like any address (no value to caller beyond a normal trade); act as `session_address` for any `AgentSession` naming it (bounded by that session's spend_cap/expiry/revoked, proceeds still route to the session owner); claim creator fees for any curve whose active CreatorCap it happens to own. COULD NOT: exercise any AdminCap/PriceRelayerCap/GraduationCap power (holds none); withdraw session escrow to itself (hardwired to owner); reach sessions bound to a different `session_address`. On-chain this key carries zero protocol authority; before mainnet, inventory the objects this address still owns.

## Appendix A: Entry-function inventory with classification

`bonding_curve.move` (MOVES-VALUE / MUTATES-SHARED-STATE / READ-ONLY / TEST-ONLY):
- `init` (`:318`, private OTW) MOVES-VALUE - mints AdminCap/PriceRelayerCap/GraduationCap, shares PriceConfig + GraduationRegistry.
- `set_sui_price` (`:378`, public) MUTATES - `&PriceRelayerCap` + band assert.
- `create_price_config` (`:420`, public) MOVES-VALUE - `&mut AdminCap` + one-shot.
- `create_and_return` (`:760`) / `create_with_launch_fee` (`:867`) MOVES-VALUE - mint 800M, launch fee, `EPreMintedSupply` + `EWrongLaunchFee`.
- `share_curve` (`:890`) MUTATES.
- `buy` (`:895`) MOVES-VALUE - `!graduated`/`!paused`/anti-bot.
- `sell` (`:1123`) MOVES-VALUE - `!graduated`/`!paused`.
- `set_paused` (`:1197`) MUTATES - `&AdminCap`.
- `graduate` (`:1210`) MUTATES - via `graduate_impl` gate.
- `record_graduation_pool` (`:1265`) MUTATES - `&AdminCap`.
- `claim_graduation_funds` (`:1309`) MOVES-VALUE - `&AdminCap`.
- `init_graduation` (`:1416`) MOVES-VALUE - `&mut AdminCap` + one-shot.
- `rotate_graduation_cap` (`:1434`) MOVES-VALUE - `&AdminCap`.
- `claim_graduation_funds_with_cap` (`:1456`) MOVES-VALUE - `&GraduationCap` + active-cap.
- `record_graduation_pool_with_cap` (`:1469`) MUTATES - `&GraduationCap` + active-cap.
- `update_metadata` (`:1481`) / `update_payouts` (`:1529`) / `claim_creator_fees` (`:1546`) / `set_comment_gate` (`:1621`) / `set_buyback_config` (`:1872`) / `creator_heartbeat` (`:1936`) - CreatorCap via `assert_active_creator`.
- `claim_protocol_fees` (`:1580`) / `claim_airdrop_fees` (`:1598`) MOVES-VALUE - `&AdminCap`.
- `post_comment` (`:1648`) MOVES-VALUE - conditional holder gate.
- `lock_tokens` (`:1683`) / `claim_vested` (`:1736`) MOVES-VALUE - sender-scoped.
- `execute_buyback` (`:1895`) MOVES-VALUE - permissionless, `!graduated`.
- `collect_protocol_surcharge` (`:1955`) MOVES-VALUE - permissionless donation to `protocol_fees` (refuted as a finding).
- `propose_takeover` (`:2019`) / `vote_takeover` (`:2076`) / `unvote_takeover` (`:2118`) / `resolve_takeover` (`:2155`) / `reclaim_vote` (`:2201`) MOVES-VALUE - CTO lifecycle (findings D-1, D-2).
- TEST-ONLY: `graduate_for_testing` (`:1253`), `comment_author` (`:1680`), `lock_vested_at` (`:1814`), `init_for_testing` (`:1820`), `new_admin_cap_for_testing` (`:1830`), `set_grad_threshold_for_testing` (`:2251`), `buy_for_testing` (`:2270`) - all `#[test_only]`.
- READ-ONLY accessors: `:434-435`, `:1356`, `:1448`, `:1641`, `:1780-1806`, `:1809-1812`, `:2219-2241`.

`agent_session.move`:
- `open_session` (`:159`) / `open_and_share` (`:191`) / `open_and_share_attested` (`:209`, requires `is_registered`) MOVES-VALUE.
- `top_up_session` (`:230`, owner) MOVES-VALUE.
- `buy_with_session` (`:284`) / `sell_with_session` (`:332`) MOVES-VALUE - `assert_can_trade` + spend_cap.
- `enable_universal_trading` (`:373`) / `disable_universal_trading` (`:382`) MUTATES - owner-only.
- `borrow_for_buy` (`:398`) / `settle_buy` (`:424`) / `borrow_tokens_for_sell` (`:458`) / `settle_sell` (`:479`) MOVES-VALUE - universal path, ticket-bound (finding E-4).
- `revoke_session` (`:511`, owner) MUTATES; `close_session` (`:521`, owner) / `expire_refund` (`:538`, permissionless-to-owner) / `sweep_token` (`:554`, owner) MOVES-VALUE.
- READ-ONLY accessors `:565-573`.

`enclave_registry.move`: `create_registry` (`:68`), `update_pcrs` (`:80`), `revoke_key` (`:96`) AdminCap-gated MUTATES; `register_enclave_key` (`:119`) permissionless, gated by native Nitro attestation + PCR match; `is_registered` (`:140`) READ-ONLY.

`template.move`: `init` (`:33`) - shares CoinMetadata, transfers TreasuryCap to the publisher (F-1 handled downstream in `create_and_return`).

## Appendix B: every shift/scaling site, its guard, and the verified boundary

Shift sites (`<<`, `>>`): NONE in any of the four modules. The Cetus `checked_shlw` class is not applicable. All scaled math is `isqrt` + `u128`-widened multiply-before-divide, which abort on overflow.

Scaling sites and verified boundaries:
- `quote_out` (`:629-634`): `(y_u * dx_u) / (x_u + dx_u)` in u128. `y, dx < 2^64` so the product `< 2^128`; no overflow. Multiply-before-divide, cast back to u64.
- `dampened_grad_threshold` (`:708-715`): `num = isqrt(1000 * 1_000_000)`, `den = isqrt(price_scaled * 1_000_000)`, `BASE_GRAD_MIST * num / den`. Symmetric precision (F-4 fix). Boundary: `9_000e9 * 31_622 = 2.846e17 < u64::MAX 1.8446e19`; `price_scaled(<= 1e5) * 1e6 = 1e11 < u64::MAX`. `isqrt(0) = 0` handled (`:676`); `den == 0` returns BASE (`:713`); `price_scaled == 0` returns BASE (`:709`). No division by zero.
- `buy` Path A needed-SUI (`:955-956`): `((x * remaining_tokens) / (y - remaining_tokens))` in u128. `y = effective_token_reserve = VTR - sold >= remaining_tokens`, and `y - remaining_tokens = VTR - CURVE_SUPPLY = 273,000,000e6 > 0`, so the denominator never underflows or hits zero.
- `buy`/`sell` fee (`:936`, `:991`, `:1143`) and buyback carve (`:1002`, `:1148`): `(x * BPS) / 10_000`, u64. Inputs are mist amounts far below the u64 overflow point for these multipliers (BPS <= 10_000).
- `split_fee_v7` (`:648-656`): remainder construction guarantees exact conservation (invariant 2).
- `do_graduate_inline` bonuses (`:1097-1098`): `(reserve * 50) / 10_000`, u64. `reserve <= ~12,803e9`, product `< 6.5e14 < u64::MAX`.
- `claim_creator_fees` payout (`:1563`): `(total * p.bps) / 10_000`; last recipient gets the remainder (`:1569`), no dust loss.
- `vested_amount` (`:1769`, `:1775`): `(total * elapsed) / duration` in u128.
- CTO math (`:2036`, `:2043`, `:2086`): `(circ * BPS) / 10_000`, u64. `circ <= 800_000_000e6 = 8e14`; `* 2500 = 2e18 < u64::MAX 1.8446e19` - within range (closest to the ceiling; still safe).
- `sui_address_for_ed25519` (`enclave_registry.move:166`): blake2b256, no arithmetic.
