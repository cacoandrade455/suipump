/// suipump::bonding_curve
///
/// Exponential bonding-curve token launcher for Sui, inspired by the design
/// patterns of leading Solana launchpads. Every launch gets its own shared
/// `Curve<T>` object.
///
/// Pricing: constant-product with *virtual* reserves (the standard on-chain
/// implementation of an exponential bonding curve). See the comment above
/// `quote_out` for why this is exact and cheap.
///
/// Fee model (1.00% total per trade, three-way split):
///   - 0.40% creator    (40 bps of trade volume)
///   - 0.50% protocol   (50 bps of trade volume)
///   - 0.10% LP/curve   (10 bps of trade volume) -- retained in sui_reserve,
///                                                  deepening liquidity for
///                                                  every holder. Migrates
///                                                  into the DEX pool on
///                                                  graduation.
///
/// Compared to the incumbent Solana launchpad (Creator 0.30% / Protocol
/// 0.95% / LP 0% / Total 1.25%): our total is lower, our creator share is
/// both higher in absolute terms (0.40% vs 0.30%) and much higher as a
/// fraction of the total (40% vs 24%), and a slice goes back into liquidity.
/// The protocol still retains the single largest share.
///
/// Graduation: triggers when the curve's token reserve is empty (all 800M
/// curve-supply tokens sold). The threshold is a *consequence* of the
/// virtual-reserve tuning, not a configured constant. With our reserves
/// (Vs=30k SUI, Vt=1.073B tokens), the curve naturally drains at ~87.9k SUI
/// of real reserves, giving roughly 2x the incumbent's $69k graduation cap
/// at today's SUI price.
///
/// Graduation bonus: creator receives 0.5% of the final reserve as a
/// one-time bonus when the curve migrates to a DEX.
module suipump::bonding_curve {
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

    /// Maximum comment length in bytes.
    const MAX_COMMENT_BYTES: u64 = 280;

    // ---------- Fee tunables (basis points; 10_000 = 100%) ----------
    /// Total trade fee: 1.00%.
    const TRADE_FEE_BPS: u64 = 100;
    /// Split of the trade fee, in bps of the *fee itself*.
    /// Must sum to BPS_DENOMINATOR (10_000).
    const CREATOR_SHARE_BPS: u64 = 4_000;  // 40% of fee  -> 0.40% of volume
    const PROTOCOL_SHARE_BPS: u64 = 5_000; // 50% of fee  -> 0.50% of volume
    const LP_SHARE_BPS: u64 = 1_000;       // 10% of fee  -> 0.10% of volume
    /// Creator bonus on graduation, in bps of the final reserve. 0.50%.
    const CREATOR_GRAD_BONUS_BPS: u64 = 50;
    /// Fee paid to the protocol on each new token launch. 2 SUI.
    /// Intentionally non-trivial to deter spam launches that dilute curation.
    const LAUNCH_FEE_MIST: u64 = 2 * 1_000_000_000;
    /// Maximum number of payout recipients per creator. Matches incumbent.
    const MAX_PAYOUTS: u64 = 10;

    /// Total token supply (1B with 6 decimals).
    const TOTAL_SUPPLY: u64 = 1_000_000_000 * 1_000_000;
    /// Supply sold via the curve (80%). Remaining 20% is minted into the LP
    /// at graduation.
    const CURVE_SUPPLY: u64 = 800_000_000 * 1_000_000;
    /// Virtual reserves — tuned so that the curve naturally drains (all
    /// 800M curve-supply tokens sold) when the real SUI reserve reaches
    /// ~87,900 SUI. Graduation triggers on drain, so there's no separately-
    /// configured threshold that could become unreachable.
    const VIRTUAL_SUI_RESERVE: u64 = 30_000 * 1_000_000_000;
    const VIRTUAL_TOKEN_RESERVE: u64 = 1_073_000_000 * 1_000_000;

    const BPS_DENOMINATOR: u64 = 10_000;

    // ---------- One-time witness for module init ----------
    public struct BONDING_CURVE has drop {}

    // ---------- Admin capability ----------
    /// Held by the protocol deployer. Grants the right to withdraw accumulated
    /// protocol fees from any curve. Transferable — deployer can rotate it to
    /// a multisig or burn it to fully decentralize.
    public struct AdminCap has key, store {
        id: UID,
    }

    // ---------- Creator capability ----------
    /// Transferable ownership token for a specific curve. Whoever holds this
    /// cap can update the payout split and claim creator fees. Matches the
    /// incumbent's "transferable coin ownership" feature: creators can sell
    /// or hand off a launched token's revenue stream without touching the
    /// underlying Curve object.
    public struct CreatorCap has key, store {
        id: UID,
        curve_id: ID,
    }

    /// Single payout recipient inside a curve's split configuration.
    public struct Payout has copy, drop, store {
        recipient: address,
        bps: u64,  // share of *creator fees*, in bps (sums to 10_000 across all entries)
    }

    fun init(_witness: BONDING_CURVE, ctx: &mut TxContext) {
        // Compile-time guard on fee split.
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
        /// Real SUI held by the curve, including the LP-share of accrued fees
        /// (we just leave that portion inside the reserve instead of splitting
        /// it out — that's what makes "LP fees" work).
        sui_reserve: Balance<SUI>,
        /// Tokens still available for purchase from the curve.
        token_reserve: Balance<T>,
        /// TreasuryCap kept inside the curve — no one can mint extra supply.
        treasury: TreasuryCap<T>,
        /// Founding creator address. Informational only — authority to update
        /// payouts or claim fees lives on the CreatorCap.
        creator: address,
        /// Current payout split for creator fees. Mutable via `update_payouts`
        /// when holding the matching CreatorCap.
        payouts: vector<Payout>,
        /// Creator's claimable fee balance. Earmarked — never touched by
        /// protocol withdrawals.
        creator_fees: Balance<SUI>,
        /// Protocol's claimable fee balance. Withdrawn via AdminCap.
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

    public struct PayoutsUpdated has copy, drop {
        curve_id: ID,
        updated_by: address,
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
    /// Legacy single-creator launch. No launch fee; single payout goes 100%
    /// to `creator`. Kept for backward compatibility with already-deployed
    /// curves. New launches should use `create_with_launch_fee`.
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

    /// Internal creation — returns the new `Curve<T>` and `CreatorCap`
    /// without sharing/transferring, so a PTB can chain additional calls
    /// (e.g. dev-buy) on the Curve before it becomes public. The caller's
    /// PTB is responsible for sharing the Curve and handing the cap off;
    /// Move will abort the transaction if either is forgotten (non-drop
    /// resources must be consumed).
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

    /// Finalize a returned Curve: share it so trading is possible. The PTB
    /// calls this after any in-line dev-buy completes. Separate from
    /// `create_and_return` so the PTB can do `buy` first with the non-shared
    /// curve (more efficient — avoids an unnecessary shared-object sequence
    /// point mid-transaction).
    public fun share_curve<T>(curve: Curve<T>) {
        transfer::share_object(curve);
    }

    /// Convenience wrapper for launches with no dev-buy. Returns nothing;
    /// shares the curve and transfers the cap to the sender in one call.
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

    /// Validate and construct a payouts vector. Parallel arrays keep the
    /// public API simple for TypeScript callers; internally we zip them.
    /// Rules:
    ///   - Must have at least 1 entry
    ///   - At most MAX_PAYOUTS (10) entries
    ///   - Same length for both input vectors
    ///   - bps values must sum to exactly BPS_DENOMINATOR (10_000)
    ///   - No duplicate addresses (client-side merge first)
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

            // No duplicates — check against everything already added.
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
    /// Constant product: (x + dx)(y - dy) = xy  =>  dy = y*dx / (x + dx)
    /// Combined with virtual reserves, this exactly reproduces the leading Solana launchpad's
    /// bonding-curve pricing with pure integer math — no fixed-point, no
    /// exponentiation, no rounding drift.
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

    /// Splits a gross fee into (creator, protocol, lp) components.
    /// Rounding errors fall to LP (the "house"), so creator and protocol
    /// are never short-changed.
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

        // Fee off the top, split three ways.
        let fee_amount = (sui_in * TRADE_FEE_BPS) / BPS_DENOMINATOR;
        let (creator_fee, protocol_fee, lp_fee) = split_fee(fee_amount);
        let swap_amount = sui_in - fee_amount;

        // Price against effective (real + virtual) reserves.
        let x = effective_sui_reserve(curve);
        let y = effective_token_reserve(curve);
        let naive_tokens_out = quote_out(swap_amount, x, y);

        // Tail-buy handling: if the naive quote wants more tokens than remain,
        // buy exactly the remainder and compute the actual swap cost in reverse.
        // Any unspent SUI is refunded. This is how a "final buyer" drains the
        // curve — matches the leading Solana launchpad's behavior and prevents dust getting stuck.
        let remaining = balance::value(&curve.token_reserve);
        let (tokens_out, actual_swap) = if (naive_tokens_out > remaining) {
            // dx needed to buy exactly `remaining`:  dx = x * remaining / (y - remaining)
            let needed = (((x as u128) * (remaining as u128))
                          / ((y as u128) - (remaining as u128))) as u64;
            (remaining, needed)
        } else {
            (naive_tokens_out, swap_amount)
        };

        assert!(tokens_out >= min_tokens_out, ESlippageExceeded);

        // Route funds:
        //   creator_fee  -> curve.creator_fees (earmarked)
        //   protocol_fee -> curve.protocol_fees (earmarked)
        //   lp_fee       -> stays in curve.sui_reserve
        //   actual_swap  -> curve.sui_reserve
        //   anything left-over -> refunded to buyer
        let creator_coin = coin::split(&mut payment, creator_fee, ctx);
        let protocol_coin = coin::split(&mut payment, protocol_fee, ctx);
        balance::join(&mut curve.creator_fees, coin::into_balance(creator_coin));
        balance::join(&mut curve.protocol_fees, coin::into_balance(protocol_coin));

        // Pay actual_swap + lp_fee into reserve; whatever's left in `payment`
        // is the refund.
        let to_reserve = actual_swap + lp_fee;
        let reserve_coin = coin::split(&mut payment, to_reserve, ctx);
        balance::join(&mut curve.sui_reserve, coin::into_balance(reserve_coin));
        // `payment` now holds only the refund (zero in the normal case).

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

        // Gross SUI out before fees.
        let x = effective_token_reserve(curve);
        let y = effective_sui_reserve(curve);
        let gross_sui_out = quote_out(amount_in, x, y);

        // Fee on gross output; split three ways.
        let fee_amount = (gross_sui_out * TRADE_FEE_BPS) / BPS_DENOMINATOR;
        let (creator_fee, protocol_fee, lp_fee) = split_fee(fee_amount);
        let net_sui_out = gross_sui_out - fee_amount;
        assert!(net_sui_out >= min_sui_out, ESlippageExceeded);

        // We'll withdraw (gross - lp_fee) — LP portion stays in the reserve.
        let withdraw_amount = gross_sui_out - lp_fee;
        assert!(withdraw_amount <= balance::value(&curve.sui_reserve), EInsufficientTokens);

        balance::join(&mut curve.token_reserve, coin::into_balance(tokens_in));

        let mut out_bal = balance::split(&mut curve.sui_reserve, withdraw_amount);
        let creator_bal = balance::split(&mut out_bal, creator_fee);
        let protocol_bal = balance::split(&mut out_bal, protocol_fee);
        balance::join(&mut curve.creator_fees, creator_bal);
        balance::join(&mut curve.protocol_fees, protocol_bal);
        // out_bal now contains net_sui_out — the seller's payout.

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
    /// Distribute accrued creator fees to all payout recipients per their
    /// configured split. Requires holding the matching CreatorCap. Pays each
    /// recipient directly (transfer happens inside this call) rather than
    /// returning coins — avoids making the caller juggle N coin objects.
    ///
    /// Rounding: the last recipient absorbs any rounding dust so the pool
    /// empties exactly. With integer bps math the total shortfall is at most
    /// `n - 1` MIST, where n = number of recipients.
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
                // Last recipient gets whatever's left — absorbs rounding.
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

    /// Replace the payout split. Requires the matching CreatorCap.
    /// Applies the same validation as launch.
    public fun update_payouts<T>(
        cap: &CreatorCap,
        curve: &mut Curve<T>,
        payout_addresses: vector<address>,
        payout_bps: vector<u64>,
        ctx: &mut TxContext,
    ) {
        assert!(cap.curve_id == object::id(curve), ECapMismatch);
        let new_payouts = build_payouts(payout_addresses, payout_bps);
        curve.payouts = new_payouts;
        event::emit(PayoutsUpdated {
            curve_id: object::id(curve),
            updated_by: tx_context::sender(ctx),
        });
    }

    /// Protocol withdraws its accumulated fees. Requires AdminCap.
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

    // ---------- Graduation ----------
    /// Graduate the curve to a DEX pool. Triggers when the curve has sold
    /// all CURVE_SUPPLY tokens — matches the leading Solana launchpad's actual behavior where
    /// graduation is a consequence of the curve filling up, not a separate
    /// threshold that could be mis-set.
    ///
    /// Returns (SUI side, token side, creator bonus) so the PTB can compose
    /// a Cetus/Turbos pool creation in the same transaction.
    public fun graduate<T>(
        curve: &mut Curve<T>,
        ctx: &mut TxContext,
    ): (Coin<SUI>, Coin<T>, Coin<SUI>) {
        assert!(!curve.graduated, EAlreadyGraduated);
        // Curve is "full" when no tokens remain to sell.
        assert!(balance::value(&curve.token_reserve) == 0, ENotGraduated);

        curve.graduated = true;

        // Mint the LP-side supply (remaining 20%).
        let lp_supply = TOTAL_SUPPLY - CURVE_SUPPLY;
        let lp_tokens_bal = coin::mint_balance(&mut curve.treasury, lp_supply);

        let total_reserve = balance::value(&curve.sui_reserve);
        let creator_bonus_amount =
            (total_reserve * CREATOR_GRAD_BONUS_BPS) / BPS_DENOMINATOR;
        let creator_bonus_bal =
            balance::split(&mut curve.sui_reserve, creator_bonus_amount);

        // Everything else (including accrued LP fees!) migrates into the pool.
        let reserve_bal = balance::withdraw_all(&mut curve.sui_reserve);

        event::emit(Graduated {
            curve_id: object::id(curve),
            final_sui_reserve: total_reserve,
            creator_bonus: creator_bonus_amount,
        });

        (
            coin::from_balance(reserve_bal, ctx),
            coin::from_balance(lp_tokens_bal, ctx),
            coin::from_balance(creator_bonus_bal, ctx),
        )
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

    public fun progress_bps<T>(c: &Curve<T>): u64 {
        // Progress is the fraction of curve tokens sold.
        let sold = CURVE_SUPPLY - balance::value(&c.token_reserve);
        (sold * BPS_DENOMINATOR) / CURVE_SUPPLY
    }

    // Fee-split constants exposed for frontend display.
    public fun trade_fee_bps(): u64 { TRADE_FEE_BPS }
    public fun creator_share_bps(): u64 { CREATOR_SHARE_BPS }
    public fun protocol_share_bps(): u64 { PROTOCOL_SHARE_BPS }
    public fun lp_share_bps(): u64 { LP_SHARE_BPS }
    public fun curve_supply(): u64 { CURVE_SUPPLY }
    public fun launch_fee_mist(): u64 { LAUNCH_FEE_MIST }
    public fun max_payouts(): u64 { MAX_PAYOUTS }

    /// Introspect a curve's current payout split. Returns (addresses, bps)
    /// as parallel vectors. Useful for frontend display.
    public fun payouts<T>(curve: &Curve<T>): (vector<address>, vector<u64>) {
        let n = vector::length(&curve.payouts);
        let mut addrs = vector::empty<address>();
        let mut bps_vec = vector::empty<u64>();
        let mut i: u64 = 0;
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
    /// Post a comment on any curve. Purely event-based — no storage, no objects.
    /// The comment is permanently on-chain via the emitted event.
    /// Any wallet can comment on any curve.
    /// Text is capped at 280 bytes (UTF-8). Empty comments are rejected.
    public fun post_comment<T>(
        curve:  &Curve<T>,
        text:   String,
        ctx:    &mut TxContext,
    ) {
        let bytes = std::string::as_bytes(&text);
        assert!(std::vector::length(bytes) > 0, ECommentEmpty);
        assert!(std::vector::length(bytes) <= MAX_COMMENT_BYTES, ECommentTooLong);
        event::emit(Comment {
            curve_id: object::id(curve),
            author:   tx_context::sender(ctx),
            text,
        });
    }

    // ---------- Test-only helpers ----------
    #[test_only]
    public fun init_for_testing(ctx: &mut TxContext) {
        let cap = AdminCap { id: object::new(ctx) };
        transfer::public_transfer(cap, tx_context::sender(ctx));
    }

    #[test_only] public fun e_already_graduated(): u64 { EAlreadyGraduated }
    #[test_only] public fun e_not_graduated(): u64 { ENotGraduated }
    #[test_only] public fun e_zero_amount(): u64 { EZeroAmount }
    #[test_only] public fun e_no_fees(): u64 { ENoFees }
    #[test_only] public fun e_slippage_exceeded(): u64 { ESlippageExceeded }
    #[test_only] public fun e_payouts_sum_invalid(): u64 { EPayoutsSumInvalid }
    #[test_only] public fun e_payouts_empty(): u64 { EPayoutsEmpty }
    #[test_only] public fun e_too_many_payouts(): u64 { ETooManyPayouts }
    #[test_only] public fun e_duplicate_payout_address(): u64 { EDuplicatePayoutAddress }
    #[test_only] public fun e_wrong_launch_fee(): u64 { EWrongLaunchFee }
    #[test_only] public fun e_cap_mismatch(): u64 { ECapMismatch }
    #[test_only] public fun e_comment_too_long(): u64 { ECommentTooLong }
    #[test_only] public fun e_comment_empty(): u64 { ECommentEmpty }
}
