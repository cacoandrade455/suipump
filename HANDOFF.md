# SuiPump — Comprehensive Handoff
**Date:** 2026-05-07 (night, Salvador UTC-3)
**Live:** suipump.vercel.app | **Repo:** github.com/cacoandrade455/suipump | **X:** @SuiPump

---

## What SuiPump Is

Permissionless bonding-curve token launchpad on Sui. Anyone launches a token in 2 wallet signatures. Price discovery via on-chain constant-product AMM. Tokens graduate to Cetus DEX when the curve drains. Creator-first economics: 40% of fees go to creators (vs pump.fun's 24%). Target: $50M+/month volume.

---

## Product State: Everything Working Right Now

### Smart Contract (Sui testnet v4)
```
Package:       0x2154486dcf503bd3e8feae4fb913e862f7e2bbf4489769aff63978f55d55b4a8
AdminCap:      0xfc80d407147af9445d7042a6a538524b5a483cc995fdbf0c795ce7eab506b6f9
Example Curve: 0xf7c137e90c5a5c9e716c91fdd3561d55e6ba3c11c37a9741b0bfde03dc9d812f
```
18/18 Move unit tests + 29/29 Python math tests. Pre-audit security review completed (SECURITY_REVIEW.md). Front-run-safe graduation implemented in v4.

### Frontend (Live on Vercel)
1. **Homepage** — token grid with sort tabs (NEWEST, OLDEST, 🔥 TRENDING, VOLUME, TRADES, RESERVE, PROGRESS), % change badges, HOT badges, partial CA search, skeleton loading, live stats bar
2. **Launch Modal** — 4-step wizard (details → payouts → dev-buy → launch), social links (Telegram/X/Website), Imgur image upload, two-tx PTB with bytecode patching
3. **Token Pages** — deep-linkable `/token/:curveId`, OHLC price chart with PRICE/MCAP toggle and 7 time intervals, trade history, top 10 holders, on-chain comments with colored wallet avatars, social links display, copy CA button, creator fee claim, graduation banner with final stats
4. **Mobile** — hamburger nav, sticky bottom trade panel, Phantom + Slush deep links, WalletConnect
5. **Portfolio** — any-address token holdings lookup
6. **Leaderboard** — top tokens + traders ranked by volume
7. **Airdrop / Whitepaper (v2.0) / Roadmap** — all updated for v4 contract
8. **Paginated Events** — all 9 components use cursor-based pagination (no more 100-event cap)
9. **Admin CLI** — `node scripts/claim_fees.js` (claimed 4.04 SUI in one test run)

### Tokens Launched on Testnet
Example Token ($EXMPL), Moon Coin ($MOON), Nenem ($NENEM), $LOVE — all by founder wallet.

---

## Session History (6 sessions, 2026-05-05 to 2026-05-07)

### Session 1-2 (May 5 morning)
Full bonding curve contract, 18/18 tests, first deploy. Frontend buy/sell, launch modal, homepage. Token page crash fix, chart improvements, investor deck prep.

### Session 3 (May 5 night)
react-router-dom deep links, trending sort, CA search. Portfolio page, PriceChart overhaul (OHLC candles, time intervals, PRICE/MCAP toggle, USD conversion from Binance), TradeHistory, Comments. Mobile layout with WalletConnect + Phantom/Slush deep links. fmt() null guards fixed.

### Session 4 (May 6 morning)
BrowserRouter bug fix. 15+ VC emails/DMs/applications sent. Pitch deck review and updates (500K pre-seed + 1.5M seed versions). First CLAUDE.md and HANDOFF.md generated.

### Session 5 (May 6 night) — Major build session
1. queryEvents pagination — new `paginateEvents.js`, all 9 components updated
2. Social links — Telegram/X/Website in LaunchModal, encoded via `||` delimiter
3. WalletConnect Project ID → Vercel env vars
4. Homepage improvements — % change badges, 🔥 TRENDING sort + HOT badge, partial CA search, trade count on cards
5. Better comments UX — deterministic wallet avatar colors, improved timestamps
6. Copy CA button on token page
7. MAX buy/sell buttons — buy presets 1/5/10/50 SUI, sell 25%/50%/75%/MAX
8. Security review — full pre-audit of bonding_curve.move (SECURITY_REVIEW.md)
9. Contract v4 deploy — front-run-safe graduation, 1% graduation fee, claim_graduation_funds()
10. Whitepaper v2.0 + Roadmap update reflecting all completed work
11. Pitch deck review — VC objection preparation

### Session 6 (May 7 night) — Outreach + competitive analysis
1. Cetus incubator escalation — Figure Asaki (Discord: figure8958) identified as best contact. Henry Du confirmed co-founder. Cetus hacked $260M May 2025. DM drafted for @CetusProtocol on X.
2. MesoLabs research — different Henry Du from Cetus, small operation, not worth formal pitch
3. Auditor outreach — OtterSec (contact@osec.io) and MoveBit (contact@movebit.xyz) emails drafted. MoveBit is better fit (Move-native, Sui relationship, likely cheaper for ~500 lines).
4. Pump.fun competitive analysis — scraped homepage/fees. Key gaps identified: voice chat, DMs, livestreaming, terminal, native app, PUMP token, PumpSwap. Features to build: LAST TRADE + MARKET CAP sort tabs, King of Hill 👑 badge, /stats revenue page. Agreed but not started.
5. Handoff preparation begun, interrupted, resumed here.

---

## Contract Changes: v3 → v4

| Feature | v3 | v4 (current) |
|---|---|---|
| Graduation returns | 3 coins (front-runnable) | No return values — internal transfers |
| Creator grad bonus | 0.5% to PTB caller | 0.5% to `curve.creator` automatically |
| Protocol grad bonus | None | 0.5% into `curve.protocol_fees` |
| Total grad fee | 0.5% | **1.0%** |
| LP tokens | Returned to caller | Transferred to `curve.creator` |
| Pool SUI | Returned to caller | Stays in reserve, claimed via `claim_graduation_funds()` |

---

## What's Blocked

| Item | Blocker | Impact |
|---|---|---|
| Cetus graduation PTB | Cetus has NO testnet deployment | Can't test auto-graduation until mainnet |
| Security audit | $20-25k, external (OtterSec/MoveBit) | **HARD GATE for mainnet** |
| AdminCap → multisig | Needs audit first | Security requirement |
| bonding_curve_tests.move | v4 graduate() has no return values, old tests expect returns | Tests need update |

---

## Next Steps (Priority Order)

### Immediate (next session)
1. **Send OtterSec and MoveBit audit emails** — drafted in session 6, not sent
2. **DM Figure Asaki on Discord + @CetusProtocol on X** — DM text ready
3. **Build: LAST TRADE + MARKET CAP sort tabs** — pump.fun parity, frontend-only
4. **Build: King of Hill 👑 badge** — #1 volume token gets crown on homepage
5. **Build: /stats revenue page** — protocol metrics dashboard

### Pre-Mainnet
6. Update bonding_curve_tests.move for v4 graduate() signature
7. Security audit (~$20-25k) — HARD GATE
8. AdminCap → multisig
9. Cetus graduation PTB (mainnet only)

### Post-Mainnet
10. Off-chain indexer for real-time data
11. $SUMP token (Season 2+)
12. SuiPump Perps

---

## Fundraising Status

**Round:** $1.5M seed | $7.5M pre-money | $9M post | 16.7% equity + 10% $SUMP warrants

### VC Outreach
| Contact | Status |
|---|---|
| HashKey, OKX, Electric, DWF, KuCoin, Gate, Pantera | ✅ Sent |
| YZi Labs, Coinbase, Arche/Ninety98, OpenVC (500+) | ✅ Applied |
| Comma3 (Ivan Li @Ivantok4), SevenX, Spartan, Animoca | ✅ Sent/DM'd |
| Cetus Incubator | 🔄 Stalled at Discord mod level |
| Sui Moonshots / Hydroflow / Developer Grants | 🔄 Submitted |
| OtterSec audit | 📧 Email drafted, not sent |
| MoveBit audit | 📧 Email drafted, not sent |

### Key Contacts
| Person | Channel | Context |
|---|---|---|
| Figure Asaki | Discord figure8958 | Cetus team, crisis communicator during hack |
| @CetusProtocol | X DM | BD/partnerships — DM drafted |
| Ivan Li (Comma3) | X @Ivantok4 | DM sent session 4 |
| SevenX partners | X @Louissongyz, @jonbit3 | DM text ready |
| Spartan Group | X @leeorgroen | DM text ready |
| Arche Fund | arche.fund/kompass | Apply to Kompass accelerator |

---

## Technical Debt

| Issue | Severity | Fix |
|---|---|---|
| bonding_curve_tests.move | Medium | Update for v4 graduate() (no return values) |
| Safari iOS caching | Low | vercel.json cache headers partially fix, manual clear needed |
| Old v3 tokens invisible | None | Correct behavior, useTokenList queries only current PACKAGE_ID |
| icon-placeholder.png 404 | None | Harmless, 🔥 fallback emoji shows |
| useTokenStats no lastTradeTime | Low | Would enable LAST TRADE sort, needs adding |

---

## Key Files Quick Reference

| File | Lines | Purpose |
|---|---|---|
| App.jsx | ~531 | Router, homepage, header, token cards, sort, search, stats |
| TokenPage.jsx | ~492 | Token detail page, trade panel, graduation UI |
| LaunchModal.jsx | ~450 | 4-step launch wizard with social links + Imgur |
| PriceChart.jsx | ~352 | OHLC candles, PRICE/MCAP, 7 intervals, USD |
| Comments.jsx | ~163 | On-chain comments with colored avatars |
| LeaderboardPage.jsx | ~263 | Top tokens + traders by volume |
| paginateEvents.js | ~74 | Shared cursor pagination utility |
| useTokenList.js | ~74 | CurveCreated event queries |
| useTokenStats.js | ~120 | Per-token: volume, trades, pctChange, recentTrades |
| constants.js | ~21 | PACKAGE_ID + curve math constants |
| curve.js | ~100 | Bonding curve math mirroring Move contract |

---

## Transcripts
Full conversation history is preserved in:
- `/mnt/transcripts/2026-05-06-23-51-53-suipump-session5-build.txt` (5383 lines — ALL source code for every file)
- `/mnt/transcripts/2026-05-07-00-47-54-suipump-session6-outreach-features.txt`
- `/mnt/transcripts/journal.txt` (index)

---

## Founder
Carlos Andrade — self-taught CS, B.A. Political Science & International Relations (IPE focus), M.A. International Relations (in progress). Built SuiPump end-to-end solo from Salvador, Brazil.
