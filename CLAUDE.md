# CLAUDE.md — SuiPump Project Memory

## Identity
You are a senior Move/React/Node.js developer working on **SuiPump** — a permissionless bonding-curve token launchpad on the Sui blockchain. You are working with Carlos Andrade, the solo founder.

## Working Style
- Deliver files **completely written and ready to paste** into the specified folder path. Never say "add this to your existing file" or "merge with your current version" — always provide the full replacement file.
- Push back when something is wrong. Don't agree with bad decisions.
- All final calls are Carlos's.
- Color scheme is **black (#080808), lime green (#84cc16), and white ONLY**. No amber, no yellow, no orange anywhere.

## Current Deployment (ACTIVE)
```
Package ID:    0xf91acdd7456381110d6a15d380dfd99fc126e59ffbf7a818c118e53765fa54c5
AdminCap:      0xc48452ed7e3c0a7bd0fb3e66ba37f15ccb6a9d090a87f7b53a451e3716ddeb6d
UpgradeCap:    0xa8579ca672b3f619692a3a2d50fa26f39036efb90f0b62e8c58cd360fc3c46ab
Example Curve: 0xdd84ca597b0f6ecdddc3909465353c6786320b20a99416d92a6709f444e089fc
Wallet:        0x0be9a8f56ba3b07f295e0c7526e7f47ca3a146649b9d864d2eb47bf3acd90c55
```

## Project Layout
```
C:\Users\User\Desktop\suipump\
├── contracts\sources\        (bonding_curve.move, bonding_curve_tests.move, token_template.move)
├── coin-template\sources\    (template.mv in frontend-app\public\)
├── frontend-app\src\
│   ├── App.jsx               (router, homepage, header with hamburger menu)
│   ├── TokenPage.jsx          (token page, TradePanelContent component, sticky mobile trade panel)
│   ├── LaunchModal.jsx        (4-step launch flow with live preview)
│   ├── PriceChart.jsx         (PRICE/MCAP toggle, all intervals)
│   ├── HolderList.jsx         (top 10 holders)
│   ├── TradeHistory.jsx       (live buy/sell feed with wallet addresses)
│   ├── Comments.jsx           (on-chain comments via post_comment)
│   ├── AirdropPage.jsx        (/airdrop)
│   ├── WhitepaperPage.jsx     (/whitepaper)
│   ├── LeaderboardPage.jsx    (/leaderboard)
│   ├── PortfolioPage.jsx      (/portfolio)
│   ├── RoadmapPage.jsx        (/roadmap)
│   ├── S1AirdropCounter.jsx
│   ├── useTokenList.js        (queries ONLY current PACKAGE_ID)
│   ├── useTokenStats.js       (enriches tokens with volume/trades for sorting)
│   ├── constants.js           (package ID, curve constants)
│   └── curve.js               (bonding curve math)
├── scripts\                   (config.js, launch.js, buy.js, inspect.js, claim_fees.js)
├── vite.config.js
├── vercel.json                (SPA routing)
└── package.json
```

## Environment
- Windows 11, Sui CLI 1.70.2, Node.js v24
- Slush wallet extension on testnet
- Stack: Move + @mysten/sui 1.24 + @mysten/dapp-kit + Vite/React + Node ESM
- Live: suipump.vercel.app (auto-deploys on git push)
- GitHub: github.com/cacoandrade455/suipump

## Contract Design
- 1% total fee: 40% creator / 50% protocol / 10% LP-in-reserve
- 0.5% creator graduation bonus
- Graduation: `token_reserve == 0` (~87.9k SUI drain)
- Virtual reserves: Vs=30,000 SUI / Vt=1,073,000,000 tokens
- Supply: 1B total (800M curve + 200M LP at graduation), 6 decimals
- 2 SUI launch fee → protocol_fees
- CreatorCap: transferable, up to 10 payout recipients
- post_comment: takes `curve_id: ID` (NOT `&Curve<T>`), emits `Comment` event, 280 char max
- Dev-buy: uncapped (rug risk accepted)
- 18/18 Move unit tests passing

## Critical SDK Patterns

### Shared Object References — ALWAYS use sharedObjectRef for curves
```js
const curveObj = await client.getObject({ id: curveId, options: { showOwner: true } });
const initialSharedVersion = curveObj.data?.owner?.Shared?.initial_shared_version;
const curveRef = tx.sharedObjectRef({
  objectId: curveId,
  initialSharedVersion,
  mutable: true,  // true for buy/sell/claim, false for read-only
});
```
**NEVER use `tx.object(curveId)` for shared objects — causes TypeMismatch errors.**

### post_comment — no typeArguments, pure address
```js
tx.moveCall({
  target: `${PACKAGE_ID}::bonding_curve::post_comment`,
  arguments: [
    tx.pure.address(curveId),  // NOT tx.object(), NOT sharedObjectRef
    tx.pure.string(text),
  ],
  // NO typeArguments — function is not generic
});
```

## Frontend Design System
- Background: `#080808`, Cards: `bg-white/[0.03]`, Borders: `border-white/10`
- Accent: `#84cc16` (lime) — highlights, labels, buttons ONLY
- Text: white headings, `white/50-60` body, `white/30` labels
- All cards: `rounded-2xl`, hero: `rounded-3xl`, inputs: `rounded-xl`
- Fonts: JetBrains Mono (body), Space Grotesk (headings)
- Loading: `animate-pulse` skeleton cards
- **NO amber, NO yellow, NO orange** — emerald for graduation only, red for sell only

## Mobile Layout
- Header: hamburger menu (`Menu`/`X` from lucide-react) hides all nav links on `sm:hidden`
- Token page: `TradePanelContent` component rendered in two places:
  - Desktop: `hidden lg:block` sticky sidebar
  - Mobile: `lg:hidden fixed bottom-0 left-0 right-0 z-50` sticky bottom panel
- Reduced padding: `p-4` instead of `p-5` on mobile cards
- Creator address: `truncate` class instead of `break-all`

## Known Mobile/Vercel Issue
Safari on iOS aggressively caches Vercel-deployed assets. After pushing new code, mobile may serve stale content. Fixes needed:
1. `vercel.json` — add `Cache-Control: no-cache` for HTML, `immutable` for hashed assets
2. `vite.config.js` — ensure `rollupOptions.output` uses `[hash]` in filenames
3. Manual: Settings → Safari → Website Data → Remove suipump.vercel.app

## Deploy Flow
```bash
# Frontend only
cd C:\Users\User\Desktop\suipump
git add . && git commit -m "msg" && git push

# Contract redeploy (clear Published.toml first)
cd C:\Users\User\Desktop\suipump\contracts
sui client publish --gas-budget 500000000
# Update PACKAGE_ID in constants.js AND config.js
```

## Key Decisions (DO NOT REVISIT)
- Dev-buy uncapped — accepted
- On-chain comments are event-based only, no stored state
- Auto-graduation deferred to mainnet (Cetus testnet dependency broken — `PublishUpgradeMissingDependency`)
- Old tokens (v2) excluded from homepage — they break with v3 SDK
- useTokenList.js queries ONLY current PACKAGE_ID
- All buy/sell/claim use `sharedObjectRef` — never `tx.object()`
- `post_comment` takes `ID` not `&Curve<T>`
- Color scheme: black/lime/white ONLY

## Blocked Items
- v3 auto-graduation: Cetus testnet has no working Move dependency. `testnet-v0.0.1` compiles but `IntegerMate`/`MoveSTL` not registered on testnet. Deferred to mainnet post-audit.
- Cetus incubator: Bigwils confirmed interest, core team reviewing. Rishab-$CETUS confirmed "cetus has passed testnet."

## Grants Status
| Grant | Status |
|---|---|
| Sui DeFi Moonshots | Submitted, follow-up sent |
| Sui Hydroflow Accelerator | Submitted |
| Cetus Incubator | Active — core team reviewing |
| Sui Developer Grants | Submitted |
| CryptoFunding.vc | Application drafted |
| Mysten Labs alumni | Outreach sent |

## Fundraising
Two pitch decks exist (PDF + PPTX):
- **500K deck**: Pre-Seed, $2.5M pre-money, $3M post, 16.7% equity, 10% $SUMP warrants
- **1.5M deck**: Seed, $7.5M pre-money, $9M post, 16.7% equity, 10% $SUMP warrants
- Investor Brief (docx): TAM/SAM/SOM, comparable raises (Pump.fun, Virtuals, Four.meme), valuations, founder bio

## Founder
Carlos Andrade — self-taught CS, B.A. Political Science & International Relations (IPE focus), M.A. International Relations (in progress). Built SuiPump end-to-end solo.
