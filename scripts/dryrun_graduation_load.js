// scripts/dryrun_graduation_load.js
// READ-ONLY preflight for the two graduation modules. Proves that:
//   1. Both modules dynamic-import cleanly (each against its OWN pinned
//      @mysten/sui install: graduation-test locks 2.16.2 v2 SuiJsonRpcClient,
//      graduation-test-turbos pins ^1.45.2 v1 SuiClient).
//   2. Each module's OWN defaultClient() (env-driven JSON-RPC endpoint) can
//      fetch the given curve object: prints exists, type, and the graduated
//      field when visible.
//
// NO signing, NO keypair, NO writes. SUI_PRIVATE_KEY is NOT read.
// DATABASE_URL is NOT needed.
//
// Run (the graduation dirs ship without node_modules - install them first):
//
//   cd C:\Users\User\Desktop\suipump\graduation-test && npm install
//   cd C:\Users\User\Desktop\suipump\graduation-test-turbos && npm install
//   set SUIPUMP_JSONRPC_URL=<third-party testnet JSON-RPC endpoint>
//   node C:\Users\User\Desktop\suipump\scripts\dryrun_graduation_load.js <CURVE_ID>
//
// Required env: SUIPUMP_JSONRPC_URL (or legacy alias SUI_RPC_URL). The Sui
// Foundation public testnet JSON-RPC fullnode is dead (week of 2026-07-06),
// so there is no default endpoint.

const curveId = process.argv[2];
if (!curveId || !curveId.startsWith('0x')) {
  console.error('Usage: node scripts/dryrun_graduation_load.js <CURVE_ID>');
  console.error('  <CURVE_ID> is the full 66-char shared curve object id (0x...)');
  process.exit(1);
}

const MODULES = [
  {
    label:  'deepbook',
    dir:    'graduation-test',
    href:   new URL('../graduation-test/graduate_deepbook_full.js', import.meta.url).href,
    fnName: 'graduateToDeepBook',
    sdk:    '@mysten/sui 2.16.2 (v2 SuiJsonRpcClient)',
  },
  {
    label:  'turbos',
    dir:    'graduation-test-turbos',
    href:   new URL('../graduation-test-turbos/graduate_turbos_full.js', import.meta.url).href,
    fnName: 'graduateToTurbos',
    sdk:    '@mysten/sui ^1.45.2 (v1 SuiClient)',
  },
];

let failures = 0;

for (const m of MODULES) {
  console.log('='.repeat(72));
  console.log(`  [${m.label}] module: ${m.dir}  (${m.sdk})`);

  // -- 1. Load the module (proves its pinned deps resolve) --------------------
  let mod;
  try {
    mod = await import(m.href);
  } catch (err) {
    failures++;
    if (err?.code === 'ERR_MODULE_NOT_FOUND' || /Cannot find (module|package)/i.test(String(err?.message))) {
      console.error(`  [${m.label}] X import failed - dependencies not installed.`);
      console.error(`  [${m.label}]   Fix: cd C:\\Users\\User\\Desktop\\suipump\\${m.dir} && npm install`);
      console.error(`  [${m.label}]   (${err.message})`);
    } else {
      console.error(`  [${m.label}] X import failed: ${err?.message ?? err}`);
    }
    continue;
  }
  console.log(`  [${m.label}] + module loaded`);
  console.log(`  [${m.label}]   ${m.fnName}: ${typeof mod[m.fnName]}`);
  console.log(`  [${m.label}]   defaultClient: ${typeof mod.defaultClient}`);
  if (typeof mod[m.fnName] !== 'function' || typeof mod.defaultClient !== 'function') {
    failures++;
    console.error(`  [${m.label}] X expected exports missing - check the module`);
    continue;
  }

  // -- 2. Build the module's OWN client flavor (env-driven) -------------------
  let client;
  try {
    client = mod.defaultClient();
  } catch (err) {
    failures++;
    console.error(`  [${m.label}] X defaultClient() failed: ${err?.message ?? err}`);
    console.error(`  [${m.label}]   Fix: set SUIPUMP_JSONRPC_URL to a third-party testnet JSON-RPC endpoint`);
    continue;
  }
  console.log(`  [${m.label}] + client constructed (${client?.constructor?.name ?? 'unknown class'})`);

  // -- 3. READ-ONLY curve fetch ------------------------------------------------
  // Both dirs' clients are JSON-RPC flavored, so the getObject call shape is
  // identical: { id, options } (v2 SuiJsonRpcClient kept the old surface).
  try {
    const obj = await client.getObject({
      id: curveId,
      options: { showContent: true, showType: true },
    });
    const exists = !!obj?.data;
    const type   = obj?.data?.type ?? null;
    const fields = obj?.data?.content?.fields ?? {};
    const graduated = ('graduated' in fields) ? fields.graduated : 'not visible';
    console.log(`  [${m.label}] curve:     ${curveId}`);
    console.log(`  [${m.label}] exists:    ${exists}`);
    console.log(`  [${m.label}] type:      ${type}`);
    console.log(`  [${m.label}] graduated: ${graduated}`);
    if (!exists) {
      failures++;
      console.error(`  [${m.label}] X curve object not found via this client (error: ${JSON.stringify(obj?.error ?? null)})`);
    }
  } catch (err) {
    failures++;
    console.error(`  [${m.label}] X getObject failed: ${err?.message ?? err}`);
    console.error(`  [${m.label}]   (endpoint unreachable, or SUIPUMP_JSONRPC_URL is not a JSON-RPC endpoint)`);
  }
}

console.log('='.repeat(72));
if (failures > 0) {
  console.error(`X dry-run finished with ${failures} failure(s)`);
  process.exitCode = 1;
} else {
  console.log('OK both graduation modules loaded and read the curve with their own clients');
}
