/// suipump::agent_session  (V11)
///
/// Per-user agent wallet: a scoped, revocable, self-custodial-rooted session.
///
/// THE TRUST MODEL (read this before reasoning about safety):
///   A 24/7 agent that trades without the user signing each trade REQUIRES a key
///   the user is not actively holding. That signer is the server-held SESSION
///   key (V10.1+: held inside a TEE via Turnkey; V11 Phase 2: Nautilus-attested).
///   This cannot be designed away. The goal is to shrink what that key can
///   do to the smallest blast radius the chain allows. On-chain scope here means
///   a fully-compromised session key can ONLY:
///     - buy/sell within suipump::bonding_curve (no arbitrary contract calls),
///     - up to spend_cap,
///     - until expiry_ms,
///     - drawing only from the deposited escrow,
///     - never touch the user's main wallet, never withdraw to an arbitrary addr.
///   Worst case: it churns the user's escrow through legitimate buy/sell; SUI
///   proceeds still land in the USER's escrow. Framing: "scoped, revocable,
///   self-custodial-rooted" -- NEVER "non-custodial" without the qualifier.
///
///   V11 EXCEPTION -- UNIVERSAL TRADING (owner opt-in, default OFF):
///   borrow_for_buy / borrow_tokens_for_sell hand raw coins to the PTB so the
///   trade can execute on ANY venue (legacy V4-V9 curves, post-graduation DEX
///   pools) -- types this module cannot name. While the hot-potato TradeTicket
///   forces settlement in the same tx, the module CANNOT verify the trade was
///   fair or that the coins came back: a compromised session key with universal
///   trading enabled can exfiltrate up to the remaining spend-cap headroom in
///   SUI and any parked tokens it borrows. That is a strictly wider envelope
///   than buy_with_session/sell_with_session, which is why it is gated behind
///   an explicit OWNER-signed enable_universal_trading call per session and is
///   OFF by default. The UI must present this tradeoff plainly.
///
/// WHY IT WORKS WITH NEXUS UNCHANGED:
///   The Leader proves/orchestrates the DAG; the BRIDGE signs the money tx.
///   Per-user just means the bridge signs with the USER'S session key, so the
///   tx sender == session.session_address. Move checks tx_context::sender(ctx)
///   == session.session_address + caps. No signature verification in Move; Sui's
///   native tx auth does it.
///
/// SUI HAS NO ALLOWANCE PRIMITIVE, so "spend from the user's live wallet up to a
/// cap, no escrow" is NOT expressible. Funds MUST sit in the session escrow.
///
/// LOCKED DESIGN DECISIONS:
///   Q1: bought tokens live ON THE SESSION (Option A) so the session can sell
///       them autonomously. Leak bounded: sale proceeds route to escrow.
///   Q3: sell proceeds -> escrow (compound). spend_cap + short expiry are the
///       safety levers, not a starved escrow.
///   Q2: a small gas float per session is the user's responsibility off-module
///       (in practice: the bridge funds the session address at provision time).
///   Q5: session keys live inside Turnkey's enclave (V10.1); Nautilus-attested
///       binding is the V11 Phase 2 follow-up (separate registry module).
///
/// V11 CHANGES (upgrade of the V10 package via its UpgradeCap; all changes are
/// body-level or additive -- no existing public signature or stored-struct
/// layout changes, per Sui upgrade compatibility rules):
///   1. NET-EXPOSURE spend cap: sells now DECREMENT `spent` by
///      min(proceeds, spent). `spend_cap` reads as "max SUI the agent may have
///      deployed at any moment" instead of a lifetime buy odometer, so looping
///      strategies (DCA + TP/SL, copytrade) recycle capital indefinitely inside
///      a bounded risk envelope. Clamped at zero: profitable sells can never
///      mint headroom beyond what the owner authorized.
///   2. UNIVERSAL TRADING via TradeTicket hot potato (owner opt-in): borrow
///      escrow SUI (or parked tokens), trade on any venue in the same PTB,
///      settle back. See the trust-model exception above.
///   3. CLOSED SENTINEL: close_session / expire_refund now also set
///      expiry_ms = 0. `expiry_ms == 0` is the canonical machine-readable
///      "this session is finished" marker (open_session rejects expiry_ms == 0,
///      and an expiry of 0 can never trade since now < 0 is false). Clients
///      should test is_closed() instead of inferring from revoked+escrow.
///   4. V2 EVENTS: SessionBuyV2 / SessionSellV2 carry spent_total AND
///      escrow_after, closing the documented indexer gap. Legacy events are
///      still emitted for indexer continuity.
module suipump::agent_session {
    use sui::balance::{Self, Balance};
    use sui::coin::{Self, Coin};
    use sui::sui::SUI;
    use sui::clock::{Self, Clock};
    use sui::event;
    use sui::dynamic_object_field as dof;
    use sui::dynamic_field as df;
    use std::type_name::{Self, TypeName};
    use suipump::bonding_curve::{Self, Curve};

    // ---------- Errors ----------
    const ENotSessionKey:   u64 = 1; // tx sender != session_address
    const ESessionRevoked:  u64 = 2;
    const ESessionExpired:  u64 = 3;
    const ESpendCapExceeded:u64 = 4;
    const EInsufficientEscrow: u64 = 5;
    const ENotOwner:        u64 = 6; // owner-only action by non-owner
    const ENotExpiredYet:   u64 = 7; // expire_refund before expiry
    // V11:
    const EZeroExpiry:              u64 = 8;  // expiry_ms == 0 is the CLOSED sentinel
    const ETicketSessionMismatch:   u64 = 9;  // ticket settled against a different session
    const ETicketKindMismatch:      u64 = 10; // buy ticket settled as sell or vice versa
    const EUniversalTradingDisabled:u64 = 11; // borrow_* without owner opt-in

    // ---------- Ticket kinds / df keys ----------
    const TICKET_BUY:  u8 = 0;
    const TICKET_SELL: u8 = 1;
    /// dynamic_field marker key: present => owner enabled universal trading.
    const UNIVERSAL_TRADING_KEY: vector<u8> = b"universal_trading";

    // ---------- Session object (shared) ----------
    /// A per-user agent session. Shared so the bridge (signing as session_address)
    /// can mutate it. Tokens bought by the session are parked as dynamic object
    /// fields keyed by token type name, so one session can hold many token types.
    /// LAYOUT FROZEN: no fields may be added/removed/reordered (Sui upgrade rule
    /// for stored structs). New per-session state goes in dynamic fields.
    public struct AgentSession has key, store {
        id:              UID,
        owner:           address,    // the user (refunds go here; proceeds compound to escrow)
        session_address: address,    // the session keypair's address (tx sender for trades)
        escrow:          Balance<SUI>,
        spent:           u64,        // V11: NET SUI currently deployed (buys - clamped sell credits)
        spend_cap:       u64,        // 0 = unbounded
        expiry_ms:       u64,        // V11: 0 is the CLOSED sentinel (never a valid open value)
        revoked:         bool,
    }

    // ---------- Hot potato (V11) ----------
    /// NO abilities: cannot be stored, copied, dropped, or transferred -- the
    /// transaction cannot commit until a settle_* consumes it. Binds the borrow
    /// to one session and one direction, and remembers how much was charged
    /// against the cap so settlement credit can be clamped (an attacker-supplied
    /// oversized "leftover" must never mint headroom).
    public struct TradeTicket {
        session_id: ID,
        borrowed:   u64, // buy: SUI charged against the cap. sell: token amount taken (informational).
        kind:       u8,  // TICKET_BUY | TICKET_SELL
    }

    // ---------- Events ----------
    public struct SessionOpened has copy, drop {
        session_id: ID, owner: address, session_address: address,
        deposit: u64, spend_cap: u64, expiry_ms: u64,
    }
    public struct SessionToppedUp has copy, drop { session_id: ID, amount: u64, new_escrow: u64 }
    public struct SessionBuy  has copy, drop { session_id: ID, sui_spent: u64, spent_total: u64 }
    public struct SessionSell has copy, drop { session_id: ID, sui_received: u64, new_escrow: u64 }
    public struct SessionClosed has copy, drop { session_id: ID, refunded: u64 }
    // V11 events (event structs cannot gain fields under upgrade rules, so these
    // are NEW types; the legacy events above are still emitted alongside).
    public struct SessionBuyV2 has copy, drop {
        session_id: ID, sui_spent: u64, spent_total: u64, escrow_after: u64,
        universal: bool, // true when executed via borrow/settle (any-venue path)
    }
    public struct SessionSellV2 has copy, drop {
        session_id: ID, sui_received: u64, spent_total: u64, escrow_after: u64,
        universal: bool,
    }
    public struct UniversalTradingToggled has copy, drop { session_id: ID, enabled: bool }

    // ---------- Open (user's MAIN wallet, ONE signature) ----------
    public fun open_session(
        deposit:         Coin<SUI>,
        session_address: address,
        spend_cap:       u64,
        expiry_ms:       u64,
        ctx:             &mut TxContext,
    ): AgentSession {
        // V11: expiry_ms == 0 is reserved as the CLOSED sentinel. (No Clock in
        // this signature and signatures are frozen by upgrade rules, so a
        // stronger "expiry in the future" check is not expressible here; a
        // past expiry only yields a session that can never trade.)
        assert!(expiry_ms > 0, EZeroExpiry);
        let owner = tx_context::sender(ctx);
        let amount = coin::value(&deposit);
        let session = AgentSession {
            id:              object::new(ctx),
            owner,
            session_address,
            escrow:          coin::into_balance(deposit),
            spent:           0,
            spend_cap,
            expiry_ms,
            revoked:         false,
        };
        event::emit(SessionOpened {
            session_id: object::id(&session),
            owner, session_address, deposit: amount, spend_cap, expiry_ms,
        });
        session
    }

    /// Convenience entry: open and share in one call.
    public fun open_and_share(
        deposit:         Coin<SUI>,
        session_address: address,
        spend_cap:       u64,
        expiry_ms:       u64,
        ctx:             &mut TxContext,
    ) {
        let session = open_session(deposit, session_address, spend_cap, expiry_ms, ctx);
        transfer::share_object(session);
    }

    // ---------- Top up (owner adds escrow) ----------
    public fun top_up_session(
        session: &mut AgentSession,
        deposit: Coin<SUI>,
        ctx:     &mut TxContext,
    ) {
        assert!(tx_context::sender(ctx) == session.owner, ENotOwner);
        let amount = coin::value(&deposit);
        balance::join(&mut session.escrow, coin::into_balance(deposit));
        event::emit(SessionToppedUp {
            session_id: object::id(session),
            amount,
            new_escrow: balance::value(&session.escrow),
        });
    }

    // ---------- Internal guards / helpers ----------
    fun assert_can_trade(session: &AgentSession, clock: &Clock, ctx: &TxContext) {
        assert!(tx_context::sender(ctx) == session.session_address, ENotSessionKey);
        assert!(!session.revoked, ESessionRevoked);
        assert!(clock::timestamp_ms(clock) < session.expiry_ms, ESessionExpired);
    }

    /// V11 net-exposure credit: reduce `spent` by `amount`, clamped at zero.
    /// Clamping is a safety property, not a convenience: proceeds above cost
    /// basis (or donated coins in the universal path) must never create
    /// headroom beyond the owner-authorized cap.
    fun credit_spent(session: &mut AgentSession, amount: u64) {
        let credit = if (amount > session.spent) { session.spent } else { amount };
        session.spent = session.spent - credit;
    }

    /// Park tokens on the session, merging with any existing balance of the
    /// same type. Zero-value coins are destroyed instead of parked.
    fun park_tokens<T>(session: &mut AgentSession, tokens: Coin<T>) {
        if (coin::value(&tokens) == 0) {
            coin::destroy_zero(tokens);
            return
        };
        let key = type_name::with_defining_ids<T>();
        if (dof::exists_<TypeName>(&session.id, key)) {
            let existing: &mut Coin<T> = dof::borrow_mut(&mut session.id, key);
            coin::join(existing, tokens);
        } else {
            dof::add(&mut session.id, key, tokens);
        };
    }

    // ---------- Buy with session (signed by the SESSION key) ----------
    /// The bridge signs this tx with the user's session key (sender ==
    /// session_address). Draws `amount` SUI from escrow, buys on the curve, and
    /// parks the bought tokens ON the session (dynamic object field by type) so
    /// the session can later sell them. Any buy refund returns to escrow.
    /// This is the NARROW path: only suipump::bonding_curve, coins never
    /// touchable by the PTB. Preferred whenever the curve is current-package.
    public fun buy_with_session<T>(
        session:          &mut AgentSession,
        curve:            &mut Curve<T>,
        amount:           u64,
        min_tokens_out:   u64,
        sui_price_scaled: u64,
        clock:            &Clock,
        ctx:              &mut TxContext,
    ) {
        assert_can_trade(session, clock, ctx);
        assert!(balance::value(&session.escrow) >= amount, EInsufficientEscrow);
        if (session.spend_cap > 0) {
            assert!(session.spent + amount <= session.spend_cap, ESpendCapExceeded);
        };

        let payment = coin::from_balance(balance::split(&mut session.escrow, amount), ctx);
        let (tokens, refund) = bonding_curve::buy<T>(
            curve, payment, min_tokens_out, option::none<address>(),
            sui_price_scaled, clock, ctx,
        );

        // Refund (graduation tail / overshoot) compounds back to escrow AND is
        // credited back against the cap (V11: it was never actually deployed).
        let refund_amount = coin::value(&refund);
        balance::join(&mut session.escrow, coin::into_balance(refund));

        park_tokens(session, tokens);

        session.spent = session.spent + amount;
        credit_spent(session, refund_amount);
        event::emit(SessionBuy {
            session_id: object::id(session),
            sui_spent: amount - refund_amount,
            spent_total: session.spent,
        });
        event::emit(SessionBuyV2 {
            session_id: object::id(session),
            sui_spent: amount - refund_amount,
            spent_total: session.spent,
            escrow_after: balance::value(&session.escrow),
            universal: false,
        });
    }

    // ---------- Sell with session (signed by the SESSION key) ----------
    /// Sells `token_amount` of the session-held tokens of type T on the curve;
    /// proceeds compound into escrow. V11: proceeds also CREDIT the spend cap
    /// (net-exposure semantics), clamped at zero.
    public fun sell_with_session<T>(
        session:      &mut AgentSession,
        curve:        &mut Curve<T>,
        token_amount: u64,
        min_sui_out:  u64,
        clock:        &Clock,
        ctx:          &mut TxContext,
    ) {
        assert_can_trade(session, clock, ctx);
        let key = type_name::with_defining_ids<T>();
        let held: &mut Coin<T> = dof::borrow_mut(&mut session.id, key);
        let to_sell = coin::split(held, token_amount, ctx);

        let proceeds = bonding_curve::sell<T>(
            curve, to_sell, min_sui_out, option::none<address>(), ctx,
        );
        let amount = coin::value(&proceeds);
        balance::join(&mut session.escrow, coin::into_balance(proceeds));

        credit_spent(session, amount);
        event::emit(SessionSell {
            session_id: object::id(session),
            sui_received: amount,
            new_escrow: balance::value(&session.escrow),
        });
        event::emit(SessionSellV2 {
            session_id: object::id(session),
            sui_received: amount,
            spent_total: session.spent,
            escrow_after: balance::value(&session.escrow),
            universal: false,
        });
    }

    // ---------- Universal trading (V11, owner opt-in) ----------
    /// Owner explicitly widens the session's envelope: with this flag set, the
    /// session key may borrow escrow SUI / parked tokens against a hot potato
    /// and route the trade through ANY venue in the same PTB (legacy V4-V9
    /// curves, post-graduation DEX pools). See the trust-model exception in the
    /// module docs: this trades V10's "coins never leave module custody" for
    /// venue universality, bounded by spend_cap / expiry / revoke.
    public fun enable_universal_trading(session: &mut AgentSession, ctx: &TxContext) {
        assert!(tx_context::sender(ctx) == session.owner, ENotOwner);
        if (!df::exists_(&session.id, UNIVERSAL_TRADING_KEY)) {
            df::add(&mut session.id, UNIVERSAL_TRADING_KEY, true);
        };
        event::emit(UniversalTradingToggled { session_id: object::id(session), enabled: true });
    }

    /// Owner narrows the envelope back to module-custody trading only.
    public fun disable_universal_trading(session: &mut AgentSession, ctx: &TxContext) {
        assert!(tx_context::sender(ctx) == session.owner, ENotOwner);
        if (df::exists_(&session.id, UNIVERSAL_TRADING_KEY)) {
            let _: bool = df::remove(&mut session.id, UNIVERSAL_TRADING_KEY);
        };
        event::emit(UniversalTradingToggled { session_id: object::id(session), enabled: false });
    }

    public fun universal_trading_enabled(session: &AgentSession): bool {
        df::exists_(&session.id, UNIVERSAL_TRADING_KEY)
    }

    /// Borrow escrow SUI for one atomic buy on any venue. Charges the FULL
    /// amount against the cap immediately (pessimistic: multiple borrows in one
    /// PTB each see the prior charges, so combined borrows can never exceed the
    /// cap); settle_buy credits back the clamped leftover.
    public fun borrow_for_buy(
        session: &mut AgentSession,
        amount:  u64,
        clock:   &Clock,
        ctx:     &mut TxContext,
    ): (Coin<SUI>, TradeTicket) {
        assert_can_trade(session, clock, ctx);
        assert!(universal_trading_enabled(session), EUniversalTradingDisabled);
        assert!(balance::value(&session.escrow) >= amount, EInsufficientEscrow);
        if (session.spend_cap > 0) {
            assert!(session.spent + amount <= session.spend_cap, ESpendCapExceeded);
        };
        session.spent = session.spent + amount;
        let funds = coin::from_balance(balance::split(&mut session.escrow, amount), ctx);
        let ticket = TradeTicket {
            session_id: object::id(session),
            borrowed:   amount,
            kind:       TICKET_BUY,
        };
        (funds, ticket)
    }

    /// Settle a buy borrow: park what was bought, rejoin unspent SUI to escrow.
    /// Leftover credit against the cap is clamped to the borrowed amount so an
    /// attacker-supplied oversized coin cannot mint headroom (any excess simply
    /// donates to the owner's escrow).
    public fun settle_buy<T>(
        session:  &mut AgentSession,
        ticket:   TradeTicket,
        leftover: Coin<SUI>,
        tokens:   Coin<T>,
        _ctx:     &mut TxContext,
    ) {
        let TradeTicket { session_id, borrowed, kind } = ticket;
        assert!(session_id == object::id(session), ETicketSessionMismatch);
        assert!(kind == TICKET_BUY, ETicketKindMismatch);

        let leftover_amount = coin::value(&leftover);
        balance::join(&mut session.escrow, coin::into_balance(leftover));
        let credit = if (leftover_amount > borrowed) { borrowed } else { leftover_amount };
        credit_spent(session, credit);

        park_tokens(session, tokens);

        let net_spent = borrowed - credit;
        event::emit(SessionBuy {
            session_id: object::id(session),
            sui_spent: net_spent,
            spent_total: session.spent,
        });
        event::emit(SessionBuyV2 {
            session_id: object::id(session),
            sui_spent: net_spent,
            spent_total: session.spent,
            escrow_after: balance::value(&session.escrow),
            universal: true,
        });
    }

    /// Borrow parked tokens for one atomic sell on any venue.
    public fun borrow_tokens_for_sell<T>(
        session:      &mut AgentSession,
        token_amount: u64,
        clock:        &Clock,
        ctx:          &mut TxContext,
    ): (Coin<T>, TradeTicket) {
        assert_can_trade(session, clock, ctx);
        assert!(universal_trading_enabled(session), EUniversalTradingDisabled);
        let key = type_name::with_defining_ids<T>();
        let held: &mut Coin<T> = dof::borrow_mut(&mut session.id, key);
        let to_sell = coin::split(held, token_amount, ctx);
        let ticket = TradeTicket {
            session_id: object::id(session),
            borrowed:   token_amount,
            kind:       TICKET_SELL,
        };
        (to_sell, ticket)
    }

    /// Settle a sell borrow: proceeds compound to escrow and credit the cap
    /// (net-exposure, clamped at zero by credit_spent); unsold tokens re-park.
    public fun settle_sell<T>(
        session:  &mut AgentSession,
        ticket:   TradeTicket,
        proceeds: Coin<SUI>,
        leftover_tokens: Coin<T>,
        _ctx:     &mut TxContext,
    ) {
        let TradeTicket { session_id, borrowed: _, kind } = ticket;
        assert!(session_id == object::id(session), ETicketSessionMismatch);
        assert!(kind == TICKET_SELL, ETicketKindMismatch);

        let amount = coin::value(&proceeds);
        balance::join(&mut session.escrow, coin::into_balance(proceeds));
        credit_spent(session, amount);

        park_tokens(session, leftover_tokens);

        event::emit(SessionSell {
            session_id: object::id(session),
            sui_received: amount,
            new_escrow: balance::value(&session.escrow),
        });
        event::emit(SessionSellV2 {
            session_id: object::id(session),
            sui_received: amount,
            spent_total: session.spent,
            escrow_after: balance::value(&session.escrow),
            universal: true,
        });
    }

    // ---------- Revoke (owner kills the session immediately) ----------
    public fun revoke_session(session: &mut AgentSession, ctx: &TxContext) {
        assert!(tx_context::sender(ctx) == session.owner, ENotOwner);
        session.revoked = true;
    }

    // ---------- Close / refund (owner reclaims escrow) ----------
    /// Owner closes the session and reclaims the remaining escrow. Any parked
    /// token balances must be swept first via sweep_token<T> (one call per type).
    /// V11: also sets the expiry_ms == 0 CLOSED sentinel (the shared object
    /// survives close, so clients need a deterministic "finished" marker).
    public fun close_session(
        session: &mut AgentSession,
        ctx:     &mut TxContext,
    ): Coin<SUI> {
        assert!(tx_context::sender(ctx) == session.owner, ENotOwner);
        session.revoked = true;
        session.expiry_ms = 0;
        let amount = balance::value(&session.escrow);
        let _all = balance::value(&session.escrow);
        let out = coin::from_balance(balance::split(&mut session.escrow, _all), ctx);
        event::emit(SessionClosed { session_id: object::id(session), refunded: amount });
        out
    }

    /// After expiry, anyone may trigger a refund of escrow to the owner (so a
    /// user who lost their session key still gets funds back). Tokens are swept
    /// separately. V11: also sets the CLOSED sentinel.
    public fun expire_refund(
        session: &mut AgentSession,
        clock:   &Clock,
        ctx:     &mut TxContext,
    ) {
        assert!(clock::timestamp_ms(clock) >= session.expiry_ms, ENotExpiredYet);
        session.revoked = true;
        session.expiry_ms = 0;
        let amount = balance::value(&session.escrow);
        let _all = balance::value(&session.escrow);
        let out = coin::from_balance(balance::split(&mut session.escrow, _all), ctx);
        transfer::public_transfer(out, session.owner);
        event::emit(SessionClosed { session_id: object::id(session), refunded: amount });
    }

    /// Sweep a parked token balance of type T back to the owner (owner-only).
    public fun sweep_token<T>(
        session: &mut AgentSession,
        ctx:     &mut TxContext,
    ) {
        assert!(tx_context::sender(ctx) == session.owner, ENotOwner);
        let key = type_name::with_defining_ids<T>();
        let tokens: Coin<T> = dof::remove(&mut session.id, key);
        transfer::public_transfer(tokens, session.owner);
    }

    // ---------- Accessors ----------
    public fun owner(s: &AgentSession): address { s.owner }
    public fun session_address(s: &AgentSession): address { s.session_address }
    public fun escrow_value(s: &AgentSession): u64 { balance::value(&s.escrow) }
    public fun spent(s: &AgentSession): u64 { s.spent }
    public fun spend_cap(s: &AgentSession): u64 { s.spend_cap }
    public fun expiry_ms(s: &AgentSession): u64 { s.expiry_ms }
    public fun revoked(s: &AgentSession): bool { s.revoked }
    /// V11: canonical "session is finished" test (set by close/expire_refund).
    public fun is_closed(s: &AgentSession): bool { s.expiry_ms == 0 }
}
