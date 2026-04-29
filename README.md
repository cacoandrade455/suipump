# SuiPump — bonding-curve token launcher on Sui

A permissionless bonding-curve token launcher with creator revenue sharing,
deployed on Sui. Differentiated from the incumbent Solana launchpad by
(1) lower total fees with a larger creator share, (2) LP fee retention that
grows liquidity with volume, and (3) Sui's object model giving each launch
its own isolated shared object.

## Project layout

```
suipump/
├── contracts/
│   ├── Move.toml
│   └── sources/
│       ├── bonding_curve.move        # core module — curve, fees, graduation
│       ├── token_template.move       # per-launch OTW template
│       └── bonding_curve_tests.move  # Move unit tests
├── frontend/
│   └── App.jsx                        # React demo UI
└── tests/
    └── test_harness.py                # Python harness mirroring contract math
```

## Key design decisions (locked in)

### Fee structure
1.00% total trade fee, three-way split:
- **0.40% creator** (40% of fee)
- **0.50% protocol** (50% of fee)
- **0.10% LP** (stays in curve reserve)

Compared to the incumbent Solana launchpad (1.25% total, 0.30% creator,
0.95% protocol, 0% LP): lower total, larger creator share both in absolute
terms and as a fraction of fees, and a slice goes back into liquidity.

Fees are paid and claimed in **SUI** (not the memecoin), matching the
incumbent's SOL-denominated model. Creators claim via `claim_creator_fees`,
protocol claims via `claim_protocol_fees` gated by an `AdminCap`.

### Graduation
Triggers when the curve sells out (`token_reserve == 0`). Curve is tuned
so drain happens at roughly 87.9k SUI of real reserves. At graduation:
- Remaining 20% of supply (200M tokens) is minted for the DEX pool
- 0.5% of the reserve goes to the creator as a graduation bonus
- Rest migrates into a Cetus/Turbos pool via PTB

### Token economics
- 1B total supply, 6 decimals
- 800M sold through the bonding curve
- 200M minted at graduation for LP seeding
- Virtual reserves: 30k SUI / 1.073B tokens

### Tail-clip mechanism
When a buy would purchase more tokens than remain, the contract clips at
`token_reserve`, reprices the swap cost in reverse, and refunds the excess
SUI. Prevents the curve from getting "stuck" with 1-token dust. `buy`
returns `(Coin<T>, Coin<SUI>)` — tokens + refund.

### AdminCap
Minted in `init()` and transferred to the deployer. Required for
`claim_protocol_fees`. Has `store` — transferable to a multisig, DAO, or
burnable to fully decentralize. Protocol fees claimed via this cap are
unrestricted SUI that can be spent however.

## Tests

Python harness (runnable without Sui toolchain):
```
cd tests
python3 test_harness.py
```

Expected output: **29 passed, 0 failed**. Covers:
- Fee split arithmetic including 1-MIST edge cases (rounding favors LP)
- Creator vs protocol earmarking (no cross-contamination)
- Authorization (only creator claims creator fees, only AdminCap claims protocol)
- Buy/sell conservation across 50 round-trips with zero leakage
- LP fee retention in reserve
- Price monotonicity and constant-product invariant
- Graduation at drain point (~87.9k SUI)
- Tail-clip refund conservation
- Post-graduation lockout (no buys, no sells, no re-graduation)

Move unit tests (`bonding_curve_tests.move`) cover the same ground against
the real Sui VM. Run with `sui move test` from the `contracts/` directory.

## Deployment plan

### Morning: toolchain + contract verification
1. `brew install sui` (or prebuilt binary on Windows)
2. `sui client` → pick testnet, generate wallet
3. `cd suipump/contracts && sui move build && sui move test`

If the Move tests pass, the contract is verified.

### Midday: local sandbox
4. `sui start --with-faucet --force-regenesis` (leave running)
5. `sui client new-env --alias local --rpc http://127.0.0.1:9000`
6. `sui client switch --env local && sui client faucet`
7. `sui client publish --gas-budget 200000000`
8. Save the **package ID** and **AdminCap object ID**

### Afternoon: wire the frontend
9. `npm install @mysten/sui @mysten/dapp-kit`
10. Replace the mock trading logic in `App.jsx` with real transaction
    construction using the package ID from step 8
11. Wire the CONNECT button to `@mysten/dapp-kit` wallet adapter
12. Test the full lifecycle: launch → buy → sell → graduate

### When ready: testnet
13. `sui client switch --env testnet && sui client faucet`
14. `sui client publish --gas-budget 200000000`

## Known gaps / follow-ups

1. **Cetus graduation PTB** — `graduate()` returns the three coins but
   doesn't compose the pool creation. Need a TypeScript PTB that calls
   `graduate` + Cetus `create_pool_with_liquidity` + `burn_lp` in one tx.

2. **Per-curve protocol fee claims don't scale.** At 10k curves, claiming
   fees requires 10k txs. Need an off-chain indexer that triggers claims
   only when a curve's balance crosses a threshold.

3. **`token_template.move` is a placeholder.** Real launches need the
   frontend to generate a fresh module per launch with unique OTW name,
   then publish as a new package.

4. **Regulatory review not done.** Taking discretionary fees from trading
   activity on tokens we help launch has live legal scrutiny in this
   category. Get a securities/CFTC lawyer to review before taking
   meaningful volume.

## Reference: final contract interface

```move
// Creation (called from token module's init)
create<T>(treasury: TreasuryCap<T>, name, symbol, creator, ctx)

// Trading — returns (tokens, refund). Refund is zero except on tail-clip.
buy<T>(curve, payment: Coin<SUI>, min_tokens_out, ctx) -> (Coin<T>, Coin<SUI>)
sell<T>(curve, tokens_in: Coin<T>, min_sui_out, ctx) -> Coin<SUI>

// Fee claims
claim_creator_fees<T>(curve, ctx) -> Coin<SUI>         // gated by creator == sender
claim_protocol_fees<T>(cap: &AdminCap, curve, ctx) -> Coin<SUI>

// Graduation — triggers when token_reserve == 0
graduate<T>(curve, ctx) -> (Coin<SUI>, Coin<T>, Coin<SUI>)
//                          ^ pool SUI   ^ 200M LP   ^ creator bonus
```
