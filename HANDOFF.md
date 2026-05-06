# SuiPump — Comprehensive Handoff
**Date:** 2026-05-06 (evening, Salvador UTC-3)
**Live:** suipump.vercel.app | **Repo:** github.com/cacoandrade455/suipump | **X:** @suipump_sump

---

## Product State: What's Working Right Now

### Contracts (Sui testnet)
```
Package:       0xf91acdd7456381110d6a15d380dfd99fc126e59ffbf7a818c118e53765fa54c5
AdminCap:      0xc48452ed7e3c0a7bd0fb3e66ba37f15ccb6a9d090a87f7b53a451e3716ddeb6d
UpgradeCap:    0xa8579ca672b3f619692a3a2d50fa26f39036efb90f0b62e8c58cd360fc3c46ab
Example Curve: 0xdd84ca597b0f6ecdddc3909465353c6786320b20a99416d92a6709f444e089fc
Wallet:        0x0be9a8f56ba3b07f295e0c7526e7f47ca3a146649b9d864d2eb47bf3acd90c55
Tests:         18/18 passing
```

### Frontend Features Live on Vercel
1. **Homepage** — live token grid from CurveCreated events (15s poll), sort by NEWEST/OLDEST/VOLUME/TRADES/RESERVE/PROGRESS/TRENDING, search by name/symbol/0x address, % change badges, skeleton loading, S1 airdrop counter
2. **Launch Modal** — 4-step (details → payouts → dev-buy → launch), image upload via Imgur anonymous API, two-tx PTB, live preview
3. **Token Pages** — deep-linkable `/token/0x...` URLs, price chart (PRICE/MCAP toggle, 1m/5m/15m/1h/6h/24h/ALL, bar/line toggle, hover crosshair, SUI+USD via Binance), trade history (last 30), top 10 holders, on-chain comments, creator fee claim button, graduation banner with Cetus trade link
4. **Mobile** — hamburger nav, sticky bottom trade panel, Phantom+Slush deep links in mobile menu, WalletConnect support
5. **Portfolio Page** — `/portfolio`, any-address lookup, defaults to connected wallet
6. **Leaderboard** — `/leaderboard`, top tokens by volume
7. **Airdrop Page** — `/airdrop`
8. **Whitepaper Page** — `/whitepaper`
9. **Roadmap Page** — `/roadmap`
10. **Admin CLI** — `node scripts/claim_fees.js` claims all protocol fees from all curves (claimed 4.04 SUI in one run)

---

## Session History — What Was Built Each Session

### Session 1 (Early days)
- Full bonding curve contract (Move), 18/18 tests, deploy
- Frontend buy/sell wired to chain
- Launch modal, two-tx PTB, Imgur image upload
- Homepage token list from CurveCreated events
- Token icons, price chart (basic SVG)

### Session 2 (2026-05-05 morning)
- Token page crash bug fix
- Chart improvements (PRICE/MCAP toggle, time intervals 1M/5M/30M/1H/ALL)
- Investor deck prep

### Session 3 (2026-05-05 night)
All 6 items:
1. **react-router-dom** — deep-linkable `/token/:curveId` URLs, BrowserRouter in main.jsx, Routes in App.jsx, vercel.json SPA rewrite
2. **% change badges** — useTokenStats.js, PctBadge component, first vs latest trade price
3. **Trending sort** — by recentTrades count (last 60 min)
4. **CA search** — search by full 0x curve address
5. **Portfolio page** — any-address lookup at `/portfolio`
6. **PriceChart overhaul** — pump.fun intervals (1m/5m/15m/1h/6h/24h/ALL), bar/line toggle (OHLC candlesticks), hover crosshair

Plus **bug hunt**: null guards in `fmt()` across 6 files — recurring crash from undefined curve fields on partial RPC load.
Plus **TradeHistory.jsx** and **Comments.jsx** built.
Plus **mobile layout** — hamburger menu, sticky trade panel, Phantom+Slush deep links.
Plus **WalletConnect** support (env var).

### Session 4 (2026-05-06 — last session before this one)
- **BrowserRouter bug fix** — `useNavigate() may only be used in context of <Router>` crash. Fixed by adding BrowserRouter back to main.jsx (was lost after mobile wallet changes).
- **15+ VC emails/DMs/applications** — full outreach campaign completed (see VC table below)
- **Pitch deck updates** — two decks: 500K pre-seed (14 slides) + 1.5M seed (14 slides)
- **CLAUDE.md and HANDOFF.md** generated

---

## Critical Bugs Fixed (history for context)

### Bug 1: useNavigate outside Router (fixed Session 4)
- **Error:** `useNavigate() may only be used in the context of a <Router> component`
- **Root cause:** BrowserRouter removed from main.jsx during mobile wallet changes
- **Fix:** Re-add `import { BrowserRouter } from 'react-router-dom'` and wrap `<App />` in `<BrowserRouter>` in main.jsx

### Bug 2: fmt() null crash (fixed Session 3)
- **Error:** `TypeError: Cannot read properties of undefined (reading 'toFixed')`
- **Root cause:** Curve fields undefined on partial RPC response. `fmt(undefined)` → crash
- **Fix:** `if (n == null) return '-'` as FIRST LINE in every `fmt`, `fmtSui`, `fmtVal` function
- **Files fixed:** App.jsx (line 22), TokenPage.jsx (line 20), HolderList.jsx (various), PortfolioPage.jsx (line 16), PriceChart.jsx `fmtVal` (line 208), curve.js `mistToSui`+`tokenUnitsToWhole`
- **LESSON:** Never use PowerShell multiline regex (`-replace`) for file edits — corrupts newlines to literal backtick-n. Always use Python script → download → paste

### Bug 3: post_comment TypeMismatch (fixed early)
- **Error:** TypeMismatch on arg 0 when calling post_comment
- **Root cause:** Original contract had `post_comment<T>(curve: &Curve<T>, ...)` — SDK can't resolve generic T
- **Fix:** Changed Move contract to `post_comment(curve_id: ID, text: String, ctx)` — non-generic, takes plain ID
- **Frontend:** `tx.pure.address(curveId)` NOT `sharedObjectRef` or `tx.object()`

---

## Current Technical Debt

| Issue | Impact | Fix |
|---|---|---|
| queryEvents capped at 100 | Silently drops trades on busy curves; leaderboard, holders, chart miss events | Paginate with cursor |
| WalletConnect Project ID not in Vercel | Mobile WalletConnect won't work in prod | cloud.walletconnect.com → add `VITE_WALLETCONNECT_PROJECT_ID` to Vercel env vars |
| Cetus graduation PTB broken on testnet | Auto-graduation doesn't work | Cetus testnet `PublishUpgradeMissingDependency` — defer to mainnet |
| Safari iOS caching | Stale assets served after Vercel deploys | vercel.json cache headers partially fix it |

---

## Fundraising Status

### Round Details
- **Raise:** $1,500,000 seed | **Pre-money:** $7.5M | **Post-money:** $9M
- **Equity:** 16.7% + 10% $SUMP warrants at Season 2 launch
- **Use of funds:** Audit ($25k) + engineering + marketing + ops

### Pitch Decks
- `SuiPump_Deck_500K_v2.pptx/.pdf` — Pre-Seed $500K, 14 slides
- `SuiPump_Deck_1500K_v2.pptx/.pdf` — **Seed $1.5M, 14 slides ← USE THIS**
- TODO: merge WhySui_Slide_1500K.pptx as slide 9 → 16-slide deck

### VC Outreach — All Done (2026-05-06 session)
| VC | Contact Method | Status |
|---|---|---|
| HashKey Capital | enquiries@hashkey.com | ✅ Sent |
| OKX Ventures | ventures@okx.com | ✅ Sent |
| Electric Capital | info@electriccapital.com | ✅ Sent |
| DWF Labs | contact@dwf-labs.com + form | ✅ Sent |
| KuCoin Ventures | ventures@kucoin.com | ✅ Sent |
| Gate Ventures | ventures@gate.com | ✅ Sent |
| Pantera Capital | panteracapital.com/contact (Funding Inquiries) | ✅ Sent |
| YZi Labs (Binance) | Direct Investment form | ✅ Applied |
| Coinbase Ventures | ventures.coinbase.com | ✅ Applied |
| Arche Fund / Ninety Eight | Typeform x2 | ✅ Applied |
| OpenVC | openvc.app | ✅ Sent (hits 500+ VCs) |
| Comma3 Ventures | DM @Ivantok4 on X | ✅ Sent |
| SevenX Ventures | DM @Louissongyz / @jonbit3 on X | ✅ Sent |
| Spartan Group | Contact form + DM @leeorgroen | ✅ Sent |
| Animoca Ventures | arche.fund/contact + @ysiu DM | ✅ Sent |
| Cetus Incubator | hello@cetus.zone | 🔄 Active (core team reviewing) |
| Sui DeFi Moonshots | Submitted + follow-up in Discord | 🔄 In progress |
| Sui Hydroflow Accelerator | Submitted | 🔄 In progress |
| Sui Developer Grants | Submitted | 🔄 In progress |

---

## Next Steps (Priority Order)

1. **Immediate:** Commit CLAUDE.md + HANDOFF.md to GitHub
   ```
   git add CLAUDE.md HANDOFF.md && git commit -m "docs: comprehensive handoff update — VC outreach complete" && git push
   ```

2. **Product next:** Choose what to build next session:
   - **queryEvents pagination** — fixes chart/holder/leaderboard data loss on busy curves
   - **Better comments UX** — currently shows raw events, could use better timestamp display
   - **Token page social links** — LaunchModal step 1 add Telegram/X/website fields, display on token page
   - **Graduation flow improvement** — more graceful graduated token display
   - **16-slide pitch deck** — merge WhySui slide

3. **Infrastructure:**
   - WalletConnect Project ID → Vercel env vars (cloud.walletconnect.com, free)
   - Safari cache fix (partially done, verify still needed)

4. **Gate to mainnet:**
   - Security audit (~$20-25k, OtterSec/Movebit/Zellic)
   - AdminCap → multisig

5. **Season 2+ (don't build yet):**
   - $SUMP governance token
   - Cetus graduation PTB (needs mainnet + Cetus team guidance)
   - Off-chain indexer
   - Perps

---

## Key Decisions Locked
- Dev-buy uncapped — rug risk accepted
- No on-chain chat with stored state — event-based only
- Auto-graduation deferred to mainnet
- Old v2 tokens excluded from homepage
- Color scheme: black/lime/white ONLY
- All buy/sell/claim use `sharedObjectRef` — never `tx.object()`
- `post_comment` takes `ID` not `&Curve<T>` — not generic
- No burn, only airdrops — $SUMP is Season 2+
- First airdrop paid in SUI, no new token for S1
