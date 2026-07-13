// WhitepaperPage.jsx
import React, { useState } from 'react';
import { ArrowLeft, ChevronDown, ChevronUp } from 'lucide-react';

// Single source of truth for the TOC sidebar. Every entry MUST stay in sync
// (number + title) with a <Section> rendered below.
const SECTIONS = [
  { number: '01', title: 'Executive Summary' },
  { number: '02', title: 'Problem' },
  { number: '03', title: 'Solution' },
  { number: '04', title: 'Fee Structure' },
  { number: '05', title: 'Token Model' },
  { number: '06', title: 'How It Works' },
  { number: '07', title: 'Season 1 Airdrop' },
  { number: '08', title: 'Architecture' },
  { number: '09', title: 'Roadmap' },
  { number: '10', title: 'Disclaimers' },
];

function Section({ number, title, children }) {
  const [open, setOpen] = useState(true);
  return (
    <div
      id={`wp-${number}`}
      className="scroll-mt-4 rounded-2xl border border-white/[0.08] bg-white/[0.015] p-5"
    >
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-2.5 text-left"
      >
        <span className="text-[10px] font-mono text-white/25">{number}</span>
        <span className="text-[13px] font-mono font-bold text-white tracking-[0.06em]">{title}</span>
        {open
          ? <ChevronUp size={14} className="ml-auto text-white/25 shrink-0" />
          : <ChevronDown size={14} className="ml-auto text-white/25 shrink-0" />}
      </button>
      {open && <div className="mt-3.5 space-y-3">{children}</div>}
    </div>
  );
}

function P({ children }) {
  return <p className="text-xs font-mono text-white/55 leading-relaxed">{children}</p>;
}

function H({ children }) {
  return <div className="pt-2 text-[10px] font-mono font-bold text-lime-400/70 tracking-[0.16em]">{children}</div>;
}

function Table({ rows, cols }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-white/[0.09]">
      <table className="w-full text-[10.5px] font-mono border-collapse">
        <thead>
          <tr className="bg-white/[0.04]">
            {cols.map((c, i) => (
              <th key={i} className={`text-left px-3.5 py-2.5 font-semibold tracking-wider ${i === 1 ? 'text-lime-400' : 'text-white/35'}`}>{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, ri) => (
            <tr key={ri} className="border-t border-white/[0.05]">
              {row.map((cell, ci) => (
                <td key={ci} className={`px-3.5 py-2.5 ${ci === 1 ? 'text-lime-400/90' : 'text-white/55'}`}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Bullet({ children }) {
  return (
    <div className="flex gap-2.5 text-xs font-mono text-white/55">
      <span className="mt-[6px] h-1 w-1 rounded-full bg-lime-400/60 shrink-0" />
      <span className="leading-relaxed">{children}</span>
    </div>
  );
}

export default function WhitepaperPage({ onBack }) {
  const scrollToSection = (number) => {
    document.getElementById(`wp-${number}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  return (
    <div>
      <button
        onClick={onBack}
        className="flex items-center gap-2 text-xs font-mono text-white/40 hover:text-white mb-6 transition-colors"
      >
        <ArrowLeft size={12} /> BACK TO HOME
      </button>

      <div className="lg:grid lg:grid-cols-[250px_1fr] lg:gap-4">

        {/* TOC sidebar - hidden below lg (6e mobile: stacked, no sidebar) */}
        <aside className="hidden lg:block">
          <div className="sticky top-4 self-start rounded-2xl border border-white/[0.08] bg-white/[0.015] p-3 flex flex-col gap-0.5">
            <div className="px-2.5 pt-2 pb-3 text-[9px] font-mono font-bold text-white/35 tracking-[0.16em]">
              WHITE PAPER · S1 · v3.0 · 2026
            </div>
            {SECTIONS.map(s => (
              <button
                key={s.number}
                onClick={() => scrollToSection(s.number)}
                className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg border border-transparent hover:border-white/10 hover:bg-white/[0.02] cursor-pointer text-left transition-colors"
              >
                <span className="text-[9.5px] font-mono text-white/25">{s.number}</span>
                <span className="text-[11px] font-mono font-semibold text-white/70">{s.title}</span>
              </button>
            ))}
            <div className="px-2.5 pt-3 pb-1.5 text-[8.5px] font-mono text-white/[0.22] leading-relaxed">
              TESTNET PREVIEW · CONTRACTS UNAUDITED · NOT FINANCIAL ADVICE
            </div>
          </div>
        </aside>

        {/* Content column */}
        <div className="space-y-4 min-w-0">

          {/* Cover */}
          <div
            className="rounded-2xl border border-lime-400/25 p-9 text-center"
            style={{ background: 'radial-gradient(circle at 50% 0%, rgba(132,204,22,.12), transparent 60%), rgba(255,255,255,.015)' }}
          >
            <div className="text-4xl font-bold font-mono text-white mb-2" style={{ fontFamily: "'Space Grotesk', sans-serif" }}>
              SUIPUMP<span className="text-lime-400">.</span>
            </div>
            <div className="text-sm font-mono text-white/50 mb-1">Permissionless Token Launchpad on Sui</div>
            <div className="text-xs font-mono text-white/25">White Paper · Season 1 · Version 3.0 · 2026</div>
            <div className="mt-4 border-t border-white/5 pt-4 text-[10px] font-mono text-white/[0.18]">
              TESTNET PREVIEW · CONTRACTS UNAUDITED · NOT FINANCIAL ADVICE
            </div>
          </div>

          <Section number="01" title="Executive Summary">
            <P>SuiPump is a permissionless bonding-curve token launchpad built on the Sui blockchain. It enables anyone to launch a fungible token in two wallet signatures, with price discovery happening automatically through an on-chain constant-product curve. Every launched token starts at a fair price, has no pre-mine, and graduates to a decentralized exchange once its bonding curve drains.</P>
            <P>SuiPump improves on existing Solana-based launchpads across several dimensions: lower total fees with a larger creator share, an LP fee that deepens curve liquidity over time, a dedicated airdrop fee bucket that funds community rewards, a transferable creator-ownership model, an optional on-chain referral program, and an optional dev-token vesting lock that lets creators commit their launch allocation to a public, immutable unlock schedule.</P>
            <P>Season 1 introduces the first coordinated user-acquisition program: at season close, the dedicated airdrop bucket - 0.25% of every trade (25% of the 1.00% trade fee) - is distributed to early users proportionally to an on-chain points system.</P>
          </Section>

          <Section number="02" title="Problem">
            <H>EXISTING LAUNCHPADS EXTRACT VALUE FROM CREATORS</H>
            <P>The leading Solana launchpad charges 1.25% on every trade but gives creators only 0.30% — just 24% of the total fee. Builders who drive volume are compensated as an afterthought.</P>
            <H>LIQUIDITY COLLAPSES AT GRADUATION</H>
            <P>Most launchpads offer no mechanism to seed post-graduation liquidity. When a token migrates to a DEX with shallow liquidity, price impact on the first trades is severe, holders dump immediately, and the token rarely recovers.</P>
            <H>NO PROTECTION AGAINST CREATOR DUMPS</H>
            <P>A creator who buys a large share of supply at launch can sell into the first wave of community buyers — a rug in everything but name. Launchpads rarely give creators a credible, on-chain way to signal long-term commitment.</P>
            <H>EARLY USERS ARE NOT REWARDED</H>
            <P>Launchpads accumulate protocol fees from the very first trade but have no mechanism to redistribute value back to users who took the early adoption risk.</P>
          </Section>

          <Section number="03" title="Solution">
            <H>CREATOR-FIRST FEE STRUCTURE</H>
            <P>SuiPump charges 1.00% total per trade — lower than the incumbent. The fee is split five ways. Without a referral: creator 0.40%, protocol 0.25%, airdrop bucket 0.25%, and 0.10% retained in the curve as LP liquidity. With a referral, the protocol and airdrop shares each contribute 0.05% to fund a 0.10% referral reward.</P>
            <H>LP FEES RETAINED IN THE CURVE</H>
            <P>The 0.10% LP share accumulates inside the curve's SUI reserve. Every trade deepens liquidity for all participants. At graduation, this migrates into the DEX pool alongside the 200M tokens reserved for liquidity.</P>
            <H>DEDICATED AIRDROP BUCKET</H>
            <P>A 0.25% slice of every trade fee is routed to a per-curve airdrop balance. This is a separate on-chain pool, distinct from protocol revenue, earmarked for community reward programs.</P>
            <H>OPTIONAL DEV-TOKEN VESTING</H>
            <P>At launch — or at any time afterward — a creator can lock tokens into an on-chain VestingLock. The lock's terms are immutable once set: no function can shorten or cancel it. This gives a creator a credible, verifiable way to commit their allocation and signal long-term alignment with holders.</P>
            <H>TRANSFERABLE CREATORCAP</H>
            <P>Each launched token is associated with a CreatorCap — a Move object that confers the right to claim creator fees and update payout configuration. The cap is transferable and supports up to 10 payout recipients with custom percentage splits.</P>
            <H>S1 AIRDROP</H>
            <P>At the end of Season 1, the dedicated airdrop bucket - 0.25% of every trade (25% of the 1.00% trade fee) - is distributed to users in proportion to their points. Points are earned by trading, launching, referring, and holding graduated tokens.</P>
          </Section>

          <Section number="04" title="Fee Structure">
            <H>TRADING FEES (1.00% PER TRADE)</H>
            <Table
              cols={['', 'No referral', 'With referral']}
              rows={[
                ['Total trade fee', '1.00%', '1.00%'],
                ['Creator share', '0.40%', '0.40%'],
                ['Protocol share', '0.25%', '0.20%'],
                ['Airdrop bucket', '0.25%', '0.20%'],
                ['LP / liquidity share', '0.10% in curve', '0.10% in curve'],
                ['Referral reward', '—', '0.10%'],
              ]}
            />
            <P>The 1.00% total never changes. A referral does not increase the fee a trader pays — it reallocates 0.10% out of the protocol and airdrop shares to reward the referrer. A referral address may not be the token's creator.</P>
            <H>LAUNCH & COMMENT FEES</H>
            <Table
              cols={['Fee', 'Amount', 'Purpose']}
              rows={[
                ['Launch fee', '2 SUI', 'Anti-spam; routed to protocol'],
                ['Comment fee', '0.001 SUI', 'Anti-spam on on-chain comments'],
              ]}
            />
            <H>GRADUATION FEES (1.00% OF FINAL RESERVE)</H>
            <Table
              cols={['Recipient', 'Share']}
              rows={[
                ['Creator bonus', '0.50%'],
                ['Protocol bonus', '0.50%'],
                ['Total graduation fee', '1.00%'],
              ]}
            />
            <P>Trading fees are paid and claimed in SUI. Creator fees are held in each curve's creator_fees balance, claimable only by the CreatorCap holder. Protocol and airdrop fees are held in separate balances, each claimable via AdminCap. Graduation bonuses are transferred automatically — creator bonus goes directly to the creator's address, protocol bonus is deposited into the protocol fee pool.</P>
          </Section>

          <Section number="05" title="Token Model">
            <Table
              cols={['Allocation', 'Supply', 'Notes']}
              rows={[
                ['Bonding curve (public sale)', '800M (80%)', 'Minted at launch, sold via the curve'],
                ['DEX liquidity (graduation)', '200M (20%)', 'Minted at graduation, paired with SUI'],
                ['Team / VC / pre-mine', '0%', 'None. Every token enters via public bonding curve'],
              ]}
            />
            <P>Total supply is 1 billion tokens with 6 decimal places. The 200M LP allocation does not exist until graduation — it is minted by the contract only when the curve fully drains, then paired with the accumulated SUI reserve and deposited into a DEX pool.</P>
            <H>DEV-TOKEN VESTING LOCK</H>
            <P>Any holder may lock tokens into an immutable on-chain VestingLock. A lock specifies an amount, a vesting mode, and a duration; once created, none of these can be altered. The lock is non-transferable — only the original creator of the lock can claim from it.</P>
            <Table
              cols={['Vesting mode', 'Unlock behavior']}
              rows={[
                ['Cliff', '0% until the end, then 100% at once'],
                ['Linear', 'Unlocks continuously across the duration'],
                ['Monthly', 'Unlocks in equal 30-day steps (requires ≥ 30 days)'],
              ]}
            />
            <Table
              cols={['Available durations']}
              rows={[['7 days'], ['30 days'], ['180 days'], ['365 days']]}
            />
            <P>A creator may lock their launch dev-buy directly within the launch transaction, or lock additional tokens at any later point. Claiming releases only the portion vested so far, tracked on-chain so a lock can never release more than it holds.</P>
          </Section>

          <Section number="06" title="How It Works">
            <H>BONDING CURVE MECHANICS</H>
            <P>SuiPump uses a constant-product pricing model with virtual reserves: Vs = 4,369 SUI and Vt = 1,073,000,000 tokens. A token graduates once its real SUI reserve reaches the graduation threshold of 12,305 SUI at $1 SUI (price-scaled: the buy entrypoint takes the live SUI price, so graduation targets a USD-stable market cap), or its token reserve fully drains — whichever comes first.</P>
            <H>LAUNCH FLOW</H>
            <P>Launching a token requires two wallet signatures. Tx 1: a fresh Move module is published with the creator's chosen name, symbol, description, and icon. Tx 2: the creator configures the curve — pays the 2 SUI launch fee, sets payout splits, picks a graduation venue, sets an optional anti-bot delay, and optionally executes a dev-buy. If the creator chooses, the dev-buy tokens are routed directly into a VestingLock within the same atomic transaction.</P>
            <H>GRADUATION VENUE</H>
            <P>At launch the creator chooses where the token graduates: Cetus, DeepBook, or Turbos. The choice is stored on-chain and is immutable after creation.</P>
            <H>ANTI-BOT DELAY</H>
            <P>A creator may set an optional anti-bot window of 0, 15, or 30 seconds. During the window only the creator can trade, giving a launch a brief protected period before it opens to the public.</P>
            <H>METADATA UPDATE WINDOW</H>
            <P>For 24 hours after launch the creator may make a single one-time update to the token's metadata. After 24 hours, or after one update, the metadata is fixed.</P>
            <H>TAIL-CLIP PROTECTION</H>
            <P>When a buy order would purchase more tokens than remain, SuiPump clips the order to exactly the remaining supply, re-prices the SUI cost, and refunds the excess. This prevents the curve from stalling with dust and ensures clean graduation.</P>
            <H>GRADUATION</H>
            <P>At graduation the contract automatically: (1) mints 200M LP tokens, (2) transfers 0.5% of the reserve to the creator as a graduation bonus, (3) deposits 0.5% into the protocol fee pool, (4) permanently freezes the token's metadata so its on-chain identity can never change, and (5) routes the remaining reserve and LP tokens for DEX pool composition. All transfers are internal — no return values, no front-running opportunity. Anyone can trigger graduation, but they only pay gas.</P>
            <H>EMERGENCY PAUSE</H>
            <P>Protocol administrators can pause trading on an individual curve via the AdminCap. While paused, both buys and sells abort. This is a safety control for responding to anomalous activity on a specific token.</P>
          </Section>

          <Section number="07" title="Season 1 Airdrop">
            <P>Season 1 runs from the protocol's first transaction on mainnet through a closing date announced with at least 30 days' notice. At season close, the dedicated airdrop bucket - 0.25% of every trade (25% of the 1.00% trade fee) - is distributed to eligible wallets in proportion to their S1 points. Distribution is in liquid SUI — no vesting, no new token.</P>
            <H>POINTS STRUCTURE</H>
            <Table
              cols={['Action', 'Points']}
              rows={[
                ['Buy on any SuiPump curve', '1 pt per 0.01 SUI spent'],
                ['Sell on any SuiPump curve', '0.5 pts per 0.01 SUI received'],
                ['Launch a token', '500 pts flat'],
                ['Token reaches 25% graduation', '250 bonus pts (creator)'],
                ['Token graduates to DEX', '2,000 bonus pts (creator)'],
                ['Refer a new launcher', "20% of referee's launch points"],
                ['Early adopter (first 1,000 wallets)', '2× multiplier on all points'],
              ]}
            />
            <H>ELIGIBILITY</H>
            <Bullet>Minimum 100 points required</Bullet>
            <Bullet>Sybil clusters identified via on-chain pattern analysis will be excluded</Bullet>
            <Bullet>Anti-sybil methodology published before snapshot</Bullet>
            <Bullet>7-day community challenge period after snapshot</Bullet>
          </Section>

          <Section number="08" title="Architecture">
            <H>SMART CONTRACTS</H>
            <P>Implemented in Move, deployed on Sui. Core module: suipump::bonding_curve — handles curve creation, trading, fee accounting, the airdrop bucket, referral routing, graduation, dev-token vesting, and the CreatorCap ownership model. Each token launch publishes a new independent Move package derived from a coin template, patched client-side via @mysten/move-bytecode-template.</P>
            <H>VERSIONING</H>
            <P>The contract has evolved across several deployed versions. Earlier versions remain on-chain permanently so that every token ever launched stays tradeable; the frontend dispatches each trade to the package version that token belongs to. New launches use the current version.</P>
            <H>SECURITY MODEL</H>
            <P>Graduation is front-run safe: the graduate() function performs all transfers internally with no return values. The TreasuryCap is permanently locked inside the Curve object — no additional tokens can ever be minted. Creator authority lives in a transferable CreatorCap. Protocol authority lives in an AdminCap, which gates protocol-fee claims, airdrop-bucket claims, and the per-curve emergency pause. Vesting locks are immutable and non-transferable. The test suite covers the full contract — 55 Move unit tests and a 59-test arithmetic harness, all passing. An independent third-party audit is conducted before mainnet.</P>
            <H>OBJECT MODEL</H>
            <P>Each launched token has its own isolated Curve&lt;T&gt; shared object. A failure or exploit in one token's curve cannot affect any other. Creator authority lives in a transferable CreatorCap owned object. Protocol authority lives in an AdminCap (multisig before mainnet). Each vesting lock is a separate shared VestingLock object claimable only by its beneficiary.</P>
            <H>OFF-CHAIN INDEXER</H>
            <P>An off-chain indexer subscribes to on-chain events and serves trade history, holder data, charts, and protocol statistics. The frontend queries the indexer first and falls back to direct RPC reads, so the application functions even if the indexer is unavailable.</P>
            <H>FRONTEND</H>
            <P>React + Vite + @mysten/dapp-kit. Connects to any Sui-compatible wallet. The launch flow operates entirely client-side: bytecode is patched in the browser using WebAssembly and published directly from the user's wallet.</P>
          </Section>

          <Section number="09" title="Roadmap">
            <H>PHASE 1 — TESTNET (COMPLETE)</H>
            <Bullet>Move contracts deployed and verified — 55 Move unit tests, 59-test arithmetic harness, all passing</Bullet>
            <Bullet>Browser-based two-signature token launch with dev-buy and optional vesting lock</Bullet>
            <Bullet>Five-way fee split with a dedicated airdrop bucket and optional referrals</Bullet>
            <Bullet>Front-run-safe graduation with on-chain metadata freeze</Bullet>
            <Bullet>Per-curve emergency pause and on-chain dev-token vesting</Bullet>
            <Bullet>8 autonomous trading strategies — TP/SL, Sniper, DCA, Copy Trading, Graduation Snipe, Rebalancer, and more</Bullet>
            <Bullet>gRPC checkpoint streaming indexer live — sub-second real-time event indexing</Bullet>
            <Bullet>Off-chain indexer live; multi-version trading across all contract versions</Bullet>
            <Bullet>Pre-audit security review completed</Bullet>
            <H>PHASE 2 — PRE-MAINNET</H>
            <Bullet>Independent security audit of the Move contracts (hard gate)</Bullet>
            <Bullet>AdminCap and UpgradeCap transferred to multisig</Bullet>
            <Bullet>DEX auto-graduation (Cetus / DeepBook / Turbos)</Bullet>
            <Bullet>Dedicated gRPC RPC node and monitoring infrastructure</Bullet>
            <Bullet>Mobile app (iOS + Android)</Bullet>
            <Bullet>Nexus/Talus autonomous agent — 24/7 server-side strategy execution</Bullet>
            <Bullet>KOL and creator partnerships</Bullet>
            <H>PHASE 3 — MAINNET</H>
            <Bullet>Mainnet deployment post-audit</Bullet>
            <Bullet>S1 airdrop tracking activated from the first transaction</Bullet>
            <Bullet>First wave of real token launches and communities</Bullet>
            <Bullet>On-chain referral system live</Bullet>
            <Bullet>Live streaming and voice chat</Bullet>
            <H>PHASE 4 — SCALE</H>
            <Bullet>$SUMP token — buyback-and-burn from protocol fees, governance</Bullet>
            <Bullet>Season 2 airdrop with enhanced point mechanics</Bullet>
            <Bullet>SuiPump Perps — derivatives market for graduated tokens</Bullet>
            <Bullet>DAO treasury management</Bullet>
            <Bullet>Multi-chain expansion</Bullet>
          </Section>

          <Section number="10" title="Disclaimers">
            <P>This white paper is provided for informational purposes only and does not constitute an offer or solicitation to sell or purchase securities, investment products, or financial instruments of any kind. Nothing in this document should be construed as financial, legal, tax, or investment advice.</P>
            <P>SuiPump is an experimental protocol currently deployed only on testnet. The contracts described have not been independently audited. All figures, projections, and estimates are illustrative and subject to change without notice.</P>
            <P>Participating in token launches on any bonding-curve launchpad carries substantial financial risk, including the total loss of funds. SuiPump does not endorse or take responsibility for any token launched through the protocol.</P>
          </Section>

          <div className="text-center text-[10px] font-mono text-white/[0.18] py-4">
            SUIPUMP · suipump.org · Testnet Preview 2026
          </div>

        </div>
      </div>
    </div>
  );
}
