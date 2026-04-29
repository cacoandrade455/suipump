/// coin_template::template
///
/// Minimal coin module compiled once and shipped with the frontend. At each
/// launch, @mysten/move-bytecode-template replaces the identifier `TEMPLATE`
/// with the real OTW name (e.g. `MOON`) and rewrites the metadata constants
/// (name, symbol, description, icon URL) before publishing.
///
/// Design decisions:
///   - `init` does NOT call create_with_launch_fee directly. Instead it
///     transfers the TreasuryCap to the publisher. The launch PTB chains
///     in create_with_launch_fee as a separate Move call, consuming the cap
///     as a transaction result. This is the only way to get user-supplied
///     payouts + launch-fee payment into the curve creation.
///   - Metadata freeze happens here so no one can mutate it post-launch.
///   - DECIMALS is fixed at 6 by protocol convention (matches CURVE_SUPPLY
///     math in bonding_curve.move). We don't expose it as a patchable
///     constant to prevent launches with incompatible decimals.
module coin_template::template {
    use sui::coin;
    use sui::url;

    /// The one-time witness. Renamed to the real symbol at patch time.
    /// Must be the uppercase of the module name, so module identifier
    /// also gets patched to match (e.g. `MOON` for module `moon`).
    public struct TEMPLATE has drop {}

    // These constants are byte-patched via update_constants() at launch time.
    // The placeholder values must be distinct enough that we can find them in
    // the BCS-encoded constant table, and long enough that real values fit.
    const DECIMALS: u8 = 6;
    const SYMBOL: vector<u8> = b"TMPL";
    const NAME: vector<u8> = b"Template Coin";
    const DESCRIPTION: vector<u8> = b"Template description placeholder that is intentionally long to accommodate real token descriptions.";
    const ICON_URL: vector<u8> = b"https://suipump.test/icon-placeholder.png";

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

        // Freeze metadata — no one can modify the token's display info later.
        transfer::public_freeze_object(metadata);

        // Hand TreasuryCap to the publisher. The launch PTB's next call
        // consumes it into bonding_curve::create_with_launch_fee.
        transfer::public_transfer(treasury, tx_context::sender(ctx));
    }
}
