# REDESIGN STATUS AUDIT - 2026-07-17

Read-only audit of the Terminal-direction redesign migration, taken after the
V13/V14 security work interrupted it. Sources of truth: design/RECONCILIATION_LEDGER.md
(decisions + coverage, last updated 2026-07-13), design/SuiPump_Redesign.dc.html
(pixel truth for STYLE), repo code under frontend-app/src (truth for LOGIC).

NOTE ON SOURCES: the entire design/ directory is gitignored (.gitignore line 73)
and none of its files are tracked - the ledger, the redesign README, and the
design HTML exist only on the dev machine (plus the mobile pair
MOBILE_README.md / SuiPump_Mobile_dc.html). This document snapshots their state
into the repo. The ledger's own status block is dated 2026-07-13 and has not
been updated since; this audit verified it against code and found it accurate.

## Per-screen status

| Screen | Status | Evidence |
|---|---|---|
| 2a brand | PORTED | Flame.jsx is the single render source for the v2 TORCH mark (four cuts AURORA/SOLID/STRIKE/PULSE + FlameLockup); full token set in tailwind.config.js:2-52; terminal chrome complete in App.jsx (header lockup :1141, ticker, network banner, footer, mobile 5a tab bar :1872). The two-tongue flame still drawn in the design HTML is SUPERSEDED by ledger B-LOGO - mismatch with the HTML is the ruling, not a gap. |
| 1b board | PORTED | App.jsx v19-terminal-reskin: C-8 filter tabs + 9-option sort (:1448-1596), C-9 slim hero (:1501), COMMUNITY CROWN card (:404/:424), M-3 star column, per-package drain caption via curveShapeFor (:331). |
| 2b token | PORTED (2 parked flags) | TokenPage.jsx terminal 2-col layout (:2154-2351), mobile 5b thumb bar + bottom sheet (:2354-2375). Parked: comment upvotes (needs indexer support); AUTOMATION chips -> strategies-modal link. |
| 2c launch | NOT STARTED (visual) | LaunchModal.jsx has zero design tokens, pre-port modal shell (:674-675), no reskin commit. All frozen logic intact and verified: Epoch authorize->redirect->return (:197-336), NameCap ownership verify (:237-264), deterministic epochsui.com URL (:182-188), 7 SUI fee split 3 Epoch / 2 launch / 2 surcharge (:477/:583-599). First in the ledger's REMAINING queue; SUPERVISED. |
| 2d agent | NOT STARTED (visual) | AgentPage.jsx still pre-redesign: violet/Space Grotesk hero, POWERED BY TALUS chip (:3156-3162), ~25 user-facing Nexus strings. A5 signer badge PRESENT and CORRECT (see decisions below). No runner chip of either name exists yet; NAUTILUS chip has no data source (attestation not persisted). SUPERVISED, "most delicate". |
| 2e portfolio | PORTED | Commit 699ce276. All C-6 requirements verified: GET /agent/sessions?owner= with GraphQL SessionOpened fallback (useSessionPositions.js:42-65), parked Coin<T> DOF probe (:96-128), SESSION tag rows (PortfolioPage.jsx:569-606), sells via /session-sell with signed owner auth, never userSell (:150-165); own-wallet + holdings-tab gated (:1361-1364). |
| /profile/:address | PORTED | Route alias App.jsx:1827 over the /portfolio/:walletAddress primary (:1823); PortfolioPage read-only via useParams + isOwnWallet gating (:998-1005, :1362-1367). Linked from LeaderboardPage rows (:174/:235), Comments author names (:230/:241/:293), HolderList (:171/:197/:241), TradeHistory (:51), LiveFeedSidebar (:203). Links target the /portfolio primary route - same page, fine. |
| Leaderboard | PARTIAL | Separate route yes (App.jsx:1821); Crown rename done. NOT restyled (pre-redesign idiom, last substantive commit 2026-06-26). POLICY VIOLATION in copy: LeaderboardPage.jsx:169 says testnet points "carry to the mainnet airdrop" - contradicts settled C-2 (testnet points eliminated). |
| Airdrop | NOT STARTED | Route separate (App.jsx:1818) but page untouched since 2026-05-11. Stale fee model: "0.50% goes to the protocol / 50% of protocol fees" (AirdropPage.jsx:46-49) and S1AirdropCounter.jsx:104 + its SSE math (:78, protocol_fee * 0.5) - all pre-C-5. S1 composition (10% NFT holders + 10% testnet users) appears nowhere. Earn table has not had its mainnet-numbers pass. Ledger also flags this exact prose (:212). |
| 2g stats | PORTED | StatsPage.jsx v4 (commit 84de77f1): projection string exact - "$50M monthly volume -> $500k total fees -> $125k S1 airdrop pool (0.25% of volume)" (:306); five-way split cards (:226-282). No rendered label anywhere calls $250k the S1 pool - zero $250k strings in shipped copy. |
| 3a roadmap | PORTED | RoadmapPage.jsx Terminal (3a/6d), content preserved, C-5 numbers correct (:164). |
| 3b whitepaper | PORTED | WhitepaperPage.jsx Terminal + sticky TOC (commit 40ee0dcb); C-5-correct fee copy (:159/:253); content fixes shipped 2026-07-13. |
| 3c checklist | ONGOING GATE | 66 items in 9 groups in the design HTML (:1463-1473). Ledger rule: tick coverage items per screen session. |
| Game page | UNTOUCHED - CORRECT | GamePage.jsx keeps its own styling; git history is gameplay fixes only. As mandated. |

## Bucket B/C decision verification

- NEXUS RUNNER -> AGENT RUNNER: neither chip exists yet (grep zero hits for
  both). The rename is not violated but not implemented - and AgentPage.jsx
  still renders ~25 Nexus/Talus-branded strings (:3165, :3370, :3380,
  :3428-3455, :3491-3611) that the 2d port must replace. 2d scope.
- King of the Hill -> COMMUNITY CROWN: DONE in code. Zero case-insensitive
  hits for "King of the Hill" in frontend-app/src; COMMUNITY CROWN rendered in
  App.jsx:404/:424 and keyed in i18n.js:67. (The design HTML itself still says
  "king of the hill" at :1209/:1464 - style source only, not shipped.)
- A5 signer badge: PRESENT, MANDATORY, and CORRECT under the new custody
  model. The amber "SIGNER: SHARED AGENT WALLET" badge (AgentPage.jsx:1549-1558)
  is driven by on-chain ground truth, not bridge state: loadSession reads the
  AgentSession object's own session_address field and compares it to the shared
  wallet 0x877af0fae3fa4f8ea936943b59bcd66104f67cf1895302e97761a28b3c3a5906
  (:1037-1038). With the shared wallet retired and zero live fallback sessions,
  session_address never equals it, so the badge correctly never shows; it
  cannot false-positive on a per-user-key session and it survives refresh. It
  would still show truthfully on any surviving legacy session - exactly the
  population the SUIPUMP_LEGACY_SIGNER drain path exists for. Two residual
  items for the 2d session: (1) the doOpen Turnkey-failure fallback still
  defaults sessionAddress to the shared wallet (:1088, :1108-1114) - with the
  legacy signer permanently disabled this creates a session no signer can
  execute (bridge turnkeyKeyForSession throws); the fallback open should
  hard-fail like enclave mode. (2) The badge body copy still describes the old
  live-fallback world; under retired custody it should say the legacy session
  can no longer trade - close/revoke and withdraw.
- TradeTicket universal-trading footnote: ABSENT - confirmed. Zero footnote
  text in TokenPage; UNIVERSAL_TRADING_ENABLED = false (AgentPage.jsx:835) and
  the only UI block is gated behind it; the on-chain mechanism is preserved
  hidden per D-8.8.
- NAUTILUS ATTESTED chip conditional: NOT IMPLEMENTED, and blocked on a data
  gap: attestation is only a transient flag during doOpen (attested =
  signerMode === 'enclave', :1090/:1107, routed through open_and_share_attested
  :1151) and is not persisted - after refresh the UI cannot distinguish an
  attested session. The chip needs a persistent source (e.g. the
  SessionAttested event) before it can be conditional. 2d scope.
- Leaderboard + Airdrop separate routes: YES - /leaderboard (App.jsx:1821) and
  /airdrop (:1818), no merged hub; header REWARDS tab routes to /airdrop with
  leaderboard in the overflow nav per M-1 default. Restyle pending on both.
- Public /profile/:address: CONFIRMED rendering and linked from all three
  surfaces (leaderboard, comments, trades/holders) - see table row.
- Launch modal Epoch flow: EXACTLY preserved - see 2c row for the full path
  cites. The port is styling-only around a frozen flow (C-7/M-2).
- Portfolio session-parked positions: CONFIRMED end to end - see 2e row.
- Stats projections: CORRECT, and the forbidden "$250k as S1 pool" label
  appears nowhere. The only stale S1 copy left in the app is the airdrop
  surface (pre-C-5 "50% of protocol fees"), itemized above.
- CommunityTakeoverPanel vs shipped escrow-CTO: PORTED, terminal-styled
  (:371-373), full V13 lifecycle present - propose with escrowed Coin<T> stake
  at 1% circulating threshold (:261-283, :188), vote/unvote (:285-327), manual
  RECLAIM MY ESCROW fallback (:347-363, :471) with the auto-sweeper noted in
  copy, 72h window as a live countdown from on-chain deadline_ms (:429).
  Correct executeTx build-then-execute, sharedObjectRef with fallback, BigInt
  discipline, full untruncated proposer address. Gaps: (1) the quorum bar
  recomputes 25% of circulating client-side (:187) instead of reading the
  on-chain TakeoverProposal.quorum_target snapshot (accessor
  proposal_quorum_target, bonding_curve.move:2232) - the TakeoverProposed event
  and the indexer /token/:id/takeover route do not surface it, so if supply
  moves after propose the displayed progress can disagree with the resolution
  threshold; surfacing quorum_target through the indexer is the fix. (2) The
  design's dynamic "CTO vote: none active" idle footnote is not implemented -
  the panel returns null when idle (:203).

## Every remaining gap, itemized

Blocking copy/policy fixes (small, shippable independently):
1. LeaderboardPage.jsx:169 - delete/replace the "points carry to the mainnet
   airdrop" sentence (contradicts settled S1 policy: testnet points eliminated).
2. AirdropPage.jsx:46-49 - replace the 0.50%-protocol / 50%-of-protocol-fees
   model with the C-5 five-way split (airdrop bucket = 0.25% of volume).
3. S1AirdropCounter.jsx:104 label and :78 SSE accumulation (protocol_fee * 0.5)
   - same C-5 correction, code not just copy.

2c launch session (next per ledger order, SUPERVISED):
4. Reskin LaunchModal to the 2c terminal page language + 5c 4-step mobile
   presentation. Zero flow changes: Epoch sequence, fee split, and the 4
   existing steps are frozen.

2d agent session (SUPERVISED, most delicate):
5. Full terminal restyle of AgentPage (violet -> lime, drop Space Grotesk and
   the POWERED BY TALUS chip).
6. Replace ~25 user-facing Nexus/Talus strings; add the AGENT RUNNER - 24/7
   chip (never "Nexus").
7. NAUTILUS TEE - ATTESTED chip, conditional on persisted attestation - needs
   a data source first (SessionAttested event or session field).
8. Preserve the A5 signer badge exactly (logic already correct); refresh its
   body copy for retired custody.
9. Fix the doOpen Turnkey-failure fallback to hard-fail instead of creating a
   dead session bound to the retired shared wallet.
10. AgentPage renders truncated DAG ids (NEXUS_DAG[k].slice(0, 18), :3428-3434)
    - display-only but violates the full-identifier rule; render full ids or
    remove with the Nexus copy.

Leaderboard/airdrop session (GATED on the testnet-airdrop poll + C-10 mobile
decision):
11. Restyle LeaderboardPage and AirdropPage to the 2f-split visual language
    (C-1: separate routes stay).
12. Airdrop content pass: S1 composition (10% NFT holders + 10% testnet
    users), earn-table mainnet numbers with live-vs-at-mainnet captions (C-3),
    testnet-points-eliminated consistency.

Parked 2b flags:
13. Comment upvotes - blocked on indexer support.
14. AUTOMATION chips -> strategies-modal link.

Non-screen items:
15. Indexer: surface TakeoverProposal quorum_target on /token/:id/takeover so
    the CTO quorum bar can read the authoritative snapshot.
16. Implement the dynamic "CTO vote: none active" idle footnote on the token
    page (design intent; panel currently renders nothing when idle).
17. Ledger hygiene: status block frozen at 2026-07-13 - update after each
    session; internal inconsistency at D-5 ("6 languages" twice) vs B-8 (seven:
    EN, ZH, PT, KO, VI, RU, ES).
18. 3c: tick coverage items per screen as sessions complete.

## Recommended finish order

1. Copy/policy hotfixes (items 1-3) - independent of any screen session, small
   diffs, and item 1 is a public policy contradiction visible today.
2. 2c launch + 5c (item 4) - first in the ledger queue, lowest risk: pure
   reskin around a frozen, verified flow.
3. 2d agent + 6a (items 5-10) - the delicate one. Do the restyle and Nexus
   rename together; land the SessionAttested persistence (7) and the dead-open
   fix (9) in the same session since both touch doOpen/loadSession.
4. Leaderboard + airdrop + 6b (items 11-12) - once the poll result and C-10
   decision land. If that gate drags, items 1-3 have already removed the wrong
   copy.
5. Parked 2b flags (13-14) when indexer support ships; indexer quorum_target
   (15) and the idle CTO footnote (16) can ride any indexer/token-page touch.
6. Keep 17-18 as standing hygiene per session.
