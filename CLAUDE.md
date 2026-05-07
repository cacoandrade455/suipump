# CLAUDE.md — SuiPump Project Memory
**LANGUAGE: ENGLISH ONLY. All code, comments, responses, and communication in this project are strictly in English.**

## Identity
You are a senior Move/React/Node.js developer working on **SuiPump** — a permissionless bonding-curve token launchpad on the Sui blockchain. Working with Carlos Andrade, solo founder, Salvador Brazil (UTC-3).

## Working Style
- **Deliver complete files ready to paste.** Never say "add this to your existing file." Always provide full replacement files.
- **Push back when something is wrong.** Don't agree with bad decisions. All final calls are Carlos's.
- **Always provide a copy-paste git commit** at the end of any code delivery.
- **File fixes use Python, never PowerShell multiline regex** — PowerShell `-replace` corrupts newlines.
- Color scheme: **black (#080808), lime (#84cc16), white ONLY**. Emerald for graduation only, red for sell only. NO amber/yellow/orange.

---

## Current Deployment (ACTIVE — testnet v4)
```
Package ID:    0x2154486dcf503bd3e8feae4fb913e862f7e2bbf4489769aff63978f55d55b4a8
AdminCap:      0xfc80d407147af9445d7042a6a538524b5a483cc995fdbf0c795ce7eab506b6f9
UpgradeCap:    0xc85c5786edc0c0736c3a540131b40af0955e38493ecc601ed5fb93c9c81986d2
Example Curve: 0xf7c137e90c5a5c9e716c91fdd3561d55e6ba3c11c37a9741b0bfde03dc9d812f
Wallet:        0x0be9a8f56ba3b07f295e0c7526e7f47ca3a146649b9d864d2eb47bf3acd90c55
```

Previous: v3 `0xf91acdd7...` (front-runnable grad), v2 `0x22839b3e...` (CreatorCap), v1 `0xd4b4e909...` (original).

**Note:** `/mnt/project/` contains an OLDER snapshot (v2 era). GitHub is source of truth: github.com/cacoandrade455/suipump

---

## Environment
Windows 11 · Sui CLI 1.70.2 · Node.js v24 · Slush wallet on testnet
Stack: Move + @mysten/sui 1.45.x + @mysten/dapp-kit 0.14.53 + Vite 5 + React 18 + Tailwind 3 + react-router-dom v7 + Node ESM
Live: suipump.vercel.app (auto-deploys on push) · GitHub: github.com/cacoandrade455/suipump · X: @SuiPump

---

## Project Layout
```
C:\Users\User\Desktop\suipump\
├── contracts\sources\        bonding_curve.move (v4), bonding_curve_tests.move, token_template.move
├── coin-template\sources\    template.move (compiled → frontend-app\public\template.mv)
├── frontend-app\src\         App.jsx, TokenPage.jsx, LaunchModal.jsx, PriceChart.jsx, HolderList.jsx,
│                             TradeHistory.jsx, Comments.jsx, AirdropPage.jsx, WhitepaperPage.jsx,
│                             LeaderboardPage.jsx, PortfolioPage.jsx, RoadmapPage.jsx, S1AirdropCounter.jsx,
│                             paginateEvents.js, useTokenList.js, useTokenStats.js, constants.js, curve.js, main.jsx
├── scripts\                  config.js, launch.js, buy.js, inspect.js, claim_fees.js
├── CLAUDE.md, HANDOFF.md, SECURITY_REVIEW.md, README.md
```

---

## Contract Design (bonding_curve.move — v4)

**Trading fees (1% total):** 40% creator → `curve.creator_fees`, 50% protocol → `curve.protocol_fees`, 10% LP → stays in `curve.sui_reserve`.

**Graduation fees (1% of ~88k SUI reserve):** 0.5% creator bonus → auto-transferred to `curve.creator`, 0.5% protocol → deposited into `curve.protocol_fees`.

**Graduation (v4 — front-run safe):** `graduate()` is permissionless, no return values, all transfers internal. Creator bonus auto-sent. LP tokens (200M) → creator. Pool SUI → stays in reserve, claimed by admin via `claim_graduation_funds()`.

**Token economics:** 1B supply (6 decimals), 800M curve + 200M LP at graduation, virtual reserves Vs=30k SUI / Vt=1.073B tokens, graduation at `token_reserve==0` (~87,912 SUI drain), 2 SUI launch fee.

**Key functions:** `create_and_return`, `share_curve`, `buy`, `sell`, `claim_creator_fees`, `claim_protocol_fees`, `update_payouts`, `graduate`, `claim_graduation_funds`, `post_comment`.

---

## ⚠️ CRITICAL SDK PATTERNS — Never Deviate

**1. ALWAYS `tx.sharedObjectRef()` for curves** — never `tx.object()` (causes TypeMismatch).
```js
const curveObj = await client.getObject({ id: curveId, options: { showOwner: true } });
const initialSharedVersion = curveObj.data?.owner?.Shared?.initial_shared_version;
const curveRef = tx.sharedObjectRef({ objectId: curveId, initialSharedVersion, mutable: true });
```

**2. `post_comment`** takes `tx.pure.address(curveId)` + `tx.pure.string(text)`. NO typeArguments, NOT sharedObjectRef.

**3. `fmt()` null guard as FIRST LINE:** `if (n == null) return '-';` — recurring production crash without this.

**4. BrowserRouter MUST wrap App in main.jsx.**

**5. vite.config.js:** `optimizeDeps: { exclude: ['@mysten/move-bytecode-template'] }`

**6. Never PowerShell multiline regex** — use Python for file fixes.

---

## Frontend Features (all deployed on Vercel)
- Homepage: token grid, sort tabs (NEWEST/OLDEST/TRENDING/VOLUME/TRADES/RESERVE/PROGRESS), % change badges, HOT badges (3+ trades/hr), partial CA search, skeleton loading, stats bar (tokens/trades/volume/S1 pool)
- Launch modal: 4-step (details→payouts→devbuy→launch), social links (Telegram/X/Website), Imgur upload (Client-ID: 546c25a59c58ad7), two-tx PTB bytecode patching
- Token pages: deep-linkable /token/:curveId, price chart (OHLC candles, PRICE/MCAP, all intervals, USD from Binance), trade history, holders, comments (wallet avatar colors), social links from `||` delimiter, copy CA button, creator fee claim, graduation banner, MAX buy/sell
- Mobile: hamburger nav, sticky bottom trade panel, Phantom+Slush deep links, WalletConnect
- Other pages: /portfolio (any-address), /leaderboard, /airdrop, /whitepaper (v2.0), /roadmap
- Events: all components use cursor-based pagination via paginateEvents.js (no 100-event cap)
- useTokenStats provides per-token: `{ volume, trades, recentTrades, pctChange, lastPrice, firstPrice, reserveSui }`

---

## Deploy Flow
```bash
# Frontend
cd C:\Users\User\Desktop\suipump && git add . && git commit -m "msg" && git push

# Contract redeploy
cd contracts → delete Published.toml → sui client publish --gas-budget 500000000
→ update PACKAGE_ID in constants.js + scripts/config.js + CLAUDE.md
```

---

## Key Decisions (DO NOT REVISIT)
Dev-buy uncapped (accepted) · On-chain comments event-only · Auto-graduation deferred to mainnet (Cetus testnet broken) · Old v2/v3 tokens excluded · useTokenList queries ONLY current PACKAGE_ID · sharedObjectRef always · post_comment takes ID not &Curve<T> · black/lime/white only · No burn, airdrops only · $SUMP Season 2+ · First airdrop in SUI · Imgur for images · Social links via `||` delimiter · Graduation front-run safe · Graduation fee 1% (0.5%+0.5%)

---

## Security Review (Pre-Audit) — SECURITY_REVIEW.md
H-1: Sell-side reserve drain (low risk) · H-2: Uncapped dev-buy (ACCEPTED) · M-1: No re-entrancy (safe on Sui) · M-2: claim_creator_fees all-or-nothing · M-3: effective_token_reserve underflow (safe, TreasuryCap locked) · M-4: Graduation front-run (**FIXED v4**)

---

## Fundraising
$1.5M seed · $7.5M pre-money · 16.7% equity + 10% $SUMP warrants · 15+ VCs contacted · Cetus incubator active (stalled at Discord mod level, Figure Asaki = best contact) · Sui grants (Moonshots, Hydroflow, Developer) submitted · OtterSec + MoveBit audit emails drafted (not sent)

## Testnet Tokens
Example Token ($EXMPL), Moon Coin ($MOON), Nenem ($NENEM), $LOVE — all by wallet 0x0be9...0c55. claim_fees.js claimed 4.04 SUI protocol fees.

## Pump.fun Gap Analysis (session 6)
Features to skip: voice chat, livestreams, DMs, native app, terminal, own DEX. Features to build next (frontend-only): LAST TRADE + MARKET CAP sort tabs, King of Hill 👑 badge, revenue/stats page (/stats). Agreed but not started.
