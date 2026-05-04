/// suipump::bonding_curve v3
///
/// Changes from v2:
///   - `buy()` now calls `try_graduate()` after every purchase.
///   - `try_graduate()` checks if token_reserve == 0 and if so, creates
///     a Cetus CLMM pool atomically in the same transaction.
///   - The separate `graduate()` entrypoint is removed — graduation is
///     now automatic and cannot be manually triggered.
///   - `Move.toml` adds a dependency on CetusClmm.
///
/// Cetus shared object IDs are stored in the GlobalConfig object and
/// passed as arguments to the contract functions that need them.
/// We keep them as parameters (not constants) so the same compiled
/// package works on both testnet and mainnet.
module suipump::bonding_curve {
    use sui::balance::{Self, Balance};
    use sui::coin::{Self, Coin, TreasuryCap, CoinMetadata};
    use sui::event;
    use sui::object::{Self, UID, ID};
    use sui::sui::SUI;
    use sui::transfer;
    use sui::tx_context::{Self, TxContext};
    use sui::clock::Clock;
    use std::string::String;
    use std::ascii::String as AsciiString;
    use std::vector;

    // Cetus CLMM imports
    use cetus_clmm::pool_creator;
    use cetus_clmm::config::GlobalConfig as CetusConfig;
    use cetus_clmm::factory::Pools;

    // ── Constants ────────────────────────────────────────────────────────────
    const CURVE_SUPPLY:      u64 = 800_000_000_000_000;   // 800M × 10^6
    const TOTAL_SUPPLY:      u64 = 1_000_000_000_000_000; // 1B  × 10^6
    const LP_SUPPLY:         u64 = 200_000_000_000_000;   // 200M × 10^6

    const VIRTUAL_SUI:    u128 = 30_000_000_000_000;      // 30k SUI in MIST
    const VIRTUAL_TOKENS: u128 = 1_073_000_000_000_000;   // 1.073B tokens in units

    const BPS_DENOMINATOR:     u64 = 10_000;
    const TRADE_FEE_BPS:       u64 = 100;   // 1.00% total
    const CREATOR_SHARE_BPS:   u64 = 4_000; // 40% of fee
    const PROTOCOL_SHARE_BPS:  u64 = 5_000; // 50% of fee
    const LP_SHARE_BPS:        u64 = 1_000; // 10% of fee

    const GRADUATION_BONUS_BPS: u64 = 50;   // 0.5% of final reserve to creator
    const MAX_PAYOUTS:          u64 = 10;
    const LAUNCH_FEE_MIST:      u64 = 2_000_000_000; // 2 SUI

    // Cetus CLMM: tick_spacing=200 → 1% fee tier, best for volatile new tokens
    const CETUS_TICK_SPACING: u32 = 200;
    // Full-range ticks: ±443600 rounded to nearest multiple of 200
    const CETUS_TICK_LOWER: u32 = 4294523696; // -443600 as u32
    const CETUS_TICK_UPPER: u32 = 443600;

    // Burn address for LP position (makes graduation liquidity permanent)
    const BURN_ADDRESS: address = @0x0000000000000000000000000000000000000000000000000000000000000000;

    // ── Error codes ──────────────────────────────────────────────────────────
    const EZeroAmount:        u64 = 1;
    const ESlippageExceeded:  u64 = 2;
    const EAlreadyGraduated:  u64 = 3;
    const ENotGraduated:      u64 = 4;
    const ENoFees:            u64 = 5;
    const EFeeSplitInvalid:   u64 = 6;
    const EBadPayouts:        u64 = 7;
    const ETooManyPayouts:    u64 = 8;
    const EInsufficientFee:   u64 = 9;

    // ── Structs ──────────────────────────────────────────────────────────────
    public struct BONDING_CURVE has drop {}

    public struct AdminCap has key, store { id: UID }

    public struct Payout has store, copy, drop {
        addr: address,
        bps:  u64,
    }

    public struct CreatorCap has key, store {
        id:       UID,
        curve_id: ID,
    }

    public struct Curve<phantom T> has key {
        id:             UID,
        sui_reserve:    Balance<SUI>,
        token_reserve:  Balance<T>,
        treasury:       TreasuryCap<T>,
        creator:        address,
        creator_fees:   Balance<SUI>,
        protocol_fees:  Balance<SUI>,
        graduated:      bool,
        name:           String,
        symbol:         AsciiString,
        payouts:        vector<Payout>,
    }

    // ── Events ───────────────────────────────────────────────────────────────
    public struct CurveCreated has copy, drop {
        curve_id: ID,
        creator:  address,
        name:     String,
        symbol:   AsciiString,
    }

    public struct TokensPurchased has copy, drop {
        curve_id:          ID,
        buyer:             address,
        sui_in:            u64,
        tokens_out:        u64,
        creator_fee:       u64,
        protocol_fee:      u64,
        lp_fee:            u64,
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

    public struct CurveGraduated has copy, drop {
        curve_id:       ID,
        creator_bonus:  u64,
        pool_sui:       u64,
        lp_tokens:      u64,
    }

    public struct CreatorFeesClaimed has copy, drop {
        curve_id: ID,
        amount:   u64,
    }

    public struct ProtocolFeesClaimed has copy, drop {
        curve_id: ID,
        amount:   u64,
    }

    // ── Init ─────────────────────────────────────────────────────────────────
    fun init(_witness: BONDING_CURVE, ctx: &mut TxContext) {
        assert!(
            CREATOR_SHARE_BPS + PROTOCOL_SHARE_BPS + LP_SHARE_BPS == BPS_DENOMINATOR,
            EFeeSplitInvalid,
        );
        let cap = AdminCap { id: object::new(ctx) };
        transfer::public_transfer(cap, tx_context::sender(ctx));
    }

    // ── Creation ─────────────────────────────────────────────────────────────

    /// Legacy create — no launch fee, single payout to creator.
    /// Kept for backwards compatibility with v1/v2 tokens.
    public fun create<T>(
        mut treasury: TreasuryCap<T>,
        name:    String,
        symbol:  AsciiString,
        creator: address,
        ctx:     &mut TxContext,
    ) {
        let token_balance = coin::mint_balance(&mut treasury, CURVE_SUPPLY);
        let payouts = vector[Payout { addr: creator, bps: BPS_DENOMINATOR }];
        let curve = Curve<T> {
            id:            object::new(ctx),
            sui_reserve:   balance::zero(),
            token_reserve: token_balance,
            treasury,
            creator,
            creator_fees:  balance::zero(),
            protocol_fees: balance::zero(),
            graduated:     false,
            name,
            symbol,
            payouts,
        };
        let curve_id = object::id(&curve);
        event::emit(CurveCreated { curve_id, creator, name, symbol });
        transfer::share_object(curve);
    }

    /// Create and return curve + cap (for PTB dev-buy composition).
    public fun create_and_return<T>(
        mut treasury: TreasuryCap<T>,
        launch_fee:   Coin<SUI>,
        name:         String,
        symbol:       AsciiString,
        payout_addrs: vector<address>,
        payout_bps:   vector<u64>,
        ctx:          &mut TxContext,
    ): (Curve<T>, CreatorCap) {
        assert!(coin::value(&launch_fee) >= LAUNCH_FEE_MIST, EInsufficientFee);
        let payouts = validate_payouts(payout_addrs, payout_bps);
        let token_balance = coin::mint_balance(&mut treasury, CURVE_SUPPLY);
        let creator = tx_context::sender(ctx);
        let launch_fee_balance = coin::into_balance(launch_fee);

        let mut curve = Curve<T> {
            id:            object::new(ctx),
            sui_reserve:   balance::zero(),
            token_reserve: token_balance,
            treasury,
            creator,
            creator_fees:  balance::zero(),
            protocol_fees: launch_fee_balance,
            graduated:     false,
            name,
            symbol,
            payouts,
        };

        let curve_id = object::id(&curve);
        let cap = CreatorCap { id: object::new(ctx), curve_id };
        event::emit(CurveCreated { curve_id, creator, name, symbol });
        (curve, cap)
    }

    public fun share_curve<T>(curve: Curve<T>) {
        transfer::share_object(curve);
    }

    // ── Buy (with auto-graduation) ────────────────────────────────────────────
    /// Buy tokens from the curve. If this purchase drains the curve
    /// (token_reserve == 0 after the swap), graduation is triggered
    /// automatically in the same transaction via try_graduate().
    ///
    /// Graduation requires the Cetus shared objects to be passed in.
    /// On non-graduating buys, cetus_config and cetus_pools are still
    /// passed but not used — this allows a uniform call signature.
    public fun buy<T>(
        curve:        &mut Curve<T>,
        payment:      Coin<SUI>,
        min_out:      u64,
        cetus_config: &CetusConfig,
        cetus_pools:  &mut Pools,
        metadata_t:   &CoinMetadata<T>,
        metadata_sui: &CoinMetadata<SUI>,
        clock:        &Clock,
        ctx:          &mut TxContext,
    ): (Coin<T>, Coin<SUI>) {
        assert!(!curve.graduated, EAlreadyGraduated);
        let sui_in = coin::value(&payment);
        assert!(sui_in > 0, EZeroAmount);

        // Fee split
        let total_fee = (sui_in as u128) * (TRADE_FEE_BPS as u128) / (BPS_DENOMINATOR as u128);
        let creator_fee  = (total_fee * (CREATOR_SHARE_BPS as u128)  / (BPS_DENOMINATOR as u128)) as u64;
        let protocol_fee = (total_fee * (PROTOCOL_SHARE_BPS as u128) / (BPS_DENOMINATOR as u128)) as u64;
        let lp_fee       = (total_fee as u64) - creator_fee - protocol_fee;

        let net_sui = sui_in - (total_fee as u64);

        // Constant-product quote with virtual reserves
        let virt_sui = VIRTUAL_SUI + (balance::value(&curve.sui_reserve) as u128);
        let virt_tok = VIRTUAL_TOKENS - (
            (CURVE_SUPPLY as u128) - (balance::value(&curve.token_reserve) as u128)
        );
        let tokens_out_raw = (net_sui as u128) * virt_tok / (virt_sui + (net_sui as u128));

        // Tail-clip: clamp to remaining supply
        let available = balance::value(&curve.token_reserve);
        let tokens_out;
        let refund_sui;
        if ((tokens_out_raw as u64) >= available) {
            // Drain the curve — recalculate exact SUI needed for all remaining tokens
            let exact_sui_needed = (available as u128) * virt_sui / (virt_tok - (available as u128));
            refund_sui = net_sui - (exact_sui_needed as u64);
            tokens_out = available;
        } else {
            tokens_out = (tokens_out_raw as u64);
            refund_sui = 0u64;
        };

        assert!(tokens_out >= min_out, ESlippageExceeded);

        // Distribute fees
        let mut payment_balance = coin::into_balance(payment);
        let creator_bal  = balance::split(&mut payment_balance, creator_fee);
        let protocol_bal = balance::split(&mut payment_balance, protocol_fee);
        // lp_fee stays in payment_balance (will go into sui_reserve)

        balance::join(&mut curve.creator_fees,  creator_bal);
        balance::join(&mut curve.protocol_fees, protocol_bal);

        // Handle refund
        let refund_coin = if (refund_sui > 0) {
            let refund_bal = balance::split(&mut payment_balance, refund_sui);
            coin::from_balance(refund_bal, ctx)
        } else {
            coin::zero<SUI>(ctx)
        };

        // Net SUI (swap + lp_fee, minus refund) into reserve
        balance::join(&mut curve.sui_reserve, payment_balance);

        // Tokens out
        let token_bal = balance::split(&mut curve.token_reserve, tokens_out);
        let token_coin = coin::from_balance(token_bal, ctx);

        let buyer = tx_context::sender(ctx);
        event::emit(TokensPurchased {
            curve_id: object::id(curve),
            buyer,
            sui_in,
            tokens_out,
            creator_fee,
            protocol_fee,
            lp_fee,
            new_sui_reserve:   balance::value(&curve.sui_reserve),
            new_token_reserve: balance::value(&curve.token_reserve),
        });

        // Auto-graduation: if curve is now drained, graduate to Cetus
        if (balance::value(&curve.token_reserve) == 0) {
            try_graduate(curve, cetus_config, cetus_pools, metadata_t, metadata_sui, clock, ctx);
        };

        (token_coin, refund_coin)
    }

    // ── Auto-graduation (internal) ────────────────────────────────────────────
    /// Called automatically from buy() when token_reserve hits zero.
    /// Creates a Cetus CLMM pool with full-range liquidity and burns the LP position.
    fun try_graduate<T>(
        curve:           &mut Curve<T>,
        cetus_config:    &CetusConfig,
        cetus_pools:     &mut Pools,
        metadata_t:      &CoinMetadata<T>,
        metadata_sui:    &CoinMetadata<SUI>,
        clock:           &Clock,
        ctx:             &mut TxContext,
    ) {
        if (curve.graduated) return;

        let final_reserve = balance::value(&curve.sui_reserve);

        // Creator graduation bonus: 0.5% of final reserve
        let bonus_u128 = (final_reserve as u128) * (GRADUATION_BONUS_BPS as u128)
            / (BPS_DENOMINATOR as u128);
        let bonus_amount = (bonus_u128 as u64);
        let bonus_bal    = balance::split(&mut curve.sui_reserve, bonus_amount);
        let bonus_coin   = coin::from_balance(bonus_bal, ctx);
        transfer::public_transfer(bonus_coin, curve.creator);

        // Mint 200M LP tokens from the locked TreasuryCap
        let lp_balance  = coin::mint_balance(&mut curve.treasury, LP_SUPPLY);
        let lp_coin     = coin::from_balance(lp_balance, ctx);
        let lp_amount   = coin::value(&lp_coin);

        // Extract remaining SUI reserve
        let pool_sui_bal = balance::withdraw_all(&mut curve.sui_reserve);
        let pool_sui_amount = balance::value(&pool_sui_bal);
        let pool_sui_coin = coin::from_balance(pool_sui_bal, ctx);

        // Compute initial sqrt price in Q64.64 format.
        // At graduation: price = pool_sui_coin / lp_coin
        // Both are in their respective smallest units.
        // Token has 6 decimals, SUI has 9 decimals.
        // price_decimal = (pool_sui / 1e9) / (lp_tokens / 1e6)
        //               = pool_sui * 1e6 / (lp_tokens * 1e9)
        //               = pool_sui / (lp_tokens * 1e3)
        // sqrt_price_q64 = sqrt(price_decimal) * 2^64
        let sqrt_price = compute_sqrt_price_q64(pool_sui_amount, lp_amount);

        // Create Cetus CLMM pool with full-range liquidity using create_pool_v2
        let (lp_position, return_token, return_sui) = pool_creator::create_pool_v2<T, SUI>(
            cetus_config,
            cetus_pools,
            CETUS_TICK_SPACING,
            sqrt_price,
            std::string::utf8(b""),
            CETUS_TICK_LOWER,
            CETUS_TICK_UPPER,
            lp_coin,
            pool_sui_coin,
            metadata_t,
            metadata_sui,
            true,
            clock,
            ctx,
        );

        // Burn the LP position NFT — makes liquidity permanent
        transfer::public_transfer(lp_position, BURN_ADDRESS);

        // Return any dust from Cetus.
        // return_token is Coin<T> — send back to creator (tiny amount, rounding dust)
        // return_sui is Coin<SUI> — add to protocol fees
        if (coin::value(&return_token) > 0) {
            transfer::public_transfer(return_token, curve.creator);
        } else {
            coin::destroy_zero(return_token);
        };
        if (coin::value(&return_sui) > 0) {
            balance::join(&mut curve.protocol_fees, coin::into_balance(return_sui));
        } else {
            coin::destroy_zero(return_sui);
        };

        curve.graduated = true;

        event::emit(CurveGraduated {
            curve_id:      object::id(curve),
            creator_bonus: bonus_amount,
            pool_sui:      pool_sui_amount,
            lp_tokens:     lp_amount,
        });
    }

    // ── Sell ─────────────────────────────────────────────────────────────────
    public fun sell<T>(
        curve:    &mut Curve<T>,
        tokens:   Coin<T>,
        min_out:  u64,
        ctx:      &mut TxContext,
    ): Coin<SUI> {
        assert!(!curve.graduated, EAlreadyGraduated);
        let tokens_in = coin::value(&tokens);
        assert!(tokens_in > 0, EZeroAmount);

        let virt_sui = VIRTUAL_SUI + (balance::value(&curve.sui_reserve) as u128);
        let tokens_sold = (CURVE_SUPPLY as u128) - (balance::value(&curve.token_reserve) as u128);
        let virt_tok = VIRTUAL_TOKENS - tokens_sold;
        let gross_sui = (tokens_in as u128) * virt_sui / (virt_tok + (tokens_in as u128));

        let total_fee    = gross_sui * (TRADE_FEE_BPS as u128) / (BPS_DENOMINATOR as u128);
        let creator_fee  = (total_fee * (CREATOR_SHARE_BPS as u128) / (BPS_DENOMINATOR as u128)) as u64;
        let protocol_fee = (total_fee * (PROTOCOL_SHARE_BPS as u128) / (BPS_DENOMINATOR as u128)) as u64;
        let lp_fee       = (total_fee as u64) - creator_fee - protocol_fee;
        let net_sui      = (gross_sui as u64) - (total_fee as u64);

        assert!(net_sui >= min_out, ESlippageExceeded);

        balance::join(&mut curve.token_reserve, coin::into_balance(tokens));
        let creator_bal  = balance::split(&mut curve.sui_reserve, creator_fee);
        let protocol_bal = balance::split(&mut curve.sui_reserve, protocol_fee);
        balance::join(&mut curve.creator_fees,  creator_bal);
        balance::join(&mut curve.protocol_fees, protocol_bal);
        let out_bal = balance::split(&mut curve.sui_reserve, net_sui);

        let seller = tx_context::sender(ctx);
        event::emit(TokensSold {
            curve_id: object::id(curve),
            seller,
            tokens_in,
            sui_out: net_sui,
            creator_fee,
            protocol_fee,
            lp_fee,
            new_sui_reserve:   balance::value(&curve.sui_reserve),
            new_token_reserve: balance::value(&curve.token_reserve),
        });

        coin::from_balance(out_bal, ctx)
    }

    // ── Fee claims ────────────────────────────────────────────────────────────
    public fun claim_creator_fees<T>(
        cap:   &CreatorCap,
        curve: &mut Curve<T>,
        ctx:   &mut TxContext,
    ): Coin<SUI> {
        assert!(cap.curve_id == object::id(curve), ENotGraduated);
        let total = balance::value(&curve.creator_fees);
        assert!(total > 0, ENoFees);

        let mut remaining = balance::withdraw_all(&mut curve.creator_fees);
        let len = vector::length(&curve.payouts);
        let mut i = 0;
        while (i < len - 1) {
            let p = vector::borrow(&curve.payouts, i);
            let share = (total as u128) * (p.bps as u128) / (BPS_DENOMINATOR as u128);
            let share_bal = balance::split(&mut remaining, share as u64);
            transfer::public_transfer(coin::from_balance(share_bal, ctx), p.addr);
            i = i + 1;
        };
        // Last recipient gets the dust
        let last = vector::borrow(&curve.payouts, len - 1);
        let last_coin = coin::from_balance(remaining, ctx);
        transfer::public_transfer(last_coin, last.addr);

        event::emit(CreatorFeesClaimed { curve_id: object::id(curve), amount: total });
        coin::zero<SUI>(ctx)
    }

    public fun claim_protocol_fees<T>(
        _cap:  &AdminCap,
        curve: &mut Curve<T>,
        ctx:   &mut TxContext,
    ): Coin<SUI> {
        let total = balance::value(&curve.protocol_fees);
        assert!(total > 0, ENoFees);
        let bal = balance::withdraw_all(&mut curve.protocol_fees);
        event::emit(ProtocolFeesClaimed { curve_id: object::id(curve), amount: total });
        coin::from_balance(bal, ctx)
    }

    public fun update_payouts<T>(
        cap:          &CreatorCap,
        curve:        &mut Curve<T>,
        payout_addrs: vector<address>,
        payout_bps:   vector<u64>,
    ) {
        assert!(cap.curve_id == object::id(curve), ENotGraduated);
        curve.payouts = validate_payouts(payout_addrs, payout_bps);
    }

    // ── Helpers ───────────────────────────────────────────────────────────────
    fun validate_payouts(
        addrs: vector<address>,
        bps:   vector<u64>,
    ): vector<Payout> {
        let len = vector::length(&addrs);
        assert!(len > 0 && len <= (MAX_PAYOUTS as u64), ETooManyPayouts);
        assert!(vector::length(&bps) == len, EBadPayouts);
        let mut payouts = vector[];
        let mut total   = 0u64;
        let mut i = 0;
        while (i < len) {
            let b = *vector::borrow(&bps, i);
            total = total + b;
            vector::push_back(&mut payouts, Payout {
                addr: *vector::borrow(&addrs, i),
                bps:  b,
            });
            i = i + 1;
        };
        assert!(total == BPS_DENOMINATOR, EBadPayouts);
        payouts
    }

    /// Compute sqrt(price) in Q64.64 fixed-point format for Cetus.
    /// price = sui_amount / token_amount (in raw smallest units)
    /// Adjusted for decimals: token=6, SUI=9
    /// price_decimal = sui_raw * 1e6 / (token_raw * 1e9)
    ///               = sui_raw / (token_raw * 1e3)
    /// sqrt_price_q64 = isqrt(price_decimal * 2^128) as u128
    fun compute_sqrt_price_q64(sui_raw: u64, token_raw: u64): u128 {
        // Scale: price * 2^128 = sui_raw * 10^6 * 2^128 / (token_raw * 10^9)
        //                      = sui_raw * 2^128 / (token_raw * 10^3)
        // isqrt gives us sqrt(price) * 2^64
        let numerator   = (sui_raw as u256) << 128u8;
        let denominator = (token_raw as u256) * 1000u256;
        let scaled = numerator / denominator;
        (isqrt_u256(scaled) as u128)
    }

    fun isqrt_u256(n: u256): u256 {
        if (n == 0u256) return 0u256;
        let mut x = n;
        let mut y = (x + 1u256) / 2u256;
        while (y < x) {
            x = y;
            y = (x + n / x) / 2u256;
        };
        x
    }

    // ── Read-only ─────────────────────────────────────────────────────────────
    public fun current_price<T>(curve: &Curve<T>): u64 {
        let reserve_mist = balance::value(&curve.sui_reserve) as u128;
        let tokens_sold  = (CURVE_SUPPLY as u128) - (balance::value(&curve.token_reserve) as u128);
        let virt_sui     = VIRTUAL_SUI + reserve_mist;
        let virt_tok     = VIRTUAL_TOKENS - tokens_sold;
        // Price in MIST per whole token (6 decimals) = virt_sui * 1e6 / virt_tok
        (virt_sui * 1_000_000u128 / virt_tok) as u64
    }
}
