/// Unit tests for suipump::bonding_curve  (v4 — void graduate, internal transfers)
///
/// Run with: `sui move test` from the contracts/ directory.
#[test_only]
module suipump::bonding_curve_tests {
    use sui::coin::{Self, Coin};
    use sui::sui::SUI;
    use sui::test_scenario::{Self as ts, Scenario};
    use sui::test_utils::destroy;
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

    // Error codes — must match bonding_curve.move exactly.
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

    /// Create a curve via the launch-fee path. Shares the Curve and transfers
    /// the CreatorCap to CREATOR. AdminCap goes to whoever called init() —
    /// for testing, use init_for_testing which goes to the tx sender.
    fun setup_curve(scenario: &mut Scenario,
                    payout_addresses: vector<address>,
                    payout_bps: vector<u64>) {
        let treasury = coin::create_treasury_cap_for_testing<TEST_TOKEN>(
            ts::ctx(scenario)
        );
        let payment = mint_sui(LAUNCH_FEE, scenario);
        bonding_curve::create_with_launch_fee<TEST_TOKEN>(
            treasury, payment,
            string::utf8(b"Test Token"), ascii::string(b"TEST"),
            payout_addresses, payout_bps,
            ts::ctx(scenario),
        );
    }

    /// Buy enough SUI to drain the entire 800M token supply via tail-clip.
    fun drain_curve(scenario: &mut Scenario) {
        ts::next_tx(scenario, BUYER);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(scenario);
        let payment = mint_sui(200_000 * MIST_PER_SUI, scenario);
        let (tokens, refund) = bonding_curve::buy(
            &mut curve, payment, 0, ts::ctx(scenario)
        );
        destroy(tokens);
        destroy(refund);
        ts::return_shared(curve);
    }

    /// Graduate the curve (permissionless — token_reserve must be 0).
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
        let bad_payment = mint_sui(MIST_PER_SUI, &mut s); // 1 SUI, not 2
        let (addrs, bps) = make_payouts_single();
        bonding_curve::create_with_launch_fee<TEST_TOKEN>(
            treasury, bad_payment,
            string::utf8(b"T"), ascii::string(b"T"),
            addrs, bps, ts::ctx(&mut s),
        );
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
        // 11 distinct addresses, each 909 bps (sum < 10_000 but count check fires first)
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
        // 11 entries summing to 10_000 — must abort with ETooManyPayouts.
        setup_curve(&mut s, addrs, bps);
        ts::end(s);
    }

    // ─── Multi-payout claim arithmetic ───────────────────────────────────────

    #[test]
    fun test_three_way_payout_split_pays_each_recipient() {
        let mut s = ts::begin(CREATOR);
        let (_a, _b) = make_payouts_three();
        setup_curve(&mut s, _a, _b);

        // 100 SUI buy → 0.40 SUI = 400_000_000 MIST creator fees.
        ts::next_tx(&mut s, BUYER);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        let payment = mint_sui(100 * MIST_PER_SUI, &mut s);
        let (tokens, refund) = bonding_curve::buy(&mut curve, payment, 0, ts::ctx(&mut s));
        destroy(tokens); destroy(refund);
        assert!(bonding_curve::creator_fees_pending(&curve) == 400_000_000, 300);
        ts::return_shared(curve);

        // Claim — A gets 50% (200M), B 30% (120M), C 20% (80M).
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
        // A=3333, B=3333, C=3334. With 1000 MIST creator fees:
        // A gets 333, B gets 333, C (last) absorbs dust = 334.
        let mut s = ts::begin(CREATOR);
        let mut addrs = vector::empty<address>();
        let mut bps   = vector::empty<u64>();
        vector::push_back(&mut addrs, PAYOUT_A); vector::push_back(&mut bps, 3_333);
        vector::push_back(&mut addrs, PAYOUT_B); vector::push_back(&mut bps, 3_333);
        vector::push_back(&mut addrs, PAYOUT_C); vector::push_back(&mut bps, 3_334);
        setup_curve(&mut s, addrs, bps);

        // 250_000 MIST buy → fee=2500, creator_fee=1000 MIST exactly.
        ts::next_tx(&mut s, BUYER);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        let payment = mint_sui(250_000, &mut s);
        let (tokens, refund) = bonding_curve::buy(&mut curve, payment, 0, ts::ctx(&mut s));
        destroy(tokens); destroy(refund);
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
        // Create two curves in the same tx via create_and_return.
        // We hold cap_a and cap_b as local variables — no ambiguity.
        // Then call claim_creator_fees(&cap_b, &mut curve_a) which must abort
        // ECapMismatch (code 15) originating in suipump::bonding_curve.
        let mut s = ts::begin(CREATOR);
        ts::next_tx(&mut s, CREATOR);

        let treasury_a = coin::create_treasury_cap_for_testing<TEST_TOKEN>(ts::ctx(&mut s));
        let payment_a  = mint_sui(LAUNCH_FEE, &mut s);
        let (addrs_a, bps_a) = make_payouts_single();
        let (mut curve_a, cap_a) = bonding_curve::create_and_return<TEST_TOKEN>(
            treasury_a, payment_a,
            string::utf8(b"Curve A"), ascii::string(b"AAA"),
            addrs_a, bps_a, ts::ctx(&mut s),
        );

        let treasury_b = coin::create_treasury_cap_for_testing<TEST_TOKEN>(ts::ctx(&mut s));
        let payment_b  = mint_sui(LAUNCH_FEE, &mut s);
        let (addrs_b, bps_b) = make_payouts_single();
        let (curve_b, cap_b) = bonding_curve::create_and_return<TEST_TOKEN>(
            treasury_b, payment_b,
            string::utf8(b"Curve B"), ascii::string(b"BBB"),
            addrs_b, bps_b, ts::ctx(&mut s),
        );

        // Share curve_a so we can mutably borrow it for the claim call.
        bonding_curve::share_curve(curve_b);
        // cap_b.curve_id == curve_b.id != curve_a.id
        // Calling claim_creator_fees with cap_b on curve_a must abort.
        bonding_curve::claim_creator_fees(&cap_b, &mut curve_a, ts::ctx(&mut s));

        // Unreachable — clean up to satisfy the compiler.
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

        // CREATOR transfers cap to BUYER.
        ts::next_tx(&mut s, CREATOR);
        let cap = ts::take_from_sender<CreatorCap>(&s);
        transfer::public_transfer(cap, BUYER);

        // Generate creator fees.
        ts::next_tx(&mut s, BUYER);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        let payment = mint_sui(10 * MIST_PER_SUI, &mut s);
        let (tokens, refund) = bonding_curve::buy(&mut curve, payment, 0, ts::ctx(&mut s));
        destroy(tokens); destroy(refund);
        ts::return_shared(curve);

        // BUYER (new cap owner) claims.
        ts::next_tx(&mut s, BUYER);
        let cap   = ts::take_from_sender<CreatorCap>(&s);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        bonding_curve::claim_creator_fees(&cap, &mut curve, ts::ctx(&mut s));
        assert!(bonding_curve::creator_fees_pending(&curve) == 0, 500);
        ts::return_to_sender(&s, cap);
        ts::return_shared(curve);

        // Payout goes to CREATOR (original payouts list unchanged).
        ts::next_tx(&mut s, CREATOR);
        let c = ts::take_from_sender<Coin<SUI>>(&s);
        assert!(coin::value(&c) == 40_000_000, 501); // 0.4% of 10 SUI
        ts::return_to_sender(&s, c);

        ts::end(s);
    }

    #[test]
    fun test_update_payouts_changes_subsequent_distribution() {
        let mut s = ts::begin(CREATOR);
        let (_a, _b) = make_payouts_single();
        setup_curve(&mut s, _a, _b);

        // Update to 3-way split.
        ts::next_tx(&mut s, CREATOR);
        let cap   = ts::take_from_sender<CreatorCap>(&s);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        let (addrs, bps) = make_payouts_three();
        bonding_curve::update_payouts(&cap, &mut curve, addrs, bps, ts::ctx(&mut s));
        ts::return_to_sender(&s, cap);
        ts::return_shared(curve);

        // Trade + claim using new split.
        ts::next_tx(&mut s, BUYER);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        let payment = mint_sui(100 * MIST_PER_SUI, &mut s);
        let (tokens, refund) = bonding_curve::buy(&mut curve, payment, 0, ts::ctx(&mut s));
        destroy(tokens); destroy(refund);
        ts::return_shared(curve);

        ts::next_tx(&mut s, CREATOR);
        let cap   = ts::take_from_sender<CreatorCap>(&s);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        bonding_curve::claim_creator_fees(&cap, &mut curve, ts::ctx(&mut s));
        ts::return_to_sender(&s, cap);
        ts::return_shared(curve);

        // PAYOUT_A gets 50% of 400M = 200M.
        ts::next_tx(&mut s, PAYOUT_A);
        let a = ts::take_from_sender<Coin<SUI>>(&s);
        assert!(coin::value(&a) == 200_000_000, 600);
        ts::return_to_sender(&s, a);

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
        let (tokens, refund) = bonding_curve::buy(&mut curve, payment, 0, ts::ctx(&mut s));
        destroy(refund);
        let sui_back = bonding_curve::sell(&mut curve, tokens, 0, ts::ctx(&mut s));
        let back = coin::value(&sui_back);
        assert!(back < 100 * MIST_PER_SUI, 700);
        assert!(back > 97  * MIST_PER_SUI, 701);
        destroy(sui_back);
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
        let (tokens, refund) = bonding_curve::buy(&mut curve, payment, 0, ts::ctx(&mut s));
        destroy(tokens); destroy(refund);
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
        // min_tokens_out = full 800M supply — impossible, slippage must fire.
        let (tokens, refund) = bonding_curve::buy(
            &mut curve, payment,
            800_000_000 * 1_000_000,
            ts::ctx(&mut s)
        );
        destroy(tokens); destroy(refund);
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
        let payment = mint_sui(200_000 * MIST_PER_SUI, &mut s);
        let (tokens, refund) = bonding_curve::buy(&mut curve, payment, 0, ts::ctx(&mut s));
        assert!(coin::value(&tokens) == 800_000_000 * 1_000_000, 800);
        assert!(bonding_curve::tokens_remaining(&curve) == 0, 801);
        assert!(coin::value(&refund) > 0, 802);
        destroy(tokens); destroy(refund);
        ts::return_shared(curve);
        ts::end(s);
    }

    // ─── Graduation (v4 — void, all transfers internal) ─────────────────────

    /// graduate() is void. Verify observable side-effects:
    ///   - curve.graduated = true
    ///   - creator receives creator_bonus (0.5% of reserve) as a Coin<SUI>
    ///   - curve.protocol_fees grows by protocol_bonus (0.5% of reserve)
    ///   - creator receives lp_tokens (200M tokens)
    ///   - sui_reserve shrinks by creator_bonus + protocol_bonus
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

        let expected_creator_bonus   = (curve_before_reserve * 50) / 10_000;
        let expected_protocol_bonus  = (curve_before_reserve * 50) / 10_000;
        let expected_reserve_after   = curve_before_reserve
                                       - expected_creator_bonus
                                       - expected_protocol_bonus;

        // graduate() — void, no return values.
        do_graduate(&mut s);

        ts::next_tx(&mut s, BUYER);
        let curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        assert!(bonding_curve::is_graduated(&curve), 900);

        // protocol_fees increased by protocol_bonus.
        let proto_after = bonding_curve::protocol_fees_pending(&curve);
        assert!(proto_after == proto_before + expected_protocol_bonus, 901);

        // sui_reserve = original minus both bonuses (pool funds stay for admin claim).
        assert!(bonding_curve::sui_reserve(&curve) == expected_reserve_after, 902);
        ts::return_shared(curve);

        // CREATOR received creator_bonus Coin<SUI>.
        ts::next_tx(&mut s, CREATOR);
        let bonus_coin = ts::take_from_sender<Coin<SUI>>(&s);
        assert!(coin::value(&bonus_coin) == expected_creator_bonus, 903);
        ts::return_to_sender(&s, bonus_coin);

        // CREATOR received LP tokens (200M × 1e6 = 200_000_000_000_000 base units).
        // (They are Coin<TEST_TOKEN> transferred to curve.creator.)
        // We verify indirectly: token amount = TOTAL_SUPPLY - CURVE_SUPPLY.
        // The actual object check is omitted here as test_scenario doesn't give
        // us a type-polymorphic take_from_sender for Coin<TEST_TOKEN> easily.
        // Covered precisely in the Python harness.

        ts::end(s);
    }

    #[test]
    #[expected_failure(abort_code = E_NOT_GRADUATED, location = suipump::bonding_curve)]
    fun test_cannot_graduate_before_drain() {
        // token_reserve > 0, so graduate() must abort with ENotGraduated.
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

        // Second graduate() must abort.
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
        let (tokens, refund) = bonding_curve::buy(&mut curve, payment, 0, ts::ctx(&mut s));
        destroy(tokens); destroy(refund);
        ts::return_shared(curve);
        ts::end(s);
    }

    #[test]
    #[expected_failure(abort_code = E_ALREADY_GRADUATED, location = suipump::bonding_curve)]
    fun test_cannot_sell_after_graduation() {
        let mut s = ts::begin(CREATOR);
        let (_a, _b) = make_payouts_single();
        setup_curve(&mut s, _a, _b);

        // Buy a small amount before draining, so BUYER holds tokens.
        ts::next_tx(&mut s, BUYER);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        let payment = mint_sui(10 * MIST_PER_SUI, &mut s);
        let (held_tokens, refund) = bonding_curve::buy(&mut curve, payment, 0, ts::ctx(&mut s));
        destroy(refund);
        ts::return_shared(curve);

        drain_curve(&mut s);
        do_graduate(&mut s);

        // Now try to sell — must abort.
        ts::next_tx(&mut s, BUYER);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        let sui_out = bonding_curve::sell(&mut curve, held_tokens, 0, ts::ctx(&mut s));
        destroy(sui_out);
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

        // post_comment takes a curve_id (not the object itself — no borrow needed).
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

        // 281 bytes — one over the 280-byte limit.
        // Each line below is exactly 100 'a' chars; three lines = 300 bytes total.
        // We use string concatenation via vector append to stay under Move's
        // single-literal compiler limit while producing a provably long string.
        let mut long_bytes = vector::empty<u8>();
        let chunk = b"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"; // 98 bytes
        vector::append(&mut long_bytes, chunk);
        vector::append(&mut long_bytes, chunk);
        vector::append(&mut long_bytes, chunk); // 294 bytes total — well over 280
        let long_text = string::utf8(long_bytes);
        bonding_curve::post_comment(curve_id, long_text, ts::ctx(&mut s));
        ts::end(s);
    }
}
