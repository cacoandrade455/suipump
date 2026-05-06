# SuiPump — Comprehensive Handoff
**Date:** 2026-05-06 (night, Salvador UTC-3)
**Live:** suipump.vercel.app | **Repo:** github.com/cacoandrade455/suipump | **X:** @suipump_sump

---

## Product State: What's Working Right Now

### Contracts (Sui testnet v4)
```
Package:       0x2154486dcf503bd3e8feae4fb913e862f7e2bbf4489769aff63978f55d55b4a8
AdminCap:      0xfc80d407147af9445d7042a6a538524b5a483cc995fdbf0c795ce7eab506b6f9
UpgradeCap:    0xc85c5786edc0c0736c3a540131b40af0955e38493ecc601ed5fb93c9c81986d2
Example Curve: 0xf7c137e90c5a5c9e716c91fdd3561d55e6ba3c11c37a9741b0bfde03dc9d812f
Wallet:        0x0be9a8f56ba3b07f295e0c7526e7f47ca3a146649b9d864d2eb47bf3acd90c55
```

### Frontend Features Live on Vercel
1. **Homepage** — token grid, TRENDING sort + HOT badge, % change badges, partial CA search, skeleton loading, S1 counter
2. **Launch Modal** — 4-step (details → payouts → dev-buy → launch), social links (Telegram/X/Website), Imgur upload, two-tx PTB
3. **Token Pages** — deep-linkable, price chart, trade history, holders, comments (wallet avatar colors), social links, copy CA button, creator fee claim, graduation banner, MAX buy/sell buttons (1/5/10/50 SUI presets)
4. **Mobile** — hamburger nav, sticky bottom trade panel, Phantom+Slush deep links, WalletConnect
5. **Portfolio Page** — any-address lookup
6. **Leaderboard** — top tokens + traders by volume
7. **Airdrop / Whitepaper / Roadmap** pages
8. **Admin CLI** — `node scripts/claim_fees.js`
9. **Paginated events** — all components use cursor-based pagination (no 100-event cap)

---

## Session History

### Session 5 (2026-05-06 night — this session)
**Major changes:**
1. **queryEvents pagination** — new `paginateEvents.js` utility, all 9 components updated to use cursor-based pagination. No more silent data loss on busy curves.
2. **Social links** — Telegram/X/Website fields in LaunchModal step 1, encoded in description via `||` delimiter, displayed on token page
3. **WalletConnect Project ID** → Vercel env vars (cloud.walletconnect.com)
4. **Homepage improvements** — % change badges, 🔥 TRENDING sort + HOT badge, partial CA search, trade count on cards
5. **Better comments UX** — deterministic wallet avatar colors, improved timestamps
6. **Copy CA button** on token page
7. **MAX buy/sell buttons** — buy presets 1/5/10/50 SUI + MAX, sell 25%/50%/75%/MAX
8. **Security review** — full pre-audit review of bonding_curve.move (SECURITY_REVIEW.md)
9. **Contract v4 deploy** — front-run-safe graduation (no return values, internal transfers), 1% graduation fee (0.5% creator + 0.5% protocol), new `claim_graduation_funds()` function
10. **Pitch deck review** — fundraising ask analysis, VC feedback preparation

### Session 4 (2026-05-06 morning)
- BrowserRouter bug fix
- 15+ VC emails/DMs/applications
- Pitch deck updates (500K + 1.5M)
- CLAUDE.md and HANDOFF.md generated

### Session 3 (2026-05-05 night)
- react-router-dom deep links, % change badges, trending sort, CA search
- Portfolio page, PriceChart overhaul, TradeHistory, Comments
- Mobile layout, WalletConnect support, fmt() null guards

### Session 2 (2026-05-05 morning)
- Token page crash fix, chart improvements, investor deck prep

### Session 1 (Early days)
- Full bonding curve contract, 18/18 tests, deploy
- Frontend buy/sell, launch modal, homepage

---

## Contract Changes in v4

| Feature | v3 (old) | v4 (current) |
|---|---|---|
| Graduation return values | Returns 3 coins (front-runnable) | No return values — internal transfers |
| Creator graduation bonus | 0.5% returned to PTB caller | 0.5% transferred to `curve.creator` |
| Protocol graduation bonus | None | 0.5% deposited into `curve.protocol_fees` |
| Total graduation fee | 0.5% | **1.0%** (0.5% creator + 0.5% protocol) |
| LP tokens at graduation | Returned to PTB caller | Transferred to `curve.creator` |
| Pool SUI at graduation | Returned to PTB caller | Stays in `curve.sui_reserve` |
| New function | — | `claim_graduation_funds()` (AdminCap-gated) |
| Graduated event | `{curve_id, final_sui_reserve, creator_bonus}` | Adds `protocol_bonus` field |

---

## Technical Debt (remaining)

| Issue | Impact | Fix |
|---|---|---|
| Cetus graduation PTB | Auto-graduation doesn't work on testnet | Defer to mainnet |
| Safari iOS caching | Stale assets after deploy | vercel.json cache headers partially fix |
| bonding_curve_tests.move | Tests need update for v4 graduate() signature | Update tests |
| Old tokens on v3 | Not visible on homepage (correct behavior) | No action needed |

---

## Fundraising Status

### Round Details
- **Raise:** $1,500,000 seed | **Pre-money:** $7.5M | **Post-money:** $9M
- **Equity:** 16.7% + 10% $SUMP warrants at Season 2 launch

### VC Outreach — All Done
| VC | Status |
|---|---|
| HashKey, OKX, Electric, DWF, KuCoin, Gate, Pantera | ✅ Sent |
| YZi Labs, Coinbase, Arche/Ninety98, OpenVC | ✅ Applied |
| Comma3, SevenX, Spartan, Animoca | ✅ Sent |
| Cetus Incubator | 🔄 Active |
| Sui Moonshots / Hydroflow / Dev Grants | 🔄 In progress |

---

## Next Steps (Priority Order)

1. **Update bonding_curve_tests.move** for v4 graduation changes
2. **Token page social links display** — verify end-to-end with a new token launch
3. **Cetus graduation PTB** — mainnet only, needs Cetus team guidance
4. **Security audit** (~$20-25k, OtterSec/Movebit/Zellic) — hard gate for mainnet
5. **AdminCap → multisig**
6. **Off-chain indexer** — defer until real volume

---

## Key Decisions Locked
- Dev-buy uncapped — accepted
- On-chain comments event-based only
- Auto-graduation deferred to mainnet
- Old v2/v3 tokens excluded from homepage
- Color scheme: black/lime/white ONLY
- All buy/sell/claim use `sharedObjectRef`
- `post_comment` takes `ID` not `&Curve<T>`
- No burn, only airdrops — $SUMP is Season 2+
- First airdrop paid in SUI
- Social links encoded in description via `||` delimiter
- Graduation is front-run safe — no return values
- Graduation fee: 1% total (0.5% creator + 0.5% protocol)
- Buy presets: 1/5/10/50 SUI + MAX
