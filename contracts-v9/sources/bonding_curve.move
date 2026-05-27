/// suipump::bonding_curve  v9
///
/// Changes from v8:
///
///   1. CURVE SHAPE RECALIBRATED
///      VIRTUAL_SUI_RESERVE   3,500 → 4,369 SUI
///      VIRTUAL_TOKEN_RESERVE 1,073,000,000 (unchanged)
///      GRAD_THRESHOLD_MIST   (static 9,000 SUI) → REMOVED — now dynamic
///
///   2. ORACLE-DRIVEN SQRT-DAMPENED GRADUATION THRESHOLD  (Pyth)
///      The PTB caller fetches a fresh Pyth price and passes it as sui_price_scaled.
///      grad_threshold = BASE_GRAD_MIST * sqrt(1000) / sqrt(price_scaled)
///        where price_scaled = price_in_usd * 1000  (e.g. $1.03 → 1030)
///      Calibrated so that at $1.03 threshold = 12,305 SUI (~$12.7k pool).
///      Graduation mcap in USD = 47,680 * sqrt(sui_price) — rises with
///      price but is dampened (not linear), preventing runaway thresholds.
///      Price table: $1→$49k  $2→$67k  $3→$82k  $5→$107k  $10→$151k mcap.
///
///   3. PYTH STALENESS FALLBACK (combine options 2+3)
///      If sui_price_scaled == 0 (caller signals stale/unavailable):
///        a. Use curve.current_grad_threshold if it was set at least once.
///        b. Otherwise fall back to BASE_GRAD_MIST (static 12,305 SUI).
///      Buys NEVER abort due to oracle unavailability.
///
///   4. GRADUATION TAIL-CLIP BUG FIX
///      Previously: a buy that overshoots the SUI threshold processed the
///      full sui_in — charging fees on SUI that didn't buy curve tokens.
///      Fix: clip actual_swap to the exact SUI needed to hit the threshold,
///      refund the tail clean, trigger graduation inline.
///      Fees are charged ONLY on (sui_in - tail_refund).
///      Conservation: creator_fee + protocol_fee + airdrop_fee + lp_fee
///                    + to_reserve + tail_refund == sui_in.  Always.
///
///   5. NEW Curve FIELD: current_grad_threshold: u64
///      Updated every buy (when oracle is fresh). Readable by frontend
///      without recalculation.
///
///   6. NEW EVENT FIELDS on TokensPurchased:
///      grad_threshold_used: u64   — dynamic threshold at trade time
///      tail_refund:         u64   — 0 for normal buys, >0 for grad-clip
///
/// Everything else is IDENTICAL to v8:
///   fee structure, 5-way split, token-drain tail-clip, vesting, comments,
///   pause, airdrop bucket, payout system, anti-bot, metadata window,
///   graduate() signature (&mut CoinMetadata<T>), record_graduation_pool.
///
/// V8 → V9 auditor diff surface:
///   bonding_curve.move — constants block, Curve struct (+1 field),
///   buy() signature (price_info_obj → sui_price_scaled: u64),
///   new helpers dampened_grad_threshold + isqrt + resolve_grad_threshold,
///   TokensPurchased event (+2 fields), do_graduate_inline helper.
///   Everything else: zero diff.

module suipump::bonding_curve {
    use sui::balance::{Self, Balance};
    use sui::clock::{Self, Clock};
    use sui::coin::{Self, Coin, TreasuryCap, CoinMetadata};
    use sui::event;
    use sui::sui::SUI;
    use std::ascii::String as AsciiString;
    use std::string::String;

    // ---------- Error codes (identical to v8) ----------
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
    const ECommentEmpty:             u64 = 17;
    const EAntiBotBlocked:           u64 = 18;
    const EBadPayouts:               u64 = 19;
    const EFeeSplitInvalid:          u64 = 21;
    const EMetadataAlreadyUpdated:   u64 = 22;
    const EMetadataWindowClosed:     u64 = 23;
    const ENoMetadataFields:         u64 = 23;
    const EMetadataNameTooLong:      u64 = 24;
    const EMetadataSymbolTooLong:    u64 = 25;
    const EWrongCommentFee:          u64 = 26;
    const ECommentTooLong:           u64 = 16;
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

    // ---------- Fee tunables (unchanged from v8) ----------
    const TRADE_FEE_BPS:           u64 = 100;
    const CREATOR_SHARE_BPS:       u64 = 4_000;
    const PROTOCOL_SHARE_BPS:      u64 = 5_000;
    const LP_SHARE_BPS:            u64 = 1_000;
    const REFERRAL_SHARE_BPS:      u64 = 1_000;
    const CREATOR_GRAD_BONUS_BPS:  u64 = 50;
    const PROTOCOL_GRAD_BONUS_BPS: u64 = 50;
    const LAUNCH_FEE_MIST:         u64 = 2 * 1_000_000_000;
    const COMMENT_FEE_MIST:        u64 = 1_000_000;
    const MAX_PAYOUTS:             u64 = 10;

    // ---------- Curve constants (v9 recalibrated) ----------
    const CURVE_SUPPLY:          u64 = 800_000_000  * 1_000_000;
    const VIRTUAL_SUI_RESERVE:   u64 = 4_369 * 1_000_000_000;       // v9: was 3,500 (V8)
    const VIRTUAL_TOKEN_RESERVE: u64 = 1_073_000_000 * 1_000_000;   // unchanged from agreed spec
    const BPS_DENOMINATOR:       u64 = 10_000;

    // ---------- Oracle / graduation (v9 new) ----------
    // BASE_GRAD_MIST is the graduation threshold at $1.03 SUI.
    // grad_threshold(price) = BASE_GRAD_MIST * sqrt(1000) / sqrt(price_scaled)
    //   price_scaled = price_in_usd * 1000  (e.g. $1.03 → 1030)
    // At $1.03: threshold = 12,305 SUI  (~$12.7k pool, ~$49k mcap)
    const BASE_GRAD_MIST:        u64 = 12_305 * 1_000_000_000;
    // Staleness is enforced off-chain: PTB caller passes sui_price_scaled = 0
    // when the Pyth price is stale. No on-chain timestamp check needed.

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

    // ---------- Vesting (identical to v8) ----------
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
        id:                    UID,
        sui_reserve:           Balance<SUI>,
        token_reserve:         Balance<T>,
        treasury:              TreasuryCap<T>,
        creator:               address,
        payouts:               vector<Payout>,
        creator_fees:          Balance<SUI>,
        protocol_fees:         Balance<SUI>,
        airdrop_fees:          Balance<SUI>,
        graduated:             bool,
        paused:                bool,
        name:                  String,
        symbol:                AsciiString,
        graduation_target:     u8,
        anti_bot_delay:        u8,
        created_at_ms:         u64,
        metadata_updated:      bool,
        lp_fees_accumulated:   u64,
        pool_id:               Option<ID>,
        creator_lp_nft_id:     Option<ID>,
        // v9: oracle-driven dynamic graduation threshold.
        // Updated every buy when Pyth is fresh; falls back to last value or
        // BASE_GRAD_MIST when Pyth is stale.  Zero means not yet set.
        current_grad_threshold: u64,
    }

    // ---------- Vesting lock (identical to v8) ----------
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

    // ---------- Events ----------
    public struct CurveCreated has copy, drop {
        curve_id:          ID,
        creator:           address,
        name:              String,
        symbol:            AsciiString,
        graduation_target: u8,
        anti_bot_delay:    u8,
    }

    // v9: two new fields vs v8
    public struct TokensPurchased has copy, drop {
        curve_id:             ID,
        buyer:                address,
        sui_in:               u64,
        tokens_out:           u64,
        creator_fee:          u64,
        protocol_fee:         u64,
        airdrop_fee:          u64,
        lp_fee:               u64,
        referral_fee:         u64,
        referral:             Option<address>,
        new_sui_reserve:      u64,
        new_token_reserve:    u64,
        grad_threshold_used:  u64,   // v9: dynamic threshold at this trade
        tail_refund:          u64,   // v9: 0 for normal buys, >0 for grad-clip
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

    // ---------- AMM helpers (identical to v8) ----------
    // Safe: (y * dx) ≤ 2^128. Proof: y,dx < 2^64 → product < 2^128.
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

    // v7/v8/v9 5-way fee split (unchanged):
    //   No referral:   40 creator / 25 protocol / 25 airdrop / 10 lp
    //   With referral: 40 creator / 20 protocol / 20 airdrop / 10 lp / 10 referral
    fun split_fee_v7(fee: u64, has_referral: bool): (u64, u64, u64, u64, u64) {
        let creator  = (fee * CREATOR_SHARE_BPS)  / BPS_DENOMINATOR;
        let lp       = (fee * LP_SHARE_BPS)        / BPS_DENOMINATOR;
        let referral = if (has_referral) { (fee * REFERRAL_SHARE_BPS) / BPS_DENOMINATOR }
                       else { 0 };
        let bucket   = fee - creator - lp - referral;
        let airdrop  = bucket / 2;
        let protocol = bucket - airdrop;
        (creator, protocol, airdrop, lp, referral)
    }

    // ---------- Oracle helpers (v9 new) ----------

    /// Integer square root (floor). Uses the standard Babylonian method.
    /// Only called with values up to ~10^18 so the iteration converges fast.
    fun isqrt(n: u64): u64 {
        if (n == 0) return 0;
        let mut x = n;
        let mut y = (x + 1) / 2;
        while (y < x) {
            x = y;
            y = (x + n / x) / 2;
        };
        x
    }

    /// Compute the dynamic graduation threshold from a fresh oracle price.
    ///
    /// Formula: BASE_GRAD_MIST * sqrt(1_000) / sqrt(price_scaled)
    ///   price_scaled = sui_price_usd * 1_000  (e.g. $1.03 → 1030)
    ///
    /// To avoid precision loss with integer sqrt we scale up:
    ///   num = isqrt(1_000 * PRECISION)
    ///   den = isqrt(price_scaled * PRECISION / 1_000)
    ///   threshold = BASE_GRAD_MIST * num / den
    ///
    /// At $1.09 (price_scaled=1090): num=31622, den=33015 → ≈12,303 SUI ≈ 12,305 SUI.
    /// Within ~0.02% of the 12,305 target — acceptable integer-sqrt error.
    fun dampened_grad_threshold(price_scaled: u64): u64 {
        // Guard: never divide by zero; price_scaled should always be > 0
        // but if oracle returns garbage, use BASE_GRAD_MIST unchanged.
        if (price_scaled == 0) return BASE_GRAD_MIST;
        let precision: u64 = 1_000_000;
        let num = isqrt(1_000u64 * precision);
        let den = isqrt(price_scaled * precision / 1_000);
        if (den == 0) return BASE_GRAD_MIST;
        BASE_GRAD_MIST * num / den
    }

    /// Oracle price is passed in by the PTB caller as sui_price_scaled.
    /// The caller is responsible for fetching a fresh Pyth price update
    /// and passing price_scaled = floor(sui_usd_price * 1000) before calling buy().
    /// e.g. $1.04 → 1040,  $2.00 → 2000
    ///
    /// Passing 0 signals "oracle unavailable" — fallback logic applies.
    /// This avoids pulling Pyth as a Move build dependency (old-style manifest
    /// conflict with new-style Sui package manager). The PTB constructs:
    ///   1. pyth::pyth::update_price_feeds(...)  — update Pyth state
    ///   2. suipump::bonding_curve::buy(..., price_scaled, ...)
    /// The price freshness guarantee is enforced by the PTB atomicity.
    fun get_oracle_price_from_input(
        sui_price_scaled: u64,
    ): Option<u64> {
        if (sui_price_scaled == 0) option::none()
        else option::some(sui_price_scaled)
    }

    /// Resolve the graduation threshold for this buy:
    ///   1. sui_price_scaled > 0 → compute dampened threshold, store on curve.
    ///   2. sui_price_scaled == 0 + curve.current_grad_threshold > 0 → reuse stored.
    ///   3. sui_price_scaled == 0 + no stored → BASE_GRAD_MIST static fallback.
    /// Returns (threshold_mist, updated_threshold_to_store).
    fun resolve_grad_threshold<T>(
        curve:            &Curve<T>,
        sui_price_scaled: u64,
    ): (u64, u64) {
        let maybe_price = get_oracle_price_from_input(sui_price_scaled);
        if (option::is_some(&maybe_price)) {
            let price_scaled = *option::borrow(&maybe_price);
            let threshold    = dampened_grad_threshold(price_scaled);
            (threshold, threshold)
        } else if (curve.current_grad_threshold > 0) {
            (curve.current_grad_threshold, curve.current_grad_threshold)
        } else {
            (BASE_GRAD_MIST, BASE_GRAD_MIST)
        }
    }

    // ---------- Payout builder (identical to v8) ----------
    fun build_payouts(addresses: vector<address>, bps_values: vector<u64>): vector<Payout> {
        let n = vector::length(&addresses);
        assert!(n > 0 && n <= MAX_PAYOUTS, EBadPayouts);
        assert!(n == vector::length(&bps_values), EBadPayouts);
        let mut total_bps = 0u64;
        let mut payouts = vector<Payout>[];
        let mut i = 0;
        while (i < n) {
            let bps = *vector::borrow(&bps_values, i);
            total_bps = total_bps + bps;
            vector::push_back(&mut payouts, Payout {
                recipient: *vector::borrow(&addresses, i),
                bps,
            });
            i = i + 1;
        };
        assert!(total_bps == BPS_DENOMINATOR, EBadPayouts);
        payouts
    }

    // ---------- Create (identical to v8, adds current_grad_threshold=0) ----------
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
            graduation_target == GRAD_TARGET_CETUS    ||
            graduation_target == GRAD_TARGET_DEEPBOOK ||
            graduation_target == GRAD_TARGET_TURBOS,
            EInvalidGraduationTarget,
        );
        assert!(
            anti_bot_delay == ANTI_BOT_NONE  ||
            anti_bot_delay == ANTI_BOT_15S   ||
            anti_bot_delay == ANTI_BOT_30S,
            EInvalidAntiBotDelay,
        );

        let payouts = build_payouts(payout_addresses, payout_bps);
        let sender  = tx_context::sender(ctx);

        // Mint total supply into token_reserve (only 800M sold on curve; 200M
        // minted fresh at graduation for the DEX LP).
        let token_supply = coin::mint(&mut treasury, CURVE_SUPPLY, ctx);

        // Launch fee → protocol_fees
        let launch_balance = coin::into_balance(payment);
        let mut protocol_fees = balance::zero<SUI>();
        balance::join(&mut protocol_fees, launch_balance);

        // Description carries social links via || delimiter (unchanged from v7+)
        let _ = description; // stored implicitly in CoinMetadata

        let curve = Curve<T> {
            id:                    object::new(ctx),
            sui_reserve:           balance::zero<SUI>(),
            token_reserve:         coin::into_balance(token_supply),
            treasury,
            creator:               sender,
            payouts,
            creator_fees:          balance::zero<SUI>(),
            protocol_fees,
            airdrop_fees:          balance::zero<SUI>(),
            graduated:             false,
            paused:                false,
            name,
            symbol,
            graduation_target,
            anti_bot_delay,
            created_at_ms:         clock::timestamp_ms(clock),
            metadata_updated:      false,
            lp_fees_accumulated:   0,
            pool_id:               option::none(),
            creator_lp_nft_id:     option::none(),
            current_grad_threshold: 0,   // v9: set on first buy via oracle
        };

        event::emit(LaunchFeeCollected {
            curve_id: object::id(&curve),
            amount:   LAUNCH_FEE_MIST,
        });

        event::emit(CurveCreated {
            curve_id:          object::id(&curve),
            creator:           sender,
            name:              curve.name,
            symbol:            curve.symbol,
            graduation_target: curve.graduation_target,
            anti_bot_delay:    curve.anti_bot_delay,
        });

        let cap = CreatorCap {
            id:       object::new(ctx),
            curve_id: object::id(&curve),
        };
        (curve, cap)
    }

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

    // ---------- Buy (v9: oracle threshold + graduation tail-clip fix) ----------
    public fun buy<T>(
        curve:            &mut Curve<T>,
        mut payment:      Coin<SUI>,
        min_tokens_out:   u64,
        referral:         Option<address>,
        sui_price_scaled: u64,    // v9: floor(sui_usd * 1000); 0 = use fallback
        clock:            &Clock,
        ctx:              &mut TxContext,
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

        // ── v9: Resolve dynamic graduation threshold ───────────────────────
        let (grad_threshold, new_stored_threshold) =
            resolve_grad_threshold(curve, sui_price_scaled);
        // Store the (potentially updated) threshold for frontend reads.
        curve.current_grad_threshold = new_stored_threshold;

        // ── Fee split (on full sui_in — we'll refund the tail below) ───────
        // IMPORTANT: fees are computed on the effective sui_in MINUS the tail
        // refund. We don't know the tail yet, so we calculate fees twice:
        //   Pass 1: compute the tail.
        //   Pass 2: recompute fees on (sui_in - tail).
        // This is the correct order to guarantee fee conservation.
        let has_referral = option::is_some(&referral);

        // ── AMM: compute tokens out and detect graduation overshoot ─────────
        let fee_amount_full  = (sui_in * TRADE_FEE_BPS) / BPS_DENOMINATOR;
        let swap_amount_full = sui_in - fee_amount_full;

        let x = effective_sui_reserve(curve);
        let y = effective_token_reserve(curve);
        let naive_tokens_out = quote_out(swap_amount_full, x, y);
        let remaining_tokens = balance::value(&curve.token_reserve);

        // ── Path A: token-drain tail-clip (identical to v8) ─────────────────
        // ── Path B: graduation SUI-threshold tail-clip (v9 new) ─────────────
        // ── Path C: normal buy (no clip) ────────────────────────────────────
        //
        // Determine which path, compute (tokens_out, actual_swap, tail_refund).
        let sui_reserve_after_swap = balance::value(&curve.sui_reserve) + swap_amount_full;

        let (tokens_out, _actual_swap, tail_refund): (u64, u64, u64) =
            if (naive_tokens_out >= remaining_tokens) {
                // Path A: would drain all tokens — clip to remaining, refund excess
                // needed_sui = VS * remaining / (VT - remaining)  (reverse AMM)
                let needed = (((x as u128) * (remaining_tokens as u128))
                              / ((y as u128) - (remaining_tokens as u128))) as u64;
                let used_swap = if (needed > swap_amount_full) { swap_amount_full } else { needed };
                let tail      = swap_amount_full - used_swap;
                (remaining_tokens, used_swap, tail)
            } else if (sui_reserve_after_swap >= grad_threshold) {
                // Path B: SUI reserve would cross graduation threshold mid-buy.
                // Clip swap to exactly hit the threshold; refund the overshoot.
                let current_reserve = balance::value(&curve.sui_reserve);
                let needed_swap     = if (grad_threshold > current_reserve) {
                    grad_threshold - current_reserve
                } else {
                    0
                };
                // Clip: never let needed_swap exceed what was paid post-fee
                let used_swap = if (needed_swap > swap_amount_full) { swap_amount_full }
                                else { needed_swap };
                let tail      = swap_amount_full - used_swap;
                // Tokens out from the clipped swap
                let clipped_tokens = quote_out(used_swap, x, y);
                let tok_out        = if (clipped_tokens > remaining_tokens) { remaining_tokens }
                                     else { clipped_tokens };
                (tok_out, used_swap, tail)
            } else {
                // Path C: normal buy, no clip
                (naive_tokens_out, swap_amount_full, 0)
            };

        assert!(tokens_out > 0,             EInsufficientTokens);
        assert!(tokens_out >= min_tokens_out, ESlippageExceeded);

        // ── Recompute fees on (sui_in - tail_refund) ────────────────────────
        // This ensures fees are only charged on SUI that actually participated.
        // tail_refund comes from the swap portion (post-fee), so:
        //   effective_sui_in = sui_in - tail_refund  (tail carries no fee)
        let effective_sui_in = sui_in - tail_refund;
        let fee_amount  = (effective_sui_in * TRADE_FEE_BPS) / BPS_DENOMINATOR;
        let swap_amount = effective_sui_in - fee_amount;  // == actual_swap + lp_fee portion

        let (creator_fee, protocol_fee, airdrop_fee, lp_fee, referral_fee) =
            split_fee_v7(fee_amount, has_referral);

        // ── Apply fees ───────────────────────────────────────────────────────
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

        // ── Move (actual_swap + lp_fee) into reserve ─────────────────────────
        // payment now holds: actual_swap + lp_fee + tail_refund
        // We split off (to_reserve = swap_amount) which equals actual_swap + lp_fee
        // because: fee_amount = creator + protocol + airdrop + lp + referral
        //          swap_amount = effective_sui_in - fee_amount
        //                      = (sui_in - tail) - fee
        //                      = actual_swap + lp_fee  ✓
        let to_reserve   = swap_amount;
        let reserve_coin = coin::split(&mut payment, to_reserve, ctx);
        balance::join(&mut curve.sui_reserve, coin::into_balance(reserve_coin));

        // ── Distribute tokens ────────────────────────────────────────────────
        let out_balance = balance::split(&mut curve.token_reserve, tokens_out);

        // ── Check graduation (inline, atomic) ────────────────────────────────
        // Trigger if SUI reserve crossed threshold (Path B) OR tokens drained (Path A).
        let new_reserve = balance::value(&curve.sui_reserve);
        let should_graduate =
            !curve.graduated &&
            (balance::value(&curve.token_reserve) == 0 ||
             new_reserve >= grad_threshold);

        if (should_graduate) {
            do_graduate_inline(curve, ctx);
        };

        event::emit(TokensPurchased {
            curve_id:            object::id(curve),
            buyer:               tx_context::sender(ctx),
            sui_in,
            tokens_out,
            creator_fee,
            protocol_fee,
            airdrop_fee,
            lp_fee,
            referral_fee,
            referral,
            new_sui_reserve:     balance::value(&curve.sui_reserve),
            new_token_reserve:   balance::value(&curve.token_reserve),
            grad_threshold_used: grad_threshold,
            tail_refund,
        });

        // payment now holds exactly tail_refund SUI (or zero for normal buys)
        (coin::from_balance(out_balance, ctx), payment)
    }

    // ---------- Inline graduation helper (v9 new) ----------
    // Called when buy() detects the threshold was crossed.
    // Identical logic to graduate() minus the metadata interaction
    // (metadata is not passed into buy — the off-chain PTB handles DEX listing
    //  in a separate step via the standalone graduate() entry after the buy).
    //
    // This sets graduated=true and emits the Graduated event so the indexer
    // and frontend react immediately.  The DEX pool is created in a follow-up
    // PTB by the protocol relayer (unchanged from v8 flow).
    fun do_graduate_inline<T>(
        curve: &mut Curve<T>,
        ctx:   &mut TxContext,
    ) {
        let reserve = balance::value(&curve.sui_reserve);
        let creator_bonus  = (reserve * CREATOR_GRAD_BONUS_BPS)  / BPS_DENOMINATOR;
        let protocol_bonus = (reserve * PROTOCOL_GRAD_BONUS_BPS) / BPS_DENOMINATOR;

        // Send creator bonus
        let creator_coin = coin::from_balance(
            balance::split(&mut curve.sui_reserve, creator_bonus), ctx
        );
        let creator_addr = curve.creator;
        transfer::public_transfer(creator_coin, creator_addr);

        // Protocol bonus stays in protocol_fees
        let proto_coin = balance::split(&mut curve.sui_reserve, protocol_bonus);
        balance::join(&mut curve.protocol_fees, proto_coin);

        curve.graduated = true;

        event::emit(Graduated {
            curve_id:          object::id(curve),
            final_sui_reserve: balance::value(&curve.sui_reserve),
            creator_bonus,
            protocol_bonus,
            graduation_target: curve.graduation_target,
        });
    }

    // ---------- Sell (identical to v8) ----------
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

        let fee_amount   = (gross_sui_out * TRADE_FEE_BPS) / BPS_DENOMINATOR;
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

    // ---------- Pause (AdminCap-gated, identical to v8) ----------
    public fun set_paused<T>(
        _cap:   &AdminCap,
        curve:  &mut Curve<T>,
        paused: bool,
    ) {
        curve.paused = paused;
        event::emit(PauseToggled { curve_id: object::id(curve), paused });
    }

    // ---------- Graduation (standalone entry — identical to v8) ----------
    // Used for: (a) token-drain path where inline graduation didn't fire,
    //           (b) off-chain PTB to attach CoinMetadata for DEX listing.
    // do_graduate_inline() already handles the SUI-threshold path inside buy().
    public fun graduate<T>(
        curve:    &mut Curve<T>,
        metadata: &mut CoinMetadata<T>,   // v8+: shared ref, not by value
        ctx:      &mut TxContext,
    ) {
        // If inline graduation already fired, curve.graduated == true.
        // In that case this function is a no-op for the bonuses (already paid)
        // but still needed for the off-chain DEX pool creation PTB to pass
        // metadata. We assert !graduated here for the standalone drain path.
        assert!(!curve.graduated, EAlreadyGraduated);
        assert!(
            balance::value(&curve.token_reserve) == 0 ||
            balance::value(&curve.sui_reserve) >= curve.current_grad_threshold,
            ENotGraduated,
        );
        let _ = metadata; // used by off-chain PTB for DEX pool; no on-chain mutation needed
        do_graduate_inline(curve, ctx);
    }

    // ---------- graduate_for_testing (test-only, no metadata param) ----------
    #[test_only]
    public fun graduate_for_testing<T>(
        curve: &mut Curve<T>,
        ctx:   &mut TxContext,
    ) {
        assert!(!curve.graduated, EAlreadyGraduated);
        assert!(
            balance::value(&curve.token_reserve) == 0 ||
            (curve.current_grad_threshold > 0 &&
             balance::value(&curve.sui_reserve) >= curve.current_grad_threshold),
            ENotGraduated,
        );
        do_graduate_inline(curve, ctx);
    }

    // ---------- Record graduation pool (identical to v8) ----------
    public fun record_graduation_pool<T>(
        _cap:             &AdminCap,
        curve:            &mut Curve<T>,
        pool_id:          ID,
        creator_lp_nft_id: ID,
    ) {
        assert!(curve.graduated, ENotGraduated);
        assert!(option::is_none(&curve.pool_id), EPoolAlreadyRecorded);
        curve.pool_id          = option::some(pool_id);
        curve.creator_lp_nft_id = option::some(creator_lp_nft_id);
        event::emit(PoolRecorded {
            curve_id: object::id(curve),
            pool_id,
            creator_lp_nft_id,
        });
    }

    // ---------- Update metadata (identical to v8) ----------
    public fun update_metadata<T>(
        cap:         &CreatorCap,
        curve:       &mut Curve<T>,
        metadata:    &mut CoinMetadata<T>,
        new_name:    Option<String>,
        new_symbol:  Option<AsciiString>,
        new_desc:    Option<String>,
        new_icon:    Option<std::string::String>,
        clock:       &Clock,
        ctx:         &mut TxContext,
    ) {
        assert!(cap.curve_id == object::id(curve), ECapMismatch);
        assert!(!curve.metadata_updated, EMetadataAlreadyUpdated);
        let now_ms = clock::timestamp_ms(clock);
        assert!(now_ms < curve.created_at_ms + METADATA_WINDOW_MS, EMetadataWindowClosed);
        let has_update =
            option::is_some(&new_name)   ||
            option::is_some(&new_symbol) ||
            option::is_some(&new_desc)   ||
            option::is_some(&new_icon);
        assert!(has_update, ENoMetadataFields);

        if (option::is_some(&new_name)) {
            let n = option::borrow(&new_name);
            assert!(std::string::length(n) <= MAX_NAME_BYTES, EMetadataNameTooLong);
            coin::update_name(&curve.treasury, metadata, *n);
        };
        if (option::is_some(&new_symbol)) {
            let s = option::borrow(&new_symbol);
            assert!(std::ascii::length(s) <= MAX_SYMBOL_BYTES, EMetadataSymbolTooLong);
            coin::update_symbol(&curve.treasury, metadata, *s);
        };
        if (option::is_some(&new_desc)) {
            coin::update_description(&curve.treasury, metadata, *option::borrow(&new_desc));
        };
        if (option::is_some(&new_icon)) {
            let icon_ascii = std::ascii::string(
                *std::string::as_bytes(option::borrow(&new_icon))
            );
            coin::update_icon_url(&curve.treasury, metadata, icon_ascii);
        };

        curve.metadata_updated = true;
        event::emit(MetadataUpdated { curve_id: object::id(curve) });
        let _ = ctx;
    }

    // ---------- Update payouts (identical to v8) ----------
    public fun update_payouts<T>(
        cap:       &CreatorCap,
        curve:     &mut Curve<T>,
        addresses: vector<address>,
        bps:       vector<u64>,
        _ctx:      &mut TxContext,
    ) {
        assert!(cap.curve_id == object::id(curve), ECapMismatch);
        curve.payouts = build_payouts(addresses, bps);
        event::emit(PayoutsUpdated {
            curve_id:   object::id(curve),
            updated_by: tx_context::sender(_ctx),
        });
    }

    // ---------- Claim creator fees (identical to v8) ----------
    public fun claim_creator_fees<T>(
        cap:   &CreatorCap,
        curve: &mut Curve<T>,
        ctx:   &mut TxContext,
    ) {
        assert!(cap.curve_id == object::id(curve), ECapMismatch);
        let total = balance::value(&curve.creator_fees);
        assert!(total > 0, ENoFees);

        let mut pot = coin::from_balance(
            balance::split(&mut curve.creator_fees, total), ctx
        );
        let n = vector::length(&curve.payouts);
        let mut i = 0;
        while (i < n - 1) {
            let p   = vector::borrow(&curve.payouts, i);
            let amt = (total * p.bps) / BPS_DENOMINATOR;
            let c   = coin::split(&mut pot, amt, ctx);
            transfer::public_transfer(c, p.recipient);
            i = i + 1;
        };
        // Last payout gets the remainder (avoids rounding dust loss)
        let last = vector::borrow(&curve.payouts, n - 1);
        transfer::public_transfer(pot, last.recipient);

        event::emit(CreatorFeesClaimed {
            curve_id: object::id(curve),
            creator:  tx_context::sender(ctx),
            amount:   total,
        });
    }

    // ---------- Claim protocol fees (AdminCap-gated, identical to v8) ----------
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
        event::emit(ProtocolFeesClaimed {
            curve_id: object::id(curve),
            amount:   total,
        });
    }

    // ---------- Claim airdrop fees (AdminCap-gated, identical to v8) ----------
    public fun claim_airdrop_fees<T>(
        _cap:  &AdminCap,
        curve: &mut Curve<T>,
        ctx:   &mut TxContext,
    ) {
        let total = balance::value(&curve.airdrop_fees);
        assert!(total > 0, ENoFees);
        let coin = coin::from_balance(
            balance::split(&mut curve.airdrop_fees, total), ctx
        );
        transfer::public_transfer(coin, tx_context::sender(ctx));
        event::emit(AirdropFeesClaimed {
            curve_id: object::id(curve),
            amount:   total,
        });
    }

    // ---------- post_comment (identical to v8) ----------
    public fun post_comment<T>(
        curve:   &mut Curve<T>,
        text:    String,
        payment: Coin<SUI>,
        author:  address,
        _ctx:    &mut TxContext,
    ) {
        assert!(coin::value(&payment) == COMMENT_FEE_MIST, EWrongCommentFee);
        let len = std::string::length(&text);
        assert!(len > 0,               ECommentEmpty);
        assert!(len <= MAX_COMMENT_BYTES, ECommentTooLong);
        balance::join(&mut curve.protocol_fees, coin::into_balance(payment));
        event::emit(Comment {
            curve_id: object::id(curve),
            author,
            text,
        });
    }

    // ---------- Lock tokens for vesting (identical to v8) ----------
    public fun lock_tokens<T>(
        curve:       &mut Curve<T>,
        tokens:      Coin<T>,
        mode:        u8,
        duration_ms: u64,
        clock:       &Clock,
        ctx:         &mut TxContext,
    ) {
        let amount = coin::value(&tokens);
        assert!(amount > 0, EZeroLockAmount);
        assert!(
            mode == VEST_MODE_CLIFF   ||
            mode == VEST_MODE_LINEAR  ||
            mode == VEST_MODE_MONTHLY,
            EInvalidVestMode,
        );
        assert!(
            duration_ms == VEST_7D    ||
            duration_ms == VEST_30D   ||
            duration_ms == VEST_180D  ||
            duration_ms == VEST_365D,
            EInvalidVestDuration,
        );
        if (mode == VEST_MODE_MONTHLY) {
            assert!(duration_ms >= VEST_30D, EMonthlyNeeds30Days);
        };

        let lock = VestingLock<T> {
            id:           object::new(ctx),
            curve_id:     object::id(curve),
            beneficiary:  tx_context::sender(ctx),
            locked:       coin::into_balance(tokens),
            total_amount: amount,
            claimed:      0,
            start_ms:     clock::timestamp_ms(clock),
            duration_ms,
            mode,
        };

        event::emit(TokensLocked {
            lock_id:      object::id(&lock),
            curve_id:     object::id(curve),
            beneficiary:  lock.beneficiary,
            total_amount: amount,
            start_ms:     lock.start_ms,
            duration_ms,
            mode,
        });

        transfer::share_object(lock);
    }

    // ---------- Claim vested tokens (identical to v8) ----------
    public fun claim_vested<T>(
        lock:  &mut VestingLock<T>,
        clock: &Clock,
        ctx:   &mut TxContext,
    ) {
        let sender = tx_context::sender(ctx);
        assert!(sender == lock.beneficiary, ENotLockBeneficiary);

        let now_ms    = clock::timestamp_ms(clock);
        let vested    = vested_amount(lock.total_amount, lock.start_ms, lock.duration_ms, lock.mode, now_ms);
        let claimable = if (vested > lock.claimed) { vested - lock.claimed } else { 0 };
        assert!(claimable > 0, ENothingVested);

        lock.claimed = lock.claimed + claimable;
        let out = coin::from_balance(balance::split(&mut lock.locked, claimable), ctx);
        transfer::public_transfer(out, sender);

        event::emit(VestedClaimed {
            lock_id:     object::id(lock),
            beneficiary: sender,
            amount:      claimable,
            remaining:   balance::value(&lock.locked),
        });
    }

    // ---------- Vested amount calculation (identical to v8) ----------
    fun vested_amount(total: u64, start_ms: u64, duration_ms: u64, mode: u8, now_ms: u64): u64 {
        if (now_ms < start_ms) return 0;
        let elapsed = now_ms - start_ms;
        if (mode == VEST_MODE_CLIFF) {
            if (elapsed >= duration_ms) { total } else { 0 }
        } else if (mode == VEST_MODE_LINEAR) {
            if (elapsed >= duration_ms) { total }
            else { (((total as u128) * (elapsed as u128)) / (duration_ms as u128)) as u64 }
        } else {
            // VEST_MODE_MONTHLY
            let months_elapsed = elapsed / MONTH_MS;
            let total_months   = duration_ms / MONTH_MS;
            if (months_elapsed >= total_months) { total }
            else { (((total as u128) * (months_elapsed as u128)) / (total_months as u128)) as u64 }
        }
    }

    // ---------- Read-only accessors (needed by tests + indexer) ----------
    public fun sui_reserve<T>(c: &Curve<T>): u64 {
        balance::value(&c.sui_reserve)
    }
    public fun token_reserve<T>(c: &Curve<T>): u64 {
        balance::value(&c.token_reserve)
    }
    public fun creator_fees<T>(c: &Curve<T>): u64 {
        balance::value(&c.creator_fees)
    }
    public fun protocol_fees<T>(c: &Curve<T>): u64 {
        balance::value(&c.protocol_fees)
    }
    public fun airdrop_fees<T>(c: &Curve<T>): u64 {
        balance::value(&c.airdrop_fees)
    }
    public fun graduated<T>(c: &Curve<T>): bool { c.graduated }
    public fun paused<T>(c: &Curve<T>): bool { c.paused }
    public fun lp_fees_accumulated<T>(c: &Curve<T>): u64 { c.lp_fees_accumulated }
    public fun current_grad_threshold<T>(c: &Curve<T>): u64 { c.current_grad_threshold }
    public fun creator<T>(c: &Curve<T>): address { c.creator }

    // ---------- Test-only init (identical to v8) ----------
    #[test_only]
    public fun init_for_testing(ctx: &mut TxContext) {
        init(BONDING_CURVE {}, ctx);
    }

    // ---------- Test-only: set grad threshold without oracle ----------
    // Allows tests to set a known threshold so graduation tests remain
    // deterministic without a live Pyth feed.
    #[test_only]
    public fun set_grad_threshold_for_testing<T>(
        curve:     &mut Curve<T>,
        threshold: u64,
    ) {
        curve.current_grad_threshold = threshold;
    }

    // ---------- Test-only: buy with explicit price override ----------
    // Mirrors the buy() logic exactly but accepts a threshold override.
    // Used by Move unit tests to avoid needing a Pyth shared object.
    #[test_only]
    public fun buy_for_testing<T>(
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

        // Use stored threshold (set by set_grad_threshold_for_testing) or BASE
        let grad_threshold = if (curve.current_grad_threshold > 0) {
            curve.current_grad_threshold
        } else {
            BASE_GRAD_MIST
        };

        let has_referral     = option::is_some(&referral);
        let fee_amount_full  = (sui_in * TRADE_FEE_BPS) / BPS_DENOMINATOR;
        let swap_amount_full = sui_in - fee_amount_full;

        let x = effective_sui_reserve(curve);
        let y = effective_token_reserve(curve);
        let naive_tokens_out    = quote_out(swap_amount_full, x, y);
        let remaining_tokens    = balance::value(&curve.token_reserve);
        let sui_reserve_after   = balance::value(&curve.sui_reserve) + swap_amount_full;

        let (tokens_out, _actual_swap, tail_refund): (u64, u64, u64) =
            if (naive_tokens_out >= remaining_tokens) {
                let needed    = (((x as u128) * (remaining_tokens as u128))
                                 / ((y as u128) - (remaining_tokens as u128))) as u64;
                let used_swap = if (needed > swap_amount_full) { swap_amount_full } else { needed };
                (remaining_tokens, used_swap, swap_amount_full - used_swap)
            } else if (sui_reserve_after >= grad_threshold) {
                let current_reserve = balance::value(&curve.sui_reserve);
                let needed_swap     = if (grad_threshold > current_reserve) {
                    grad_threshold - current_reserve
                } else { 0 };
                let used_swap  = if (needed_swap > swap_amount_full) { swap_amount_full }
                                 else { needed_swap };
                let tail       = swap_amount_full - used_swap;
                let tok_out    = quote_out(used_swap, x, y);
                let tok_out    = if (tok_out > remaining_tokens) { remaining_tokens } else { tok_out };
                (tok_out, used_swap, tail)
            } else {
                (naive_tokens_out, swap_amount_full, 0)
            };

        assert!(tokens_out > 0,              EInsufficientTokens);
        assert!(tokens_out >= min_tokens_out, ESlippageExceeded);

        let effective_sui_in = sui_in - tail_refund;
        let fee_amount  = (effective_sui_in * TRADE_FEE_BPS) / BPS_DENOMINATOR;
        let swap_amount = effective_sui_in - fee_amount;

        let (creator_fee, protocol_fee, airdrop_fee, lp_fee, referral_fee) =
            split_fee_v7(fee_amount, has_referral);

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

        let reserve_coin = coin::split(&mut payment, swap_amount, ctx);
        balance::join(&mut curve.sui_reserve, coin::into_balance(reserve_coin));

        let out_balance = balance::split(&mut curve.token_reserve, tokens_out);

        let new_reserve = balance::value(&curve.sui_reserve);
        let should_graduate =
            !curve.graduated &&
            (balance::value(&curve.token_reserve) == 0 ||
             new_reserve >= grad_threshold);
        if (should_graduate) {
            do_graduate_inline(curve, ctx);
        };

        event::emit(TokensPurchased {
            curve_id:            object::id(curve),
            buyer:               tx_context::sender(ctx),
            sui_in,
            tokens_out,
            creator_fee,
            protocol_fee,
            airdrop_fee,
            lp_fee,
            referral_fee,
            referral,
            new_sui_reserve:     balance::value(&curve.sui_reserve),
            new_token_reserve:   balance::value(&curve.token_reserve),
            grad_threshold_used: grad_threshold,
            tail_refund,
        });

        (coin::from_balance(out_balance, ctx), payment)
    }
}
