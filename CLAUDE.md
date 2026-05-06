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

## Current Deployment (ACTIVE — testnet)
```
Package ID:    0xf91acdd7456381110d6a15d380dfd99fc126e59ffbf7a818c118e53765fa54c5
AdminCap:      0xc48452ed7e3c0a7bd0fb3e66ba37f15ccb6a9d090a87f7b53a451e3716ddeb6d
UpgradeCap:    0xa8579ca672b3f619692a3a2d50fa26f39036efb90f0b62e8c58cd360fc3c46ab
Example Curve: 0xdd84ca597b0f6ecdddc3909465353c6786320b20a99416d92a6709f444e089fc
Wallet:        0x0be9a8f56ba3b07f295e0c7526e7f47ca3a146649b9d864d2eb47bf3acd90c55
```

**Note:** `/mnt/project/` contains an OLDER snapshot. The live, up-to-date code is on **GitHub at github.com/cacoandrade455/suipump**. Always treat GitHub as the source of truth when there's a discrepancy.

---

## Project Layout
```
C:\Users\User\Desktop\suipump\
├── contracts\
│   ├── Move.toml
│   ├── Published.toml
│   └── sources\
│       ├── bonding_curve.move       (core contract — 18/18 tests passing)
│       ├── bonding_curve_tests.move
│       └── token_template.move      (example token)
├── coin-template\
│   └── sources\
│       └── template.move            (compiled → template.mv in frontend-app\public\)
├── frontend-app\
│   ├── public\
│   │   └── template.mv              (compiled coin template bytecode for launch flow)
│   ├── src\
│   │   ├── App.jsx                  (BrowserRouter routes, homepage, header, hamburger)
│   │   ├── TokenPage.jsx            (token page, TradePanelContent, sticky mobile panel, graduation state)
│   │   ├── LaunchModal.jsx          (4-step: details→payouts→devbuy→launch)
│   │   ├── PriceChart.jsx           (PRICE/MCAP toggle, 1m/5m/15m/1h/6h/24h/ALL, bar/line toggle, hover crosshair, USD from Binance)
│   │   ├── HolderList.jsx           (top 10 holders from trade events)
│   │   ├── TradeHistory.jsx         (live buy/sell feed, last 30 trades)
│   │   ├── Comments.jsx             (on-chain comments via post_comment)
│   │   ├── AirdropPage.jsx          (/airdrop)
│   │   ├── WhitepaperPage.jsx       (/whitepaper)
│   │   ├── LeaderboardPage.jsx      (/leaderboard — top tokens + traders by volume)
│   │   ├── PortfolioPage.jsx        (/portfolio — any-address lookup, defaults to connected wallet)
│   │   ├── RoadmapPage.jsx          (/roadmap)
│   │   ├── S1AirdropCounter.jsx     (live S1 pool counter, display-only)
│   │   ├── useTokenList.js          (queries CurveCreated events, ONLY current PACKAGE_ID)
│   │   ├── useTokenStats.js         (enriches tokens: volume, trades, pctChange, recentTrades)
│   │   ├── constants.js             (PACKAGE_ID, curve constants — update after redeploy)
│   │   └── curve.js                 (bonding curve math, mirrors Move contract)
│   ├── index.html
│   ├── index.css                    (@import dapp-kit CSS, tailwind directives, Google Fonts)
│   ├── main.jsx                     (BrowserRouter wraps App — REQUIRED)
│   ├── vite.config.js               (optimizeDeps exclude move-bytecode-template, hash output)
│   ├── tailwind.config.js
│   ├── postcss.config.js
│   ├── vercel.json                  (SPA rewrite + cache headers)
│   ├── .env                         (VITE_WALLETCONNECT_PROJECT_ID — in .gitignore ✅)
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

## Contract Design (bonding_curve.move)

### Fee Structure
- **1% total trade fee**, split:
  - 40% creator → `curve.creator_fees` (claimed via CreatorCap)
  - 50% protocol → `curve.protocol_fees` (claimed via AdminCap)
  - 10% LP → stays in `curve.sui_reserve`
- **0.5% creator graduation bonus** — paid from final reserve at graduation
- **2 SUI launch fee** → protocol_fees on creation

### Token Economics
- Total supply: 1,000,000,000 (6 decimals)
- Curve supply: 800,000,000 tokens (sold via bonding curve)
- LP supply: 200,000,000 tokens (minted at graduation)
- Virtual reserves: Vs = 30,000 SUI / Vt = 1,073,000,000 tokens
- Graduation: `token_reserve == 0` (~87,912 SUI real reserve)

### Key Contract Functions
```move
create_and_return<T>(treasury, payment, name, symbol, payout_addresses, payout_bps, ctx) -> (Curve<T>, CreatorCap)
share_curve<T>(curve)
buy<T>(curve, payment: Coin<SUI>, min_tokens_out, ctx) -> (Coin<T>, Coin<SUI>)
sell<T>(curve, tokens_in: Coin<T>, min_sui_out, ctx) -> Coin<SUI>
claim_creator_fees<T>(cap: &CreatorCap, curve, ctx)
claim_protocol_fees<T>(cap: &AdminCap, curve, ctx) -> Coin<SUI>
update_payouts<T>(cap: &CreatorCap, curve, payout_addresses, payout_bps, ctx)
graduate<T>(curve, ctx) -> (Coin<SUI>, Coin<T>, Coin<SUI>)
post_comment(curve_id: ID, text: String, ctx)   // NOT generic, takes ID not &Curve<T>
```

### CreatorCap
- Transferable object — whoever holds it can claim fees and update payouts
- Up to 10 payout recipients, bps must sum to 10,000
- `cap.curve_id` must match the curve being operated on

---

## ⚠️ CRITICAL SDK PATTERNS — Never Deviate

### 1. Shared Object References — ALWAYS use sharedObjectRef
```js
const curveObj = await client.getObject({ id: curveId, options: { showOwner: true } });
const initialSharedVersion = curveObj.data?.owner?.Shared?.initial_shared_version;
const curveRef = tx.sharedObjectRef({
  objectId: curveId,
  initialSharedVersion,
  mutable: true,   // true for buy/sell/claim/graduate, false for read-only
});
```
**NEVER `tx.object(curveId)` for shared objects — causes TypeMismatch errors every time.**

### 2. post_comment — No typeArguments, tx.pure.address
```js
tx.moveCall({
  target: `${PACKAGE_ID}::bonding_curve::post_comment`,
  arguments: [
    tx.pure.address(curveId),   // curve_id is ID type — pure address, NOT sharedObjectRef
    tx.pure.string(text),
  ],
  // NO typeArguments — post_comment is NOT generic
});
```

### 3. Null Guards — REQUIRED in every fmt function
**Root cause of recurring production crash: `TypeError: Cannot read properties of undefined (reading 'toFixed')`**
Curve fields can be undefined when the RPC response is partial or the object hasn't fully loaded.

```js
function fmt(n, d = 2) {
  if (n == null) return '-';          // ← REQUIRED FIRST LINE in every fmt
  if (!Number.isFinite(n)) return '-';
  if (n >= 1e9) return (n / 1e9).toFixed(d) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(d) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(d) + 'k';
  if (n !== 0 && Math.abs(n) < 0.0001) return n.toExponential(2);
  return n.toFixed(d);
}
// Also required in curve.js:
export const mistToSui = (m) => (m == null ? 0 : Number(BigInt(m)) / 1e9);
export const tokenUnitsToWhole = (u) => (u == null ? 0 : Number(BigInt(u)) / 10 ** TOKEN_DECIMALS);
```
**Files that must have null guards:** App.jsx, TokenPage.jsx, HolderList.jsx, PortfolioPage.jsx, PriceChart.jsx (`fmtVal`), curve.js (`mistToSui`, `tokenUnitsToWhole`)

### 4. BrowserRouter — REQUIRED in main.jsx
```jsx
import { BrowserRouter } from 'react-router-dom';
// Wrap App:
<BrowserRouter>
  <App />
</BrowserRouter>
// App.jsx uses useNavigate, useLocation, Routes, Route — all require Router context
// This has been broken and fixed once — don't remove it again
```

### 5. vite.config.js — Required settings
```js
export default defineConfig({
  plugins: [react()],
  server: { port: 5173 },
  optimizeDeps: {
    exclude: ['@mysten/move-bytecode-template'],  // WASM package — MUST exclude
  },
  build: {
    rollupOptions: {
      output: {
        entryFileNames: 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash].[ext]',
      },
    },
  },
});
```

---

## Launch Flow (two-tx PTB)

```
Tx1: Publish patched coin module
  - Patch template.mv via @mysten/move-bytecode-template (WASM)
  - update_identifiers: TEMPLATE→SYMBOL, template→modulename
  - update_constants: TMPL→symbol, Template Coin→name, description, icon URL
  - publish module → TreasuryCap transferred to sender
  - Wait 3 seconds for indexing

Tx2: Configure curve
  - splitCoins(gas, [2 SUI launch fee])
  - create_and_return<NewType>(treasury, fee, name, symbol, payouts, bps)
  - Optional: buy(curve, devPayment, 0) for dev-buy
  - share_curve(curve)
  - transferObjects([cap], sender)

Orphan risk: if Tx2 fails after Tx1, TreasuryCap stays in wallet.
LaunchModal has retry button but no auto-detection of orphaned TreasuryCap on page load.
```

---

## Frontend Design System

### Colors
```
Background:      #080808
Card bg:         bg-white/[0.03]
Card border:     border-white/10
Accent/lime:     #84cc16  (lime-400) — buttons, highlights, labels
Accent hover:    #bef264  (lime-300)
Text primary:    white
Text body:       text-white/50 to text-white/60
Text labels:     text-white/30
Graduation:      emerald-400 ONLY
Sell/danger:     red-400 ONLY
NO amber/yellow/orange anywhere
```

### Typography
```
Body font:    JetBrains Mono (Google Fonts)
Heading font: Space Grotesk (Google Fonts)
@import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;700&family=Space+Grotesk:wght@700&display=swap');
```

### Border Radius
- Cards: `rounded-2xl`, Hero: `rounded-3xl`, Inputs: `rounded-xl`

### Loading States
- Skeleton cards: `animate-pulse` with `bg-white/5` placeholder divs

---

## Routing (react-router-dom v7)
```
/                    → HomePage
/token/:curveId      → TokenPageWrapper → TokenPage
/airdrop             → AirdropPage
/whitepaper          → WhitepaperPage
/leaderboard         → LeaderboardPage
/portfolio           → PortfolioPage (any-address lookup)
/roadmap             → RoadmapPage
```
- vercel.json SPA rewrite: `{ "source": "/(.*)", "destination": "/index.html" }`
- vercel.json cache: no-cache for HTML, immutable for hashed assets

---

## Homepage Features
- Token grid from CurveCreated events (15s poll)
- Sort: NEWEST / OLDEST / VOLUME / TRADES / RESERVE / PROGRESS / TRENDING (by recentTrades in last 60 min)
- Search by name, symbol, or curve ID (full 0x address)
- % change badges via useTokenStats.js (`pctChange = ((latest - first) / first) * 100`)
- Skeleton loading cards
- Stats bar: tokens count, trades, volume, S1 pool

## Token Page Features
- Live curve state (5s poll via useSuiClientQuery)
- Price chart — candles/line toggle, PRICE/MCAP toggle, 1m/5m/15m/1h/6h/24h/ALL intervals
- USD price from Binance: `https://api.binance.com/api/v3/ticker/price?symbol=SUIUSDT`
- Trade history (last 30 trades via TradeHistory.jsx)
- Top 10 holders (computed from trade events via HolderList.jsx)
- On-chain comments (via Comments.jsx)
- Creator fee claim button (only shown if wallet holds matching CreatorCap)
- Mobile sticky bottom trade panel (TradePanelContent component)
- Graduated tokens: show Cetus trade link instead of buy/sell panel + graduation data

---

## Mobile Layout
- Header: hamburger (`Menu`/`X` from lucide-react), all nav links hidden (`sm:hidden`) on mobile
- Token page `TradePanelContent` rendered TWICE:
  - Desktop: `hidden lg:block` sticky sidebar
  - Mobile: `lg:hidden fixed bottom-0 left-0 right-0 z-50`
- Mobile wallet deep links: Phantom + Slush in hamburger menu dropdown
- WalletConnect: `VITE_WALLETCONNECT_PROJECT_ID` env var (cloud.walletconnect.com for free ID)

---

## Key Constants (update after every redeploy)
```js
// frontend-app/src/constants.js AND scripts/config.js
PACKAGE_ID        = '0xf91acdd7...'
CURVE_ID          = '0xdd84ca5...'  (example curve)
TOKEN_TYPE        = `${PACKAGE_ID}::token_template::TOKEN_TEMPLATE`
TRADE_FEE_BPS     = 100
CREATOR_SHARE_BPS = 4000
PROTOCOL_SHARE_BPS= 5000
LP_SHARE_BPS      = 1000
CURVE_SUPPLY      = 800_000_000
VIRTUAL_SUI       = 30_000
VIRTUAL_TOKENS    = 1_073_000_000
DRAIN_SUI_APPROX  = 87_912
TOKEN_DECIMALS    = 6
MIST_PER_SUI      = 1_000_000_000
```

---

## Deploy Flow
```bash
# Frontend deploy (auto-deploys to Vercel on push)
cd C:\Users\User\Desktop\suipump
git add . && git commit -m "feat: description" && git push

# Contract redeploy
cd C:\Users\User\Desktop\suipump\contracts
# 1. Delete Published.toml
# 2. sui client publish --gas-budget 500000000
# 3. Update PACKAGE_ID in frontend-app\src\constants.js
# 4. Update PACKAGE_ID and ADMIN_CAP_ID in scripts\config.js
# 5. Update object IDs in CLAUDE.md and HANDOFF.md

# Admin fee claim
cd C:\Users\User\Desktop\suipump\scripts
node claim_fees.js
```

---

## Known Issues / Technical Debt
1. **queryEvents capped at 100** — silently drops trades on busy curves. Leaderboard, holder list, chart miss events. Fix: paginate with cursor.
2. **WalletConnect Project ID** — not yet in Vercel env vars. Get free ID at cloud.walletconnect.com → add to Vercel Settings → Environment Variables as `VITE_WALLETCONNECT_PROJECT_ID`.
3. **Orphaned TreasuryCap** — if Tx2 fails after Tx1 in launch flow, TreasuryCap stays in wallet. LaunchModal shows retry button but no auto-detection on page load.
4. **Safari iOS caching** — aggressive cache on Vercel. vercel.json cache headers partially fix it. Manual fix: Settings → Safari → Website Data → Remove suipump.vercel.app.

---

## Blocked Items
- **Cetus graduation PTB** — Cetus testnet has no working Move dependency (`PublishUpgradeMissingDependency`). Deferred to mainnet. When ready: call `graduate<T>()` → returns (pool_sui, lp_tokens, creator_bonus) → compose Cetus `create_pool_with_liquidity` in same PTB.
- **Cetus incubator** — active, core team reviewing. Bigwils confirmed interest.

---

## Pre-Mainnet Checklist (in order)
1. ☐ Security audit — OtterSec / Movebit / Zellic (~$20-25k) — **HARD GATE**
2. ☐ AdminCap → multisig wallet
3. ☐ WalletConnect Project ID → Vercel env vars
4. ☐ queryEvents pagination fix (cursor)
5. ☐ Cetus graduation PTB
6. ☐ Off-chain indexer (defer until real volume)

---

## Key Decisions (DO NOT REVISIT)
- **Dev-buy uncapped** — rug risk accepted, incumbent parity
- **On-chain comments event-based only** — no stored state, no moderation liability; `post_comment(ID, String)` — not generic, no sharedObjectRef
- **Auto-graduation deferred to mainnet** — Cetus testnet dep broken
- **Old v2 tokens excluded from homepage** — break with v3 SDK
- **useTokenList.js queries ONLY current PACKAGE_ID**
- **All buy/sell/claim use sharedObjectRef** — never `tx.object()` for shared objects
- **Color scheme: black/lime/white ONLY** — no exceptions
- **No burn, only airdrops** — $SUMP token is Season 2+
- **Image upload via Imgur anonymous API** — Client-ID: 546c25a59c58ad7
- **First airdrop paid in SUI** — no new token

---

## Fundraising

### Active Round
- **Raise:** $1,500,000 seed
- **Pre-money:** $7,500,000
- **Post-money:** $9,000,000
- **Equity:** 16.7%
- **$SUMP warrants:** 10% at Season 2 launch
- **Use of funds:** Audit ($25k) + engineering + marketing + ops

### Pitch Decks (keep both, use 1.5M for seed outreach)
- `SuiPump_Deck_500K_v2.pdf/pptx` — Pre-Seed $500K, 14 slides (backup)
- `SuiPump_Deck_1500K_v2.pdf/pptx` — Seed $1.5M, 14 slides ← USE THIS
- TODO: 16-slide version (merge WhySui_Slide_1500K.pptx as slide 9)

### VC Outreach Status
| VC | Contact | Status |
|---|---|---|
| Comma3 Ventures | DM @Ivantok4 on X | Sent |
| SevenX Ventures | DM @Louissongyz / @jonbit3 on X | Sent |
| HashKey Capital | enquiries@hashkey.com | Sent |
| OKX Ventures | ventures@okx.com | Sent |
| Animoca Ventures | arche.fund/contact + @ysiu DM | Sent |
| Electric Capital | info@electriccapital.com | Sent |
| YZi Labs (Binance) | Direct Investment form | Applied |
| DWF Labs | contact@dwf-labs.com + form | Sent |
| Coinbase Ventures | ventures.coinbase.com | Applied |
| Arche Fund / Ninety Eight | Typeform submitted (x2) | Applied |
| Spartan Group | Contact form + DM @leeorgroen | Sent |
| KuCoin Ventures | ventures@kucoin.com | Sent |
| Gate Ventures | ventures@gate.com | Sent |
| Pantera Capital | panteracapital.com/contact | Sent |
| OpenVC | openvc.app | Sent — hits 500+ VCs |
| Cetus Incubator | hello@cetus.zone | Active |
| Sui DeFi Moonshots | Submitted + follow-up | In progress |
| Sui Hydroflow | Submitted | In progress |
| Sui Developer Grants | Submitted | In progress |

### Cetus Email Sent
- To: hello@cetus.zone
- Asks: (1) Graduation PTB guidance, (2) Incubator funding for audit

---

## Tokens Launched on Testnet
| Token | Symbol | Package | Curve |
|---|---|---|---|
| Example Token | $EXMPL | v3 (current) | 0xdd84ca5... |
| Moon Coin | $MOON | 0xfc5f2eb... | 0x160f597... |
| Nenem | $NENEM | v3 | — |
| Love Token | $LOVE (<3) | v3 | — |
*Old tokens (MOON, NENEM, LOVE) are on old packages and excluded from homepage — they break with v3 SDK sharedObjectRef pattern.*

---

## Founder
- **Name:** Carlos Andrade
- **Background:** Self-taught CS, B.A. Political Science & International Relations (IPE focus), M.A. International Relations (in progress)
- **Built:** SuiPump end-to-end solo — Move contracts, frontend, scripts, tooling
- **Location:** Salvador, Brazil (UTC-3)
- **X:** @suipump_sump
- **GitHub:** github.com/cacoandrade455
