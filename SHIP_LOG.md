# SHIP LOG — redesign-terminal queue

Autonomous port of the remaining redesign queue. One entry per screen: files, gates,
verified-vs-not, open flags. STYLE-only ports; all logic/hooks/PTB preserved verbatim.

---

## 2b part 2 + 5b — Comments, AIAnalysis, creator tools, automation, takeover — SHIPPED

**Files changed (named `git add` only):**
- `frontend-app/src/AIAnalysis.jsx` — AI ANALYSIS card → Terminal card (border-white/[0.08] rounded-2xl bg-white/[0.015]); white/55 header + lime BETA chip; severity-driven verdict pill (red/amber/lime from existing strongCount/flagCount, never fabricated); 6px-dot flag rows; footnote white/22. Removed a now-dead lucide import.
- `frontend-app/src/Comments.jsx` — COMMENTS card → Terminal card; header + dynamic subtitle (live holderGated gate label, V10-lineage only); composer moved into bordered box with lime POST; 28px rounded-[9px] avatars, reply rail border-l-2 border-lime-400/20. All holder-gate / reply / SSE / PTB paths byte-identical.
- `frontend-app/src/TokenPage.jsx` — restyled 6 local panels (CreatorToolsPanel→amber card, CommunityTakeoverPanel, CommentGatePanel, CreatorBuybackPanel, TPSLPanel→AUTOMATION header + real TRADING KEY pill from keypair state, VestingPanel) + 5b mobile TP/SL & Vesting accordions + CommentsBlock wrapper (moved header inside card to avoid duplicate). No handler/PTB/useTPSL/buyback/CTO/gate logic changed.
- `frontend-app/src/i18n.js` — added `commentsGateHolders`, `commentsGateOpen`, `commentsPostInfo` in all 7 languages (en/zh/pt/ko/vi/ru/es).

**Gates (all independently re-run by orchestrator):**
- `npm run build` → ✓ built in 20.10s, 2238 modules, no errors (dynamic-import note + >500 kB chunk warning are pre-existing).
- `npx acorn --ecma2023 --module src/i18n.js` → OK.
- `npx esbuild` parse: AIAnalysis.jsx OK, Comments.jsx OK, TokenPage.jsx OK.
- ASCII purity: only new non-ASCII in .jsx is the middot `·` via the `{'·'}` rendered-UI-glyph pattern part 1 established (3 occurrences). i18n.js gained expected CJK/Cyrillic translation glyphs. No new em-dashes in code/comments.

**Verified:** build + syntax + ASCII gates (proof above); all logic paths left byte-identical (restyle-only).
**Not verified (no browser run this session):** live pixel rendering, TRADING-KEY pill state transitions in-app, dynamic-gate subtitle toggling. Presentation-only; runtime behavior unchanged.

**Open flags:**
1. Comments upvotes `▲ N` + "holds %" / DEV badges: design shows them; no backing data in Comments.jsx. OMITTED (not fabricated). Feature gap if wanted → needs indexer support.
2. AUTOMATION strategy chips (TP/SL·LIMIT·DCA·COPY·REBAL·GRAD SNIPE·ACTIVE·N): those belong to the App.jsx-lifted StrategiesModal suite, not TPSLPanel. Header renamed to AUTOMATION + real TRADING KEY pill added; chip row NOT wired here. Confirm if chips should link to the strategies modal from the token page.
3. AUTOMATION AES-256 footnote: OMITTED per ledger item 14 (verify wording against useTradeKey before shipping the security claim; not verified this session).
4. Minor glyph deviations: TRADING KEY pill without design's `✓`; Comments composer kept its Send icon rather than a "POST" text label (avoids new untranslated non-ASCII copy).
5. CreatorToolsPanel in code is the links/metadata editor; the design's amber mock composes claimable-fees/buyback/vesting rows that live in SEPARATE panels. Restyled container/header/buttons to amber; did NOT merge the mock rows or hardcode its numbers.

---

## 2e portfolio + 5d + session-parked positions (C-6) — SHIPPED

**Files changed (named `git add` only):**
- `frontend-app/src/useSessionPositions.js` — NEW read-only C-6 data module. `useSessionPositions(account, tokens)` → `{positions, loading, error, refresh}`; `sellSessionPosition({sessionId, curveId})`. Mirrors AgentPage's discovery (indexer-first `/agent/sessions?owner=`, GraphQL `SessionOpened` fallback under PACKAGE_ID_V10), parked Coin<T> probe (GraphQL dynamicFields, balance>0, universal_trading + plumbing-module filtered), and the `/session-sell` bridge call (sellAll:true) verbatim. BigInt handled (balanceWhole is Number). Pure ASCII.
- `frontend-app/src/PortfolioPage.jsx` — 2e desktop + 5d mobile restyle to Terminal; summary card (radial-lime gradient), pill tabs with real counts, holdings grid + allocation bars, amber CREATOR FEES CLAIM ALL bar. Wired the SESSION POSITIONS section (violet SESSION badge, distinct from address holdings) → SELL calls `sellSessionPosition({sessionId, curveId})`, disabled+READ-ONLY when curveId==null, double-click guarded, refresh() on success. SESSION section + creator-fees gated to OWN wallet (public /portfolio/:addr hides them — aligns with C-4 read-only).
- `frontend-app/src/i18n.js` — 18 new keys × 7 languages (SESSION POSITIONS, session-sell ok/fail, etc.).

**Gates (independently re-run by orchestrator):**
- `npm run build` → ✓ built in 19.89s, no errors.
- `npx esbuild src/PortfolioPage.jsx` OK; `npx acorn --ecma2023 --module` on i18n.js OK and useSessionPositions.js OK.
- ASCII: useSessionPositions.js pure ASCII; PortfolioPage added non-ASCII are rendered UI glyphs only (emoji/·/≈/↓/✓/●/✎); ZERO new em-dashes in code/comments (verified).

**Verified:** build + syntax + ASCII; C-6 data module logic mirrors AgentPage verbatim (read + confirmed by orchestrator); no existing logic changed except relocating the byte-identical `handleClaimAll` to a persistent CreatorFeesBar + a benign `setFeeNonce` refresh line.
**Not verified (no wallet/bridge/indexer live this session):** live claim-all signing round-trip, `/session-sell` bridge response, live `/agent/sessions` + GraphQL dynamicFields payload shapes (replicated from AgentPage's assumptions, not exercised).

**Open flags:**
1. Design's AVG COST + uPNL holdings columns and UNREALIZED PNL summary stat OMITTED — no per-holding cost basis exists in code (not fabricated). Shows TOTAL VALUE / REALIZED PNL / AIRDROP POINTS. Realized PnL wired to `/trader/:address` closed-position net cashflow (real endpoint).
2. No per-row SELL on address-balance holdings (no existing handler; rows stay click-to-token-page). Mandatory SELL exists only on SESSION positions per C-6.
3. Module assumptions (flagged): inner Coin<T> parsed from GraphQL `repr` (first `Coin<` .. last `>`); tokenType→curve matched case-insensitively with no short/zero-padded address normalization (a mismatch degrades to a visible read-only curveId=null row, never a silent drop).
4. Public-profile gate DECISION: SESSION positions + creator-fees hidden on `/portfolio/:walletAddress`. If read-only SESSION list on public profiles is wanted later, flip the own-wallet gate.

---

## /profile/:address public profile (C-4) — SHIPPED

Most of C-4 was ALREADY in place: `/portfolio/:walletAddress` route exists (D-0.2), PortfolioPage reads `useParams().walletAddress` → `viewAddress`/`isOwnWallet`/`viewAccount` and renders a read-only view for arbitrary wallets (restyled + own-vs-public gated in the 2e screen). Address links already existed in Comments (author → `/portfolio/:addr`), HolderList (holders + traders tabs), and LeaderboardPage (points leaders + traders rows). Remaining gaps closed here.

**Files changed (named `git add` only):**
- `frontend-app/src/App.jsx` — added `/profile/:walletAddress` alias route → same PortfolioPage (same param name, zero PortfolioPage change; own-wallet features stay gated).
- `frontend-app/src/TradeHistory.jsx` — the trader address (`t.who`) in each trade row is now a `Link` to `/portfolio/:who` (was plain text). Added `Link` import.
- `frontend-app/src/LiveFeedSidebar.jsx` — live-trade row wallet is now a `Link` to `/portfolio/:wallet`. Converted the outer row from `<button>` to a `role="button"` div (with Enter/Space keydown) so the nested address `Link` is valid HTML; `stopPropagation` keeps the row's token navigation intact.

**Gates (independently run):**
- `npm run build` → ✓ built in 20.29s, no errors.
- `npx esbuild` OK: App.jsx, TradeHistory.jsx, LiveFeedSidebar.jsx.
- ASCII: zero new em-dashes; kept pre-existing rendered glyphs (`…`, `▲`/`▼`).

**Verified:** build + syntax; the read-only public view is the existing param-driven PortfolioPage (confirmed isOwnWallet gating by reading the code). Every C-4 surface (leaderboard, comments, trade rows incl. live feed) now links addresses to the profile.
**Not verified (no browser this session):** live click-through navigation and that PortfolioPage's tabs populate for an arbitrary address end-to-end (data path is the same viewAccount used for own wallet).

**Open flags:**
1. Alias uses param name `:walletAddress` (not `:address`) so PortfolioPage needs no change; the public URL is still `/profile/0x...`. Existing links point at `/portfolio/:addr`; both routes resolve to the same view. If a canonical `/profile/...` link surface is wanted, repoint the Link targets in a follow-up.
2. Public profiles hide SESSION positions + creator-fees (own-wallet gate from the 2e screen) — intended for read-only profiles.

---

## 2g stats + 6c with C-5 corrected projection — SHIPPED

The current StatsPage shipped the OLD/wrong fee model (protocol labelled 0.50%, three-way 40/50/10 split, "$500k protocol fees -> $250k S1 pool"). This screen corrects it to the C-5 five-way model AND restyles to the Terminal design. Verified `CREATOR_GRAD_BONUS_BPS = 50` / `PROTOCOL_GRAD_BONUS_BPS = 50` in contracts-v10/sources/bonding_curve.move (ledger item 11) → the "1% of final reserve · 0.5/0.5" copy is accurate and shipped.

**Files changed (named `git add` only):**
- `frontend-app/src/StatsPage.jsx` — full rewrite (v4). C-5 corrections + Terminal restyle.

**C-5 corrections (the crux):**
- Fee model fallbacks: protocol `vol*0.0025` (0.25%, was `vol*0.005`), NEW airdrop bucket `vol*0.0025` (0.25%), creator `vol*0.004` (0.40%), LP `vol*0.001` (0.10%). S1 pool = the airdrop bucket (`d.s1PoolSui ?? airdropBucket`), no longer `protocolFees*0.5`.
- Labels: PROTOCOL FEES sub "0.25% of every trade" (was 0.50%); S1 AIRDROP POOL sub "the airdrop bucket - 0.25% of every trade" (was "50% of protocol fees").
- Fee breakdown is now FIVE-WAY (four buckets): CREATOR 40 / PROTOCOL 25 / AIRDROP BUCKET 25 / LP 10, with the referral note (protocol+airdrop each cede 0.05% for a 0.10% referrer reward; trader always pays 1.00%) and the verified graduation-bonus note (1% reserve fee: 0.5% creator / 0.5% protocol).
- Projection copy = C-5 exact: "$50M monthly volume -> $500k total fees -> $125k S1 airdrop pool (0.25% of volume)." (was "~$500k protocol fees -> ~$250k S1 pool").

**Restyle:** Terminal stat cards (accent lime-400/30 + bg lime-400/[0.05]; neutral white/[0.08] + bg white/[0.015]), Terminal fee/top-tokens cards, header card. Two-up desktop layout, `grid-cols-2` on mobile serves 6c (opens via hamburger/··· per M-4). Data-fetch logic (indexer /stats + /leaderboard/volume, suiUsd poll, 30s refresh) preserved.

**Gates (independently run):**
- `npm run build` → ✓ built in 20.47s, no errors.
- `npx esbuild src/StatsPage.jsx` OK.
- ASCII: StatsPage.jsx is now PURE ASCII (replaced all glyphs: em-dash→'-', arrow→'->', ellipsis→'...', middot→'-'). Zero non-ASCII bytes.

**Verified:** build + syntax + ASCII; grad-bonus constants checked against the Move source; C-5 numbers match the ledger and the design's own (corrected) data arrays.
**Not verified (no live indexer this session):** whether `d.protocolFeesSui`/`d.s1PoolSui` from the live indexer already represent the 0.25% buckets vs the old 0.50% combined — the C-5 model is applied to the FALLBACK math; if the indexer emits combined values under old field names, that is an indexer-side follow-up (flagged).

**Open flags:**
1. StatsPage remains English-only (no `t(lang,key)`) — it never had i18n wired (App passes `lang` but the component signature ignored it pre-reskin). Preserved existing behavior rather than expanding scope to 7-language keys for ~15 stat labels. Flag: full i18n of stats is a separate enhancement.
2. Indexer field semantics: if `/stats` returns `protocolFeesSui` as the old 0.50% combined bucket, the label "0.25%" would understate the raw value. Fallback math is C-5-correct; verify the live indexer field meaning at mainnet.
3. GRADUATION BONUSES surfaced as a verified copy line in the fee note (formula, no fabricated $ value) rather than a stat card, since no indexer field backs a bonuses total. Covers the 3c "Graduation bonuses" item honestly.

---

## 3a roadmap + 6d — SHIPPED

Ported the design 3a STYLE onto the CURRENT page's real content (D-4.2: keep repo content, not design placeholder copy).

**Files changed (named `git add` only):**
- `frontend-app/src/RoadmapPage.jsx` — Terminal restyle. Kept the 4 real phases + items + `t(lang,...)` (roadmapTitle/roadmapSub/target/backToHome). New: lime radial header card with the 4-segment progress bar + $50M target; phases in a 2-column grid (single column on mobile = 6d); Terminal card tints (complete = lime, active/upcoming = neutral); 13px checkbox squares with lime done-dot.
- Corrected the target projection to the C-5 model: "~$500,000/month total fees, ~$125,000 to the S1 airdrop pool (0.25% of volume)" (was the wrong "~$500,000 protocol fees -> ~$250,000 S1 pool").

**Gates (independently run):**
- `npm run build` → ✓ built in 19.87s, no errors.
- `npx esbuild src/RoadmapPage.jsx` OK.
- ASCII: pure ASCII (no glyphs; used hyphens/commas, no arrows/em-dashes).

**Verified:** build + syntax + ASCII; content unchanged except the C-5 projection correction; i18n keys reused (all pre-existing).
**Not verified (no browser this session):** live pixel rendering / responsive 6d stacking (uses `grid-cols-1 lg:grid-cols-2`, opens via hamburger per M-4).

**Open flags:**
1. Phase content is hardcoded (as before) — only the header/subtitle/target/back strings use i18n. Item text was English-only pre-reskin; preserved. Full i18n of phase items is a separate enhancement.
2. Phase 2 lists "Nexus/Talus 24/7 agent execution" as a pending item — the Nexus path is scoped out of v1 (Bucket B-1), but this is existing repo CONTENT (a roadmap item, not a live chip), left as-is per D-4.2. Flag for Carlos if the roadmap wording should drop "Nexus".

---

## 3b whitepaper + 6e — SHIPPED

Ported the design 3b STYLE (sticky TOC + Terminal section cards) onto the current page's rich 10-section content, FROZEN verbatim (D-4.2). Content was already fee-correct (five-way split in section 04). Delegated the restyle to a redesign-porter, then orchestrator-verified content integrity.

**Files changed (named `git add` only):**
- `frontend-app/src/WhitepaperPage.jsx` — Terminal restyle + 250px sticky TOC sidebar (desktop; `hidden lg:block`, `lg:grid-cols-[250px_1fr]`); mobile (6e) = full-width stacked sections, no sidebar. Restyled cover (lime radial hero), Section cards (kept collapse behavior + added `id` anchors + `scroll-mt-4`), bordered five-way-highlighted Tables (`overflow-x-auto` so wide tables scroll on mobile), P/H/Bullet Terminal type. TOC rows scroll to sections via `getElementById(...).scrollIntoView({behavior:'smooth'})` off a single `SECTIONS` source-of-truth array.

**Gates (independently re-run by orchestrator):**
- `npm run build` → ✓ built in 23.49s, 2239 modules, no errors.
- `npx esbuild src/WhitepaperPage.jsx` OK.
- ASCII: only new non-ASCII is the middot `·` in the two new rendered sidebar strings (design-specified, rendered-UI glyph). Zero new non-ASCII in code/comments; content glyphs untouched.
- **Content integrity (orchestrator-verified):** the porter re-typed the file via Write, so I diffed HEAD vs working after stripping classNames/JSX. Result: 10 sections intact; all frozen fingerprints present with counts matching HEAD (0.40% x2, 0.25% x4, 0.10% in curve, 0.50% x2, "500 pts flat", "2,000 bonus pts", "20% of referee", "800M (80%)", "200M (20%)", "55 Move unit tests", "Vs = 3,500", "9,000 SUI", "1 pt per 0.01 SUI spent"). Only net additions: the 10 TOC labels + scroll options + sidebar header/footer. No sentence dropped or altered.

**Verified:** build + syntax + ASCII + content-byte integrity (fingerprint + token diff).
**Not verified (no browser this session):** runtime smooth-scroll behavior (standard DOM `scrollIntoView` on statically-rendered ids; low risk) and pixel match.

**Open flags:**
1. English-only preserved — page never had `t(lang,key)` (ignores the `lang` prop). i18n of the whitepaper is a separate enhancement, out of a style-only pass (noted per D-4.2).
2. CONTENT FACTS left verbatim per the freeze but flagged for Carlos: (a) section 06 states `Vs = 3,500 SUI` / graduation threshold `9,000 SUI`, whereas CLAUDE.md lists `VS=4369` / `BASE_GRAD=12,305` — the whitepaper copy is STALE vs the contract. (b) sections 01/03/07 describe the S1 airdrop as "50% of accumulated protocol fees", which predates the airdrop-bucket model (C-5: S1 pool = the 0.25% airdrop bucket) and the C-2 policy (points + 10% NFT + 10% testnet). Both are CONTENT-correctness edits requiring Carlos sign-off, out of scope for the reskin.


---

## Post-review content fixes - whitepaper contract math + S1 bucket model, roadmap wording; indexer stats semantics note - SHIPPED

Resolves the prior entry's open flag #2 (stale section-06 curve math + "50% of protocol
fees" S1 phrasing). Carlos-approved content edits; no logic/hooks/PTB touched.

**Files changed (named `git add` only):**
- `frontend-app/src/WhitepaperPage.jsx` - 4 sentence-level content corrections (sections 01, 03, 06, 07). Style/structure untouched.
- `frontend-app/src/RoadmapPage.jsx` - 1 phase-2 item wording change.

**Exact sentences changed (before -> after):**

1. Section 06 (curve math), BONDING CURVE MECHANICS:
   - BEFORE: "SuiPump uses a constant-product pricing model with virtual reserves: Vs = 3,500 SUI and Vt = 1,073,000,000 tokens. A token graduates once its real SUI reserve reaches the graduation threshold of 9,000 SUI, or its token reserve fully drains - whichever comes first."
   - AFTER:  "SuiPump uses a constant-product pricing model with virtual reserves: Vs = 4,369 SUI and Vt = 1,073,000,000 tokens. A token graduates once its real SUI reserve reaches the graduation threshold of 12,305 SUI at $1 SUI (price-scaled: the buy entrypoint takes the live SUI price, so graduation targets a USD-stable market cap), or its token reserve fully drains - whichever comes first."
   - Vt (1,073,000,000 = 1,073M) verified correct against contract VTR - left unchanged. Section 06 states no graduation market-cap figure, so no formula was inserted.

2. Section 01 (Executive Summary), last paragraph:
   - BEFORE: "Season 1 introduces the first coordinated user-acquisition program: at season close, 50% of all accumulated protocol fees are distributed to early users proportionally to an on-chain points system."
   - AFTER:  "Season 1 introduces the first coordinated user-acquisition program: at season close, the dedicated airdrop bucket - 0.25% of every trade (25% of the 1.00% trade fee) - is distributed to early users proportionally to an on-chain points system."

3. Section 03 (Solution), S1 AIRDROP:
   - BEFORE: "At the end of Season 1, 50% of accumulated protocol fees are distributed to users in proportion to their points. Points are earned by trading, launching, referring, and holding graduated tokens."
   - AFTER:  "At the end of Season 1, the dedicated airdrop bucket - 0.25% of every trade (25% of the 1.00% trade fee) - is distributed to users in proportion to their points. Points are earned by trading, launching, referring, and holding graduated tokens."

4. Section 07 (Season 1 Airdrop), lead paragraph:
   - BEFORE: "Season 1 runs from the protocol's first transaction on mainnet through a closing date announced with at least 30 days' notice. At season close, 50% of all accumulated protocol fees are distributed to eligible wallets in proportion to their S1 points. Distribution is in liquid SUI - no vesting, no new token."
   - AFTER:  "Season 1 runs from the protocol's first transaction on mainnet through a closing date announced with at least 30 days' notice. At season close, the dedicated airdrop bucket - 0.25% of every trade (25% of the 1.00% trade fee) - is distributed to eligible wallets in proportion to their S1 points. Distribution is in liquid SUI - no vesting, no new token."
   - NOTE: no NFT/testnet allocation split percentages added (pending community poll, per instruction).

5. RoadmapPage phase 2 item:
   - BEFORE: "Nexus/Talus 24/7 agent execution"
   - AFTER:  "24/7 autonomous agent execution"
   - (Whitepaper section-09 "Nexus/Talus autonomous agent" bullet was deliberately NOT touched - out of task scope + would move a frozen fingerprint.)

**Gates (all re-run this session, output captured):**
- Fingerprint content diff (HEAD vs WT): "3,500" 1->0, "9,000 SUI" 1->0, "accumulated protocol fees" 3->0. Diffstat: WhitepaperPage 4 lines (-4/+4), RoadmapPage 1 line - no collateral. All other frozen fingerprints (0.40%, 0.25%, 0.10%, 0.50%, supply figures, points figures, 55 tests, Vt 1,073,000,000) unchanged.
- `npm run build` -> OK, built in 23.43s, 2239 modules, no errors (dynamic-import note + >500 kB chunk warning pre-existing).
- `npx esbuild src/WhitepaperPage.jsx` OK; `npx esbuild src/RoadmapPage.jsx` OK.
- ASCII purity: total non-ASCII byte count HEAD==WT (WhitepaperPage 113==113, RoadmapPage 0==0). Zero new non-ASCII; inserts use ASCII hyphens; pre-existing rendered em-dashes untouched.

**Verified:** fingerprint + build + esbuild + ASCII (proof above). Restyle-free, content-only edits.
**Not verified (no browser this session):** live pixel rendering of the reworded sentences. Presentation-only; no runtime behavior touched.

### INDEXER STATS SEMANTICS (Task 4 - READ-ONLY diagnostic, no indexer code changed)

**Where:** `/stats` endpoint = `indexer/api.js:141-152`. Values are VOLUME-DERIVED (fixed
rate x total volume), NOT event-derived from on-chain fee balances. `getGlobalStats()`
(`indexer/db.js:590`) sums `token_stats.volume_sui` -> `totalVolume`.

**How each field is computed (api.js:144-146):**
- `protocolFeesSui = totalVolume * 0.005`  -> OLD COMBINED 0.50% model (protocol + airdrop lumped). This is NOT the C-5 0.25% protocol bucket; it overstates true protocol revenue by 2x.
- `creatorFeesSui  = totalVolume * 0.004`  -> 0.40%. Correct under both the old and C-5 models.
- `s1PoolSui       = protocolFeesSui * 0.5` = totalVolume * 0.0025 -> 0.25% of volume. Numerically equal to the C-5 airdrop bucket, but derived indirectly as half of the inflated 0.50% protocol figure (correct by arithmetic coincidence, fragile).
- No dedicated `airdropFeesSui` field is emitted. StatsPage reads `d.airdropFeesSui` (StatsPage.jsx:135) but the indexer never sends it, so it always falls back to `vol*0.0025`.

**StatsPage label accuracy at mainnet:**
- "S1 AIRDROP POOL" card (StatsPage.jsx:137 `s1Pool = d.s1PoolSui ?? airdropBucket`; label line 230, sub "the airdrop bucket - 0.25% of every trade") -> ACCURATE. Indexer s1PoolSui = 0.25% of volume, matches the label.
- "PROTOCOL FEES" card (StatsPage.jsx:134 `protocolFees = d.protocolFeesSui ?? vol*0.0025`; label line 223, sub "0.25% of every trade" line 226) -> INACCURATE at mainnet. The `??` prefers the live indexer field, which returns 0.50% of volume, so the card will display DOUBLE the rate its own sub-label claims. (The intended 0.0025 fallback only fires if the indexer field is absent, which it is not.)

**VERDICT: an indexer-side change IS required for the PROTOCOL FEES field to be accurate at mainnet.** Minimal fix (proposed, NOT applied - read-only task):
- `indexer/api.js:144` -> `const protocolFeesSui = stats.totalVolume * 0.0025;` (C-5 protocol bucket).
- `indexer/api.js:146` -> DECOUPLE: `const s1PoolSui = stats.totalVolume * 0.0025;` (independent of protocolFeesSui; otherwise fixing line 144 would halve the S1 figure to 0.00125 = 0.125%).
- Optional: also emit `airdropFeesSui = stats.totalVolume * 0.0025;` in the response - StatsPage.jsx:135 already reads it, so this makes the airdrop bucket a first-class field instead of a client-side fallback.
The S1 AIRDROP POOL card needs no change on its own, but the protocol fix must not regress it - hence the decoupling above.

---

## Indexer /stats -> C-5 fee buckets; whitepaper section 09 agent-layer rename - SHIPPED

Implements the prior entry's INDEXER STATS SEMANTICS proposed fix (Task 1) and resolves
the deliberately-skipped section-09 Nexus/Talus rename (Task 2). Carlos-approved.

**Files changed (named `git add` only):** `indexer/api.js`, `frontend-app/src/WhitepaperPage.jsx`, `SHIP_LOG.md`.

**Task 1 - indexer/api.js `/stats` fee fields (api.js:143-157):**
- `protocolFeesSui` was `stats.totalVolume * 0.005` (old combined 0.50% protocol+airdrop) -> now `stats.totalVolume * 0.0025` (C-5 protocol bucket 0.25%).
- `s1PoolSui` was `protocolFeesSui * 0.5` (would have halved to 0.00125 once line 1 dropped to 0.0025) -> now `stats.totalVolume * 0.0025` computed INDEPENDENTLY (decoupled), so it stays at 0.25% of volume regardless of the protocol line.
- NEW field `airdropFeesSui = stats.totalVolume * 0.0025` emitted in the response (StatsPage.jsx:135 already reads `d.airdropFeesSui` and previously fell back to `vol*0.0025`; it is now a first-class field).
- Added a 4-line comment: values are volume-derived approximations under the C-5 five-way split (40/25/25/10 of the 1.00% fee) and ignore referral cessions (protocol + airdrop each cede 0.05% on referred trades); event-derived fee accounting is a post-mainnet enhancement.
- No other field or route touched.

**Task 1 grep proof (no other file depends on the old 0.50% semantics):**
Searched repo `*.{js,jsx}` for `protocolFeesSui|s1PoolSui|airdropFeesSui|0.005|0.50%`:
- `suipump-nexus-tools/bridge.js:1693-1694` - computes its OWN `protocolFeesSui`/`airdropFeesSui` from mist balances (`Number(...Mist)/1e9`) on a different route; does not read the indexer's volume-derived field. UNAFFECTED.
- `frontend-app/src/App.jsx:180` and `S1AirdropCounter.jsx:47` - consume `s1PoolSui`. Value is IDENTICAL before/after (old `0.005*0.5` = new `0.0025` = 0.25% of volume). No regression.
- `frontend-app/src/StatsPage.jsx:134-137` - consume all three with `?? vol*0.0025` fallbacks; the fix makes `protocolFeesSui` match its "0.25% of every trade" card label and promotes `airdropFeesSui` to a real field. Now accurate.
- `frontend-app/src/AirdropPage.jsx:46` - static prose "0.50% goes to the protocol"; does NOT read the field (independent copy, not a code dependency). OUT OF SCOPE this session; flagged to Carlos as a separate stale-copy item.
- Runner (`agent-runner/strategy.js`) - zero references (no grep hit).
- No consumer depended on the field literally equaling 0.50% of volume. Safe.

**Task 2 - WhitepaperPage.jsx section 09 (Roadmap, PHASE 2 bullet, line 306):**
- BEFORE: "Nexus/Talus autonomous agent -- 24/7 server-side strategy execution"
- AFTER:  "24/7 autonomous agent layer -- server-side strategy execution"
- (em-dash preserved as the existing rendered glyph.) Dropped the now-duplicate "24/7" from the trailing clause so it does not read "24/7 ... 24/7" - the minimal grammar adjustment the rename forces. Section describes a roadmap bullet, not execution routing, so the alternate "agent runner with per-user session keys" rewording did not apply. "Nexus/Talus" verified to occur exactly ONCE in the file (line 306, section 09) before editing; nothing else in section 09 or any other section changed.

**Incidental gate-compliance fix (same file, disclosed):** `indexer/api.js` carried 2 pre-existing non-ASCII bytes - a `check-glyph` in two `console.log` startup strings (lines 727 + 921 post-edit). Hard rule 14 (.js must be pure ASCII) is enforced by a blocking whole-file gate hook that fired on my edit. Converted both `check-glyph` -> `OK` (cosmetic log text, behavior-neutral) so the file passes. These bytes predate this session (non-ASCII count was 6==6 HEAD vs WT before the fix); not introduced by Task 1.

**Gates (re-run this session, output captured):**
- Whitepaper fingerprint diff: "Nexus" 1->0; "24/7" 1->1 (unchanged); non-ASCII 113==113; diffstat 1 line (-1/+1). All other fingerprints match HEAD.
- `npx acorn --ecma2023 --module indexer/api.js` -> PARSE OK. (NOTE: the repo's PostToolUse gate hook runs acorn WITHOUT `--module`, so it emits a false "import/export only with sourceType: module" error on this and every ESM `.js` file; the file is valid ESM - 13 import/export, 0 require - and passes the correct `--module` gate the task specified.)
- `npx esbuild src/WhitepaperPage.jsx` -> parse OK.
- `npm run build` (frontend) -> OK, built in 19.58s, 2239 modules (dynamic-import note + >500 kB chunk warning pre-existing).
- ASCII: indexer/api.js now 0 non-ASCII; WhitepaperPage.jsx 113==113 (zero new).

**Verified:** grep dependency proof + fingerprint + acorn(--module) + esbuild + build + ASCII (all output captured). `/stats` change is a pure numeric-rate + additive-field edit; `s1PoolSui`/`protocolFeesSui` semantics traced through every consumer.
**Not verified (no live indexer/browser this session):** the deployed `/stats` JSON at runtime and StatsPage rendering the corrected PROTOCOL FEES value. Presentation/number-only; no control flow changed.

**Open flags:**
1. `AirdropPage.jsx:46` prose still says "0.50% goes to the protocol" - stale vs the C-5 0.25% protocol bucket. Independent copy (not tied to the /stats field). Needs a separate Carlos-approved content pass; not touched here (out of task scope).
2. Repo gate hook runs acorn in script mode for `.js`, producing false failures on ESM indexer files. Not a code bug; consider passing `--module` (or auto-detecting) in `.claude/hooks/gates.py` so ESM `.js` edits stop tripping the block.
