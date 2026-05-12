/// suipump_test::bonding_curve_test
///
/// Throwaway test contract — identical to production bonding_curve.move
/// except graduation triggers at >= 10 SUI in the reserve instead of
/// requiring token_reserve == 0.
///
/// Deploy this as a SEPARATE package. It has nothing to do with the live
/// v4 package. Use config_test.js to point scripts at this package.
///
/// After DeepBook graduation testing is done, discard this package.
/// Never deploy this to mainnet.
module suipump_test::bonding_curve_test {
    use sui::balance::{Self, Balance};
    use sui::coin::{Self, Coin, TreasuryCap};
    use sui::event;
    use sui::sui::SUI;
    use std::ascii::String as AsciiString;
    use std::string::String;

    // ---------- Errors ----------
    const EInsufficientTokens: u64 = 2;
    const ESlippageExceeded: u64 = 3;
    const EAlreadyGraduated: u64 = 4;
    const ENotGraduated: u64 = 5;
    const EZeroAmount: u64 = 7;
    const ENoFees: u64 = 8;
    const EFeeSplitInvalid: u64 = 9;
    const EPayoutsSumInvalid: u64 = 10;
    const EPayoutsEmpty: u64 = 11;
    const ETooManyPayouts: u64 = 12;
    const EDuplicatePayoutAddress: u64 = 13;
    const EWrongLaunchFee: u64 = 14;
    const ECapMismatch: u64 = 15;
    const ECommentTooLong: u64 = 16;
    const ECommentEmpty: u64 = 17;

    const MAX_COMMENT_BYTES: u64 = 280;

    // ---------- Fee tunables ----------
    const TRADE_FEE_BPS: u64 = 100;
    const CREATOR_SHARE_BPS: u64 = 4_000;
    const PROTOCOL_SHARE_BPS: u64 = 5_000;
    const LP_SHARE_BPS: u64 = 1_000;
    const CREATOR_GRAD_BONUS_BPS: u64 = 50;
    const PROTOCOL_GRAD_BONUS_BPS: u64 = 50;
    const LAUNCH_FEE_MIST: u64 = 2 * 1_000_000_000;
    const MAX_PAYOUTS: u64 = 10;

    const TOTAL_SUPPLY: u64 = 1_000_000_000 * 1_000_000;
    const CURVE_SUPPLY: u64 = 800_000_000 * 1_000_000;
    const VIRTUAL_SUI_RESERVE: u64 = 30_000 * 1_000_000_000;
    const VIRTUAL_TOKEN_RESERVE: u64 = 1_073_000_000 * 1_000_000;

    const BPS_DENOMINATOR: u64 = 10_000;

    /// TEST ONLY — graduation allowed once sui_reserve >= 10 SUI.
    /// In production this is ~87,900 SUI (full drain).
    const TEST_GRAD_THRESHOLD_MIST: u64 = 10 * 1_000_000_000;

    // ---------- One-time witness ----------
    public struct BONDING_CURVE_TEST has drop {}

    // ---------- Admin capability ----------
    public struct AdminCap has key, store {
        id: UID,
    }

    // ---------- Creator capability ----------
    public struct CreatorCap has key, store {
        id: UID,
        curve_id: ID,
    }

    public struct Payout has copy, drop, store {
        recipient: address,
        bps: u64,
    }

    fun init(_witness: BONDING_CURVE_TEST, ctx: &mut TxContext) {
        assert!(
            CREATOR_SHARE_BPS + PROTOCOL_SHARE_BPS + LP_SHARE_BPS == BPS_DENOMINATOR,
            EFeeSplitInvalid,
        );
        let cap = AdminCap { id: object::new(ctx) };
        transfer::public_transfer(cap, tx_context::sender(ctx));
    }

    // ---------- Core object ----------
    public struct Curve<phantom T> has key {
        id: UID,
        sui_reserve: Balance<SUI>,
        token_reserve: Balance<T>,
        treasury: TreasuryCap<T>,
        creator: address,
        payouts: vector<Payout>,
        creator_fees: Balance<SUI>,
        protocol_fees: Balance<SUI>,
        graduated: bool,
        name: String,
        symbol: AsciiString,
    }

    // ---------- Events ----------
    public struct CurveCreated has copy, drop {
        curve_id: ID,
        creator: address,
        name: String,
        symbol: AsciiString,
    }

    public struct TokensPurchased has copy, drop {
        curve_id: ID,
        buyer: address,
        sui_in: u64,
        tokens_out: u64,
        creator_fee: u64,
        protocol_fee: u64,
        lp_fee: u64,
        new_sui_reserve: u64,
        new_token_reserve: u64,
    }

    public struct TokensSold has copy, drop {
        curve_id: ID,
        seller: address,
        tokens_in: u64,
        sui_out: u64,
        creator_fee: u64,
        protocol_fee: u64,
        lp_fee: u64,
        new_sui_reserve: u64,
        new_token_reserve: u64,
    }

    public struct Graduated has copy, drop {
        curve_id: ID,
        final_sui_reserve: u64,
        creator_bonus: u64,
        protocol_bonus: u64,
    }

    public struct CreatorFeesClaimed has copy, drop {
        curve_id: ID,
        creator: address,
        amount: u64,
    }

    public struct ProtocolFeesClaimed has copy, drop {
        curve_id: ID,
        amount: u64,
    }

    public struct LaunchFeeCollected has copy, drop {
        curve_id: ID,
        amount: u64,
    }

    public struct Comment has copy, drop {
        curve_id: ID,
        author:   address,
        text:     String,
    }

    // ---------- Creation ----------
    public fun create<T>(
        mut treasury: TreasuryCap<T>,
        name: String,
        symbol: AsciiString,
        creator: address,
        ctx: &mut TxContext,
    ) {
        let token_balance = coin::mint_balance(&mut treasury, CURVE_SUPPLY);
        let mut payouts = vector::empty<Payout>();
        vector::push_back(&mut payouts, Payout { recipient: creator, bps: BPS_DENOMINATOR });

        let curve = Curve<T> {
            id: object::new(ctx),
            sui_reserve: balance::zero(),
            token_reserve: token_balance,
            treasury,
            creator,
            payouts,
            creator_fees: balance::zero(),
            protocol_fees: balance::zero(),
            graduated: false,
            name,
            symbol,
        };

        event::emit(CurveCreated {
            curve_id: object::id(&curve),
            creator,
            name: curve.name,
            symbol: curve.symbol,
        });

        transfer::share_object(curve);
    }

    #[allow(lint(self_transfer))]
    public fun create_and_return<T>(
        mut treasury: TreasuryCap<T>,
        payment: Coin<SUI>,
        name: String,
        symbol: AsciiString,
        payout_addresses: vector<address>,
        payout_bps: vector<u64>,
        ctx: &mut TxContext,
    ): (Curve<T>, CreatorCap) {
        assert!(coin::value(&payment) == LAUNCH_FEE_MIST, EWrongLaunchFee);
        let payouts = build_payouts(payout_addresses, payout_bps);

        let token_balance = coin::mint_balance(&mut treasury, CURVE_SUPPLY);
        let creator = tx_context::sender(ctx);

        let mut curve = Curve<T> {
            id: object::new(ctx),
            sui_reserve: balance::zero(),
            token_reserve: token_balance,
            treasury,
            creator,
            payouts,
            creator_fees: balance::zero(),
            protocol_fees: balance::zero(),
            graduated: false,
            name,
            symbol,
        };
        balance::join(&mut curve.protocol_fees, coin::into_balance(payment));

        let cap = CreatorCap {
            id: object::new(ctx),
            curve_id: object::id(&curve),
        };

        event::emit(CurveCreated {
            curve_id: object::id(&curve),
            creator,
            name: curve.name,
            symbol: curve.symbol,
        });
        event::emit(LaunchFeeCollected {
            curve_id: object::id(&curve),
            amount: LAUNCH_FEE_MIST,
        });

        (curve, cap)
    }

    public fun share_curve<T>(curve: Curve<T>) {
        transfer::share_object(curve);
    }

    #[allow(lint(self_transfer))]
    public fun create_with_launch_fee<T>(
        treasury: TreasuryCap<T>,
        payment: Coin<SUI>,
        name: String,
        symbol: AsciiString,
        payout_addresses: vector<address>,
        payout_bps: vector<u64>,
        ctx: &mut TxContext,
    ) {
        let (curve, cap) = create_and_return<T>(
            treasury, payment, name, symbol,
            payout_addresses, payout_bps, ctx,
        );
        transfer::share_object(curve);
        transfer::public_transfer(cap, tx_context::sender(ctx));
    }

    fun build_payouts(
        addresses: vector<address>,
        bps_values: vector<u64>,
    ): vector<Payout> {
        let n = vector::length(&addresses);
        assert!(n == vector::length(&bps_values), EPayoutsSumInvalid);
        assert!(n > 0, EPayoutsEmpty);
        assert!(n <= MAX_PAYOUTS, ETooManyPayouts);

        let mut out = vector::empty<Payout>();
        let mut sum: u64 = 0;
        let mut i: u64 = 0;
        while (i < n) {
            let addr = *vector::borrow(&addresses, i);
            let share = *vector::borrow(&bps_values, i);

            let mut j: u64 = 0;
            let m = vector::length(&out);
            while (j < m) {
                let existing = vector::borrow(&out, j);
                assert!(existing.recipient != addr, EDuplicatePayoutAddress);
                j = j + 1;
            };

            vector::push_back(&mut out, Payout { recipient: addr, bps: share });
            sum = sum + share;
            i = i + 1;
        };
        assert!(sum == BPS_DENOMINATOR, EPayoutsSumInvalid);
        out
    }

    // ---------- Pricing math ----------
    fun quote_out(dx: u64, x_reserve: u64, y_reserve: u64): u64 {
        let dx_u128 = dx as u128;
        let x_u128 = x_reserve as u128;
        let y_u128 = y_reserve as u128;
        ((y_u128 * dx_u128) / (x_u128 + dx_u128)) as u64
    }

    fun effective_sui_reserve<T>(c: &Curve<T>): u64 {
        balance::value(&c.sui_reserve) + VIRTUAL_SUI_RESERVE
    }

    fun effective_token_reserve<T>(c: &Curve<T>): u64 {
        let sold = CURVE_SUPPLY - balance::value(&c.token_reserve);
        VIRTUAL_TOKEN_RESERVE - sold
    }

    fun split_fee(fee: u64): (u64, u64, u64) {
        let creator = (fee * CREATOR_SHARE_BPS) / BPS_DENOMINATOR;
        let protocol = (fee * PROTOCOL_SHARE_BPS) / BPS_DENOMINATOR;
        let lp = fee - creator - protocol;
        (creator, protocol, lp)
    }

    // ---------- Buy ----------
    public fun buy<T>(
        curve: &mut Curve<T>,
        mut payment: Coin<SUI>,
        min_tokens_out: u64,
        ctx: &mut TxContext,
    ): (Coin<T>, Coin<SUI>) {
        assert!(!curve.graduated, EAlreadyGraduated);
        let sui_in = coin::value(&payment);
        assert!(sui_in > 0, EZeroAmount);

        let fee_amount = (sui_in * TRADE_FEE_BPS) / BPS_DENOMINATOR;
        let (creator_fee, protocol_fee, lp_fee) = split_fee(fee_amount);
        let swap_amount = sui_in - fee_amount;

        let x = effective_sui_reserve(curve);
        let y = effective_token_reserve(curve);
        let naive_tokens_out = quote_out(swap_amount, x, y);

        let remaining = balance::value(&curve.token_reserve);
        let (tokens_out, actual_swap) = if (naive_tokens_out > remaining) {
            let needed = (((x as u128) * (remaining as u128))
                          / ((y as u128) - (remaining as u128))) as u64;
            (remaining, needed)
        } else {
            (naive_tokens_out, swap_amount)
        };

        assert!(tokens_out >= min_tokens_out, ESlippageExceeded);

        let creator_coin = coin::split(&mut payment, creator_fee, ctx);
        let protocol_coin = coin::split(&mut payment, protocol_fee, ctx);
        balance::join(&mut curve.creator_fees, coin::into_balance(creator_coin));
        balance::join(&mut curve.protocol_fees, coin::into_balance(protocol_coin));

        let to_reserve = actual_swap + lp_fee;
        let reserve_coin = coin::split(&mut payment, to_reserve, ctx);
        balance::join(&mut curve.sui_reserve, coin::into_balance(reserve_coin));

        let out_balance = balance::split(&mut curve.token_reserve, tokens_out);

        event::emit(TokensPurchased {
            curve_id: object::id(curve),
            buyer: tx_context::sender(ctx),
            sui_in,
            tokens_out,
            creator_fee,
            protocol_fee,
            lp_fee,
            new_sui_reserve: balance::value(&curve.sui_reserve),
            new_token_reserve: balance::value(&curve.token_reserve),
        });

        (coin::from_balance(out_balance, ctx), payment)
    }

    // ---------- Sell ----------
    public fun sell<T>(
        curve: &mut Curve<T>,
        tokens_in: Coin<T>,
        min_sui_out: u64,
        ctx: &mut TxContext,
    ): Coin<SUI> {
        assert!(!curve.graduated, EAlreadyGraduated);
        let amount_in = coin::value(&tokens_in);
        assert!(amount_in > 0, EZeroAmount);

        let x = effective_token_reserve(curve);
        let y = effective_sui_reserve(curve);
        let gross_sui_out = quote_out(amount_in, x, y);

        let fee_amount = (gross_sui_out * TRADE_FEE_BPS) / BPS_DENOMINATOR;
        let (creator_fee, protocol_fee, lp_fee) = split_fee(fee_amount);
        let net_sui_out = gross_sui_out - fee_amount;
        assert!(net_sui_out >= min_sui_out, ESlippageExceeded);

        let withdraw_amount = gross_sui_out - lp_fee;
        assert!(withdraw_amount <= balance::value(&curve.sui_reserve), EInsufficientTokens);

        balance::join(&mut curve.token_reserve, coin::into_balance(tokens_in));

        let mut out_bal = balance::split(&mut curve.sui_reserve, withdraw_amount);
        let creator_bal = balance::split(&mut out_bal, creator_fee);
        let protocol_bal = balance::split(&mut out_bal, protocol_fee);
        balance::join(&mut curve.creator_fees, creator_bal);
        balance::join(&mut curve.protocol_fees, protocol_bal);

        event::emit(TokensSold {
            curve_id: object::id(curve),
            seller: tx_context::sender(ctx),
            tokens_in: amount_in,
            sui_out: net_sui_out,
            creator_fee,
            protocol_fee,
            lp_fee,
            new_sui_reserve: balance::value(&curve.sui_reserve),
            new_token_reserve: balance::value(&curve.token_reserve),
        });

        coin::from_balance(out_bal, ctx)
    }

    // ---------- Fee claims ----------
    public fun claim_creator_fees<T>(
        cap: &CreatorCap,
        curve: &mut Curve<T>,
        ctx: &mut TxContext,
    ) {
        assert!(cap.curve_id == object::id(curve), ECapMismatch);
        let total = balance::value(&curve.creator_fees);
        assert!(total > 0, ENoFees);

        let n = vector::length(&curve.payouts);
        let mut i: u64 = 0;
        let mut paid: u64 = 0;
        while (i < n) {
            let payout = vector::borrow(&curve.payouts, i);
            let amount = if (i == n - 1) {
                total - paid
            } else {
                (total * payout.bps) / BPS_DENOMINATOR
            };
            if (amount > 0) {
                let bal = balance::split(&mut curve.creator_fees, amount);
                transfer::public_transfer(
                    coin::from_balance(bal, ctx),
                    payout.recipient,
                );
            };
            paid = paid + amount;
            i = i + 1;
        };

        event::emit(CreatorFeesClaimed {
            curve_id: object::id(curve),
            creator: curve.creator,
            amount: total,
        });
    }

    public fun claim_protocol_fees<T>(
        _cap: &AdminCap,
        curve: &mut Curve<T>,
        ctx: &mut TxContext,
    ): Coin<SUI> {
        let amount = balance::value(&curve.protocol_fees);
        assert!(amount > 0, ENoFees);
        let bal = balance::withdraw_all(&mut curve.protocol_fees);

        event::emit(ProtocolFeesClaimed {
            curve_id: object::id(curve),
            amount,
        });

        coin::from_balance(bal, ctx)
    }

    // ---------- Graduation (TEST — 10 SUI threshold) ----------
    /// Permissionless. In production, graduation requires token_reserve == 0
    /// (~87,900 SUI). Here it triggers once sui_reserve >= 10 SUI so we can
    /// test the DeepBook graduation PTB without buying the whole curve.
    ///
    /// All other graduation mechanics are identical to production.
    #[allow(lint(self_transfer))]
    public fun graduate<T>(
        curve: &mut Curve<T>,
        ctx: &mut TxContext,
    ) {
        assert!(!curve.graduated, EAlreadyGraduated);

        // ── TEST THRESHOLD ─────────────────────────────────────────────────
        // Allow graduation when token_reserve is fully drained OR
        // when sui_reserve has accumulated >= 10 SUI (test shortcut).
        assert!(
            balance::value(&curve.token_reserve) == 0 ||
            balance::value(&curve.sui_reserve) >= TEST_GRAD_THRESHOLD_MIST,
            ENotGraduated,
        );
        // ───────────────────────────────────────────────────────────────────

        curve.graduated = true;

        // Mint the LP-side supply (remaining 20%).
        let lp_supply = TOTAL_SUPPLY - CURVE_SUPPLY;
        let lp_tokens_bal = coin::mint_balance(&mut curve.treasury, lp_supply);

        let total_reserve = balance::value(&curve.sui_reserve);

        // Creator bonus: 0.50% of final reserve → curve.creator
        let creator_bonus_amount =
            (total_reserve * CREATOR_GRAD_BONUS_BPS) / BPS_DENOMINATOR;
        let creator_bonus_bal =
            balance::split(&mut curve.sui_reserve, creator_bonus_amount);
        transfer::public_transfer(
            coin::from_balance(creator_bonus_bal, ctx),
            curve.creator,
        );

        // Protocol bonus: 0.50% of final reserve → protocol_fees
        let protocol_bonus_amount =
            (total_reserve * PROTOCOL_GRAD_BONUS_BPS) / BPS_DENOMINATOR;
        let protocol_bonus_bal =
            balance::split(&mut curve.sui_reserve, protocol_bonus_amount);
        balance::join(&mut curve.protocol_fees, protocol_bonus_bal);

        // Pool SUI stays in sui_reserve — admin claims via claim_graduation_funds()
        // LP tokens → creator
        transfer::public_transfer(
            coin::from_balance(lp_tokens_bal, ctx),
            curve.creator,
        );

        event::emit(Graduated {
            curve_id: object::id(curve),
            final_sui_reserve: total_reserve,
            creator_bonus: creator_bonus_amount,
            protocol_bonus: protocol_bonus_amount,
        });
    }

    /// Admin claims the pool SUI post-graduation for DEX pool composition.
    public fun claim_graduation_funds<T>(
        _cap: &AdminCap,
        curve: &mut Curve<T>,
        ctx: &mut TxContext,
    ): Coin<SUI> {
        assert!(curve.graduated, ENotGraduated);
        let amount = balance::value(&curve.sui_reserve);
        assert!(amount > 0, ENoFees);
        let bal = balance::withdraw_all(&mut curve.sui_reserve);
        coin::from_balance(bal, ctx)
    }

    // ---------- Read-only ----------
    public fun current_price<T>(c: &Curve<T>): u64 {
        let x = effective_sui_reserve(c) as u128;
        let y = effective_token_reserve(c) as u128;
        ((x * 1_000_000) / y) as u64
    }

    public fun sui_reserve<T>(c: &Curve<T>): u64 { balance::value(&c.sui_reserve) }
    public fun tokens_remaining<T>(c: &Curve<T>): u64 { balance::value(&c.token_reserve) }
    public fun creator<T>(c: &Curve<T>): address { c.creator }
    public fun creator_fees_pending<T>(c: &Curve<T>): u64 { balance::value(&c.creator_fees) }
    public fun protocol_fees_pending<T>(c: &Curve<T>): u64 { balance::value(&c.protocol_fees) }
    public fun is_graduated<T>(c: &Curve<T>): bool { c.graduated }
    public fun grad_threshold_mist(): u64 { TEST_GRAD_THRESHOLD_MIST }

    public fun post_comment(
        curve_id: ID,
        text:     String,
        ctx:      &mut TxContext,
    ) {
        let bytes = std::string::as_bytes(&text);
        assert!(std::vector::length(bytes) > 0, ECommentEmpty);
        assert!(std::vector::length(bytes) <= MAX_COMMENT_BYTES, ECommentTooLong);
        event::emit(Comment {
            curve_id,
            author: tx_context::sender(ctx),
            text,
        });
    }

    #[test_only]
    public fun init_for_testing(ctx: &mut TxContext) {
        let cap = AdminCap { id: object::new(ctx) };
        transfer::public_transfer(cap, tx_context::sender(ctx));
    }
}
