# SuiPump - Project Handoff

Authoritative handoff and working constitution for anyone working on this repo.
Read fully before any task. Last rebuilt: 2026-07-18.

THIS FILE IS COMMITTED AND PUBLIC. Never put secrets, private keys, API keys,
or env values in it. Object ids, package ids, and public wallet addresses are
fine; key material is not, ever.

## What SuiPump is

Permissionless bonding-curve token launchpad on Sui with an autonomous per-user
agent layer (the differentiator: per-session trading signed by isolated Turnkey
TEE / Nitro-enclave keys, escrow + spend cap enforced on-chain). Testnet live;
MAINNET is gated on F-14 (multisig for the remaining admin powers) plus a
MoveBit external audit (~$50K planned figure; the audit docs name MoveBit but
not the price). Solo founder/owner: Carlos (does not write code).

- Live: https://suipump.org (NEVER the Vercel URL in anything user- or public-facing)
- Repo: github.com/cacoandrade455/suipump - Local: C:\Users\User\Desktop\suipump
- Stack: Move contracts + React 18 / Vite 5 / Tailwind 3 / react-router-dom v7 +
  @mysten/sui 2.17.x (^2.17.0 in frontend-app; verifyPersonalMessageSignature
  imports from '@mysten/sui/verify') + @mysten/dapp-kit-react (createDAppKit) on
  @mysten/dapp-kit-core 1.3.2 + @mysten/move-bytecode-template 0.3.0 (the
  bytecode-template package is the token publish path for /launch and an input
  to the user-funded launch redesign). Node v24 backend (indexer + bridge on
  Render), PostgreSQL, Vercel frontend (auto-deploy from main).
- Dev machine: Windows 11 cmd (NOT PowerShell). Backslash paths. Slush wallet.

## Package lineage - the most load-bearing facts in the repo

Source of truth: frontend-app/src/constants.js, indexer/write_target.js, and
the PACKAGE_LATEST map in suipump-nexus-tools/bridge.js. NEVER contradict these.

ALL package ids V4..V12 stay in ALL_PACKAGE_IDS FOREVER, plus V13 and V14
(env-gated, conditional-spread when their env vars are set). Old tokens remain
visible, tradeable, and counted in stats. READ paths iterate all of them; WRITE
paths dispatch by each token's own package version (signatures differ per
version).

Legacy lineage (V4-V9, tradeable forever):
- V4   0x2154486dcf503bd3e8feae4fb913e862f7e2bbf4489769aff63978f55d55b4a8
- V5   0x785c0604cb6c60a8547501e307d2b0ca7a586ff912c8abff4edfb88db65b7236
- V6   0x21d5b1284d5f1d4d14214654f414ffca20c757ee9f9db7701d3ffaaac62cd768
- V7   0xfb8f3f3e4e8d53130ac140906eebea6b6740bfaf0c971aec607fbc723be951f0
- V8_1 0x145a1e79b83cc17680dbfe4f96839cd359c7db380ac15463ecb6dc30f9849b69
- V8   0xbb4ee050239f59dfd983501ce101698ba27857f77aff2d437cec568fe0062546
- V9   0x719698e5138582d78ee95317271e8bce05769569a4f58c940a7f1b424d90ffe2

V10 lineage (FROZEN - no further upgrades planned):
- V10 0x2deda2cade65cd5afd5ffbe799d48f2491debf08d3aef6fa11aa6e1c8afe1598
      (DEFINING package of the lineage: creator buyback+burn, CTO votes,
      holder-gated comments + parent_id replies, protocol surcharge,
      AgentSession. buy()/sell() signatures identical to V9;
      claim_creator_fees()/update_payouts() gain clock; post_comment() gains
      holder_coin + parent_id.)
- V11 0xc03817bce45ff492e5d0f40f9e46f5a075a952b50c5c6146b8fb38138bd699eb
      (UPGRADE of V10, not a separate publish: net-exposure spend cap,
      TradeTicket universal-trading owner opt-in, expiry_ms==0 closed sentinel,
      SessionBuyV2/SessionSellV2 events.)
- V12 0xf5a3566ba920a3e3614e8b25da0ca3237879b6e22eb12f21ccf2bceb6520b9cd
      (Second upgrade: set_comment_gate toggle, enclave_registry module
      (Nautilus), open_and_share_attested, SessionAttested. WRITE TARGET for
      the V10 lineage.)

V13 lineage (CURRENT - fresh publish 2026-07-17, sui 1.75.2, publish digest
HFqyRPYV2UXYnqt83KegrhFpUReoGgncXPC42n8rADq1):
- V13 0xdf66376f006557b9f81b3455ee786ffd7f2a633488cc3bd31a37ddbdc69bd56b
      NOT an upgrade of the V10 lineage - a SEPARATE lineage with its OWN type
      identity. V13 curves are
      0xdf66376f006557b9f81b3455ee786ffd7f2a633488cc3bd31a37ddbdc69bd56b::bonding_curve::Curve<T>,
      never V10-typed. WHY a fresh publish: the F-2 fix removes buy()'s
      caller-supplied sui_price_scaled u64 (buy()/buy_with_session() take
      &PriceConfig instead), and the compatible upgrade policy forbids public
      signature changes - so the fix REQUIRED a new lineage. Also:
      post_comment goes 7 -> 6 params (author dropped); escrow-weighted CTO.
      Env-gated everywhere: VITE_SUIPUMP_V13_PACKAGE + VITE_SUIPUMP_PRICE_CONFIG
      (frontend), SUIPUMP_V13_PACKAGE + SUIPUMP_PRICE_CONFIG (backend).
      PriceConfig (shared)
      0xa5b38690b2883e8e4d2c155c43a438dcbc67f027a2577f529198843a989a21f9.
- V14 0xb6e7cef4d36b3cf0fd84888dd9930ce9abfcc0ed56f01384f1e02b55eeac1b03
      ADDITIVE COMPATIBLE UPGRADE of V13 via UpgradeCap V13, live 2026-07-18.
      NOT a replacement of V13 and NOT a new lineage. DEFINING package for the
      new types and events only: GraduationCap, GraduationRegistry,
      GraduationCapIssued, GraduationCapRotated, and the new entrypoints
      init_graduation, rotate_graduation_cap, claim_graduation_funds_with_cap,
      record_graduation_pool_with_cap. WRITE target for new graduations.
      V13 curve and buy events keep their V13 type identity (indexed via the
      V13 id); only the new graduation events type under V14. Env-gated:
      VITE_SUIPUMP_V14_PACKAGE (frontend) / SUIPUMP_V14_PACKAGE +
      SUIPUMP_GRADUATION_CAP + SUIPUMP_GRADUATION_REGISTRY (worker; all three
      set = _with_cap path, any missing = AdminCap path). This closed GRAD-1.

UPGRADE SEMANTICS (memorize):
- Types keep their DEFINING package ids forever. Curve<T>/AgentSession type
  under V10 for the V10 lineage; V11/V12 never appear as curve-type packages.
  V13 curves type under V13; V14 never appears as a curve-type package.
- Calls to a defining address run OLD bytecode. All WRITES must target the
  lineage's LATEST package (V12 for the V10 lineage, V14 for V13-lineage
  graduation calls) or upgrades never take effect. bridge.js remaps via
  PACKAGE_LATEST (defining package -> latest upgrade).
- Events defined in V10 keep V10-typed names even when emitted by V12 code;
  only new events (SessionBuyV2, CommentGateSet, SessionAttested) type under
  V11/V12. Same rule in the V13 lineage: only
  GraduationCapIssued/GraduationCapRotated type under V14.
- Every NEW package version MUST get its own branch in getVirtuals (frontend)
  and getVSui (runner) or prices silently fall through to stale virtual
  reserves (this caused the -20% price-badge incident). Same for
  signature-dispatch sets (V5_PLUS / V7_PLUS / V9_PLUS / V10_PLUS in
  bridge.js). EXCEPTION: V14 deliberately has NO curve-shape/dispatch branch
  anywhere - V14 curves keep the V13 type identity, so resolvers never see
  the V14 id (constants.js documents this as intentional). V14 is present
  only in ALL_PACKAGE_IDS event-read coverage.

DECOY TRAP (read twice): after the V14 upgrade, the UpgradeCap V13 object's
on-chain `package` field shows an id beginning 0xc0d595ef that is NOT the
defining package for V14's new types. NEVER copy a package id out of an
UpgradeCap object (or out of Published.toml's published-at field, which
records storage ids that diverge from defining ids after upgrades). Package
ids come from THIS handoff and the reaudit docs, nowhere else. The 0xc0d595ef
prefix is INTENTIONALLY PARTIAL so it can never be copy-pasted into code -
this is the one sanctioned exception to the full-id rule below.

Capabilities (V10 lineage): ADMIN_CAP_V10
0x144d426960a9a6b8db63ce3426e06a9c41273a17e72ed0193cd8c8507d4f6ec5.
UPGRADE_CAP_V10 0xb840fc9c54271c73f9c5e8f22f42ffda3c46f93914586bf671958ad9e754a274
governs the whole V10 lineage. (V9 caps - legacy: AdminCap
0x2e0989604424ffa96f58618795285dac09d8eaf2fd0d35f4a7e9bbc22bea2bf7, UpgradeCap
0xb3d8067ef98271c7edc58843e46f2e4cf2c12dad6537a3a1f1008f057db41e0e.)

Capabilities (V13 lineage): AdminCap V13
0xb3d3155ca1bc153664143895928aa77384f5c70f752c306e10fa619f460e039d. UpgradeCap
V13 0x79ebefc92e5da42720ff4b3e719a71e4ecd5428a9750d4ada8257f61e3556a19 (governs
V14 and future V13-lineage upgrades). PriceRelayerCap
0x818e0263bc28f5f6089ed6b120fa818cba61d0378897f197398ed2b860ad7510.
GraduationRegistry (shared)
0xe1d895aec204ec64e2ad9755080d3dad20d053af6d480c149ae601d375281e8a.
GraduationCap
0xe1eeaf7620fe62bc4e0d207821760c69a84758c757c47000790292f1a8d905ee.

## Curve math + fees

Constants (V9 through V14): VS=4369 virtual SUI, VTR=1073M virtual token
reserve (bonding_curve.move: VIRTUAL_SUI_RESERVE = 4_369 * 1_000_000_000,
VIRTUAL_TOKEN_RESERVE = 1_073_000_000 * 1_000_000).

Graduation threshold - SPLIT BY LINEAGE, do not mix:
- V13+ (current): BASE_GRAD_MIST = 9_000 * 1_000_000_000 (9000 SUI at $1) and
  the threshold is DYNAMIC: BASE_GRAD * sqrt(1000) / sqrt(price_scaled),
  computed on-chain via isqrt in resolve_grad_threshold(price_cfg, clock).
  buy() resolves it from the shared PriceConfig every call and caches it in
  the Curve field `current_grad_threshold` (u64) - on the buy path that field
  is a DISPLAY CACHE ONLY. Standalone graduate() reads the STORED
  current_grad_threshold and requires it > 0 (fresh curves cannot be
  grief-graduated). Stale price (> 30 min) or price == 0 falls back to the
  static 9000 floor - buys never abort on oracle unavailability. Off-chain
  resolver order: curve.current_grad_threshold, else recompute from
  PriceConfig, else the 9000 floor. 12305 must never appear in V13+ math.
- V4-V12 keep their STATIC drain constants forever: 12305 SUI for V9-V12
  (contracts-v9 BASE_GRAD_MIST = 12_305 * 1_000_000_000); V8/V8_1 use 9000
  with vSui 3500 (see frontend-app/api/token-og.js per-version table).

Fees (unchanged through the lineages): trade fee 1.00% (TRADE_FEE_BPS=100).
split_fee_v7: 40% creator / 25% protocol / 25% airdrop / 10% LP. With
referral: 40/20/20/10/10.

Buyback (V10+): set_buyback_config<T>(cap, curve, buyback_bps, burn, clock,
ctx) creator-gated; execute_buyback<T>(curve, ctx) callable by anyone.
Launch-time default buybackBps 2000 + buybackBurn; UI config {enabled, pct}
default 50, threshold 5 SUI.

## Custody model - four wallets, know this cold

1. PRICE RELAYER wallet
   0xce53cb8f9befc490393d70528ef732bbcbe12d951ffcdd76a37af9b0f9624629
   Holds ONLY the PriceRelayerCap + gas. Key = SUI_PRIVATE_KEY on the indexer
   worker. Publishes a clamped SUI/USD price every 300s via
   set_sui_price(PriceRelayerCap, PriceConfig, price, clock): three parallel
   sources (Binance SUIUSDT, Coinbase SUI-USD, Kraken SUIUSD), requires >= 2
   responsive with <= 5% spread, publishes the MEDIAN, clamped to scaled
   [100, 100000] ($0.10-$100). Guard failure = no push; stale is safe (9000
   floor). Worst case if this key leaks: a bounded wrong price (E-1 fix).
2. GRADUATION SIGNER wallet
   0x7334d47632af5386d9b16326ade55be642fc8a569a1672b0cbaaf4d0e7e6180a
   Holds ONLY the GraduationCap + gas. Key = GRADUATION_SIGNER_KEY on the
   worker's graduation scripts. auto_graduate uses the _with_cap entrypoints
   (claim_graduation_funds_with_cap / record_graduation_pool_with_cap): it can
   only claim graduated reserves and record pools. Revocable at any time from
   the cold AdminCap via rotate_graduation_cap (this is the GRAD-1 fix).
3. MAIN wallet
   0x0be9a8f56ba3b07f295e0c7526e7f47ca3a146649b9d864d2eb47bf3acd90c55
   Holds AdminCap V13 + UpgradeCap V13. COLD - the key lives on NO server
   (off every server since 2026-07-18). Its remaining powers (mint, pause,
   fee claims) are exactly what the F-14 mainnet multisig gate covers.
4. RETIRED shared agent wallet
   0x877af0fae3fa4f8ea936943b59bcd66104f67cf1895302e97761a28b3c3a5906
   Removed from ALL execution paths (0 live fallback sessions). The bridge's
   bare /buy /sell /claim /launch endpoints return HTTP 410. Its key is
   loadable ONLY behind SUIPUMP_LEGACY_SIGNER=1, which is never set; without
   the flag the load path throws. /health exposes legacySigner status.

## Env vars (code-verified inventory)

Services: worker = indexer worker (node index.js), api = indexer web
(api_server.js), bridge = suipump-nexus-tools/bridge.js, runner = agent-runner,
fe = Vercel frontend build (VITE_*, baked at build), edge = frontend-app/api/*.

Package / write-target (all flow through indexer/write_target.js):
- SUIPUMP_LATEST_WRITE_PACKAGE  worker+bridge+graduation scripts - V10-lineage
  write target; default V12
  0xf5a3566ba920a3e3614e8b25da0ca3237879b6e22eb12f21ccf2bceb6520b9cd
- SUIPUMP_V13_PACKAGE   worker+api+runner+bridge+edge - the V13 package id;
  never hardcoded anywhere; unset = V13 events not indexed, V13 branches inert
- SUIPUMP_PRICE_CONFIG  worker (price publisher) + bridge (V13 dispatch) -
  shared PriceConfig id; unset = both stay dormant
- SUIPUMP_V14_PACKAGE   worker+bridge+edge - V14 id (event types + _with_cap
  target); unset = behaves exactly pre-V14
- SUIPUMP_GRADUATION_CAP / SUIPUMP_GRADUATION_REGISTRY  worker graduation path.
  graduationAuthority(): ALL of V14 pkg + cap + registry set -> cap mode
  (AdminCap goes cold); any missing -> admin mode (pre-V14 path)
- SUIPUMP_PRICE_RELAYER_CAP  worker - PriceRelayerCap id, the ONLY cap
  set_sui_price accepts; ownership asserted vs signer at startup; unset =
  publisher dormant
- PACKAGE_IDS  worker only - comma-separated override of the tracked package
  list (boot log states which source won). Default = code ALL_PACKAGE_IDS
  (V4..V12 hardcoded + V13/V14 from env). Full 12-id override line:
  0x2154486dcf503bd3e8feae4fb913e862f7e2bbf4489769aff63978f55d55b4a8,0x785c0604cb6c60a8547501e307d2b0ca7a586ff912c8abff4edfb88db65b7236,0x21d5b1284d5f1d4d14214654f414ffca20c757ee9f9db7701d3ffaaac62cd768,0xfb8f3f3e4e8d53130ac140906eebea6b6740bfaf0c971aec607fbc723be951f0,0x145a1e79b83cc17680dbfe4f96839cd359c7db380ac15463ecb6dc30f9849b69,0xbb4ee050239f59dfd983501ce101698ba27857f77aff2d437cec568fe0062546,0x719698e5138582d78ee95317271e8bce05769569a4f58c940a7f1b424d90ffe2,0x2deda2cade65cd5afd5ffbe799d48f2491debf08d3aef6fa11aa6e1c8afe1598,0xc03817bce45ff492e5d0f40f9e46f5a075a952b50c5c6146b8fb38138bd699eb,0xf5a3566ba920a3e3614e8b25da0ca3237879b6e22eb12f21ccf2bceb6520b9cd,0xdf66376f006557b9f81b3455ee786ffd7f2a633488cc3bd31a37ddbdc69bd56b,0xb6e7cef4d36b3cf0fd84888dd9930ce9abfcc0ed56f01384f1e02b55eeac1b03
- EPOCH_PKG  worker - Epoch partner-launch event package (hardcoded testnet
  default; mainnet swap required)

Signer / custody keys (values NEVER in this repo):
- SUI_PRIVATE_KEY  HAZARD - same env NAME, DIFFERENT wallet per service. On
  the worker it is the price-relayer wallet key (guarded by the cap-owner
  assert at startup). On the bridge it is the retired shared-agent-wallet key,
  inert unless SUIPUMP_LEGACY_SIGNER=1. Never copy one service's env into the
  other.
- GRADUATION_SIGNER_KEY  graduation scripts only - the graduation signer
  wallet key; MUST NEVER be read by the price publisher; throws if the
  graduation CLI runs without it
- SUIPUMP_LEGACY_SIGNER  bridge - '1' gates the only remaining shared-agent
  key path; never set
- TURNKEY_API_PUBLIC_KEY / TURNKEY_API_PRIVATE_KEY / TURNKEY_ORGANIZATION_ID
  bridge - all three required for Turnkey TEE signing; TURNKEY_API_BASE_URL
  optional; TURNKEY_SESSION_KEYS optional JSON map (env fallback for signer DB)
- ENCLAVE_SIGNER_URL  bridge - Nitro-enclave signer endpoint

Service one-liners:
- bridge: PORT (3030), SUIPUMP_INDEXER_URL, AGENT_API_KEY (unset = write
  endpoints OPEN with loud warning), SUI_GRAPHQL_URL, DATABASE_URL
- runner: PORT (3040), AGENT_API_KEY, STRATEGY_API_KEY, DEMO_MODE ('1' = on,
  must stay OFF), INVOKER_ADDRESS, RUNNER_URL, SUIPUMP_BRIDGE_URL,
  INDEXER_URL, SUI_GRAPHQL_URL, DAG_* / GROUP_* ids, STRATEGY_* tunables
- indexer: DATABASE_URL, NODE_ENV, NETWORK (default testnet), SUI_GRAPHQL_URL,
  SUI_GRPC_URL, PORT (3001), STRATEGY_API_KEY, POINTS_EXCLUDED_WALLETS
- graduation scripts: SUIPUMP_JSONRPC_URL (legacy alias SUI_RPC_URL) REQUIRED -
  throws if unset (the sole grandfathered JSON-RPC consumer, see hard rule 2)

Frontend build (VITE_*, baked into the Vercel bundle):
- VITE_SUIPUMP_V13_PACKAGE / VITE_SUIPUMP_PRICE_CONFIG - V13 read paths + buy
  dispatch; V13_BUY_ENABLED only when BOTH are set
- VITE_SUIPUMP_V14_PACKAGE - V14 event-type read coverage
- VITE_INDEXER_URL / VITE_SUIPUMP_BRIDGE_URL / VITE_AGENT_RUNNER_URL - service
  bases
- VITE_AGENT_SESSION_WALLET / VITE_ENCLAVE_REGISTRY_ID - fallback session
  wallet + EnclaveRegistry (hardcoded defaults exist)
- VITE_SP_INTERNAL_KEY - client half of the internal analysis-endpoint secret

Vercel edge/serverless (frontend-app/api/*):
- SUIPUMP_V13_PACKAGE / SUIPUMP_V14_PACKAGE (token-og.js), SUIPUMP_BRIDGE_URL,
  AGENT_RUNNER_URL, AGENT_API_KEY (server-side x-agent-key, never shipped to
  the browser), INDEXER_URL (falls back to VITE_INDEXER_URL), STRATEGY_API_KEY,
  SP_INTERNAL_KEY, GROQ_API_KEY, EPOCH_API_BASE + EPOCH_SHARED_SECRET.
  NOTE: rpc.js hardcodes the GraphQL upstream
  https://graphql.testnet.sui.io/graphql with no env override - a code change
  is required at mainnet cutover.

Known hardcode gap: ADMIN_CAP_V13 is a literal in indexer/auto_graduate.js and
both graduation-test scripts (documented testnet-only expedient for the admin
graduation path; dead code once the cap path is armed).

## Security posture

Audit documents (read before touching contracts):
- SECURITY_AUDIT_2026-07-15.md (its findings table IS the resolution ledger)
- contracts-v10/AUDIT_NOTES.md
- contracts-v10/SECURITY_REAUDIT_2026-07-16.md
- contracts-v10/SECURITY_REAUDIT_2026-07-17_PREPUBLISH.md
- contracts-v10/EXECUTIVE_SECURITY_REPORT.md

Findings status (precise): F-1, F-2, F-3, F-4, F-5, F-7, F-10 FIXED; F-6
ACCEPTED (founder decision); F-8 SUPERSEDED by the F-2 fix; F-9 PARTLY
RESOLVED with the remainder tracked as F-14 (mainnet multisig). Highlights:
- F-2: buy() no longer trusts a caller-supplied price - it reads the shared
  PriceConfig (the change that forced the V13 fresh publish).
- F-3 + F-AC-1: fixed together by the escrow-weighted CTO redesign.
- E-1: fixed by splitting price publishing onto the PriceRelayerCap (relayer
  compromise = bounded wrong price only, no admin powers).
- PREPUBLISH-2: fixed - one-shot marker guarantees exactly one
  PriceConfig/PriceRelayerCap per package on BOTH publish paths.
- GRAD-1: fixed by the V14 GraduationCap + rotation registry (graduation
  signer holds a narrow revocable cap; AdminCap went cold).

MAINNET-BLOCKING: F-14 (multisig for remaining AdminCap powers) + the MoveBit
external audit. Everything else above is shipped on testnet.

## HARD RULES - never violate

1. **Wallet transactions for bonding-curve trades: NEVER
   dAppKit.signAndExecuteTransaction.** It makes Slush build/serialize the PTB
   and it crashes reading txSignatures on shared-object refs (proven
   2026-07-09). ALWAYS:
   tx.setSender(account.address)
   -> const built = await tx.build({ client: new SuiGraphQLClient({ url: '/api/rpc' }) })
   -> const { signature } = await dAppKit.signTransaction({ transaction: tx })
   -> client.executeTransaction({ transaction: built, signatures: [signature] }).
   Manual trades are USER-wallet-signed (userBuy/userSell in AgentPage;
   TokenPage trade path) and refuse legacy V4-V9 curves by design. The
   bridge's bare /buy /sell endpoints are RETIRED (HTTP 410) - no manual or
   autonomous trade routes through the shared agent keypair.
2. **JSON-RPC is FORBIDDEN** (hard shutdown 2026-07-31). SuiGraphQLClient /
   SuiGrpcClient only. GraphQL getObject takes { objectId } and reads
   obj.object.owner - never the JSON-RPC shape with id + options. Never write
   new code using SuiClient/getFullnodeUrl. Sole grandfathered exception: the
   worker-dispatched graduation scripts (SUIPUMP_JSONRPC_URL).
3. **Curve refs:** use tx.sharedObjectRef({ objectId, initialSharedVersion,
   mutable:true }) when the ISV is known, with tx.object(curveId) as the
   fallback when it is not (TokenPage pattern). Curves are shared objects.
4. **NEVER truncate ANY on-chain identifier** - object IDs, tx digests,
   package IDs, capability IDs, curve IDs / token CAs, wallet/session
   addresses, coin types, DAG IDs. Full 66-char strings everywhere: prose,
   lists, commands, code, comments. Sole sanctioned exception: the 0xc0d595ef
   decoy prefix in the lineage section, deliberately partial so it cannot be
   copy-pasted.
5. **Git discipline:** explicit `git add <named files>` only - NEVER
   `git add -A` or `git add .`. Never commit session notes, scratch handoffs,
   env files, or key material. This handoff file IS committed - keep it
   public-safe. Nobody but the owner pushes or deploys; he reviews the diff
   and fires every push himself.
6. **BigInt x number crashes at runtime.** Convert with Number(bigint) before
   any arithmetic on u64 chain values. A green build does NOT catch this class
   of bug.
7. **fmt() first line stays `if (n == null) return '-';`** Never remove or
   reorder.
8. **post_comment dispatches per version.** V13-lineage signature (6 params):
   post_comment<T>(curve, text, payment, &holder_coin, parent_id, ctx).
   V10-lineage signature (7 params):
   post_comment<T>(curve, text, payment, author, &holder_coin, parent_id, ctx),
   write targeted at V12, NOT the curve-derived defining id. parent_id =
   parent comment's tx digest as address, ZERO_ADDR
   (0x0000000000000000000000000000000000000000000000000000000000000000) for
   top-level. Legacy V4-V9 keep their older signatures - dispatch, don't
   assume.
9. **Browser storage:** no trading/session/critical state in localStorage or
   sessionStorage ever. Existing cosmetic caches (pfp cache, watchlist, legacy
   V4-V9 off-chain reply cache) are grandfathered - do not extend the pattern.
10. **No PowerShell multiline regex** for scripting/codemods - write a Python
    script (dev machine is Windows cmd).
11. **Design system:** lime-on-void terminal aesthetic (#84cc16 on #050505,
    JetBrains Mono). During the redesign migration, read EXACT values (colors,
    font shorthand, padding, radii, borders, hover states) from the design
    HTML - never invent values, never ship the design HTML itself.
12. **BrowserRouter wraps <App /> in main.jsx.** Do not move routing setup.
13. **Images upload via the Imgur anonymous API.** Token page block order
    stays: Chart -> Stats -> Trades/Holders -> AIAnalysis -> Trade -> Comments.
14. **ASCII purity** in source files (no non-ASCII outside rendered UI
    glyphs). Gates before any commit: acorn ES2023 for .js, esbuild for .jsx.

## Agent layer (bridge / runner / sessions) - know this cold

- Execution is BRIDGE-DIRECT. The Nexus/Talus Leader path is SCOPED OUT of v1
  (settled decision). Runner DEMO_MODE must be OFF in the runner env;
  session-bound orders never take the Leader branch regardless
  (if (DEMO_MODE && !sessionId)).
- Signer is chosen PER SESSION by turnkeyKeyForSession(sessionId) in the
  bridge: provisioned Turnkey/enclave key -> signViaEnclave signs the tx
  digest inside the TEE/Nitro enclave (key never leaves; sender ==
  session_address; true per-user custody). Sessions WITHOUT a provisioned key
  cannot trade: the old shared-wallet fallback throws unless
  SUIPUMP_LEGACY_SIGNER=1 (never set). The A5.2 amber badge ("SIGNER: SHARED
  AGENT WALLET") remains in the UI to surface any legacy fallback - keep it.
- The shared agent wallet is RETIRED (see Custody model): bare /buy /sell
  /claim /launch return HTTP 410; request-body privateKey overrides removed.
- The contract protects user funds either way: sender == session_address +
  spend_cap + expiry + revoked, enforced on-chain.
- **spend_cap semantics are V11 net-exposure: sells DECREMENT spent, clamped
  at zero.** It is NOT a lifetime cumulative buy odometer - never describe or
  code it as one.
- Session-bought positions live as parked Coin<T> dynamic OBJECT fields ON THE
  SESSION object, not at any address balance. Read the DOF
  (getSessionParkedWhole in strategy.js / sessionParkedAtomic in bridge.js),
  never the address, for session positions. Session sells go through
  /session-sell (supports sellAll:true).
- Sessions are AUTONOMOUS-ONLY. Manual trades are the user's own wallet.
- spawnChild children must inherit BOTH wallet AND sessionId.
- Double-buy protections (do not weaken): fireNexusBuy refuses bridge fallback
  while a walk is pending; bridge BUY_IDEMPOTENCY_TTL_MS dedup;
  fireScheduleTask is quarantined ("DO NOT CALL FROM STRATEGY FIRE PATHS"),
  taskId=null everywhere.
- sanitizeParams is a strict per-type allowlist that SILENTLY DROPS unknown
  fields: fold new fields (e.g. sessionId) into params unconditionally AFTER
  it runs.
- Self-funded sessions: the owner's open PTB grants 0.5 SUI gas to the session
  address (skipGasFunding:true); enclave/Turnkey sessions touch no shared
  wallet for signing or gas.

## Redesign migration ("Terminal" direction) - active workstream

- Ground truth: RECONCILIATION_LEDGER.md. Design HTML (SuiPump_Redesign.dc.html)
  is the pixel-level truth for STYLE; the repo code is the truth for
  LOGIC/features. Recreate in React/Tailwind using existing hooks
  (useTokenList, useTradeKey, useCreatorBuyback, useWatchlist,
  useRealtimeFeed, t(lang,key) i18n, dapp-kit flows). NEVER ship the design
  HTML.
- Migration order: 2a brand -> 1b board -> 2b token (2 sessions) -> 2c launch
  -> 2d agent (A5-preserving) -> 2e portfolio -> /profile ->
  leaderboard+airdrop -> 2g stats -> 3a/3b. Screen 3c is the 66-item
  acceptance checklist.
- Settled decisions: NEXUS RUNNER chip -> AGENT RUNNER; TradeTicket footnote
  omitted in v1; NAUTILUS ATTESTED chip conditional + A5 signer badge
  MANDATORY in 2d; "King of the Hill" -> COMMUNITY CROWN; Leaderboard +
  Airdrop stay SEPARATE routes; S1 airdrop = 10% NFT holders + 10% testnet
  users, TESTNET POINTS ELIMINATED (mainnet points start fresh); earn-table
  numbers are the real MAINNET numbers; public read-only /profile/:address IS
  in scope; stats projection: $50M volume -> $500k total fees -> $125k S1
  airdrop pool (0.25% of volume) - never label $250k as the S1 pool;
  portfolio SHOWS session-parked positions (GET /agent/sessions?owner=, probe
  parked Coin<T> DOFs, tag SESSION, sell via /session-sell); launch modal
  keeps the EXACT existing Epoch authorize->redirect->return flow.
- Game page (GamePage.jsx): intentionally untouched. Do not restyle.
- Flame logo: inline SVG system, one geometry, four cuts
  (AURORA/SOLID/STRIKE/PULSE) - never redraw, only cut. Exact paths in
  REDESIGN_README.md.

## Known traps

- update_constants requires the new value's byte length to EXACTLY match the
  placeholder in template.move. To raise metadata capacity: recompile the
  template with longer placeholders and re-upload template.mv. Tokens deployed
  as "Template Coin" are permanently frozen - they cannot be fixed; don't try.
- Stale-bundle false alarms: before concluding a frontend fix "didn't work",
  verify the deployed bundle is fresh (Vercel deployment Ready + Empty Cache
  and Hard Reload, or Incognito). Conversely, do not reflexively blame cache -
  verify, then read the actual files in the failure path. Debug surgically;
  never shotgun changes.
- The owner's browser injects MetaMask + OKX alongside Slush - console noise.
  Incognito with only Slush gives the cleanest diagnosis.
- CRLF: .gitattributes pins source to LF; core.autocrlf=true corrupts on
  checkout.
- Reserve-derived pricing: first_price and last_price must use the SAME
  (reserve-derived) definition or price badges show spurious deltas.
- Epoch integration: launch fee 7 SUI total (3 Epoch / 2 SuiPump / net 4
  protocol); one name per token; deterministic URL
  https://[name].epochsui.com/.
- Indexer: two Render services - worker (node index.js, pg_notify
  'suipump_events') + web (node api_server.js, LISTEN -> SSE at GET
  /stream?curveId=). UNIQUE constraint on events: (tx_digest, event_type).
- Package-id provenance: see the DECOY TRAP in the lineage section. Neither
  the UpgradeCap object's package field nor Published.toml's published-at is a
  source of defining package ids after an upgrade.

## Dev discipline / workflow

- The owner does not write code. Deliver complete drop-in files or complete,
  surgical edits - never fragments, stubs, or TODOs.
- Never claim something is fixed without proof. Minimum bar: `npm run build`
  passes (frontend) / `sui move build` + tests (contracts) / acorn+esbuild
  gates, output shown. For chain-interaction changes, state explicitly what
  was verified and what was not (runtime BigInt bugs survive a green build).
- Verification culture: behavior is confirmed with raw curl output,
  screenshots, and on-chain state before moving to the next item.
- Before any push, verify deliverable integrity: `certutil -hashfile <file>
  MD5` on each changed file and compare against the reviewed copy, so the
  bytes on disk are provably the bytes that were reviewed.
- Git: `git add <named files>` only (hard rule 5). The owner names and ends
  working sessions, reviews every diff, and fires every push himself.
- If the owner says it's broken, first verify bundle freshness (see Known
  traps), then read the specific files in the failure path before
  hypothesizing.
- On-chain state-changing operations (publishes, upgrades, admin calls) are
  proposed as exact commands for the owner to run - never executed by anyone
  else.

## Commands

- `npm run dev` - local dev server (frontend-app)
- `npm run build` - production build; must pass before any commit touching
  frontend
- `npx acorn --ecma2023 <file.js>` / esbuild parse for .jsx - syntax gates
- Move: `sui move build` in the contracts dir; tests + Python harness
  (test_harness_v10.py). Publish/upgrade commands are proposed to the owner,
  never run directly.
- Sui CLI: 1.75.2 (the V13/V14 publish toolchain).

## Key IDs and endpoints (testnet)

- Enclave registry 0xf001bf6b078879b95c969ea11ef07dd53ffed364c62d8832990077f67d4996a1
  (register tx digest 95mZqhLQfWJR3uvGyT4HgCpqEiELCTkv1eXL92ApercA)
- Main/control wallet 0x0be9a8f56ba3b07f295e0c7526e7f47ca3a146649b9d864d2eb47bf3acd90c55
- Price relayer wallet 0xce53cb8f9befc490393d70528ef732bbcbe12d951ffcdd76a37af9b0f9624629
- Graduation signer wallet 0x7334d47632af5386d9b16326ade55be642fc8a569a1672b0cbaaf4d0e7e6180a
- Retired shared agent wallet 0x877af0fae3fa4f8ea936943b59bcd66104f67cf1895302e97761a28b3c3a5906
- Owner's connected test wallet 0x77cd9934de80769ea7e8af5b7dcac9e17f649fb5bd89a1089b0551e567b35347
- Indexer https://suipump-62s2.onrender.com - Bridge https://suipump-bridge.onrender.com
- Sui GraphQL (direct event reads) https://graphql.testnet.sui.io/graphql;
  frontend build/execute goes through the /api/rpc proxy.

## Public content (when drafting tweets/posts)

No em-dashes, no hashtags, no engagement bait. Relevant emoji before every
sentence/paragraph. Single tweets only, link in the first reply (suipump.org),
end with a real question, max 2-3 posts/day. Discord posts end with
:emoji_1: :emoji_1: :emoji_1: :emoji_1: :emoji_1:. Em-dashes are fine in
internal docs.
