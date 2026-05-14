/// suipump::bonding_curve v6
///
/// Changes from v5:
///   - Metadata update redesigned: instant, one-time only, within 24h of launch
///   - Removed: PendingMetadata struct, queue_metadata_update, apply_metadata_update
///   - Added: update_metadata() — instant, burns the right after use
///   - Curve struct: pending_metadata removed, metadata_updated: bool added
///
/// Everything else identical to v5.
///
/// Fee model (1.00% total per trade):
///   Without referral: 40% creator / 50% protocol / 10% LP
///   With referral:    40% creator / 40% protocol / 10% LP / 10% referral
///
/// Graduation fee (1.00% total of final reserve):
///   0.50% creator bonus / 0.50% protocol bonus
module suipump::bonding_curve {
    use sui::balance::{Self, Balance};
    use sui::coin::{Self, Coin, TreasuryCap, CoinMetadata};
    use sui::event;
    use sui::sui::SUI;
    use sui::clock::{Self, Clock};
    use std::ascii::String as AsciiString;
    use std::string::String;
    use std::option::{Self, Option};

    // ---------- Errors ----------
    const EInsufficientTokens:       u64 = 2;
    const ESlippageExceeded:         u64 = 3;
    const EAlreadyGraduated:         u64 = 4;
    const ENotGraduated:             u64 = 5;
    const EZeroAmount:               u64 = 7;
    const ENoFees:                   u64 = 8;
    const EFeeSplitInvalid:          u64 = 9;
    const EPayoutsSumInvalid:        u64 = 10;
    const EPayoutsEmpty:             u64 = 11;
    const ETooManyPayouts:           u64 = 12;
    const EDuplicatePayoutAddress:   u64 = 13;
    const EWrongLaunchFee:           u64 = 14;
    const ECapMismatch:              u64 = 15;
    const ECommentTooLong:           u64 = 16;
    const ECommentEmpty:             u64 = 17;
    const EAntiBotBlocked:           u64 = 18;
    const EInvalidAntiBotDelay:      u64 = 19;
    const EInvalidGraduationTarget:  u64 = 20;
    const EMetadataAlreadyUpdated:   u64 = 21; // one-time only
    const EMetadataWindowClosed:     u64 = 22; // 24h window expired
    const ENoMetadataFields:         u64 = 23;
    const EMetadataNameTooLong:      u64 = 24;
    const EMetadataSymbolTooLong:    u64 = 25;

    const MAX_COMMENT_BYTES: u64 = 280;
    const MAX_NAME_BYTES:    u64 = 64;
    const MAX_SYMBOL_BYTES:  u64 = 16;

    // ---------- Fee tunables ----------
    const TRADE_FEE_BPS:           u64 = 100;
    const CREATOR_SHARE_BPS:       u64 = 4_000;
    const PROTOCOL_SHARE_BPS:      u64 = 5_000;
    const LP_SHARE_BPS:            u64 = 1_000;
    const REFERRAL_SHARE_BPS:      u64 = 1_000;
    const CREATOR_GRAD_BONUS_BPS:  u64 = 50;
    const PROTOCOL_GRAD_BONUS_BPS: u64 = 50;
    const LAUNCH_FEE_MIST:         u64 = 2 * 1_000_000_000;
    const MAX_PAYOUTS:             u64 = 10;

    // ---------- Curve constants ----------
    const TOTAL_SUPPLY:        u64 = 1_000_000_000 * 1_000_000;
    const CURVE_SUPPLY:        u64 = 800_000_000  * 1_000_000;
    const VIRTUAL_SUI_RESERVE: u64 = 9_000 * 1_000_000_000;
    const VIRTUAL_TOKEN_RESERVE: u64 = 1_073_000_000 * 1_000_000;
    const GRAD_THRESHOLD_MIST: u64 = 17_000 * 1_000_000_000;
    const BPS_DENOMINATOR:     u64 = 10_000;

    // Anti-bot delay options (seconds)
    const ANTI_BOT_NONE: u8 = 0;
    const ANTI_BOT_15S:  u8 = 15;
    const ANTI_BOT_30S:  u8 = 30;

    // Graduation targets
    const GRAD_TARGET_CETUS:    u8 = 0;
    const GRAD_TARGET_DEEPBOOK: u8 = 1;

    // Metadata update window: 24h from launch
    const METADATA_WINDOW_MS: u64 = 24 * 60 * 60 * 1_000;

    // ---------- One-time witness ----------
    public struct BONDING_CURVE has drop {}

    // ---------- Capabilities ----------
    public struct AdminCap has key, store { id: UID }

    public struct CreatorCap has key, store {
        id: UID,
        curve_id: ID,
    }

    public struct Payout has copy, drop, store {
        recipient: address,
        bps: u64,
    }

    fun init(_witness: BONDING_CURVE, ctx: &mut TxContext) {
        assert!(
            CREATOR_SHARE_BPS + PROTOCOL_SHARE_BPS + LP_SHARE_BPS == BPS_DENOMINATOR,
            EFeeSplitInvalid,
        );
        transfer::public_transfer(AdminCap { id: object::new(ctx) }, tx_context::sender(ctx));
    }

    // ---------- Core object ----------
    public struct Curve<phantom T> has key {
        id: UID,
        sui_reserve:       Balance<SUI>,
        token_reserve:     Balance<T>,
        treasury:          TreasuryCap<T>,
        creator:           address,
        payouts:           vector<Payout>,
        creator_fees:      Balance<SUI>,
        protocol_fees:     Balance<SUI>,
        graduated:         bool,
        name:              String,
        symbol:            AsciiString,
        graduation_target: u8,
        anti_bot_delay:    u8,
        created_at_ms:     u64,
        metadata_updated:  bool, // one-time metadata update flag
    }

    // ---------- Events ----------
    public struct CurveCreated has copy, drop {
        curve_id:          ID,
        creator:           address,
        name:              String,
        symbol:            AsciiString,
        graduation_target: u8,
        anti_bot_delay:    u8,
    }

    public struct TokensPurchased has copy, drop {
        curve_id:          ID,
        buyer:             address,
        sui_in:            u64,
        tokens_out:        u64,
        creator_fee:       u64,
        protocol_fee:      u64,
        lp_fee:            u64,
        referral_fee:      u64,
        referral:          Option<address>,
        new_sui_reserve:   u64,
        new_token_reserve: u64,
    }

    public struct TokensSold has copy, drop {
        curve_id:          ID,
        seller:            address,
        tokens_in:         u64,
        sui_out:           u64,
        creator_fee:       u64,
        protocol_fee:      u64,
        lp_fee:            u64,
        new_sui_reserve:   u64,
        new_token_reserve: u64,
    }

    public struct Graduated has copy, drop {
        curve_id:          ID,
        final_sui_reserve: u64,
        creator_bonus:     u64,
        protocol_bonus:    u64,
        graduation_target: u8,
    }

    public struct CreatorFeesClaimed has copy, drop {
        curve_id: ID,
        creator:  address,
        amount:   u64,
    }

    public struct ProtocolFeesClaimed has copy, drop {
        curve_id: ID,
        amount:   u64,
    }

    public struct PayoutsUpdated has copy, drop {
        curve_id:   ID,
        updated_by: address,
    }

    public struct LaunchFeeCollected has copy, drop {
        curve_id: ID,
        amount:   u64,
    }

    public struct Comment has copy, drop {
        curve_id: ID,
        author:   address,
        text:     String,
    }

    public struct MetadataUpdated has copy, drop {
        curve_id: ID,
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
            sui_reserve:       balance::zero(),
            token_reserve:     token_balance,
            treasury,
            creator,
            payouts,
            creator_fees:      balance::zero(),
            protocol_fees:     balance::zero(),
            graduated:         false,
            name,
            symbol,
            graduation_target: GRAD_TARGET_CETUS,
            anti_bot_delay:    ANTI_BOT_NONE,
            created_at_ms:     0,
            metadata_updated:  false,
        };

        event::emit(CurveCreated {
            curve_id:          object::id(&curve),
            creator,
            name:              curve.name,
            symbol:            curve.symbol,
            graduation_target: curve.graduation_target,
            anti_bot_delay:    curve.anti_bot_delay,
        });

        transfer::share_object(curve);
    }

    #[allow(lint(self_transfer))]
    public fun create_and_return<T>(
        mut treasury: TreasuryCap<T>,
        payment: Coin<SUI>,
        name: String,
        symbol: AsciiString,
        description: String,
        payout_addresses: vector<address>,
        payout_bps: vector<u64>,
        graduation_target: u8,
        anti_bot_delay: u8,
        clock: &Clock,
        ctx: &mut TxContext,
    ): (Curve<T>, CreatorCap) {
        assert!(coin::value(&payment) == LAUNCH_FEE_MIST, EWrongLaunchFee);
        assert!(
            graduation_target == GRAD_TARGET_CETUS || graduation_target == GRAD_TARGET_DEEPBOOK,
            EInvalidGraduationTarget,
        );
        assert!(
            anti_bot_delay == ANTI_BOT_NONE ||
            anti_bot_delay == ANTI_BOT_15S  ||
            anti_bot_delay == ANTI_BOT_30S,
            EInvalidAntiBotDelay,
        );

        let payouts = build_payouts(payout_addresses, payout_bps);
        let token_balance = coin::mint_balance(&mut treasury, CURVE_SUPPLY);
        let creator = tx_context::sender(ctx);
        let now_ms = clock::timestamp_ms(clock);
        let _ = description;

        let mut curve = Curve<T> {
            id: object::new(ctx),
            sui_reserve:       balance::zero(),
            token_reserve:     token_balance,
            treasury,
            creator,
            payouts,
            creator_fees:      balance::zero(),
            protocol_fees:     balance::zero(),
            graduated:         false,
            name,
            symbol,
            graduation_target,
            anti_bot_delay,
            created_at_ms:     now_ms,
            metadata_updated:  false,
        };

        balance::join(&mut curve.protocol_fees, coin::into_balance(payment));

        let cap = CreatorCap { id: object::new(ctx), curve_id: object::id(&curve) };

        event::emit(CurveCreated {
            curve_id:          object::id(&curve),
            creator,
            name:              curve.name,
            symbol:            curve.symbol,
            graduation_target: curve.graduation_target,
            anti_bot_delay:    curve.anti_bot_delay,
        });
        event::emit(LaunchFeeCollected { curve_id: object::id(&curve), amount: LAUNCH_FEE_MIST });

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
        description: String,
        payout_addresses: vector<address>,
        payout_bps: vector<u64>,
        graduation_target: u8,
        anti_bot_delay: u8,
        clock: &Clock,
        ctx: &mut TxContext,
    ) {
        let (curve, cap) = create_and_return<T>(
            treasury, payment, name, symbol, description,
            payout_addresses, payout_bps,
            graduation_target, anti_bot_delay,
            clock, ctx,
        );
        transfer::share_object(curve);
        transfer::public_transfer(cap, tx_context::sender(ctx));
    }

    fun build_payouts(addresses: vector<address>, bps_values: vector<u64>): vector<Payout> {
        let n = vector::length(&addresses);
        assert!(n == vector::length(&bps_values), EPayoutsSumInvalid);
        assert!(n > 0, EPayoutsEmpty);
        assert!(n <= MAX_PAYOUTS, ETooManyPayouts);

        let mut out = vector::empty<Payout>();
        let mut sum: u64 = 0;
        let mut i: u64 = 0;
        while (i < n) {
            let addr  = *vector::borrow(&addresses, i);
            let share = *vector::borrow(&bps_values, i);
            let mut j: u64 = 0;
            let m = vector::length(&out);
            while (j < m) {
                assert!(vector::borrow(&out, j).recipient != addr, EDuplicatePayoutAddress);
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
        let x_u128  = x_reserve as u128;
        let y_u128  = y_reserve as u128;
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
        let creator  = (fee * CREATOR_SHARE_BPS)  / BPS_DENOMINATOR;
        let protocol = (fee * PROTOCOL_SHARE_BPS) / BPS_DENOMINATOR;
        let lp       = fee - creator - protocol;
        (creator, protocol, lp)
    }

    fun split_fee_with_referral(fee: u64): (u64, u64, u64, u64) {
        let creator  = (fee * CREATOR_SHARE_BPS)  / BPS_DENOMINATOR;
        let referral = (fee * REFERRAL_SHARE_BPS) / BPS_DENOMINATOR;
        let lp       = (fee * LP_SHARE_BPS)       / BPS_DENOMINATOR;
        let protocol = fee - creator - referral - lp;
        (creator, protocol, lp, referral)
    }

    // ---------- Buy ----------
    #[allow(lint(self_transfer))]
    public fun buy<T>(
        curve:          &mut Curve<T>,
        mut payment:    Coin<SUI>,
        min_tokens_out: u64,
        referral:       Option<address>,
        clock:          &Clock,
        ctx:            &mut TxContext,
    ): (Coin<T>, Coin<SUI>) {
        assert!(!curve.graduated, EAlreadyGraduated);
        let sui_in = coin::value(&payment);
        assert!(sui_in > 0, EZeroAmount);

        if (curve.anti_bot_delay > 0) {
            let now_ms   = clock::timestamp_ms(clock);
            let delay_ms = (curve.anti_bot_delay as u64) * 1_000;
            if (now_ms < curve.created_at_ms + delay_ms) {
                assert!(tx_context::sender(ctx) == curve.creator, EAntiBotBlocked);
            };
        };

        let fee_amount  = (sui_in * TRADE_FEE_BPS) / BPS_DENOMINATOR;
        let swap_amount = sui_in - fee_amount;

        let (creator_fee, protocol_fee, lp_fee, referral_fee);
        if (option::is_some(&referral)) {
            let (c, p, l, r) = split_fee_with_referral(fee_amount);
            creator_fee = c; protocol_fee = p; lp_fee = l; referral_fee = r;
        } else {
            let (c, p, l) = split_fee(fee_amount);
            creator_fee = c; protocol_fee = p; lp_fee = l; referral_fee = 0;
        };

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

        let creator_coin  = coin::split(&mut payment, creator_fee,  ctx);
        let protocol_coin = coin::split(&mut payment, protocol_fee, ctx);
        balance::join(&mut curve.creator_fees,  coin::into_balance(creator_coin));
        balance::join(&mut curve.protocol_fees, coin::into_balance(protocol_coin));

        if (referral_fee > 0 && option::is_some(&referral)) {
            let referral_coin = coin::split(&mut payment, referral_fee, ctx);
            transfer::public_transfer(referral_coin, *option::borrow(&referral));
        };

        let to_reserve   = actual_swap + lp_fee;
        let reserve_coin = coin::split(&mut payment, to_reserve, ctx);
        balance::join(&mut curve.sui_reserve, coin::into_balance(reserve_coin));

        let out_balance = balance::split(&mut curve.token_reserve, tokens_out);

        event::emit(TokensPurchased {
            curve_id:          object::id(curve),
            buyer:             tx_context::sender(ctx),
            sui_in,
            tokens_out,
            creator_fee,
            protocol_fee,
            lp_fee,
            referral_fee,
            referral,
            new_sui_reserve:   balance::value(&curve.sui_reserve),
            new_token_reserve: balance::value(&curve.token_reserve),
        });

        (coin::from_balance(out_balance, ctx), payment)
    }

    // ---------- Sell ----------
    public fun sell<T>(
        curve:       &mut Curve<T>,
        tokens_in:   Coin<T>,
        min_sui_out: u64,
        ctx:         &mut TxContext,
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

        let mut out_bal  = balance::split(&mut curve.sui_reserve, withdraw_amount);
        let creator_bal  = balance::split(&mut out_bal, creator_fee);
        let protocol_bal = balance::split(&mut out_bal, protocol_fee);
        balance::join(&mut curve.creator_fees,  creator_bal);
        balance::join(&mut curve.protocol_fees, protocol_bal);

        event::emit(TokensSold {
            curve_id:          object::id(curve),
            seller:            tx_context::sender(ctx),
            tokens_in:         amount_in,
            sui_out:           net_sui_out,
            creator_fee,
            protocol_fee,
            lp_fee,
            new_sui_reserve:   balance::value(&curve.sui_reserve),
            new_token_reserve: balance::value(&curve.token_reserve),
        });

        coin::from_balance(out_bal, ctx)
    }

    // ---------- Fee claims ----------
    public fun claim_creator_fees<T>(
        cap:   &CreatorCap,
        curve: &mut Curve<T>,
        ctx:   &mut TxContext,
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
                transfer::public_transfer(coin::from_balance(bal, ctx), payout.recipient);
            };
            paid = paid + amount;
            i = i + 1;
        };

        event::emit(CreatorFeesClaimed {
            curve_id: object::id(curve),
            creator:  curve.creator,
            amount:   total,
        });
    }

    public fun update_payouts<T>(
        cap:              &CreatorCap,
        curve:            &mut Curve<T>,
        payout_addresses: vector<address>,
        payout_bps:       vector<u64>,
        ctx:              &mut TxContext,
    ) {
        assert!(cap.curve_id == object::id(curve), ECapMismatch);
        curve.payouts = build_payouts(payout_addresses, payout_bps);
        event::emit(PayoutsUpdated {
            curve_id:   object::id(curve),
            updated_by: tx_context::sender(ctx),
        });
    }

    public fun claim_protocol_fees<T>(
        _cap:  &AdminCap,
        curve: &mut Curve<T>,
        ctx:   &mut TxContext,
    ): Coin<SUI> {
        let amount = balance::value(&curve.protocol_fees);
        assert!(amount > 0, ENoFees);
        let bal = balance::withdraw_all(&mut curve.protocol_fees);
        event::emit(ProtocolFeesClaimed { curve_id: object::id(curve), amount });
        coin::from_balance(bal, ctx)
    }

    // ---------- Graduation ----------
    #[allow(lint(self_transfer))]
    public fun graduate<T>(
        curve: &mut Curve<T>,
        ctx:   &mut TxContext,
    ) {
        assert!(!curve.graduated, EAlreadyGraduated);
        assert!(
            balance::value(&curve.token_reserve) == 0 ||
            balance::value(&curve.sui_reserve) >= GRAD_THRESHOLD_MIST,
            ENotGraduated,
        );

        curve.graduated = true;

        let lp_supply     = TOTAL_SUPPLY - CURVE_SUPPLY;
        let lp_tokens_bal = coin::mint_balance(&mut curve.treasury, lp_supply);
        let total_reserve = balance::value(&curve.sui_reserve);

        let creator_bonus_amount  = (total_reserve * CREATOR_GRAD_BONUS_BPS)  / BPS_DENOMINATOR;
        let protocol_bonus_amount = (total_reserve * PROTOCOL_GRAD_BONUS_BPS) / BPS_DENOMINATOR;

        let creator_bonus_bal  = balance::split(&mut curve.sui_reserve, creator_bonus_amount);
        let protocol_bonus_bal = balance::split(&mut curve.sui_reserve, protocol_bonus_amount);

        transfer::public_transfer(coin::from_balance(creator_bonus_bal, ctx), curve.creator);
        balance::join(&mut curve.protocol_fees, protocol_bonus_bal);
        transfer::public_transfer(coin::from_balance(lp_tokens_bal, ctx), curve.creator);

        event::emit(Graduated {
            curve_id:          object::id(curve),
            final_sui_reserve: total_reserve,
            creator_bonus:     creator_bonus_amount,
            protocol_bonus:    protocol_bonus_amount,
            graduation_target: curve.graduation_target,
        });
    }

    public fun claim_graduation_funds<T>(
        _cap:  &AdminCap,
        curve: &mut Curve<T>,
        ctx:   &mut TxContext,
    ): Coin<SUI> {
        assert!(curve.graduated, ENotGraduated);
        let amount = balance::value(&curve.sui_reserve);
        assert!(amount > 0, ENoFees);
        let bal = balance::withdraw_all(&mut curve.sui_reserve);
        coin::from_balance(bal, ctx)
    }

    // ---------- Metadata update (instant, one-time, 24h window) ----------
    /// Creator can update name/symbol/description/icon exactly once,
    /// within 24 hours of launch. Instant — no timelock.
    /// After use or after 24h, permanently locked.
    public fun update_metadata<T>(
        cap:         &CreatorCap,
        curve:       &mut Curve<T>,
        metadata:    &mut CoinMetadata<T>,
        name:        Option<String>,
        symbol:      Option<AsciiString>,
        description: Option<String>,
        icon_url:    Option<AsciiString>,
        clock:       &Clock,
        _ctx:        &mut TxContext,
    ) {
        assert!(cap.curve_id == object::id(curve), ECapMismatch);
        assert!(!curve.metadata_updated, EMetadataAlreadyUpdated);

        // 24h window check
        let now_ms = clock::timestamp_ms(clock);
        assert!(now_ms < curve.created_at_ms + METADATA_WINDOW_MS, EMetadataWindowClosed);

        // At least one field required
        assert!(
            option::is_some(&name)        ||
            option::is_some(&symbol)      ||
            option::is_some(&description) ||
            option::is_some(&icon_url),
            ENoMetadataFields,
        );

        // Length validation
        if (option::is_some(&name)) {
            assert!(
                std::string::length(option::borrow(&name)) <= MAX_NAME_BYTES,
                EMetadataNameTooLong,
            );
        };
        if (option::is_some(&symbol)) {
            assert!(
                std::ascii::length(option::borrow(&symbol)) <= MAX_SYMBOL_BYTES,
                EMetadataSymbolTooLong,
            );
        };

        // Apply instantly
        if (option::is_some(&name)) {
            coin::update_name(&curve.treasury, metadata, *option::borrow(&name));
        };
        if (option::is_some(&symbol)) {
            coin::update_symbol(&curve.treasury, metadata, *option::borrow(&symbol));
        };
        if (option::is_some(&description)) {
            coin::update_description(&curve.treasury, metadata, *option::borrow(&description));
        };
        if (option::is_some(&icon_url)) {
            let url = std::ascii::into_bytes(*option::borrow(&icon_url));
            coin::update_icon_url(&curve.treasury, metadata, std::ascii::string(url));
        };

        // Burn the right — can never be called again
        curve.metadata_updated = true;

        event::emit(MetadataUpdated { curve_id: object::id(curve) });
    }

    // ---------- Read-only ----------
    public fun current_price<T>(c: &Curve<T>): u64 {
        let x = effective_sui_reserve(c) as u128;
        let y = effective_token_reserve(c) as u128;
        ((x * 1_000_000) / y) as u64
    }

    public fun sui_reserve<T>(c: &Curve<T>): u64           { balance::value(&c.sui_reserve) }
    public fun tokens_remaining<T>(c: &Curve<T>): u64      { balance::value(&c.token_reserve) }
    public fun creator<T>(c: &Curve<T>): address           { c.creator }
    public fun creator_fees_pending<T>(c: &Curve<T>): u64  { balance::value(&c.creator_fees) }
    public fun protocol_fees_pending<T>(c: &Curve<T>): u64 { balance::value(&c.protocol_fees) }
    public fun is_graduated<T>(c: &Curve<T>): bool         { c.graduated }
    public fun graduation_target<T>(c: &Curve<T>): u8      { c.graduation_target }
    public fun anti_bot_delay<T>(c: &Curve<T>): u8         { c.anti_bot_delay }
    public fun created_at_ms<T>(c: &Curve<T>): u64         { c.created_at_ms }
    public fun metadata_updated<T>(c: &Curve<T>): bool     { c.metadata_updated }

    public fun metadata_window_closes_at<T>(c: &Curve<T>): u64 {
        c.created_at_ms + METADATA_WINDOW_MS
    }

    public fun progress_bps<T>(c: &Curve<T>): u64 {
        let sold = CURVE_SUPPLY - balance::value(&c.token_reserve);
        (sold * BPS_DENOMINATOR) / CURVE_SUPPLY
    }

    public fun grad_threshold_mist(): u64  { GRAD_THRESHOLD_MIST }
    public fun trade_fee_bps(): u64        { TRADE_FEE_BPS }
    public fun creator_share_bps(): u64    { CREATOR_SHARE_BPS }
    public fun protocol_share_bps(): u64   { PROTOCOL_SHARE_BPS }
    public fun lp_share_bps(): u64         { LP_SHARE_BPS }
    public fun referral_share_bps(): u64   { REFERRAL_SHARE_BPS }
    public fun curve_supply(): u64         { CURVE_SUPPLY }
    public fun launch_fee_mist(): u64      { LAUNCH_FEE_MIST }
    public fun max_payouts(): u64          { MAX_PAYOUTS }
    public fun virtual_sui_reserve(): u64  { VIRTUAL_SUI_RESERVE }

    public fun payouts<T>(curve: &Curve<T>): (vector<address>, vector<u64>) {
        let n = vector::length(&curve.payouts);
        let mut addrs   = vector::empty<address>();
        let mut bps_vec = vector::empty<u64>();
        let mut i: u64  = 0;
        while (i < n) {
            let p = vector::borrow(&curve.payouts, i);
            vector::push_back(&mut addrs, p.recipient);
            vector::push_back(&mut bps_vec, p.bps);
            i = i + 1;
        };
        (addrs, bps_vec)
    }

    public fun creator_cap_curve_id(cap: &CreatorCap): ID { cap.curve_id }

    // ---------- Comments ----------
    public fun post_comment(
        curve_id: ID,
        text:     String,
        ctx:      &mut TxContext,
    ) {
        let bytes = std::string::as_bytes(&text);
        assert!(std::vector::length(bytes) > 0,                  ECommentEmpty);
        assert!(std::vector::length(bytes) <= MAX_COMMENT_BYTES, ECommentTooLong);
        event::emit(Comment { curve_id, author: tx_context::sender(ctx), text });
    }

    // ---------- Test-only ----------
    #[test_only]
    public fun init_for_testing(ctx: &mut TxContext) {
        transfer::public_transfer(AdminCap { id: object::new(ctx) }, tx_context::sender(ctx));
    }

    #[test_only] public fun e_already_graduated(): u64       { EAlreadyGraduated }
    #[test_only] public fun e_not_graduated(): u64           { ENotGraduated }
    #[test_only] public fun e_zero_amount(): u64             { EZeroAmount }
    #[test_only] public fun e_no_fees(): u64                 { ENoFees }
    #[test_only] public fun e_slippage_exceeded(): u64       { ESlippageExceeded }
    #[test_only] public fun e_payouts_sum_invalid(): u64     { EPayoutsSumInvalid }
    #[test_only] public fun e_payouts_empty(): u64           { EPayoutsEmpty }
    #[test_only] public fun e_too_many_payouts(): u64        { ETooManyPayouts }
    #[test_only] public fun e_duplicate_payout_address(): u64{ EDuplicatePayoutAddress }
    #[test_only] public fun e_wrong_launch_fee(): u64        { EWrongLaunchFee }
    #[test_only] public fun e_cap_mismatch(): u64            { ECapMismatch }
    #[test_only] public fun e_comment_too_long(): u64        { ECommentTooLong }
    #[test_only] public fun e_comment_empty(): u64           { ECommentEmpty }
    #[test_only] public fun e_anti_bot_blocked(): u64        { EAntiBotBlocked }
    #[test_only] public fun e_metadata_already_updated(): u64{ EMetadataAlreadyUpdated }
    #[test_only] public fun e_metadata_window_closed(): u64  { EMetadataWindowClosed }
}
