# SuiPump frontend

React + Vite + @mysten/dapp-kit, wired to the testnet deployment.

## Setup

```
cd frontend-app
npm install
```

First install takes ~1-2 min. Installs React, Vite, Tailwind, and the Sui dApp Kit.

## Run

```
npm run dev
```

Opens at http://localhost:5173. The first load fetches the live curve state
from testnet, so you need an internet connection.

## Wallet

You need a Sui wallet browser extension installed:
- **Slush** (formerly Sui Wallet) — https://slush.app
- **Suiet** — https://suiet.app
- **Phantom** — supports Sui in recent versions

Set the wallet to **Testnet**, then click CONNECT in the top-right. The
ConnectButton handles account selection automatically.

## Build for deploy

```
npm run build
```

Outputs a static bundle into `dist/`. Host anywhere (Vercel, Netlify,
Cloudflare Pages — any static host works, no server needed).

## Deployment constants

Addresses are in `src/constants.js`. After each redeploy of the Move
package, update `PACKAGE_ID` and `CURVE_ID`.

Current (testnet):
- Package: `0xd4b4e909...f512f1`
- Example Curve: `0xc6528971...eab61`

## What works

- Live curve state (reserve, tokens remaining, accrued fees, price) via
  `useSuiClientQuery` with 5s refetch
- Real buy transactions — splits SUI off gas coin, calls `bonding_curve::buy`,
  receives tokens + refund back
- Real sell transactions — merges/splits your Coin<T> holdings, calls
  `bonding_curve::sell`
- Live quote preview mirroring exact contract arithmetic (including
  tail-clip refund estimation)
- 1% slippage floor on both sides
- Transaction status with suivision link

## What's deferred

- **Token launch UI** — each new launch requires publishing a fresh Move
  package with a unique OTW. Needs a separate flow that generates and
  publishes a new module per click. For now the frontend trades the
  existing Example Token only.
- **Graduation button** — once the curve drains, we need a button that
  calls `graduate()` + deposits into Cetus. Will add when the existing
  Example Token's curve actually fills.
- **Creator fee claim button** — trivial to add (one `moveCall` to
  `claim_creator_fees`). Hasn't been wired yet.
- **Indexer** — trade log, holder count, candlestick history require an
  off-chain indexer subscribing to events. Out of scope for this iteration.
