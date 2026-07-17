// indexer/write_target.js
// Single env-driven WRITE target for the whole repo (V13 closeout, Task E).
//
// V13 is UNPUBLISHED. Nothing in the repo may hardcode a V13 package id or a
// PriceConfig object id - both arrive by ENV ONLY. After the V13 publish,
// Carlos flips these env vars on Render/Vercel with NO code change:
//
//   SUIPUMP_LATEST_WRITE_PACKAGE - the newest published upgrade package id that
//       every WRITE (moveCall) targets. Defaults to the currently-deployed V12
//       upgrade 0xf5a3566ba920a3e3614e8b25da0ca3237879b6e22eb12f21ccf2bceb6520b9cd
//       until the V13 publish. READ paths (ALL_PACKAGE_IDS iteration) are NOT
//       affected by this module and keep every historical package id.
//   SUIPUMP_PRICE_CONFIG - the shared PriceConfig object id created by the V13
//       publish (price_cfg). null until the publish.
//   SUIPUMP_V13_PACKAGE - the V13 package id itself, for consumers that need it
//       as a version key (event types, dispatch-set entries). null until the
//       publish.
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

// Set only after the V13 publish.
export const V13_PACKAGE = process.env.SUIPUMP_V13_PACKAGE ?? null;

// assertWriteTarget(client, requiredFunctions)
//   requiredFunctions: array of [moduleName, functionName] pairs. Each pair is
//   introspected against LATEST_WRITE_PACKAGE.
//
// Supports BOTH client flavors:
//   - v2 SuiGraphQLClient / SuiGrpcClient: client.getMoveFunction({ packageId,
//     moduleName, name }) - the result carries the definition on .function when
//     found (mirrors sessionCurvePackage in suipump-nexus-tools/bridge.js).
//   - v1 JSON-RPC SuiClient: client.getNormalizedMoveFunction({ package,
//     module, function }) - the graduation-test dirs pin @mysten/sui v1 for
//     turbos-clmm-sdk compatibility.
//
// Behavior contract: only a DEFINITIVE "this package has no such function"
// answer throws (refusing to start beats silently targeting a package without
// the function). A transport failure (endpoint down, network blip, 5xx) only
// warns and continues - transient outages must NOT crashloop services on
// Render; on-chain execution gives the final answer.
export async function assertWriteTarget(client, requiredFunctions) {
  for (const [moduleName, functionName] of requiredFunctions ?? []) {
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
          packageId: LATEST_WRITE_PACKAGE,
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
    } else if (client && typeof client.getNormalizedMoveFunction === 'function') {
      // v1 JSON-RPC flavor. Absence surfaces as a THROWN RPC error, so we
      // classify by message: "not found"-shaped errors are definitive absence;
      // anything else (network, timeout, 5xx) is a transport failure.
      try {
        const res = await client.getNormalizedMoveFunction({
          package: LATEST_WRITE_PACKAGE,
          module: moduleName,
          function: functionName,
        });
        found = !!res;
      } catch (err) {
        const msg = String(err && err.message ? err.message : err);
        if (/no function|function not found|cannot find function|no module|module not found|does not exist|not found in/i.test(msg)) {
          found = false;
        } else {
          transportErr = err;
        }
      }
    } else {
      console.warn(`[write-target] client exposes neither getMoveFunction nor getNormalizedMoveFunction - verification skipped for ${label} on ${LATEST_WRITE_PACKAGE}`);
      continue;
    }

    if (found === false) {
      // Definitive absence: block startup loudly. Full package id on purpose -
      // never truncate identifiers.
      throw new Error(`[write-target] package ${LATEST_WRITE_PACKAGE} is missing ${label} - check SUIPUMP_LATEST_WRITE_PACKAGE (the write target must be the newest published upgrade that contains it)`);
    }
    if (found === null) {
      // Only definitive absence blocks startup; transient outages must not
      // crashloop services.
      const why = String(transportErr && transportErr.message ? transportErr.message : transportErr);
      console.warn(`[write-target] could not verify ${label} on ${LATEST_WRITE_PACKAGE} (${why}) - verification skipped for this pair`);
    }
  }
  return true;
}
