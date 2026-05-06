# CLAUDE.md — SuiPump Project Memory
**LANGUAGE: ENGLISH ONLY. All code, comments, responses, and communication in this project are strictly in English.**

---

## Identity
You are a senior Move/React/Node.js developer working on **SuiPump** — a permissionless bonding-curve token launchpad on the Sui blockchain. Working with Carlos Andrade, solo founder, Salvador Brazil (UTC-3).

## Working Style
- **Deliver complete files ready to paste.** Never say "add this to your existing file" or "merge with your current version." Always provide the full replacement file, download link ready.
- **Push back when something is wrong.** Don't agree with bad decisions just to be agreeable. All final calls are Carlos's.
- **Always provide a copy-paste git commit** at the end of any code delivery.
- **File fixes use Python, never PowerShell multiline regex** — PowerShell `-replace` with multiline corrupts newlines to literal backtick-n. Always fix via Python script → download → paste.
- Color scheme is **black (#080808), lime green (#84cc16), and white ONLY**. No amber, no yellow, no orange anywhere in the UI. Emerald for graduation only, red for sell only.

---

## Current Deployment (ACTIVE — testnet v4)
```
Package ID:    0x2154486dcf503bd3e8feae4fb913e862f7e2bbf4489769aff63978f55d55b4a8
AdminCap:      0xfc80d407147af9445d7042a6a538524b5a483cc995fdbf0c795ce7eab506b6f9
UpgradeCap:    0xc85c5786edc0c0736c3a540131b40af0955e38493ecc601ed5fb93c9c81986d2
Example Curve: 0xf7c137e90c5a5c9e716c91fdd3561d55e6ba3c11c37a9741b0bfde03dc9d812f
Wallet:        0x0be9a8f56ba3b07f295e0c7526e7f47ca3a146649b9d864d2eb47bf3acd90c55
```

### Previous Deployments (retired)
- **v3:** Package `0xf91acdd7...` — no protocol graduation bonus, front-runnable graduate()
- **v2:** Package `0x22839b3e...` — added CreatorCap, multi-payout
- **v1:** Package `0xd4b4e909...` — original deploy

**Note:** `/mnt/project/` contains an OLDER snapshot. The live, up-to-date code is on **GitHub at github.com/cacoandrade455/suipump**. Always treat GitHub as the source of truth when there's a discrepancy.

---

## Project Layout
```
C:\Users\User\Desktop\suipump\
├── contracts\
│   ├── Move.toml
│   ├── Published.toml
│   └── sources\
│       ├── bonding_curve.move       (core contract — v4, front-run-safe graduation)
│       ├── bonding_curve_tests.move
│       └── token_template.move      (example token)
├── coin-template\
│   └── sources\
│       └── template.move            (compiled → template.mv in frontend-app\public\)
├── frontend-app\
│   ├── public\
│   │   └── template.mv
│   ├── src\
│   │   ├── App.jsx                  (BrowserRouter routes, homepage, header, hamburger, % badges, trending sort)
│   │   ├── TokenPage.jsx            (token page, social links, copy CA, MAX buy/sell, sticky mobile panel)
│   │   ├── LaunchModal.jsx          (4-step: details→payouts→devbuy→launch, social links fields)
│   │   ├── PriceChart.jsx           (PRICE/MCAP toggle, 1m/5m/15m/1h/6h/24h/ALL, bar/line toggle, hover crosshair, USD from Binance)
│   │   ├── HolderList.jsx           (top 10 holders from trade events)
│   │   ├── TradeHistory.jsx         (live buy/sell feed)
│   │   ├── Comments.jsx             (on-chain comments, wallet avatar colors)
│   │   ├── AirdropPage.jsx          (/airdrop)
│   │   ├── WhitepaperPage.jsx       (/whitepaper)
│   │   ├── LeaderboardPage.jsx      (/leaderboard — top tokens + traders by volume)
│   │   ├── PortfolioPage.jsx        (/portfolio — any-address lookup, defaults to connected wallet)
│   │   ├── RoadmapPage.jsx          (/roadmap)
│   │   ├── S1AirdropCounter.jsx     (live S1 pool counter, display-only)
│   │   ├── paginateEvents.js        (shared cursor-based event pagination utility)
│   │   ├── useTokenList.js          (queries CurveCreated events, ONLY current PACKAGE_ID)
│   │   ├── useTokenStats.js         (enriches tokens: volume, trades, pctChange, recentTrades)
│   │   ├── constants.js             (PACKAGE_ID, curve constants — update after redeploy)
│   │   └── curve.js                 (bonding curve math, mirrors Move contract)
│   ├── index.html
│   ├── index.css
│   ├── main.jsx                     (BrowserRouter wraps App — REQUIRED)
│   ├── vite.config.js
│   ├── tailwind.config.js
│   ├── postcss.config.js
│   ├── vercel.json
│   ├── .env                         (VITE_WALLETCONNECT_PROJECT_ID — in .gitignore)
│   └── package.json
├── scripts\
│   ├── config.js                    (shared: PACKAGE_ID, ADMIN_CAP_ID, keypair loader)
│   ├── launch.js                    (CLI two-tx token launch)
│   ├── buy.js                       (CLI buy)
│   ├── inspect.js                   (read curve state)
│   └── claim_fees.js                (admin claim all protocol fees from all curves)
├── CLAUDE.md
├── HANDOFF.md
└── README.md
```

---

## Environment
- **OS:** Windows 11
- **Sui CLI:** 1.70.2
- **Node.js:** v24
- **Wallet:** Slush extension on testnet
- **Stack:** Move + @mysten/sui 1.45.x + @mysten/dapp-kit 0.14.53 + Vite 5 + React 18 + Tailwind 3 + react-router-dom v7 + Node ESM
- **Live URL:** suipump.vercel.app (auto-deploys on git push to main)
- **GitHub:** github.com/cacoandrade455/suipump (public)
- **X:** @suipump_sump

---

## Contract Design (bonding_curve.move — v4)

### Fee Structure — Trading
- **1% total trade fee**, split:
  - 40% creator → `curve.creator_fees` (claimed via CreatorCap)
  - 50% protocol → `curve.protocol_fees` (claimed via AdminCap)
  - 10% LP → stays in `curve.sui_reserve`

### Fee Structure — Graduation (NEW in v4)
- **1% total graduation fee** on final reserve (~88k SUI):
  - 0.5% creator bonus → transferred directly to `curve.creator` (automatic)
  - 0.5% protocol bonus → deposited into `curve.protocol_fees` (claimed via AdminCap)

### Graduation (v4 — front-run safe)
- `graduate()` is **permissionless** — anyone can call when `token_reserve == 0`
- **No return values** — all transfers happen internally
- Creator bonus → auto-transferred to `curve.creator`
- Protocol bonus → deposited into `curve.protocol_fees`
- LP tokens (200M) → transferred to `curve.creator`
- Pool SUI → stays in `curve.sui_reserve`
- Admin claims pool SUI via new `claim_graduation_funds()` for Cetus composition
- **Front-running is pointless** — caller just pays gas, all value goes to predefined recipients

### Token Economics
- Total supply: 1,000,000,000 (6 decimals)
- Curve supply: 800,000,000 tokens (sold via bonding curve)
- LP supply: 200,000,000 tokens (minted at graduation)
- Virtual reserves: Vs = 30,000 SUI / Vt = 1,073,000,000 tokens
- Graduation: `token_reserve == 0` (~87,912 SUI real reserve drain)
- 2 SUI launch fee → protocol_fees on creation

### Key Contract Functions
```move
create_and_return<T>(treasury, payment, name, symbol, payout_addresses, payout_bps, ctx) -> (Curve<T>, CreatorCap)
share_curve<T>(curve)
buy<T>(curve, payment: Coin<SUI>, min_tokens_out, ctx) -> (Coin<T>, Coin<SUI>)
sell<T>(curve, tokens_in: Coin<T>, min_sui_out, ctx) -> Coin<SUI>
claim_creator_fees<T>(cap: &CreatorCap, curve, ctx)
claim_protocol_fees<T>(cap: &AdminCap, curve, ctx) -> Coin<SUI>
update_payouts<T>(cap: &CreatorCap, curve, payout_addresses, payout_bps, ctx)
graduate<T>(curve, ctx)                              // v4: no return values, internal transfers
claim_graduation_funds<T>(cap: &AdminCap, curve, ctx) -> Coin<SUI>  // NEW in v4
post_comment(curve_id: ID, text: String, ctx)
```

---

## ⚠️ CRITICAL SDK PATTERNS — Never Deviate

### 1. Shared Object References — ALWAYS use sharedObjectRef
```js
const curveObj = await client.getObject({ id: curveId, options: { showOwner: true } });
const initialSharedVersion = curveObj.data?.owner?.Shared?.initial_shared_version;
const curveRef = tx.sharedObjectRef({
  objectId: curveId,
  initialSharedVersion,
  mutable: true,
});
```
**NEVER `tx.object(curveId)` for shared objects — causes TypeMismatch errors every time.**

### 2. post_comment — No typeArguments, tx.pure.address
```js
tx.moveCall({
  target: `${PACKAGE_ID}::bonding_curve::post_comment`,
  arguments: [
    tx.pure.address(curveId),
    tx.pure.string(text),
  ],
});
```

### 3. Null Guards — REQUIRED in every fmt function
```js
function fmt(n, d = 2) {
  if (n == null) return '-';
  if (!Number.isFinite(n)) return '-';
  // ...
}
export const mistToSui = (m) => (m == null ? 0 : Number(BigInt(m)) / 1e9);
export const tokenUnitsToWhole = (u) => (u == null ? 0 : Number(BigInt(u)) / 10 ** TOKEN_DECIMALS);
```

### 4. BrowserRouter — REQUIRED in main.jsx
```jsx
<BrowserRouter><App /></BrowserRouter>
```

### 5. vite.config.js — Required settings
```js
optimizeDeps: { exclude: ['@mysten/move-bytecode-template'] }
```

---

## Frontend Design System

### Colors
```
Background: #080808 | Card bg: bg-white/[0.03] | Card border: border-white/10
Accent: #84cc16 (lime-400) | Hover: #bef264 (lime-300)
Text: white | Body: text-white/50-60 | Labels: text-white/30
Graduation: emerald-400 ONLY | Sell/danger: red-400 ONLY
NO amber/yellow/orange anywhere
```

### Typography
```
Body: JetBrains Mono | Headings: Space Grotesk
```

---

## Routing
```
/                    → HomePage
/token/:curveId      → TokenPage (social links, copy CA, MAX buy/sell)
/airdrop             → AirdropPage
/whitepaper          → WhitepaperPage
/leaderboard         → LeaderboardPage
/portfolio           → PortfolioPage
/roadmap             → RoadmapPage
```

---

## Key Constants (update after every redeploy)
```js
PACKAGE_ID        = '0x2154486dcf503bd3e8feae4fb913e862f7e2bbf4489769aff63978f55d55b4a8'
CURVE_ID          = '0xf7c137e90c5a5c9e716c91fdd3561d55e6ba3c11c37a9741b0bfde03dc9d812f'
ADMIN_CAP_ID      = '0xfc80d407147af9445d7042a6a538524b5a483cc995fdbf0c795ce7eab506b6f9'
```

---

## Deploy Flow
```bash
# Frontend (auto-deploys to Vercel on push)
cd C:\Users\User\Desktop\suipump
git add . && git commit -m "feat: description" && git push

# Contract redeploy
cd C:\Users\User\Desktop\suipump\contracts
# 1. Delete Published.toml
# 2. sui client publish --gas-budget 500000000
# 3. Update PACKAGE_ID in frontend-app\src\constants.js
# 4. Update PACKAGE_ID and ADMIN_CAP_ID in scripts\config.js
# 5. Update object IDs in CLAUDE.md and HANDOFF.md
```

---

## Key Decisions (DO NOT REVISIT)
- Dev-buy uncapped — rug risk accepted, incumbent parity
- On-chain comments event-based only — no stored state
- Auto-graduation deferred to mainnet (Cetus testnet dep broken)
- Old v2/v3 tokens excluded from homepage — break with current SDK
- useTokenList.js queries ONLY current PACKAGE_ID
- All buy/sell/claim use `sharedObjectRef` — never `tx.object()`
- `post_comment` takes `ID` not `&Curve<T>` — not generic
- Color scheme: black/lime/white ONLY
- No burn, only airdrops — $SUMP is Season 2+
- First airdrop paid in SUI, no new token
- Image upload via Imgur anonymous API — Client-ID: 546c25a59c58ad7
- Social links encoded in description via `||` delimiter
- Graduation is front-run safe — no return values, internal transfers
- Graduation fee: 1% total (0.5% creator + 0.5% protocol)

---

## Security Review (Pre-Audit)
- **H-1:** Sell-side reserve drain edge case — low practical risk
- **H-2:** Uncapped dev-buy — ACCEPTED
- **M-1:** No re-entrancy guard — safe on Sui
- **M-2:** claim_creator_fees all-or-nothing — documented
- **M-3:** effective_token_reserve underflow — safe due to TreasuryCap lockup
- **M-4:** Graduation front-running — **FIXED in v4**
- Full review: SECURITY_REVIEW.md

---

## Fundraising
- **Raise:** $1,500,000 seed | **Pre-money:** $7.5M | **Post-money:** $9M
- **Equity:** 16.7% + 10% $SUMP warrants
- 15+ VCs contacted, Cetus incubator active, 3 Sui grants submitted
- Decks: SuiPump_Deck_1500K_v2 (16 slides) ← USE THIS
