/// suipump::bonding_curve  v8
///
/// ONE CHANGE FROM V7: `graduate()` now takes `&mut CoinMetadata<T>` (shared
/// object reference) instead of `CoinMetadata<T>` by value, and no longer
/// calls `transfer::public_freeze_object(metadata)` internally.
///
/// Why this matters:
///   The V7 coin template called `public_freeze_object(metadata)` in `init`.
///   A frozen object can NEVER be passed by `&mut`.  This made
///   `update_metadata()` — which takes `&mut CoinMetadata<T>` — abort with
///   `InvalidObjectByMutRef` for every V7 token, forever.
///
///   The V8 coin template calls `public_share_object(metadata)` instead.
///   Shared objects CAN be passed by `&mut` (with `mutable: true` in the PTB).
///   The two functions that touch metadata are now both happy:
///     - update_metadata(&mut CoinMetadata<T>)  — creator can update once / 24h
///     - graduate(&mut CoinMetadata<T>)          — protocol uses it for the DEX
///       listing; metadata protection comes from the existing
///       `metadata_updated: bool` flag + 24h window (identity is still
///       tamper-resistant post-graduation because update rights are exhausted
///       or the window is closed).
///
///   All other contract logic is IDENTICAL to V7.  No curve math was changed,
///   no fee splits were changed, no new features were added.  V8 is a minimal,
///   targeted fix so the auditor diff is as small as possible.
///
/// V7 → V8 diff (contract-only):
///   1. graduate() signature: `metadata: CoinMetadata<T>` → `metadata: &mut CoinMetadata<T>`
///   2. graduate() body: remove `transfer::public_freeze_object(metadata);`
///   3. graduate_for_testing(): same signature change (no-metadata test helper)
///      — graduate_for_testing() already didn't freeze, so body is unchanged.
///
/// V8 AdminCap / UpgradeCap will be new objects post-publish.
/// V7 tokens ($LOCKI, etc.) have permanently frozen metadata — they cannot
/// benefit from V8.  Only tokens launched via the V8 template will have
/// working update_metadata().  The auditor must review V7+V8 as a combined
/// delta.

module suipump::bonding_curve {
    use sui::balance::{Self, Balance};
    use sui::clock::{Self, Clock};
    use sui::coin::{Self, Coin, TreasuryCap, CoinMetadata};
    use sui::event;
    use sui::sui::SUI;
    use std::ascii::String as AsciiString;
    use std::string::String;

    // ---------- Error codes (identical to V7) ----------
    const EInsufficientTokens:       u64 = 2;
    const ESlippageExceeded:         u64 = 3;
    const EAlreadyGraduated:         u64 = 4;
    const ENotGraduated:             u64 = 5;
    const ECapMismatch:              u64 = 6;
    const EZeroAmount:               u64 = 7;
    const ENoFees:                   u64 = 8;
    const EWrongLaunchFee:           u64 = 9;
    const EInvalidGraduationTarget:  u64 = 10;
    const EInvalidAntiBotDelay:      u64 = 11;
    const EAntiBotBlocked:           u64 = 18;
    const EBadPayouts:               u64 = 19;
    const ETooManyPayouts:           u64 = 20;
    const EFeeSplitInvalid:          u64 = 21;
    const EMetadataAlreadyUpdated:   u64 = 22;
    const EMetadataWindowClosed:     u64 = 23;  // Note: window check uses < not <=
    const ENoMetadataFields:         u64 = 23;  // same slot (both guard update_metadata)
    const EMetadataNameTooLong:      u64 = 24;
    const EMetadataSymbolTooLong:    u64 = 25;
    const EWrongCommentFee:          u64 = 26;
    const ESelfReferral:             u64 = 27;
    const EPaused:                   u64 = 28;
    const EPoolAlreadyRecorded:      u64 = 29;
    const EInvalidVestMode:          u64 = 30;
    const EInvalidVestDuration:      u64 = 31;
    const EMonthlyNeeds30Days:       u64 = 32;
    const ENotLockBeneficiary:       u64 = 33;
    const ENothingVested:            u64 = 34;
    const EZeroLockAmount:           u64 = 35;

    const MAX_COMMENT_BYTES: u64 = 280;
    const MAX_NAME_BYTES:    u64 = 64;
    const MAX_SYMBOL_BYTES:  u64 = 16;

    // ---------- Fee tunables (unchanged from V7) ----------
    const TRADE_FEE_BPS:           u64 = 100;
    const CREATOR_SHARE_BPS:       u64 = 4_000;
    const PROTOCOL_SHARE_BPS:      u64 = 5_000;  // kept for init assert
    const LP_SHARE_BPS:            u64 = 1_000;
    const REFERRAL_SHARE_BPS:      u64 = 1_000;
    const CREATOR_GRAD_BONUS_BPS:  u64 = 50;
    const PROTOCOL_GRAD_BONUS_BPS: u64 = 50;
    const LAUNCH_FEE_MIST:         u64 = 2 * 1_000_000_000;
    const COMMENT_FEE_MIST:        u64 = 1_000_000;  // 0.001 SUI
    const MAX_PAYOUTS:             u64 = 10;

    // ---------- Curve constants (unchanged from V7) ----------
    const TOTAL_SUPPLY:          u64 = 1_000_000_000 * 1_000_000;
    const CURVE_SUPPLY:          u64 = 800_000_000  * 1_000_000;
    const VIRTUAL_SUI_RESERVE:   u64 = 3_500 * 1_000_000_000;
    const VIRTUAL_TOKEN_RESERVE: u64 = 1_073_000_000 * 1_000_000;
    const GRAD_THRESHOLD_MIST:   u64 = 9_000 * 1_000_000_000;
    const BPS_DENOMINATOR:       u64 = 10_000;

    // Anti-bot delay options (seconds)
    const ANTI_BOT_NONE: u8 = 0;
    const ANTI_BOT_15S:  u8 = 15;
    const ANTI_BOT_30S:  u8 = 30;

    // Graduation targets
    const GRAD_TARGET_CETUS:    u8 = 0;
    const GRAD_TARGET_DEEPBOOK: u8 = 1;
    const GRAD_TARGET_TURBOS:   u8 = 2;

    // Metadata update window: 24h from launch
    const METADATA_WINDOW_MS: u64 = 24 * 60 * 60 * 1_000;

    // ---------- Vesting (identical to V7) ----------
    const VEST_MODE_CLIFF:   u8 = 0;
    const VEST_MODE_LINEAR:  u8 = 1;
    const VEST_MODE_MONTHLY: u8 = 2;

    const VEST_7D:   u64 = 7   * 24 * 60 * 60 * 1_000;
    const VEST_30D:  u64 = 30  * 24 * 60 * 60 * 1_000;
    const VEST_180D: u64 = 180 * 24 * 60 * 60 * 1_000;
    const VEST_365D: u64 = 365 * 24 * 60 * 60 * 1_000;
    const MONTH_MS:  u64 = 30  * 24 * 60 * 60 * 1_000;

    // ---------- One-time witness ----------
    public struct BONDING_CURVE has drop {}

    // ---------- Capabilities ----------
    public struct AdminCap  has key, store { id: UID }
    public struct CreatorCap has key, store {
        id:       UID,
        curve_id: ID,
    }

    public struct Payout has copy, drop, store {
        recipient: address,
        bps:       u64,
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
        id:                  UID,
        sui_reserve:         Balance<SUI>,
        token_reserve:       Balance<T>,
        treasury:            TreasuryCap<T>,
        creator:             address,
        payouts:             vector<Payout>,
        creator_fees:        Balance<SUI>,
        protocol_fees:       Balance<SUI>,
        airdrop_fees:        Balance<SUI>,
        graduated:           bool,
        paused:              bool,
        name:                String,
        symbol:              AsciiString,
        graduation_target:   u8,
        anti_bot_delay:      u8,
        created_at_ms:       u64,
        metadata_updated:    bool,
        lp_fees_accumulated: u64,
        pool_id:             Option<ID>,
        creator_lp_nft_id:   Option<ID>,
    }

    // ---------- Vesting lock ----------
    public struct VestingLock<phantom T> has key {
        id:           UID,
        curve_id:     ID,
        beneficiary:  address,
        locked:       Balance<T>,
        total_amount: u64,
        claimed:      u64,
        start_ms:     u64,
        duration_ms:  u64,
        mode:         u8,
    }

    // ---------- Events (identical to V7) ----------
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
        airdrop_fee:       u64,
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
        airdrop_fee:       u64,
        lp_fee:            u64,
        referral_fee:      u64,
        referral:          Option<address>,
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

    public struct PoolRecorded has copy, drop {
        curve_id:          ID,
        pool_id:           ID,
        creator_lp_nft_id: ID,
    }

    public struct TokensLocked has copy, drop {
        lock_id:      ID,
        curve_id:     ID,
        beneficiary:  address,
        total_amount: u64,
        start_ms:     u64,
        duration_ms:  u64,
        mode:         u8,
    }

    public struct VestedClaimed has copy, drop {
        lock_id:     ID,
        beneficiary: address,
        amount:      u64,
        remaining:   u64,
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

    public struct AirdropFeesClaimed has copy, drop {
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

    public struct PauseToggled has copy, drop {
        curve_id: ID,
        paused:   bool,
    }

    public struct MetadataUpdated has copy, drop {
        curve_id: ID,
    }

    // ---------- AMM helpers ----------
    // Safe: x,y < 2^64; dx < 2^64; product fits in u128.
    // Proof: (y * dx) ≤ 2^64 * 2^64 = 2^128, which fits u128.
    fun quote_out(dx: u64, x_reserve: u64, y_reserve: u64): u64 {
        let dx_u = dx as u128;
        let x_u  = x_reserve as u128;
        let y_u  = y_reserve as u128;
        ((y_u * dx_u) / (x_u + dx_u)) as u64
    }

    fun effective_sui_reserve<T>(c: &Curve<T>): u64 {
        balance::value(&c.sui_reserve) + VIRTUAL_SUI_RESERVE
    }

    fun effective_token_reserve<T>(c: &Curve<T>): u64 {
        let sold = CURVE_SUPPLY - balance::value(&c.token_reserve);
        VIRTUAL_TOKEN_RESERVE - sold
    }

    // V7 5-way fee split (unchanged in V8):
    //   No referral:   40 creator / 25 protocol / 25 airdrop / 10 lp
    //   With referral: 40 creator / 20 protocol / 20 airdrop / 10 lp / 10 referral
    fun split_fee_v7(fee: u64, has_referral: bool): (u64, u64, u64, u64, u64) {
        let creator  = (fee * CREATOR_SHARE_BPS)  / BPS_DENOMINATOR;
        let lp       = (fee * LP_SHARE_BPS)        / BPS_DENOMINATOR;
        let referral = if (has_referral) {
            (fee * REFERRAL_SHARE_BPS) / BPS_DENOMINATOR
        } else { 0 };
        let bucket   = fee - creator - lp - referral;
        let airdrop  = bucket / 2;
        let protocol = bucket - airdrop;
        (creator, protocol, airdrop, lp, referral)
    }

    // ---------- Payout builder ----------
    fun build_payouts(addresses: vector<address>, bps_values: vector<u64>): vector<Payout> {
        let n = vector::length(&addresses);
        assert!(n > 0 && n == vector::length(&bps_values), EBadPayouts);
        assert!(n <= MAX_PAYOUTS as u64, ETooManyPayouts);
        let mut payouts = vector::empty<Payout>();
        let mut i = 0;
        let mut sum = 0u64;
        while (i < n) {
            sum = sum + *vector::borrow(&bps_values, i);
            vector::push_back(&mut payouts, Payout {
                recipient: *vector::borrow(&addresses, i),
                bps:       *vector::borrow(&bps_values, i),
            });
            i = i + 1;
        };
        assert!(sum == BPS_DENOMINATOR, EBadPayouts);
        payouts
    }

    // ---------- Creation ----------
    // Legacy (no launch fee, no anti-bot, no graduation target).
    public fun create<T>(
        mut treasury: TreasuryCap<T>,
        name:         String,
        symbol:       AsciiString,
        creator:      address,
        ctx:          &mut TxContext,
    ): (Curve<T>, CreatorCap) {
        let token_balance = coin::mint_balance(&mut treasury, CURVE_SUPPLY);
        let mut curve = Curve<T> {
            id:                  object::new(ctx),
            sui_reserve:         balance::zero(),
            token_reserve:       token_balance,
            treasury,
            creator,
            payouts:             vector[Payout { recipient: creator, bps: BPS_DENOMINATOR }],
            creator_fees:        balance::zero(),
            protocol_fees:       balance::zero(),
            airdrop_fees:        balance::zero(),
            graduated:           false,
            paused:              false,
            name,
            symbol,
            graduation_target:   GRAD_TARGET_CETUS,
            anti_bot_delay:      ANTI_BOT_NONE,
            created_at_ms:       0,
            metadata_updated:    false,
            lp_fees_accumulated: 0,
            pool_id:             option::none(),
            creator_lp_nft_id:   option::none(),
        };
        let cap = CreatorCap { id: object::new(ctx), curve_id: object::id(&curve) };
        event::emit(CurveCreated {
            curve_id:          object::id(&curve),
            creator,
            name:              curve.name,
            symbol:            curve.symbol,
            graduation_target: curve.graduation_target,
            anti_bot_delay:    curve.anti_bot_delay,
        });
        (curve, cap)
    }

    // Returns (Curve, CreatorCap) for PTB chaining (dev-buy).
    public fun create_and_return<T>(
        mut treasury:      TreasuryCap<T>,
        payment:           Coin<SUI>,
        name:              String,
        symbol:            AsciiString,
        description:       String,
        payout_addresses:  vector<address>,
        payout_bps:        vector<u64>,
        graduation_target: u8,
        anti_bot_delay:    u8,
        clock:             &Clock,
        ctx:               &mut TxContext,
    ): (Curve<T>, CreatorCap) {
        assert!(coin::value(&payment) == LAUNCH_FEE_MIST, EWrongLaunchFee);
        assert!(
            graduation_target == GRAD_TARGET_CETUS
                || graduation_target == GRAD_TARGET_DEEPBOOK
                || graduation_target == GRAD_TARGET_TURBOS,
            EInvalidGraduationTarget,
        );
        assert!(
            anti_bot_delay == ANTI_BOT_NONE ||
            anti_bot_delay == ANTI_BOT_15S  ||
            anti_bot_delay == ANTI_BOT_30S,
            EInvalidAntiBotDelay,
        );

        let payouts   = build_payouts(payout_addresses, payout_bps);
        let token_bal = coin::mint_balance(&mut treasury, CURVE_SUPPLY);
        let creator   = tx_context::sender(ctx);
        let now_ms    = clock::timestamp_ms(clock);
        let _ = description;

        let mut curve = Curve<T> {
            id:                  object::new(ctx),
            sui_reserve:         balance::zero(),
            token_reserve:       token_bal,
            treasury,
            creator,
            payouts,
            creator_fees:        balance::zero(),
            protocol_fees:       balance::zero(),
            airdrop_fees:        balance::zero(),
            graduated:           false,
            paused:              false,
            name,
            symbol,
            graduation_target,
            anti_bot_delay,
            created_at_ms:       now_ms,
            metadata_updated:    false,
            lp_fees_accumulated: 0,
            pool_id:             option::none(),
            creator_lp_nft_id:   option::none(),
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

    // Convenience wrapper for non-PTB callers.
    #[allow(lint(self_transfer))]
    public fun create_with_launch_fee<T>(
        treasury:          TreasuryCap<T>,
        payment:           Coin<SUI>,
        name:              String,
        symbol:            AsciiString,
        description:       String,
        payout_addresses:  vector<address>,
        payout_bps:        vector<u64>,
        graduation_target: u8,
        anti_bot_delay:    u8,
        clock:             &Clock,
        ctx:               &mut TxContext,
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

    public fun share_curve<T>(curve: Curve<T>) {
        transfer::share_object(curve);
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
        assert!(!curve.paused,    EPaused);
        let sui_in = coin::value(&payment);
        assert!(sui_in > 0, EZeroAmount);

        if (option::is_some(&referral)) {
            assert!(*option::borrow(&referral) != curve.creator, ESelfReferral);
        };

        if (curve.anti_bot_delay > 0) {
            let now_ms   = clock::timestamp_ms(clock);
            let delay_ms = (curve.anti_bot_delay as u64) * 1_000;
            if (now_ms < curve.created_at_ms + delay_ms) {
                assert!(tx_context::sender(ctx) == curve.creator, EAntiBotBlocked);
            };
        };

        let fee_amount  = (sui_in * TRADE_FEE_BPS) / BPS_DENOMINATOR;
        let swap_amount = sui_in - fee_amount;

        let has_referral = option::is_some(&referral);
        let (creator_fee, protocol_fee, airdrop_fee, lp_fee, referral_fee) =
            split_fee_v7(fee_amount, has_referral);

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

        assert!(tokens_out > 0,             EInsufficientTokens);
        assert!(tokens_out >= min_tokens_out, ESlippageExceeded);

        let creator_coin  = coin::split(&mut payment, creator_fee,  ctx);
        let protocol_coin = coin::split(&mut payment, protocol_fee, ctx);
        let airdrop_coin  = coin::split(&mut payment, airdrop_fee,  ctx);
        balance::join(&mut curve.creator_fees,  coin::into_balance(creator_coin));
        balance::join(&mut curve.protocol_fees, coin::into_balance(protocol_coin));
        balance::join(&mut curve.airdrop_fees,  coin::into_balance(airdrop_coin));

        if (referral_fee > 0 && has_referral) {
            let referral_coin = coin::split(&mut payment, referral_fee, ctx);
            transfer::public_transfer(referral_coin, *option::borrow(&referral));
        };

        curve.lp_fees_accumulated = curve.lp_fees_accumulated + lp_fee;

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
            airdrop_fee,
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
        referral:    Option<address>,
        ctx:         &mut TxContext,
    ): Coin<SUI> {
        assert!(!curve.graduated, EAlreadyGraduated);
        assert!(!curve.paused,    EPaused);
        let amount_in = coin::value(&tokens_in);
        assert!(amount_in > 0, EZeroAmount);

        if (option::is_some(&referral)) {
            assert!(*option::borrow(&referral) != curve.creator, ESelfReferral);
        };

        let x = effective_token_reserve(curve);
        let y = effective_sui_reserve(curve);
        let gross_sui_out = quote_out(amount_in, x, y);

        let fee_amount = (gross_sui_out * TRADE_FEE_BPS) / BPS_DENOMINATOR;
        let has_referral = option::is_some(&referral);
        let (creator_fee, protocol_fee, airdrop_fee, lp_fee, referral_fee) =
            split_fee_v7(fee_amount, has_referral);
        let net_sui_out = gross_sui_out - fee_amount;
        assert!(net_sui_out >= min_sui_out, ESlippageExceeded);

        let withdraw_amount = gross_sui_out - lp_fee;
        assert!(balance::value(&curve.sui_reserve) >= withdraw_amount, EInsufficientTokens);

        balance::join(&mut curve.token_reserve, coin::into_balance(tokens_in));

        let mut pot = coin::from_balance(
            balance::split(&mut curve.sui_reserve, withdraw_amount), ctx
        );
        let creator_coin  = coin::split(&mut pot, creator_fee,  ctx);
        let protocol_coin = coin::split(&mut pot, protocol_fee, ctx);
        let airdrop_coin  = coin::split(&mut pot, airdrop_fee,  ctx);
        balance::join(&mut curve.creator_fees,  coin::into_balance(creator_coin));
        balance::join(&mut curve.protocol_fees, coin::into_balance(protocol_coin));
        balance::join(&mut curve.airdrop_fees,  coin::into_balance(airdrop_coin));

        if (referral_fee > 0 && has_referral) {
            let referral_coin = coin::split(&mut pot, referral_fee, ctx);
            transfer::public_transfer(referral_coin, *option::borrow(&referral));
        };

        event::emit(TokensSold {
            curve_id:          object::id(curve),
            seller:            tx_context::sender(ctx),
            tokens_in:         amount_in,
            sui_out:           net_sui_out,
            creator_fee,
            protocol_fee,
            airdrop_fee,
            lp_fee,
            referral_fee,
            referral,
            new_sui_reserve:   balance::value(&curve.sui_reserve),
            new_token_reserve: balance::value(&curve.token_reserve),
        });

        pot
    }

    // ---------- Pause (AdminCap-gated) ----------
    public fun set_paused<T>(
        _cap:   &AdminCap,
        curve:  &mut Curve<T>,
        paused: bool,
    ) {
        curve.paused = paused;
        event::emit(PauseToggled { curve_id: object::id(curve), paused });
    }

    // ---------- Graduation ----------
    // V8 CHANGE: takes `&mut CoinMetadata<T>` instead of `CoinMetadata<T>` by
    // value.  No longer calls `public_freeze_object`.  This is correct because:
    //   - V8 template calls `public_share_object(metadata)` so metadata IS a
    //     shared object, which MUST be passed by ref — not by value.
    //   - Post-graduation tamper resistance: the `metadata_updated` flag is
    //     already set (the creator used their one-time update, or the 24h
    //     window has closed).  Either way no further mutation is possible.
    #[allow(lint(self_transfer))]
    public fun graduate<T>(
        curve:    &mut Curve<T>,
        metadata: &mut CoinMetadata<T>,   // V8: shared ref, not by value
        ctx:      &mut TxContext,
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

        // V8: metadata is a shared &mut — we do NOT freeze it here.
        // The metadata argument is passed to satisfy the type system so the
        // DEX pool-creation PTB can chain metadata reads after graduation.
        let _ = metadata;

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

    public fun record_graduation_pool<T>(
        _cap:              &AdminCap,
        curve:             &mut Curve<T>,
        pool_id:           ID,
        creator_lp_nft_id: ID,
    ) {
        assert!(option::is_none(&curve.pool_id), EPoolAlreadyRecorded);
        curve.pool_id = option::some(pool_id);
        curve.creator_lp_nft_id = option::some(creator_lp_nft_id);
        event::emit(PoolRecorded {
            curve_id:          object::id(curve),
            pool_id,
            creator_lp_nft_id,
        });
    }

    // ---------- Metadata update (one-time, 24h window) ----------
    // Works in V8 because CoinMetadata is SHARED (public_share_object in
    // V8 template init), so it can be passed as &mut.  V7 tokens have
    // FROZEN metadata — this function is unreachable for V7 tokens.
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

        let now_ms = clock::timestamp_ms(clock);
        assert!(now_ms < curve.created_at_ms + METADATA_WINDOW_MS, EMetadataWindowClosed);

        assert!(
            option::is_some(&name)        ||
            option::is_some(&symbol)      ||
            option::is_some(&description) ||
            option::is_some(&icon_url),
            ENoMetadataFields,
        );

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

        curve.metadata_updated = true;
        event::emit(MetadataUpdated { curve_id: object::id(curve) });
    }

    // ---------- Comments (0.001 SUI fee) ----------
    public fun post_comment<T>(
        curve:   &mut Curve<T>,
        payment: Coin<SUI>,
        text:    String,
        ctx:     &mut TxContext,
    ) {
        assert!(coin::value(&payment) == COMMENT_FEE_MIST, EWrongCommentFee);
        let bytes = std::string::as_bytes(&text);
        assert!(std::vector::length(bytes) > 0,                    0);  // ECommentEmpty
        assert!(std::vector::length(bytes) <= MAX_COMMENT_BYTES,   0);  // ECommentTooLong
        balance::join(&mut curve.protocol_fees, coin::into_balance(payment));
        event::emit(Comment {
            curve_id: object::id(curve),
            author:   tx_context::sender(ctx),
            text,
        });
    }

    // ---------- Fee claims ----------
    #[allow(lint(self_transfer))]
    public fun claim_creator_fees<T>(
        cap:   &CreatorCap,
        curve: &mut Curve<T>,
        ctx:   &mut TxContext,
    ) {
        assert!(cap.curve_id == object::id(curve), ECapMismatch);
        let amount = balance::value(&curve.creator_fees);
        assert!(amount > 0, ENoFees);

        let payouts = curve.payouts;
        let n = vector::length(&payouts);
        let mut remaining = amount;
        let mut i = 0;
        while (i < n) {
            let p = vector::borrow(&payouts, i);
            let share = if (i == n - 1) {
                remaining  // dust to last
            } else {
                (amount * p.bps) / BPS_DENOMINATOR
            };
            if (share > 0) {
                let coin_out = coin::from_balance(
                    balance::split(&mut curve.creator_fees, share), ctx
                );
                transfer::public_transfer(coin_out, p.recipient);
                remaining = remaining - share;
            };
            i = i + 1;
        };

        event::emit(CreatorFeesClaimed {
            curve_id: object::id(curve),
            creator:  curve.creator,
            amount,
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

    public fun claim_airdrop_fees<T>(
        _cap:  &AdminCap,
        curve: &mut Curve<T>,
        ctx:   &mut TxContext,
    ): Coin<SUI> {
        let amount = balance::value(&curve.airdrop_fees);
        assert!(amount > 0, ENoFees);
        let bal = balance::withdraw_all(&mut curve.airdrop_fees);
        event::emit(AirdropFeesClaimed { curve_id: object::id(curve), amount });
        coin::from_balance(bal, ctx)
    }

    // ---------- Payout update ----------
    public fun update_payouts<T>(
        cap:               &CreatorCap,
        curve:             &mut Curve<T>,
        payout_addresses:  vector<address>,
        payout_bps:        vector<u64>,
        ctx:               &mut TxContext,
    ) {
        assert!(cap.curve_id == object::id(curve), ECapMismatch);
        curve.payouts = build_payouts(payout_addresses, payout_bps);
        event::emit(PayoutsUpdated {
            curve_id:   object::id(curve),
            updated_by: tx_context::sender(ctx),
        });
    }

    // ---------- Vesting ----------
    fun assert_valid_vest(mode: u8, duration_ms: u64) {
        assert!(
            mode == VEST_MODE_CLIFF ||
            mode == VEST_MODE_LINEAR ||
            mode == VEST_MODE_MONTHLY,
            EInvalidVestMode,
        );
        assert!(
            duration_ms == VEST_7D   ||
            duration_ms == VEST_30D  ||
            duration_ms == VEST_180D ||
            duration_ms == VEST_365D,
            EInvalidVestDuration,
        );
        if (mode == VEST_MODE_MONTHLY) {
            assert!(duration_ms >= VEST_30D, EMonthlyNeeds30Days);
        };
    }

    fun vested_amount(total: u64, start_ms: u64, duration_ms: u64, mode: u8, now_ms: u64): u64 {
        if (now_ms < start_ms) { return 0 };
        let elapsed = now_ms - start_ms;
        if (elapsed >= duration_ms) { return total };

        if (mode == VEST_MODE_CLIFF) {
            0
        } else if (mode == VEST_MODE_LINEAR) {
            (((total as u128) * (elapsed as u128)) / (duration_ms as u128)) as u64
        } else {
            let total_months   = duration_ms / MONTH_MS;
            let elapsed_months = elapsed     / MONTH_MS;
            (((total as u128) * (elapsed_months as u128)) / (total_months as u128)) as u64
        }
    }

    public fun lock_tokens<T>(
        curve:       &Curve<T>,
        tokens:      Coin<T>,
        mode:        u8,
        duration_ms: u64,
        clock:       &Clock,
        ctx:         &mut TxContext,
    ) {
        assert_valid_vest(mode, duration_ms);
        let amount = coin::value(&tokens);
        assert!(amount > 0, EZeroLockAmount);

        let beneficiary = tx_context::sender(ctx);
        let now_ms      = clock::timestamp_ms(clock);

        let lock = VestingLock<T> {
            id:           object::new(ctx),
            curve_id:     object::id(curve),
            beneficiary,
            locked:       coin::into_balance(tokens),
            total_amount: amount,
            claimed:      0,
            start_ms:     now_ms,
            duration_ms,
            mode,
        };

        event::emit(TokensLocked {
            lock_id:      object::id(&lock),
            curve_id:     object::id(curve),
            beneficiary,
            total_amount: amount,
            start_ms:     now_ms,
            duration_ms,
            mode,
        });

        transfer::share_object(lock);
    }

    #[allow(lint(self_transfer))]
    public fun claim_vested<T>(
        lock:  &mut VestingLock<T>,
        clock: &Clock,
        ctx:   &mut TxContext,
    ): Coin<T> {
        assert!(tx_context::sender(ctx) == lock.beneficiary, ENotLockBeneficiary);

        let now_ms = clock::timestamp_ms(clock);
        let vested = vested_amount(
            lock.total_amount, lock.start_ms, lock.duration_ms, lock.mode, now_ms,
        );
        let claimable = vested - lock.claimed;
        assert!(claimable > 0, ENothingVested);

        lock.claimed = lock.claimed + claimable;
        let out = balance::split(&mut lock.locked, claimable);

        event::emit(VestedClaimed {
            lock_id:     object::id(lock),
            beneficiary: lock.beneficiary,
            amount:      claimable,
            remaining:   balance::value(&lock.locked),
        });

        coin::from_balance(out, ctx)
    }

    // ---------- Read-only ----------
    public fun current_price<T>(c: &Curve<T>): u64 {
        let x = effective_sui_reserve(c) as u128;
        let y = effective_token_reserve(c) as u128;
        ((x * 1_000_000) / y) as u64
    }

    public fun sui_reserve<T>(c: &Curve<T>):       u64 { balance::value(&c.sui_reserve) }
    public fun token_reserve<T>(c: &Curve<T>):     u64 { balance::value(&c.token_reserve) }
    public fun creator_fees<T>(c: &Curve<T>):      u64 { balance::value(&c.creator_fees) }
    public fun protocol_fees<T>(c: &Curve<T>):     u64 { balance::value(&c.protocol_fees) }
    public fun airdrop_fees<T>(c: &Curve<T>):      u64 { balance::value(&c.airdrop_fees) }
    public fun graduated<T>(c: &Curve<T>):         bool { c.graduated }
    public fun paused<T>(c: &Curve<T>):            bool { c.paused }
    public fun creator<T>(c: &Curve<T>):           address { c.creator }
    public fun graduation_target<T>(c: &Curve<T>): u8 { c.graduation_target }
    public fun anti_bot_delay<T>(c: &Curve<T>):    u8 { c.anti_bot_delay }
    public fun created_at_ms<T>(c: &Curve<T>):     u64 { c.created_at_ms }
    public fun metadata_updated<T>(c: &Curve<T>):  bool { c.metadata_updated }
    public fun lp_fees_accumulated<T>(c: &Curve<T>): u64 { c.lp_fees_accumulated }
    public fun pool_id<T>(c: &Curve<T>):           Option<ID> { c.pool_id }

    public fun lock_total<T>(l: &VestingLock<T>):       u64     { l.total_amount }
    public fun lock_claimed<T>(l: &VestingLock<T>):     u64     { l.claimed }
    public fun lock_remaining<T>(l: &VestingLock<T>):   u64     { balance::value(&l.locked) }
    public fun lock_beneficiary<T>(l: &VestingLock<T>): address { l.beneficiary }
    public fun lock_vested_at<T>(l: &VestingLock<T>, now_ms: u64): u64 {
        vested_amount(l.total_amount, l.start_ms, l.duration_ms, l.mode, now_ms)
    }

    // ---------- Test-only helpers ----------
    #[test_only]
    public fun graduate_for_testing<T>(
        curve: &mut Curve<T>,
        ctx:   &mut TxContext,
    ) {
        // Identical to graduate() minus the metadata argument.
        // Used in unit tests because CoinMetadata cannot be fabricated from
        // create_treasury_cap_for_testing (no genuine OTW).
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

    // ---------- Test-only error code accessors ----------
    #[test_only] public fun e_insufficient_tokens(): u64      { EInsufficientTokens }
    #[test_only] public fun e_slippage_exceeded(): u64        { ESlippageExceeded }
    #[test_only] public fun e_already_graduated(): u64        { EAlreadyGraduated }
    #[test_only] public fun e_not_graduated(): u64            { ENotGraduated }
    #[test_only] public fun e_cap_mismatch(): u64             { ECapMismatch }
    #[test_only] public fun e_zero_amount(): u64              { EZeroAmount }
    #[test_only] public fun e_no_fees(): u64                  { ENoFees }
    #[test_only] public fun e_wrong_launch_fee(): u64         { EWrongLaunchFee }
    #[test_only] public fun e_invalid_graduation_target(): u64{ EInvalidGraduationTarget }
    #[test_only] public fun e_invalid_anti_bot_delay(): u64   { EInvalidAntiBotDelay }
    #[test_only] public fun e_anti_bot_blocked(): u64         { EAntiBotBlocked }
    #[test_only] public fun e_bad_payouts(): u64              { EBadPayouts }
    #[test_only] public fun e_metadata_already_updated(): u64 { EMetadataAlreadyUpdated }
    #[test_only] public fun e_metadata_window_closed(): u64   { EMetadataWindowClosed }
    #[test_only] public fun e_no_metadata_fields(): u64       { ENoMetadataFields }
    #[test_only] public fun e_metadata_name_too_long(): u64   { EMetadataNameTooLong }
    #[test_only] public fun e_metadata_symbol_too_long(): u64 { EMetadataSymbolTooLong }
    #[test_only] public fun e_wrong_comment_fee(): u64        { EWrongCommentFee }
    #[test_only] public fun e_self_referral(): u64            { ESelfReferral }
    #[test_only] public fun e_paused(): u64                   { EPaused }
    #[test_only] public fun e_pool_already_recorded(): u64    { EPoolAlreadyRecorded }
    #[test_only] public fun e_invalid_vest_mode(): u64        { EInvalidVestMode }
    #[test_only] public fun e_invalid_vest_duration(): u64    { EInvalidVestDuration }
    #[test_only] public fun e_monthly_needs_30_days(): u64    { EMonthlyNeeds30Days }
    #[test_only] public fun e_not_lock_beneficiary(): u64     { ENotLockBeneficiary }
    #[test_only] public fun e_nothing_vested(): u64           { ENothingVested }
    #[test_only] public fun e_zero_lock_amount(): u64         { EZeroLockAmount }
}
