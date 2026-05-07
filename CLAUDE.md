# SuiPump — CLAUDE.md
*AI memory file for Claude Code and claude.ai — Session 8*
*Last updated: May 7, 2026*

---

## What This Project Is

SuiPump is a permissionless bonding-curve token launchpad on Sui — the pump.fun of Sui. Built solo by Carlos. Full-stack: Move contracts + React frontend. Live on testnet at suipump.vercel.app. Mainnet after security audit.

**GitHub (source of truth):** github.com/cacoandrade455/suipump
**Never use /mnt/project/ files — they are outdated v2 era.**

---

## Deployments

### v4 Testnet (CURRENT)
```
Package:    0x2154486dcf503bd3e8feae4fb913e862f7e2bbf4489769aff63978f55d55b4a8
AdminCap:   0xfc80d407147af9445d7042a6a538524b5a483cc995fdbf0c795ce7eab506b6f9
UpgradeCap: 0xc85c5786edc0c0736c3a540131b40af0955e38493ecc601ed5fb93c9c81986d2
```

### MOON Token (first real token)
```
Package:    0xfc5f2eb382996b07f5f3e077213ed5814fd387fb1b19451848a07400b7d2806e
Curve:      0x160f597f2072373db171b390c04c405cc755abae7b092fcaa92988289ae96a55
```

---

## Stack

- Move + Sui CLI 1.70.2
- @mysten/sui 1.45.x + @mysten/dapp-kit 0.14.53
- React 18 + Vite 5 + Tailwind 3 + react-router-dom v7
- Node.js v24, Windows 11
- Vercel (auto-deploy on git push)

---

## Contract Design

### Fees
- Trade: 1% → 40% creator / 50% protocol / 10% LP reserve
- Graduation: 1% of reserve → 0.5% creator (auto-transfer) / 0.5% protocol
- Launch: 2 SUI → protocol_fees

### Curve Math
- Virtual reserves: Vs=30k SUI, Vt=1.073B tokens
- Total supply: 1B (800M curve + 200M LP at grad)
- Graduation: token_reserve == 0 (~87.9k SUI)
- 6 decimals

### graduate() — VOID (v4)
Does NOT return values. All transfers are internal:
- Creator gets 0.5% bonus SUI via transfer
- Protocol gets 0.5% bonus into protocol_fees
- LP tokens transferred to creator
- Pool SUI stays in sui_reserve for admin claim

### Tests
- 26/26 Move unit tests: `sui move test` from contracts/
- 29/29 Python tests: `python tests/test_harness.py`

---

## Frontend Files

```
frontend-app/src/
├── App.jsx              — Main app, routing, HomePage, TokenCard, StatsBar, useStats()
├── TokenPage.jsx        — Token detail page
├── LaunchModal.jsx      — 4-step launch flow
├── PriceChart.jsx       — OHLC chart, interval filtering, animation
├── HolderList.jsx
├── TradeHistory.jsx
├── Comments.jsx
├── AirdropPage.jsx
├── WhitepaperPage.jsx
├── LeaderboardPage.jsx
├── PortfolioPage.jsx
├── RoadmapPage.jsx
├── S1AirdropCounter.jsx
├── useTokenList.js      — CurveCreated events → token list
├── useTokenStats.js     — Per-token stats (volume, trades, pctChange, lastPrice, reserveSui)
├── constants.js         — PACKAGE_ID
├── curve.js             — AMM math
├── main.jsx             — Entry point, BrowserRouter, Vercel Analytics
└── paginateEvents.js    — Cursor-based pagination
```

### useStats() (already in App.jsx)
Fetches TokensPurchased + TokensSold events, computes:
- `poolSui` — protocol fees estimate
- `tradeCount` — total trades
- `volume` — total SUI volume in SUI

---

## CRITICAL RULES — NEVER VIOLATE

1. **`tx.sharedObjectRef` for curves** — never `tx.object()`
2. **`post_comment`** — `tx.pure.address(curveId)` + `tx.pure.string(text)`, NO typeArguments
3. **`fmt()`** — MUST have `if (n == null) return '-'` as first line
4. **`BrowserRouter`** — MUST wrap App in main.jsx
5. **No PowerShell multiline regex** — use Python
6. **Colors: black/lime/white ONLY** — no amber, yellow, orange anywhere
7. **Complete files only** — never partial files or merge instructions
8. **GitHub first** — always read repo before writing code

---

## To-Do List (Session 8)

### Build (priority order)
1. `/stats` revenue page — `StatsPage.jsx` at `/stats` route. Protocol fees, volume, token count, graduations. USD primary. Use existing `useStats()` + `useTokenList()`.
2. Trade alert Discord bot — Node.js, polls events every 15s, posts to Discord channels
3. Socials + meta tags on Vercel — Discord/X/GitHub in header, OG tags for previews
4. `update_description()` — New Move fn + frontend. Minimal launch fields (name/symbol/image only), rest editable post-deploy
5. GIF token pictures — accept .gif URLs in launch modal + render animated
6. Longer description limit + char counter — BCS limit hit, someone got error on launch

### Growth
7. Sui Overflow 2026 — register + submit at overflow.sui.io (DeFi track, $500K+)
8. Moonshot reapply — wait 2-3 weeks
9. Boost X post — AFTER items 1-6 done
10. Follow up KOL DMs (48hrs)

### Pre-Mainnet
11. Audit emails — MoveBit (contact@movebit.xyz), OtterSec (contact@osec.io)
12. DM Cetus — Figure Asaki (Discord: figure8958)
13. Seed close — $1.5M, 16.7% equity + 10% $SUMP warrants

---

## Key Context

### Pump.fun Comparison
| | pump.fun | SuiPump |
|---|---|---|
| Trade fee | 1.25% | 1.00% |
| Creator cut | 0.26% | 0.40% |
| Launch fee | Free | 2 SUI |
| Chain | Solana | Sui |
| Graduation | Raydium | Cetus |

### Fundraising
- $1.5M seed, $7.5M pre-money
- 15+ VCs contacted: HashKey, OKX, Electric, DWF, KuCoin, Gate, Pantera, YZi, Coinbase, Arche, Spartan, SevenX, Animoca + more
- Cetus incubator ticket active
- Suipad IDO application submitted (June 2027 dates, 50K SUI raise)

### Social Media (as of session 7)
- @SuiPump_SUMP verified ✅
- @SuiNetwork liked a reply — stay engaged on their posts
- Vercel Analytics live: USA 44%, Brazil 22%, Germany/Italy/Philippines 11% each
- Desktop 56%, Mobile 44%

### DeepBook as Cetus Alternative
If Cetus doesn't engage: DeepBook is Mysten Labs' native order book, $51.3M Sui DeFi fund supports integrations. Better pitch: "graduates to Mysten Labs' native DEX." Apply at deepbook.tech/resources.

### Community Crown 👑
The #1 volume token badge. Never call it "King of the Hill."

### $SUMP Token
Season 2 only. Does not exist yet. Anyone claiming to sell $SUMP is a scam.

---

## Session History
- Session 1-5: Contract v1→v4, full frontend build
- Session 6: Pump.fun gap analysis, auditor/Cetus outreach drafted
- Session 7 (May 7 2026): 26/26 Move tests + 29/29 Python. USD prices live. Chart animation fixed. Vercel Analytics. Discord server. Icon designed. @SuiPump verified. @SuiNetwork engagement. Suipad submitted. Sui Overflow identified.
