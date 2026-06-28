/// suipump::agent_session  (V10)
///
/// Per-user agent wallet: a scoped, revocable, self-custodial-rooted session.
///
/// THE TRUST MODEL (read this before reasoning about safety):
///   A 24/7 agent that trades without the user signing each trade REQUIRES a key
///   the user is not actively holding. That signer is the server-held SESSION
///   key. This cannot be designed away. The goal is to shrink what that key can
///   do to the smallest blast radius the chain allows. On-chain scope here means
///   a fully-compromised session key can ONLY:
///     - buy/sell within suipump::bonding_curve (no arbitrary contract calls),
///     - up to spend_cap,
///     - until expiry_ms,
///     - drawing only from the deposited escrow,
///     - never touch the user's main wallet, never withdraw to an arbitrary addr.
///   Worst case: it churns the user's escrow through legitimate buy/sell; SUI
///   proceeds still land in the USER's escrow. Framing: "scoped, revocable,
///   self-custodial-rooted" — NEVER "non-custodial" without the qualifier.
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
///   Q2: a small gas float per session is the user's responsibility off-module.
///   Q5: session keys live in secrets-manager on testnet, KMS/HSM before mainnet.
module suipump::agent_session {
    use sui::balance::{Self, Balance};
    use sui::coin::{Self, Coin};
    use sui::sui::SUI;
    use sui::clock::{Self, Clock};
    use sui::event;
    use sui::dynamic_object_field as dof;
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

    // ---------- Session object (shared) ----------
    /// A per-user agent session. Shared so the bridge (signing as session_address)
    /// can mutate it. Tokens bought by the session are parked as dynamic object
    /// fields keyed by token type name, so one session can hold many token types.
    public struct AgentSession has key, store {
        id:              UID,
        owner:           address,    // the user (refunds go here; proceeds compound to escrow)
        session_address: address,    // the session keypair's address (tx sender for trades)
        escrow:          Balance<SUI>,
        spent:           u64,        // cumulative SUI spent on buys
        spend_cap:       u64,        // 0 = unbounded
        expiry_ms:       u64,
        revoked:         bool,
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

    // ---------- Open (user's MAIN wallet, ONE signature) ----------
    public fun open_session(
        deposit:         Coin<SUI>,
        session_address: address,
        spend_cap:       u64,
        expiry_ms:       u64,
        ctx:             &mut TxContext,
    ): AgentSession {
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

    // ---------- Internal guard ----------
    fun assert_can_trade(session: &AgentSession, clock: &Clock, ctx: &TxContext) {
        assert!(tx_context::sender(ctx) == session.session_address, ENotSessionKey);
        assert!(!session.revoked, ESessionRevoked);
        assert!(clock::timestamp_ms(clock) < session.expiry_ms, ESessionExpired);
    }

    // ---------- Buy with session (signed by the SESSION key) ----------
    /// The bridge signs this tx with the user's session key (sender ==
    /// session_address). Draws `amount` SUI from escrow, buys on the curve, and
    /// parks the bought tokens ON the session (dynamic object field by type) so
    /// the session can later sell them. Any buy refund returns to escrow.
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

        // Refund (graduation tail / overshoot) compounds back to escrow.
        balance::join(&mut session.escrow, coin::into_balance(refund));

        // Park bought tokens on the session, merging with any existing balance
        // of the same token type held under the type-name key.
        let key = type_name::with_defining_ids<T>();
        if (dof::exists_<TypeName>(&session.id, key)) {
            let existing: &mut Coin<T> = dof::borrow_mut(&mut session.id, key);
            coin::join(existing, tokens);
        } else {
            dof::add(&mut session.id, key, tokens);
        };

        session.spent = session.spent + amount;
        event::emit(SessionBuy {
            session_id: object::id(session),
            sui_spent: amount,
            spent_total: session.spent,
        });
    }

    // ---------- Sell with session (signed by the SESSION key) ----------
    /// Sells `token_amount` of the session-held tokens of type T on the curve;
    /// proceeds compound into escrow.
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

        event::emit(SessionSell {
            session_id: object::id(session),
            sui_received: amount,
            new_escrow: balance::value(&session.escrow),
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
    public fun close_session(
        session: &mut AgentSession,
        ctx:     &mut TxContext,
    ): Coin<SUI> {
        assert!(tx_context::sender(ctx) == session.owner, ENotOwner);
        session.revoked = true;
        let amount = balance::value(&session.escrow);
        let _all = balance::value(&session.escrow);
        let out = coin::from_balance(balance::split(&mut session.escrow, _all), ctx);
        event::emit(SessionClosed { session_id: object::id(session), refunded: amount });
        out
    }

    /// After expiry, anyone may trigger a refund of escrow to the owner (so a
    /// user who lost their session key still gets funds back). Tokens are swept
    /// separately.
    public fun expire_refund(
        session: &mut AgentSession,
        clock:   &Clock,
        ctx:     &mut TxContext,
    ) {
        assert!(clock::timestamp_ms(clock) >= session.expiry_ms, ENotExpiredYet);
        session.revoked = true;
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

    
}
