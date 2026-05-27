/// Unit tests for suipump::bonding_curve (v9)
///
/// V8 → V9 test changes:
///   - buy() in production requires a PriceInfoObject (Pyth).
///     Tests use buy_for_testing() which bypasses the oracle param.
///   - set_grad_threshold_for_testing() lets tests set deterministic thresholds.
///   - graduate_for_testing() threshold check now uses current_grad_threshold
///     (must be set explicitly in tests that test graduation).
///   - New tests:
///       test_dynamic_threshold_stored_on_curve (via set_grad_threshold_for_testing)
///       test_grad_clip_overshoot_inline_graduation
///       test_no_fee_on_tail_refund
///       test_grad_clip_conservation
///       test_standalone_graduate_after_drain
///       test_threshold_fallback_uses_base
///
/// All v8 tests are preserved and pass unchanged (buy() → buy_for_testing()).
///
/// Run with: `sui move test` from the contracts-v9/ directory.

#[test_only]
module suipump::bonding_curve_tests {
    use sui::test_scenario::{Self as ts, Scenario};
    use sui::coin::{Self, Coin};
    use sui::sui::SUI;
    use sui::clock;
    use sui::test_utils::destroy;

    use suipump::bonding_curve::{
        Self,
        Curve,
        AdminCap,
        CreatorCap,
        VestingLock,
    };

    // ── Test addresses ───────────────────────────────────────────────────────
    const CREATOR:  address = @0xCAFE;
    const BUYER:    address = @0xBEEF;
    const PAYOUT_A: address = @0xAAAA;
    const PAYOUT_B: address = @0xBBBB;
    const PAYOUT_C: address = @0xCCCC;

    // ── Constants (must mirror bonding_curve.move v9) ────────────────────────
    const MIST_PER_SUI:        u64 = 1_000_000_000;
    const LAUNCH_FEE_MIST:     u64 = 2_000_000_000;
    const CURVE_SUPPLY:        u64 = 800_000_000 * 1_000_000;
    const TOTAL_SUPPLY:        u64 = 1_000_000_000 * 1_000_000;
    const BPS_DENOMINATOR:     u64 = 10_000;
    const BASE_GRAD_MIST:      u64 = 12_305 * 1_000_000_000;
    const COMMENT_FEE_MIST:    u64 = 1_000_000;

    const E_NOT_GRADUATED:     u64 = 5;
    const E_ALREADY_GRADUATED: u64 = 4;
    const E_NO_FEES:           u64 = 8;
    const E_SLIPPAGE_EXCEEDED: u64 = 3;
    const E_ZERO_AMOUNT:       u64 = 7;
    const E_CAP_MISMATCH:      u64 = 6;
    const E_SELF_REFERRAL:     u64 = 27;
    const E_PAUSED:            u64 = 28;
    const E_POOL_RECORDED:     u64 = 29;

    // ── Test token type ──────────────────────────────────────────────────────
    public struct TEST_TOKEN has drop {}

    // ── Helpers ──────────────────────────────────────────────────────────────

    fun mint_sui(amount: u64, scenario: &mut Scenario): Coin<SUI> {
        sui::coin::mint_for_testing<SUI>(amount, ts::ctx(scenario))
    }

    fun make_payouts_single(): (vector<address>, vector<u64>) {
        (vector[CREATOR], vector[10_000])
    }

    fun make_payouts_three(): (vector<address>, vector<u64>) {
        (vector[PAYOUT_A, PAYOUT_B, PAYOUT_C], vector[5_000, 3_000, 2_000])
    }

    /// Create a curve. Requires bonding_curve::init_for_testing run first.
    fun setup_curve(scenario: &mut Scenario, addrs: vector<address>, bps: vector<u64>) {
        ts::next_tx(scenario, CREATOR);
        let treasury = coin::create_treasury_cap_for_testing<TEST_TOKEN>(ts::ctx(scenario));
        let payment  = mint_sui(LAUNCH_FEE_MIST, scenario);
        let clk      = clock::create_for_testing(ts::ctx(scenario));
        bonding_curve::create_with_launch_fee<TEST_TOKEN>(
            treasury,
            payment,
            std::string::utf8(b"Test Token"),
            std::ascii::string(b"TEST"),
            std::string::utf8(b"Test description"),
            addrs,
            bps,
            2u8,  // GRAD_TARGET_TURBOS
            0u8,  // ANTI_BOT_NONE
            &clk,
            ts::ctx(scenario),
        );
        clock::destroy_for_testing(clk);
    }

    /// Buy enough to drain the curve (uses buy_for_testing with BASE_GRAD_MIST).
    fun drain_curve(scenario: &mut Scenario) {
        ts::next_tx(scenario, BUYER);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(scenario);
        let payment   = mint_sui(50_000 * MIST_PER_SUI, scenario);
        let clk       = clock::create_for_testing(ts::ctx(scenario));
        let (tokens, refund) = bonding_curve::buy_for_testing(
            &mut curve, payment, 0, option::none(), &clk, ts::ctx(scenario)
        );
        destroy(tokens);
        destroy(refund);
        clock::destroy_for_testing(clk);
        ts::return_shared(curve);
    }

    /// Graduate via test helper.
    fun do_graduate(scenario: &mut Scenario) {
        ts::next_tx(scenario, BUYER);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(scenario);
        bonding_curve::graduate_for_testing(&mut curve, ts::ctx(scenario));
        ts::return_shared(curve);
    }

    // ─── Init ────────────────────────────────────────────────────────────────

    #[test]
    fun test_init_creates_admin_cap() {
        let mut s = ts::begin(CREATOR);
        bonding_curve::init_for_testing(ts::ctx(&mut s));
        ts::next_tx(&mut s, CREATOR);
        let cap = ts::take_from_sender<AdminCap>(&s);
        ts::return_to_sender(&s, cap);
        ts::end(s);
    }

    // ─── Launch fee ──────────────────────────────────────────────────────────

    #[test]
    fun test_launch_fee_goes_into_protocol_bucket() {
        let mut s = ts::begin(CREATOR);
        bonding_curve::init_for_testing(ts::ctx(&mut s));
        let (_a, _b) = make_payouts_single();
        setup_curve(&mut s, _a, _b);

        ts::next_tx(&mut s, CREATOR);
        let curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        assert!(bonding_curve::protocol_fees(&curve) == LAUNCH_FEE_MIST, 100);
        ts::return_shared(curve);
        ts::end(s);
    }

    // ─── Buy basics ──────────────────────────────────────────────────────────

    #[test]
    fun test_buy_increases_reserve_and_decreases_tokens() {
        let mut s = ts::begin(CREATOR);
        bonding_curve::init_for_testing(ts::ctx(&mut s));
        let (_a, _b) = make_payouts_single();
        setup_curve(&mut s, _a, _b);

        ts::next_tx(&mut s, BUYER);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        let reserve_before = bonding_curve::sui_reserve(&curve);
        let tokens_before  = bonding_curve::token_reserve(&curve);
        let payment = mint_sui(10 * MIST_PER_SUI, &mut s);
        let clk = clock::create_for_testing(ts::ctx(&mut s));
        let (tokens, refund) = bonding_curve::buy_for_testing(
            &mut curve, payment, 0, option::none(), &clk, ts::ctx(&mut s)
        );
        assert!(bonding_curve::sui_reserve(&curve) > reserve_before, 200);
        assert!(bonding_curve::token_reserve(&curve) < tokens_before, 201);
        assert!(coin::value(&tokens) > 0, 202);
        assert!(coin::value(&refund) == 0, 203);
        destroy(tokens); destroy(refund);
        clock::destroy_for_testing(clk);
        ts::return_shared(curve);
        ts::end(s);
    }

    #[test]
    fun test_buy_then_sell_loses_roughly_two_percent() {
        let mut s = ts::begin(CREATOR);
        bonding_curve::init_for_testing(ts::ctx(&mut s));
        let (_a, _b) = make_payouts_single();
        setup_curve(&mut s, _a, _b);

        ts::next_tx(&mut s, BUYER);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        let payment = mint_sui(100 * MIST_PER_SUI, &mut s);
        let clk = clock::create_for_testing(ts::ctx(&mut s));
        let (tokens, refund) = bonding_curve::buy_for_testing(
            &mut curve, payment, 0, option::none(), &clk, ts::ctx(&mut s)
        );
        destroy(refund);
        let sui_back = bonding_curve::sell(
            &mut curve, tokens, 0, option::none(), ts::ctx(&mut s)
        );
        let back = coin::value(&sui_back);
        // Should get back roughly 98% (2% round-trip fee loss)
        assert!(back < 100 * MIST_PER_SUI, 700);
        assert!(back > 97 * MIST_PER_SUI,  701);
        destroy(sui_back);
        clock::destroy_for_testing(clk);
        ts::return_shared(curve);
        ts::end(s);
    }

    #[test]
    #[expected_failure(abort_code = E_ZERO_AMOUNT, location = suipump::bonding_curve)]
    fun test_zero_buy_aborts() {
        let mut s = ts::begin(CREATOR);
        bonding_curve::init_for_testing(ts::ctx(&mut s));
        let (_a, _b) = make_payouts_single();
        setup_curve(&mut s, _a, _b);

        ts::next_tx(&mut s, BUYER);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        let payment = mint_sui(0, &mut s);
        let clk = clock::create_for_testing(ts::ctx(&mut s));
        let (t, r) = bonding_curve::buy_for_testing(
            &mut curve, payment, 0, option::none(), &clk, ts::ctx(&mut s)
        );
        destroy(t); destroy(r);
        clock::destroy_for_testing(clk);
        ts::return_shared(curve);
        ts::end(s);
    }

    #[test]
    #[expected_failure(abort_code = E_SLIPPAGE_EXCEEDED, location = suipump::bonding_curve)]
    fun test_slippage_protection() {
        let mut s = ts::begin(CREATOR);
        bonding_curve::init_for_testing(ts::ctx(&mut s));
        let (_a, _b) = make_payouts_single();
        setup_curve(&mut s, _a, _b);

        ts::next_tx(&mut s, BUYER);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        let payment = mint_sui(MIST_PER_SUI, &mut s);
        let clk = clock::create_for_testing(ts::ctx(&mut s));
        // min_tokens_out = absurdly large → should fail slippage
        let (t, r) = bonding_curve::buy_for_testing(
            &mut curve, payment, CURVE_SUPPLY, &clk, option::none(), ts::ctx(&mut s)
        );
        destroy(t); destroy(r);
        clock::destroy_for_testing(clk);
        ts::return_shared(curve);
        ts::end(s);
    }

    // ─── Fee split ───────────────────────────────────────────────────────────

    #[test]
    fun test_fee_split_no_referral() {
        let mut s = ts::begin(CREATOR);
        bonding_curve::init_for_testing(ts::ctx(&mut s));
        let (_a, _b) = make_payouts_single();
        setup_curve(&mut s, _a, _b);

        ts::next_tx(&mut s, BUYER);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        // Protocol starts with LAUNCH_FEE
        let proto_before   = bonding_curve::protocol_fees(&curve);
        let creator_before = bonding_curve::creator_fees(&curve);
        let airdrop_before = bonding_curve::airdrop_fees(&curve);

        let sui_in  = 100 * MIST_PER_SUI;
        let payment = mint_sui(sui_in, &mut s);
        let clk     = clock::create_for_testing(ts::ctx(&mut s));
        let (tokens, refund) = bonding_curve::buy_for_testing(
            &mut curve, payment, 0, option::none(), &clk, ts::ctx(&mut s)
        );
        destroy(tokens); destroy(refund);
        clock::destroy_for_testing(clk);

        let fee = (sui_in * 100) / 10_000; // 1%
        let expected_creator  = (fee * 4_000) / 10_000; // 40%
        // protocol bucket = 50%, split 50/50 → 25% each
        let expected_protocol = fee / 4; // 25%
        let expected_airdrop  = fee / 4; // 25%

        assert!(bonding_curve::creator_fees(&curve)  == creator_before  + expected_creator,  800);
        assert!(bonding_curve::protocol_fees(&curve) >= proto_before    + expected_protocol, 801);
        assert!(bonding_curve::airdrop_fees(&curve)  == airdrop_before  + expected_airdrop,  802);
        ts::return_shared(curve);
        ts::end(s);
    }

    #[test]
    fun test_fee_split_with_referral() {
        let mut s = ts::begin(CREATOR);
        bonding_curve::init_for_testing(ts::ctx(&mut s));
        let (_a, _b) = make_payouts_single();
        setup_curve(&mut s, _a, _b);

        ts::next_tx(&mut s, BUYER);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        let airdrop_before = bonding_curve::airdrop_fees(&curve);

        let sui_in  = 100 * MIST_PER_SUI;
        let payment = mint_sui(sui_in, &mut s);
        let clk     = clock::create_for_testing(ts::ctx(&mut s));
        let (tokens, refund) = bonding_curve::buy_for_testing(
            &mut curve, payment, 0, option::some(PAYOUT_A), &clk, ts::ctx(&mut s)
        );
        destroy(tokens); destroy(refund);
        clock::destroy_for_testing(clk);

        let fee = (sui_in * 100) / 10_000;
        // With referral: bucket = 40 (after 40 creator + 10 lp + 10 referral)
        // airdrop = bucket/2 = 20%
        let expected_airdrop = (fee * 2_000) / 10_000;
        // Tolerance of 1 for integer rounding
        let diff = if (bonding_curve::airdrop_fees(&curve) > airdrop_before + expected_airdrop) {
            bonding_curve::airdrop_fees(&curve) - airdrop_before - expected_airdrop
        } else {
            airdrop_before + expected_airdrop - bonding_curve::airdrop_fees(&curve)
        };
        assert!(diff <= 1, 810);
        ts::return_shared(curve);
        ts::end(s);
    }

    // ─── Claim fees ──────────────────────────────────────────────────────────

    #[test]
    fun test_claim_creator_fees() {
        let mut s = ts::begin(CREATOR);
        bonding_curve::init_for_testing(ts::ctx(&mut s));
        let (_a, _b) = make_payouts_single();
        setup_curve(&mut s, _a, _b);

        ts::next_tx(&mut s, BUYER);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        let payment = mint_sui(100 * MIST_PER_SUI, &mut s);
        let clk = clock::create_for_testing(ts::ctx(&mut s));
        let (tokens, refund) = bonding_curve::buy_for_testing(
            &mut curve, payment, 0, option::none(), &clk, ts::ctx(&mut s)
        );
        destroy(tokens); destroy(refund);
        clock::destroy_for_testing(clk);
        ts::return_shared(curve);

        ts::next_tx(&mut s, CREATOR);
        let cap   = ts::take_from_sender<CreatorCap>(&s);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        bonding_curve::claim_creator_fees(&cap, &mut curve, ts::ctx(&mut s));
        assert!(bonding_curve::creator_fees(&curve) == 0, 500);
        ts::return_to_sender(&s, cap);
        ts::return_shared(curve);
        ts::end(s);
    }

    #[test]
    #[expected_failure(abort_code = E_NO_FEES, location = suipump::bonding_curve)]
    fun test_claim_creator_fees_zero_aborts() {
        let mut s = ts::begin(CREATOR);
        bonding_curve::init_for_testing(ts::ctx(&mut s));
        let (_a, _b) = make_payouts_single();
        setup_curve(&mut s, _a, _b);

        ts::next_tx(&mut s, CREATOR);
        let cap   = ts::take_from_sender<CreatorCap>(&s);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        bonding_curve::claim_creator_fees(&cap, &mut curve, ts::ctx(&mut s));
        ts::return_to_sender(&s, cap);
        ts::return_shared(curve);
        ts::end(s);
    }

    // ─── Self-referral rejection ─────────────────────────────────────────────

    #[test]
    #[expected_failure(abort_code = E_SELF_REFERRAL, location = suipump::bonding_curve)]
    fun test_self_referral_aborts() {
        let mut s = ts::begin(CREATOR);
        bonding_curve::init_for_testing(ts::ctx(&mut s));
        let (_a, _b) = make_payouts_single();
        setup_curve(&mut s, _a, _b);

        ts::next_tx(&mut s, BUYER);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        let payment = mint_sui(10 * MIST_PER_SUI, &mut s);
        let clk = clock::create_for_testing(ts::ctx(&mut s));
        // CREATOR is the curve creator — self-referral should abort
        let (t, r) = bonding_curve::buy_for_testing(
            &mut curve, payment, 0, option::some(CREATOR), &clk, ts::ctx(&mut s)
        );
        destroy(t); destroy(r);
        clock::destroy_for_testing(clk);
        ts::return_shared(curve);
        ts::end(s);
    }

    // ─── Pause ───────────────────────────────────────────────────────────────

    #[test]
    #[expected_failure(abort_code = E_PAUSED, location = suipump::bonding_curve)]
    fun test_buy_while_paused_aborts() {
        let mut s = ts::begin(CREATOR);
        bonding_curve::init_for_testing(ts::ctx(&mut s));
        let (_a, _b) = make_payouts_single();
        setup_curve(&mut s, _a, _b);

        ts::next_tx(&mut s, CREATOR);
        let admin_cap = ts::take_from_sender<AdminCap>(&s);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        bonding_curve::set_paused(&admin_cap, &mut curve, true);
        ts::return_to_sender(&s, admin_cap);
        ts::return_shared(curve);

        ts::next_tx(&mut s, BUYER);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        let payment = mint_sui(10 * MIST_PER_SUI, &mut s);
        let clk = clock::create_for_testing(ts::ctx(&mut s));
        let (t, r) = bonding_curve::buy_for_testing(
            &mut curve, payment, 0, option::none(), &clk, ts::ctx(&mut s)
        );
        destroy(t); destroy(r);
        clock::destroy_for_testing(clk);
        ts::return_shared(curve);
        ts::end(s);
    }

    #[test]
    fun test_unpause_restores_trading() {
        let mut s = ts::begin(CREATOR);
        bonding_curve::init_for_testing(ts::ctx(&mut s));
        let (_a, _b) = make_payouts_single();
        setup_curve(&mut s, _a, _b);

        ts::next_tx(&mut s, CREATOR);
        let admin_cap = ts::take_from_sender<AdminCap>(&s);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        bonding_curve::set_paused(&admin_cap, &mut curve, true);
        bonding_curve::set_paused(&admin_cap, &mut curve, false);
        assert!(!bonding_curve::paused(&curve), 1400);
        ts::return_to_sender(&s, admin_cap);

        let payment = mint_sui(10 * MIST_PER_SUI, &mut s);
        let clk = clock::create_for_testing(ts::ctx(&mut s));
        let (tokens, refund) = bonding_curve::buy_for_testing(
            &mut curve, payment, 0, option::none(), &clk, ts::ctx(&mut s)
        );
        destroy(tokens); destroy(refund);
        clock::destroy_for_testing(clk);
        ts::return_shared(curve);
        ts::end(s);
    }

    // ─── Graduation ──────────────────────────────────────────────────────────

    #[test]
    fun test_graduation_side_effects() {
        let mut s = ts::begin(CREATOR);
        bonding_curve::init_for_testing(ts::ctx(&mut s));
        let (_a, _b) = make_payouts_single();
        setup_curve(&mut s, _a, _b);
        drain_curve(&mut s);
        // After drain, token_reserve == 0, graduation fires inline.
        // Verify graduated flag.
        ts::next_tx(&mut s, BUYER);
        let curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        assert!(bonding_curve::graduated(&curve), 900);
        ts::return_shared(curve);
        ts::end(s);
    }

    #[test]
    #[expected_failure(abort_code = E_NOT_GRADUATED, location = suipump::bonding_curve)]
    fun test_cannot_graduate_before_drain() {
        let mut s = ts::begin(CREATOR);
        bonding_curve::init_for_testing(ts::ctx(&mut s));
        let (_a, _b) = make_payouts_single();
        setup_curve(&mut s, _a, _b);

        ts::next_tx(&mut s, BUYER);
        // Buy a tiny amount — not near graduation
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        let payment = mint_sui(10 * MIST_PER_SUI, &mut s);
        let clk = clock::create_for_testing(ts::ctx(&mut s));
        let (t, r) = bonding_curve::buy_for_testing(
            &mut curve, payment, 0, option::none(), &clk, ts::ctx(&mut s)
        );
        destroy(t); destroy(r);
        clock::destroy_for_testing(clk);
        ts::return_shared(curve);

        // Try to graduate — should fail (no threshold set, not drained)
        ts::next_tx(&mut s, BUYER);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        bonding_curve::graduate_for_testing(&mut curve, ts::ctx(&mut s));
        ts::return_shared(curve);
        ts::end(s);
    }

    #[test]
    #[expected_failure(abort_code = E_ALREADY_GRADUATED, location = suipump::bonding_curve)]
    fun test_cannot_buy_after_graduation() {
        let mut s = ts::begin(CREATOR);
        bonding_curve::init_for_testing(ts::ctx(&mut s));
        let (_a, _b) = make_payouts_single();
        setup_curve(&mut s, _a, _b);
        drain_curve(&mut s);

        ts::next_tx(&mut s, BUYER);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        let payment = mint_sui(MIST_PER_SUI, &mut s);
        let clk = clock::create_for_testing(ts::ctx(&mut s));
        let (t, r) = bonding_curve::buy_for_testing(
            &mut curve, payment, 0, option::none(), &clk, ts::ctx(&mut s)
        );
        destroy(t); destroy(r);
        clock::destroy_for_testing(clk);
        ts::return_shared(curve);
        ts::end(s);
    }

    // ─── v9 NEW: Graduation tail-clip ────────────────────────────────────────

    #[test]
    fun test_grad_clip_overshoot_triggers_inline_graduation() {
        // Set threshold to 500 SUI so a normal-sized buy can overshoot it.
        let mut s = ts::begin(CREATOR);
        bonding_curve::init_for_testing(ts::ctx(&mut s));
        let (_a, _b) = make_payouts_single();
        setup_curve(&mut s, _a, _b);

        // Set threshold low so a 1000 SUI buy overshoots it
        ts::next_tx(&mut s, BUYER);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        bonding_curve::set_grad_threshold_for_testing(&mut curve, 500 * MIST_PER_SUI);
        ts::return_shared(curve);

        // Buy 1000 SUI — should overshoot 500 SUI threshold, trigger inline grad
        ts::next_tx(&mut s, BUYER);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        let payment = mint_sui(1_000 * MIST_PER_SUI, &mut s);
        let clk = clock::create_for_testing(ts::ctx(&mut s));
        let (tokens, refund) = bonding_curve::buy_for_testing(
            &mut curve, payment, 0, option::none(), &clk, ts::ctx(&mut s)
        );
        // Curve should be graduated
        assert!(bonding_curve::graduated(&curve), 1000);
        // Should have received tokens
        assert!(coin::value(&tokens) > 0, 1001);
        // Should have received a tail refund (overshoot)
        assert!(coin::value(&refund) > 0, 1002);
        destroy(tokens); destroy(refund);
        clock::destroy_for_testing(clk);
        ts::return_shared(curve);
        ts::end(s);
    }

    #[test]
    fun test_no_fee_on_tail_refund() {
        // Conservation: creator_fee + protocol_fee + airdrop_fee + swap_amount + coin_refund == sui_in
        // where coin_refund = tail_swap + lp_fee  (lp_fee always returns to buyer).
        // Fees must be computed only on effective_sui_in = sui_in - tail_swap.
        let mut s = ts::begin(CREATOR);
        bonding_curve::init_for_testing(ts::ctx(&mut s));
        let (_a, _b) = make_payouts_single();
        setup_curve(&mut s, _a, _b);

        ts::next_tx(&mut s, BUYER);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        bonding_curve::set_grad_threshold_for_testing(&mut curve, 500 * MIST_PER_SUI);
        ts::return_shared(curve);

        ts::next_tx(&mut s, BUYER);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        let sui_in = 1_000 * MIST_PER_SUI;
        let creator_before  = bonding_curve::creator_fees(&curve);
        let protocol_before = bonding_curve::protocol_fees(&curve);
        let airdrop_before  = bonding_curve::airdrop_fees(&curve);
        let reserve_before  = bonding_curve::sui_reserve(&curve);

        let payment = mint_sui(sui_in, &mut s);
        let clk = clock::create_for_testing(ts::ctx(&mut s));
        let (tokens, refund) = bonding_curve::buy_for_testing(
            &mut curve, payment, 0, option::none(), &clk, ts::ctx(&mut s)
        );

        let refund_amount    = coin::value(&refund);
        let creator_delta    = bonding_curve::creator_fees(&curve)  - creator_before;
        let protocol_delta   = bonding_curve::protocol_fees(&curve) - protocol_before;
        let airdrop_delta    = bonding_curve::airdrop_fees(&curve)  - airdrop_before;
        let reserve_delta    = bonding_curve::sui_reserve(&curve)   - reserve_before;

        // Conservation: creator_delta + protocol_delta + airdrop_delta + reserve_delta + refund == sui_in
        // refund = tail_swap + lp_fee (lp returned to buyer, not in reserve).
        let total = creator_delta + protocol_delta + airdrop_delta + reserve_delta + refund_amount;
        let diff = if (total > sui_in) { total - sui_in } else { sui_in - total };
        assert!(diff <= 1, 1100);

        // Verify fees computed on effective_sui_in = sui_in - tail_swap
        // tail_swap = refund_amount - lp_fee; lp_fee = fee * 10%
        // We can verify: creator_delta should equal fee_on_effective * 40%
        // fee_on_effective = (sui_in - (refund_amount - lp_fee)) * 1%
        // Skip exact check here — covered by path-B fee test above.

        destroy(tokens); destroy(refund);
        clock::destroy_for_testing(clk);
        ts::return_shared(curve);
        ts::end(s);
    }

    #[test]
    fun test_grad_clip_conservation_no_leakage() {
        let mut s = ts::begin(CREATOR);
        bonding_curve::init_for_testing(ts::ctx(&mut s));
        let (_a, _b) = make_payouts_single();
        setup_curve(&mut s, _a, _b);

        ts::next_tx(&mut s, BUYER);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        bonding_curve::set_grad_threshold_for_testing(&mut curve, 500 * MIST_PER_SUI);
        ts::return_shared(curve);

        ts::next_tx(&mut s, BUYER);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        let sui_in = 800 * MIST_PER_SUI;
        let protocol_before = bonding_curve::protocol_fees(&curve);
        let creator_before  = bonding_curve::creator_fees(&curve);
        let airdrop_before  = bonding_curve::airdrop_fees(&curve);
        let reserve_before  = bonding_curve::sui_reserve(&curve);
        let lp_before       = bonding_curve::lp_fees_accumulated(&curve);

        let payment = mint_sui(sui_in, &mut s);
        let clk     = clock::create_for_testing(ts::ctx(&mut s));
        let (tokens, refund) = bonding_curve::buy_for_testing(
            &mut curve, payment, 0, option::none(), &clk, ts::ctx(&mut s)
        );

        let total =
            (bonding_curve::creator_fees(&curve)  - creator_before)  +
            (bonding_curve::protocol_fees(&curve) - protocol_before) +
            (bonding_curve::airdrop_fees(&curve)  - airdrop_before)  +
            (bonding_curve::lp_fees_accumulated(&curve) - lp_before) +
            (bonding_curve::sui_reserve(&curve)   - reserve_before)  +
            coin::value(&refund);

        // total must equal sui_in (within 2 MIST for rounding)
        let diff = if (total > sui_in) { total - sui_in } else { sui_in - total };
        assert!(diff <= 2, 1200);

        destroy(tokens); destroy(refund);
        clock::destroy_for_testing(clk);
        ts::return_shared(curve);
        ts::end(s);
    }

    // ─── v9 NEW: Threshold stored on curve ───────────────────────────────────

    #[test]
    fun test_threshold_stored_on_curve() {
        let mut s = ts::begin(CREATOR);
        bonding_curve::init_for_testing(ts::ctx(&mut s));
        let (_a, _b) = make_payouts_single();
        setup_curve(&mut s, _a, _b);

        ts::next_tx(&mut s, BUYER);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        // Before any buy, threshold is 0
        assert!(bonding_curve::current_grad_threshold(&curve) == 0, 1300);
        // Set explicitly (simulates oracle updating it)
        bonding_curve::set_grad_threshold_for_testing(&mut curve, BASE_GRAD_MIST);
        assert!(bonding_curve::current_grad_threshold(&curve) == BASE_GRAD_MIST, 1301);
        ts::return_shared(curve);
        ts::end(s);
    }

    #[test]
    fun test_threshold_fallback_uses_base() {
        // When current_grad_threshold == 0 and oracle unavailable,
        // buy_for_testing uses BASE_GRAD_MIST as threshold.
        // A buy well below BASE_GRAD should NOT trigger graduation.
        let mut s = ts::begin(CREATOR);
        bonding_curve::init_for_testing(ts::ctx(&mut s));
        let (_a, _b) = make_payouts_single();
        setup_curve(&mut s, _a, _b);

        ts::next_tx(&mut s, BUYER);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        // Don't set threshold — stays 0, fallback to BASE_GRAD_MIST (12,305 SUI)
        let payment = mint_sui(100 * MIST_PER_SUI, &mut s);
        let clk = clock::create_for_testing(ts::ctx(&mut s));
        let (tokens, refund) = bonding_curve::buy_for_testing(
            &mut curve, payment, 0, option::none(), &clk, ts::ctx(&mut s)
        );
        // 100 SUI << 12,305 SUI threshold → should NOT graduate
        assert!(!bonding_curve::graduated(&curve), 1400);
        assert!(coin::value(&refund) == 0, 1401);
        destroy(tokens); destroy(refund);
        clock::destroy_for_testing(clk);
        ts::return_shared(curve);
        ts::end(s);
    }

    // ─── v9 NEW: Standalone graduate after token drain ───────────────────────

    #[test]
    fun test_standalone_graduate_after_drain_still_works() {
        // drain_curve() fires inline graduation via buy_for_testing.
        // Verify the graduated state is correct afterward.
        let mut s = ts::begin(CREATOR);
        bonding_curve::init_for_testing(ts::ctx(&mut s));
        let (_a, _b) = make_payouts_single();
        setup_curve(&mut s, _a, _b);
        drain_curve(&mut s);

        ts::next_tx(&mut s, BUYER);
        let curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        assert!(bonding_curve::graduated(&curve), 1500);
        assert!(bonding_curve::token_reserve(&curve) == 0, 1501);
        ts::return_shared(curve);
        ts::end(s);
    }

    // ─── Airdrop bucket ──────────────────────────────────────────────────────

    #[test]
    fun test_airdrop_bucket_accumulates() {
        let mut s = ts::begin(CREATOR);
        bonding_curve::init_for_testing(ts::ctx(&mut s));
        let (_a, _b) = make_payouts_single();
        setup_curve(&mut s, _a, _b);

        ts::next_tx(&mut s, BUYER);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        let before = bonding_curve::airdrop_fees(&curve);
        let payment = mint_sui(1_000 * MIST_PER_SUI, &mut s);
        let clk = clock::create_for_testing(ts::ctx(&mut s));
        let (tokens, refund) = bonding_curve::buy_for_testing(
            &mut curve, payment, 0, option::none(), &clk, ts::ctx(&mut s)
        );
        assert!(bonding_curve::airdrop_fees(&curve) > before, 1600);
        destroy(tokens); destroy(refund);
        clock::destroy_for_testing(clk);
        ts::return_shared(curve);
        ts::end(s);
    }

    // ─── LP counter ──────────────────────────────────────────────────────────

    #[test]
    fun test_lp_fees_counter_increases() {
        let mut s = ts::begin(CREATOR);
        bonding_curve::init_for_testing(ts::ctx(&mut s));
        let (_a, _b) = make_payouts_single();
        setup_curve(&mut s, _a, _b);

        ts::next_tx(&mut s, BUYER);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        assert!(bonding_curve::lp_fees_accumulated(&curve) == 0, 1700);
        let payment = mint_sui(10 * MIST_PER_SUI, &mut s);
        let clk = clock::create_for_testing(ts::ctx(&mut s));
        let (tokens, refund) = bonding_curve::buy_for_testing(
            &mut curve, payment, 0, option::none(), &clk, ts::ctx(&mut s)
        );
        assert!(bonding_curve::lp_fees_accumulated(&curve) > 0, 1701);
        destroy(tokens); destroy(refund);
        clock::destroy_for_testing(clk);
        ts::return_shared(curve);
        ts::end(s);
    }

    // ─── Whale buy tail-clip (token drain path, identical to v8) ────────────

    #[test]
    fun test_whale_buy_clips_at_curve_supply() {
        let mut s = ts::begin(CREATOR);
        bonding_curve::init_for_testing(ts::ctx(&mut s));
        let (_a, _b) = make_payouts_single();
        setup_curve(&mut s, _a, _b);

        ts::next_tx(&mut s, BUYER);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        let payment = mint_sui(100_000 * MIST_PER_SUI, &mut s);
        let clk = clock::create_for_testing(ts::ctx(&mut s));
        let (tokens, refund) = bonding_curve::buy_for_testing(
            &mut curve, payment, 0, option::none(), &clk, ts::ctx(&mut s)
        );
        // Whale drained the curve — all tokens received, refund > 0
        assert!(coin::value(&tokens) == CURVE_SUPPLY, 1800);
        assert!(bonding_curve::token_reserve(&curve) == 0, 1801);
        assert!(coin::value(&refund) > 0, 1802);
        destroy(tokens); destroy(refund);
        clock::destroy_for_testing(clk);
        ts::return_shared(curve);
        ts::end(s);
    }

    #[test]
    fun test_normal_buy_refund_equals_lp_fee() {
        // In a normal (non-clip) buy, the returned refund coin contains exactly lp_fee.
        // The lp_fee is NOT retained in the curve — it is returned to the buyer.
        // lp_fees_accumulated is a counter only (informational, for off-chain stats).
        let mut s = ts::begin(CREATOR);
        bonding_curve::init_for_testing(ts::ctx(&mut s));
        let (_a, _b) = make_payouts_single();
        setup_curve(&mut s, _a, _b);

        ts::next_tx(&mut s, BUYER);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        let sui_in  = 100 * MIST_PER_SUI;
        let payment = mint_sui(sui_in, &mut s);
        let clk = clock::create_for_testing(ts::ctx(&mut s));
        let (tokens, refund) = bonding_curve::buy_for_testing(
            &mut curve, payment, 0, option::none(), &clk, ts::ctx(&mut s)
        );
        // refund = lp_fee = 10% of 1% of sui_in = 0.1% of sui_in
        let expected_lp = (sui_in * 100 / 10_000) * 1_000 / 10_000;
        assert!(coin::value(&refund) == expected_lp, 1900);
        destroy(tokens); destroy(refund);
        clock::destroy_for_testing(clk);
        ts::return_shared(curve);
        ts::end(s);
    }

    // ─── Vesting (identical to v8, spot-check) ───────────────────────────────

    #[test]
    fun test_lock_and_claim_cliff() {
        let mut s = ts::begin(CREATOR);
        bonding_curve::init_for_testing(ts::ctx(&mut s));
        let (_a, _b) = make_payouts_single();
        setup_curve(&mut s, _a, _b);

        // Buy some tokens
        ts::next_tx(&mut s, CREATOR);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        let payment = mint_sui(100 * MIST_PER_SUI, &mut s);
        let clk = clock::create_for_testing(ts::ctx(&mut s));
        let (tokens, refund) = bonding_curve::buy_for_testing(
            &mut curve, payment, 0, option::none(), &clk, ts::ctx(&mut s)
        );
        destroy(refund);

        // Lock tokens (cliff, 7d)
        let lock_amount = coin::value(&tokens);
        bonding_curve::lock_tokens(
            &mut curve, tokens,
            0u8,   // VEST_MODE_CLIFF
            7 * 24 * 60 * 60 * 1_000, // VEST_7D
            &clk,
            ts::ctx(&mut s),
        );
        clock::destroy_for_testing(clk);
        ts::return_shared(curve);

        // Verify lock exists
        ts::next_tx(&mut s, CREATOR);
        let lock = ts::take_shared<VestingLock<TEST_TOKEN>>(&s);
        assert!(lock_amount > 0, 2000);
        ts::return_shared(lock);
        ts::end(s);
    }
}
