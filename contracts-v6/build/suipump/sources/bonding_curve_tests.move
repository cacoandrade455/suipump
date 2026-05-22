/// Unit tests for suipump::bonding_curve (v6)
///
/// Changes from v4 tests:
///   - create_with_launch_fee / create_and_return now take description,
///     graduation_target, anti_bot_delay, clock args
///   - New error codes: EAntiBotBlocked (18), EMetadataAlreadyUpdated (21),
///     EMetadataWindowClosed (22)
///   - New tests: anti_bot_delay, metadata_updated flag
///   - drain sanity check updated for VS=9k (drains ~21k SUI, not ~88k)
///   - graduation threshold is now GRAD_THRESHOLD_MIST = 17k SUI
///
/// Run with: `sui move test` from the contracts-v6/ directory.
#[test_only]
module suipump::bonding_curve_tests {
    use sui::coin::{Self, Coin};
    use sui::sui::SUI;
    use sui::test_scenario::{Self as ts, Scenario};
    use sui::test_utils::destroy;
    use sui::clock;
    use std::ascii;
    use std::string;

    use suipump::bonding_curve::{Self, Curve, CreatorCap, AdminCap};

    public struct TEST_TOKEN has drop {}

    const CREATOR:   address = @0xC1EA70;
    const BUYER:     address = @0xB0FEE;
    const ADMIN:     address = @0xAD1;
    const PAYOUT_A:  address = @0xA;
    const PAYOUT_B:  address = @0xB;
    const PAYOUT_C:  address = @0xC;

    const MIST_PER_SUI: u64 = 1_000_000_000;
    const LAUNCH_FEE:   u64 = 2 * 1_000_000_000;

    // Graduation target — must match v6 contract
    const GRAD_THRESHOLD_MIST: u64 = 17_000 * 1_000_000_000;

    // Error codes — must match bonding_curve.move exactly
    const E_SLIPPAGE_EXCEEDED:        u64 = 3;
    const E_ALREADY_GRADUATED:        u64 = 4;
    const E_NOT_GRADUATED:            u64 = 5;
    const E_ZERO_AMOUNT:              u64 = 7;
    const E_NO_FEES:                  u64 = 8;
    const E_PAYOUTS_SUM_INVALID:      u64 = 10;
    const E_PAYOUTS_EMPTY:            u64 = 11;
    const E_TOO_MANY_PAYOUTS:         u64 = 12;
    const E_DUPLICATE_PAYOUT_ADDRESS: u64 = 13;
    const E_WRONG_LAUNCH_FEE:         u64 = 14;
    const E_CAP_MISMATCH:             u64 = 15;
    const E_COMMENT_TOO_LONG:         u64 = 16;
    const E_COMMENT_EMPTY:            u64 = 17;
    const E_ANTI_BOT_BLOCKED:         u64 = 18;
    const E_METADATA_ALREADY_UPDATED: u64 = 21;
    const E_METADATA_WINDOW_CLOSED:   u64 = 22;

    // ─── Helpers ─────────────────────────────────────────────────────────────

    fun mint_sui(amount: u64, scenario: &mut Scenario): Coin<SUI> {
        coin::mint_for_testing<SUI>(amount, ts::ctx(scenario))
    }

    fun make_payouts_single(): (vector<address>, vector<u64>) {
        let mut addrs = vector::empty<address>();
        let mut bps   = vector::empty<u64>();
        vector::push_back(&mut addrs, CREATOR);
        vector::push_back(&mut bps,   10_000);
        (addrs, bps)
    }

    fun make_payouts_three(): (vector<address>, vector<u64>) {
        let mut addrs = vector::empty<address>();
        let mut bps   = vector::empty<u64>();
        vector::push_back(&mut addrs, PAYOUT_A); vector::push_back(&mut bps, 5_000);
        vector::push_back(&mut addrs, PAYOUT_B); vector::push_back(&mut bps, 3_000);
        vector::push_back(&mut addrs, PAYOUT_C); vector::push_back(&mut bps, 2_000);
        (addrs, bps)
    }

    /// Create a v6 curve. Shares the Curve and transfers CreatorCap to CREATOR.
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
            0, // anti_bot_delay: 0 = no delay
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
        let (tokens, refund) = bonding_curve::buy(
            &mut curve, payment, 0,
            std::option::none(),
            &clk,
            ts::ctx(scenario)
        );
        destroy(tokens);
        destroy(refund);
        clock::destroy_for_testing(clk);
        ts::return_shared(curve);
    }

    /// Graduate the curve (permissionless).
    fun do_graduate(scenario: &mut Scenario) {
        ts::next_tx(scenario, BUYER);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(scenario);
        bonding_curve::graduate(&mut curve, ts::ctx(scenario));
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
        assert!(bonding_curve::protocol_fees_pending(&curve) == LAUNCH_FEE, 100);
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
        assert!(bonding_curve::creator_cap_curve_id(&cap) == object::id(&curve), 200);
        ts::return_to_sender(&s, cap);
        ts::return_shared(curve);
        ts::end(s);
    }

    // ─── Payout validation ───────────────────────────────────────────────────

    #[test]
    #[expected_failure(abort_code = E_PAYOUTS_EMPTY, location = suipump::bonding_curve)]
    fun test_empty_payouts_rejected() {
        let mut s = ts::begin(CREATOR);
        setup_curve(&mut s, vector::empty(), vector::empty());
        ts::end(s);
    }

    #[test]
    #[expected_failure(abort_code = E_PAYOUTS_SUM_INVALID, location = suipump::bonding_curve)]
    fun test_payouts_not_summing_to_10000_rejected() {
        let mut s = ts::begin(CREATOR);
        let mut addrs = vector::empty<address>();
        let mut bps   = vector::empty<u64>();
        vector::push_back(&mut addrs, PAYOUT_A); vector::push_back(&mut bps, 3_000);
        vector::push_back(&mut addrs, PAYOUT_B); vector::push_back(&mut bps, 3_000);
        setup_curve(&mut s, addrs, bps);
        ts::end(s);
    }

    #[test]
    #[expected_failure(abort_code = E_DUPLICATE_PAYOUT_ADDRESS, location = suipump::bonding_curve)]
    fun test_duplicate_payout_address_rejected() {
        let mut s = ts::begin(CREATOR);
        let mut addrs = vector::empty<address>();
        let mut bps   = vector::empty<u64>();
        vector::push_back(&mut addrs, PAYOUT_A); vector::push_back(&mut bps, 5_000);
        vector::push_back(&mut addrs, PAYOUT_A); vector::push_back(&mut bps, 5_000);
        setup_curve(&mut s, addrs, bps);
        ts::end(s);
    }

    #[test]
    #[expected_failure(abort_code = E_TOO_MANY_PAYOUTS, location = suipump::bonding_curve)]
    fun test_too_many_payouts_rejected() {
        let mut s = ts::begin(CREATOR);
        let mut addrs = vector::empty<address>();
        let mut bps   = vector::empty<u64>();
        vector::push_back(&mut addrs, @0x1);  vector::push_back(&mut bps, 1_000);
        vector::push_back(&mut addrs, @0x2);  vector::push_back(&mut bps, 1_000);
        vector::push_back(&mut addrs, @0x3);  vector::push_back(&mut bps, 1_000);
        vector::push_back(&mut addrs, @0x4);  vector::push_back(&mut bps, 1_000);
        vector::push_back(&mut addrs, @0x5);  vector::push_back(&mut bps, 1_000);
        vector::push_back(&mut addrs, @0x6);  vector::push_back(&mut bps, 1_000);
        vector::push_back(&mut addrs, @0x7);  vector::push_back(&mut bps, 1_000);
        vector::push_back(&mut addrs, @0x8);  vector::push_back(&mut bps, 1_000);
        vector::push_back(&mut addrs, @0x9);  vector::push_back(&mut bps, 1_000);
        vector::push_back(&mut addrs, @0xa);  vector::push_back(&mut bps,   500);
        vector::push_back(&mut addrs, @0xb);  vector::push_back(&mut bps,   500);
        setup_curve(&mut s, addrs, bps);
        ts::end(s);
    }

    // ─── Multi-payout claim arithmetic ───────────────────────────────────────

    #[test]
    fun test_three_way_payout_split_pays_each_recipient() {
        let mut s = ts::begin(CREATOR);
        let (_a, _b) = make_payouts_three();
        setup_curve(&mut s, _a, _b);

        ts::next_tx(&mut s, BUYER);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        let payment = mint_sui(100 * MIST_PER_SUI, &mut s);
        let clk = clock::create_for_testing(ts::ctx(&mut s));
        let (tokens, refund) = bonding_curve::buy(&mut curve, payment, 0, std::option::none(), &clk, ts::ctx(&mut s));
        destroy(tokens); destroy(refund);
        clock::destroy_for_testing(clk);
        assert!(bonding_curve::creator_fees_pending(&curve) == 400_000_000, 300);
        ts::return_shared(curve);

        ts::next_tx(&mut s, CREATOR);
        let cap   = ts::take_from_sender<CreatorCap>(&s);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        bonding_curve::claim_creator_fees(&cap, &mut curve, ts::ctx(&mut s));
        assert!(bonding_curve::creator_fees_pending(&curve) == 0, 301);
        ts::return_to_sender(&s, cap);
        ts::return_shared(curve);

        ts::next_tx(&mut s, PAYOUT_A);
        let a = ts::take_from_sender<Coin<SUI>>(&s);
        assert!(coin::value(&a) == 200_000_000, 310);
        ts::return_to_sender(&s, a);

        ts::next_tx(&mut s, PAYOUT_B);
        let b = ts::take_from_sender<Coin<SUI>>(&s);
        assert!(coin::value(&b) == 120_000_000, 311);
        ts::return_to_sender(&s, b);

        ts::next_tx(&mut s, PAYOUT_C);
        let c = ts::take_from_sender<Coin<SUI>>(&s);
        assert!(coin::value(&c) == 80_000_000, 312);
        ts::return_to_sender(&s, c);

        ts::end(s);
    }

    #[test]
    fun test_claim_rounding_goes_to_last_recipient() {
        let mut s = ts::begin(CREATOR);
        let mut addrs = vector::empty<address>();
        let mut bps   = vector::empty<u64>();
        vector::push_back(&mut addrs, PAYOUT_A); vector::push_back(&mut bps, 3_333);
        vector::push_back(&mut addrs, PAYOUT_B); vector::push_back(&mut bps, 3_333);
        vector::push_back(&mut addrs, PAYOUT_C); vector::push_back(&mut bps, 3_334);
        setup_curve(&mut s, addrs, bps);

        ts::next_tx(&mut s, BUYER);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        let payment = mint_sui(250_000, &mut s);
        let clk = clock::create_for_testing(ts::ctx(&mut s));
        let (tokens, refund) = bonding_curve::buy(&mut curve, payment, 0, std::option::none(), &clk, ts::ctx(&mut s));
        destroy(tokens); destroy(refund);
        clock::destroy_for_testing(clk);
        assert!(bonding_curve::creator_fees_pending(&curve) == 1000, 400);
        ts::return_shared(curve);

        ts::next_tx(&mut s, CREATOR);
        let cap   = ts::take_from_sender<CreatorCap>(&s);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        bonding_curve::claim_creator_fees(&cap, &mut curve, ts::ctx(&mut s));
        assert!(bonding_curve::creator_fees_pending(&curve) == 0, 401);
        ts::return_to_sender(&s, cap);
        ts::return_shared(curve);

        ts::next_tx(&mut s, PAYOUT_A);
        let a = ts::take_from_sender<Coin<SUI>>(&s);
        assert!(coin::value(&a) == 333, 410); ts::return_to_sender(&s, a);

        ts::next_tx(&mut s, PAYOUT_B);
        let b = ts::take_from_sender<Coin<SUI>>(&s);
        assert!(coin::value(&b) == 333, 411); ts::return_to_sender(&s, b);

        ts::next_tx(&mut s, PAYOUT_C);
        let c = ts::take_from_sender<Coin<SUI>>(&s);
        assert!(coin::value(&c) == 334, 412); ts::return_to_sender(&s, c);

        ts::end(s);
    }

    // ─── Cap authorization ───────────────────────────────────────────────────

    #[test]
    #[expected_failure(abort_code = E_CAP_MISMATCH, location = suipump::bonding_curve)]
    fun test_cap_mismatch_aborts() {
        let mut s = ts::begin(CREATOR);
        ts::next_tx(&mut s, CREATOR);

        let clk = clock::create_for_testing(ts::ctx(&mut s));

        let treasury_a = coin::create_treasury_cap_for_testing<TEST_TOKEN>(ts::ctx(&mut s));
        let payment_a  = mint_sui(LAUNCH_FEE, &mut s);
        let (addrs_a, bps_a) = make_payouts_single();
        let (mut curve_a, cap_a) = bonding_curve::create_and_return<TEST_TOKEN>(
            treasury_a, payment_a,
            string::utf8(b"Curve A"), ascii::string(b"AAA"),
            string::utf8(b"desc a"),
            addrs_a, bps_a, 0, 0, &clk, ts::ctx(&mut s),
        );

        let treasury_b = coin::create_treasury_cap_for_testing<TEST_TOKEN>(ts::ctx(&mut s));
        let payment_b  = mint_sui(LAUNCH_FEE, &mut s);
        let (addrs_b, bps_b) = make_payouts_single();
        let (curve_b, cap_b) = bonding_curve::create_and_return<TEST_TOKEN>(
            treasury_b, payment_b,
            string::utf8(b"Curve B"), ascii::string(b"BBB"),
            string::utf8(b"desc b"),
            addrs_b, bps_b, 0, 0, &clk, ts::ctx(&mut s),
        );

        clock::destroy_for_testing(clk);
        bonding_curve::share_curve(curve_b);
        bonding_curve::claim_creator_fees(&cap_b, &mut curve_a, ts::ctx(&mut s));

        bonding_curve::share_curve(curve_a);
        transfer::public_transfer(cap_a, CREATOR);
        transfer::public_transfer(cap_b, CREATOR);
        ts::end(s);
    }

    #[test]
    fun test_cap_transfer_transfers_claim_authority() {
        let mut s = ts::begin(CREATOR);
        let (_a, _b) = make_payouts_single();
        setup_curve(&mut s, _a, _b);

        ts::next_tx(&mut s, CREATOR);
        let cap = ts::take_from_sender<CreatorCap>(&s);
        transfer::public_transfer(cap, BUYER);

        ts::next_tx(&mut s, BUYER);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        let payment = mint_sui(10 * MIST_PER_SUI, &mut s);
        let clk = clock::create_for_testing(ts::ctx(&mut s));
        let (tokens, refund) = bonding_curve::buy(&mut curve, payment, 0, std::option::none(), &clk, ts::ctx(&mut s));
        destroy(tokens); destroy(refund);
        clock::destroy_for_testing(clk);
        ts::return_shared(curve);

        ts::next_tx(&mut s, BUYER);
        let cap   = ts::take_from_sender<CreatorCap>(&s);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        bonding_curve::claim_creator_fees(&cap, &mut curve, ts::ctx(&mut s));
        assert!(bonding_curve::creator_fees_pending(&curve) == 0, 500);
        ts::return_to_sender(&s, cap);
        ts::return_shared(curve);

        ts::next_tx(&mut s, CREATOR);
        let c = ts::take_from_sender<Coin<SUI>>(&s);
        assert!(coin::value(&c) == 40_000_000, 501);
        ts::return_to_sender(&s, c);

        ts::end(s);
    }

    // ─── Buy / sell basics ───────────────────────────────────────────────────

    #[test]
    fun test_buy_then_sell_loses_roughly_two_percent() {
        let mut s = ts::begin(CREATOR);
        let (_a, _b) = make_payouts_single();
        setup_curve(&mut s, _a, _b);

        ts::next_tx(&mut s, BUYER);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        let payment = mint_sui(100 * MIST_PER_SUI, &mut s);
        let clk = clock::create_for_testing(ts::ctx(&mut s));
        let (tokens, refund) = bonding_curve::buy(&mut curve, payment, 0, std::option::none(), &clk, ts::ctx(&mut s));
        destroy(refund);
        let sui_back = bonding_curve::sell(&mut curve, tokens, 0, ts::ctx(&mut s));
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
        let (tokens, refund) = bonding_curve::buy(&mut curve, payment, 0, std::option::none(), &clk, ts::ctx(&mut s));
        destroy(tokens); destroy(refund);
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
        let payment = mint_sui(MIST_PER_SUI, &mut s);
        let clk = clock::create_for_testing(ts::ctx(&mut s));
        let (tokens, refund) = bonding_curve::buy(
            &mut curve, payment,
            800_000_000 * 1_000_000,
            std::option::none(),
            &clk,
            ts::ctx(&mut s)
        );
        destroy(tokens); destroy(refund);
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
        let payment = mint_sui(50_000 * MIST_PER_SUI, &mut s);
        let clk = clock::create_for_testing(ts::ctx(&mut s));
        let (tokens, refund) = bonding_curve::buy(&mut curve, payment, 0, std::option::none(), &clk, ts::ctx(&mut s));
        assert!(coin::value(&tokens) == 800_000_000 * 1_000_000, 800);
        assert!(bonding_curve::tokens_remaining(&curve) == 0, 801);
        assert!(coin::value(&refund) > 0, 802);
        destroy(tokens); destroy(refund);
        clock::destroy_for_testing(clk);
        ts::return_shared(curve);
        ts::end(s);
    }

    // ─── Anti-bot delay ──────────────────────────────────────────────────────

    #[test]
    fun test_creator_can_buy_during_antibot_window() {
        let mut s = ts::begin(CREATOR);
        // Set clock to 0ms, anti-bot = 30s
        let clk = setup_curve_with_antibot(&mut s, 30, 0);

        ts::next_tx(&mut s, CREATOR);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        let payment = mint_sui(MIST_PER_SUI, &mut s);
        // Clock still at 0ms — within 30s window — but CREATOR is allowed
        let (tokens, refund) = bonding_curve::buy(&mut curve, payment, 0, std::option::none(), &clk, ts::ctx(&mut s));
        destroy(tokens); destroy(refund);
        ts::return_shared(curve);
        clock::destroy_for_testing(clk);
        ts::end(s);
    }

    #[test]
    #[expected_failure(abort_code = E_ANTI_BOT_BLOCKED, location = suipump::bonding_curve)]
    fun test_non_creator_blocked_during_antibot_window() {
        let mut s = ts::begin(CREATOR);
        let clk = setup_curve_with_antibot(&mut s, 30, 0);

        // BUYER tries to buy at t=0, within 30s window — must be blocked
        ts::next_tx(&mut s, BUYER);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        let payment = mint_sui(MIST_PER_SUI, &mut s);
        let (tokens, refund) = bonding_curve::buy(&mut curve, payment, 0, std::option::none(), &clk, ts::ctx(&mut s));
        destroy(tokens); destroy(refund);
        ts::return_shared(curve);
        clock::destroy_for_testing(clk);
        ts::end(s);
    }

    #[test]
    fun test_buyer_can_buy_after_antibot_window_expires() {
        let mut s = ts::begin(CREATOR);
        // Launch at t=0 with 15s anti-bot
        let mut clk = setup_curve_with_antibot(&mut s, 15, 0);

        // Advance clock past 15s
        clock::set_for_testing(&mut clk, 16_000); // 16 seconds in ms

        ts::next_tx(&mut s, BUYER);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        let payment = mint_sui(MIST_PER_SUI, &mut s);
        let (tokens, refund) = bonding_curve::buy(&mut curve, payment, 0, std::option::none(), &clk, ts::ctx(&mut s));
        destroy(tokens); destroy(refund);
        ts::return_shared(curve);
        clock::destroy_for_testing(clk);
        ts::end(s);
    }

    #[test]
    fun test_no_antibot_allows_all_buyers_immediately() {
        let mut s = ts::begin(CREATOR);
        let (_a, _b) = make_payouts_single();
        setup_curve(&mut s, _a, _b); // anti_bot_delay = 0

        ts::next_tx(&mut s, BUYER);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        let payment = mint_sui(MIST_PER_SUI, &mut s);
        let clk = clock::create_for_testing(ts::ctx(&mut s));
        let (tokens, refund) = bonding_curve::buy(&mut curve, payment, 0, std::option::none(), &clk, ts::ctx(&mut s));
        destroy(tokens); destroy(refund);
        clock::destroy_for_testing(clk);
        ts::return_shared(curve);
        ts::end(s);
    }

    // ─── Graduation ──────────────────────────────────────────────────────────

    #[test]
    fun test_graduation_side_effects() {
        let mut s = ts::begin(CREATOR);
        let (_a, _b) = make_payouts_single();
        setup_curve(&mut s, _a, _b);
        drain_curve(&mut s);

        ts::next_tx(&mut s, BUYER);
        let curve_before_reserve;
        let proto_before;
        {
            let curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
            curve_before_reserve = bonding_curve::sui_reserve(&curve);
            proto_before         = bonding_curve::protocol_fees_pending(&curve);
            ts::return_shared(curve);
        };

        let expected_creator_bonus  = (curve_before_reserve * 50) / 10_000;
        let expected_protocol_bonus = (curve_before_reserve * 50) / 10_000;
        let expected_reserve_after  = curve_before_reserve
                                      - expected_creator_bonus
                                      - expected_protocol_bonus;

        do_graduate(&mut s);

        ts::next_tx(&mut s, BUYER);
        let curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        assert!(bonding_curve::is_graduated(&curve), 900);
        let proto_after = bonding_curve::protocol_fees_pending(&curve);
        assert!(proto_after == proto_before + expected_protocol_bonus, 901);
        assert!(bonding_curve::sui_reserve(&curve) == expected_reserve_after, 902);
        ts::return_shared(curve);

        ts::next_tx(&mut s, CREATOR);
        let bonus_coin = ts::take_from_sender<Coin<SUI>>(&s);
        assert!(coin::value(&bonus_coin) == expected_creator_bonus, 903);
        ts::return_to_sender(&s, bonus_coin);

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
        bonding_curve::graduate(&mut curve, ts::ctx(&mut s));
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
        bonding_curve::graduate(&mut curve, ts::ctx(&mut s));
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
        let payment = mint_sui(MIST_PER_SUI, &mut s);
        let clk = clock::create_for_testing(ts::ctx(&mut s));
        let (tokens, refund) = bonding_curve::buy(&mut curve, payment, 0, std::option::none(), &clk, ts::ctx(&mut s));
        destroy(tokens); destroy(refund);
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
        let payment = mint_sui(10 * MIST_PER_SUI, &mut s);
        let clk = clock::create_for_testing(ts::ctx(&mut s));
        let (held_tokens, refund) = bonding_curve::buy(&mut curve, payment, 0, std::option::none(), &clk, ts::ctx(&mut s));
        destroy(refund);
        clock::destroy_for_testing(clk);
        ts::return_shared(curve);

        drain_curve(&mut s);
        do_graduate(&mut s);

        ts::next_tx(&mut s, BUYER);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        let sui_out = bonding_curve::sell(&mut curve, held_tokens, 0, ts::ctx(&mut s));
        destroy(sui_out);
        ts::return_shared(curve);
        ts::end(s);
    }

    // ─── Metadata: one-time flag ──────────────────────────────────────────────

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
        setup_curve(&mut s, _a, _b); // created_at_ms = 0 (test clock default)

        ts::next_tx(&mut s, CREATOR);
        let curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        // 0 + 86_400_000ms = 86_400_000ms
        assert!(bonding_curve::metadata_window_closes_at(&curve) == 86_400_000, 1101);
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
        drain_curve(&mut s);
        do_graduate(&mut s);

        ts::next_tx(&mut s, CREATOR);
        let admin_cap = ts::take_from_sender<AdminCap>(&s);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        let pool_sui = bonding_curve::claim_graduation_funds(
            &admin_cap, &mut curve, ts::ctx(&mut s)
        );
        assert!(coin::value(&pool_sui) > 0, 1000);
        assert!(bonding_curve::sui_reserve(&curve) == 0, 1001);
        destroy(pool_sui);
        ts::return_to_sender(&s, admin_cap);
        ts::return_shared(curve);
        ts::end(s);
    }

    #[test]
    #[expected_failure(abort_code = E_NOT_GRADUATED, location = suipump::bonding_curve)]
    fun test_claim_graduation_funds_fails_if_not_graduated() {
        let mut s = ts::begin(CREATOR);
        bonding_curve::init_for_testing(ts::ctx(&mut s));

        ts::next_tx(&mut s, CREATOR);
        let (_a, _b) = make_payouts_single();
        setup_curve(&mut s, _a, _b);

        ts::next_tx(&mut s, CREATOR);
        let admin_cap = ts::take_from_sender<AdminCap>(&s);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        let pool_sui = bonding_curve::claim_graduation_funds(
            &admin_cap, &mut curve, ts::ctx(&mut s)
        );
        destroy(pool_sui);
        ts::return_to_sender(&s, admin_cap);
        ts::return_shared(curve);
        ts::end(s);
    }

    // ─── Comments ────────────────────────────────────────────────────────────

    #[test]
    fun test_post_comment_succeeds() {
        let mut s = ts::begin(CREATOR);
        let (_a, _b) = make_payouts_single();
        setup_curve(&mut s, _a, _b);

        ts::next_tx(&mut s, BUYER);
        let curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        let curve_id = object::id(&curve);
        ts::return_shared(curve);

        bonding_curve::post_comment(
            curve_id,
            string::utf8(b"great token"),
            ts::ctx(&mut s),
        );
        ts::end(s);
    }

    #[test]
    #[expected_failure(abort_code = E_COMMENT_EMPTY, location = suipump::bonding_curve)]
    fun test_empty_comment_rejected() {
        let mut s = ts::begin(BUYER);
        let (_a, _b) = make_payouts_single();
        setup_curve(&mut s, _a, _b);

        ts::next_tx(&mut s, BUYER);
        let curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        let curve_id = object::id(&curve);
        ts::return_shared(curve);

        bonding_curve::post_comment(curve_id, string::utf8(b""), ts::ctx(&mut s));
        ts::end(s);
    }

    #[test]
    #[expected_failure(abort_code = E_COMMENT_TOO_LONG, location = suipump::bonding_curve)]
    fun test_comment_too_long_rejected() {
        let mut s = ts::begin(BUYER);
        let (_a, _b) = make_payouts_single();
        setup_curve(&mut s, _a, _b);

        ts::next_tx(&mut s, BUYER);
        let curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        let curve_id = object::id(&curve);
        ts::return_shared(curve);

        let mut long_bytes = vector::empty<u8>();
        let chunk = b"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        vector::append(&mut long_bytes, chunk);
        vector::append(&mut long_bytes, chunk);
        vector::append(&mut long_bytes, chunk);
        let long_text = string::utf8(long_bytes);
        bonding_curve::post_comment(curve_id, long_text, ts::ctx(&mut s));
        ts::end(s);
    }
}
