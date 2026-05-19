/// coin_template::template  (V8)
///
/// One change from V7: `init` calls `public_share_object(metadata)` instead of
/// `public_freeze_object(metadata)`.  A shared CoinMetadata can be passed as
/// `&mut CoinMetadata<T>` by the creator (via `update_metadata`) and by
/// `graduate()` (via `&mut CoinMetadata<T>`).  Frozen metadata — the V7 bug —
/// can never be passed mutably, making `update_metadata` irrecoverably broken
/// for every V7 token.  V8 fixes this permanently.
///
/// Everything else is identical to V7 template:
///   - `init` transfers TreasuryCap to publisher so the launch PTB can chain
///     `create_and_return` + optional dev-buy + `share_curve` in Tx 2.
///   - DECIMALS = 6 (hard-coded, not patchable).
///   - All four string constants (SYMBOL / NAME / DESCRIPTION / ICON_URL) are
///     BCS-patched by `@mysten/move-bytecode-template` at each launch.
module coin_template::template {
    use sui::coin;
    use sui::url;

    /// The one-time witness. Renamed to the real symbol at patch time.
    /// Must be uppercase of the module name (e.g. `MOON` for module `moon`).
    public struct TEMPLATE has drop {}

    // BCS-patched via update_constants() at launch time.
    // Placeholder lengths must be >= any real value (padding with spaces at
    // patch time).  Placeholders must be unique in the constant pool.
    const DECIMALS:    u8          = 6;
    const SYMBOL:      vector<u8>  = b"TMPL";
    const NAME:        vector<u8>  = b"Template Coin";
    const DESCRIPTION: vector<u8>  = b"Template description placeholder that is intentionally long to accommodate real token descriptions.";
    const ICON_URL:    vector<u8>  = b"https://suipump.test/icon-placeholder.png";

    fun init(witness: TEMPLATE, ctx: &mut TxContext) {
        let (treasury, metadata) = coin::create_currency(
            witness,
            DECIMALS,
            SYMBOL,
            NAME,
            DESCRIPTION,
            option::some(url::new_unsafe_from_bytes(ICON_URL)),
            ctx,
        );

        // V8 FIX: share metadata so it can be passed as &mut CoinMetadata<T>.
        // V7 called public_freeze_object here — a frozen object can never be
        // borrowed mutably, making update_metadata() and the new graduate()
        // signature both impossible.  Sharing is the correct pattern for
        // protocol-managed metadata.
        transfer::public_share_object(metadata);

        // Hand TreasuryCap to the publisher.  The launch PTB's next call
        // (create_and_return) consumes it into bonding_curve::create_and_return.
        transfer::public_transfer(treasury, tx_context::sender(ctx));
    }
}
