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
