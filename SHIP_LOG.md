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

