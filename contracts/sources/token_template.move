/// suipump::token_template
///
/// A one-time-witness template showing how a creator publishes a new coin
/// and hands it straight into a `bonding_curve::Curve`. Each new launch on
/// the platform is its own published module with a unique OTW — this is a
/// hard constraint of Sui's Coin standard and ensures each token type is
/// globally unique.
///
/// In production, the frontend generates this module from a template,
/// substitutes the OTW name + metadata, and publishes it as a fresh package
/// via a programmable transaction block.
module suipump::token_template {
    use sui::coin::{Self};
    use sui::url;
    use std::ascii;
    use std::string;

    use suipump::bonding_curve;

    /// One-time witness. In a generated module this would be renamed to
    /// match the token symbol (e.g. `MOON`, `PEPE`, etc).
    public struct TOKEN_TEMPLATE has drop {}

    /// Example metadata — in a real template these are string-substituted
    /// by the frontend at package-publish time.
    const NAME: vector<u8> = b"Example Token";
    const SYMBOL: vector<u8> = b"EXMPL";
    const DESCRIPTION: vector<u8> = b"An example bonded token";
    const ICON_URL: vector<u8> = b"https://example.com/icon.png";
    const DECIMALS: u8 = 6;

    fun init(witness: TOKEN_TEMPLATE, ctx: &mut TxContext) {
        let (treasury, metadata) = coin::create_currency(
            witness,
            DECIMALS,
            SYMBOL,
            NAME,
            DESCRIPTION,
            option::some(url::new_unsafe_from_bytes(ICON_URL)),
            ctx,
        );

        // Freeze metadata so the curve's display info is immutable.
        transfer::public_freeze_object(metadata);

        // Hand the TreasuryCap directly to a new shared Curve. The creator
        // is the sender of this publish tx.
        bonding_curve::create<TOKEN_TEMPLATE>(
            treasury,
            string::utf8(NAME),
            ascii::string(SYMBOL),
            tx_context::sender(ctx),
            ctx,
        );
    }
}
