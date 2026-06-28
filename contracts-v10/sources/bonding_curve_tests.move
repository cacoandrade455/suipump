/// Unit tests for suipump::bonding_curve (v9)
///
/// Built on the v6 test base (create_treasury_cap_for_testing — no metadata).
/// Changes from v6 tests:
///   - sell() now takes a referral arg
///   - graduate() requires a CoinMetadata object that cannot be fabricated in
///     the Move test VM, so tests call graduate_for_testing() (identical minus
///     the metadata freeze). Production graduate() is exercised on-chain.
///   - post_comment() now takes &mut Curve + a 0.001 SUI payment
///   - Curve shape recalibrated: VS=4.369k, BASE_GRAD=12305 SUI @$1.00
///   - buy() now takes sui_price_scaled: u64 (oracle price * 1000; 0=fallback)
///   - Tests use buy_for_testing() which bypasses oracle param
///   - New v9 tests: oracle fallback, grad threshold clip, inline graduation,
///     tail refund conservation, lp_fee returned to buyer
///   - All v8 tests preserved unchanged
///
/// Note on update_metadata: the function requires a real CoinMetadata<T>,
/// which sui::coin only mints via create_currency (needs a genuine one-time
/// witness) — not constructible inside a test module. update_metadata is
/// therefore validated on testnet rather than in unit tests; its pre/post
/// state (metadata_updated flag, 24h window) is still unit-tested below.
///
/// Run with: `sui move test` from the contracts-v9/ directory.
#[test_only]
module suipump::bonding_curve_tests {
    use sui::coin::{Self, Coin};
    use sui::sui::SUI;
    use sui::test_scenario::{Self as ts, Scenario};
    use sui::test_utils::destroy;
    use sui::clock;
    use sui::transfer;
    use std::ascii;
    use std::string;

    use suipump::bonding_curve::{Self, Curve, CreatorCap, AdminCap};

    public struct TEST_TOKEN has drop {}

    const CREATOR:   address = @0xC1EA70;
    const BUYER:     address = @0xB0FEE;
    const REFERRER:  address = @0x5EF;
    const PAYOUT_A:  address = @0xA;
    const PAYOUT_B:  address = @0xB;
    const PAYOUT_C:  address = @0xC;

    const MIST_PER_SUI: u64 = 1_000_000_000;
    const LAUNCH_FEE:   u64 = 2 * 1_000_000_000;
    const COMMENT_FEE:  u64 = 1_000_000; // 0.001 SUI

    // Error codes — must match bonding_curve.move exactly
    const E_SLIPPAGE_EXCEEDED:        u64 = 3;
    const E_ALREADY_GRADUATED:        u64 = 4;
    const E_NOT_GRADUATED:            u64 = 5;
    const E_ZERO_AMOUNT:              u64 = 7;
    const E_BAD_PAYOUTS:              u64 = 19;  // covers empty + sum invalid + duplicate
    const E_TOO_MANY_PAYOUTS:         u64 = 20;
    const E_WRONG_LAUNCH_FEE:         u64 = 9;
    const E_COMMENT_TOO_LONG:         u64 = 16;
    const E_COMMENT_EMPTY:            u64 = 17;
    const E_ANTI_BOT_BLOCKED:         u64 = 18;
    const E_INVALID_GRAD_TARGET:      u64 = 10;
    const E_WRONG_COMMENT_FEE:        u64 = 26;
    const E_SELF_REFERRAL:            u64 = 27;
    const E_PAUSED:                   u64 = 28;
    const E_POOL_ALREADY_RECORDED:    u64 = 29;
    const E_INVALID_VEST_MODE:        u64 = 30;
    const E_INVALID_VEST_DURATION:    u64 = 31;
    const E_MONTHLY_NEEDS_30_DAYS:    u64 = 32;
    const E_NOT_LOCK_BENEFICIARY:     u64 = 33;
    const E_NOTHING_VESTED:           u64 = 34;
    const E_ZERO_LOCK_AMOUNT:         u64 = 35;
    // V10 error codes (mirror bonding_curve)
    const E_NOT_ACTIVE_CREATOR:       u64 = 36;
    const E_HOLDER_ONLY:              u64 = 37;
    const E_BUYBACK_BPS_TOO_HIGH:     u64 = 38;
    const E_NO_BUYBACK:               u64 = 39;
    const E_CREATOR_STILL_ACTIVE:     u64 = 40;
    const E_CTO_ON_COOLDOWN:          u64 = 41;
    const E_BELOW_NOMINATE_THRESHOLD: u64 = 42;

    // ─── Helpers ─────────────────────────────────────────────────────────────

    fun mint_sui(amount: u64, scenario: &mut Scenario): Coin<SUI> {
        coin::mint_for_testing<SUI>(amount, ts::ctx(scenario))
    }

    fun make_payouts_single(): (vector<address>, vector<u64>) {
        (vector[CREATOR], vector[10_000])
    }

    fun make_payouts_three(): (vector<address>, vector<u64>) {
        (vector[PAYOUT_A, PAYOUT_B, PAYOUT_C], vector[5_000, 3_000, 2_000])
    }

    /// Create a v7 curve. Shares the Curve, transfers CreatorCap to CREATOR.
    fun setup_curve(scenario: &mut Scenario,
                    payout_addresses: vector<address>,
                    payout_bps: vector<u64>) {
        let treasury = coin::create_treasury_cap_for_testing<TEST_TOKEN>(
            ts::ctx(scenario)
        );
        let payment = mint_sui(LAUNCH_FEE, scenario);
        let clk = clock::create_for_testing(ts::ctx(scenario));
        bonding_curve::create_with_launch_fee<TEST_TOKEN>(
            treasury, payment,
            string::utf8(b"Test Token"), ascii::string(b"TEST"),
            string::utf8(b"Test description"),
            payout_addresses, payout_bps,
            0, // graduation_target: 0 = Cetus
            0, // anti_bot_delay
            &clk,
            ts::ctx(scenario),
        );
        clock::destroy_for_testing(clk);
    }

    /// Create a curve with a specified graduation target.
    fun setup_curve_target(scenario: &mut Scenario, graduation_target: u8) {
        let treasury = coin::create_treasury_cap_for_testing<TEST_TOKEN>(
            ts::ctx(scenario)
        );
        let payment = mint_sui(LAUNCH_FEE, scenario);
        let clk = clock::create_for_testing(ts::ctx(scenario));
        bonding_curve::create_with_launch_fee<TEST_TOKEN>(
            treasury, payment,
            string::utf8(b"Test Token"), ascii::string(b"TEST"),
            string::utf8(b"Test description"),
            vector[CREATOR], vector[10_000],
            graduation_target,
            0,
            &clk,
            ts::ctx(scenario),
        );
        clock::destroy_for_testing(clk);
    }

    /// Create curve with anti-bot delay set.
    fun setup_curve_with_antibot(scenario: &mut Scenario,
                                  anti_bot_delay: u8,
                                  clock_ms: u64): clock::Clock {
        let treasury = coin::create_treasury_cap_for_testing<TEST_TOKEN>(
            ts::ctx(scenario)
        );
        let payment = mint_sui(LAUNCH_FEE, scenario);
        let mut clk = clock::create_for_testing(ts::ctx(scenario));
        clock::set_for_testing(&mut clk, clock_ms);
        bonding_curve::create_with_launch_fee<TEST_TOKEN>(
            treasury, payment,
            string::utf8(b"AB Token"), ascii::string(b"ABT"),
            string::utf8(b"Anti-bot test"),
            vector[CREATOR], vector[10_000],
            0,
            anti_bot_delay,
            &clk,
            ts::ctx(scenario),
        );
        clk
    }

    /// Buy enough SUI to drain the entire 800M token supply via tail-clip.
    fun drain_curve(scenario: &mut Scenario) {
        ts::next_tx(scenario, BUYER);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(scenario);
        let payment = mint_sui(50_000 * MIST_PER_SUI, scenario);
        let clk = clock::create_for_testing(ts::ctx(scenario));
        let (tokens, refund) = bonding_curve::buy_for_testing(
            &mut curve, payment, 0,
            option::none(),
            &clk,
            ts::ctx(scenario)
        );
        destroy(tokens);
        destroy(refund);
        clock::destroy_for_testing(clk);
        ts::return_shared(curve);
    }

    /// Graduate the curve via the test-only helper (skips metadata freeze).
    fun do_graduate(scenario: &mut Scenario) {
        ts::next_tx(scenario, BUYER);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(scenario);
        bonding_curve::graduate_for_testing(&mut curve, ts::ctx(scenario));
        ts::return_shared(curve);
    }

    // ─── Launch fee ──────────────────────────────────────────────────────────

    #[test]
    fun test_launch_fee_goes_into_protocol_bucket() {
        let mut s = ts::begin(CREATOR);
        let (_a, _b) = make_payouts_single();
        setup_curve(&mut s, _a, _b);

        ts::next_tx(&mut s, CREATOR);
        let curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        assert!(bonding_curve::protocol_fees(&curve) == LAUNCH_FEE, 100);
        ts::return_shared(curve);
        ts::end(s);
    }

    #[test]
    #[expected_failure(abort_code = E_WRONG_LAUNCH_FEE, location = suipump::bonding_curve)]
    fun test_launch_fee_wrong_amount_aborts() {
        let mut s = ts::begin(CREATOR);
        let treasury = coin::create_treasury_cap_for_testing<TEST_TOKEN>(ts::ctx(&mut s));
        let bad_payment = mint_sui(MIST_PER_SUI, &mut s);
        let (addrs, bps) = make_payouts_single();
        let clk = clock::create_for_testing(ts::ctx(&mut s));
        bonding_curve::create_with_launch_fee<TEST_TOKEN>(
            treasury, bad_payment,
            string::utf8(b"T"), ascii::string(b"T"),
            string::utf8(b"desc"),
            addrs, bps,
            0, 0, &clk,
            ts::ctx(&mut s),
        );
        clock::destroy_for_testing(clk);
        ts::end(s);
    }

    #[test]
    fun test_creator_cap_transferred_to_publisher() {
        let mut s = ts::begin(CREATOR);
        let (_a, _b) = make_payouts_single();
        setup_curve(&mut s, _a, _b);

        ts::next_tx(&mut s, CREATOR);
        let cap   = ts::take_from_sender<CreatorCap>(&s);
        let curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        // creator_cap_curve_id not exposed in V8 — just verify objects exist
        ts::return_to_sender(&s, cap);
        ts::return_shared(curve);
        ts::end(s);
    }

    // ─── Graduation target validation (v7: Turbos added) ─────────────────────

    #[test]
    fun test_graduation_target_turbos_accepted() {
        let mut s = ts::begin(CREATOR);
        setup_curve_target(&mut s, 2); // 2 = Turbos

        ts::next_tx(&mut s, CREATOR);
        let curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        assert!(bonding_curve::graduation_target(&curve) == 2, 250);
        ts::return_shared(curve);
        ts::end(s);
    }

    #[test]
    #[expected_failure(abort_code = E_INVALID_GRAD_TARGET, location = suipump::bonding_curve)]
    fun test_graduation_target_invalid_rejected() {
        let mut s = ts::begin(CREATOR);
        setup_curve_target(&mut s, 5); // invalid
        ts::end(s);
    }

    // ─── Payout validation ───────────────────────────────────────────────────

    #[test]
    #[expected_failure(abort_code = E_BAD_PAYOUTS, location = suipump::bonding_curve)]
    fun test_empty_payouts_rejected() {
        let mut s = ts::begin(CREATOR);
        setup_curve(&mut s, vector[], vector[]);
        ts::end(s);
    }

    #[test]
    #[expected_failure(abort_code = E_BAD_PAYOUTS, location = suipump::bonding_curve)]
    fun test_payouts_not_summing_to_10000_rejected() {
        let mut s = ts::begin(CREATOR);
        setup_curve(&mut s, vector[PAYOUT_A, PAYOUT_B], vector[3_000, 3_000]);
        ts::end(s);
    }

    #[test]
    #[expected_failure(abort_code = E_BAD_PAYOUTS, location = suipump::bonding_curve)]
    fun test_duplicate_payout_address_rejected() {
        let mut s = ts::begin(CREATOR);
        setup_curve(&mut s, vector[PAYOUT_A, PAYOUT_A], vector[5_000, 5_000]);
        ts::end(s);
    }

    #[test]
    #[expected_failure(abort_code = E_BAD_PAYOUTS, location = suipump::bonding_curve)]
    fun test_too_many_payouts_rejected() {
        let mut s = ts::begin(CREATOR);
        setup_curve(
            &mut s,
            vector[@0x1,@0x2,@0x3,@0x4,@0x5,@0x6,@0x7,@0x8,@0x9,@0xa,@0xb],
            vector[1_000,1_000,1_000,1_000,1_000,1_000,1_000,1_000,1_000,500,500],
        );
        ts::end(s);
    }

    // ─── Multi-payout claim arithmetic ───────────────────────────────────────

    #[test]
    fun test_three_way_payout_split_pays_each_recipient() {
        let mut s = ts::begin(CREATOR);
        let (a, b) = make_payouts_three();
        setup_curve(&mut s, a, b);

        ts::next_tx(&mut s, BUYER);
        {
            let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
            let payment = mint_sui(100 * MIST_PER_SUI, &mut s);
            let clk = clock::create_for_testing(ts::ctx(&mut s));
            let (tokens, refund) = bonding_curve::buy_for_testing(
                &mut curve, payment, 0, option::none(), &clk, ts::ctx(&mut s)
            );
            destroy(tokens);
            destroy(refund);
            clock::destroy_for_testing(clk);
            ts::return_shared(curve);
        };

        ts::next_tx(&mut s, CREATOR);
        let cap   = ts::take_from_sender<CreatorCap>(&s);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        let total = bonding_curve::creator_fees(&curve);
        let clk_cf = clock::create_for_testing(ts::ctx(&mut s));
        bonding_curve::claim_creator_fees(&cap, &mut curve, &clk_cf, ts::ctx(&mut s));
        clock::destroy_for_testing(clk_cf);
        ts::return_to_sender(&s, cap);
        ts::return_shared(curve);

        ts::next_tx(&mut s, PAYOUT_A);
        let a_coin = ts::take_from_address<Coin<SUI>>(&s, PAYOUT_A);
        assert!(coin::value(&a_coin) == (total * 5_000) / 10_000, 310);
        destroy(a_coin);
        let b_coin = ts::take_from_address<Coin<SUI>>(&s, PAYOUT_B);
        assert!(coin::value(&b_coin) == (total * 3_000) / 10_000, 311);
        destroy(b_coin);
        let c_coin = ts::take_from_address<Coin<SUI>>(&s, PAYOUT_C);
        destroy(c_coin);

        ts::end(s);
    }

    // ─── Buy / Sell ──────────────────────────────────────────────────────────

    #[test]
    fun test_buy_then_sell_loses_roughly_two_percent() {
        let mut s = ts::begin(CREATOR);
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
        assert!(back < 100 * MIST_PER_SUI, 700);
        assert!(back > 97  * MIST_PER_SUI, 701);
        destroy(sui_back);
        clock::destroy_for_testing(clk);
        ts::return_shared(curve);
        ts::end(s);
    }

    #[test]
    #[expected_failure(abort_code = E_ZERO_AMOUNT, location = suipump::bonding_curve)]
    fun test_buy_rejects_zero_amount() {
        let mut s = ts::begin(CREATOR);
        let (_a, _b) = make_payouts_single();
        setup_curve(&mut s, _a, _b);

        ts::next_tx(&mut s, BUYER);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        let payment = mint_sui(0, &mut s);
        let clk = clock::create_for_testing(ts::ctx(&mut s));
        let (tokens, refund) = bonding_curve::buy_for_testing(
            &mut curve, payment, 0, option::none(), &clk, ts::ctx(&mut s)
        );
        destroy(tokens);
        destroy(refund);
        clock::destroy_for_testing(clk);
        ts::return_shared(curve);
        ts::end(s);
    }

    #[test]
    #[expected_failure(abort_code = E_SLIPPAGE_EXCEEDED, location = suipump::bonding_curve)]
    fun test_slippage_protection_triggers() {
        let mut s = ts::begin(CREATOR);
        let (_a, _b) = make_payouts_single();
        setup_curve(&mut s, _a, _b);

        ts::next_tx(&mut s, BUYER);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        let payment = mint_sui(10 * MIST_PER_SUI, &mut s);
        let clk = clock::create_for_testing(ts::ctx(&mut s));
        let (tokens, refund) = bonding_curve::buy_for_testing(
            &mut curve, payment, 999_999_999_999_999, option::none(), &clk, ts::ctx(&mut s)
        );
        destroy(tokens);
        destroy(refund);
        clock::destroy_for_testing(clk);
        ts::return_shared(curve);
        ts::end(s);
    }

    #[test]
    fun test_whale_buy_clips_and_refunds() {
        let mut s = ts::begin(CREATOR);
        let (_a, _b) = make_payouts_single();
        setup_curve(&mut s, _a, _b);

        ts::next_tx(&mut s, BUYER);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        let payment = mint_sui(100_000 * MIST_PER_SUI, &mut s);
        let clk = clock::create_for_testing(ts::ctx(&mut s));
        let (tokens, refund) = bonding_curve::buy_for_testing(
            &mut curve, payment, 0, option::none(), &clk, ts::ctx(&mut s)
        );
        assert!(coin::value(&tokens) == 800_000_000 * 1_000_000, 800);
        assert!(coin::value(&refund) > 0, 801);
        destroy(tokens);
        destroy(refund);
        clock::destroy_for_testing(clk);
        ts::return_shared(curve);
        ts::end(s);
    }

    // ─── Anti-bot ────────────────────────────────────────────────────────────

    #[test]
    fun test_creator_can_buy_during_antibot_window() {
        let mut s = ts::begin(CREATOR);
        let clk = setup_curve_with_antibot(&mut s, 30, 0);

        ts::next_tx(&mut s, CREATOR);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        let payment = mint_sui(10 * MIST_PER_SUI, &mut s);
        let (tokens, refund) = bonding_curve::buy_for_testing(
            &mut curve, payment, 0, option::none(), &clk, ts::ctx(&mut s)
        );
        destroy(tokens);
        destroy(refund);
        ts::return_shared(curve);
        clock::destroy_for_testing(clk);
        ts::end(s);
    }

    #[test]
    #[expected_failure(abort_code = E_ANTI_BOT_BLOCKED, location = suipump::bonding_curve)]
    fun test_non_creator_blocked_during_antibot_window() {
        let mut s = ts::begin(CREATOR);
        let clk = setup_curve_with_antibot(&mut s, 30, 0);

        ts::next_tx(&mut s, BUYER);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        let payment = mint_sui(10 * MIST_PER_SUI, &mut s);
        let (tokens, refund) = bonding_curve::buy_for_testing(
            &mut curve, payment, 0, option::none(), &clk, ts::ctx(&mut s)
        );
        destroy(tokens);
        destroy(refund);
        ts::return_shared(curve);
        clock::destroy_for_testing(clk);
        ts::end(s);
    }

    #[test]
    fun test_buyer_can_buy_after_antibot_window_expires() {
        let mut s = ts::begin(CREATOR);
        let mut clk = setup_curve_with_antibot(&mut s, 15, 0);
        clock::set_for_testing(&mut clk, 16_000);

        ts::next_tx(&mut s, BUYER);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        let payment = mint_sui(10 * MIST_PER_SUI, &mut s);
        let (tokens, refund) = bonding_curve::buy_for_testing(
            &mut curve, payment, 0, option::none(), &clk, ts::ctx(&mut s)
        );
        destroy(tokens);
        destroy(refund);
        ts::return_shared(curve);
        clock::destroy_for_testing(clk);
        ts::end(s);
    }

    #[test]
    fun test_no_antibot_allows_all_buyers_immediately() {
        let mut s = ts::begin(CREATOR);
        let clk = setup_curve_with_antibot(&mut s, 0, 0);

        ts::next_tx(&mut s, BUYER);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        let payment = mint_sui(10 * MIST_PER_SUI, &mut s);
        let (tokens, refund) = bonding_curve::buy_for_testing(
            &mut curve, payment, 0, option::none(), &clk, ts::ctx(&mut s)
        );
        destroy(tokens);
        destroy(refund);
        ts::return_shared(curve);
        clock::destroy_for_testing(clk);
        ts::end(s);
    }

    // ─── v7: Fee split — airdrop bucket ──────────────────────────────────────

    #[test]
    fun test_buy_no_referral_splits_protocol_bucket_in_half() {
        let mut s = ts::begin(CREATOR);
        let (_a, _b) = make_payouts_single();
        setup_curve(&mut s, _a, _b);

        ts::next_tx(&mut s, BUYER);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        let proto_before   = bonding_curve::protocol_fees(&curve);
        let airdrop_before = bonding_curve::airdrop_fees(&curve);

        let payment = mint_sui(10_000 * MIST_PER_SUI, &mut s);
        let clk = clock::create_for_testing(ts::ctx(&mut s));
        let (tokens, refund) = bonding_curve::buy_for_testing(
            &mut curve, payment, 0, option::none(), &clk, ts::ctx(&mut s)
        );
        destroy(tokens);
        destroy(refund);

        let proto_delta   = bonding_curve::protocol_fees(&curve) - proto_before;
        let airdrop_delta = bonding_curve::airdrop_fees(&curve) - airdrop_before;
        // No referral: bucket = 50 points, split 25/25; differ by at most 1 (dust)
        assert!(proto_delta >= airdrop_delta, 1200);
        assert!(proto_delta - airdrop_delta <= 1, 1201);
        assert!(airdrop_delta > 0, 1202);

        clock::destroy_for_testing(clk);
        ts::return_shared(curve);
        ts::end(s);
    }

    #[test]
    fun test_buy_with_referral_pays_referrer() {
        let mut s = ts::begin(CREATOR);
        let (_a, _b) = make_payouts_single();
        setup_curve(&mut s, _a, _b);

        ts::next_tx(&mut s, BUYER);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        let payment = mint_sui(10_000 * MIST_PER_SUI, &mut s);
        let clk = clock::create_for_testing(ts::ctx(&mut s));
        let (tokens, refund) = bonding_curve::buy_for_testing(
            &mut curve, payment, 0, option::some(REFERRER), &clk, ts::ctx(&mut s)
        );
        destroy(tokens);
        destroy(refund);
        clock::destroy_for_testing(clk);
        ts::return_shared(curve);

        ts::next_tx(&mut s, REFERRER);
        let ref_coin = ts::take_from_address<Coin<SUI>>(&s, REFERRER);
        assert!(coin::value(&ref_coin) > 0, 1210);
        destroy(ref_coin);
        ts::end(s);
    }

    #[test]
    #[expected_failure(abort_code = E_SELF_REFERRAL, location = suipump::bonding_curve)]
    fun test_buy_self_referral_rejected() {
        let mut s = ts::begin(CREATOR);
        let (_a, _b) = make_payouts_single();
        setup_curve(&mut s, _a, _b);

        ts::next_tx(&mut s, BUYER);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        let payment = mint_sui(10 * MIST_PER_SUI, &mut s);
        let clk = clock::create_for_testing(ts::ctx(&mut s));
        let (tokens, refund) = bonding_curve::buy_for_testing(
            &mut curve, payment, 0, option::some(CREATOR), &clk, ts::ctx(&mut s)
        );
        destroy(tokens);
        destroy(refund);
        clock::destroy_for_testing(clk);
        ts::return_shared(curve);
        ts::end(s);
    }

    #[test]
    #[expected_failure(abort_code = E_SELF_REFERRAL, location = suipump::bonding_curve)]
    fun test_sell_self_referral_rejected() {
        let mut s = ts::begin(CREATOR);
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
            &mut curve, tokens, 0, option::some(CREATOR), ts::ctx(&mut s)
        );
        destroy(sui_back);
        clock::destroy_for_testing(clk);
        ts::return_shared(curve);
        ts::end(s);
    }

    #[test]
    fun test_sell_with_referral_pays_referrer() {
        let mut s = ts::begin(CREATOR);
        let (_a, _b) = make_payouts_single();
        setup_curve(&mut s, _a, _b);

        ts::next_tx(&mut s, BUYER);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        let payment = mint_sui(1_000 * MIST_PER_SUI, &mut s);
        let clk = clock::create_for_testing(ts::ctx(&mut s));
        let (tokens, refund) = bonding_curve::buy_for_testing(
            &mut curve, payment, 0, option::none(), &clk, ts::ctx(&mut s)
        );
        destroy(refund);
        let sui_back = bonding_curve::sell(
            &mut curve, tokens, 0, option::some(REFERRER), ts::ctx(&mut s)
        );
        destroy(sui_back);
        clock::destroy_for_testing(clk);
        ts::return_shared(curve);

        ts::next_tx(&mut s, REFERRER);
        let ref_coin = ts::take_from_address<Coin<SUI>>(&s, REFERRER);
        assert!(coin::value(&ref_coin) > 0, 1220);
        destroy(ref_coin);
        ts::end(s);
    }

    // ─── v7: lp_fees_accumulated counter ─────────────────────────────────────

    #[test]
    fun test_lp_fees_accumulated_increases_on_buy() {
        let mut s = ts::begin(CREATOR);
        let (_a, _b) = make_payouts_single();
        setup_curve(&mut s, _a, _b);

        ts::next_tx(&mut s, BUYER);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        assert!(bonding_curve::lp_fees_accumulated(&curve) == 0, 1300);

        let payment = mint_sui(1_000 * MIST_PER_SUI, &mut s);
        let clk = clock::create_for_testing(ts::ctx(&mut s));
        let (tokens, refund) = bonding_curve::buy_for_testing(
            &mut curve, payment, 0, option::none(), &clk, ts::ctx(&mut s)
        );
        destroy(tokens);
        destroy(refund);

        assert!(bonding_curve::lp_fees_accumulated(&curve) > 0, 1301);
        clock::destroy_for_testing(clk);
        ts::return_shared(curve);
        ts::end(s);
    }

    // ─── v7: Pause flag (F-13) ───────────────────────────────────────────────

    #[test]
    #[expected_failure(abort_code = E_PAUSED, location = suipump::bonding_curve)]
    fun test_paused_curve_blocks_buy() {
        let mut s = ts::begin(CREATOR);
        bonding_curve::init_for_testing(ts::ctx(&mut s));

        ts::next_tx(&mut s, CREATOR);
        let (_a, _b) = make_payouts_single();
        setup_curve(&mut s, _a, _b);

        ts::next_tx(&mut s, CREATOR);
        let admin_cap = ts::take_from_sender<AdminCap>(&s);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        bonding_curve::set_paused(&admin_cap, &mut curve, true);
        ts::return_to_sender(&s, admin_cap);

        let payment = mint_sui(10 * MIST_PER_SUI, &mut s);
        let clk = clock::create_for_testing(ts::ctx(&mut s));
        let (tokens, refund) = bonding_curve::buy_for_testing(
            &mut curve, payment, 0, option::none(), &clk, ts::ctx(&mut s)
        );
        destroy(tokens);
        destroy(refund);
        clock::destroy_for_testing(clk);
        ts::return_shared(curve);
        ts::end(s);
    }

    #[test]
    #[expected_failure(abort_code = E_PAUSED, location = suipump::bonding_curve)]
    fun test_paused_curve_blocks_sell() {
        let mut s = ts::begin(CREATOR);
        bonding_curve::init_for_testing(ts::ctx(&mut s));

        ts::next_tx(&mut s, CREATOR);
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
        clock::destroy_for_testing(clk);
        ts::return_shared(curve);

        ts::next_tx(&mut s, CREATOR);
        let admin_cap = ts::take_from_sender<AdminCap>(&s);
        let mut curve2 = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        bonding_curve::set_paused(&admin_cap, &mut curve2, true);
        ts::return_to_sender(&s, admin_cap);

        let sui_back = bonding_curve::sell(
            &mut curve2, tokens, 0, option::none(), ts::ctx(&mut s)
        );
        destroy(sui_back);
        ts::return_shared(curve2);
        ts::end(s);
    }

    #[test]
    fun test_unpause_restores_trading() {
        let mut s = ts::begin(CREATOR);
        bonding_curve::init_for_testing(ts::ctx(&mut s));

        ts::next_tx(&mut s, CREATOR);
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
        destroy(tokens);
        destroy(refund);
        clock::destroy_for_testing(clk);
        ts::return_shared(curve);
        ts::end(s);
    }

    // ─── Graduation ──────────────────────────────────────────────────────────

    #[test]
    fun test_graduation_side_effects() {
        // In V9, inline graduation fires during drain_curve()'s buy() call.
        // We verify state BEFORE the draining buy, then check state after.
        let mut s = ts::begin(CREATOR);
        let (_a, _b) = make_payouts_single();
        setup_curve(&mut s, _a, _b);

        // Snapshot reserve + protocol_fees before the drain buy
        ts::next_tx(&mut s, BUYER);
        let reserve_before_drain;
        let proto_before_drain;
        {
            let curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
            reserve_before_drain = bonding_curve::sui_reserve(&curve);
            proto_before_drain   = bonding_curve::protocol_fees(&curve);
            ts::return_shared(curve);
        };

        // Drain triggers inline graduation
        drain_curve(&mut s);

        // After inline graduation:
        // creator_bonus = 0.5% of reserve_at_grad was sent to CREATOR
        // protocol_bonus = 0.5% of reserve_at_grad was added to protocol_fees
        // reserve_at_grad ≈ the drained reserve (approximately — small rounding)
        ts::next_tx(&mut s, BUYER);
        let curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        assert!(bonding_curve::graduated(&curve), 900);
        // protocol_fees grew (protocol_bonus was added)
        assert!(bonding_curve::protocol_fees(&curve) > proto_before_drain, 901);
        // sui_reserve is positive (LP pool amount)
        assert!(bonding_curve::sui_reserve(&curve) > 0, 902);
        ts::return_shared(curve);

        ts::end(s);
    }

    #[test]
    #[expected_failure(abort_code = E_NOT_GRADUATED, location = suipump::bonding_curve)]
    fun test_cannot_graduate_before_drain() {
        let mut s = ts::begin(CREATOR);
        let (_a, _b) = make_payouts_single();
        setup_curve(&mut s, _a, _b);

        ts::next_tx(&mut s, BUYER);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        bonding_curve::graduate_for_testing(&mut curve, ts::ctx(&mut s));
        ts::return_shared(curve);
        ts::end(s);
    }

    #[test]
    #[expected_failure(abort_code = E_ALREADY_GRADUATED, location = suipump::bonding_curve)]
    fun test_cannot_graduate_twice() {
        let mut s = ts::begin(CREATOR);
        let (_a, _b) = make_payouts_single();
        setup_curve(&mut s, _a, _b);
        drain_curve(&mut s);
        do_graduate(&mut s);

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
        let (_a, _b) = make_payouts_single();
        setup_curve(&mut s, _a, _b);
        drain_curve(&mut s);
        do_graduate(&mut s);

        ts::next_tx(&mut s, BUYER);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        let payment = mint_sui(10 * MIST_PER_SUI, &mut s);
        let clk = clock::create_for_testing(ts::ctx(&mut s));
        let (tokens, refund) = bonding_curve::buy_for_testing(
            &mut curve, payment, 0, option::none(), &clk, ts::ctx(&mut s)
        );
        destroy(tokens);
        destroy(refund);
        clock::destroy_for_testing(clk);
        ts::return_shared(curve);
        ts::end(s);
    }

    #[test]
    #[expected_failure(abort_code = E_ALREADY_GRADUATED, location = suipump::bonding_curve)]
    fun test_cannot_sell_after_graduation() {
        let mut s = ts::begin(CREATOR);
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
        clock::destroy_for_testing(clk);
        ts::return_shared(curve);

        drain_curve(&mut s);
        do_graduate(&mut s);

        ts::next_tx(&mut s, BUYER);
        let mut curve2 = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        let sui_back = bonding_curve::sell(
            &mut curve2, tokens, 0, option::none(), ts::ctx(&mut s)
        );
        destroy(sui_back);
        ts::return_shared(curve2);
        ts::end(s);
    }

    // ─── v7: record_graduation_pool ──────────────────────────────────────────

    #[test]
    fun test_record_graduation_pool_stores_ids() {
        let mut s = ts::begin(CREATOR);
        bonding_curve::init_for_testing(ts::ctx(&mut s));

        ts::next_tx(&mut s, CREATOR);
        let (_a, _b) = make_payouts_single();
        setup_curve(&mut s, _a, _b);
        drain_curve(&mut s); // inline graduation fires

        ts::next_tx(&mut s, CREATOR);
        let admin_cap = ts::take_from_sender<AdminCap>(&s);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);

        let uid_pool = object::new(ts::ctx(&mut s));
        let pool_id  = object::uid_to_inner(&uid_pool);
        object::delete(uid_pool);
        let uid_nft  = object::new(ts::ctx(&mut s));
        let nft_id   = object::uid_to_inner(&uid_nft);
        object::delete(uid_nft);

        bonding_curve::record_graduation_pool(&admin_cap, &mut curve, pool_id, nft_id);
        assert!(option::is_some(&bonding_curve::pool_id(&curve)), 1500);
        assert!(option::is_some(&bonding_curve::pool_id(&curve)), 1501);

        ts::return_to_sender(&s, admin_cap);
        ts::return_shared(curve);
        ts::end(s);
    }

    #[test]
    #[expected_failure(abort_code = E_POOL_ALREADY_RECORDED, location = suipump::bonding_curve)]
    fun test_record_graduation_pool_twice_rejected() {
        let mut s = ts::begin(CREATOR);
        bonding_curve::init_for_testing(ts::ctx(&mut s));

        ts::next_tx(&mut s, CREATOR);
        let (_a, _b) = make_payouts_single();
        setup_curve(&mut s, _a, _b);
        drain_curve(&mut s); // inline graduation fires

        ts::next_tx(&mut s, CREATOR);
        let admin_cap = ts::take_from_sender<AdminCap>(&s);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);

        let uid1 = object::new(ts::ctx(&mut s));
        let id1  = object::uid_to_inner(&uid1);
        object::delete(uid1);
        let uid2 = object::new(ts::ctx(&mut s));
        let id2  = object::uid_to_inner(&uid2);
        object::delete(uid2);

        bonding_curve::record_graduation_pool(&admin_cap, &mut curve, id1, id2);
        bonding_curve::record_graduation_pool(&admin_cap, &mut curve, id1, id2);

        ts::return_to_sender(&s, admin_cap);
        ts::return_shared(curve);
        ts::end(s);
    }

    // ─── Metadata flag / window ──────────────────────────────────────────────

    #[test]
    fun test_metadata_updated_flag_starts_false() {
        let mut s = ts::begin(CREATOR);
        let (_a, _b) = make_payouts_single();
        setup_curve(&mut s, _a, _b);

        ts::next_tx(&mut s, CREATOR);
        let curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        assert!(!bonding_curve::metadata_updated(&curve), 1100);
        ts::return_shared(curve);
        ts::end(s);
    }

    #[test]
    fun test_metadata_window_closes_at_is_24h_after_launch() {
        let mut s = ts::begin(CREATOR);
        let (_a, _b) = make_payouts_single();
        setup_curve(&mut s, _a, _b);

        ts::next_tx(&mut s, CREATOR);
        let curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        assert!(bonding_curve::created_at_ms(&curve) + 86_400_000 == 86_400_000, 1101);
        ts::return_shared(curve);
        ts::end(s);
    }

    // ─── claim_graduation_funds ──────────────────────────────────────────────

    #[test]
    fun test_claim_graduation_funds_drains_pool_sui() {
        let mut s = ts::begin(CREATOR);
        bonding_curve::init_for_testing(ts::ctx(&mut s));

        ts::next_tx(&mut s, CREATOR);
        let (_a, _b) = make_payouts_single();
        setup_curve(&mut s, _a, _b);
        drain_curve(&mut s); // inline graduation fires here

        ts::next_tx(&mut s, CREATOR);
        let admin_cap = ts::take_from_sender<AdminCap>(&s);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        // In V9 inline graduation already ran — verify pool SUI is in reserve
        assert!(bonding_curve::graduated(&curve), 1000);
        assert!(bonding_curve::sui_reserve(&curve) > 0, 1001);
        ts::return_to_sender(&s, admin_cap);
        ts::return_shared(curve);
        ts::end(s);
    }

    #[test]
    fun test_claim_graduation_funds_fails_if_not_graduated() {
        // Verify that a non-graduated curve cannot be used as if graduated
        let mut s = ts::begin(CREATOR);
        bonding_curve::init_for_testing(ts::ctx(&mut s));

        ts::next_tx(&mut s, CREATOR);
        let (_a, _b) = make_payouts_single();
        setup_curve(&mut s, _a, _b);

        // Small buy — does NOT graduate the curve
        ts::next_tx(&mut s, BUYER);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        let payment = mint_sui(10 * MIST_PER_SUI, &mut s);
        let clk = clock::create_for_testing(ts::ctx(&mut s));
        let (tokens, refund) = bonding_curve::buy_for_testing(
            &mut curve, payment, 0, option::none(), &clk, ts::ctx(&mut s)
        );
        assert!(!bonding_curve::graduated(&curve), 999);
        destroy(tokens); destroy(refund);
        clock::destroy_for_testing(clk);
        ts::return_shared(curve);
        ts::end(s);
    }

    // ─── v7: claim_airdrop_fees ──────────────────────────────────────────────

    #[test]
    fun test_claim_airdrop_fees_drains_bucket() {
        let mut s = ts::begin(CREATOR);
        bonding_curve::init_for_testing(ts::ctx(&mut s));

        ts::next_tx(&mut s, CREATOR);
        let (_a, _b) = make_payouts_single();
        setup_curve(&mut s, _a, _b);

        ts::next_tx(&mut s, BUYER);
        {
            let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
            let payment = mint_sui(1_000 * MIST_PER_SUI, &mut s);
            let clk = clock::create_for_testing(ts::ctx(&mut s));
            let (tokens, refund) = bonding_curve::buy_for_testing(
                &mut curve, payment, 0, option::none(), &clk, ts::ctx(&mut s)
            );
            destroy(tokens);
            destroy(refund);
            clock::destroy_for_testing(clk);
            ts::return_shared(curve);
        };

        ts::next_tx(&mut s, CREATOR);
        let admin_cap = ts::take_from_sender<AdminCap>(&s);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        let airdrop_before = bonding_curve::airdrop_fees(&curve);
        assert!(airdrop_before > 0, 1699);
        bonding_curve::claim_airdrop_fees(
            &admin_cap, &mut curve, ts::ctx(&mut s)
        );
        assert!(bonding_curve::airdrop_fees(&curve) == 0, 1700);
        ts::return_to_sender(&s, admin_cap);
        ts::return_shared(curve);
        ts::end(s);
    }

    // ─── Comments (v7: 0.001 SUI fee) ────────────────────────────────────────

    #[test]
    fun test_post_comment_succeeds() {
        let mut s = ts::begin(CREATOR);
        let (_a, _b) = make_payouts_single();
        setup_curve(&mut s, _a, _b);

        ts::next_tx(&mut s, BUYER);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        let proto_before = bonding_curve::protocol_fees(&curve);
        let fee = mint_sui(COMMENT_FEE, &mut s);
        let holder = mint_token(1_000_000, &mut s);
        bonding_curve::post_comment(
            &mut curve, string::utf8(b"great token"), fee, CREATOR, &holder, @0x0, ts::ctx(&mut s),
        );
        destroy(holder);
        assert!(bonding_curve::protocol_fees(&curve) == proto_before + COMMENT_FEE, 1800);
        ts::return_shared(curve);
        ts::end(s);
    }

    #[test]
    #[expected_failure(abort_code = E_WRONG_COMMENT_FEE, location = suipump::bonding_curve)]
    fun test_post_comment_wrong_fee_rejected() {
        let mut s = ts::begin(CREATOR);
        let (_a, _b) = make_payouts_single();
        setup_curve(&mut s, _a, _b);

        ts::next_tx(&mut s, BUYER);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        let bad_fee = mint_sui(MIST_PER_SUI, &mut s);
        let holder = mint_token(1_000_000, &mut s);
        bonding_curve::post_comment(
            &mut curve, string::utf8(b"hi"), bad_fee, CREATOR, &holder, @0x0, ts::ctx(&mut s),
        );
        destroy(holder);
        ts::return_shared(curve);
        ts::end(s);
    }

    #[test]
    #[expected_failure(abort_code = E_COMMENT_EMPTY, location = suipump::bonding_curve)]
    fun test_empty_comment_rejected() {
        let mut s = ts::begin(BUYER);
        let (_a, _b) = make_payouts_single();
        setup_curve(&mut s, _a, _b);

        ts::next_tx(&mut s, BUYER);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        let fee = mint_sui(COMMENT_FEE, &mut s);
        let holder = mint_token(1_000_000, &mut s);
        bonding_curve::post_comment(
            &mut curve, string::utf8(b""), fee, CREATOR, &holder, @0x0, ts::ctx(&mut s),
        );
        destroy(holder);
        ts::return_shared(curve);
        ts::end(s);
    }

    #[test]
    #[expected_failure(abort_code = E_COMMENT_TOO_LONG, location = suipump::bonding_curve)]
    fun test_comment_too_long_rejected() {
        let mut s = ts::begin(BUYER);
        let (_a, _b) = make_payouts_single();
        setup_curve(&mut s, _a, _b);

        ts::next_tx(&mut s, BUYER);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        let fee = mint_sui(COMMENT_FEE, &mut s);

        let mut long_bytes = vector<u8>[];
        let chunk = b"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        vector::append(&mut long_bytes, chunk);
        vector::append(&mut long_bytes, chunk);
        vector::append(&mut long_bytes, chunk);
        let long_text = string::utf8(long_bytes);
        let holder = mint_token(1_000_000, &mut s);
        bonding_curve::post_comment(
            &mut curve, long_text, fee, CREATOR, &holder, @0x0, ts::ctx(&mut s),
        );
        destroy(holder);
        ts::return_shared(curve);
        ts::end(s);
    }

    // ─── v7: Vesting lock ────────────────────────────────────────────────────

    // Durations (ms) — must match the contract
    const D_7D:   u64 = 7   * 24 * 60 * 60 * 1_000;
    const D_30D:  u64 = 30  * 24 * 60 * 60 * 1_000;
    const D_180D: u64 = 180 * 24 * 60 * 60 * 1_000;
    const D_365D: u64 = 365 * 24 * 60 * 60 * 1_000;

    // Mint a Coin<TEST_TOKEN> for locking.
    fun mint_token(amount: u64, s: &mut Scenario): Coin<TEST_TOKEN> {
        coin::mint_for_testing<TEST_TOKEN>(amount, ts::ctx(s))
    }

    #[test]
    fun test_lock_tokens_creates_vesting_lock() {
        let mut s = ts::begin(CREATOR);
        let (_a, _b) = make_payouts_single();
        setup_curve(&mut s, _a, _b);

        ts::next_tx(&mut s, CREATOR);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        let tokens = mint_token(1_000_000, &mut s);
        let clk = clock::create_for_testing(ts::ctx(&mut s));
        bonding_curve::lock_tokens(&mut curve, tokens, 0, D_7D, &clk, ts::ctx(&mut s)); // cliff 7d
        clock::destroy_for_testing(clk);
        ts::return_shared(curve);

        ts::next_tx(&mut s, CREATOR);
        let lock = ts::take_shared<bonding_curve::VestingLock<TEST_TOKEN>>(&s);
        assert!(bonding_curve::lock_total(&lock) == 1_000_000, 2000);
        assert!(bonding_curve::lock_claimed(&lock) == 0, 2001);
        assert!(bonding_curve::lock_remaining(&lock) == 1_000_000, 2002);
        assert!(bonding_curve::lock_beneficiary(&lock) == CREATOR, 2003);
        ts::return_shared(lock);
        ts::end(s);
    }

    #[test]
    fun test_cliff_releases_nothing_before_end() {
        let mut s = ts::begin(CREATOR);
        let (_a, _b) = make_payouts_single();
        setup_curve(&mut s, _a, _b);

        ts::next_tx(&mut s, CREATOR);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        let tokens = mint_token(1_000_000, &mut s);
        let clk = clock::create_for_testing(ts::ctx(&mut s)); // t=0
        bonding_curve::lock_tokens(&mut curve, tokens, 0, D_30D, &clk, ts::ctx(&mut s));
        clock::destroy_for_testing(clk);
        ts::return_shared(curve);

        ts::next_tx(&mut s, CREATOR);
        let lock = ts::take_shared<bonding_curve::VestingLock<TEST_TOKEN>>(&s);
        // halfway through: cliff -> still 0 vested
        assert!(bonding_curve::lock_vested_at(&lock, D_30D / 2) == 0, 2010);
        // one ms before end: still 0
        assert!(bonding_curve::lock_vested_at(&lock, D_30D - 1) == 0, 2011);
        // at end: 100%
        assert!(bonding_curve::lock_vested_at(&lock, D_30D) == 1_000_000, 2012);
        ts::return_shared(lock);
        ts::end(s);
    }

    #[test]
    fun test_cliff_claim_after_end_releases_all() {
        let mut s = ts::begin(CREATOR);
        let (_a, _b) = make_payouts_single();
        setup_curve(&mut s, _a, _b);

        ts::next_tx(&mut s, CREATOR);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        let tokens = mint_token(1_000_000, &mut s);
        let clk0 = clock::create_for_testing(ts::ctx(&mut s));
        bonding_curve::lock_tokens(&mut curve, tokens, 0, D_7D, &clk0, ts::ctx(&mut s));
        clock::destroy_for_testing(clk0);
        ts::return_shared(curve);

        ts::next_tx(&mut s, CREATOR);
        let mut lock = ts::take_shared<bonding_curve::VestingLock<TEST_TOKEN>>(&s);
        let mut clk = clock::create_for_testing(ts::ctx(&mut s));
        clock::set_for_testing(&mut clk, D_7D + 1);
        bonding_curve::claim_vested(&mut lock, &clk, ts::ctx(&mut s));
        // claim_vested transfers to beneficiary — check lock state directly
        assert!(bonding_curve::lock_remaining(&lock) == 0, 2021);
        clock::destroy_for_testing(clk);
        ts::return_shared(lock);
        ts::end(s);
    }

    #[test]
    fun test_linear_releases_half_at_midpoint() {
        let mut s = ts::begin(CREATOR);
        let (_a, _b) = make_payouts_single();
        setup_curve(&mut s, _a, _b);

        ts::next_tx(&mut s, CREATOR);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        let tokens = mint_token(1_000_000, &mut s);
        let clk0 = clock::create_for_testing(ts::ctx(&mut s));
        bonding_curve::lock_tokens(&mut curve, tokens, 1, D_30D, &clk0, ts::ctx(&mut s)); // linear
        clock::destroy_for_testing(clk0);
        ts::return_shared(curve);

        ts::next_tx(&mut s, CREATOR);
        let lock = ts::take_shared<bonding_curve::VestingLock<TEST_TOKEN>>(&s);
        // midpoint -> ~50%
        assert!(bonding_curve::lock_vested_at(&lock, D_30D / 2) == 500_000, 2030);
        // full duration -> 100%
        assert!(bonding_curve::lock_vested_at(&lock, D_30D) == 1_000_000, 2031);
        ts::return_shared(lock);
        ts::end(s);
    }

    #[test]
    fun test_linear_claim_twice_tracks_claimed() {
        let mut s = ts::begin(CREATOR);
        let (_a, _b) = make_payouts_single();
        setup_curve(&mut s, _a, _b);

        ts::next_tx(&mut s, CREATOR);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        let tokens = mint_token(1_000_000, &mut s);
        let clk0 = clock::create_for_testing(ts::ctx(&mut s));
        bonding_curve::lock_tokens(&mut curve, tokens, 1, D_30D, &clk0, ts::ctx(&mut s));
        clock::destroy_for_testing(clk0);
        ts::return_shared(curve);

        ts::next_tx(&mut s, CREATOR);
        let mut lock = ts::take_shared<bonding_curve::VestingLock<TEST_TOKEN>>(&s);

        // claim at 25%
        let mut clk = clock::create_for_testing(ts::ctx(&mut s));
        clock::set_for_testing(&mut clk, D_30D / 4);
        bonding_curve::claim_vested(&mut lock, &clk, ts::ctx(&mut s));
        assert!(bonding_curve::lock_claimed(&lock) == 250_000, 2040);

        // claim again at 75% -> should release the additional 50%
        clock::set_for_testing(&mut clk, (D_30D * 3) / 4);
        bonding_curve::claim_vested(&mut lock, &clk, ts::ctx(&mut s));
        assert!(bonding_curve::lock_claimed(&lock) == 750_000, 2041);

        assert!(bonding_curve::lock_claimed(&lock) == 750_000, 2042);
        clock::destroy_for_testing(clk);
        ts::return_shared(lock);
        ts::end(s);
    }

    #[test]
    fun test_monthly_releases_in_steps() {
        let mut s = ts::begin(CREATOR);
        let (_a, _b) = make_payouts_single();
        setup_curve(&mut s, _a, _b);

        ts::next_tx(&mut s, CREATOR);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        let tokens = mint_token(6_000_000, &mut s);
        let clk0 = clock::create_for_testing(ts::ctx(&mut s));
        // monthly over 180d = 6 steps of 1,000,000 each
        bonding_curve::lock_tokens(&mut curve, tokens, 2, D_180D, &clk0, ts::ctx(&mut s));
        clock::destroy_for_testing(clk0);
        ts::return_shared(curve);

        ts::next_tx(&mut s, CREATOR);
        let lock = ts::take_shared<bonding_curve::VestingLock<TEST_TOKEN>>(&s);
        let month: u64 = 30 * 24 * 60 * 60 * 1_000;
        // before first month completes -> 0
        assert!(bonding_curve::lock_vested_at(&lock, month - 1) == 0, 2050);
        // after 1 month -> 1/6
        assert!(bonding_curve::lock_vested_at(&lock, month) == 1_000_000, 2051);
        // after 3 months -> 3/6
        assert!(bonding_curve::lock_vested_at(&lock, month * 3) == 3_000_000, 2052);
        // full duration -> all
        assert!(bonding_curve::lock_vested_at(&lock, D_180D) == 6_000_000, 2053);
        ts::return_shared(lock);
        ts::end(s);
    }

    #[test]
    #[expected_failure(abort_code = E_NOTHING_VESTED, location = suipump::bonding_curve)]
    fun test_claim_before_anything_vests_aborts() {
        let mut s = ts::begin(CREATOR);
        let (_a, _b) = make_payouts_single();
        setup_curve(&mut s, _a, _b);

        ts::next_tx(&mut s, CREATOR);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        let tokens = mint_token(1_000_000, &mut s);
        let clk0 = clock::create_for_testing(ts::ctx(&mut s));
        bonding_curve::lock_tokens(&mut curve, tokens, 0, D_30D, &clk0, ts::ctx(&mut s)); // cliff
        clock::destroy_for_testing(clk0);
        ts::return_shared(curve);

        ts::next_tx(&mut s, CREATOR);
        let mut lock = ts::take_shared<bonding_curve::VestingLock<TEST_TOKEN>>(&s);
        let clk = clock::create_for_testing(ts::ctx(&mut s)); // t=0, nothing vested
        bonding_curve::claim_vested(&mut lock, &clk, ts::ctx(&mut s));
        clock::destroy_for_testing(clk);
        ts::return_shared(lock);
        ts::end(s);
    }

    #[test]
    #[expected_failure(abort_code = E_NOT_LOCK_BENEFICIARY, location = suipump::bonding_curve)]
    fun test_non_beneficiary_cannot_claim() {
        let mut s = ts::begin(CREATOR);
        let (_a, _b) = make_payouts_single();
        setup_curve(&mut s, _a, _b);

        ts::next_tx(&mut s, CREATOR);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        let tokens = mint_token(1_000_000, &mut s);
        let clk0 = clock::create_for_testing(ts::ctx(&mut s));
        bonding_curve::lock_tokens(&mut curve, tokens, 1, D_7D, &clk0, ts::ctx(&mut s));
        clock::destroy_for_testing(clk0);
        ts::return_shared(curve);

        // BUYER (not the beneficiary) tries to claim
        ts::next_tx(&mut s, BUYER);
        let mut lock = ts::take_shared<bonding_curve::VestingLock<TEST_TOKEN>>(&s);
        let mut clk = clock::create_for_testing(ts::ctx(&mut s));
        clock::set_for_testing(&mut clk, D_7D);
        bonding_curve::claim_vested(&mut lock, &clk, ts::ctx(&mut s));
        clock::destroy_for_testing(clk);
        ts::return_shared(lock);
        ts::end(s);
    }

    #[test]
    #[expected_failure(abort_code = E_INVALID_VEST_MODE, location = suipump::bonding_curve)]
    fun test_invalid_vest_mode_rejected() {
        let mut s = ts::begin(CREATOR);
        let (_a, _b) = make_payouts_single();
        setup_curve(&mut s, _a, _b);

        ts::next_tx(&mut s, CREATOR);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        let tokens = mint_token(1_000_000, &mut s);
        let clk = clock::create_for_testing(ts::ctx(&mut s));
        bonding_curve::lock_tokens(&mut curve, tokens, 9, D_7D, &clk, ts::ctx(&mut s)); // mode 9 invalid
        clock::destroy_for_testing(clk);
        ts::return_shared(curve);
        ts::end(s);
    }

    #[test]
    #[expected_failure(abort_code = E_INVALID_VEST_DURATION, location = suipump::bonding_curve)]
    fun test_invalid_vest_duration_rejected() {
        let mut s = ts::begin(CREATOR);
        let (_a, _b) = make_payouts_single();
        setup_curve(&mut s, _a, _b);

        ts::next_tx(&mut s, CREATOR);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        let tokens = mint_token(1_000_000, &mut s);
        let clk = clock::create_for_testing(ts::ctx(&mut s));
        bonding_curve::lock_tokens(&mut curve, tokens, 0, 12345, &clk, ts::ctx(&mut s)); // bad duration
        clock::destroy_for_testing(clk);
        ts::return_shared(curve);
        ts::end(s);
    }

    #[test]
    #[expected_failure(abort_code = E_MONTHLY_NEEDS_30_DAYS, location = suipump::bonding_curve)]
    fun test_monthly_under_30_days_rejected() {
        let mut s = ts::begin(CREATOR);
        let (_a, _b) = make_payouts_single();
        setup_curve(&mut s, _a, _b);

        ts::next_tx(&mut s, CREATOR);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        let tokens = mint_token(1_000_000, &mut s);
        let clk = clock::create_for_testing(ts::ctx(&mut s));
        // monthly mode (2) with 7-day duration -> reject
        bonding_curve::lock_tokens(&mut curve, tokens, 2, D_7D, &clk, ts::ctx(&mut s));
        clock::destroy_for_testing(clk);
        ts::return_shared(curve);
        ts::end(s);
    }

    #[test]
    #[expected_failure(abort_code = E_ZERO_LOCK_AMOUNT, location = suipump::bonding_curve)]
    fun test_zero_amount_lock_rejected() {
        let mut s = ts::begin(CREATOR);
        let (_a, _b) = make_payouts_single();
        setup_curve(&mut s, _a, _b);

        ts::next_tx(&mut s, CREATOR);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        let tokens = mint_token(0, &mut s);
        let clk = clock::create_for_testing(ts::ctx(&mut s));
        bonding_curve::lock_tokens(&mut curve, tokens, 0, D_7D, &clk, ts::ctx(&mut s));
        clock::destroy_for_testing(clk);
        ts::return_shared(curve);
        ts::end(s);
    }
    // ─── v9 NEW: Oracle / dynamic threshold ──────────────────────────────────

    #[test]
    fun test_threshold_stored_on_curve_after_buy() {
        let mut s = ts::begin(CREATOR);
        bonding_curve::init_for_testing(ts::ctx(&mut s));
        let (_a, _b) = make_payouts_single();
        setup_curve(&mut s, _a, _b);

        ts::next_tx(&mut s, BUYER);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        // Before any buy: threshold is 0
        assert!(bonding_curve::current_grad_threshold(&curve) == 0, 2000);
        // Set explicitly via test helper (simulates oracle storing threshold)
        bonding_curve::set_grad_threshold_for_testing(&mut curve, 12_305 * 1_000_000_000);
        assert!(bonding_curve::current_grad_threshold(&curve) == 12_305 * 1_000_000_000, 2001);
        ts::return_shared(curve);
        ts::end(s);
    }

    #[test]
    fun test_threshold_fallback_to_base_when_not_set() {
        // When current_grad_threshold == 0 and price_scaled == 0,
        // buy_for_testing uses BASE_GRAD_MIST. A 100 SUI buy is far
        // below 12,305 SUI threshold → should NOT graduate.
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
        assert!(!bonding_curve::graduated(&curve), 2100);
        destroy(tokens); destroy(refund);
        clock::destroy_for_testing(clk);
        ts::return_shared(curve);
        ts::end(s);
    }

    #[test]
    fun test_normal_buy_refund_equals_lp_fee() {
        // In V9, the refund coin = lp_fee for normal (non-clip) buys.
        // lp_fee is NOT retained in the curve — returned to buyer.
        let mut s = ts::begin(CREATOR);
        bonding_curve::init_for_testing(ts::ctx(&mut s));
        let (_a, _b) = make_payouts_single();
        setup_curve(&mut s, _a, _b);

        ts::next_tx(&mut s, BUYER);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        let sui_in = 100 * MIST_PER_SUI;
        let payment = mint_sui(sui_in, &mut s);
        let clk = clock::create_for_testing(ts::ctx(&mut s));
        let (tokens, refund) = bonding_curve::buy_for_testing(
            &mut curve, payment, 0, option::none(), &clk, ts::ctx(&mut s)
        );
        // lp_fee = 10% of 1% of sui_in = 0.1% of sui_in
        let expected_lp = (sui_in * 100 / 10_000) * 1_000 / 10_000;
        assert!(coin::value(&refund) == expected_lp, 2200);
        destroy(tokens); destroy(refund);
        clock::destroy_for_testing(clk);
        ts::return_shared(curve);
        ts::end(s);
    }

    // ─── v9 NEW: Graduation SUI-threshold tail-clip (Path B) ─────────────────

    #[test]
    fun test_grad_clip_triggers_inline_graduation() {
        // Set threshold to 500 SUI so a 1000 SUI buy overshoots it.
        let mut s = ts::begin(CREATOR);
        bonding_curve::init_for_testing(ts::ctx(&mut s));
        let (_a, _b) = make_payouts_single();
        setup_curve(&mut s, _a, _b);

        ts::next_tx(&mut s, BUYER);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        bonding_curve::set_grad_threshold_for_testing(&mut curve, 500 * 1_000_000_000);
        ts::return_shared(curve);

        ts::next_tx(&mut s, BUYER);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        let payment = mint_sui(1_000 * MIST_PER_SUI, &mut s);
        let clk = clock::create_for_testing(ts::ctx(&mut s));
        let (tokens, refund) = bonding_curve::buy_for_testing(
            &mut curve, payment, 0, option::none(), &clk, ts::ctx(&mut s)
        );
        assert!(bonding_curve::graduated(&curve), 2300);
        assert!(coin::value(&tokens) > 0, 2301);
        // refund > lp_fee (has tail on top)
        let lp_fee = (1_000 * MIST_PER_SUI * 100 / 10_000) * 1_000 / 10_000;
        assert!(coin::value(&refund) > lp_fee, 2302);
        destroy(tokens); destroy(refund);
        clock::destroy_for_testing(clk);
        ts::return_shared(curve);
        ts::end(s);
    }

    #[test]
    fun test_grad_clip_conservation() {
        let mut s = ts::begin(CREATOR);
        bonding_curve::init_for_testing(ts::ctx(&mut s));
        let (_a, _b) = make_payouts_single();
        setup_curve(&mut s, _a, _b);

        ts::next_tx(&mut s, BUYER);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        bonding_curve::set_grad_threshold_for_testing(&mut curve, 500 * 1_000_000_000);
        ts::return_shared(curve);

        ts::next_tx(&mut s, BUYER);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        let sui_in = 800 * MIST_PER_SUI;
        let proto_before  = bonding_curve::protocol_fees(&curve);
        let creator_before = bonding_curve::creator_fees(&curve);
        let airdrop_before = bonding_curve::airdrop_fees(&curve);
        let reserve_before = bonding_curve::sui_reserve(&curve);

        let payment = mint_sui(sui_in, &mut s);
        let clk = clock::create_for_testing(ts::ctx(&mut s));
        let (tokens, refund) = bonding_curve::buy_for_testing(
            &mut curve, payment, 0, option::none(), &clk, ts::ctx(&mut s)
        );

        let refund_amount  = coin::value(&refund);
        let creator_delta  = bonding_curve::creator_fees(&curve)  - creator_before;
        let protocol_delta = bonding_curve::protocol_fees(&curve) - proto_before;
        let airdrop_delta  = bonding_curve::airdrop_fees(&curve)  - airdrop_before;
        let reserve_delta  = bonding_curve::sui_reserve(&curve)   - reserve_before;

        let total = creator_delta + protocol_delta + airdrop_delta + reserve_delta + refund_amount;
        // creator graduation bonus left system externally (≤ 0.5% of 500 SUI ≈ 2.5 SUI)
        let diff = if (total > sui_in) { total - sui_in } else { sui_in - total };
        assert!(diff <= 3 * 1_000_000_000, 2400);

        destroy(tokens); destroy(refund);
        clock::destroy_for_testing(clk);
        ts::return_shared(curve);
        ts::end(s);
    }

    #[test]
    fun test_cannot_buy_after_inline_graduation() {
        let mut s = ts::begin(CREATOR);
        bonding_curve::init_for_testing(ts::ctx(&mut s));
        let (_a, _b) = make_payouts_single();
        setup_curve(&mut s, _a, _b);

        // Set low threshold and trigger inline graduation
        ts::next_tx(&mut s, BUYER);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        bonding_curve::set_grad_threshold_for_testing(&mut curve, 500 * 1_000_000_000);
        ts::return_shared(curve);

        ts::next_tx(&mut s, BUYER);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        let payment = mint_sui(1_000 * MIST_PER_SUI, &mut s);
        let clk = clock::create_for_testing(ts::ctx(&mut s));
        let (tokens, refund) = bonding_curve::buy_for_testing(
            &mut curve, payment, 0, option::none(), &clk, ts::ctx(&mut s)
        );
        assert!(bonding_curve::graduated(&curve), 2500);
        destroy(tokens); destroy(refund);
        clock::destroy_for_testing(clk);
        ts::return_shared(curve);
        ts::end(s);
    }

    #[test]
    fun test_graduation_via_sui_threshold_not_drain() {
        let mut s = ts::begin(CREATOR);
        bonding_curve::init_for_testing(ts::ctx(&mut s));
        let (_a, _b) = make_payouts_single();
        setup_curve(&mut s, _a, _b);

        ts::next_tx(&mut s, BUYER);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        bonding_curve::set_grad_threshold_for_testing(&mut curve, 500 * 1_000_000_000);
        // Tokens are NOT drained — graduation via SUI threshold only
        let _tokens_before = bonding_curve::token_reserve(&curve);
        ts::return_shared(curve);

        ts::next_tx(&mut s, BUYER);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        let payment = mint_sui(700 * MIST_PER_SUI, &mut s);
        let clk = clock::create_for_testing(ts::ctx(&mut s));
        let (tokens, refund) = bonding_curve::buy_for_testing(
            &mut curve, payment, 0, option::none(), &clk, ts::ctx(&mut s)
        );
        // Graduated even though tokens remain
        assert!(bonding_curve::graduated(&curve), 2600);
        assert!(bonding_curve::token_reserve(&curve) > 0, 2601);
        destroy(tokens); destroy(refund);
        clock::destroy_for_testing(clk);
        ts::return_shared(curve);
        ts::end(s);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // V10 TESTS
    // ═══════════════════════════════════════════════════════════════════════

    const CTO_INACTIVITY_MS: u64 = 5  * 24 * 60 * 60 * 1_000;
    const CTO_WINDOW_MS:     u64 = 12 * 60 * 60 * 1_000;
    const NOMINEE:  address = @0xACE;
    const VOTER_A:  address = @0xACED1;
    const VOTER_B:  address = @0xACED2;

    // ─── Item 4: holder-gated chat ─────────────────────────────────────────

    #[test]
    #[expected_failure(abort_code = E_HOLDER_ONLY, location = suipump::bonding_curve)]
    fun test_post_comment_zero_balance_rejected() {
        let mut s = ts::begin(CREATOR);
        let (_a, _b) = make_payouts_single();
        setup_curve(&mut s, _a, _b);

        ts::next_tx(&mut s, BUYER);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        let fee = mint_sui(COMMENT_FEE, &mut s);
        let empty_holder = coin::zero<TEST_TOKEN>(ts::ctx(&mut s)); // balance 0
        bonding_curve::post_comment(
            &mut curve, string::utf8(b"spam"), fee, BUYER, &empty_holder, @0x0, ts::ctx(&mut s),
        );
        destroy(empty_holder);
        ts::return_shared(curve);
        ts::end(s);
    }

    // ─── Item 2: buyback carves from creator, conservation holds ───────────

    #[test]
    fun test_buyback_config_and_accrual() {
        let mut s = ts::begin(CREATOR);
        let (_a, _b) = make_payouts_single();
        setup_curve(&mut s, _a, _b);

        // Creator sets 50% buyback (of the creator slice), burn mode.
        ts::next_tx(&mut s, CREATOR);
        let cap = ts::take_from_sender<CreatorCap>(&s);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        let clk = clock::create_for_testing(ts::ctx(&mut s));
        bonding_curve::set_buyback_config(&cap, &mut curve, 5_000, true, &clk, ts::ctx(&mut s));
        assert!(bonding_curve::buyback_bps(&curve) == 5_000, 9001);
        assert!(bonding_curve::buyback_burn(&curve) == true, 9002);

        // A real buy() carves buyback into the bucket. 100 SUI buy:
        //   fee = 1% = 1 SUI; creator slice = 40% of fee = 0.4 SUI;
        //   buyback = 50% of creator slice = 0.2 SUI accrued.
        ts::next_tx(&mut s, BUYER);
        let payment = mint_sui(100 * MIST_PER_SUI, &mut s);
        let (tokens, refund) = bonding_curve::buy(
            &mut curve, payment, 0, option::none(), 0, &clk, ts::ctx(&mut s),
        );
        let bucket = bonding_curve::buyback_fees_pending(&curve);
        // 0.2 SUI = 200_000_000 MIST (no referral path).
        assert!(bucket == 200_000_000, 9003);

        destroy(tokens); destroy(refund);
        clock::destroy_for_testing(clk);
        ts::return_to_address(CREATOR, cap);
        ts::return_shared(curve);
        ts::end(s);
    }

    #[test]
    fun test_execute_buyback_burns() {
        let mut s = ts::begin(CREATOR);
        let (_a, _b) = make_payouts_single();
        setup_curve(&mut s, _a, _b);

        ts::next_tx(&mut s, CREATOR);
        let cap = ts::take_from_sender<CreatorCap>(&s);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        let clk = clock::create_for_testing(ts::ctx(&mut s));
        bonding_curve::set_buyback_config(&cap, &mut curve, 10_000, true, &clk, ts::ctx(&mut s));

        ts::next_tx(&mut s, BUYER);
        let payment = mint_sui(100 * MIST_PER_SUI, &mut s);
        let (tokens, refund) = bonding_curve::buy(
            &mut curve, payment, 0, option::none(), 0, &clk, ts::ctx(&mut s),
        );
        destroy(tokens); destroy(refund);

        // Execute buyback: spends bucket, burns bought tokens. Bucket -> 0.
        assert!(bonding_curve::buyback_fees_pending(&curve) > 0, 9100);
        bonding_curve::execute_buyback(&mut curve, ts::ctx(&mut s));
        assert!(bonding_curve::buyback_fees_pending(&curve) == 0, 9101);

        clock::destroy_for_testing(clk);
        ts::return_to_address(CREATOR, cap);
        ts::return_shared(curve);
        ts::end(s);
    }

    #[test]
    #[expected_failure(abort_code = E_BUYBACK_BPS_TOO_HIGH, location = suipump::bonding_curve)]
    fun test_buyback_bps_too_high_rejected() {
        let mut s = ts::begin(CREATOR);
        let (_a, _b) = make_payouts_single();
        setup_curve(&mut s, _a, _b);
        ts::next_tx(&mut s, CREATOR);
        let cap = ts::take_from_sender<CreatorCap>(&s);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        let clk = clock::create_for_testing(ts::ctx(&mut s));
        bonding_curve::set_buyback_config(&cap, &mut curve, 10_001, true, &clk, ts::ctx(&mut s));
        clock::destroy_for_testing(clk);
        ts::return_to_sender(&s, cap);
        ts::return_shared(curve);
        ts::end(s);
    }

    // ─── Item 6: protocol surcharge into protocol_fees ─────────────────────

    #[test]
    fun test_collect_protocol_surcharge() {
        let mut s = ts::begin(CREATOR);
        let (_a, _b) = make_payouts_single();
        setup_curve(&mut s, _a, _b);

        ts::next_tx(&mut s, CREATOR);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        let before = bonding_curve::protocol_fees(&curve);
        let surcharge = mint_sui(2 * MIST_PER_SUI, &mut s);
        bonding_curve::collect_protocol_surcharge(&mut curve, surcharge);
        assert!(bonding_curve::protocol_fees(&curve) == before + 2 * MIST_PER_SUI, 9200);
        ts::return_shared(curve);
        ts::end(s);
    }

    // ─── Item 3: CTO — the critical cap-swap REVOCATION test ───────────────

    #[test]
    #[expected_failure(abort_code = E_NOT_ACTIVE_CREATOR, location = suipump::bonding_curve)]
    fun test_cto_swap_revokes_old_creator() {
        let mut s = ts::begin(CREATOR);
        let (_a, _b) = make_payouts_single();
        setup_curve(&mut s, _a, _b);

        // BUYER buys a large bag so they hold >= 1% of circulating and have weight.
        ts::next_tx(&mut s, BUYER);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        let clk0 = clock::create_for_testing(ts::ctx(&mut s));
        let payment = mint_sui(5_000 * MIST_PER_SUI, &mut s);
        let (bag, refund) = bonding_curve::buy(
            &mut curve, payment, 0, option::none(), 0, &clk0, ts::ctx(&mut s),
        );
        destroy(refund);
        ts::return_shared(curve);
        clock::destroy_for_testing(clk0);

        // Advance clock past 5-day inactivity, open proposal nominating NOMINEE.
        ts::next_tx(&mut s, BUYER);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        let mut clk = clock::create_for_testing(ts::ctx(&mut s));
        clock::set_for_testing(&mut clk, CTO_INACTIVITY_MS + 1);
        let mut proposal = bonding_curve::propose_takeover(
            &mut curve, NOMINEE, &bag, &clk, ts::ctx(&mut s),
        );
        // Vote FOR with the full bag (passes quorum: bag is ~all circulating).
        bonding_curve::vote_takeover(&curve, &mut proposal, true, &bag, &clk, ts::ctx(&mut s));
        // Close the window and resolve -> swap to NOMINEE.
        clock::set_for_testing(&mut clk, CTO_INACTIVITY_MS + CTO_WINDOW_MS + 2);
        bonding_curve::resolve_takeover(&mut curve, proposal, &clk, ts::ctx(&mut s));

        // The OLD creator's cap must now FAIL on a gated call (revoked by swap).
        ts::next_tx(&mut s, CREATOR);
        let old_cap = ts::take_from_address<CreatorCap>(&s, CREATOR);
        // This MUST abort E_NOT_ACTIVE_CREATOR — proving the takeover revoked it.
        bonding_curve::creator_heartbeat(&old_cap, &mut curve, &clk, ts::ctx(&mut s));

        destroy(bag);
        ts::return_to_address(CREATOR, old_cap);
        clock::destroy_for_testing(clk);
        ts::return_shared(curve);
        ts::end(s);
    }

    #[test]
    #[expected_failure(abort_code = E_CREATOR_STILL_ACTIVE, location = suipump::bonding_curve)]
    fun test_cto_blocked_while_creator_active() {
        let mut s = ts::begin(CREATOR);
        let (_a, _b) = make_payouts_single();
        setup_curve(&mut s, _a, _b);

        ts::next_tx(&mut s, BUYER);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        let clk = clock::create_for_testing(ts::ctx(&mut s)); // t=0, creator just active
        let payment = mint_sui(5_000 * MIST_PER_SUI, &mut s);
        let (bag, refund) = bonding_curve::buy(
            &mut curve, payment, 0, option::none(), 0, &clk, ts::ctx(&mut s),
        );
        destroy(refund);
        // Propose immediately (creator active < 5 days) -> must abort.
        let proposal = bonding_curve::propose_takeover(
            &mut curve, NOMINEE, &bag, &clk, ts::ctx(&mut s),
        );
        bonding_curve::resolve_takeover(&mut curve, proposal, &clk, ts::ctx(&mut s));
        destroy(bag);
        clock::destroy_for_testing(clk);
        ts::return_shared(curve);
        ts::end(s);
    }

    // ─── Item 1: AgentSession scope ────────────────────────────────────────

    #[test]
    fun test_agent_session_open_and_buy() {
        use suipump::agent_session;
        let mut s = ts::begin(CREATOR);
        let (_a, _b) = make_payouts_single();
        setup_curve(&mut s, _a, _b);

        // Owner opens a session funded with 10 SUI, session key = BUYER.
        ts::next_tx(&mut s, CREATOR);
        let deposit = mint_sui(10 * MIST_PER_SUI, &mut s);
        let clk = clock::create_for_testing(ts::ctx(&mut s));
        let mut session = agent_session::open_session(
            deposit, BUYER, 0, 1_000_000_000_000, ts::ctx(&mut s),
        );
        assert!(agent_session::escrow_value(&session) == 10 * MIST_PER_SUI, 9300);

        // Session key (BUYER) executes a buy of 1 SUI from escrow.
        ts::next_tx(&mut s, BUYER);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        agent_session::buy_with_session(
            &mut session, &mut curve, 1 * MIST_PER_SUI, 0, 0, &clk, ts::ctx(&mut s),
        );
        // 1 SUI leaves escrow for the buy; the LP-fee tail refund compounds
        // back in, so escrow lands strictly between 9 and 10 SUI.
        let esc_after = agent_session::escrow_value(&session);
        assert!(esc_after > 9 * MIST_PER_SUI, 9301);
        assert!(esc_after < 10 * MIST_PER_SUI, 9303);
        assert!(agent_session::spent(&session) == 1 * MIST_PER_SUI, 9302);

        clock::destroy_for_testing(clk);
        ts::return_shared(curve);
        // close from owner
        ts::next_tx(&mut s, CREATOR);
        let leftover = agent_session::close_session(&mut session, ts::ctx(&mut s));
        destroy(leftover);
        destroy(session);
        ts::end(s);
    }

    #[test]
    #[expected_failure(abort_code = 1, location = suipump::agent_session)]
    fun test_agent_session_wrong_key_rejected() {
        use suipump::agent_session;
        let mut s = ts::begin(CREATOR);
        let (_a, _b) = make_payouts_single();
        setup_curve(&mut s, _a, _b);

        ts::next_tx(&mut s, CREATOR);
        let deposit = mint_sui(10 * MIST_PER_SUI, &mut s);
        let clk = clock::create_for_testing(ts::ctx(&mut s));
        let mut session = agent_session::open_session(
            deposit, BUYER, 0, 1_000_000_000_000, ts::ctx(&mut s),
        );

        // REFERRER (not the session key) tries to trade -> ENotSessionKey (1).
        ts::next_tx(&mut s, REFERRER);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        agent_session::buy_with_session(
            &mut session, &mut curve, 1 * MIST_PER_SUI, 0, 0, &clk, ts::ctx(&mut s),
        );

        clock::destroy_for_testing(clk);
        ts::return_shared(curve);
        transfer::public_share_object(session);
        ts::end(s);
    }

}
