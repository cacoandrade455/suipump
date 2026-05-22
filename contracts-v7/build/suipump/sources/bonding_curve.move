/// suipump::bonding_curve v7
///
/// Changes from v6:
///   - Curve shape recalibrated: VIRTUAL_SUI_RESERVE 9k -> 3.5k,
///     GRAD_THRESHOLD_MIST 17k -> 9k (~$4k start mcap, ~13x to graduation)
///   - graduation_target now accepts Turbos (2) in addition to Cetus (0) /
///     DeepBook (1); still set once at creation, immutable thereafter
///   - post_comment now charges a 0.001 SUI fee routed into protocol_fees
///   - F-12: buy AND sell assert referral != curve.creator (no self-referral)
///   - F-13: AdminCap-gated `paused` flag; buy and sell both abort when paused
///   - F-06: lp_fees_accumulated — running on-chain counter of LP fees
///   - sell now accepts a referral param (referral earns on all volume)
///   - Airdrop bucket: protocol's fee share splits 50/50 protocol/airdrop on
///     every trade. With referral, the 10-point referral cut is carved evenly
///     (5/5) from the protocol and airdrop sides. New airdrop_fees balance +
///     claim_airdrop_fees (AdminCap).
///   - graduate() now takes CoinMetadata<T> by value and permanently freezes
///     it via public_freeze_object — graduated token identity is immutable.
///   - record_graduation_pool(): AdminCap call to store the DEX pool_id and
///     creator LP NFT id after the off-chain pool-creation PTB runs.
///
/// Fee model (1.00% total per trade):
///   Without referral: 40 creator / 50 protocol-bucket / 10 LP
///                     protocol-bucket splits 25 protocol / 25 airdrop
///   With referral:    40 creator / 40 protocol-bucket / 10 LP / 10 referral
///                     protocol-bucket splits 20 protocol / 20 airdrop
///                     (referral 10 = 5 from protocol + 5 from airdrop)
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
    const EWrongCommentFee:          u64 = 26; // v7: comment fee must be exact
    const ESelfReferral:             u64 = 27; // v7: F-12 referral != creator
    const EPaused:                   u64 = 28; // v7: F-13 trading paused
    const EPoolAlreadyRecorded:      u64 = 29; // v7: record_graduation_pool once
    const EInvalidVestMode:          u64 = 30; // v7: vesting mode out of range
    const EInvalidVestDuration:      u64 = 31; // v7: vesting duration not allowed
    const EMonthlyNeeds30Days:       u64 = 32; // v7: monthly mode needs >= 30d
    const ENotLockBeneficiary:       u64 = 33; // v7: only creator can claim
    const ENothingVested:            u64 = 34; // v7: no unlocked tokens yet
    const EZeroLockAmount:           u64 = 35; // v7: cannot lock an empty coin

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
    const COMMENT_FEE_MIST:        u64 = 1_000_000; // v7: 0.001 SUI
    const MAX_PAYOUTS:             u64 = 10;

    // ---------- Curve constants (v7 recalibrated) ----------
    const TOTAL_SUPPLY:        u64 = 1_000_000_000 * 1_000_000;
    const CURVE_SUPPLY:        u64 = 800_000_000  * 1_000_000;
    const VIRTUAL_SUI_RESERVE: u64 = 3_500 * 1_000_000_000;          // v7: was 9k
    const VIRTUAL_TOKEN_RESERVE: u64 = 1_073_000_000 * 1_000_000;
    const GRAD_THRESHOLD_MIST: u64 = 9_000 * 1_000_000_000;          // v7: was 17k
    const BPS_DENOMINATOR:     u64 = 10_000;

    // Anti-bot delay options (seconds)
    const ANTI_BOT_NONE: u8 = 0;
    const ANTI_BOT_15S:  u8 = 15;
    const ANTI_BOT_30S:  u8 = 30;

    // Graduation targets (v7: Turbos added)
    const GRAD_TARGET_CETUS:    u8 = 0;
    const GRAD_TARGET_DEEPBOOK: u8 = 1;
    const GRAD_TARGET_TURBOS:   u8 = 2;

    // Metadata update window: 24h from launch
    const METADATA_WINDOW_MS: u64 = 24 * 60 * 60 * 1_000;

    // ---------- Vesting (v7 dev-token lock) ----------
    // Vesting modes
    const VEST_MODE_CLIFF:   u8 = 0; // 0% until end, then 100%
    const VEST_MODE_LINEAR:  u8 = 1; // continuous: total * elapsed / duration
    const VEST_MODE_MONTHLY: u8 = 2; // equal monthly steps (requires >= 30d)

    // Allowed durations (ms)
    const VEST_7D:   u64 = 7   * 24 * 60 * 60 * 1_000;
    const VEST_30D:  u64 = 30  * 24 * 60 * 60 * 1_000;
    const VEST_180D: u64 = 180 * 24 * 60 * 60 * 1_000;
    const VEST_365D: u64 = 365 * 24 * 60 * 60 * 1_000;

    // One 30-day month in ms — used for monthly-step math
    const MONTH_MS: u64 = 30 * 24 * 60 * 60 * 1_000;

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
        airdrop_fees:      Balance<SUI>,   // v7: separate airdrop bucket
        graduated:         bool,
        paused:            bool,           // v7: F-13 trading pause
        name:              String,
        symbol:            AsciiString,
        graduation_target: u8,
        anti_bot_delay:    u8,
        created_at_ms:     u64,
        metadata_updated:  bool,
        lp_fees_accumulated: u64,          // v7: F-06 running LP fee counter
        pool_id:           Option<ID>,     // v7: set by record_graduation_pool
        creator_lp_nft_id: Option<ID>,     // v7: set by record_graduation_pool
    }

    // ---------- Vesting lock (v7) ----------
    // Holds locked Coin<T> for a beneficiary. Terms are immutable once created:
    // no function can shorten, cancel, or alter a lock. The only mutation is
    // claim_vested(), which releases the portion unlocked so far.
    // Non-transferable: shared object, but only `beneficiary` can claim.
    public struct VestingLock<phantom T> has key {
        id:           UID,
        curve_id:     ID,
        beneficiary:  address,
        locked:       Balance<T>,  // remaining (unclaimed) tokens
        total_amount: u64,         // original locked amount (never changes)
        claimed:      u64,         // cumulative amount claimed so far
        start_ms:     u64,         // lock start timestamp
        duration_ms:  u64,         // total vesting duration
        mode:         u8,          // VEST_MODE_CLIFF / LINEAR / MONTHLY
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
        airdrop_fee:       u64,            // v7
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
        airdrop_fee:       u64,            // v7
        lp_fee:            u64,
        referral_fee:      u64,            // v7
        referral:          Option<address>, // v7
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

    public struct PoolRecorded has copy, drop {   // v7
        curve_id:          ID,
        pool_id:           ID,
        creator_lp_nft_id: ID,
    }

    public struct TokensLocked has copy, drop {   // v7
        lock_id:      ID,
        curve_id:     ID,
        beneficiary:  address,
        total_amount: u64,
        start_ms:     u64,
        duration_ms:  u64,
        mode:         u8,
    }

    public struct VestedClaimed has copy, drop {  // v7
        lock_id:      ID,
        beneficiary:  address,
        amount:       u64,
        remaining:    u64,
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

    public struct AirdropFeesClaimed has copy, drop {  // v7
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

    public struct PauseToggled has copy, drop {   // v7
        curve_id: ID,
        paused:   bool,
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
        let mut payouts: vector<Payout> = vector[];
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
            airdrop_fees:      balance::zero(),
            graduated:         false,
            paused:            false,
            name,
            symbol,
            graduation_target: GRAD_TARGET_CETUS,
            anti_bot_delay:    ANTI_BOT_NONE,
            created_at_ms:     0,
            metadata_updated:  false,
            lp_fees_accumulated: 0,
            pool_id:           option::none(),
            creator_lp_nft_id: option::none(),
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
            airdrop_fees:      balance::zero(),
            graduated:         false,
            paused:            false,
            name,
            symbol,
            graduation_target,
            anti_bot_delay,
            created_at_ms:     now_ms,
            metadata_updated:  false,
            lp_fees_accumulated: 0,
            pool_id:           option::none(),
            creator_lp_nft_id: option::none(),
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

        let mut out: vector<Payout> = vector[];
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
    //
    // quote_out: constant-product AMM swap output.
    //   out = (y * dx) / (x + dx)
    //
    // u128 overflow safety proof (for auditors):
    //   All three inputs are u64, so each is < 2^64 (~1.84e19).
    //   The only multiplication is `y_u128 * dx_u128`.
    //   A u128 holds values up to 2^128 - 1 (~3.40e38).
    //   Worst case y * dx < 2^64 * 2^64 = 2^128, which is within u128 range
    //   (equality is unreachable since both operands are strictly < 2^64).
    //   In practice values are far smaller: token reserves are bounded by
    //   VIRTUAL_TOKEN_RESERVE (~1.073e15) and SUI reserves by the graduation
    //   threshold plus virtual reserve, so the real product is < ~1e34.
    //   The addition `x_u128 + dx_u128` is two u64s in u128 space: max
    //   < 2^65, no overflow. The divisor is always > 0 because callers
    //   only invoke quote_out with dx > 0 (zero-amount trades are rejected
    //   upstream via EZeroAmount), so x + dx >= dx > 0.
    //   The final `as u64` cast is safe: out <= y (since dx/(x+dx) < 1),
    //   and y originates from a u64 reserve value.
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

    // ---------- Fee splitting (v7) ----------
    //
    // Returns (creator, protocol, airdrop, lp, referral).
    // No referral:  40 creator / 25 protocol / 25 airdrop / 10 lp / 0 referral
    // With referral: 40 creator / 20 protocol / 20 airdrop / 10 lp / 10 referral
    // The protocol-bucket (50 or 40) always splits in half: protocol / airdrop.
    // Remainder dust from integer division lands in protocol.
    fun split_fee_v7(fee: u64, has_referral: bool): (u64, u64, u64, u64, u64) {
        let creator  = (fee * CREATOR_SHARE_BPS) / BPS_DENOMINATOR;
        let lp       = (fee * LP_SHARE_BPS)      / BPS_DENOMINATOR;
        let referral = if (has_referral) {
            (fee * REFERRAL_SHARE_BPS) / BPS_DENOMINATOR
        } else { 0 };
        // protocol-bucket = everything left after creator + lp + referral
        let bucket   = fee - creator - lp - referral;
        // split bucket in half — airdrop gets floor, protocol gets the rest
        let airdrop  = bucket / 2;
        let protocol = bucket - airdrop;
        (creator, protocol, airdrop, lp, referral)
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
        assert!(!curve.paused, EPaused); // v7: F-13
        let sui_in = coin::value(&payment);
        assert!(sui_in > 0, EZeroAmount);

        // v7: F-12 — creator may not self-refer
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

        // v7: F-06 — track LP fees that flow into the reserve
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
        assert!(!curve.paused, EPaused); // v7: F-13
        let amount_in = coin::value(&tokens_in);
        assert!(amount_in > 0, EZeroAmount);

        // v7: F-12 — creator may not self-refer
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

        // LP fee stays in the reserve; everything except lp_fee is withdrawn
        let withdraw_amount = gross_sui_out - lp_fee;
        assert!(withdraw_amount <= balance::value(&curve.sui_reserve), EInsufficientTokens);

        balance::join(&mut curve.token_reserve, coin::into_balance(tokens_in));

        // v7: F-06 — LP fee retained in reserve
        curve.lp_fees_accumulated = curve.lp_fees_accumulated + lp_fee;

        let mut out_bal  = balance::split(&mut curve.sui_reserve, withdraw_amount);
        let creator_bal  = balance::split(&mut out_bal, creator_fee);
        let protocol_bal = balance::split(&mut out_bal, protocol_fee);
        let airdrop_bal  = balance::split(&mut out_bal, airdrop_fee);
        balance::join(&mut curve.creator_fees,  creator_bal);
        balance::join(&mut curve.protocol_fees, protocol_bal);
        balance::join(&mut curve.airdrop_fees,  airdrop_bal);

        // referral paid out directly
        if (referral_fee > 0 && has_referral) {
            let referral_bal = balance::split(&mut out_bal, referral_fee);
            transfer::public_transfer(
                coin::from_balance(referral_bal, ctx),
                *option::borrow(&referral),
            );
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

    // v7: claim the airdrop bucket — AdminCap-gated, mirrors protocol claim
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

    // ---------- Pause (v7: F-13) ----------
    // AdminCap-gated emergency switch. When paused, buy and sell both abort.
    public fun set_paused<T>(
        _cap:   &AdminCap,
        curve:  &mut Curve<T>,
        paused: bool,
    ) {
        curve.paused = paused;
        event::emit(PauseToggled { curve_id: object::id(curve), paused });
    }

    // ---------- Graduation ----------
    // v7: takes CoinMetadata<T> by value and permanently freezes it, locking
    // the graduated token's identity. Metadata can never change post-graduation.
    #[allow(lint(self_transfer, freeze_wrapped))]
    public fun graduate<T>(
        curve:    &mut Curve<T>,
        metadata: CoinMetadata<T>,
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

        // v7: freeze the token's metadata — identity is now permanent
        transfer::public_freeze_object(metadata);

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

    // v7: after the off-chain PTB creates the DEX pool, the admin records the
    // pool id and the creator's LP NFT id on the curve. Callable once.
    public fun record_graduation_pool<T>(
        _cap:              &AdminCap,
        curve:             &mut Curve<T>,
        pool_id:           ID,
        creator_lp_nft_id: ID,
    ) {
        assert!(curve.graduated, ENotGraduated);
        assert!(option::is_none(&curve.pool_id), EPoolAlreadyRecorded);
        curve.pool_id           = option::some(pool_id);
        curve.creator_lp_nft_id = option::some(creator_lp_nft_id);
        event::emit(PoolRecorded {
            curve_id: object::id(curve),
            pool_id,
            creator_lp_nft_id,
        });
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

    // ---------- Comments (v7: 0.001 SUI fee) ----------
    public fun post_comment<T>(
        curve:   &mut Curve<T>,
        payment: Coin<SUI>,
        text:    String,
        ctx:     &mut TxContext,
    ) {
        assert!(coin::value(&payment) == COMMENT_FEE_MIST, EWrongCommentFee);
        let bytes = std::string::as_bytes(&text);
        assert!(std::vector::length(bytes) > 0,                  ECommentEmpty);
        assert!(std::vector::length(bytes) <= MAX_COMMENT_BYTES, ECommentTooLong);

        balance::join(&mut curve.protocol_fees, coin::into_balance(payment));

        event::emit(Comment {
            curve_id: object::id(curve),
            author:   tx_context::sender(ctx),
            text,
        });
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
    public fun airdrop_fees_pending<T>(c: &Curve<T>): u64  { balance::value(&c.airdrop_fees) }
    public fun is_graduated<T>(c: &Curve<T>): bool         { c.graduated }
    public fun is_paused<T>(c: &Curve<T>): bool            { c.paused }
    public fun graduation_target<T>(c: &Curve<T>): u8      { c.graduation_target }
    public fun anti_bot_delay<T>(c: &Curve<T>): u8         { c.anti_bot_delay }
    public fun created_at_ms<T>(c: &Curve<T>): u64         { c.created_at_ms }
    public fun metadata_updated<T>(c: &Curve<T>): bool     { c.metadata_updated }
    public fun lp_fees_accumulated<T>(c: &Curve<T>): u64   { c.lp_fees_accumulated }

    public fun pool_id<T>(c: &Curve<T>): Option<ID>           { c.pool_id }
    public fun creator_lp_nft_id<T>(c: &Curve<T>): Option<ID> { c.creator_lp_nft_id }

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
    public fun comment_fee_mist(): u64     { COMMENT_FEE_MIST }
    public fun curve_supply(): u64         { CURVE_SUPPLY }
    public fun launch_fee_mist(): u64      { LAUNCH_FEE_MIST }
    public fun max_payouts(): u64          { MAX_PAYOUTS }
    public fun virtual_sui_reserve(): u64  { VIRTUAL_SUI_RESERVE }

    public fun payouts<T>(curve: &Curve<T>): (vector<address>, vector<u64>) {
        let n = vector::length(&curve.payouts);
        let mut addrs: vector<address> = vector[];
        let mut bps_vec: vector<u64> = vector[];
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

    // ---------- Vesting (v7 dev-token lock) ----------

    fun assert_valid_vest(mode: u8, duration_ms: u64) {
        assert!(
            mode == VEST_MODE_CLIFF
                || mode == VEST_MODE_LINEAR
                || mode == VEST_MODE_MONTHLY,
            EInvalidVestMode,
        );
        assert!(
            duration_ms == VEST_7D
                || duration_ms == VEST_30D
                || duration_ms == VEST_180D
                || duration_ms == VEST_365D,
            EInvalidVestDuration,
        );
        // Monthly stepping is meaningless below one month.
        if (mode == VEST_MODE_MONTHLY) {
            assert!(duration_ms >= VEST_30D, EMonthlyNeeds30Days);
        };
    }

    // How much of `total` has vested by `now_ms`, given an immutable schedule.
    // Pure function — the single source of truth for all three modes.
    fun vested_amount(
        total: u64,
        start_ms: u64,
        duration_ms: u64,
        mode: u8,
        now_ms: u64,
    ): u64 {
        // Before start: nothing. (now_ms < start can't happen on-chain, but
        // guard anyway so the math is total-order safe.)
        if (now_ms <= start_ms) { return 0 };
        let elapsed = now_ms - start_ms;
        // Fully vested once the whole duration has passed — all modes.
        if (elapsed >= duration_ms) { return total };

        if (mode == VEST_MODE_CLIFF) {
            // Not past duration (checked above) -> nothing yet.
            0
        } else if (mode == VEST_MODE_LINEAR) {
            // total * elapsed / duration, u128 to avoid overflow.
            (((total as u128) * (elapsed as u128)) / (duration_ms as u128)) as u64
        } else {
            // MONTHLY: equal steps. Number of whole months in the schedule,
            // and how many have fully elapsed.
            let total_months   = duration_ms / MONTH_MS;       // >= 1 (>=30d)
            let elapsed_months = elapsed / MONTH_MS;           // < total_months here
            // released = total * elapsed_months / total_months
            (((total as u128) * (elapsed_months as u128))
                / (total_months as u128)) as u64
        }
    }

    // Lock a Coin<T> into a new immutable VestingLock. Anyone can lock their
    // own tokens at any time; the launch flow uses this for the dev-buy.
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
        let now_ms = clock::timestamp_ms(clock);

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

        // Shared so the beneficiary can claim across transactions; claim is
        // gated to `beneficiary` so sharing does not weaken the lock.
        transfer::share_object(lock);
    }

    // Claim whatever has vested so far. Only the beneficiary may call.
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
        // Claimable = vested-so-far minus what was already taken.
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

    // ---------- Vesting read-only ----------
    public fun lock_total<T>(l: &VestingLock<T>): u64        { l.total_amount }
    public fun lock_claimed<T>(l: &VestingLock<T>): u64      { l.claimed }
    public fun lock_remaining<T>(l: &VestingLock<T>): u64    { balance::value(&l.locked) }
    public fun lock_beneficiary<T>(l: &VestingLock<T>): address { l.beneficiary }
    public fun lock_start_ms<T>(l: &VestingLock<T>): u64     { l.start_ms }
    public fun lock_duration_ms<T>(l: &VestingLock<T>): u64  { l.duration_ms }
    public fun lock_mode<T>(l: &VestingLock<T>): u8          { l.mode }
    public fun lock_curve_id<T>(l: &VestingLock<T>): ID      { l.curve_id }

    // Amount vested at a given timestamp — lets the UI show unlock progress.
    public fun lock_vested_at<T>(l: &VestingLock<T>, now_ms: u64): u64 {
        vested_amount(l.total_amount, l.start_ms, l.duration_ms, l.mode, now_ms)
    }

    public fun vest_mode_cliff(): u8   { VEST_MODE_CLIFF }
    public fun vest_mode_linear(): u8  { VEST_MODE_LINEAR }
    public fun vest_mode_monthly(): u8 { VEST_MODE_MONTHLY }
    public fun vest_7d(): u64   { VEST_7D }
    public fun vest_30d(): u64  { VEST_30D }
    public fun vest_180d(): u64 { VEST_180D }
    public fun vest_365d(): u64 { VEST_365D }

    // ---------- Test-only ----------
    #[test_only]
    public fun init_for_testing(ctx: &mut TxContext) {
        transfer::public_transfer(AdminCap { id: object::new(ctx) }, tx_context::sender(ctx));
    }

    // Test-only graduation: identical to graduate() but without the
    // CoinMetadata freeze, since CoinMetadata cannot be fabricated inside
    // the Move test VM (new_coin_metadata is public(package) to sui::coin).
    // Production graduate() — with the real freeze — is unchanged.
    #[test_only]
    #[allow(lint(self_transfer))]
    public fun graduate_for_testing<T>(
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
    #[test_only] public fun e_wrong_comment_fee(): u64       { EWrongCommentFee }
    #[test_only] public fun e_self_referral(): u64           { ESelfReferral }
    #[test_only] public fun e_paused(): u64                  { EPaused }
    #[test_only] public fun e_pool_already_recorded(): u64   { EPoolAlreadyRecorded }
    #[test_only] public fun e_invalid_vest_mode(): u64       { EInvalidVestMode }
    #[test_only] public fun e_invalid_vest_duration(): u64   { EInvalidVestDuration }
    #[test_only] public fun e_monthly_needs_30_days(): u64   { EMonthlyNeeds30Days }
    #[test_only] public fun e_not_lock_beneficiary(): u64    { ENotLockBeneficiary }
    #[test_only] public fun e_nothing_vested(): u64          { ENothingVested }
    #[test_only] public fun e_zero_lock_amount(): u64        { EZeroLockAmount }
}
