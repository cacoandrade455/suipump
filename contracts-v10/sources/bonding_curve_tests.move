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
///   - V13: buy() takes price_cfg: &PriceConfig (protocol-published, AdminCap-set).
///     The V9 caller-supplied sui_price_scaled: u64 is GONE (audit F-2).
///   - F-10: buy_for_testing is a ZERO-LOGIC delegator to the real buy() and
///     takes the same &PriceConfig. Every buy in this file executes the
///     production pricing/fee/graduation path; tests call init_for_testing
///     first so the shared PriceConfig exists. Graduation tests reach REAL
///     thresholds (BASE_GRAD_MIST 9,000 SUI unset, or the dampened value for a
///     published price) instead of forced 500-SUI ones.
///   - New v9 tests: oracle fallback, grad threshold clip, inline graduation,
///     tail refund conservation
///   - All v8 tests preserved (expectations re-derived from production math
///     where the pre-F-5/F-10 shadow had baked the bug in as the spec)
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
    use std::unit_test::destroy;
    use sui::clock;
    use sui::transfer;
    use std::ascii;
    use std::string;

    use suipump::bonding_curve::{Self, Curve, CreatorCap, AdminCap, PriceConfig, PriceRelayerCap};

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
    const E_CREATOR_STILL_ACTIVE:     u64 = 40;
    const E_LP_ALREADY_CLAIMED:       u64 = 51;
    const E_RESERVE_TOO_LOW:          u64 = 52;
    const E_PRICE_CONFIG_EXISTS:      u64 = 54;
    // V13 escrow-weighted CTO error codes (mirror bonding_curve)
    const E_CTO_ON_COOLDOWN:          u64 = 41;
    const E_BELOW_NOMINATE_THRESHOLD: u64 = 42;
    const E_CTO_VOTE_CLOSED:          u64 = 45;
    const E_CTO_VOTE_STILL_OPEN:      u64 = 46;
    const E_CTO_ALREADY_RESOLVED:     u64 = 48;
    const E_CTO_PROPOSAL_LIVE:        u64 = 55;
    const E_CTO_BELOW_MIN_VOTE:       u64 = 56;
    const E_CTO_NOT_VOTER:            u64 = 57;
    const E_CTO_NOT_RESOLVED:         u64 = 58;
    const E_CTO_ZERO_CIRCULATING:     u64 = 59;

    const LP_SUPPLY_ATOMIC:           u64 = 200_000_000 * 1_000_000; // 1B total - 800M curve

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
    /// F-10: routes through the REAL buy() (buy_for_testing is a zero-logic
    /// delegator), so callers must run init_for_testing first - the shared
    /// PriceConfig is taken here. The price stays UNSET, so the threshold is
    /// BASE_GRAD_MIST (9,000 SUI); a 50,000 SUI buy still drains all 800M via
    /// Path A (needed swap = 12,802.93 SUI) and graduates inline.
    fun drain_curve(scenario: &mut Scenario) {
        ts::next_tx(scenario, BUYER);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(scenario);
        let cfg = ts::take_shared<PriceConfig>(scenario);
        let payment = mint_sui(50_000 * MIST_PER_SUI, scenario);
        let clk = clock::create_for_testing(ts::ctx(scenario));
        let (tokens, refund) = bonding_curve::buy_for_testing(
            &mut curve, payment, 0,
            option::none(),
            &cfg,
            &clk,
            ts::ctx(scenario)
        );
        destroy(tokens);
        destroy(refund);
        clock::destroy_for_testing(clk);
        ts::return_shared(cfg);
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
        bonding_curve::init_for_testing(ts::ctx(&mut s));
        let (a, b) = make_payouts_three();
        setup_curve(&mut s, a, b);

        ts::next_tx(&mut s, BUYER);
        {
            let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
            let cfg = ts::take_shared<PriceConfig>(&s);
            let payment = mint_sui(100 * MIST_PER_SUI, &mut s);
            let clk = clock::create_for_testing(ts::ctx(&mut s));
            let (tokens, refund) = bonding_curve::buy_for_testing(
                &mut curve, payment, 0, option::none(), &cfg, &clk, ts::ctx(&mut s)
            );
            destroy(tokens);
            destroy(refund);
            clock::destroy_for_testing(clk);
            ts::return_shared(cfg);
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
        bonding_curve::init_for_testing(ts::ctx(&mut s));
        let (_a, _b) = make_payouts_single();
        setup_curve(&mut s, _a, _b);

        ts::next_tx(&mut s, BUYER);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        let cfg = ts::take_shared<PriceConfig>(&s);
        let payment = mint_sui(100 * MIST_PER_SUI, &mut s);
        let clk = clock::create_for_testing(ts::ctx(&mut s));
        let (tokens, refund) = bonding_curve::buy_for_testing(
            &mut curve, payment, 0, option::none(), &cfg, &clk, ts::ctx(&mut s)
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
        ts::return_shared(cfg);
        ts::return_shared(curve);
        ts::end(s);
    }

    #[test]
    #[expected_failure(abort_code = E_ZERO_AMOUNT, location = suipump::bonding_curve)]
    fun test_buy_rejects_zero_amount() {
        let mut s = ts::begin(CREATOR);
        bonding_curve::init_for_testing(ts::ctx(&mut s));
        let (_a, _b) = make_payouts_single();
        setup_curve(&mut s, _a, _b);

        ts::next_tx(&mut s, BUYER);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        let cfg = ts::take_shared<PriceConfig>(&s);
        let payment = mint_sui(0, &mut s);
        let clk = clock::create_for_testing(ts::ctx(&mut s));
        let (tokens, refund) = bonding_curve::buy_for_testing(
            &mut curve, payment, 0, option::none(), &cfg, &clk, ts::ctx(&mut s)
        );
        destroy(tokens);
        destroy(refund);
        clock::destroy_for_testing(clk);
        ts::return_shared(cfg);
        ts::return_shared(curve);
        ts::end(s);
    }

    #[test]
    #[expected_failure(abort_code = E_SLIPPAGE_EXCEEDED, location = suipump::bonding_curve)]
    fun test_slippage_protection_triggers() {
        let mut s = ts::begin(CREATOR);
        bonding_curve::init_for_testing(ts::ctx(&mut s));
        let (_a, _b) = make_payouts_single();
        setup_curve(&mut s, _a, _b);

        ts::next_tx(&mut s, BUYER);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        let cfg = ts::take_shared<PriceConfig>(&s);
        let payment = mint_sui(10 * MIST_PER_SUI, &mut s);
        let clk = clock::create_for_testing(ts::ctx(&mut s));
        let (tokens, refund) = bonding_curve::buy_for_testing(
            &mut curve, payment, 999_999_999_999_999, option::none(), &cfg, &clk, ts::ctx(&mut s)
        );
        destroy(tokens);
        destroy(refund);
        clock::destroy_for_testing(clk);
        ts::return_shared(cfg);
        ts::return_shared(curve);
        ts::end(s);
    }

    #[test]
    fun test_whale_buy_clips_and_refunds() {
        let mut s = ts::begin(CREATOR);
        bonding_curve::init_for_testing(ts::ctx(&mut s));
        let (_a, _b) = make_payouts_single();
        setup_curve(&mut s, _a, _b);

        ts::next_tx(&mut s, BUYER);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        let cfg = ts::take_shared<PriceConfig>(&s);
        let payment = mint_sui(100_000 * MIST_PER_SUI, &mut s);
        let clk = clock::create_for_testing(ts::ctx(&mut s));
        let (tokens, refund) = bonding_curve::buy_for_testing(
            &mut curve, payment, 0, option::none(), &cfg, &clk, ts::ctx(&mut s)
        );
        assert!(coin::value(&tokens) == 800_000_000 * 1_000_000, 800);
        assert!(coin::value(&refund) > 0, 801);
        destroy(tokens);
        destroy(refund);
        clock::destroy_for_testing(clk);
        ts::return_shared(cfg);
        ts::return_shared(curve);
        ts::end(s);
    }

    // ─── Anti-bot ────────────────────────────────────────────────────────────

    #[test]
    fun test_creator_can_buy_during_antibot_window() {
        let mut s = ts::begin(CREATOR);
        bonding_curve::init_for_testing(ts::ctx(&mut s));
        let clk = setup_curve_with_antibot(&mut s, 30, 0);

        ts::next_tx(&mut s, CREATOR);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        let cfg = ts::take_shared<PriceConfig>(&s);
        let payment = mint_sui(10 * MIST_PER_SUI, &mut s);
        let (tokens, refund) = bonding_curve::buy_for_testing(
            &mut curve, payment, 0, option::none(), &cfg, &clk, ts::ctx(&mut s)
        );
        destroy(tokens);
        destroy(refund);
        ts::return_shared(cfg);
        ts::return_shared(curve);
        clock::destroy_for_testing(clk);
        ts::end(s);
    }

    #[test]
    #[expected_failure(abort_code = E_ANTI_BOT_BLOCKED, location = suipump::bonding_curve)]
    fun test_non_creator_blocked_during_antibot_window() {
        let mut s = ts::begin(CREATOR);
        bonding_curve::init_for_testing(ts::ctx(&mut s));
        let clk = setup_curve_with_antibot(&mut s, 30, 0);

        ts::next_tx(&mut s, BUYER);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        let cfg = ts::take_shared<PriceConfig>(&s);
        let payment = mint_sui(10 * MIST_PER_SUI, &mut s);
        let (tokens, refund) = bonding_curve::buy_for_testing(
            &mut curve, payment, 0, option::none(), &cfg, &clk, ts::ctx(&mut s)
        );
        destroy(tokens);
        destroy(refund);
        ts::return_shared(cfg);
        ts::return_shared(curve);
        clock::destroy_for_testing(clk);
        ts::end(s);
    }

    #[test]
    fun test_buyer_can_buy_after_antibot_window_expires() {
        let mut s = ts::begin(CREATOR);
        bonding_curve::init_for_testing(ts::ctx(&mut s));
        let mut clk = setup_curve_with_antibot(&mut s, 15, 0);
        clock::set_for_testing(&mut clk, 16_000);

        ts::next_tx(&mut s, BUYER);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        let cfg = ts::take_shared<PriceConfig>(&s);
        let payment = mint_sui(10 * MIST_PER_SUI, &mut s);
        let (tokens, refund) = bonding_curve::buy_for_testing(
            &mut curve, payment, 0, option::none(), &cfg, &clk, ts::ctx(&mut s)
        );
        destroy(tokens);
        destroy(refund);
        ts::return_shared(cfg);
        ts::return_shared(curve);
        clock::destroy_for_testing(clk);
        ts::end(s);
    }

    #[test]
    fun test_no_antibot_allows_all_buyers_immediately() {
        let mut s = ts::begin(CREATOR);
        bonding_curve::init_for_testing(ts::ctx(&mut s));
        let clk = setup_curve_with_antibot(&mut s, 0, 0);

        ts::next_tx(&mut s, BUYER);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        let cfg = ts::take_shared<PriceConfig>(&s);
        let payment = mint_sui(10 * MIST_PER_SUI, &mut s);
        let (tokens, refund) = bonding_curve::buy_for_testing(
            &mut curve, payment, 0, option::none(), &cfg, &clk, ts::ctx(&mut s)
        );
        destroy(tokens);
        destroy(refund);
        ts::return_shared(cfg);
        ts::return_shared(curve);
        clock::destroy_for_testing(clk);
        ts::end(s);
    }

    // ─── v7: Fee split — airdrop bucket ──────────────────────────────────────

    #[test]
    fun test_buy_no_referral_splits_protocol_bucket_in_half() {
        let mut s = ts::begin(CREATOR);
        bonding_curve::init_for_testing(ts::ctx(&mut s));
        let (_a, _b) = make_payouts_single();
        setup_curve(&mut s, _a, _b);

        ts::next_tx(&mut s, BUYER);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        let cfg = ts::take_shared<PriceConfig>(&s);
        let proto_before   = bonding_curve::protocol_fees(&curve);
        let airdrop_before = bonding_curve::airdrop_fees(&curve);

        // V13: BASE_GRAD_MIST dropped 12,305 -> 9,000 SUI. A 10,000 SUI buy
        // now CLIPS at the threshold and graduates inline, and graduation adds
        // a protocol-ONLY bonus (do_graduate_inline: PROTOCOL_GRAD_BONUS_BPS)
        // that contaminates any fee-split measurement. Keep this buy well
        // below the threshold so it stays a plain, non-graduating buy.
        let payment = mint_sui(1_000 * MIST_PER_SUI, &mut s);
        let clk = clock::create_for_testing(ts::ctx(&mut s));
        let (tokens, refund) = bonding_curve::buy_for_testing(
            &mut curve, payment, 0, option::none(), &cfg, &clk, ts::ctx(&mut s)
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
        ts::return_shared(cfg);
        ts::return_shared(curve);
        ts::end(s);
    }

    #[test]
    fun test_buy_with_referral_pays_referrer() {
        let mut s = ts::begin(CREATOR);
        bonding_curve::init_for_testing(ts::ctx(&mut s));
        let (_a, _b) = make_payouts_single();
        setup_curve(&mut s, _a, _b);

        ts::next_tx(&mut s, BUYER);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        let cfg = ts::take_shared<PriceConfig>(&s);
        // V13: BASE_GRAD_MIST dropped 12,305 -> 9,000 SUI. A 10,000 SUI buy
        // now CLIPS at the threshold and graduates inline, and graduation adds
        // a protocol-ONLY bonus (do_graduate_inline: PROTOCOL_GRAD_BONUS_BPS)
        // that contaminates any fee-split measurement. Keep this buy well
        // below the threshold so it stays a plain, non-graduating buy.
        let payment = mint_sui(1_000 * MIST_PER_SUI, &mut s);
        let clk = clock::create_for_testing(ts::ctx(&mut s));
        let (tokens, refund) = bonding_curve::buy_for_testing(
            &mut curve, payment, 0, option::some(REFERRER), &cfg, &clk, ts::ctx(&mut s)
        );
        destroy(tokens);
        destroy(refund);
        clock::destroy_for_testing(clk);
        ts::return_shared(cfg);
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
        bonding_curve::init_for_testing(ts::ctx(&mut s));
        let (_a, _b) = make_payouts_single();
        setup_curve(&mut s, _a, _b);

        ts::next_tx(&mut s, BUYER);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        let cfg = ts::take_shared<PriceConfig>(&s);
        let payment = mint_sui(10 * MIST_PER_SUI, &mut s);
        let clk = clock::create_for_testing(ts::ctx(&mut s));
        let (tokens, refund) = bonding_curve::buy_for_testing(
            &mut curve, payment, 0, option::some(CREATOR), &cfg, &clk, ts::ctx(&mut s)
        );
        destroy(tokens);
        destroy(refund);
        clock::destroy_for_testing(clk);
        ts::return_shared(cfg);
        ts::return_shared(curve);
        ts::end(s);
    }

    #[test]
    #[expected_failure(abort_code = E_SELF_REFERRAL, location = suipump::bonding_curve)]
    fun test_sell_self_referral_rejected() {
        let mut s = ts::begin(CREATOR);
        bonding_curve::init_for_testing(ts::ctx(&mut s));
        let (_a, _b) = make_payouts_single();
        setup_curve(&mut s, _a, _b);

        ts::next_tx(&mut s, BUYER);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        let cfg = ts::take_shared<PriceConfig>(&s);
        let payment = mint_sui(100 * MIST_PER_SUI, &mut s);
        let clk = clock::create_for_testing(ts::ctx(&mut s));
        let (tokens, refund) = bonding_curve::buy_for_testing(
            &mut curve, payment, 0, option::none(), &cfg, &clk, ts::ctx(&mut s)
        );
        destroy(refund);
        let sui_back = bonding_curve::sell(
            &mut curve, tokens, 0, option::some(CREATOR), ts::ctx(&mut s)
        );
        destroy(sui_back);
        clock::destroy_for_testing(clk);
        ts::return_shared(cfg);
        ts::return_shared(curve);
        ts::end(s);
    }

    #[test]
    fun test_sell_with_referral_pays_referrer() {
        let mut s = ts::begin(CREATOR);
        bonding_curve::init_for_testing(ts::ctx(&mut s));
        let (_a, _b) = make_payouts_single();
        setup_curve(&mut s, _a, _b);

        ts::next_tx(&mut s, BUYER);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        let cfg = ts::take_shared<PriceConfig>(&s);
        let payment = mint_sui(1_000 * MIST_PER_SUI, &mut s);
        let clk = clock::create_for_testing(ts::ctx(&mut s));
        let (tokens, refund) = bonding_curve::buy_for_testing(
            &mut curve, payment, 0, option::none(), &cfg, &clk, ts::ctx(&mut s)
        );
        destroy(refund);
        let sui_back = bonding_curve::sell(
            &mut curve, tokens, 0, option::some(REFERRER), ts::ctx(&mut s)
        );
        destroy(sui_back);
        clock::destroy_for_testing(clk);
        ts::return_shared(cfg);
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
        bonding_curve::init_for_testing(ts::ctx(&mut s));
        let (_a, _b) = make_payouts_single();
        setup_curve(&mut s, _a, _b);

        ts::next_tx(&mut s, BUYER);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        let cfg = ts::take_shared<PriceConfig>(&s);
        assert!(bonding_curve::lp_fees_accumulated(&curve) == 0, 1300);

        let payment = mint_sui(1_000 * MIST_PER_SUI, &mut s);
        let clk = clock::create_for_testing(ts::ctx(&mut s));
        let (tokens, refund) = bonding_curve::buy_for_testing(
            &mut curve, payment, 0, option::none(), &cfg, &clk, ts::ctx(&mut s)
        );
        destroy(tokens);
        destroy(refund);

        assert!(bonding_curve::lp_fees_accumulated(&curve) > 0, 1301);
        clock::destroy_for_testing(clk);
        ts::return_shared(cfg);
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

        let cfg = ts::take_shared<PriceConfig>(&s);
        let payment = mint_sui(10 * MIST_PER_SUI, &mut s);
        let clk = clock::create_for_testing(ts::ctx(&mut s));
        let (tokens, refund) = bonding_curve::buy_for_testing(
            &mut curve, payment, 0, option::none(), &cfg, &clk, ts::ctx(&mut s)
        );
        destroy(tokens);
        destroy(refund);
        clock::destroy_for_testing(clk);
        ts::return_shared(cfg);
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
        let cfg = ts::take_shared<PriceConfig>(&s);
        let payment = mint_sui(100 * MIST_PER_SUI, &mut s);
        let clk = clock::create_for_testing(ts::ctx(&mut s));
        let (tokens, refund) = bonding_curve::buy_for_testing(
            &mut curve, payment, 0, option::none(), &cfg, &clk, ts::ctx(&mut s)
        );
        destroy(refund);
        clock::destroy_for_testing(clk);
        ts::return_shared(cfg);
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

        let cfg = ts::take_shared<PriceConfig>(&s);
        let payment = mint_sui(10 * MIST_PER_SUI, &mut s);
        let clk = clock::create_for_testing(ts::ctx(&mut s));
        let (tokens, refund) = bonding_curve::buy_for_testing(
            &mut curve, payment, 0, option::none(), &cfg, &clk, ts::ctx(&mut s)
        );
        destroy(tokens);
        destroy(refund);
        clock::destroy_for_testing(clk);
        ts::return_shared(cfg);
        ts::return_shared(curve);
        ts::end(s);
    }

    // ─── Graduation ──────────────────────────────────────────────────────────

    #[test]
    fun test_graduation_side_effects() {
        // In V9, inline graduation fires during drain_curve()'s buy() call.
        // We verify state BEFORE the draining buy, then check state after.
        let mut s = ts::begin(CREATOR);
        bonding_curve::init_for_testing(ts::ctx(&mut s));
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
        // drain_curve graduates inline; the standalone call below is the
        // SECOND graduation attempt and must abort EAlreadyGraduated.
        let mut s = ts::begin(CREATOR);
        bonding_curve::init_for_testing(ts::ctx(&mut s));
        let (_a, _b) = make_payouts_single();
        setup_curve(&mut s, _a, _b);
        drain_curve(&mut s);

        ts::next_tx(&mut s, BUYER);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        bonding_curve::graduate_for_testing(&mut curve, ts::ctx(&mut s));
        ts::return_shared(curve);
        ts::end(s);
    }

    #[test]
    #[expected_failure(abort_code = E_ALREADY_GRADUATED, location = suipump::bonding_curve)]
    fun test_cannot_buy_after_graduation() {
        // drain_curve graduates inline; the buy below must be the aborting call.
        let mut s = ts::begin(CREATOR);
        bonding_curve::init_for_testing(ts::ctx(&mut s));
        let (_a, _b) = make_payouts_single();
        setup_curve(&mut s, _a, _b);
        drain_curve(&mut s);

        ts::next_tx(&mut s, BUYER);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        let cfg = ts::take_shared<PriceConfig>(&s);
        let payment = mint_sui(10 * MIST_PER_SUI, &mut s);
        let clk = clock::create_for_testing(ts::ctx(&mut s));
        let (tokens, refund) = bonding_curve::buy_for_testing(
            &mut curve, payment, 0, option::none(), &cfg, &clk, ts::ctx(&mut s)
        );
        destroy(tokens);
        destroy(refund);
        clock::destroy_for_testing(clk);
        ts::return_shared(cfg);
        ts::return_shared(curve);
        ts::end(s);
    }

    #[test]
    #[expected_failure(abort_code = E_ALREADY_GRADUATED, location = suipump::bonding_curve)]
    fun test_cannot_sell_after_graduation() {
        // drain_curve graduates inline; the sell below must be the aborting call.
        let mut s = ts::begin(CREATOR);
        bonding_curve::init_for_testing(ts::ctx(&mut s));
        let (_a, _b) = make_payouts_single();
        setup_curve(&mut s, _a, _b);

        ts::next_tx(&mut s, BUYER);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        let cfg = ts::take_shared<PriceConfig>(&s);
        let payment = mint_sui(100 * MIST_PER_SUI, &mut s);
        let clk = clock::create_for_testing(ts::ctx(&mut s));
        let (tokens, refund) = bonding_curve::buy_for_testing(
            &mut curve, payment, 0, option::none(), &cfg, &clk, ts::ctx(&mut s)
        );
        destroy(refund);
        clock::destroy_for_testing(clk);
        ts::return_shared(cfg);
        ts::return_shared(curve);

        drain_curve(&mut s);

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
        assert!(bonding_curve::graduated(&curve), 1000);

        let reserve_before = bonding_curve::sui_reserve(&curve);
        assert!(reserve_before > 0, 1001);

        // Actually call the function this test is named after.
        let (sui_coin, lp_coin) = bonding_curve::claim_graduation_funds<TEST_TOKEN>(
            &admin_cap, &mut curve, ts::ctx(&mut s)
        );

        // Reserve fully drained, returned SUI == pre-claim reserve.
        assert!(bonding_curve::sui_reserve(&curve) == 0, 1002);
        assert!(coin::value(&sui_coin) == reserve_before, 1003);
        // 200M LP minted fresh at graduation.
        assert!(coin::value(&lp_coin) == LP_SUPPLY_ATOMIC, 1004);

        destroy(sui_coin);
        destroy(lp_coin);
        ts::return_to_sender(&s, admin_cap);
        ts::return_shared(curve);
        ts::end(s);
    }

    #[test]
    #[expected_failure(abort_code = E_NOT_GRADUATED, location = suipump::bonding_curve)]
    fun test_claim_graduation_funds_fails_if_not_graduated() {
        // A non-graduated curve must not release the reserve or mint the LP.
        let mut s = ts::begin(CREATOR);
        bonding_curve::init_for_testing(ts::ctx(&mut s));

        ts::next_tx(&mut s, CREATOR);
        let (_a, _b) = make_payouts_single();
        setup_curve(&mut s, _a, _b);

        // Small buy — does NOT graduate the curve.
        ts::next_tx(&mut s, BUYER);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        let cfg = ts::take_shared<PriceConfig>(&s);
        let payment = mint_sui(10 * MIST_PER_SUI, &mut s);
        let clk = clock::create_for_testing(ts::ctx(&mut s));
        let (tokens, refund) = bonding_curve::buy_for_testing(
            &mut curve, payment, 0, option::none(), &cfg, &clk, ts::ctx(&mut s)
        );
        assert!(!bonding_curve::graduated(&curve), 999);
        destroy(tokens); destroy(refund);
        clock::destroy_for_testing(clk);
        ts::return_shared(cfg);
        ts::return_shared(curve);

        // Claim on the non-graduated curve — expected to abort ENotGraduated.
        ts::next_tx(&mut s, CREATOR);
        let admin_cap = ts::take_from_sender<AdminCap>(&s);
        let mut curve2 = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        let (sui_coin, lp_coin) = bonding_curve::claim_graduation_funds<TEST_TOKEN>(
            &admin_cap, &mut curve2, ts::ctx(&mut s)
        );
        destroy(sui_coin); destroy(lp_coin);
        ts::return_to_sender(&s, admin_cap);
        ts::return_shared(curve2);
        ts::end(s);
    }

    #[test]
    #[expected_failure(abort_code = E_LP_ALREADY_CLAIMED, location = suipump::bonding_curve)]
    fun test_claim_graduation_funds_twice_aborts() {
        // One-shot guard: the reserve is emptied on the first claim and never
        // refills, so a second claim aborts BEFORE minting a second LP tranche.
        let mut s = ts::begin(CREATOR);
        bonding_curve::init_for_testing(ts::ctx(&mut s));

        ts::next_tx(&mut s, CREATOR);
        let (_a, _b) = make_payouts_single();
        setup_curve(&mut s, _a, _b);
        drain_curve(&mut s);

        ts::next_tx(&mut s, CREATOR);
        let admin_cap = ts::take_from_sender<AdminCap>(&s);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);

        let (sui1, lp1) = bonding_curve::claim_graduation_funds<TEST_TOKEN>(
            &admin_cap, &mut curve, ts::ctx(&mut s)
        );
        destroy(sui1); destroy(lp1);

        // Second claim — expected to abort ELpAlreadyClaimed.
        let (sui2, lp2) = bonding_curve::claim_graduation_funds<TEST_TOKEN>(
            &admin_cap, &mut curve, ts::ctx(&mut s)
        );
        destroy(sui2); destroy(lp2);
        ts::return_to_sender(&s, admin_cap);
        ts::return_shared(curve);
        ts::end(s);
    }

    #[test]
    #[expected_failure(abort_code = E_RESERVE_TOO_LOW, location = suipump::bonding_curve)]
    fun test_claim_graduation_funds_rejects_trivial_reserve() {
        // F-2 backstop: a curve graduated on a trivially small reserve (the shape
        // an oracle-manipulation attack produces) must NOT be able to mint 200M LP.
        // F-10: buy() can no longer be fed a forged threshold (it resolves from
        // the shared PriceConfig), so the trivial graduation is staged on the
        // STANDALONE graduate() gate instead, which reads the STORED
        // current_grad_threshold. A real 5 SUI buy funds the reserve first:
        //   fee = 1% = 50_000_000; swap = 4_950_000_000; lp_fee = 5_000_000
        //   reserve = swap + lp_fee = 4_955_000_000 (F-5)   -- far below the
        //   500 SUI MIN_GRAD_RESERVE_MIST floor, above the forced 3 SUI gate.
        let mut s = ts::begin(CREATOR);
        bonding_curve::init_for_testing(ts::ctx(&mut s));

        ts::next_tx(&mut s, CREATOR);
        let (_a, _b) = make_payouts_single();
        setup_curve(&mut s, _a, _b);

        ts::next_tx(&mut s, BUYER);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        let cfg = ts::take_shared<PriceConfig>(&s);
        let payment = mint_sui(5 * MIST_PER_SUI, &mut s);
        let clk = clock::create_for_testing(ts::ctx(&mut s));
        let (tokens, refund) = bonding_curve::buy_for_testing(
            &mut curve, payment, 0, option::none(), &cfg, &clk, ts::ctx(&mut s)
        );
        destroy(tokens); destroy(refund);
        clock::destroy_for_testing(clk);
        // The real buy did NOT graduate (4.955 SUI << the 9,000 SUI fallback
        // threshold); the standalone gate fires on the forced stored value.
        assert!(!bonding_curve::graduated(&curve), 1009);
        assert!(bonding_curve::sui_reserve(&curve) == 4_955_000_000, 1012);
        bonding_curve::set_grad_threshold_for_testing(&mut curve, 3 * MIST_PER_SUI);
        bonding_curve::graduate_for_testing(&mut curve, ts::ctx(&mut s));
        assert!(bonding_curve::graduated(&curve), 1010);
        assert!(bonding_curve::sui_reserve(&curve) < 500 * MIST_PER_SUI, 1011);
        ts::return_shared(cfg);
        ts::return_shared(curve);

        // Claim on the trivially-funded graduated curve — expect EReserveTooLow.
        ts::next_tx(&mut s, CREATOR);
        let admin_cap = ts::take_from_sender<AdminCap>(&s);
        let mut curve2 = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        let (sui_coin, lp_coin) = bonding_curve::claim_graduation_funds<TEST_TOKEN>(
            &admin_cap, &mut curve2, ts::ctx(&mut s)
        );
        destroy(sui_coin); destroy(lp_coin);
        ts::return_to_sender(&s, admin_cap);
        ts::return_shared(curve2);
        ts::end(s);
    }

    #[test]
    #[expected_failure(abort_code = E_NOT_GRADUATED, location = suipump::bonding_curve)]
    fun test_graduate_rejects_zero_threshold_fresh_curve() {
        // F-2 (self-audit): a fresh curve has current_grad_threshold == 0 and a
        // full token_reserve, so without the `threshold > 0` guard graduate()
        // would pass (sui_reserve 0 >= 0) and permanently brick it. This exercises
        // graduate_for_testing, whose guard production graduate() now mirrors
        // (production graduate() itself needs a CoinMetadata not constructible in
        // the test VM). Expected to abort ENotGraduated.
        let mut s = ts::begin(CREATOR);
        let (_a, _b) = make_payouts_single();
        setup_curve(&mut s, _a, _b);

        ts::next_tx(&mut s, BUYER);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        assert!(bonding_curve::current_grad_threshold(&curve) == 0, 1030);
        bonding_curve::graduate_for_testing(&mut curve, ts::ctx(&mut s));
        ts::return_shared(curve);
        ts::end(s);
    }

    // ─── V13: protocol-published price (replaces the F-2 caller-price clamp) ──

    /// The V9 caller-supplied sui_price_scaled is GONE, so the clamp that used to
    /// blunt a hostile price is gone with it. These tests drive the buy() oracle
    /// path directly. (F-10 CLOSED: buy_for_testing is now a zero-logic delegator
    /// to buy(), so every buy in this file - not just these - executes
    /// resolve_grad_threshold/dampened_grad_threshold. The old shadow read
    /// current_grad_threshold directly, which is what hid the F-4 31.6x error
    /// through 55 green runs.)

    #[test]
    fun test_price_unset_falls_back_to_base_grad() {
        let mut s = ts::begin(CREATOR);
        bonding_curve::init_for_testing(ts::ctx(&mut s));

        ts::next_tx(&mut s, CREATOR);
        let (_a, _b) = make_payouts_single();
        setup_curve(&mut s, _a, _b);

        ts::next_tx(&mut s, BUYER);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        let cfg = ts::take_shared<PriceConfig>(&s);
        let clk = clock::create_for_testing(ts::ctx(&mut s));

        // PriceConfig starts UNSET (0). buy() must fall back to the static
        // BASE_GRAD_MIST and must NOT abort: launching before the relayer runs
        // is safe, graduation just runs undampened.
        let payment = mint_sui(1 * MIST_PER_SUI, &mut s);
        let (tokens, refund) = bonding_curve::buy<TEST_TOKEN>(
            &mut curve, payment, 0, option::none(), &cfg, &clk, ts::ctx(&mut s)
        );
        destroy(tokens); destroy(refund);
        assert!(bonding_curve::current_grad_threshold(&curve) == 9_000 * MIST_PER_SUI, 2000);

        clock::destroy_for_testing(clk);
        ts::return_shared(cfg);
        ts::return_shared(curve);
        ts::end(s);
    }

    #[test]
    fun test_published_price_dampens_threshold() {
        let mut s = ts::begin(CREATOR);
        bonding_curve::init_for_testing(ts::ctx(&mut s));

        ts::next_tx(&mut s, CREATOR);
        let (_a, _b) = make_payouts_single();
        setup_curve(&mut s, _a, _b);

        // Publish $1.00 -> threshold is EXACTLY BASE_GRAD_MIST by definition
        // (BASE is the anchor the sqrt pivots on: sqrt(1000)/sqrt(1000) == 1).
        ts::next_tx(&mut s, CREATOR);
        // E-1: set_sui_price is now gated on PriceRelayerCap, not AdminCap. This
        // local is the price-relayer cap (minted to CREATOR by init_for_testing).
        let admin = ts::take_from_sender<PriceRelayerCap>(&s);
        let mut cfg = ts::take_shared<PriceConfig>(&s);
        let clk = clock::create_for_testing(ts::ctx(&mut s));
        bonding_curve::set_sui_price(&admin, &mut cfg, 1000, &clk);
        assert!(bonding_curve::price_scaled(&cfg) == 1000, 2010);

        ts::next_tx(&mut s, BUYER);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        let payment = mint_sui(1 * MIST_PER_SUI, &mut s);
        let (tokens, refund) = bonding_curve::buy<TEST_TOKEN>(
            &mut curve, payment, 0, option::none(), &cfg, &clk, ts::ctx(&mut s)
        );
        destroy(tokens); destroy(refund);
        assert!(bonding_curve::current_grad_threshold(&curve) == 9_000_000_000_000, 2011);

        // Publish $0.75 -> threshold RISES (cheaper SUI, dearer in SUI terms).
        // Exact integer math: 9e12 * isqrt(1e9) / isqrt(7.5e8)
        //                   = 9e12 * 31622 / 27386 = 10,392,098,152,340
        bonding_curve::set_sui_price(&admin, &mut cfg, 750, &clk);
        let payment2 = mint_sui(1 * MIST_PER_SUI, &mut s);
        let (t2, r2) = bonding_curve::buy<TEST_TOKEN>(
            &mut curve, payment2, 0, option::none(), &cfg, &clk, ts::ctx(&mut s)
        );
        destroy(t2); destroy(r2);
        assert!(bonding_curve::current_grad_threshold(&curve) == 10_392_098_152_340, 2012);

        // Publish $10.00 -> threshold FALLS to 2,845.98 SUI. This is the whole
        // point of the dampener: a 13x SUI move produces a 3.6x mcap move, not
        // 13x. Without it, $10 SUI would need a ~$512k mcap to graduate.
        bonding_curve::set_sui_price(&admin, &mut cfg, 10000, &clk);
        let payment3 = mint_sui(1 * MIST_PER_SUI, &mut s);
        let (t3, r3) = bonding_curve::buy<TEST_TOKEN>(
            &mut curve, payment3, 0, option::none(), &cfg, &clk, ts::ctx(&mut s)
        );
        destroy(t3); destroy(r3);
        assert!(bonding_curve::current_grad_threshold(&curve) == 2_845_980_000_000, 2013);

        clock::destroy_for_testing(clk);
        // Taken from CREATOR but the current tx sender is BUYER, so
        // return_to_sender would abort with ECantReturnObject (code 2).
        ts::return_to_address(CREATOR, admin);
        ts::return_shared(cfg);
        ts::return_shared(curve);
        ts::end(s);
    }

    #[test]
    fun test_stale_price_falls_back_and_never_aborts() {
        let mut s = ts::begin(CREATOR);
        bonding_curve::init_for_testing(ts::ctx(&mut s));

        ts::next_tx(&mut s, CREATOR);
        let (_a, _b) = make_payouts_single();
        setup_curve(&mut s, _a, _b);

        ts::next_tx(&mut s, CREATOR);
        // E-1: set_sui_price is now gated on PriceRelayerCap, not AdminCap. This
        // local is the price-relayer cap (minted to CREATOR by init_for_testing).
        let admin = ts::take_from_sender<PriceRelayerCap>(&s);
        let mut cfg = ts::take_shared<PriceConfig>(&s);
        let mut clk = clock::create_for_testing(ts::ctx(&mut s));

        // Publish $0.75 at t=0.
        bonding_curve::set_sui_price(&admin, &mut cfg, 750, &clk);

        // Jump past PRICE_MAX_AGE_MS (30 min). A dead relayer must NOT halt
        // trading - buy() falls back to BASE_GRAD_MIST rather than aborting.
        clock::set_for_testing(&mut clk, 30 * 60 * 1_000 + 1);

        ts::next_tx(&mut s, BUYER);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        let payment = mint_sui(1 * MIST_PER_SUI, &mut s);
        let (tokens, refund) = bonding_curve::buy<TEST_TOKEN>(
            &mut curve, payment, 0, option::none(), &cfg, &clk, ts::ctx(&mut s)
        );
        destroy(tokens); destroy(refund);
        assert!(bonding_curve::current_grad_threshold(&curve) == 9_000 * MIST_PER_SUI, 2020);

        clock::destroy_for_testing(clk);
        // Taken from CREATOR but the current tx sender is BUYER, so
        // return_to_sender would abort with ECantReturnObject (code 2).
        ts::return_to_address(CREATOR, admin);
        ts::return_shared(cfg);
        ts::return_shared(curve);
        ts::end(s);
    }

    #[test]
    #[expected_failure(abort_code = 43)] // EPriceOutOfBand
    fun test_set_sui_price_rejects_below_min() {
        let mut s = ts::begin(CREATOR);
        bonding_curve::init_for_testing(ts::ctx(&mut s));

        ts::next_tx(&mut s, CREATOR);
        // E-1: set_sui_price is now gated on PriceRelayerCap, not AdminCap. This
        // local is the price-relayer cap (minted to CREATOR by init_for_testing).
        let admin = ts::take_from_sender<PriceRelayerCap>(&s);
        let mut cfg = ts::take_shared<PriceConfig>(&s);
        let clk = clock::create_for_testing(ts::ctx(&mut s));

        // 99 = $0.099, below MIN_PRICE_SCALED. Bounds live at the SETTER so a
        // garbage source or a compromised cap cannot write it at all.
        bonding_curve::set_sui_price(&admin, &mut cfg, 99, &clk);

        clock::destroy_for_testing(clk);
        ts::return_to_sender(&s, admin);
        ts::return_shared(cfg);
        ts::end(s);
    }

    #[test]
    #[expected_failure(abort_code = 43)] // EPriceOutOfBand
    fun test_set_sui_price_rejects_above_max() {
        let mut s = ts::begin(CREATOR);
        bonding_curve::init_for_testing(ts::ctx(&mut s));

        ts::next_tx(&mut s, CREATOR);
        // E-1: set_sui_price is now gated on PriceRelayerCap, not AdminCap. This
        // local is the price-relayer cap (minted to CREATOR by init_for_testing).
        let admin = ts::take_from_sender<PriceRelayerCap>(&s);
        let mut cfg = ts::take_shared<PriceConfig>(&s);
        let clk = clock::create_for_testing(ts::ctx(&mut s));

        // 100_001 = $100.001, above MAX_PRICE_SCALED. u64::MAX would land here too.
        bonding_curve::set_sui_price(&admin, &mut cfg, 100_001, &clk);

        clock::destroy_for_testing(clk);
        ts::return_to_sender(&s, admin);
        ts::return_shared(cfg);
        ts::end(s);
    }

    // --- V13: create_price_config (upgrade bootstrap; upgrades never run init) ---

    #[test]
    fun test_create_price_config_shares_unset_config() {
        let mut s = ts::begin(CREATOR);
        bonding_curve::init_for_testing(ts::ctx(&mut s));

        ts::next_tx(&mut s, CREATOR);
        // Pin init's config id FIRST so we can prove the admin entrypoint shared
        // a DIFFERENT object (on an upgraded package only the admin-created one
        // would exist - init never re-runs on upgrade).
        let init_cfg_id = option::destroy_some(ts::most_recent_id_shared<PriceConfig>());
        let mut admin = ts::take_from_sender<AdminCap>(&s);
        bonding_curve::create_price_config(&mut admin, ts::ctx(&mut s));
        ts::return_to_sender(&s, admin);

        ts::next_tx(&mut s, CREATOR);
        let new_cfg_id = option::destroy_some(ts::most_recent_id_shared<PriceConfig>());
        assert!(new_cfg_id != init_cfg_id, 3000);
        let cfg = ts::take_shared_by_id<PriceConfig>(&s, new_cfg_id);
        // Exact UNSET state init creates: the BASE_GRAD_MIST fallback applies
        // until the relayer publishes the first price.
        assert!(bonding_curve::price_scaled(&cfg) == 0, 3001);
        assert!(bonding_curve::price_updated_at_ms(&cfg) == 0, 3002);
        ts::return_shared(cfg);
        ts::end(s);
    }

    #[test]
    #[expected_failure(abort_code = E_PRICE_CONFIG_EXISTS, location = suipump::bonding_curve)]
    fun test_create_price_config_second_call_aborts() {
        let mut s = ts::begin(CREATOR);
        bonding_curve::init_for_testing(ts::ctx(&mut s));

        ts::next_tx(&mut s, CREATOR);
        let mut admin = ts::take_from_sender<AdminCap>(&s);
        bonding_curve::create_price_config(&mut admin, ts::ctx(&mut s));
        // The dynamic-field marker on the AdminCap's UID makes any second call
        // abort - one PriceConfig per lineage, forever.
        bonding_curve::create_price_config(&mut admin, ts::ctx(&mut s));
        ts::return_to_sender(&s, admin);
        ts::end(s);
    }

    #[test]
    fun test_buy_via_admin_created_config_matches_init_config() {
        let mut s = ts::begin(CREATOR);
        bonding_curve::init_for_testing(ts::ctx(&mut s));

        // Curve A - will trade against init's PriceConfig.
        ts::next_tx(&mut s, CREATOR);
        let (a1, b1) = make_payouts_single();
        setup_curve(&mut s, a1, b1);

        // Curve B - will trade against the admin-created PriceConfig.
        ts::next_tx(&mut s, CREATOR);
        let curve_a_id = option::destroy_some(ts::most_recent_id_shared<Curve<TEST_TOKEN>>());
        let (a2, b2) = make_payouts_single();
        setup_curve(&mut s, a2, b2);

        ts::next_tx(&mut s, CREATOR);
        let curve_b_id = option::destroy_some(ts::most_recent_id_shared<Curve<TEST_TOKEN>>());
        assert!(curve_a_id != curve_b_id, 3010);
        let init_cfg_id = option::destroy_some(ts::most_recent_id_shared<PriceConfig>());
        let mut admin = ts::take_from_sender<AdminCap>(&s);
        bonding_curve::create_price_config(&mut admin, ts::ctx(&mut s));

        // Publish the SAME price ($0.75) into BOTH configs.
        ts::next_tx(&mut s, CREATOR);
        let admin_cfg_id = option::destroy_some(ts::most_recent_id_shared<PriceConfig>());
        assert!(admin_cfg_id != init_cfg_id, 3011);
        let mut init_cfg  = ts::take_shared_by_id<PriceConfig>(&s, init_cfg_id);
        let mut admin_cfg = ts::take_shared_by_id<PriceConfig>(&s, admin_cfg_id);
        let clk = clock::create_for_testing(ts::ctx(&mut s));
        // E-1: set_sui_price takes the PriceRelayerCap; `admin` stays the AdminCap
        // used above for create_price_config. Proves the two authorities are split.
        let relayer = ts::take_from_sender<PriceRelayerCap>(&s);
        bonding_curve::set_sui_price(&relayer, &mut init_cfg, 750, &clk);
        bonding_curve::set_sui_price(&relayer, &mut admin_cfg, 750, &clk);

        // Identical 1 SUI buys on two fresh curves, one per config.
        ts::next_tx(&mut s, BUYER);
        let mut curve_a = ts::take_shared_by_id<Curve<TEST_TOKEN>>(&s, curve_a_id);
        let mut curve_b = ts::take_shared_by_id<Curve<TEST_TOKEN>>(&s, curve_b_id);
        let pay_a = mint_sui(1 * MIST_PER_SUI, &mut s);
        let (tok_a, ref_a) = bonding_curve::buy<TEST_TOKEN>(
            &mut curve_a, pay_a, 0, option::none(), &init_cfg, &clk, ts::ctx(&mut s)
        );
        let pay_b = mint_sui(1 * MIST_PER_SUI, &mut s);
        let (tok_b, ref_b) = bonding_curve::buy<TEST_TOKEN>(
            &mut curve_b, pay_b, 0, option::none(), &admin_cfg, &clk, ts::ctx(&mut s)
        );

        // Same observable outcome through either config: tokens out, refund,
        // both reserves, and the dampened threshold ($0.75 -> 10,392,098,152,340
        // exactly as in test_published_price_dampens_threshold).
        assert!(coin::value(&tok_a) > 0, 3012);
        assert!(coin::value(&tok_a) == coin::value(&tok_b), 3013);
        assert!(coin::value(&ref_a) == coin::value(&ref_b), 3014);
        assert!(bonding_curve::sui_reserve(&curve_a) == bonding_curve::sui_reserve(&curve_b), 3015);
        assert!(bonding_curve::token_reserve(&curve_a) == bonding_curve::token_reserve(&curve_b), 3016);
        assert!(bonding_curve::current_grad_threshold(&curve_b) == 10_392_098_152_340, 3017);
        assert!(
            bonding_curve::current_grad_threshold(&curve_a)
                == bonding_curve::current_grad_threshold(&curve_b),
            3018,
        );

        destroy(tok_a); destroy(ref_a);
        destroy(tok_b); destroy(ref_b);
        clock::destroy_for_testing(clk);
        // Taken from CREATOR but the current tx sender is BUYER, so
        // return_to_sender would abort with ECantReturnObject (code 2).
        ts::return_to_address(CREATOR, admin);
        ts::return_to_address(CREATOR, relayer);
        ts::return_shared(init_cfg);
        ts::return_shared(admin_cfg);
        ts::return_shared(curve_a);
        ts::return_shared(curve_b);
        ts::end(s);
    }

    // --- E-1: PriceRelayerCap split (set_sui_price gated on the relayer cap ONLY) ---

    #[test]
    fun test_price_relayer_cap_sets_price() {
        // (a) The PriceRelayerCap (minted to the publisher by init) publishes the
        // price successfully - it is the sole price authority after the E-1 split.
        let mut s = ts::begin(CREATOR);
        bonding_curve::init_for_testing(ts::ctx(&mut s));

        ts::next_tx(&mut s, CREATOR);
        let relayer = ts::take_from_sender<PriceRelayerCap>(&s);
        let mut cfg = ts::take_shared<PriceConfig>(&s);
        let clk = clock::create_for_testing(ts::ctx(&mut s));
        bonding_curve::set_sui_price(&relayer, &mut cfg, 1000, &clk);
        assert!(bonding_curve::price_scaled(&cfg) == 1000, 4000);
        assert!(bonding_curve::price_updated_at_ms(&cfg) == clock::timestamp_ms(&clk), 4001);

        clock::destroy_for_testing(clk);
        ts::return_to_sender(&s, relayer);
        ts::return_shared(cfg);
        ts::end(s);
    }

    #[test]
    fun test_set_sui_price_gated_on_relayer_cap_only() {
        // (b) PROOF BY ABSENCE (compile-time). set_sui_price's first parameter is
        // &PriceRelayerCap. There is NO overload and NO alternate entry that
        // accepts an &AdminCap for the price: the AdminCap-gated version was
        // DELETED, not kept as a dual path. Passing the AdminCap held below into
        // set_sui_price would fail to type-check, so this file cannot even express
        // the old AdminCap price path. We hold BOTH caps to make the split
        // explicit, and drive the price with the ONLY authority that compiles.
        let mut s = ts::begin(CREATOR);
        bonding_curve::init_for_testing(ts::ctx(&mut s));

        ts::next_tx(&mut s, CREATOR);
        let relayer = ts::take_from_sender<PriceRelayerCap>(&s);
        let admin = ts::take_from_sender<AdminCap>(&s);
        let mut cfg = ts::take_shared<PriceConfig>(&s);
        let clk = clock::create_for_testing(ts::ctx(&mut s));
        // bonding_curve::set_sui_price(&admin, &mut cfg, 2000, &clk); // WOULD NOT COMPILE
        bonding_curve::set_sui_price(&relayer, &mut cfg, 2000, &clk);
        assert!(bonding_curve::price_scaled(&cfg) == 2000, 4010);

        clock::destroy_for_testing(clk);
        ts::return_to_sender(&s, relayer);
        ts::return_to_sender(&s, admin);
        ts::return_shared(cfg);
        ts::end(s);
    }

    #[test]
    fun test_create_price_config_mints_relayer_cap() {
        // (c) The upgrade bootstrap create_price_config mints a WORKING
        // PriceRelayerCap (transferred to the admin caller) that sets the price on
        // the config it shared. "Exactly one" is guaranteed by the one-shot marker:
        // a second create_price_config aborts EPriceConfigExists BEFORE minting a
        // second cap (proven by test_create_price_config_second_call_aborts).
        let mut s = ts::begin(CREATOR);
        bonding_curve::init_for_testing(ts::ctx(&mut s));

        ts::next_tx(&mut s, CREATOR);
        let mut admin = ts::take_from_sender<AdminCap>(&s);
        bonding_curve::create_price_config(&mut admin, ts::ctx(&mut s));
        ts::return_to_sender(&s, admin);

        ts::next_tx(&mut s, CREATOR);
        let new_cfg_id = option::destroy_some(ts::most_recent_id_shared<PriceConfig>());
        let mut cfg = ts::take_shared_by_id<PriceConfig>(&s, new_cfg_id);
        let relayer = ts::take_from_sender<PriceRelayerCap>(&s);
        let clk = clock::create_for_testing(ts::ctx(&mut s));
        bonding_curve::set_sui_price(&relayer, &mut cfg, 5000, &clk);
        assert!(bonding_curve::price_scaled(&cfg) == 5000, 4020);

        clock::destroy_for_testing(clk);
        ts::return_to_sender(&s, relayer);
        ts::return_shared(cfg);
        ts::end(s);
    }

    #[test]
    fun test_admin_cap_still_pauses_after_relayer_split() {
        // (d) The split did not weaken AdminCap authority: an AdminCap-gated power
        // (set_paused) still works after set_sui_price moved to PriceRelayerCap.
        let mut s = ts::begin(CREATOR);
        bonding_curve::init_for_testing(ts::ctx(&mut s));

        ts::next_tx(&mut s, CREATOR);
        let (_a, _b) = make_payouts_single();
        setup_curve(&mut s, _a, _b);

        ts::next_tx(&mut s, CREATOR);
        let admin_cap = ts::take_from_sender<AdminCap>(&s);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        bonding_curve::set_paused(&admin_cap, &mut curve, true);
        assert!(bonding_curve::paused(&curve), 4030);
        bonding_curve::set_paused(&admin_cap, &mut curve, false);
        assert!(!bonding_curve::paused(&curve), 4031);
        ts::return_to_sender(&s, admin_cap);
        ts::return_shared(curve);
        ts::end(s);
    }

    // --- F-1: unbacked pre-mint (CRITICAL) ---

    #[test]
    #[expected_failure(abort_code = 53)] // EPreMintedSupply
    fun test_f1_premint_aborts_launch() {
        let mut s = ts::begin(CREATOR);
        bonding_curve::init_for_testing(ts::ctx(&mut s));

        ts::next_tx(&mut s, CREATOR);
        // template::init hands the TreasuryCap to the PUBLISHER, so the creator
        // holds an unrestricted mint between the coin-publish tx and the launch.
        // Here they print 500M unbacked tokens to themselves first. Honest buyers
        // would then fund sui_reserve and the creator would dump into it - the
        // curve becomes their exit liquidity and it costs them nothing. The
        // zero-supply assert in create_and_return must stop the launch outright.
        let mut treasury = coin::create_treasury_cap_for_testing<TEST_TOKEN>(
            ts::ctx(&mut s)
        );
        let premint = coin::mint(&mut treasury, 500_000_000 * 1_000_000, ts::ctx(&mut s));
        destroy(premint);

        let payment = mint_sui(LAUNCH_FEE, &mut s);
        let clk = clock::create_for_testing(ts::ctx(&mut s));
        let (_a, _b) = make_payouts_single();
        bonding_curve::create_with_launch_fee<TEST_TOKEN>(
            treasury, payment,
            string::utf8(b"Test Token"), ascii::string(b"TEST"),
            string::utf8(b"Test description"),
            _a, _b,
            0, // graduation_target
            0, // anti_bot_delay
            &clk,
            ts::ctx(&mut s),
        );
        clock::destroy_for_testing(clk);
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
            let cfg = ts::take_shared<PriceConfig>(&s);
            let payment = mint_sui(1_000 * MIST_PER_SUI, &mut s);
            let clk = clock::create_for_testing(ts::ctx(&mut s));
            let (tokens, refund) = bonding_curve::buy_for_testing(
                &mut curve, payment, 0, option::none(), &cfg, &clk, ts::ctx(&mut s)
            );
            destroy(tokens);
            destroy(refund);
            clock::destroy_for_testing(clk);
            ts::return_shared(cfg);
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
            &mut curve, string::utf8(b"great token"), fee, &holder, @0x0, ts::ctx(&mut s),
        );
        destroy(holder);
        assert!(bonding_curve::protocol_fees(&curve) == proto_before + COMMENT_FEE, 1800);
        ts::return_shared(curve);
        ts::end(s);
    }

    #[test]
    fun test_comment_author_is_tx_sender() {
        let mut s = ts::begin(CREATOR);
        let (_a, _b) = make_payouts_single();
        setup_curve(&mut s, _a, _b);

        // V13 (audit F-7): post_comment no longer takes an author parameter;
        // the emitted Comment event's author must be the tx sender. Post as
        // BUYER (a non-creator) and inspect this tx's events -- events_by_type
        // only sees events emitted in the CURRENT test_scenario transaction,
        // so the assertions happen before the next next_tx/end.
        ts::next_tx(&mut s, BUYER);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        let fee = mint_sui(COMMENT_FEE, &mut s);
        let holder = mint_token(1_000_000, &mut s);
        bonding_curve::post_comment(
            &mut curve, string::utf8(b"sender is author"), fee, &holder, @0x0, ts::ctx(&mut s),
        );
        let evs = sui::event::events_by_type<bonding_curve::Comment>();
        assert!(vector::length(&evs) == 1, 1801);
        assert!(bonding_curve::comment_author(vector::borrow(&evs, 0)) == BUYER, 1802);
        destroy(holder);
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
            &mut curve, string::utf8(b"hi"), bad_fee, &holder, @0x0, ts::ctx(&mut s),
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
            &mut curve, string::utf8(b""), fee, &holder, @0x0, ts::ctx(&mut s),
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
            &mut curve, long_text, fee, &holder, @0x0, ts::ctx(&mut s),
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
        // F-10: the display cache current_grad_threshold is stamped by the REAL
        // buy() from resolve_grad_threshold (previously this test only
        // exercised the set_grad_threshold_for_testing setter). Price unset ->
        // resolve_grad_threshold returns BASE_GRAD_MIST = 9_000 SUI.
        let mut s = ts::begin(CREATOR);
        bonding_curve::init_for_testing(ts::ctx(&mut s));
        let (_a, _b) = make_payouts_single();
        setup_curve(&mut s, _a, _b);

        ts::next_tx(&mut s, BUYER);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        let cfg = ts::take_shared<PriceConfig>(&s);
        // Before any buy: threshold is 0 (never stamped)
        assert!(bonding_curve::current_grad_threshold(&curve) == 0, 2000);
        let payment = mint_sui(1 * MIST_PER_SUI, &mut s);
        let clk = clock::create_for_testing(ts::ctx(&mut s));
        let (tokens, refund) = bonding_curve::buy_for_testing(
            &mut curve, payment, 0, option::none(), &cfg, &clk, ts::ctx(&mut s)
        );
        destroy(tokens); destroy(refund);
        assert!(bonding_curve::current_grad_threshold(&curve) == 9_000 * MIST_PER_SUI, 2001);
        clock::destroy_for_testing(clk);
        ts::return_shared(cfg);
        ts::return_shared(curve);
        ts::end(s);
    }

    #[test]
    fun test_threshold_fallback_to_base_when_not_set() {
        // When the PriceConfig has never been published (price_scaled == 0),
        // buy() falls back to BASE_GRAD_MIST (9,000 SUI). A 100 SUI buy is far
        // below that -> should NOT graduate.
        let mut s = ts::begin(CREATOR);
        bonding_curve::init_for_testing(ts::ctx(&mut s));
        let (_a, _b) = make_payouts_single();
        setup_curve(&mut s, _a, _b);

        ts::next_tx(&mut s, BUYER);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        let cfg = ts::take_shared<PriceConfig>(&s);
        let payment = mint_sui(100 * MIST_PER_SUI, &mut s);
        let clk = clock::create_for_testing(ts::ctx(&mut s));
        let (tokens, refund) = bonding_curve::buy_for_testing(
            &mut curve, payment, 0, option::none(), &cfg, &clk, ts::ctx(&mut s)
        );
        assert!(!bonding_curve::graduated(&curve), 2100);
        destroy(tokens); destroy(refund);
        clock::destroy_for_testing(clk);
        ts::return_shared(cfg);
        ts::return_shared(curve);
        ts::end(s);
    }

    #[test]
    fun test_normal_buy_refund_is_zero_lp_fee_in_reserve() {
        // F-5 + F-10: for a normal (non-clip) buy the payment splits EXACTLY
        // into fees + reserve, so the returned refund coin is EMPTY. The old
        // expectation (refund == lp_fee) documented the pre-F-5 shadow bug in
        // which the lp_fee leaked back to the buyer while lp_fees_accumulated
        // still incremented. DERIVATION (production buy(), sui_in = 100 SUI =
        // 100_000_000_000 MIST, Path C so tail_refund = 0):
        //   fee         = 1%                      =   1_000_000_000
        //   swap_amount = sui_in - fee            =  99_000_000_000
        //   lp_fee      = 10% of fee              =     100_000_000
        //   to_reserve  = swap_amount + lp_fee    =  99_100_000_000   (F-5)
        //   refund      = sui_in - (fee - lp_fee) - to_reserve = 0
        let mut s = ts::begin(CREATOR);
        bonding_curve::init_for_testing(ts::ctx(&mut s));
        let (_a, _b) = make_payouts_single();
        setup_curve(&mut s, _a, _b);

        ts::next_tx(&mut s, BUYER);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        let cfg = ts::take_shared<PriceConfig>(&s);
        let sui_in = 100 * MIST_PER_SUI;
        let payment = mint_sui(sui_in, &mut s);
        let clk = clock::create_for_testing(ts::ctx(&mut s));
        let (tokens, refund) = bonding_curve::buy_for_testing(
            &mut curve, payment, 0, option::none(), &cfg, &clk, ts::ctx(&mut s)
        );
        assert!(coin::value(&refund) == 0, 2200);
        assert!(bonding_curve::sui_reserve(&curve) == 99_100_000_000, 2201);
        assert!(bonding_curve::lp_fees_accumulated(&curve) == 100_000_000, 2202);
        destroy(tokens); destroy(refund);
        clock::destroy_for_testing(clk);
        ts::return_shared(cfg);
        ts::return_shared(curve);
        ts::end(s);
    }

    // ─── v9 NEW: Graduation SUI-threshold tail-clip (Path B) ─────────────────

    #[test]
    fun test_grad_clip_triggers_inline_graduation() {
        // F-10: reach a REAL dampened threshold through the production path by
        // publishing the band ceiling $100.00 (price_scaled = 100_000), the
        // LOWEST reachable threshold. DERIVATION (dampened_grad_threshold,
        // precision = 1_000_000):
        //   num = isqrt(1_000 * 1_000_000)   = isqrt(1e9)  =  31_622
        //   den = isqrt(100_000 * 1_000_000) = isqrt(1e11) = 316_227
        //   threshold = 9_000_000_000_000 * 31_622 / 316_227 = 899_980_077_602
        // A 1,000 SUI buy on the fresh curve: swap_full = 990_000_000_000 >
        // threshold -> Path B clip:
        //   used_swap = threshold; tail = 990_000_000_000 - 899_980_077_602
        //             = 90_019_922_398
        // and with F-5 the payment leftover is EXACTLY that tail (the lp_fee
        // goes into the reserve, not back to the buyer).
        let mut s = ts::begin(CREATOR);
        bonding_curve::init_for_testing(ts::ctx(&mut s));
        let (_a, _b) = make_payouts_single();
        setup_curve(&mut s, _a, _b);

        ts::next_tx(&mut s, CREATOR);
        // E-1: set_sui_price is now gated on PriceRelayerCap, not AdminCap. This
        // local is the price-relayer cap (minted to CREATOR by init_for_testing).
        let admin = ts::take_from_sender<PriceRelayerCap>(&s);
        let mut cfg = ts::take_shared<PriceConfig>(&s);
        let clk = clock::create_for_testing(ts::ctx(&mut s));
        bonding_curve::set_sui_price(&admin, &mut cfg, 100_000, &clk);

        ts::next_tx(&mut s, BUYER);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        let payment = mint_sui(1_000 * MIST_PER_SUI, &mut s);
        let (tokens, refund) = bonding_curve::buy_for_testing(
            &mut curve, payment, 0, option::none(), &cfg, &clk, ts::ctx(&mut s)
        );
        assert!(bonding_curve::graduated(&curve), 2300);
        assert!(coin::value(&tokens) > 0, 2301);
        assert!(bonding_curve::current_grad_threshold(&curve) == 899_980_077_602, 2302);
        assert!(coin::value(&refund) == 90_019_922_398, 2303);
        destroy(tokens); destroy(refund);
        clock::destroy_for_testing(clk);
        // Taken from CREATOR but the current tx sender is BUYER, so
        // return_to_sender would abort with ECantReturnObject (code 2).
        ts::return_to_address(CREATOR, admin);
        ts::return_shared(cfg);
        ts::return_shared(curve);
        ts::end(s);
    }

    #[test]
    fun test_grad_clip_conservation() {
        // F-10: EXACT conservation through the production path. Price unset ->
        // threshold = BASE_GRAD_MIST = 9_000_000_000_000. DERIVATION for a
        // 10,000 SUI buy on a fresh curve (all values MIST, floor division):
        //   fee_full  = 100_000_000_000; swap_full = 9_900_000_000_000 >
        //   threshold -> Path B: used_swap = 9_000_000_000_000,
        //   tail (refund) = 900_000_000_000
        //   effective = 9_100_000_000_000; fee = 91_000_000_000
        //   creator 40%          = 36_400_000_000
        //   lp 10%               =  9_100_000_000
        //   protocol = airdrop   = 22_750_000_000 (45.5e9 bucket halved)
        //   to_reserve = (9_100e9 - 91e9) + 9_100_000_000 = 9_018_100_000_000
        //   grad bonuses (50 bps each of the post-buy reserve):
        //     9_018_100_000_000 * 50 / 10_000 = 45_090_500_000
        //     creator bonus leaves as a coin; protocol bonus joins protocol_fees
        //   reserve after grad = 9_018_100_000_000 - 2 * 45_090_500_000
        //                      = 8_927_919_000_000
        // Identity (every MIST accounted): creator_fees + protocol_fees (incl
        // bonus) + airdrop_fees + reserve + refund + creator_bonus_coin == sui_in.
        let mut s = ts::begin(CREATOR);
        bonding_curve::init_for_testing(ts::ctx(&mut s));
        let (_a, _b) = make_payouts_single();
        setup_curve(&mut s, _a, _b);

        ts::next_tx(&mut s, BUYER);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        let cfg = ts::take_shared<PriceConfig>(&s);
        let sui_in = 10_000 * MIST_PER_SUI;
        let proto_before  = bonding_curve::protocol_fees(&curve);
        let creator_before = bonding_curve::creator_fees(&curve);
        let airdrop_before = bonding_curve::airdrop_fees(&curve);
        let reserve_before = bonding_curve::sui_reserve(&curve);

        let payment = mint_sui(sui_in, &mut s);
        let clk = clock::create_for_testing(ts::ctx(&mut s));
        let (tokens, refund) = bonding_curve::buy_for_testing(
            &mut curve, payment, 0, option::none(), &cfg, &clk, ts::ctx(&mut s)
        );
        assert!(bonding_curve::graduated(&curve), 2400);

        let refund_amount  = coin::value(&refund);
        let creator_delta  = bonding_curve::creator_fees(&curve)  - creator_before;
        let protocol_delta = bonding_curve::protocol_fees(&curve) - proto_before;
        let airdrop_delta  = bonding_curve::airdrop_fees(&curve)  - airdrop_before;
        let reserve_delta  = bonding_curve::sui_reserve(&curve)   - reserve_before;
        assert!(refund_amount  == 900_000_000_000, 2401);
        assert!(creator_delta  == 36_400_000_000, 2402);
        assert!(protocol_delta == 22_750_000_000 + 45_090_500_000, 2403);
        assert!(airdrop_delta  == 22_750_000_000, 2404);
        assert!(reserve_delta  == 8_927_919_000_000, 2405);

        destroy(tokens); destroy(refund);
        clock::destroy_for_testing(clk);
        ts::return_shared(cfg);
        ts::return_shared(curve);

        // The creator graduation bonus left the curve as a Coin<SUI> to
        // CREATOR (the only coin at that address). With it counted,
        // conservation is EXACT - no tolerance window.
        ts::next_tx(&mut s, CREATOR);
        let bonus = ts::take_from_address<Coin<SUI>>(&s, CREATOR);
        assert!(coin::value(&bonus) == 45_090_500_000, 2406);
        assert!(
            creator_delta + protocol_delta + airdrop_delta + reserve_delta
                + refund_amount + coin::value(&bonus) == sui_in,
            2407,
        );
        destroy(bonus);
        ts::end(s);
    }

    #[test]
    #[expected_failure(abort_code = E_ALREADY_GRADUATED, location = suipump::bonding_curve)]
    fun test_cannot_buy_after_inline_graduation() {
        // F-10: graduate for REAL through buy() (price unset -> threshold
        // BASE_GRAD_MIST = 9,000 SUI; a 10,000 SUI buy clips at it and
        // graduates inline), then prove the very next buy aborts
        // EAlreadyGraduated. The pre-F-10 version never attempted the second
        // buy - it only asserted the graduated flag.
        let mut s = ts::begin(CREATOR);
        bonding_curve::init_for_testing(ts::ctx(&mut s));
        let (_a, _b) = make_payouts_single();
        setup_curve(&mut s, _a, _b);

        ts::next_tx(&mut s, BUYER);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        let cfg = ts::take_shared<PriceConfig>(&s);
        let payment = mint_sui(10_000 * MIST_PER_SUI, &mut s);
        let clk = clock::create_for_testing(ts::ctx(&mut s));
        let (tokens, refund) = bonding_curve::buy_for_testing(
            &mut curve, payment, 0, option::none(), &cfg, &clk, ts::ctx(&mut s)
        );
        assert!(bonding_curve::graduated(&curve), 2500);
        destroy(tokens); destroy(refund);

        // Second buy on the graduated curve - MUST abort EAlreadyGraduated.
        let payment2 = mint_sui(10 * MIST_PER_SUI, &mut s);
        let (t2, r2) = bonding_curve::buy_for_testing(
            &mut curve, payment2, 0, option::none(), &cfg, &clk, ts::ctx(&mut s)
        );
        destroy(t2); destroy(r2);
        clock::destroy_for_testing(clk);
        ts::return_shared(cfg);
        ts::return_shared(curve);
        ts::end(s);
    }

    #[test]
    fun test_graduation_via_sui_threshold_not_drain() {
        // F-10: price unset -> threshold = BASE_GRAD_MIST (9,000 SUI), well
        // below the 12,802.93 SUI swap needed to drain all 800M tokens, so a
        // 10,000 SUI buy graduates via Path B with tokens REMAINING.
        // DERIVATION: used_swap = 9_000_000_000_000 on the fresh curve
        //   (x = VS = 4_369e9, y = VTR = 1_073_000_000e6):
        //   tokens_out = y * used / (x + used) = 722_342_733_188_720
        //   token_reserve after = 800_000_000e6 - tokens_out
        //                       = 77_657_266_811_280
        let mut s = ts::begin(CREATOR);
        bonding_curve::init_for_testing(ts::ctx(&mut s));
        let (_a, _b) = make_payouts_single();
        setup_curve(&mut s, _a, _b);

        ts::next_tx(&mut s, BUYER);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        let cfg = ts::take_shared<PriceConfig>(&s);
        let payment = mint_sui(10_000 * MIST_PER_SUI, &mut s);
        let clk = clock::create_for_testing(ts::ctx(&mut s));
        let (tokens, refund) = bonding_curve::buy_for_testing(
            &mut curve, payment, 0, option::none(), &cfg, &clk, ts::ctx(&mut s)
        );
        // Graduated even though tokens remain
        assert!(bonding_curve::graduated(&curve), 2600);
        assert!(bonding_curve::token_reserve(&curve) == 77_657_266_811_280, 2601);
        assert!(coin::value(&tokens) == 722_342_733_188_720, 2602);
        destroy(tokens); destroy(refund);
        clock::destroy_for_testing(clk);
        ts::return_shared(cfg);
        ts::return_shared(curve);
        ts::end(s);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // V10 TESTS
    // ═══════════════════════════════════════════════════════════════════════

    const CTO_INACTIVITY_MS: u64 = 5  * 24 * 60 * 60 * 1_000;
    const CTO_WINDOW_MS:     u64 = 72 * 60 * 60 * 1_000;
    // Mirror of bonding_curve::CURVE_SUPPLY (for the MIN_VOTE floor computation).
    const CTO_CURVE_SUPPLY:  u64 = 800_000_000 * 1_000_000;
    const CTO_MIN_VOTE_BPS:  u64 = 1;
    const CTO_BPS_DENOM:     u64 = 10_000;
    const VOTER_A:  address = @0x570A;
    const VOTER_B:  address = @0x570B;

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
            &mut curve, string::utf8(b"spam"), fee, &empty_holder, @0x0, ts::ctx(&mut s),
        );
        destroy(empty_holder);
        ts::return_shared(curve);
        ts::end(s);
    }

    // ─── Item 2: buyback carves from creator, conservation holds ───────────

    #[test]
    fun test_buyback_config_and_accrual() {
        let mut s = ts::begin(CREATOR);
        // V13: init shares the PriceConfig that buy() now reads.
        bonding_curve::init_for_testing(ts::ctx(&mut s));
        let (_a, _b) = make_payouts_single();
        setup_curve(&mut s, _a, _b);

        // Creator sets 50% buyback (of the creator slice), burn mode.
        ts::next_tx(&mut s, CREATOR);
        let cap = ts::take_from_sender<CreatorCap>(&s);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        let cfg = ts::take_shared<PriceConfig>(&s);
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
            &mut curve, payment, 0, option::none(), &cfg, &clk, ts::ctx(&mut s),
        );
        let bucket = bonding_curve::buyback_fees_pending(&curve);
        // 0.2 SUI = 200_000_000 MIST (no referral path).
        assert!(bucket == 200_000_000, 9003);

        destroy(tokens); destroy(refund);
        clock::destroy_for_testing(clk);
        ts::return_to_address(CREATOR, cap);
        ts::return_shared(cfg);
        ts::return_shared(curve);
        ts::end(s);
    }

    #[test]
    fun test_execute_buyback_burns() {
        let mut s = ts::begin(CREATOR);
        // V13: init shares the PriceConfig that buy() now reads.
        bonding_curve::init_for_testing(ts::ctx(&mut s));
        let (_a, _b) = make_payouts_single();
        setup_curve(&mut s, _a, _b);

        ts::next_tx(&mut s, CREATOR);
        let cap = ts::take_from_sender<CreatorCap>(&s);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        let cfg = ts::take_shared<PriceConfig>(&s);
        let clk = clock::create_for_testing(ts::ctx(&mut s));
        bonding_curve::set_buyback_config(&cap, &mut curve, 10_000, true, &clk, ts::ctx(&mut s));

        ts::next_tx(&mut s, BUYER);
        let payment = mint_sui(100 * MIST_PER_SUI, &mut s);
        let (tokens, refund) = bonding_curve::buy(
            &mut curve, payment, 0, option::none(), &cfg, &clk, ts::ctx(&mut s),
        );
        destroy(tokens); destroy(refund);

        // Execute buyback: spends bucket, burns bought tokens. Bucket -> 0.
        assert!(bonding_curve::buyback_fees_pending(&curve) > 0, 9100);
        bonding_curve::execute_buyback(&mut curve, ts::ctx(&mut s));
        assert!(bonding_curve::buyback_fees_pending(&curve) == 0, 9101);

        clock::destroy_for_testing(clk);
        ts::return_to_address(CREATOR, cap);
        ts::return_shared(cfg);
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

    // ─── Item 3: CTO (V13 escrow-weighted, shared proposal) ────────────────
    // Cross-transaction test_scenario throughout: the ORIGINAL suite validated
    // CTO in a SINGLE tx, which is exactly how F-AC-1 (proposal never shared)
    // survived. Every test below proposes in one tx and votes/resolves/reclaims
    // in LATER txs against the SHARED proposal object.

    fun begin_cto(): Scenario {
        let mut s = ts::begin(CREATOR);
        // V13: init shares the PriceConfig that buy() reads.
        bonding_curve::init_for_testing(ts::ctx(&mut s));
        let (_a, _b) = make_payouts_single();
        setup_curve(&mut s, _a, _b);
        s
    }

    /// Buy via the PRODUCTION buy() so the voter gets a REAL Coin<TEST_TOKEN>,
    /// then park it at `buyer` for a later takeover tx. Buys stay well under the
    /// 9,000 SUI graduation floor so the curve never graduates mid-test.
    fun buy_bag(s: &mut Scenario, buyer: address, sui_amt: u64) {
        ts::next_tx(s, buyer);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(s);
        let cfg = ts::take_shared<PriceConfig>(s);
        let clk = clock::create_for_testing(ts::ctx(s));
        let payment = mint_sui(sui_amt, s);
        let (bag, refund) = bonding_curve::buy(
            &mut curve, payment, 0, option::none(), &cfg, &clk, ts::ctx(s),
        );
        destroy(refund);
        transfer::public_transfer(bag, buyer);
        clock::destroy_for_testing(clk);
        ts::return_shared(cfg);
        ts::return_shared(curve);
    }

    /// The per-vote spam floor = 0.01% of CURVE_SUPPLY (mirrors production).
    fun min_vote(): u64 { (CTO_CURVE_SUPPLY * CTO_MIN_VOTE_BPS) / CTO_BPS_DENOM }

    // F-AC-1 regression: a proposal opened in one tx MUST be a shared object
    // reachable by a later tx.
    #[test]
    fun test_cto_shares_the_object() {
        let mut s = begin_cto();
        buy_bag(&mut s, VOTER_A, 3_000 * MIST_PER_SUI);

        ts::next_tx(&mut s, VOTER_A);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        let bag = ts::take_from_address<Coin<TEST_TOKEN>>(&s, VOTER_A);
        let stake_amt = coin::value(&bag);
        let mut clk = clock::create_for_testing(ts::ctx(&mut s));
        clock::set_for_testing(&mut clk, CTO_INACTIVITY_MS + 1);
        bonding_curve::propose_takeover(&mut curve, bag, &clk, ts::ctx(&mut s));
        clock::destroy_for_testing(clk);
        ts::return_shared(curve);

        // LATER tx: taking the shared proposal must SUCCEED.
        ts::next_tx(&mut s, BUYER);
        let proposal = ts::take_shared<bonding_curve::TakeoverProposal<TEST_TOKEN>>(&s);
        assert!(bonding_curve::proposal_proposer(&proposal) == VOTER_A, 9500);
        assert!(bonding_curve::proposal_total_weight(&proposal) == stake_amt, 9501);
        assert!(bonding_curve::proposal_escrow_value(&proposal) == stake_amt, 9502);
        assert!(!bonding_curve::proposal_resolved(&proposal), 9503);
        ts::return_shared(proposal);
        ts::end(s);
    }

    // F-3 physical impossibility: the vote coin is LOCKED in escrow, so it cannot
    // be moved to a second wallet to vote twice.
    #[test]
    fun test_cto_f3_double_count_impossible() {
        let mut s = begin_cto();
        buy_bag(&mut s, VOTER_A, 3_000 * MIST_PER_SUI);

        ts::next_tx(&mut s, VOTER_A);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        let bag = ts::take_from_address<Coin<TEST_TOKEN>>(&s, VOTER_A);
        let stake_amt = coin::value(&bag);
        let mut clk = clock::create_for_testing(ts::ctx(&mut s));
        clock::set_for_testing(&mut clk, CTO_INACTIVITY_MS + 1);
        bonding_curve::propose_takeover(&mut curve, bag, &clk, ts::ctx(&mut s));
        clock::destroy_for_testing(clk);
        ts::return_shared(curve);

        ts::next_tx(&mut s, VOTER_A);
        // VOTER_A's coin is locked away; VOTER_B never held any: no coin can move.
        assert!(!ts::has_most_recent_for_address<Coin<TEST_TOKEN>>(VOTER_A), 9510);
        assert!(!ts::has_most_recent_for_address<Coin<TEST_TOKEN>>(VOTER_B), 9511);
        let proposal = ts::take_shared<bonding_curve::TakeoverProposal<TEST_TOKEN>>(&s);
        // Each token is counted EXACTLY once.
        assert!(bonding_curve::proposal_total_weight(&proposal) == stake_amt, 9512);
        assert!(bonding_curve::proposal_voter_weight(&proposal, VOTER_A) == stake_amt, 9513);
        assert!(bonding_curve::proposal_voter_weight(&proposal, VOTER_B) == 0, 9514);
        assert!(bonding_curve::proposal_escrow_value(&proposal) == stake_amt, 9515);
        ts::return_shared(proposal);
        ts::end(s);
    }

    #[test]
    #[expected_failure(abort_code = E_BELOW_NOMINATE_THRESHOLD, location = suipump::bonding_curve)]
    fun test_cto_propose_below_nominate_aborts() {
        let mut s = begin_cto();
        buy_bag(&mut s, VOTER_A, 3_000 * MIST_PER_SUI);

        ts::next_tx(&mut s, VOTER_A);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        let mut bag = ts::take_from_address<Coin<TEST_TOKEN>>(&s, VOTER_A);
        let circ = bonding_curve::cto_circulating_supply(&curve);
        let threshold = (circ * 100) / 10_000; // CTO_NOMINATE_BPS = 1%
        // Stake ONE atomic unit below the nominate threshold.
        let stake = coin::split(&mut bag, threshold - 1, ts::ctx(&mut s));
        destroy(bag);
        let mut clk = clock::create_for_testing(ts::ctx(&mut s));
        clock::set_for_testing(&mut clk, CTO_INACTIVITY_MS + 1);
        bonding_curve::propose_takeover(&mut curve, stake, &clk, ts::ctx(&mut s));
        clock::destroy_for_testing(clk);
        ts::return_shared(curve);
        ts::end(s);
    }

    // F-4.0 regression: a curve with 0 circulating supply (all supply still in
    // token_reserve) degenerated the nominate threshold AND the quorum to 0,
    // letting a coin::zero stake open a proposal that then auto-succeeded. Propose
    // against a zero-circulating curve MUST abort ECtoZeroCirculating.
    #[test]
    #[expected_failure(abort_code = E_CTO_ZERO_CIRCULATING, location = suipump::bonding_curve)]
    fun test_cto_propose_zero_circulating_aborts() {
        let mut s = begin_cto(); // no buys: token_reserve == CURVE_SUPPLY -> circ == 0

        ts::next_tx(&mut s, VOTER_A);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        assert!(bonding_curve::cto_circulating_supply(&curve) == 0, 9580);
        let zero = coin::zero<TEST_TOKEN>(ts::ctx(&mut s));
        let mut clk = clock::create_for_testing(ts::ctx(&mut s));
        clock::set_for_testing(&mut clk, CTO_INACTIVITY_MS + 1);
        bonding_curve::propose_takeover(&mut curve, zero, &clk, ts::ctx(&mut s));
        clock::destroy_for_testing(clk);
        ts::return_shared(curve);
        ts::end(s);
    }

    // F-4.0 regression (zero-stake floor): even when circulating > 0, a coin::zero
    // stake must be rejected (the free-nomination path). amount > 0 is checked
    // before the threshold compare, so this aborts ECtoZeroCirculating.
    #[test]
    #[expected_failure(abort_code = E_CTO_ZERO_CIRCULATING, location = suipump::bonding_curve)]
    fun test_cto_propose_zero_stake_aborts() {
        let mut s = begin_cto();
        buy_bag(&mut s, VOTER_A, 3_000 * MIST_PER_SUI);

        ts::next_tx(&mut s, VOTER_A);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        assert!(bonding_curve::cto_circulating_supply(&curve) > 0, 9585);
        let zero = coin::zero<TEST_TOKEN>(ts::ctx(&mut s));
        let mut clk = clock::create_for_testing(ts::ctx(&mut s));
        clock::set_for_testing(&mut clk, CTO_INACTIVITY_MS + 1);
        bonding_curve::propose_takeover(&mut curve, zero, &clk, ts::ctx(&mut s));
        clock::destroy_for_testing(clk);
        ts::return_shared(curve);
        ts::end(s);
    }

    // F-6.0 regression: the quorum target is SNAPSHOT at propose time. Inflating
    // circulating supply with a buy after the proposal opens (buy() has no
    // live-proposal guard) must NOT raise the quorum above a tally that legitimately
    // met 25% at open. Old bug: resolve read live circulating supply -> the buy
    // defeated the takeover; here it succeeds on the frozen snapshot.
    #[test]
    fun test_cto_quorum_snapshot_survives_supply_inflation() {
        let mut s = begin_cto();
        buy_bag(&mut s, VOTER_A, 3_000 * MIST_PER_SUI);

        // A proposes staking EXACTLY 25% of circulating-at-open (meets quorum).
        ts::next_tx(&mut s, VOTER_A);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        let mut bag = ts::take_from_address<Coin<TEST_TOKEN>>(&s, VOTER_A);
        let circ0 = bonding_curve::cto_circulating_supply(&curve);
        let quorum0 = (circ0 * 2_500) / 10_000; // 25%
        let stake = coin::split(&mut bag, quorum0, ts::ctx(&mut s));
        destroy(bag);
        let mut clk = clock::create_for_testing(ts::ctx(&mut s));
        clock::set_for_testing(&mut clk, CTO_INACTIVITY_MS + 1);
        bonding_curve::propose_takeover(&mut curve, stake, &clk, ts::ctx(&mut s));
        clock::destroy_for_testing(clk);
        ts::return_shared(curve);

        // The proposal froze the propose-time 25% as its quorum target.
        ts::next_tx(&mut s, BUYER);
        let proposal = ts::take_shared<bonding_curve::TakeoverProposal<TEST_TOKEN>>(&s);
        assert!(bonding_curve::proposal_quorum_target(&proposal) == quorum0, 9590);
        assert!(bonding_curve::proposal_total_weight(&proposal) == quorum0, 9591);
        ts::return_shared(proposal);

        // Attacker inflates circulating supply while the proposal is live.
        buy_bag(&mut s, BUYER, 3_000 * MIST_PER_SUI);
        ts::next_tx(&mut s, BUYER);
        let curve_ro = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        let inflate_bag = ts::take_from_address<Coin<TEST_TOKEN>>(&s, BUYER);
        // Live 25% now exceeds the tally: the old live-read would have failed here.
        let live_quorum = (bonding_curve::cto_circulating_supply(&curve_ro) * 2_500) / 10_000;
        assert!(live_quorum > quorum0, 9592);
        destroy(inflate_bag);
        ts::return_shared(curve_ro);

        // Resolve after the window -> SUCCEEDS on the snapshot despite inflation.
        ts::next_tx(&mut s, BUYER);
        let mut proposal = ts::take_shared<bonding_curve::TakeoverProposal<TEST_TOKEN>>(&s);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        let mut clk = clock::create_for_testing(ts::ctx(&mut s));
        clock::set_for_testing(&mut clk, CTO_INACTIVITY_MS + CTO_WINDOW_MS + 2);
        bonding_curve::resolve_takeover(&mut proposal, &mut curve, &clk, ts::ctx(&mut s));
        assert!(bonding_curve::proposal_succeeded(&proposal), 9593);
        assert!(bonding_curve::proposal_resolved(&proposal), 9594);
        clock::destroy_for_testing(clk);
        ts::return_shared(curve);
        ts::return_shared(proposal);
        ts::end(s);
    }

    #[test]
    #[expected_failure(abort_code = E_CTO_PROPOSAL_LIVE, location = suipump::bonding_curve)]
    fun test_cto_second_live_proposal_aborts() {
        let mut s = begin_cto();
        buy_bag(&mut s, VOTER_A, 2_000 * MIST_PER_SUI);
        buy_bag(&mut s, VOTER_B, 2_000 * MIST_PER_SUI);

        // First proposal shares an object + sets the live marker.
        ts::next_tx(&mut s, VOTER_A);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        let bag_a = ts::take_from_address<Coin<TEST_TOKEN>>(&s, VOTER_A);
        let mut clk = clock::create_for_testing(ts::ctx(&mut s));
        clock::set_for_testing(&mut clk, CTO_INACTIVITY_MS + 1);
        bonding_curve::propose_takeover(&mut curve, bag_a, &clk, ts::ctx(&mut s));
        clock::destroy_for_testing(clk);
        ts::return_shared(curve);

        // Second concurrent proposal on the same curve -> abort.
        ts::next_tx(&mut s, VOTER_B);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        let bag_b = ts::take_from_address<Coin<TEST_TOKEN>>(&s, VOTER_B);
        let mut clk = clock::create_for_testing(ts::ctx(&mut s));
        clock::set_for_testing(&mut clk, CTO_INACTIVITY_MS + 2);
        bonding_curve::propose_takeover(&mut curve, bag_b, &clk, ts::ctx(&mut s));
        clock::destroy_for_testing(clk);
        ts::return_shared(curve);
        ts::end(s);
    }

    #[test]
    #[expected_failure(abort_code = E_CTO_BELOW_MIN_VOTE, location = suipump::bonding_curve)]
    fun test_cto_vote_below_min_aborts() {
        let mut s = begin_cto();
        buy_bag(&mut s, VOTER_A, 3_000 * MIST_PER_SUI);

        ts::next_tx(&mut s, VOTER_A);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        let mut bag = ts::take_from_address<Coin<TEST_TOKEN>>(&s, VOTER_A);
        // Carve off a sub-min slice for the illegal vote, propose with the rest.
        let tiny = coin::split(&mut bag, min_vote() - 1, ts::ctx(&mut s));
        transfer::public_transfer(tiny, VOTER_A);
        let mut clk = clock::create_for_testing(ts::ctx(&mut s));
        clock::set_for_testing(&mut clk, CTO_INACTIVITY_MS + 1);
        bonding_curve::propose_takeover(&mut curve, bag, &clk, ts::ctx(&mut s));
        clock::destroy_for_testing(clk);
        ts::return_shared(curve);

        ts::next_tx(&mut s, VOTER_A);
        let mut proposal = ts::take_shared<bonding_curve::TakeoverProposal<TEST_TOKEN>>(&s);
        let tiny = ts::take_from_address<Coin<TEST_TOKEN>>(&s, VOTER_A);
        let mut clk = clock::create_for_testing(ts::ctx(&mut s));
        clock::set_for_testing(&mut clk, CTO_INACTIVITY_MS + 2);
        bonding_curve::vote_takeover(&mut proposal, tiny, &clk, ts::ctx(&mut s));
        clock::destroy_for_testing(clk);
        ts::return_shared(proposal);
        ts::end(s);
    }

    #[test]
    #[expected_failure(abort_code = E_CTO_VOTE_CLOSED, location = suipump::bonding_curve)]
    fun test_cto_vote_past_deadline_aborts() {
        let mut s = begin_cto();
        buy_bag(&mut s, VOTER_A, 2_000 * MIST_PER_SUI);
        buy_bag(&mut s, VOTER_B, 2_000 * MIST_PER_SUI);

        ts::next_tx(&mut s, VOTER_A);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        let bag_a = ts::take_from_address<Coin<TEST_TOKEN>>(&s, VOTER_A);
        let mut clk = clock::create_for_testing(ts::ctx(&mut s));
        clock::set_for_testing(&mut clk, CTO_INACTIVITY_MS + 1);
        bonding_curve::propose_takeover(&mut curve, bag_a, &clk, ts::ctx(&mut s));
        clock::destroy_for_testing(clk);
        ts::return_shared(curve);

        ts::next_tx(&mut s, VOTER_B);
        let mut proposal = ts::take_shared<bonding_curve::TakeoverProposal<TEST_TOKEN>>(&s);
        let bag_b = ts::take_from_address<Coin<TEST_TOKEN>>(&s, VOTER_B);
        let mut clk = clock::create_for_testing(ts::ctx(&mut s));
        clock::set_for_testing(&mut clk, CTO_INACTIVITY_MS + CTO_WINDOW_MS + 2);
        bonding_curve::vote_takeover(&mut proposal, bag_b, &clk, ts::ctx(&mut s));
        clock::destroy_for_testing(clk);
        ts::return_shared(proposal);
        ts::end(s);
    }

    #[test]
    #[expected_failure(abort_code = E_CTO_ALREADY_RESOLVED, location = suipump::bonding_curve)]
    fun test_cto_vote_on_resolved_aborts() {
        let mut s = begin_cto();
        buy_bag(&mut s, VOTER_A, 2_000 * MIST_PER_SUI);
        buy_bag(&mut s, VOTER_B, 2_000 * MIST_PER_SUI);

        ts::next_tx(&mut s, VOTER_A);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        let bag_a = ts::take_from_address<Coin<TEST_TOKEN>>(&s, VOTER_A);
        let mut clk = clock::create_for_testing(ts::ctx(&mut s));
        clock::set_for_testing(&mut clk, CTO_INACTIVITY_MS + 1);
        bonding_curve::propose_takeover(&mut curve, bag_a, &clk, ts::ctx(&mut s));
        clock::destroy_for_testing(clk);
        ts::return_shared(curve);

        // Resolve after the window closes.
        ts::next_tx(&mut s, BUYER);
        let mut proposal = ts::take_shared<bonding_curve::TakeoverProposal<TEST_TOKEN>>(&s);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        let mut clk = clock::create_for_testing(ts::ctx(&mut s));
        clock::set_for_testing(&mut clk, CTO_INACTIVITY_MS + CTO_WINDOW_MS + 2);
        bonding_curve::resolve_takeover(&mut proposal, &mut curve, &clk, ts::ctx(&mut s));
        clock::destroy_for_testing(clk);
        ts::return_shared(curve);
        ts::return_shared(proposal);

        // Voting a resolved proposal -> abort (resolved check precedes deadline).
        ts::next_tx(&mut s, VOTER_B);
        let mut proposal = ts::take_shared<bonding_curve::TakeoverProposal<TEST_TOKEN>>(&s);
        let bag_b = ts::take_from_address<Coin<TEST_TOKEN>>(&s, VOTER_B);
        let mut clk = clock::create_for_testing(ts::ctx(&mut s));
        clock::set_for_testing(&mut clk, CTO_INACTIVITY_MS + CTO_WINDOW_MS + 3);
        bonding_curve::vote_takeover(&mut proposal, bag_b, &clk, ts::ctx(&mut s));
        clock::destroy_for_testing(clk);
        ts::return_shared(proposal);
        ts::end(s);
    }

    #[test]
    fun test_cto_unvote_returns_exact_and_decrements() {
        let mut s = begin_cto();
        buy_bag(&mut s, VOTER_A, 2_000 * MIST_PER_SUI);
        buy_bag(&mut s, VOTER_B, 2_000 * MIST_PER_SUI);

        ts::next_tx(&mut s, VOTER_A);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        let bag_a = ts::take_from_address<Coin<TEST_TOKEN>>(&s, VOTER_A);
        let a_amt = coin::value(&bag_a);
        let mut clk = clock::create_for_testing(ts::ctx(&mut s));
        clock::set_for_testing(&mut clk, CTO_INACTIVITY_MS + 1);
        bonding_curve::propose_takeover(&mut curve, bag_a, &clk, ts::ctx(&mut s));
        clock::destroy_for_testing(clk);
        ts::return_shared(curve);

        ts::next_tx(&mut s, VOTER_B);
        let mut proposal = ts::take_shared<bonding_curve::TakeoverProposal<TEST_TOKEN>>(&s);
        let bag_b = ts::take_from_address<Coin<TEST_TOKEN>>(&s, VOTER_B);
        let b_amt = coin::value(&bag_b);
        let mut clk = clock::create_for_testing(ts::ctx(&mut s));
        clock::set_for_testing(&mut clk, CTO_INACTIVITY_MS + 2);
        bonding_curve::vote_takeover(&mut proposal, bag_b, &clk, ts::ctx(&mut s));
        assert!(bonding_curve::proposal_total_weight(&proposal) == a_amt + b_amt, 9520);
        assert!(bonding_curve::proposal_escrow_value(&proposal) == a_amt + b_amt, 9521);
        clock::destroy_for_testing(clk);
        ts::return_shared(proposal);

        // B unvotes BEFORE the deadline: exact escrow returned, weight decremented.
        ts::next_tx(&mut s, VOTER_B);
        let mut proposal = ts::take_shared<bonding_curve::TakeoverProposal<TEST_TOKEN>>(&s);
        let mut clk = clock::create_for_testing(ts::ctx(&mut s));
        clock::set_for_testing(&mut clk, CTO_INACTIVITY_MS + 3);
        bonding_curve::unvote_takeover(&mut proposal, &clk, ts::ctx(&mut s));
        assert!(bonding_curve::proposal_total_weight(&proposal) == a_amt, 9522);
        assert!(bonding_curve::proposal_escrow_value(&proposal) == a_amt, 9523);
        assert!(!bonding_curve::proposal_has_voter(&proposal, VOTER_B), 9524);
        clock::destroy_for_testing(clk);
        ts::return_shared(proposal);

        ts::next_tx(&mut s, VOTER_B);
        let refunded = ts::take_from_address<Coin<TEST_TOKEN>>(&s, VOTER_B);
        assert!(coin::value(&refunded) == b_amt, 9525);
        destroy(refunded);
        ts::end(s);
    }

    #[test]
    #[expected_failure(abort_code = E_CTO_VOTE_CLOSED, location = suipump::bonding_curve)]
    fun test_cto_unvote_after_deadline_aborts() {
        let mut s = begin_cto();
        buy_bag(&mut s, VOTER_A, 2_000 * MIST_PER_SUI);
        buy_bag(&mut s, VOTER_B, 2_000 * MIST_PER_SUI);

        ts::next_tx(&mut s, VOTER_A);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        let bag_a = ts::take_from_address<Coin<TEST_TOKEN>>(&s, VOTER_A);
        let mut clk = clock::create_for_testing(ts::ctx(&mut s));
        clock::set_for_testing(&mut clk, CTO_INACTIVITY_MS + 1);
        bonding_curve::propose_takeover(&mut curve, bag_a, &clk, ts::ctx(&mut s));
        clock::destroy_for_testing(clk);
        ts::return_shared(curve);

        ts::next_tx(&mut s, VOTER_B);
        let mut proposal = ts::take_shared<bonding_curve::TakeoverProposal<TEST_TOKEN>>(&s);
        let bag_b = ts::take_from_address<Coin<TEST_TOKEN>>(&s, VOTER_B);
        let mut clk = clock::create_for_testing(ts::ctx(&mut s));
        clock::set_for_testing(&mut clk, CTO_INACTIVITY_MS + 2);
        bonding_curve::vote_takeover(&mut proposal, bag_b, &clk, ts::ctx(&mut s));
        clock::destroy_for_testing(clk);
        ts::return_shared(proposal);

        // Unvote AFTER the deadline -> abort (no post-deadline weight withdrawal).
        ts::next_tx(&mut s, VOTER_B);
        let mut proposal = ts::take_shared<bonding_curve::TakeoverProposal<TEST_TOKEN>>(&s);
        let mut clk = clock::create_for_testing(ts::ctx(&mut s));
        clock::set_for_testing(&mut clk, CTO_INACTIVITY_MS + CTO_WINDOW_MS + 2);
        bonding_curve::unvote_takeover(&mut proposal, &clk, ts::ctx(&mut s));
        clock::destroy_for_testing(clk);
        ts::return_shared(proposal);
        ts::end(s);
    }

    #[test]
    #[expected_failure(abort_code = E_CTO_VOTE_STILL_OPEN, location = suipump::bonding_curve)]
    fun test_cto_resolve_before_deadline_aborts() {
        let mut s = begin_cto();
        buy_bag(&mut s, VOTER_A, 3_000 * MIST_PER_SUI);

        ts::next_tx(&mut s, VOTER_A);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        let bag_a = ts::take_from_address<Coin<TEST_TOKEN>>(&s, VOTER_A);
        let mut clk = clock::create_for_testing(ts::ctx(&mut s));
        clock::set_for_testing(&mut clk, CTO_INACTIVITY_MS + 1);
        bonding_curve::propose_takeover(&mut curve, bag_a, &clk, ts::ctx(&mut s));
        clock::destroy_for_testing(clk);
        ts::return_shared(curve);

        ts::next_tx(&mut s, BUYER);
        let mut proposal = ts::take_shared<bonding_curve::TakeoverProposal<TEST_TOKEN>>(&s);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        let mut clk = clock::create_for_testing(ts::ctx(&mut s));
        clock::set_for_testing(&mut clk, CTO_INACTIVITY_MS + 2); // still before deadline
        bonding_curve::resolve_takeover(&mut proposal, &mut curve, &clk, ts::ctx(&mut s));
        clock::destroy_for_testing(clk);
        ts::return_shared(curve);
        ts::return_shared(proposal);
        ts::end(s);
    }

    // Intent preserved from the old test_cto_swap_revokes_old_creator: a passing
    // takeover swaps the cap and REVOKES the old creator's cap.
    #[test]
    #[expected_failure(abort_code = E_NOT_ACTIVE_CREATOR, location = suipump::bonding_curve)]
    fun test_cto_resolve_success_swaps_cap() {
        let mut s = begin_cto();
        buy_bag(&mut s, VOTER_A, 3_000 * MIST_PER_SUI);

        // A proposes with the full bag (~all circulating -> clears the 25% quorum).
        ts::next_tx(&mut s, VOTER_A);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        let bag_a = ts::take_from_address<Coin<TEST_TOKEN>>(&s, VOTER_A);
        let mut clk = clock::create_for_testing(ts::ctx(&mut s));
        clock::set_for_testing(&mut clk, CTO_INACTIVITY_MS + 1);
        bonding_curve::propose_takeover(&mut curve, bag_a, &clk, ts::ctx(&mut s));
        clock::destroy_for_testing(clk);
        ts::return_shared(curve);

        // Resolve after the window -> success, cap swapped to VOTER_A.
        ts::next_tx(&mut s, BUYER);
        let mut proposal = ts::take_shared<bonding_curve::TakeoverProposal<TEST_TOKEN>>(&s);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        let mut clk = clock::create_for_testing(ts::ctx(&mut s));
        clock::set_for_testing(&mut clk, CTO_INACTIVITY_MS + CTO_WINDOW_MS + 2);
        bonding_curve::resolve_takeover(&mut proposal, &mut curve, &clk, ts::ctx(&mut s));
        assert!(bonding_curve::proposal_succeeded(&proposal), 9530);
        assert!(bonding_curve::proposal_resolved(&proposal), 9531);
        ts::return_shared(proposal);

        // The OLD creator's cap must now FAIL a gated call (revoked by the swap).
        ts::next_tx(&mut s, CREATOR);
        let old_cap = ts::take_from_address<CreatorCap>(&s, CREATOR);
        bonding_curve::creator_heartbeat(&old_cap, &mut curve, &clk, ts::ctx(&mut s));

        ts::return_to_address(CREATOR, old_cap);
        clock::destroy_for_testing(clk);
        ts::return_shared(curve);
        ts::end(s);
    }

    // A takeover BELOW quorum fails: incumbent keeps the cap, cooldown starts.
    #[test]
    fun test_cto_resolve_failure_below_quorum() {
        let mut s = begin_cto();
        buy_bag(&mut s, VOTER_A, 3_000 * MIST_PER_SUI);

        ts::next_tx(&mut s, VOTER_A);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        let mut bag = ts::take_from_address<Coin<TEST_TOKEN>>(&s, VOTER_A);
        let circ = bonding_curve::cto_circulating_supply(&curve);
        let slice = (circ * 100) / 10_000; // 1% (>= nominate, < 25% quorum)
        let stake = coin::split(&mut bag, slice, ts::ctx(&mut s));
        destroy(bag);
        let mut clk = clock::create_for_testing(ts::ctx(&mut s));
        clock::set_for_testing(&mut clk, CTO_INACTIVITY_MS + 1);
        bonding_curve::propose_takeover(&mut curve, stake, &clk, ts::ctx(&mut s));
        clock::destroy_for_testing(clk);
        ts::return_shared(curve);

        // Resolve after the window -> FAIL.
        ts::next_tx(&mut s, BUYER);
        let mut proposal = ts::take_shared<bonding_curve::TakeoverProposal<TEST_TOKEN>>(&s);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        let mut clk = clock::create_for_testing(ts::ctx(&mut s));
        clock::set_for_testing(&mut clk, CTO_INACTIVITY_MS + CTO_WINDOW_MS + 2);
        bonding_curve::resolve_takeover(&mut proposal, &mut curve, &clk, ts::ctx(&mut s));
        assert!(!bonding_curve::proposal_succeeded(&proposal), 9540);
        assert!(bonding_curve::proposal_resolved(&proposal), 9541);
        assert!(bonding_curve::cto_cooldown_until_ms(&curve) > 0, 9542);
        ts::return_shared(proposal);

        // The OLD creator's cap STILL works (heartbeat succeeds -> no abort).
        ts::next_tx(&mut s, CREATOR);
        let old_cap = ts::take_from_address<CreatorCap>(&s, CREATOR);
        bonding_curve::creator_heartbeat(&old_cap, &mut curve, &clk, ts::ctx(&mut s));
        ts::return_to_address(CREATOR, old_cap);
        clock::destroy_for_testing(clk);
        ts::return_shared(curve);
        ts::end(s);
    }

    #[test]
    #[expected_failure(abort_code = E_CTO_ALREADY_RESOLVED, location = suipump::bonding_curve)]
    fun test_cto_resolve_twice_aborts() {
        let mut s = begin_cto();
        buy_bag(&mut s, VOTER_A, 3_000 * MIST_PER_SUI);

        ts::next_tx(&mut s, VOTER_A);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        let bag_a = ts::take_from_address<Coin<TEST_TOKEN>>(&s, VOTER_A);
        let mut clk = clock::create_for_testing(ts::ctx(&mut s));
        clock::set_for_testing(&mut clk, CTO_INACTIVITY_MS + 1);
        bonding_curve::propose_takeover(&mut curve, bag_a, &clk, ts::ctx(&mut s));
        clock::destroy_for_testing(clk);
        ts::return_shared(curve);

        ts::next_tx(&mut s, BUYER);
        let mut proposal = ts::take_shared<bonding_curve::TakeoverProposal<TEST_TOKEN>>(&s);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        let mut clk = clock::create_for_testing(ts::ctx(&mut s));
        clock::set_for_testing(&mut clk, CTO_INACTIVITY_MS + CTO_WINDOW_MS + 2);
        bonding_curve::resolve_takeover(&mut proposal, &mut curve, &clk, ts::ctx(&mut s));
        // Second resolve -> abort.
        bonding_curve::resolve_takeover(&mut proposal, &mut curve, &clk, ts::ctx(&mut s));
        clock::destroy_for_testing(clk);
        ts::return_shared(curve);
        ts::return_shared(proposal);
        ts::end(s);
    }

    #[test]
    fun test_cto_reclaim_after_success_returns_all() {
        let mut s = begin_cto();
        buy_bag(&mut s, VOTER_A, 2_000 * MIST_PER_SUI);
        buy_bag(&mut s, VOTER_B, 2_000 * MIST_PER_SUI);

        ts::next_tx(&mut s, VOTER_A);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        let bag_a = ts::take_from_address<Coin<TEST_TOKEN>>(&s, VOTER_A);
        let a_amt = coin::value(&bag_a);
        let mut clk = clock::create_for_testing(ts::ctx(&mut s));
        clock::set_for_testing(&mut clk, CTO_INACTIVITY_MS + 1);
        bonding_curve::propose_takeover(&mut curve, bag_a, &clk, ts::ctx(&mut s));
        clock::destroy_for_testing(clk);
        ts::return_shared(curve);

        ts::next_tx(&mut s, VOTER_B);
        let mut proposal = ts::take_shared<bonding_curve::TakeoverProposal<TEST_TOKEN>>(&s);
        let bag_b = ts::take_from_address<Coin<TEST_TOKEN>>(&s, VOTER_B);
        let b_amt = coin::value(&bag_b);
        let mut clk = clock::create_for_testing(ts::ctx(&mut s));
        clock::set_for_testing(&mut clk, CTO_INACTIVITY_MS + 2);
        bonding_curve::vote_takeover(&mut proposal, bag_b, &clk, ts::ctx(&mut s));
        clock::destroy_for_testing(clk);
        ts::return_shared(proposal);

        // Resolve (success), then reclaim BOTH voters from a permissionless caller.
        ts::next_tx(&mut s, BUYER);
        let mut proposal = ts::take_shared<bonding_curve::TakeoverProposal<TEST_TOKEN>>(&s);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        let mut clk = clock::create_for_testing(ts::ctx(&mut s));
        clock::set_for_testing(&mut clk, CTO_INACTIVITY_MS + CTO_WINDOW_MS + 2);
        bonding_curve::resolve_takeover(&mut proposal, &mut curve, &clk, ts::ctx(&mut s));
        assert!(bonding_curve::proposal_succeeded(&proposal), 9550);
        clock::destroy_for_testing(clk);
        ts::return_shared(curve);
        bonding_curve::reclaim_vote(&mut proposal, VOTER_A, ts::ctx(&mut s));
        bonding_curve::reclaim_vote(&mut proposal, VOTER_B, ts::ctx(&mut s));
        assert!(bonding_curve::proposal_escrow_value(&proposal) == 0, 9551);
        assert!(!bonding_curve::proposal_has_voter(&proposal, VOTER_A), 9552);
        assert!(!bonding_curve::proposal_has_voter(&proposal, VOTER_B), 9553);
        ts::return_shared(proposal);

        ts::next_tx(&mut s, BUYER);
        let ra = ts::take_from_address<Coin<TEST_TOKEN>>(&s, VOTER_A);
        let rb = ts::take_from_address<Coin<TEST_TOKEN>>(&s, VOTER_B);
        assert!(coin::value(&ra) == a_amt, 9554);
        assert!(coin::value(&rb) == b_amt, 9555);
        destroy(ra);
        destroy(rb);
        ts::end(s);
    }

    #[test]
    fun test_cto_reclaim_after_failure_returns_all() {
        let mut s = begin_cto();
        buy_bag(&mut s, VOTER_A, 2_000 * MIST_PER_SUI);
        buy_bag(&mut s, VOTER_B, 2_000 * MIST_PER_SUI);

        ts::next_tx(&mut s, VOTER_A);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        let mut bag_a = ts::take_from_address<Coin<TEST_TOKEN>>(&s, VOTER_A);
        let circ = bonding_curve::cto_circulating_supply(&curve);
        let slice = (circ * 100) / 10_000; // 1% each -> 2% combined < 25% quorum
        let stake_a = coin::split(&mut bag_a, slice, ts::ctx(&mut s));
        destroy(bag_a);
        let mut clk = clock::create_for_testing(ts::ctx(&mut s));
        clock::set_for_testing(&mut clk, CTO_INACTIVITY_MS + 1);
        bonding_curve::propose_takeover(&mut curve, stake_a, &clk, ts::ctx(&mut s));
        clock::destroy_for_testing(clk);
        ts::return_shared(curve);

        ts::next_tx(&mut s, VOTER_B);
        let mut proposal = ts::take_shared<bonding_curve::TakeoverProposal<TEST_TOKEN>>(&s);
        let mut bag_b = ts::take_from_address<Coin<TEST_TOKEN>>(&s, VOTER_B);
        let vote_b = coin::split(&mut bag_b, slice, ts::ctx(&mut s));
        destroy(bag_b);
        let mut clk = clock::create_for_testing(ts::ctx(&mut s));
        clock::set_for_testing(&mut clk, CTO_INACTIVITY_MS + 2);
        bonding_curve::vote_takeover(&mut proposal, vote_b, &clk, ts::ctx(&mut s));
        clock::destroy_for_testing(clk);
        ts::return_shared(proposal);

        // Resolve (fail), reclaim both.
        ts::next_tx(&mut s, BUYER);
        let mut proposal = ts::take_shared<bonding_curve::TakeoverProposal<TEST_TOKEN>>(&s);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        let mut clk = clock::create_for_testing(ts::ctx(&mut s));
        clock::set_for_testing(&mut clk, CTO_INACTIVITY_MS + CTO_WINDOW_MS + 2);
        bonding_curve::resolve_takeover(&mut proposal, &mut curve, &clk, ts::ctx(&mut s));
        assert!(!bonding_curve::proposal_succeeded(&proposal), 9560);
        clock::destroy_for_testing(clk);
        ts::return_shared(curve);
        bonding_curve::reclaim_vote(&mut proposal, VOTER_A, ts::ctx(&mut s));
        bonding_curve::reclaim_vote(&mut proposal, VOTER_B, ts::ctx(&mut s));
        assert!(bonding_curve::proposal_escrow_value(&proposal) == 0, 9561);
        ts::return_shared(proposal);

        ts::next_tx(&mut s, BUYER);
        let ra = ts::take_from_address<Coin<TEST_TOKEN>>(&s, VOTER_A);
        let rb = ts::take_from_address<Coin<TEST_TOKEN>>(&s, VOTER_B);
        assert!(coin::value(&ra) == slice, 9562);
        assert!(coin::value(&rb) == slice, 9563);
        destroy(ra);
        destroy(rb);
        ts::end(s);
    }

    #[test]
    fun test_cto_reclaim_pays_voter_not_caller() {
        let mut s = begin_cto();
        buy_bag(&mut s, VOTER_A, 3_000 * MIST_PER_SUI);

        ts::next_tx(&mut s, VOTER_A);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        let bag_a = ts::take_from_address<Coin<TEST_TOKEN>>(&s, VOTER_A);
        let a_amt = coin::value(&bag_a);
        let mut clk = clock::create_for_testing(ts::ctx(&mut s));
        clock::set_for_testing(&mut clk, CTO_INACTIVITY_MS + 1);
        bonding_curve::propose_takeover(&mut curve, bag_a, &clk, ts::ctx(&mut s));
        clock::destroy_for_testing(clk);
        ts::return_shared(curve);

        ts::next_tx(&mut s, BUYER);
        let mut proposal = ts::take_shared<bonding_curve::TakeoverProposal<TEST_TOKEN>>(&s);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        let mut clk = clock::create_for_testing(ts::ctx(&mut s));
        clock::set_for_testing(&mut clk, CTO_INACTIVITY_MS + CTO_WINDOW_MS + 2);
        bonding_curve::resolve_takeover(&mut proposal, &mut curve, &clk, ts::ctx(&mut s));
        clock::destroy_for_testing(clk);
        ts::return_shared(curve);
        ts::return_shared(proposal);

        // A DIFFERENT sender (REFERRER) reclaims FOR VOTER_A.
        ts::next_tx(&mut s, REFERRER);
        let mut proposal = ts::take_shared<bonding_curve::TakeoverProposal<TEST_TOKEN>>(&s);
        bonding_curve::reclaim_vote(&mut proposal, VOTER_A, ts::ctx(&mut s));
        ts::return_shared(proposal);

        // VOTER_A received the funds; the caller REFERRER did NOT.
        ts::next_tx(&mut s, VOTER_A);
        assert!(!ts::has_most_recent_for_address<Coin<TEST_TOKEN>>(REFERRER), 9570);
        let ra = ts::take_from_address<Coin<TEST_TOKEN>>(&s, VOTER_A);
        assert!(coin::value(&ra) == a_amt, 9571);
        destroy(ra);
        ts::end(s);
    }

    #[test]
    #[expected_failure(abort_code = E_CTO_NOT_VOTER, location = suipump::bonding_curve)]
    fun test_cto_double_reclaim_aborts() {
        let mut s = begin_cto();
        buy_bag(&mut s, VOTER_A, 3_000 * MIST_PER_SUI);

        ts::next_tx(&mut s, VOTER_A);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        let bag_a = ts::take_from_address<Coin<TEST_TOKEN>>(&s, VOTER_A);
        let mut clk = clock::create_for_testing(ts::ctx(&mut s));
        clock::set_for_testing(&mut clk, CTO_INACTIVITY_MS + 1);
        bonding_curve::propose_takeover(&mut curve, bag_a, &clk, ts::ctx(&mut s));
        clock::destroy_for_testing(clk);
        ts::return_shared(curve);

        ts::next_tx(&mut s, BUYER);
        let mut proposal = ts::take_shared<bonding_curve::TakeoverProposal<TEST_TOKEN>>(&s);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        let mut clk = clock::create_for_testing(ts::ctx(&mut s));
        clock::set_for_testing(&mut clk, CTO_INACTIVITY_MS + CTO_WINDOW_MS + 2);
        bonding_curve::resolve_takeover(&mut proposal, &mut curve, &clk, ts::ctx(&mut s));
        clock::destroy_for_testing(clk);
        ts::return_shared(curve);
        bonding_curve::reclaim_vote(&mut proposal, VOTER_A, ts::ctx(&mut s));
        // Second reclaim for the same voter -> entry gone -> abort.
        bonding_curve::reclaim_vote(&mut proposal, VOTER_A, ts::ctx(&mut s));
        ts::return_shared(proposal);
        ts::end(s);
    }

    #[test]
    #[expected_failure(abort_code = E_CTO_NOT_RESOLVED, location = suipump::bonding_curve)]
    fun test_cto_reclaim_before_resolve_aborts() {
        let mut s = begin_cto();
        buy_bag(&mut s, VOTER_A, 3_000 * MIST_PER_SUI);

        ts::next_tx(&mut s, VOTER_A);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        let bag_a = ts::take_from_address<Coin<TEST_TOKEN>>(&s, VOTER_A);
        let mut clk = clock::create_for_testing(ts::ctx(&mut s));
        clock::set_for_testing(&mut clk, CTO_INACTIVITY_MS + 1);
        bonding_curve::propose_takeover(&mut curve, bag_a, &clk, ts::ctx(&mut s));
        clock::destroy_for_testing(clk);
        ts::return_shared(curve);

        // Reclaim before resolve -> abort.
        ts::next_tx(&mut s, BUYER);
        let mut proposal = ts::take_shared<bonding_curve::TakeoverProposal<TEST_TOKEN>>(&s);
        bonding_curve::reclaim_vote(&mut proposal, VOTER_A, ts::ctx(&mut s));
        ts::return_shared(proposal);
        ts::end(s);
    }

    #[test]
    #[expected_failure(abort_code = E_CTO_ON_COOLDOWN, location = suipump::bonding_curve)]
    fun test_cto_propose_after_failed_resolve_aborts() {
        let mut s = begin_cto();
        buy_bag(&mut s, VOTER_A, 3_000 * MIST_PER_SUI);

        // Failing proposal (stake 1% only), keep the remainder for a 2nd propose.
        ts::next_tx(&mut s, VOTER_A);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        let mut bag = ts::take_from_address<Coin<TEST_TOKEN>>(&s, VOTER_A);
        let circ = bonding_curve::cto_circulating_supply(&curve);
        let slice = (circ * 100) / 10_000;
        let stake = coin::split(&mut bag, slice, ts::ctx(&mut s));
        transfer::public_transfer(bag, VOTER_A);
        let mut clk = clock::create_for_testing(ts::ctx(&mut s));
        clock::set_for_testing(&mut clk, CTO_INACTIVITY_MS + 1);
        bonding_curve::propose_takeover(&mut curve, stake, &clk, ts::ctx(&mut s));
        clock::destroy_for_testing(clk);
        ts::return_shared(curve);

        // Resolve -> fail -> cooldown set.
        ts::next_tx(&mut s, BUYER);
        let mut proposal = ts::take_shared<bonding_curve::TakeoverProposal<TEST_TOKEN>>(&s);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        let mut clk = clock::create_for_testing(ts::ctx(&mut s));
        clock::set_for_testing(&mut clk, CTO_INACTIVITY_MS + CTO_WINDOW_MS + 2);
        bonding_curve::resolve_takeover(&mut proposal, &mut curve, &clk, ts::ctx(&mut s));
        clock::destroy_for_testing(clk);
        ts::return_shared(proposal);
        ts::return_shared(curve);

        // Re-propose immediately (still within cooldown) -> abort.
        ts::next_tx(&mut s, VOTER_A);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        let bag = ts::take_from_address<Coin<TEST_TOKEN>>(&s, VOTER_A);
        let mut clk = clock::create_for_testing(ts::ctx(&mut s));
        clock::set_for_testing(&mut clk, CTO_INACTIVITY_MS + CTO_WINDOW_MS + 3);
        bonding_curve::propose_takeover(&mut curve, bag, &clk, ts::ctx(&mut s));
        clock::destroy_for_testing(clk);
        ts::return_shared(curve);
        ts::end(s);
    }

    #[test]
    fun test_cto_propose_after_cooldown_succeeds() {
        let mut s = begin_cto();
        buy_bag(&mut s, VOTER_A, 3_000 * MIST_PER_SUI);

        // Failing proposal (stake 1%), keep the remainder.
        ts::next_tx(&mut s, VOTER_A);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        let mut bag = ts::take_from_address<Coin<TEST_TOKEN>>(&s, VOTER_A);
        let circ = bonding_curve::cto_circulating_supply(&curve);
        let slice = (circ * 100) / 10_000;
        let stake = coin::split(&mut bag, slice, ts::ctx(&mut s));
        transfer::public_transfer(bag, VOTER_A);
        let mut clk = clock::create_for_testing(ts::ctx(&mut s));
        clock::set_for_testing(&mut clk, CTO_INACTIVITY_MS + 1);
        bonding_curve::propose_takeover(&mut curve, stake, &clk, ts::ctx(&mut s));
        clock::destroy_for_testing(clk);
        ts::return_shared(curve);

        // Resolve -> fail, capture the cooldown deadline.
        ts::next_tx(&mut s, BUYER);
        let mut proposal = ts::take_shared<bonding_curve::TakeoverProposal<TEST_TOKEN>>(&s);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        let mut clk = clock::create_for_testing(ts::ctx(&mut s));
        clock::set_for_testing(&mut clk, CTO_INACTIVITY_MS + CTO_WINDOW_MS + 2);
        bonding_curve::resolve_takeover(&mut proposal, &mut curve, &clk, ts::ctx(&mut s));
        let cooldown_until = bonding_curve::cto_cooldown_until_ms(&curve);
        clock::destroy_for_testing(clk);
        ts::return_shared(proposal);
        ts::return_shared(curve);

        // After the cooldown, a fresh proposal succeeds and shares a new object.
        ts::next_tx(&mut s, VOTER_A);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        let bag = ts::take_from_address<Coin<TEST_TOKEN>>(&s, VOTER_A);
        let mut clk = clock::create_for_testing(ts::ctx(&mut s));
        clock::set_for_testing(&mut clk, cooldown_until + 1);
        bonding_curve::propose_takeover(&mut curve, bag, &clk, ts::ctx(&mut s));
        clock::destroy_for_testing(clk);
        ts::return_shared(curve);

        ts::next_tx(&mut s, BUYER);
        let new_id = option::destroy_some(
            ts::most_recent_id_shared<bonding_curve::TakeoverProposal<TEST_TOKEN>>()
        );
        let proposal = ts::take_shared_by_id<bonding_curve::TakeoverProposal<TEST_TOKEN>>(&s, new_id);
        assert!(bonding_curve::proposal_proposer(&proposal) == VOTER_A, 9580);
        assert!(!bonding_curve::proposal_resolved(&proposal), 9581);
        ts::return_shared(proposal);
        ts::end(s);
    }

    // Intent preserved from the old test_cto_blocked_while_creator_active.
    #[test]
    #[expected_failure(abort_code = E_CREATOR_STILL_ACTIVE, location = suipump::bonding_curve)]
    fun test_cto_blocked_while_creator_active() {
        let mut s = begin_cto();
        buy_bag(&mut s, VOTER_A, 3_000 * MIST_PER_SUI);

        // Propose at t=0 (creator active < 5 days) -> abort.
        ts::next_tx(&mut s, VOTER_A);
        let mut curve = ts::take_shared<Curve<TEST_TOKEN>>(&s);
        let bag_a = ts::take_from_address<Coin<TEST_TOKEN>>(&s, VOTER_A);
        let clk = clock::create_for_testing(ts::ctx(&mut s)); // t=0
        bonding_curve::propose_takeover(&mut curve, bag_a, &clk, ts::ctx(&mut s));
        clock::destroy_for_testing(clk);
        ts::return_shared(curve);
        ts::end(s);
    }

    // ─── Item 1: AgentSession scope ────────────────────────────────────────

    #[test]
    fun test_agent_session_open_and_buy() {
        use suipump::agent_session;
        let mut s = ts::begin(CREATOR);
        // V13: init shares the PriceConfig that buy() now reads.
        bonding_curve::init_for_testing(ts::ctx(&mut s));
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
        let cfg = ts::take_shared<PriceConfig>(&s);
        agent_session::buy_with_session(
            &mut session, &mut curve, 1 * MIST_PER_SUI, 0, &cfg, &clk, ts::ctx(&mut s),
        );
        // F-5 FIXED: the LP fee now LANDS IN THE RESERVE instead of being handed
        // back to the buyer, so a non-graduating buy returns an EMPTY refund.
        // Escrow is exactly 10 - 1 = 9 SUI and spent is the full 1 SUI.
        //
        // HISTORY: the 9302 assertion previously read `== 1 SUI - 1_000_000`,
        // adjusted to accommodate the F-5 refund. That treated the BUG as the
        // spec - the test was bent to fit broken code rather than left red as a
        // signal. The ORIGINAL `== 1 SUI` was correct all along, and with F-5
        // fixed it is correct again. Same class as the hollowed
        // test_claim_graduation_funds_* bodies (audit F-10).
        let esc_after = agent_session::escrow_value(&session);
        assert!(esc_after == 9 * MIST_PER_SUI, 9301);
        assert!(esc_after < 10 * MIST_PER_SUI, 9303);
        assert!(agent_session::spent(&session) == 1 * MIST_PER_SUI, 9302);

        clock::destroy_for_testing(clk);
        ts::return_shared(cfg);
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
        // V13: init shares the PriceConfig that buy() now reads.
        bonding_curve::init_for_testing(ts::ctx(&mut s));
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
        let cfg = ts::take_shared<PriceConfig>(&s);
        agent_session::buy_with_session(
            &mut session, &mut curve, 1 * MIST_PER_SUI, 0, &cfg, &clk, ts::ctx(&mut s),
        );

        clock::destroy_for_testing(clk);
        ts::return_shared(cfg);
        ts::return_shared(curve);
        transfer::public_share_object(session);
        ts::end(s);
    }

}
