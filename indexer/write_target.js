// indexer/write_target.js
// Single env-driven WRITE target for the whole repo (V13 closeout, Task E).
//
// V13 was PUBLISHED 2026-07-17 as a FRESH PUBLISH (its own type identity, NOT an
// upgrade of V10). Nothing in the repo may hardcode a V13 package id or a
// PriceConfig object id - both arrive by ENV ONLY. Carlos arms the write path by
// setting these env vars on Render/Vercel with NO code change:
//
//   SUIPUMP_LATEST_WRITE_PACKAGE - the package id that V10-LINEAGE writes (moveCall)
//       target. Defaults to the V12 upgrade
//       0xf5a3566ba920a3e3614e8b25da0ca3237879b6e22eb12f21ccf2bceb6520b9cd. Set it
//       to the newest package of the ACTIVE lineage - after the V14 publish that is
//       V14 0xb6e7cef4d36b3cf0fd84888dd9930ce9abfcc0ed56f01384f1e02b55eeac1b03, the
//       COMPATIBLE additive upgrade of V13 (V13 stays the type identity of existing
//       curves; V14 never replaces it in read paths). NOTE: this remaps the
//       V10 lineage only (see PACKAGE_LATEST in bridge.js); V13-lineage curves are
//       remapped V13 -> V14 by the graduation scripts' own WRITE_PACKAGE maps
//       (env-gated, null-safe) so their writes run the latest V14 bytecode.
//       READ paths (ALL_PACKAGE_IDS iteration) are NOT affected by this module.
//   SUIPUMP_PRICE_CONFIG - the shared PriceConfig object id created by the V13
//       publish (price_cfg).
//   SUIPUMP_V13_PACKAGE - the V13 package id itself, for consumers that need it as
//       a version key (event types, dispatch-set entries, virtual-reserve branch).
//
// TWO SIGNER KEYS, NEVER CONFLATED (env contract; this module reads neither):
//   SUI_PRIVATE_KEY       - the PRICE RELAYER wallet
//       0xce53cb8f9befc490393d70528ef732bbcbe12d951ffcdd76a37af9b0f9624629 (holds
//       the PriceRelayerCap). Read by price_publisher.js and cto_reclaim_sweeper.js.
//   GRADUATION_SIGNER_KEY - the graduation signer. In GraduationCap mode (the V14
//       env triplet set, see below) this is the DEDICATED graduation wallet
//       0x7334d47632af5386d9b16326ade55be642fc8a569a1672b0cbaaf4d0e7e6180a, which
//       owns ONLY the GraduationCap - NOT the AdminCap key. In the pre-V14
//       AdminCap fallback (triplet unset) it is the MAIN wallet
//       0x0be9a8f56ba3b07f295e0c7526e7f47ca3a146649b9d864d2eb47bf3acd90c55 (holds
//       AdminCap V13). Read ONLY by the graduation-test/graduation-test-turbos
//       scripts that auto_graduate.js imports. auto_graduate MUST NEVER read
//       SUI_PRIVATE_KEY; price_publisher MUST NEVER read GRADUATION_SIGNER_KEY.
//
// ========== V14 SHIPPED (GRAD-1) - ADMIN FALLBACK IS TESTNET-ONLY =============
// Pre-V14, GRADUATION_SIGNER_KEY carried the AdminCap holder's private key on an
// always-online server - exactly the concentration finding E-1/GRAD-1 was raised
// to eliminate. V14 - a COMPATIBLE additive upgrade of V13 published via
// UpgradeCap V13 0x79ebefc92e5da42720ff4b3e719a71e4ecd5428a9750d4ada8257f61e3556a19
// - ships the fix: GraduationCap
// 0xe1eeaf7620fe62bc4e0d207821760c69a84758c757c47000790292f1a8d905ee, whose only
// powers are claim_graduation_funds_with_cap / record_graduation_pool_with_cap,
// validated against the shared GraduationRegistry
// 0xe1d895aec204ec64e2ad9755080d3dad20d053af6d480c149ae601d375281e8a
// (active-cap rotation: the cold AdminCap can revoke a compromised cap instantly,
// same pattern as the CreatorCap swap). With the SUIPUMP_V14_PACKAGE +
// SUIPUMP_GRADUATION_CAP + SUIPUMP_GRADUATION_REGISTRY triplet set on Render,
// GRADUATION_SIGNER_KEY holds ONLY the dedicated graduation wallet's key and the
// AdminCap key moves cold. The AdminCap fallback (any of the triplet unset)
// remains a TESTNET-ONLY EXPEDIENT and MUST NOT reach mainnet.
// =============================================================================
//
// ZERO imports on purpose: this module is imported from indexer/, from
// suipump-nexus-tools/ and from the graduation-test dirs, each with its own
// node_modules tree - it must not depend on any package being installed in any
// of them.

export const LATEST_WRITE_PACKAGE = (
  process.env.SUIPUMP_LATEST_WRITE_PACKAGE
  ?? '0xf5a3566ba920a3e3614e8b25da0ca3237879b6e22eb12f21ccf2bceb6520b9cd' // V12, current on-chain write target
).toLowerCase();

export const PRICE_CONFIG_ID = process.env.SUIPUMP_PRICE_CONFIG ?? null;

// The V13 package id (published 2026-07-17). Normalized to lowercase so every
// consumer's case-insensitive comparisons and Set membership are consistent.
export const V13_PACKAGE = (process.env.SUIPUMP_V13_PACKAGE ?? '').trim().toLowerCase() || null;

// ---------- V14 (GRAD-1): GraduationCap upgrade -----------------------------
// V14 is an ADDITIVE upgrade of V13 (compatible policy), so V14 curves keep the
// V13 TYPE identity - no new curve-shape branch is needed. What IS new: the
// GraduationCap path (claim/record _with_cap), the shared GraduationRegistry, and
// the GraduationCapIssued/Rotated events (typed under the V14 package id). All
// arrive by ENV only; every consumer stays null-safe when unset, behaving EXACTLY
// as pre-V14.
//   SUIPUMP_V14_PACKAGE        - the V14 package id (the upgrade). Target of the
//       new _with_cap graduation functions and the home of the new event types.
//   SUIPUMP_GRADUATION_CAP     - the GraduationCap object the graduation signer holds.
//   SUIPUMP_GRADUATION_REGISTRY- the shared GraduationRegistry (active_cap_id).
export const V14_PACKAGE = (process.env.SUIPUMP_V14_PACKAGE ?? '').trim().toLowerCase() || null;
export const GRADUATION_CAP_ID = (process.env.SUIPUMP_GRADUATION_CAP ?? '').trim() || null;
export const GRADUATION_REGISTRY_ID = (process.env.SUIPUMP_GRADUATION_REGISTRY ?? '').trim() || null;

// V14 graduation authority resolver - the SINGLE decision point for which cap the
// graduation signer uses. When ALL THREE V14 env vars are set it returns the narrow
// GraduationCap path ({ mode:'cap', pkg, cap, registry }); the graduation scripts
// then call claim_graduation_funds_with_cap / record_graduation_pool_with_cap on the
// V14 package, keeping the AdminCap key off the server (GRAD-1). Any missing -> it
// returns { mode:'admin' } and the scripts use the pre-V14 AdminCap path unchanged.
// SIGNER: both modes are signed by GRADUATION_SIGNER_KEY. In 'admin' mode that key
// must hold the AdminCap (the GRAD-1 concentration); in 'cap' mode it need hold ONLY
// the GraduationCap, so the AdminCap can move cold.
export function graduationAuthority() {
  if (V14_PACKAGE && GRADUATION_CAP_ID && GRADUATION_REGISTRY_ID) {
    return { mode: 'cap', pkg: V14_PACKAGE, cap: GRADUATION_CAP_ID, registry: GRADUATION_REGISTRY_ID };
  }
  return { mode: 'admin' };
}

// assertWriteTarget(client, requiredFunctions)
//   requiredFunctions: array of [moduleName, functionName] pairs, optionally
//   [moduleName, functionName, packageId] triples. Pairs are introspected
//   against LATEST_WRITE_PACKAGE; a triple's third element overrides the
//   package for THAT entry only (used for the V14 GraduationCap _with_cap
//   entrypoints, which live on SUIPUMP_V14_PACKAGE, not on the lineage write
//   target). Omitting the third element keeps pre-V14 behavior exactly.
//
// Client contract: v2 SuiGraphQLClient / SuiGrpcClient only -
// client.getMoveFunction({ packageId, moduleName, name }); the result carries
// the definition on .function when found (mirrors sessionCurvePackage in
// suipump-nexus-tools/bridge.js). The v1 JSON-RPC introspection flavor was
// removed with the JSON-RPC purge: every caller (indexer, bridge.js, both
// graduation dirs) now passes a v2 GraphQL client.
//
// Behavior contract: only a DEFINITIVE "this package has no such function"
// answer throws (refusing to start beats silently targeting a package without
// the function). A transport failure (endpoint down, network blip, 5xx) only
// warns and continues - transient outages must NOT crashloop services on
// Render; on-chain execution gives the final answer.
export async function assertWriteTarget(client, requiredFunctions) {
  for (const [moduleName, functionName, packageOverride] of requiredFunctions ?? []) {
    const targetPkg = packageOverride ?? LATEST_WRITE_PACKAGE;
    const label = `${moduleName}::${functionName}`;
    // found: true = present, false = definitively absent, null = unverifiable.
    let found = null;
    let transportErr = null;

    if (client && typeof client.getMoveFunction === 'function') {
      // v2 flavor. A successful call carries the definition on .function; a
      // successful call without it is a definitive absence. The v2 GraphQL
      // core ALSO reports absence by THROWING "Missing response data" (the
      // query round-trip succeeded but the node resolved to null - verified
      // live against the testnet endpoint, 2026-07-16), so that message is
      // definitive too. Any other throw is a transport problem, not an answer.
      try {
        const res = await client.getMoveFunction({
          packageId: targetPkg,
          moduleName,
          name: functionName,
        });
        found = !!(res && res.function);
      } catch (err) {
        const msg = String(err && err.message ? err.message : err);
        // ONLY "Missing response data" is definitive on the v2 flavor. Broader
        // patterns like /not found/ are unsafe here: an HTTP 404 from a typoed
        // SUI_GRAPHQL_URL or a proxy throws "GraphQL request failed: Not Found
        // (404)", which is a transport failure, not an on-chain answer.
        if (/missing response data/i.test(msg)) {
          found = false;
        } else {
          transportErr = err;
        }
      }
    } else {
      console.warn(`[write-target] client does not expose getMoveFunction - verification skipped for ${label} on ${targetPkg}`);
      continue;
    }

    if (found === false) {
      // Definitive absence: block startup loudly. Full package id on purpose -
      // never truncate identifiers.
      throw new Error(`[write-target] package ${targetPkg} is missing ${label} - check ${packageOverride ? 'SUIPUMP_V14_PACKAGE (per-pair package override)' : 'SUIPUMP_LATEST_WRITE_PACKAGE'} (the write target must be the newest published upgrade that contains it)`);
    }
    if (found === null) {
      // Only definitive absence blocks startup; transient outages must not
      // crashloop services.
      const why = String(transportErr && transportErr.message ? transportErr.message : transportErr);
      console.warn(`[write-target] could not verify ${label} on ${targetPkg} (${why}) - verification skipped for this pair`);
    }
  }
  return true;
}
