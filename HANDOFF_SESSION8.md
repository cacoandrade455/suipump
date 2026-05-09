# SuiPump — Session 8 Handoff
*Generated end of Session 7 — May 7, 2026*

---

## Project Overview

SuiPump is a permissionless bonding-curve token launchpad on the Sui blockchain, built solo by Carlos (cacoandrade455). It is the first of its kind on Sui — analogous to pump.fun on Solana but with better creator economics, fully on-chain architecture, and native Sui/Move stack.

- **Live app:** suipump.vercel.app
- **GitHub (source of truth):** github.com/cacoandrade455/suipump
- **X:** @SuiPump_SUMP (verified ✅, 7+ followers as of session 7)
- **Discord:** SuiPump server (fully built via setup-discord.js)
- **Network:** Sui testnet (mainnet after audit)

---

## Active Deployment (v4 — Testnet)

```
Package:    0x2154486dcf503bd3e8feae4fb913e862f7e2bbf4489769aff63978f55d55b4a8
AdminCap:   0xfc80d407147af9445d7042a6a538524b5a483cc995fdbf0c795ce7eab506b6f9
UpgradeCap: 0xc85c5786edc0c0736c3a540131b40af0955e38493ecc601ed5fb93c9c81986d2
Ex. Curve:  0xf7c137e90c5a5c9e716c91fdd3561d55e6ba3c11c37a9741b0bfde03dc9d812f
```

**MOON token (first real launch):**
```
Package:    0xfc5f2eb382996b07f5f3e077213ed5814fd387fb1b19451848a07400b7d2806e
Curve:      0x160f597f2072373db171b390c04c405cc755abae7b092fcaa92988289ae96a55
CreatorCap: 0x85a5eba8f91284577c0580405719d767eb5c917de8cb1edc7ecb5a4e4a1a9b5f
```

---

## Tech Stack

- **Contracts:** Move (Sui), ~500 lines, fully tested
- **Frontend:** React 18 + Vite 5 + Tailwind 3 + @mysten/dapp-kit 0.14.53 + @mysten/sui 1.45.x
- **Router:** react-router-dom v7
- **Node:** v24, Windows 11, Sui CLI 1.70.2
- **Wallet:** Slush (0x0be9a8f56ba3b07f295e0c7526e7f47ca3a146649b9d864d2eb47bf3acd90c55)
- **Deploy:** Vercel (auto-deploy on git push to main)

---

## Contract Design (v4)

### Fee Structure
- **Trade fee: 1%** split as: 40% creator / 50% protocol / 10% LP-in-reserve
- **Graduation fee: 1% of final reserve** split as: 0.5% creator bonus (auto-transferred) / 0.5% protocol bonus (into fee pool)
- **Launch fee: 2 SUI** per token (goes to protocol_fees)

### Bonding Curve Math
- Virtual SUI reserve: 30,000 SUI
- Virtual token reserve: 1,073,000,000 tokens
- Total supply: 1B tokens (800M curve supply + 200M LP at graduation)
- 6 decimals
- Graduation triggers when token_reserve == 0 (~87.9k SUI drained)
- Starting price: ~0.0000280 SUI/token (~$0.000028 at current SUI price)

### Key Functions
- `graduate()` — void, all transfers internal, front-run-safe
- `claim_graduation_funds(&AdminCap, curve, ctx)` — admin claims pool SUI post-graduation
- `create_and_return()` + `share_curve()` — PTB composability for dev-buy
- `update_payouts()` — cap-gated payout split changes
- `update_description()` — **NOT YET BUILT**, on to-do list
- `post_comment()` — takes curve_id (address), no typeArguments

### Test Coverage
- **26/26 Move unit tests passing** (`sui move test` from contracts/)
- **29/29 Python simulation tests passing** (`python tests/test_harness.py`)

---

## Frontend Architecture

### Key Files
```
frontend-app/src/
├── App.jsx              — Homepage, TokenCard, StatsBar, HomePage, routing
├── TokenPage.jsx        — Individual token page with chart, trade panel, comments
├── LaunchModal.jsx      — 4-step token launch flow
├── PriceChart.jsx       — OHLC chart with interval filtering + animation
├── HolderList.jsx       — Token holder list
├── TradeHistory.jsx     — Trade event history
├── Comments.jsx         — On-chain comments
├── AirdropPage.jsx      — Season 1 airdrop info
├── WhitepaperPage.jsx   — Full whitepaper
├── LeaderboardPage.jsx  — Volume leaderboard
├── PortfolioPage.jsx    — User portfolio
├── RoadmapPage.jsx      — Development roadmap
├── S1AirdropCounter.jsx — Season 1 counter widget
├── useTokenList.js      — Fetches CurveCreated events, returns token list
├── useTokenStats.js     — Per-token: volume, trades, pctChange, lastPrice, reserveSui
├── constants.js         — PACKAGE_ID and other constants
├── curve.js             — AMM math helpers
├── main.jsx             — App entry, BrowserRouter, Vercel Analytics
└── paginateEvents.js    — Cursor-based event pagination (no 100-event cap)
```

### Critical SDK Rules (never violate)
1. ALWAYS use `tx.sharedObjectRef` for curves — never `tx.object()`
2. `post_comment`: use `tx.pure.address(curveId)` + `tx.pure.string(text)`, NO typeArguments
3. `fmt()` MUST have `if (n == null) return '-'` as first line
4. `BrowserRouter` MUST wrap `App` in `main.jsx`
5. NEVER PowerShell multiline regex — use Python
6. Color scheme: **black/lime/white ONLY** — no amber, yellow, or orange

### Completed Features
- Homepage with 7 sort tabs: NEWEST, OLDEST, TRENDING, LAST TRADE, MARKET CAP, VOLUME, TRADES, RESERVE, PROGRESS
- % change badges, HOT badges, Community Crown 👑 on #1 volume token
- Launch modal (4-step, Imgur image upload, social links, two-tx PTB)
- Token pages: OHLC chart (PRICE/MCAP toggle, 1M/5M/30M/1H/ALL intervals), trade history, holders, comments, social links, copy CA, graduation banner, MAX buy/sell
- USD-primary price and market cap display (Binance API feed, 30s refresh)
- Chart animation with smooth cubic bezier path + draw-on animation
- Real interval filtering (actual timestamp cutoff, not just slice)
- Portfolio, leaderboard, mobile layout, WalletConnect
- Whitepaper v2.0, roadmap, S1 counter
- Vercel Analytics (`<Analytics />` component in main.jsx)
- Social links encoded in description via `||` delimiter

### useStats() (in App.jsx)
Already computes from events:
- `poolSui` — protocol fees * 0.5 (S1 pool estimate)
- `tradeCount` — total trades
- `volume` — total SUI volume

### StatsBar (in App.jsx)
Shows: TOKENS, TRADES, VOLUME, S1 POOL on homepage header

---

## Session 7 — What Was Built/Done

### Code Changes
1. **PriceChart.jsx** — Complete rewrite:
   - Fixed `filterByInterval` to use real timestamp window (was doing `slice(-100)` regardless)
   - Added smooth cubic bezier path animation (`stroke-dasharray` + CSS `@keyframes chartDraw`)
   - Area fade-in animation (`chartFade`)
   - `animKey` counter forces React to remount animated elements on data refresh
   - USD-primary y-axis labels (Binance price feed)
   - Hover crosshair tooltip shows USD primary + SUI secondary

2. **TokenPage.jsx** — USD price display:
   - Added `suiUsd` state with Binance/CoinGecko 30s poller
   - `priceUsd` and `mcapUsd` computed from `priceMist`
   - Header price card: `$0.00001234` (lime, primary) + `0.000000012 SUI` (dim, secondary)

3. **App.jsx** — Token card USD display:
   - Module-level `_suiUsdCache` + `refreshSuiUsd()` function
   - `HomePage` fetches and passes `suiUsd` prop to each `TokenCard`
   - MC and price on cards now show USD primary

4. **main.jsx** — Added Vercel Analytics:
   ```jsx
   import { Analytics } from '@vercel/analytics/react';
   // Inside render: <Analytics /> inside BrowserRouter
   ```

5. **bonding_curve_tests.move** — Full rewrite for v4:
   - Fixed `graduate()` call sites (was unpacking 3 return values, now void)
   - New: `test_graduation_side_effects`, `test_cannot_sell_after_graduation`
   - New: `test_claim_graduation_funds_drains_pool_sui`, `test_claim_graduation_funds_fails_if_not_graduated`
   - New: `test_cap_mismatch_aborts` (uses `create_and_return` for two curves in same tx)
   - New: `test_post_comment_succeeds`, `test_empty_comment_rejected`, `test_comment_too_long_rejected`
   - All 26/26 passing

6. **test_harness.py** — Updated for v4:
   - Added `PROTOCOL_GRAD_BONUS_BPS = 50`
   - `graduate()` now void — takes `creator_wallet` and `lp_wallet` dicts
   - All graduation test bodies updated to verify internal transfers
   - 29/29 passing

### Discord Server Built
Full SuiPump Discord server created via `setup-discord.js`:
- Categories: 👋 WELCOME, 📚 INFO, 💬 COMMUNITY, 🛠 BUILDERS, 🔊 VOICE
- Read-only INFO channels: #whitepaper, #roadmap, #tokenomics, #faq (full content posted)
- Roles: Founder 🔥, Team, Moderator 🛡, Whale 🐋, Holder 🪙, Builder 🛠, OG 👑, Community
- Welcome message, rules, announcements all posted

### Icon Designed
New SuiPump icon: hollow neon lime green flame (Lucide path) + white SUIPUMP text, black background, neon glow filter. Saved as `suipump-icon.png`.

### Growth Activities
- @SuiPump verified on X ✅
- @SuiNetwork liked a reply about Slush integration
- Replied to @SuiNetwork Moonshots post (2.8K views)
- Replied to Cetus Whales community post about incubation
- KOL DMs sent to: Max Crypto, UMER THE BULL, jussy, Danh Tran, Sui Intern, emori.sui, Satoshi Flipper + others
- Suipad IDO application submitted (50K SUI raise, June 2027 dates)
- Sui Overflow 2026 identified — registration open, DeFi & Payments track, $500K+ prizes + $500K incubator seed pool. Eligible (work within 60 days of registration)
- TokenNation DM sent in Portuguese
- Vercel Analytics showing: USA 44%, Brazil 22%, Germany 11%, Italy 11%, Philippines 11%. Desktop 56%, Mobile 44%.

---

## To-Do List (Session 8+)

### 🔨 Build
1. **`/stats` revenue page** — New `StatsPage.jsx` route at `/stats`. Show: protocol fees (total + 24h), volume (total + 24h), tokens launched, graduations, live SUI/USD price. All USD primary. Data from `useStats()` (already in App.jsx) + `useTokenList()`. Add route to App.jsx router.
2. **Trade alert Discord bot** — Node.js script polling Sui events every 15s. Posts to #token-launches on new token, #trading on big buys (>5 SUI), #announcements on graduation. Runs as persistent process (Railway/Render free tier).
3. **Socials linked on Vercel + meta tags** — Discord invite, @SuiPump, GitHub in header/footer. Open Graph + Twitter card meta tags for link previews when sharing.
4. **`update_description()` on CreatorCap** — New Move function + frontend wiring. Minimal required fields at launch (name, symbol, image only). Socials/website/Telegram optional and editable post-deploy via CreatorCap.
5. **Allow GIFs as token pictures** — Accept `.gif` URLs in launch modal, render animated in token cards + token pages.
6. **Increase token description limit + character counter** — Current BCS limit too short. Someone tried to launch with a long description and got "String too long for BCS" error. Add frontend char counter + enforce/increase limit.

### 📈 Growth
7. Register + submit for **Sui Overflow 2026** (overflow.sui.io) — DeFi & Payments track
8. **Moonshot reapplication** — Wait 2-3 weeks, reapply with session 7 progress as proof
9. Keep engaging **@SuiNetwork** thread — they liked a reply, stay visible
10. Follow up KOL DMs in 48 hours
11. **Boost X post** — after all app changes are live and tested

### 🔒 Pre-Mainnet
12. Send **MoveBit + OtterSec audit emails** (contact@movebit.xyz, contact@osec.io) — Subject: "Sui Move Audit — SuiPump Bonding Curve Contract"
13. **DM Figure Asaki** (Cetus Discord: figure8958) re: incubation
14. **Seed round close** — $1.5M, 15+ VCs in pipeline

---

## Key Decisions & Context

### Why DeepBook over Cetus (if Cetus doesn't engage)
- DeepBook is Mysten Labs' native order book — more prestigious pitch ("graduates to Mysten Labs' native DEX")
- Sui Foundation has a $51.3M DeFi fund specifically supporting DeepBook integrations
- DeepBook RFP grant available at deepbook.tech/resources
- Cetus had a $260M hack in May 2025 — some investors may prefer DeepBook anyway

### Pricing Context
- SUI/USD: ~$0.49 (May 7 2026)
- Starting market cap: ~$27k USD (virtual reserve artifact, not real trades)
- pump.fun charges 1.25% (0.3% creator / 0.95% protocol), free launch
- SuiPump charges 1% (0.4% creator / 0.5% protocol / 0.1% LP), 2 SUI launch fee

### Vercel Analytics Data (Day 1)
- Countries: USA 44%, Brazil 22%, Germany 11%, Italy 11%, Philippines 11%
- Devices: Desktop 56%, Mobile 44%
- This confirms: real international audience, mobile layout matters

### Twitter/X Strategy
- Wait for @SuiNetwork engagement to compound before boosting
- Boost only after all app changes are live (items 1-6 complete)
- Don't DM KOLs about testnet tokens — no real return yet
- Pitch angle: "be a founding creator on mainnet, day 1 before everyone else"
- Blue checkmark verified — reply to @SuiNetwork posts while engagement is hot

---

## File Delivery Notes
All files delivered this session are drop-in ready for `frontend-app/src/`:
- `PriceChart.jsx` → `frontend-app/src/PriceChart.jsx`
- `TokenPage.jsx` → `frontend-app/src/TokenPage.jsx`
- `App.jsx` → `frontend-app/src/App.jsx`
- `main.jsx` → `frontend-app/src/main.jsx`
- `bonding_curve_tests.move` → `contracts/sources/bonding_curve_tests.move`
- `test_harness.py` → `tests/test_harness.py`
- `setup-discord.js` → standalone script (not in repo)
- `suipump-icon.png` → use for X pfp + Discord server icon

---

## Rules for Next Claude
1. **GitHub is source of truth** — always clone/read before writing code
2. **Never use tx.object() for curves** — always tx.sharedObjectRef
3. **Black/lime/white color scheme only** — no amber, yellow, orange
4. **Files must be complete and drop-in ready** — never partial files or merge instructions
5. **fmt() must have null check first** — `if (n == null) return '-'`
6. **BrowserRouter wraps App in main.jsx** — never move this
7. **Python for multiline regex** — never PowerShell
8. **Push back when something is wrong** — Carlos wants honest feedback, not agreement
