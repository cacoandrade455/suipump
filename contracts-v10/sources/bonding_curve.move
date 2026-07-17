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
    use sui::table::{Self, Table};
    use sui::dynamic_field as df;
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
    // ---------- V10 error codes ----------
    const ENotActiveCreator:         u64 = 36; // cap is not the curve's active creator cap
    const EHolderOnly:               u64 = 37; // action requires token balance > 0
    const EBuybackBpsTooHigh:        u64 = 38; // buyback_bps > BPS_DENOMINATOR
    const ENoBuyback:                u64 = 39; // execute_buyback called with empty buyback bucket
    const ECreatorStillActive:       u64 = 40; // CTO: creator not inactive long enough
    const ECtoOnCooldown:            u64 = 41; // CTO: within post-failure cooldown
    const EBelowNominateThreshold:   u64 = 42; // CTO: nominator holds < 1% circulating
    const ECtoWrongCurve:            u64 = 44; // CTO: proposal/curve id mismatch
    const ECtoVoteClosed:            u64 = 45; // CTO: vote window has closed
    const ECtoVoteStillOpen:         u64 = 46; // CTO: vote window has not yet closed
    const ECtoAlreadyResolved:       u64 = 48; // CTO: proposal already resolved
    // V12:
    const ECommentGateNoop:          u64 = 50; // toggle called with the current value
    // V13: graduation exit path (restored; lost in the v8->v9 rewrite).
    const ELpAlreadyClaimed:         u64 = 51; // claim_graduation_funds already drained this curve
    const EReserveTooLow:            u64 = 52; // F-2: graduated reserve below the mint-site floor
    const EPriceOutOfBand:           u64 = 43; // V13: set_sui_price outside [MIN,MAX]_PRICE_SCALED
    const EPreMintedSupply:          u64 = 53; // F-1: TreasuryCap had supply before create_and_return
    const EPriceConfigExists:        u64 = 54; // V13: create_price_config already called on this AdminCap
    // V13: escrow-weighted CTO redesign (shared proposal + Coin<T> escrow).
    const ECtoProposalLive:          u64 = 55; // CTO: a live proposal already exists for this curve
    const ECtoBelowMinVote:          u64 = 56; // CTO: vote coin below the MIN_VOTE spam floor
    const ECtoNotVoter:              u64 = 57; // CTO: unvote/reclaim by an address with no escrow entry
    const ECtoNotResolved:           u64 = 58; // CTO: reclaim before the proposal is resolved
    const ECtoZeroCirculating:       u64 = 59; // CTO: propose against a curve with 0 circulating supply / 0 stake
    const ECtoProposerBondLocked:    u64 = 60; // PASS-C-1: proposer may not unvote below the nominate bond while live

    /// V12 comments toggle: dynamic-field marker on the curve. Marker ABSENT =
    /// holder-gated (the V10/V11 default, preserved); marker PRESENT = open
    /// comments (anyone may post). Stored as a dynamic field because the
    /// stored Curve<T> struct layout is frozen under upgrade rules.
    const COMMENTS_UNGATED_KEY: vector<u8> = b"comments_ungated";
    // V13: one-shot marker for claim_graduation_funds. Dynamic field on curve.id
    // (no struct-layout change, upgrade-safe). PRESENT = the graduation reserve +
    // 200M LP have already been claimed. This guard is EXPLICIT and self-contained
    // — it does not depend on "nothing refills sui_reserve post-graduation" being
    // enforced by buy/sell/execute_buyback, so a future reserve-touching function
    // cannot silently re-open the 200M mint.
    const GRAD_CLAIMED_KEY:     vector<u8> = b"grad_funds_claimed";
    // V13: one-shot marker for create_price_config. Dynamic field on the
    // AdminCap's UID (which is why create_price_config takes &mut AdminCap).
    // PRESENT = the admin entrypoint already shared the upgrade-path PriceConfig,
    // so a second call aborts EPriceConfigExists instead of minting a duplicate
    // config that could de-synchronize clients pinning SUIPUMP_PRICE_CONFIG.
    const PRICE_CONFIG_CREATED_KEY: vector<u8> = b"price_config_created";
    // V13: escrow-weighted CTO. Dynamic field on curve.id holding the live
    // TakeoverProposal's ID. PRESENT = a proposal is open for this curve (blocks a
    // second concurrent proposal); removed at resolve so a later CTO can open.
    const CTO_LIVE_PROPOSAL_KEY: vector<u8> = b"cto_live_proposal";

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

    // ---------- V10: Community Takeover (CTO) constants ----------
    const CTO_INACTIVITY_MS: u64 = 5  * 24 * 60 * 60 * 1_000; // 5-day creator inactivity gate
    const CTO_WINDOW_MS:     u64 = 72 * 60 * 60 * 1_000;      // 72-hour vote window
    const CTO_COOLDOWN_MS:   u64 = 3  * 24 * 60 * 60 * 1_000; // 3-day post-failure cooldown
    const CTO_NOMINATE_BPS:  u64 = 100;   // nominator must hold >= 1% of circulating supply
    const CTO_QUORUM_BPS:    u64 = 2_500; // quorum: escrowed weight must reach 25% of circulating
    const CTO_MIN_VOTE_BPS:  u64 = 1;     // 0.01% of CURVE_SUPPLY: per-vote table-spam floor

    // ---------- Curve constants (v9 recalibrated) ----------
    const CURVE_SUPPLY:          u64 = 800_000_000  * 1_000_000;
    // V13: total supply == curve supply + graduation LP allocation. The 200M LP
    // (TOTAL_SUPPLY - CURVE_SUPPLY) is minted fresh at claim_graduation_funds and
    // handed to the protocol relayer to seed the DEX pool. Mirrors V8's exit path.
    const TOTAL_SUPPLY:          u64 = 1_000_000_000 * 1_000_000;
    const VIRTUAL_SUI_RESERVE:   u64 = 4_369 * 1_000_000_000;       // v9: was 3,500 (V8)
    const VIRTUAL_TOKEN_RESERVE: u64 = 1_073_000_000 * 1_000_000;   // unchanged from agreed spec
    const BPS_DENOMINATOR:       u64 = 10_000;

    // ---------- Graduation threshold: protocol-published price (V13) ----------
    // BASE_GRAD_MIST is the graduation threshold AT $1.00 SUI (price_scaled=1000).
    // It is the anchor the sqrt dampener pivots on:
    //   grad_threshold(price) = BASE_GRAD_MIST * sqrt(1000) / sqrt(price_scaled)
    //   price_scaled = floor(sui_usd * 1000)   e.g. $0.75 -> 750
    // Threshold FALLS as SUI appreciates, so graduation mcap scales with
    // sqrt(price) not linearly. At BASE = 9,000 (max reachable reserve = 12,803):
    //   $0.49  12,857 SUI  ->  above the 12,803 ceiling: crossover, drain path
    //   $0.75  10,392 SUI  ->  $31.2k mcap
    //   $1.00   9,000 SUI  ->  $36.0k mcap
    //   $2.00   6,363 SUI  ->  $50.9k mcap
    //   $5.00   4,024 SUI  ->  $80.5k mcap
    //   $10.00  2,845 SUI  ->  $113.8k mcap
    //   $100      900 SUI  ->  $360k mcap
    const BASE_GRAD_MIST:        u64 = 9_000 * 1_000_000_000;
    // ---------- V13: protocol-published price reference ----------
    // The SUI/USD price is published by the protocol relayer via set_sui_price
    // (AdminCap-gated) into the shared PriceConfig object. buy() READS it; the
    // caller cannot supply, choose, or influence it. This deletes F-2 (a caller
    // passing an inflated price to collapse the threshold) at the root rather
    // than clamping a hostile input into a narrower band. Bounds are enforced AT
    // THE SETTER, so a fat-fingered or compromised push cannot write garbage.
    const MIN_PRICE_SCALED:      u64 = 100;      // $0.10 SUI
    const MAX_PRICE_SCALED:      u64 = 100_000;  // $100.00 SUI
    // A published price older than this is IGNORED and buy() falls back to the
    // static BASE_GRAD_MIST. buy() must NEVER abort on a stale price: a dead
    // relayer must not halt trading. Push cadence is 5 min, so 30 min tolerates
    // several missed pushes.
    const PRICE_MAX_AGE_MS:      u64 = 30 * 60 * 1_000;
    // Mint-site backstop: claim_graduation_funds refuses to drain the reserve and
    // mint the 200M LP below this. Must sit BELOW the smallest LEGITIMATE
    // threshold, which is 900 SUI at MAX_PRICE_SCALED ($100). 500 never blocks a
    // real graduation anywhere in the [$0.10, $100] band.
    const MIN_GRAD_RESERVE_MIST: u64 = 500 * 1_000_000_000;

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

    /// V13 (audit E-1): the ONLY capability that can publish the SUI/USD price
    /// via set_sui_price. Deliberately split out of AdminCap because the price
    /// relayer must hold a HOT key online publishing every ~5 min, and AdminCap
    /// also drains every graduated reserve, mints the 200M LP, and pauses
    /// trading. SECURITY PROPERTY: compromise of the hot relayer key holding
    /// this cap can ONLY push a price already clamped to [MIN,MAX]_PRICE_SCALED
    /// - it can never touch reserves, minting, fees, pause, or the enclave
    /// registry. Nothing else in the package accepts a &PriceRelayerCap.
    public struct PriceRelayerCap has key, store { id: UID }

    /// V13: the protocol-published SUI/USD reference the dampened graduation
    /// threshold reads. Shared so buy() can take it by reference; only the
    /// PriceRelayerCap holder can write it (set_sui_price). Replaces V9's
    /// caller-supplied sui_price_scaled: u64, which was F-2.
    public struct PriceConfig has key {
        id:               UID,
        sui_price_scaled: u64,  // floor(sui_usd * 1000); 0 = never published
        updated_at_ms:    u64,  // clock ms at last publish; 0 = never published
    }

    /// Emitted on every price publish: the public audit trail proving the
    /// protocol is not skewing graduation timing.
    public struct SuiPriceUpdated has copy, drop {
        price_scaled:  u64,
        updated_at_ms: u64,
    }

    /// V13 (audit E-1): emitted at the single site that mints the PriceRelayerCap
    /// (init on a fresh publish, create_price_config on an upgrade) so the publish
    /// runbook can capture and hand the hot relayer key its cap id.
    public struct PriceRelayerCapIssued has copy, drop {
        cap_id: ID,
    }
    public struct CreatorCap has key, store {
        id:       UID,
        curve_id: ID,
    }

    public struct Payout has copy, drop, store {
        recipient: address,
        bps:       u64,
    }

    /// PACKAGE INVARIANT (audit PREPUBLISH-2): EXACTLY ONE PriceConfig and
    /// EXACTLY ONE PriceRelayerCap exist per package, and the two bootstrap paths
    /// are mutually exclusive. A FRESH publish runs init, which creates the one
    /// canonical PriceConfig + relayer cap AND sets the PRICE_CONFIG_CREATED_KEY
    /// one-shot marker on the AdminCap (so create_price_config can never run and
    /// mint a duplicate). A V13 UPGRADE does not run init; the admin instead calls
    /// create_price_config exactly once (its own one-shot marker guards a second
    /// call). Either way the package ends with a single canonical PriceConfig and a
    /// single PriceRelayerCap. This uniqueness is load-bearing: resolve_grad_threshold
    /// performs NO identity check on the &PriceConfig it is handed, so if two shared
    /// PriceConfig objects could coexist a caller could pick the graduation threshold
    /// by choosing which config to pass (the object-form of F-2). One-shot uniqueness
    /// is what makes the missing identity check safe, so the marker must NEVER be
    /// relaxed on either path. (Defense-in-depth follow-up: pin the canonical config
    /// id and assert it in buy()/buy_with_session - deferred, post-mainnet.)
    fun init(_witness: BONDING_CURVE, ctx: &mut TxContext) {
        assert!(
            CREATOR_SHARE_BPS + PROTOCOL_SHARE_BPS + LP_SHARE_BPS == BPS_DENOMINATOR,
            EFeeSplitInvalid,
        );
        // PREPUBLISH-2: set the one-shot marker on the AdminCap BEFORE transferring
        // it, so create_price_config aborts EPriceConfigExists on a fresh publish too
        // - init already created the one canonical PriceConfig below. Without this a
        // fresh publish could end with a SECOND PriceConfig (and a second relayer cap).
        let mut admin = AdminCap { id: object::new(ctx) };
        df::add(&mut admin.id, PRICE_CONFIG_CREATED_KEY, true);
        transfer::public_transfer(admin, tx_context::sender(ctx));
        // V13 (audit E-1): mint the price-only relayer cap on the FRESH-publish
        // path (the stated mainnet plan) so the hot relayer key never needs the
        // AdminCap. create_price_config mints the analogous cap on the upgrade
        // path. Handed to the publisher, who forwards it to the relayer key.
        let relayer_cap = PriceRelayerCap { id: object::new(ctx) };
        event::emit(PriceRelayerCapIssued { cap_id: object::id(&relayer_cap) });
        transfer::public_transfer(relayer_cap, tx_context::sender(ctx));
        // V13: one shared PriceConfig per package. Starts UNSET (0), so every buy
        // falls back to the static BASE_GRAD_MIST until the relayer publishes the
        // first price. Launching before the relayer runs is therefore safe.
        // PREPUBLISH-2: this is the SINGLE canonical PriceConfig for a fresh publish;
        // the marker set above makes create_price_config unable to add a second one.
        transfer::share_object(PriceConfig {
            id:               object::new(ctx),
            sui_price_scaled: 0,
            updated_at_ms:    0,
        });
    }

    /// V13: publish the SUI/USD reference. PriceRelayerCap-gated (audit E-1);
    /// called by the protocol relayer every ~5 min with the median of three
    /// independent sources. Bounds asserted here, so a garbage source /
    /// fat-finger / compromised RELAYER cap cannot write an out-of-band value.
    /// Reads then need no clamp.
    /// E-1: this is the ONLY function gated on PriceRelayerCap, and it is NO
    /// LONGER callable with an AdminCap - the parameter type is PriceRelayerCap
    /// and Move type-checks the argument, so there is no dual-path escape hatch.
    /// A compromised hot relayer key can therefore only shift graduation timing
    /// within the clamped [MIN,MAX]_PRICE_SCALED band; it can never drain a
    /// reserve, mint the 200M LP, claim fees, or pause a curve (all AdminCap).
    /// CENTRALIZATION (disclose): the protocol still publishes the number the
    /// graduation threshold is computed from; every write emits SuiPriceUpdated.
    public fun set_sui_price(
        _cap:         &PriceRelayerCap,
        cfg:          &mut PriceConfig,
        price_scaled: u64,
        clock:        &Clock,
    ) {
        assert!(
            price_scaled >= MIN_PRICE_SCALED && price_scaled <= MAX_PRICE_SCALED,
            EPriceOutOfBand,
        );
        cfg.sui_price_scaled = price_scaled;
        cfg.updated_at_ms    = clock::timestamp_ms(clock);
        event::emit(SuiPriceUpdated {
            price_scaled,
            updated_at_ms: cfg.updated_at_ms,
        });
    }

    /// V13 upgrade bootstrap: share the PriceConfig on an UPGRADED package.
    /// init only runs on a FRESH publish, so the V10-lineage upgrade would
    /// otherwise land with buy() taking &PriceConfig and NO PriceConfig object
    /// in existence - every V13-dispatched buy would be unconstructable.
    /// Shares the exact UNSET state init creates (sui_price_scaled = 0,
    /// updated_at_ms = 0), so the BASE_GRAD_MIST fallback applies until the
    /// relayer publishes the first price.
    /// Must be called EXACTLY ONCE by the AdminCap holder immediately after the
    /// V13 upgrade; upgrades do not run init. Clients pin the resulting object
    /// id via SUIPUMP_PRICE_CONFIG.
    /// One-shot: a dynamic-field marker on the AdminCap's UID
    /// (PRICE_CONFIG_CREATED_KEY) makes any second call abort
    /// EPriceConfigExists.
    /// E-1: mints exactly one PriceRelayerCap (the ONLY price-setting authority)
    /// alongside the PriceConfig, transferred to the admin caller, who forwards
    /// it to the hot relayer key. The same one-shot marker bounds it to a single
    /// cap per package, so a second call cannot mint a duplicate relayer cap.
    /// PREPUBLISH-2 / PACKAGE INVARIANT: EXACTLY ONE PriceConfig and EXACTLY ONE
    /// PriceRelayerCap per package, on BOTH publish paths, mutually exclusive. On a
    /// FRESH publish init already set PRICE_CONFIG_CREATED_KEY, so this aborts
    /// EPriceConfigExists there; it only runs on the UPGRADE path (where init did
    /// not run), and its own marker check makes a second call abort. resolve_grad_threshold
    /// does NO identity check on the &PriceConfig it receives; this uniqueness is
    /// what makes that safe, so the marker must NEVER be relaxed on either path.
    public fun create_price_config(admin: &mut AdminCap, ctx: &mut TxContext) {
        assert!(!df::exists(&admin.id, PRICE_CONFIG_CREATED_KEY), EPriceConfigExists);
        df::add(&mut admin.id, PRICE_CONFIG_CREATED_KEY, true);
        let relayer_cap = PriceRelayerCap { id: object::new(ctx) };
        event::emit(PriceRelayerCapIssued { cap_id: object::id(&relayer_cap) });
        transfer::public_transfer(relayer_cap, tx_context::sender(ctx));
        transfer::share_object(PriceConfig {
            id:               object::new(ctx),
            sui_price_scaled: 0,
            updated_at_ms:    0,
        });
    }

    /// Read accessors for the frontend / relayer.
    public fun price_scaled(cfg: &PriceConfig): u64 { cfg.sui_price_scaled }
    public fun price_updated_at_ms(cfg: &PriceConfig): u64 { cfg.updated_at_ms }

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
        // ---------- V10 fields ----------
        // The cap that currently controls this curve. Set at creation to the
        // launch cap; swapped by a successful community takeover. EVERY
        // CreatorCap-gated function asserts the presented cap's id == this.
        active_creator_cap_id:  ID,
        // Last creator activity (ms). Stamped by every creator-gated action and
        // by creator_heartbeat. The 5-day CTO inactivity clock reads this.
        last_creator_activity_ms: u64,
        // Set to (now + 3 days) when a takeover FAILS; blocks re-proposal until then.
        cto_cooldown_until_ms:  u64,
        // Fee-funded buyback config. buyback_bps is carved out of the CREATOR
        // fee slice on every trade (total fee stays 1%). 0 = disabled.
        buyback_bps:            u64,
        // true = burn bought tokens; false = return them to the creator.
        buyback_burn:           bool,
        // Accrued SUI carved from creator fees, awaiting execute_buyback.
        buyback_fees:           Balance<SUI>,
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

    // V13: emitted once per curve when the graduation reserve + LP are claimed.
    public struct GraduationFundsClaimed has copy, drop {
        curve_id:   ID,
        sui_amount: u64,
        lp_amount:  u64,
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
        // V10: 0x0 (the zero address treated as "no parent") for a top-level
        // comment; otherwise the tx-digest-derived id of the parent comment.
        // The indexer reconstructs the reply tree from (id, parent_id) pairs.
        parent_id: address,
    }

    /// V12: creator toggled the holder gate for this curve's comments.
    public struct CommentGateSet has copy, drop {
        curve_id:     ID,
        holder_gated: bool,
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

    // ---------- V10: active-creator-cap gate ----------
    /// Asserts the presented cap is THE active creator cap for this curve (not
    /// merely a cap that points at this curve — that is the v9 check, which a
    /// taken-over creator's stale cap would still pass). Also stamps creator
    /// activity, resetting the 5-day CTO inactivity clock. Call at the top of
    /// every CreatorCap-gated mutation.
    fun assert_active_creator<T>(cap: &CreatorCap, curve: &mut Curve<T>, clock: &Clock) {
        assert!(cap.curve_id == object::id(curve),               ECapMismatch);
        assert!(object::id(cap) == curve.active_creator_cap_id,  ENotActiveCreator);
        curve.last_creator_activity_ms = clock::timestamp_ms(clock);
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
    /// threshold = BASE_GRAD_MIST * sqrt(1000) / sqrt(price_scaled)
    /// F-4 FIX (V13): den previously computed isqrt(price_scaled * precision / 1_000)
    /// while num was isqrt(1_000 * precision) - ASYMMETRIC. den divided by 1,000
    /// where num multiplied, a sqrt(1000)=31.6x error in the SAME direction at
    /// every price. The threshold ran 31.6x HIGH, always exceeding the curve's
    /// 12,803 SUI ceiling, so Path B never fired and the dampener never ran in
    /// production. The doc above already had the CORRECT den (33,015 at 1090).
    /// OVERFLOW: BASE(9e12) * num(31,622) = 2.85e17 < u64::MAX. price(<=1e5)*1e6 = 1e11. ok.
    fun dampened_grad_threshold(price_scaled: u64): u64 {
        if (price_scaled == 0) return BASE_GRAD_MIST;
        let precision: u64 = 1_000_000;
        let num = isqrt(1_000u64 * precision);
        let den = isqrt(price_scaled * precision);
        if (den == 0) return BASE_GRAD_MIST;
        BASE_GRAD_MIST * num / den
    }

    /// Resolve this buy's graduation threshold from the protocol-published price.
    ///   1. price published AND fresh   -> dampened threshold
    ///   2. never published (0)         -> BASE_GRAD_MIST
    ///   3. stale (> PRICE_MAX_AGE_MS)   -> BASE_GRAD_MIST
    /// NEVER ABORTS: a dead relayer degrades the dampener, it must not halt
    /// trading. Falling back to BASE_GRAD_MIST (9,000 SUI at $1) is a real,
    /// reachable threshold, not a lockout. Bounds are enforced in set_sui_price,
    /// so cfg.sui_price_scaled is always in [MIN,MAX]_PRICE_SCALED or exactly 0.
    /// The threshold is recomputed from live state every buy - nothing is stored
    /// for reuse, so there is no persisted threshold to poison (F-8).
    fun resolve_grad_threshold(cfg: &PriceConfig, clock: &Clock): u64 {
        if (cfg.sui_price_scaled == 0) return BASE_GRAD_MIST;
        let now_ms = clock::timestamp_ms(clock);
        if (now_ms > cfg.updated_at_ms + PRICE_MAX_AGE_MS) return BASE_GRAD_MIST;
        dampened_grad_threshold(cfg.sui_price_scaled)
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
            let addr = *vector::borrow(&addresses, i);
            let bps  = *vector::borrow(&bps_values, i);
            // Duplicate address check: scan previous entries
            let mut j = 0;
            while (j < i) {
                assert!(vector::borrow(&payouts, j).recipient != addr, EBadPayouts);
                j = j + 1;
            };
            total_bps = total_bps + bps;
            vector::push_back(&mut payouts, Payout { recipient: addr, bps });
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
        // F-1 (CRITICAL, V13). template::init hands the TreasuryCap to the
        // PUBLISHER, so between the coin-publish tx and this call the creator
        // holds an unrestricted mint. Without this assert they mint an unbacked
        // pile, let honest buyers fund sui_reserve, then dump into the curve.
        // NOT the accepted dev-buy (real SUI through the curve); this is free.
        assert!(coin::total_supply(&treasury) == 0, EPreMintedSupply);
        let token_supply = coin::mint(&mut treasury, CURVE_SUPPLY, ctx);

        // Launch fee → protocol_fees
        let launch_balance = coin::into_balance(payment);
        let mut protocol_fees = balance::zero<SUI>();
        balance::join(&mut protocol_fees, launch_balance);

        // Description carries social links via || delimiter (unchanged from v7+)
        let _ = description; // stored implicitly in CoinMetadata

        // V10: create the curve UID and the creator cap UID up front so we can
        // record the cap's id ON the curve at construction (active_creator_cap_id).
        let curve_uid = object::new(ctx);
        let curve_id  = object::uid_to_inner(&curve_uid);
        let cap_uid   = object::new(ctx);
        let cap_id    = object::uid_to_inner(&cap_uid);

        let curve = Curve<T> {
            id:                    curve_uid,
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
            // V10:
            active_creator_cap_id:  cap_id,
            last_creator_activity_ms: clock::timestamp_ms(clock),
            cto_cooldown_until_ms:  0,
            buyback_bps:            0,
            buyback_burn:           false,
            buyback_fees:           balance::zero<SUI>(),
        };

        event::emit(LaunchFeeCollected {
            curve_id,
            amount:   LAUNCH_FEE_MIST,
        });

        event::emit(CurveCreated {
            curve_id,
            creator:           sender,
            name:              curve.name,
            symbol:            curve.symbol,
            graduation_target: curve.graduation_target,
            anti_bot_delay:    curve.anti_bot_delay,
        });

        let cap = CreatorCap {
            id:       cap_uid,
            curve_id,
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
        price_cfg:        &PriceConfig,  // V13: replaces sui_price_scaled: u64 (F-2)
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

        // V13: threshold from the protocol-published price. Recomputed from live
        // state every buy. current_grad_threshold is now a DISPLAY CACHE ONLY;
        // it is never read back for the graduation decision, so no poison (F-8).
        let grad_threshold = resolve_grad_threshold(price_cfg, clock);
        curve.current_grad_threshold = grad_threshold;

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

        let (creator_fee_full, protocol_fee, airdrop_fee, lp_fee, referral_fee) =
            split_fee_v7(fee_amount, has_referral);

        // ── V10: carve buyback out of the creator slice (total fee unchanged) ─
        // buyback_amount is taken FROM creator_fee, so:
        //   buyback_amount + creator_fee == creator_fee_full
        // and the global conservation identity is preserved:
        //   creator_fee_full + protocol + airdrop + lp + referral == fee_amount
        let buyback_amount = (creator_fee_full * curve.buyback_bps) / BPS_DENOMINATOR;
        let creator_fee    = creator_fee_full - buyback_amount;

        // ── Apply fees ───────────────────────────────────────────────────────
        let creator_coin  = coin::split(&mut payment, creator_fee,  ctx);
        let protocol_coin = coin::split(&mut payment, protocol_fee, ctx);
        let airdrop_coin  = coin::split(&mut payment, airdrop_fee,  ctx);
        balance::join(&mut curve.creator_fees,  coin::into_balance(creator_coin));
        balance::join(&mut curve.protocol_fees, coin::into_balance(protocol_coin));
        balance::join(&mut curve.airdrop_fees,  coin::into_balance(airdrop_coin));

        // V10: route the carved buyback SUI into the curve's buyback bucket,
        // to be spent later by execute_buyback (NOT a recursive curve-buy here,
        // which would re-enter the AMM mid-trade and corrupt this trade's price).
        if (buyback_amount > 0) {
            let buyback_coin = coin::split(&mut payment, buyback_amount, ctx);
            balance::join(&mut curve.buyback_fees, coin::into_balance(buyback_coin));
        };

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
        // F-5 FIX (V13). The comment here was a FALSE PROOF: it claimed
        // swap_amount == actual_swap + lp_fee. It does not - fee_amount INCLUDES
        // lp_fee and swap_amount = effective_sui_in - fee_amount, so lp_fee is
        // subtracted out. No coin::split(lp_fee) exists here, so the leftover
        // lp_fee + tail_refund was REFUNDED to the buyer while lp_fees_accumulated
        // was incremented - a phantom counter and an underfunded DEX seed. sell()
        // got this right, which is why only buy leaked. With + lp_fee the leftover
        // is exactly tail_refund again.
        let to_reserve   = swap_amount + lp_fee;
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
        let (creator_fee_full, protocol_fee, airdrop_fee, lp_fee, referral_fee) =
            split_fee_v7(fee_amount, has_referral);
        // V10: carve buyback from the creator slice (seller payout unaffected).
        let buyback_amount = (creator_fee_full * curve.buyback_bps) / BPS_DENOMINATOR;
        let creator_fee    = creator_fee_full - buyback_amount;
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
        // V10: accrue carved buyback SUI into the buyback bucket.
        if (buyback_amount > 0) {
            let buyback_coin = coin::split(&mut pot, buyback_amount, ctx);
            balance::join(&mut curve.buyback_fees, coin::into_balance(buyback_coin));
        };

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
        let _ = metadata; // used by off-chain PTB for DEX pool; no on-chain mutation needed
        graduate_impl(curve, ctx);
    }

    // Single implementation of the standalone-graduation gate (F-10: graduate()
    // and graduate_for_testing previously carried two hand-synced copies of
    // these asserts; a test-only fork of gating logic is exactly the shadow
    // pattern that hid F-4/F-5, so both now delegate here).
    fun graduate_impl<T>(
        curve: &mut Curve<T>,
        ctx:   &mut TxContext,
    ) {
        assert!(!curve.graduated, EAlreadyGraduated);
        // F-2 (self-audit): production graduate() reads current_grad_threshold
        // directly and NEVER goes through resolve_grad_threshold, so the buy()-path
        // price clamp does NOT protect it. On a fresh curve current_grad_threshold
        // is 0, and without the `> 0` guard "sui_reserve >= 0" is always true, so a
        // permissionless graduate() would brick any brand-new curve for gas. Require
        // the threshold to have been established by a real oracle-priced buy first.
        // The token_reserve==0 drain branch stays.
        assert!(
            balance::value(&curve.token_reserve) == 0 ||
            (curve.current_grad_threshold > 0 &&
             balance::value(&curve.sui_reserve) >= curve.current_grad_threshold),
            ENotGraduated,
        );
        do_graduate_inline(curve, ctx);
    }

    // ---------- graduate_for_testing (test-only, no metadata param) ----------
    // Production graduate() requires a CoinMetadata<T> the Move test VM cannot
    // construct; this drops that parameter and delegates to the SAME
    // graduate_impl production runs. Zero duplicated gating logic (F-10).
    #[test_only]
    public fun graduate_for_testing<T>(
        curve: &mut Curve<T>,
        ctx:   &mut TxContext,
    ) {
        graduate_impl(curve, ctx);
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

    // ---------- Graduation exit path (V13; restored from V8) ----------
    // AdminCap-gated, one-shot. Callable only after the curve has graduated
    // (inline via buy() OR standalone graduate()). Mints the 200M LP allocation
    // and drains ALL remaining bonding-curve SUI, returning both to the caller
    // (the protocol relayer) to seed the DEX pool. The protocol owns the LP.
    //
    // Guard model (three independent barriers on the 200M mint):
    //   1. EXPLICIT one-shot: a dynamic-field marker (GRAD_CLAIMED_KEY) set BEFORE
    //      the mint. Self-contained — does NOT rely on any other function keeping
    //      sui_reserve empty. A second call aborts ELpAlreadyClaimed.
    //   2. MINT-SITE reserve floor (F-2): the mint cannot fire against a trivial
    //      reserve, so a manipulated-oracle "cheap graduation" (a fresh curve
    //      graduated on ~3 SUI) can never mint 200M against it. This bounds the
    //      OUTPUT and is immune to any dampened_grad_threshold / oracle bug.
    //   3. AdminCap gate (caller authority).
    public fun claim_graduation_funds<T>(
        _cap:  &AdminCap,
        curve: &mut Curve<T>,
        ctx:   &mut TxContext,
    ): (Coin<SUI>, Coin<T>) {
        assert!(curve.graduated, ENotGraduated);
        // Barrier 1: explicit one-shot marker, checked before any mint.
        assert!(!df::exists(&curve.id, GRAD_CLAIMED_KEY), ELpAlreadyClaimed);
        // Barrier 2 (F-2): refuse to mint the 200M LP against a trivial reserve.
        let sui_amount = balance::value(&curve.sui_reserve);
        assert!(sui_amount >= MIN_GRAD_RESERVE_MIST, EReserveTooLow);
        // Mark claimed BEFORE minting/draining so nothing can re-enter the mint.
        df::add(&mut curve.id, GRAD_CLAIMED_KEY, true);

        let sui_out = coin::from_balance(
            balance::withdraw_all(&mut curve.sui_reserve), ctx
        );

        // The only mint after launch. Raises max supply CURVE_SUPPLY (800M) ->
        // TOTAL_SUPPLY (1B). Mirrors V8: lp_supply = TOTAL_SUPPLY - CURVE_SUPPLY.
        let lp_supply = TOTAL_SUPPLY - CURVE_SUPPLY;
        let lp_out    = coin::from_balance(
            coin::mint_balance(&mut curve.treasury, lp_supply), ctx
        );

        event::emit(GraduationFundsClaimed {
            curve_id:   object::id(curve),
            sui_amount,
            lp_amount:  lp_supply,
        });

        (sui_out, lp_out)
    }

    // V13: relayer/frontend read to distinguish "graduated, claim done" from
    // "graduated, nothing claimed yet" — the state machine the auto-graduate
    // retry needs (claimed-but-no-pool vs nothing-to-claim).
    public fun grad_funds_claimed<T>(c: &Curve<T>): bool {
        df::exists(&c.id, GRAD_CLAIMED_KEY)
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
        assert_active_creator(cap, curve, clock);
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
        clock:     &Clock,
        _ctx:      &mut TxContext,
    ) {
        assert_active_creator(cap, curve, clock);
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
        clock: &Clock,
        ctx:   &mut TxContext,
    ) {
        assert_active_creator(cap, curve, clock);
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
    /// V12: the ACTIVE creator toggles whether commenting requires holding the
    /// token. Default (marker absent) = holder-gated, exactly the V10 behavior;
    /// setting holder_gated=false opens comments to everyone. Uses the same
    /// active-creator authorization as every other creator control (respects
    /// community takeovers).
    public fun set_comment_gate<T>(
        cap:          &CreatorCap,
        curve:        &mut Curve<T>,
        holder_gated: bool,
        clock:        &Clock,
        _ctx:         &mut TxContext,
    ) {
        assert_active_creator(cap, curve, clock);
        let currently_open = df::exists(&curve.id, COMMENTS_UNGATED_KEY);
        if (holder_gated) {
            assert!(currently_open, ECommentGateNoop);
            let _: bool = df::remove(&mut curve.id, COMMENTS_UNGATED_KEY);
        } else {
            assert!(!currently_open, ECommentGateNoop);
            df::add(&mut curve.id, COMMENTS_UNGATED_KEY, true);
        };
        event::emit(CommentGateSet { curve_id: object::id(curve), holder_gated });
    }

    /// V12: read the gate (true = commenting requires holding the token).
    public fun comments_holder_gated<T>(curve: &Curve<T>): bool {
        !df::exists(&curve.id, COMMENTS_UNGATED_KEY)
    }

    /// V13 (audit F-7): the Comment event's author is the transaction sender.
    /// The caller-supplied `author: address` parameter is GONE -- it let anyone
    /// emit comments attributed to an arbitrary address.
    public fun post_comment<T>(
        curve:       &mut Curve<T>,
        text:        String,
        payment:     Coin<SUI>,
        // V10: caller presents a reference to their own token balance to prove
        // they hold > 0 of this token (holder-gated chat). The coin is borrowed,
        // never consumed. 0x0 parent_id = top-level; else the parent comment id.
        holder_coin: &Coin<T>,
        parent_id:   address,
        ctx:         &mut TxContext,
    ) {
        assert!(coin::value(&payment) == COMMENT_FEE_MIST, EWrongCommentFee);
        // V12: holder gate is now creator-togglable. Marker absent (default) =
        // gated, preserving V10 behavior; creators can open comments to all.
        if (comments_holder_gated(curve)) {
            assert!(coin::value(holder_coin) > 0, EHolderOnly);
        };
        let len = std::string::length(&text);
        assert!(len > 0,               ECommentEmpty);
        assert!(len <= MAX_COMMENT_BYTES, ECommentTooLong);
        balance::join(&mut curve.protocol_fees, coin::into_balance(payment));
        event::emit(Comment {
            curve_id: object::id(curve),
            author: tx_context::sender(ctx),
            text,
            parent_id,
        });
    }

    /// V13 test hook: the tests module cannot read another module's struct
    /// fields, so expose the Comment event's author for event assertions.
    #[test_only]
    public fun comment_author(c: &Comment): address { c.author }

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
    // ---------- Restored read-only accessors (required by tests) ----------
    public fun graduated<T>(c: &Curve<T>): bool { c.graduated }
    public fun paused<T>(c: &Curve<T>): bool { c.paused }
    public fun graduation_target<T>(c: &Curve<T>): u8 { c.graduation_target }
    public fun anti_bot_delay<T>(c: &Curve<T>): u8 { c.anti_bot_delay }
    public fun metadata_updated<T>(c: &Curve<T>): bool { c.metadata_updated }
    public fun created_at_ms<T>(c: &Curve<T>): u64 { c.created_at_ms }
    public fun lp_fees_accumulated<T>(c: &Curve<T>): u64 { c.lp_fees_accumulated }
    public fun current_grad_threshold<T>(c: &Curve<T>): u64 { c.current_grad_threshold }
    public fun creator<T>(c: &Curve<T>): address { c.creator }
    public fun pool_id<T>(c: &Curve<T>): Option<ID> { c.pool_id }
    public fun creator_lp_nft_id<T>(c: &Curve<T>): Option<ID> { c.creator_lp_nft_id }

    // ---------- VestingLock accessors (required by tests) ----------
    public fun lock_total<T>(l: &VestingLock<T>): u64 { l.total_amount }
    public fun lock_claimed<T>(l: &VestingLock<T>): u64 { l.claimed }
    public fun lock_remaining<T>(l: &VestingLock<T>): u64 { balance::value(&l.locked) }
    public fun lock_beneficiary<T>(l: &VestingLock<T>): address { l.beneficiary }
    #[test_only]
    public fun lock_vested_at<T>(l: &VestingLock<T>, now_ms: u64): u64 {
        vested_amount(l.total_amount, l.start_ms, l.duration_ms, l.mode, now_ms)
    }

    // ---------- Test-only init ----------
    #[test_only]
    public fun init_for_testing(ctx: &mut TxContext) {
        init(BONDING_CURVE {}, ctx);
    }

    /// PREPUBLISH-2 test hook: mint a BARE AdminCap with NO PRICE_CONFIG_CREATED_KEY
    /// marker, to simulate the V13 UPGRADE path where the AdminCap predates V13 (it
    /// was minted by the V10 init, which had no marker) and init() therefore never
    /// ran. On this cap create_price_config succeeds once and a second call aborts.
    /// Fresh-publish init() marks the cap it mints, so it must never be used there.
    #[test_only]
    public fun new_admin_cap_for_testing(ctx: &mut TxContext): AdminCap {
        AdminCap { id: object::new(ctx) }
    }
    // =====================================================================
    // V10 ADDITIONS
    // =====================================================================

    // ---------- V10 events ----------
    public struct BuybackConfigured has copy, drop {
        curve_id: ID, buyback_bps: u64, burn: bool,
    }
    public struct BuybackExecuted has copy, drop {
        curve_id: ID, sui_spent: u64, tokens_bought: u64, burned: bool,
    }
    public struct CreatorHeartbeat has copy, drop {
        curve_id: ID, at_ms: u64,
    }
    public struct ProtocolSurchargeCollected has copy, drop {
        curve_id: ID, amount: u64,
    }
    // V13: escrow-weighted CTO events. Weight is the Coin<T> locked in escrow,
    // so a vote cannot be double-counted by shuffling coins between wallets.
    public struct TakeoverProposed has copy, drop {
        curve_id: ID, proposal_id: ID, proposer: address, deadline_ms: u64,
    }
    public struct TakeoverVoted has copy, drop {
        proposal_id: ID, voter: address, amount: u64, total_weight: u64,
    }
    public struct TakeoverUnvoted has copy, drop {
        proposal_id: ID, voter: address, amount: u64,
    }
    public struct TakeoverResolved has copy, drop {
        proposal_id: ID, curve_id: ID, succeeded: bool, total_weight: u64,
    }
    public struct VoteReclaimed has copy, drop {
        proposal_id: ID, voter: address, amount: u64,
    }

    // ---------- V10: buyback configuration (active-creator-gated) ----------
    /// Creator sets the fraction of THEIR fee slice routed to buyback, and
    /// whether bought tokens are burned (true) or returned to the creator
    /// (false). buyback_bps is in basis points of the creator slice (0..=10000).
    public fun set_buyback_config<T>(
        cap:         &CreatorCap,
        curve:       &mut Curve<T>,
        buyback_bps: u64,
        burn:        bool,
        clock:       &Clock,
        _ctx:        &mut TxContext,
    ) {
        assert_active_creator(cap, curve, clock);
        assert!(buyback_bps <= BPS_DENOMINATOR, EBuybackBpsTooHigh);
        curve.buyback_bps  = buyback_bps;
        curve.buyback_burn = burn;
        event::emit(BuybackConfigured {
            curve_id: object::id(curve), buyback_bps, burn,
        });
    }

    /// Execute the accrued buyback: spend the whole buyback_fees bucket to buy
    /// curve tokens at the current price, then burn them (buyback_burn==true)
    /// or transfer them to the creator (false). Permissionless (anyone may
    /// trigger; the destination is fixed by config, so there is no abuse vector).
    /// Done as a SEPARATE call — never inside buy()/sell() — so the AMM is never
    /// re-entered mid-trade. Uses the same constant-product math as buy().
    public fun execute_buyback<T>(
        curve: &mut Curve<T>,
        ctx:   &mut TxContext,
    ) {
        assert!(!curve.graduated, EAlreadyGraduated);
        let spend = balance::value(&curve.buyback_fees);
        assert!(spend > 0, ENoBuyback);

        // Quote tokens out for the full buyback SUI at current effective reserves.
        let x = effective_sui_reserve(curve);
        let y = effective_token_reserve(curve);
        let remaining = balance::value(&curve.token_reserve);
        let naive_out = quote_out(spend, x, y);
        let tokens_out = if (naive_out > remaining) { remaining } else { naive_out };
        assert!(tokens_out > 0, ENoBuyback);

        // Move the buyback SUI into the curve's real SUI reserve (it bought tokens).
        let buyback_bal = balance::split(&mut curve.buyback_fees, spend);
        balance::join(&mut curve.sui_reserve, buyback_bal);

        // Take the bought tokens out of the curve reserve.
        let bought = balance::split(&mut curve.token_reserve, tokens_out);

        if (curve.buyback_burn) {
            // Real burn via the curve's TreasuryCap.
            let burn_coin = coin::from_balance(bought, ctx);
            coin::burn(&mut curve.treasury, burn_coin);
        } else {
            let ret_coin = coin::from_balance(bought, ctx);
            transfer::public_transfer(ret_coin, curve.creator);
        };

        event::emit(BuybackExecuted {
            curve_id:      object::id(curve),
            sui_spent:     spend,
            tokens_bought: tokens_out,
            burned:        curve.buyback_burn,
        });
    }

    // ---------- V10: creator heartbeat (resets the 5-day CTO clock) ----------
    public fun creator_heartbeat<T>(
        cap:   &CreatorCap,
        curve: &mut Curve<T>,
        clock: &Clock,
        _ctx:  &mut TxContext,
    ) {
        assert_active_creator(cap, curve, clock);
        event::emit(CreatorHeartbeat {
            curve_id: object::id(curve),
            at_ms:    clock::timestamp_ms(clock),
        });
    }

    // ---------- V10: launch-with-site protocol surcharge ----------
    /// Deposit an arbitrary protocol surcharge into the curve's protocol_fees
    /// treasury (the SAME Balance the base launch fee and trade protocol fees
    /// accrue to). public (not entry) so it composes inside the launch PTB via
    /// moveCall, while the curve is still held by value before share_curve.
    /// No amount assertion: the launch PTB sets the amount.
    public fun collect_protocol_surcharge<T>(
        curve:   &mut Curve<T>,
        payment: Coin<SUI>,
    ) {
        let amount = coin::value(&payment);
        balance::join(&mut curve.protocol_fees, coin::into_balance(payment));
        event::emit(ProtocolSurchargeCollected { curve_id: object::id(curve), amount });
    }

    // =====================================================================
    // V13: COMMUNITY TAKEOVER (escrow-weighted, shared proposal)
    // =====================================================================

    /// Escrow-weighted takeover. After the creator has been inactive >= 5 days a
    /// >=1% holder opens a proposal by ESCROWING their stake as the first vote;
    /// holders then add weight by locking their own Coin<T> into the same escrow
    /// for a 12h window. Voting weight is the coin PHYSICALLY LOCKED in the
    /// proposal, so the same coin cannot be moved to a second wallet and voted
    /// twice (fixes F-3). The proposal is a SHARED object so it is reachable by
    /// every later transaction (fixes F-AC-1). Passes iff total escrowed weight
    /// reaches 25% of circulating supply. On success the curve's
    /// active_creator_cap_id is swapped to a fresh cap minted to the proposer,
    /// invalidating the old creator's cap across every gated function. Escrow is
    /// never consumed at resolve: it persists so every voter can reclaim their
    /// exact stake via the permissionless reclaim_vote.
    public struct TakeoverProposal<phantom T> has key {
        id:           UID,
        curve_id:     ID,
        proposer:     address,
        // PASS-C-1: the proposer's nominate bond, recorded at propose time. While
        // the proposal is live it blocks every competing proposal (the one-live
        // marker), so the proposer must NOT be able to reclaim this bond via
        // unvote_takeover mid-window - otherwise propose+immediate-unvote perpetually
        // denies the community-takeover recovery at gas-only cost. The proposer may
        // unvote only weight staked ABOVE this bond; the bond itself is reclaimable
        // only after resolve, via the permissionless reclaim_vote (never forfeit).
        proposer_bond: u64,
        opened_at_ms: u64,
        deadline_ms:  u64,
        escrow:       Balance<T>,
        votes:        Table<address, u64>,
        total_weight: u64,
        // F-4.0 / F-6.0: quorum target SNAPSHOT at propose time = circulating * 25%.
        // Frozen here so trading during/after the window cannot move the goalposts
        // (live circulating_supply at resolve was atomically manipulable via an
        // in-PTB buy->resolve->sell). A snapshot of 0 (tiny circ that rounds the
        // 25% down to 0) is treated as an automatic FAIL in resolve_takeover.
        quorum_target: u64,
        resolved:     bool,
        succeeded:    bool,
    }

    /// Circulating supply for CTO math = tokens NOT held by the curve itself.
    /// (CURVE_SUPPLY minus the curve's unsold token_reserve = tokens in holders'
    /// wallets.) Coins locked in escrow already left token_reserve at buy time,
    /// so escrowing does not change circulating supply. Vesting locks are
    /// likewise excluded because locked tokens already left token_reserve.
    fun circulating_supply<T>(curve: &Curve<T>): u64 {
        CURVE_SUPPLY - balance::value(&curve.token_reserve)
    }

    /// Open a takeover. The proposer's nominate stake is ESCROWED as the first
    /// vote - a locked coin cannot be moved to a second wallet to vote twice
    /// (fixes F-3). The proposal is shared so later transactions can vote/resolve.
    public fun propose_takeover<T>(
        curve: &mut Curve<T>,
        stake: Coin<T>,
        clock: &Clock,
        ctx:   &mut TxContext,
    ) {
        let now = clock::timestamp_ms(clock);
        assert!(now - curve.last_creator_activity_ms >= CTO_INACTIVITY_MS, ECreatorStillActive);
        assert!(now >= curve.cto_cooldown_until_ms, ECtoOnCooldown);
        assert!(!df::exists(&curve.id, CTO_LIVE_PROPOSAL_KEY), ECtoProposalLive);

        // F-4.0: a curve with 0 circulating supply has no community to represent,
        // and the nominate threshold would degenerate to 0 (letting a coin::zero
        // stake open a proposal with total_weight 0). Reject both the zero-circ
        // curve and any zero-value stake outright.
        let circ = circulating_supply(curve);
        assert!(circ > 0, ECtoZeroCirculating);
        let threshold = (circ * CTO_NOMINATE_BPS) / BPS_DENOMINATOR;
        let amount = coin::value(&stake);
        assert!(amount > 0, ECtoZeroCirculating);
        assert!(amount >= threshold, EBelowNominateThreshold);

        // F-6.0: snapshot the 25%-of-circulating quorum target NOW so post-open
        // trading cannot move it (resolve compares total_weight against this).
        let quorum_target = (circ * CTO_QUORUM_BPS) / BPS_DENOMINATOR;

        let sender = tx_context::sender(ctx);
        let mut votes = table::new<address, u64>(ctx);
        table::add(&mut votes, sender, amount);
        let proposal = TakeoverProposal<T> {
            id:           object::new(ctx),
            curve_id:     object::id(curve),
            proposer:     sender,
            // PASS-C-1: lock the proposer's nominate bond for the life of the proposal.
            proposer_bond: amount,
            opened_at_ms: now,
            deadline_ms:  now + CTO_WINDOW_MS,
            escrow:       coin::into_balance(stake),
            votes,
            total_weight: amount,
            quorum_target,
            resolved:     false,
            succeeded:    false,
        };
        let pid = object::id(&proposal);
        df::add(&mut curve.id, CTO_LIVE_PROPOSAL_KEY, pid);
        event::emit(TakeoverProposed {
            curve_id:    object::id(curve),
            proposal_id: pid,
            proposer:    sender,
            deadline_ms: proposal.deadline_ms,
        });
        transfer::share_object(proposal);
    }

    /// Add weight by LOCKING coins into escrow; voting weight is the coin locked
    /// into escrow, support-only against quorum.
    public fun vote_takeover<T>(
        proposal: &mut TakeoverProposal<T>,
        coins:    Coin<T>,
        clock:    &Clock,
        ctx:      &mut TxContext,
    ) {
        assert!(!proposal.resolved, ECtoAlreadyResolved);
        let now = clock::timestamp_ms(clock);
        assert!(now < proposal.deadline_ms, ECtoVoteClosed);
        let amount = coin::value(&coins);
        let min = (CURVE_SUPPLY * CTO_MIN_VOTE_BPS) / BPS_DENOMINATOR;
        assert!(amount >= min, ECtoBelowMinVote);

        balance::join(&mut proposal.escrow, coin::into_balance(coins));
        let who = tx_context::sender(ctx);
        if (table::contains(&proposal.votes, who)) {
            let cur = *table::borrow(&proposal.votes, who);
            *table::borrow_mut(&mut proposal.votes, who) = cur + amount;
        } else {
            table::add(&mut proposal.votes, who, amount);
        };
        proposal.total_weight = proposal.total_weight + amount;
        event::emit(TakeoverVoted {
            proposal_id:  object::id(proposal),
            voter:        who,
            amount,
            total_weight: proposal.total_weight,
        });
    }

    /// Withdraw a vote BEFORE the deadline: escrow returned and total_weight
    /// decremented so a withdrawn vote cannot count. The clock is required so a
    /// vote cannot be pulled after the deadline (which could flip a decided tally).
    ///
    /// PASS-C-1: a NON-proposer voter withdraws their full stake (unchanged). The
    /// PROPOSER may withdraw only the weight they staked ABOVE their nominate bond;
    /// the bond stays locked until resolve (reclaimable then via reclaim_vote). A
    /// proposer holding exactly the bond therefore CANNOT unvote while live, which
    /// removes the propose+immediate-unvote perpetual-denial grief: keeping the
    /// one-live-proposal marker set now costs the bond locked for the whole window.
    /// Escrow conservation is preserved exactly: escrow == sum(votes) on every path
    /// (this only reduces the amount split out and the amount decremented in lockstep).
    public fun unvote_takeover<T>(
        proposal: &mut TakeoverProposal<T>,
        clock:    &Clock,
        ctx:      &mut TxContext,
    ) {
        assert!(!proposal.resolved, ECtoAlreadyResolved);
        let now = clock::timestamp_ms(clock);
        assert!(now < proposal.deadline_ms, ECtoVoteClosed);
        let who = tx_context::sender(ctx);
        assert!(table::contains(&proposal.votes, who), ECtoNotVoter);
        let withdraw = if (who == proposal.proposer) {
            // Proposer keeps proposer_bond locked; only the excess above it exits.
            // cur >= proposer_bond always (the entry starts at the bond and unvote
            // never sets it below the bond), so the subtraction cannot underflow.
            let cur = *table::borrow(&proposal.votes, who);
            let excess = cur - proposal.proposer_bond;
            assert!(excess > 0, ECtoProposerBondLocked);
            *table::borrow_mut(&mut proposal.votes, who) = proposal.proposer_bond;
            excess
        } else {
            table::remove(&mut proposal.votes, who)
        };
        proposal.total_weight = proposal.total_weight - withdraw;
        let bal = balance::split(&mut proposal.escrow, withdraw);
        transfer::public_transfer(coin::from_balance(bal, ctx), who);
        event::emit(TakeoverUnvoted {
            proposal_id: object::id(proposal),
            voter:       who,
            amount:      withdraw,
        });
    }

    /// Resolve after the window closes. Permissionless. The shared proposal
    /// PERSISTS (it is not consumed) so escrow is never stranded: anyone can
    /// resolve, then reclaim for every voter. total_weight freezes at resolve.
    /// On success, mint a fresh CreatorCap to the proposer and swap
    /// active_creator_cap_id; on failure, start the 3-day cooldown.
    public fun resolve_takeover<T>(
        proposal: &mut TakeoverProposal<T>,
        curve:    &mut Curve<T>,
        clock:    &Clock,
        ctx:      &mut TxContext,
    ) {
        assert!(proposal.curve_id == object::id(curve), ECtoWrongCurve);
        let now = clock::timestamp_ms(clock);
        assert!(now >= proposal.deadline_ms, ECtoVoteStillOpen);
        assert!(!proposal.resolved, ECtoAlreadyResolved);

        // F-6.0: use the quorum SNAPSHOT taken at propose time, not the live
        // circulating supply (which is atomically manipulable inside the resolve
        // PTB via buy->resolve->sell). F-4.0: a snapshot of 0 (degenerate/near-zero
        // circulating) is an automatic FAIL, and a zero tally never succeeds.
        let quorum = proposal.quorum_target;
        let succeeded = quorum > 0 && proposal.total_weight > 0 && proposal.total_weight >= quorum;
        proposal.resolved = true;
        proposal.succeeded = succeeded;

        let _: ID = df::remove(&mut curve.id, CTO_LIVE_PROPOSAL_KEY);

        if (succeeded) {
            let new_cap = CreatorCap {
                id:       object::new(ctx),
                curve_id: object::id(curve),
            };
            curve.active_creator_cap_id    = object::id(&new_cap);
            curve.creator                  = proposal.proposer;
            curve.last_creator_activity_ms = now;
            transfer::public_transfer(new_cap, proposal.proposer);
        } else {
            curve.cto_cooldown_until_ms = now + CTO_COOLDOWN_MS;
        };
        event::emit(TakeoverResolved {
            proposal_id:  object::id(proposal),
            curve_id:     object::id(curve),
            succeeded,
            total_weight: proposal.total_weight,
        });
    }

    /// Reclaim a voter's escrow after resolution (expire_refund pattern): callable
    /// by ANYONE, funds ALWAYS go to the voter, never the caller. Because resolve
    /// is permissionless the escrow is always drainable. total_weight is the
    /// frozen record and is intentionally NOT changed here.
    public fun reclaim_vote<T>(
        proposal: &mut TakeoverProposal<T>,
        voter:    address,
        ctx:      &mut TxContext,
    ) {
        assert!(proposal.resolved, ECtoNotResolved);
        assert!(table::contains(&proposal.votes, voter), ECtoNotVoter);
        let amt = table::remove(&mut proposal.votes, voter);
        let bal = balance::split(&mut proposal.escrow, amt);
        transfer::public_transfer(coin::from_balance(bal, ctx), voter);
        event::emit(VoteReclaimed {
            proposal_id: object::id(proposal),
            voter,
            amount:      amt,
        });
    }

    // ---------- V10/V13 accessors ----------
    public fun active_creator_cap_id<T>(c: &Curve<T>): ID { c.active_creator_cap_id }
    public fun last_creator_activity_ms<T>(c: &Curve<T>): u64 { c.last_creator_activity_ms }
    public fun cto_cooldown_until_ms<T>(c: &Curve<T>): u64 { c.cto_cooldown_until_ms }
    public fun buyback_bps<T>(c: &Curve<T>): u64 { c.buyback_bps }
    public fun buyback_burn<T>(c: &Curve<T>): bool { c.buyback_burn }
    public fun buyback_fees_pending<T>(c: &Curve<T>): u64 { balance::value(&c.buyback_fees) }
    public fun cto_circulating_supply<T>(c: &Curve<T>): u64 { circulating_supply(c) }

    // ---------- V13: TakeoverProposal accessors (tests + frontend) ----------
    public fun proposal_curve_id<T>(p: &TakeoverProposal<T>): ID { p.curve_id }
    public fun proposal_proposer<T>(p: &TakeoverProposal<T>): address { p.proposer }
    public fun proposal_deadline_ms<T>(p: &TakeoverProposal<T>): u64 { p.deadline_ms }
    public fun proposal_total_weight<T>(p: &TakeoverProposal<T>): u64 { p.total_weight }
    public fun proposal_quorum_target<T>(p: &TakeoverProposal<T>): u64 { p.quorum_target }
    public fun proposal_resolved<T>(p: &TakeoverProposal<T>): bool { p.resolved }
    public fun proposal_succeeded<T>(p: &TakeoverProposal<T>): bool { p.succeeded }
    public fun proposal_escrow_value<T>(p: &TakeoverProposal<T>): u64 { balance::value(&p.escrow) }
    public fun proposal_voter_weight<T>(p: &TakeoverProposal<T>, addr: address): u64 {
        if (table::contains(&p.votes, addr)) { *table::borrow(&p.votes, addr) } else { 0 }
    }
    public fun proposal_has_voter<T>(p: &TakeoverProposal<T>, addr: address): bool {
        table::contains(&p.votes, addr)
    }

    // ---------- Test-only: set STORED grad threshold ----------
    // F-10: this may ONLY feed the standalone graduate()/graduate_for_testing
    // gate, which reads the STORED current_grad_threshold. It must never feed
    // a buy path: buy_for_testing delegates to buy(), which recomputes the
    // threshold from the shared PriceConfig on every call and OVERWRITES this
    // field. Kept solely so tests can stage the graduate_impl gate (e.g. the
    // trivial-reserve claim backstop) without a curve-sized buy.
    #[test_only]
    public fun set_grad_threshold_for_testing<T>(
        curve:     &mut Curve<T>,
        threshold: u64,
    ) {
        curve.current_grad_threshold = threshold;
    }

    // ---------- Test-only: buy wrapper ----------
    // F-10 FIX (V13): buy_for_testing was a PARALLEL IMPLEMENTATION of buy().
    // It read curve.current_grad_threshold directly (never
    // resolve_grad_threshold), lacked the F-5 `to_reserve = swap_amount +
    // lp_fee` reserve fix (it split only swap_amount while still incrementing
    // lp_fees_accumulated), and skipped the V10 buyback carve. ~50 tests
    // exercised that shadow instead of the real entrypoint, which is how the
    // F-4 31.6x threshold error and the PriceConfig init blocker survived
    // green runs. It is now a ZERO-LOGIC delegator: every economic decision
    // (threshold resolution via a real &PriceConfig, fee split, tail clips,
    // inline graduation) executes the production buy() path.
    #[test_only]
    public fun buy_for_testing<T>(
        curve:          &mut Curve<T>,
        payment:        Coin<SUI>,
        min_tokens_out: u64,
        referral:       Option<address>,
        price_cfg:      &PriceConfig,
        clock:          &Clock,
        ctx:            &mut TxContext,
    ): (Coin<T>, Coin<SUI>) {
        buy(curve, payment, min_tokens_out, referral, price_cfg, clock, ctx)
    }
}
