// WhitepaperPage.jsx
import React, { useState } from 'react';
import { ArrowLeft, ChevronDown, ChevronUp } from 'lucide-react';

function Section({ number, title, children }) {
  const [open, setOpen] = useState(true);
  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.03] overflow-hidden">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between p-5 text-left hover:bg-white/5 transition-colors"
      >
        <div className="flex items-center gap-3">
          <span className="text-[10px] font-mono text-white/20">{number}</span>
          <span className="text-sm font-bold font-mono text-white tracking-wide">{title}</span>
        </div>
        {open
          ? <ChevronUp size={14} className="text-white/20 shrink-0" />
          : <ChevronDown size={14} className="text-white/20 shrink-0" />}
      </button>
      {open && <div className="px-5 pb-5 space-y-3">{children}</div>}
    </div>
  );
}

function P({ children }) {
  return <p className="text-xs font-mono text-white/50 leading-relaxed">{children}</p>;
}

function H({ children }) {
  return <div className="text-[10px] font-mono text-lime-400/70 tracking-widest pt-2">{children}</div>;
}

function Table({ rows, cols }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-white/10">
      <table className="w-full text-[10px] font-mono border-collapse">
        <thead>
          <tr className="border-b border-white/10">
            {cols.map((c, i) => (
              <th key={i} className={`text-left p-2.5 ${i === 1 ? 'text-lime-400' : 'text-white/30'} bg-white/5`}>{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, ri) => (
            <tr key={ri} className={`border-b border-white/5 last:border-0 ${ri % 2 === 0 ? '' : 'bg-white/[0.02]'}`}>
              {row.map((cell, ci) => (
                <td key={ci} className={`p-2.5 ${ci === 1 ? 'text-lime-400/80' : 'text-white/50'}`}>{cell}</td>
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
    <div className="flex gap-2 text-xs font-mono text-white/50">
      <span className="text-lime-400/50 shrink-0">·</span>
      <span className="leading-relaxed">{children}</span>
    </div>
  );
}

export default function WhitepaperPage({ onBack }) {
  return (
    <div>
      <button
        onClick={onBack}
        className="flex items-center gap-2 text-xs font-mono text-white/40 hover:text-white mb-6 transition-colors"
      >
        <ArrowLeft size={12} /> BACK TO HOME
      </button>

      <div className="max-w-3xl mx-auto space-y-4">

        {/* Cover */}
        <div className="rounded-3xl border border-lime-400/20 bg-gradient-to-br from-lime-950/20 via-black to-black p-10 text-center relative overflow-hidden">
          <div className="absolute top-0 left-1/2 -translate-x-1/2 w-64 h-24 bg-lime-400/10 blur-3xl rounded-full pointer-events-none" />
          <div className="relative">
            <div className="text-4xl font-bold font-mono text-white mb-2" style={{ fontFamily: "'Space Grotesk', sans-serif" }}>
              SUIPUMP<span className="text-lime-400">.</span>
            </div>
            <div className="text-sm font-mono text-white/50 mb-1">Permissionless Token Launchpad on Sui</div>
            <div className="text-xs font-mono text-white/25">White Paper · Season 1 · Version 2.0 · 2026</div>
            <div className="mt-4 border-t border-white/5 pt-4 text-[10px] font-mono text-white/15">
              TESTNET PREVIEW · CONTRACTS UNAUDITED · NOT FINANCIAL ADVICE
            </div>
          </div>
        </div>

        <Section number="01" title="Executive Summary">
          <P>SuiPump is a permissionless bonding-curve token launchpad built on the Sui blockchain. It enables anyone to launch a fungible token in two wallet signatures, with price discovery happening automatically through an on-chain constant-product curve. Every launched token starts at a fair price, has no pre-mine, and graduates to a decentralized exchange once its bonding curve drains.</P>
          <P>SuiPump improves on existing Solana-based launchpads across three dimensions: lower total fees with a larger creator share, an LP fee that deepens curve liquidity over time, and a transferable creator-ownership model that lets revenue streams be traded or delegated.</P>
          <P>Season 1 introduces the first coordinated user-acquisition program: at season close, 50% of all accumulated protocol fees are distributed to early users proportionally to an on-chain points system.</P>
        </Section>

        <Section number="02" title="Problem">
          <H>EXISTING LAUNCHPADS EXTRACT VALUE FROM CREATORS</H>
          <P>The leading Solana launchpad charges 1.25% on every trade but gives creators only 0.30% — just 24% of the total fee. Builders who drive volume are compensated as an afterthought.</P>
          <H>LIQUIDITY COLLAPSES AT GRADUATION</H>
          <P>Most launchpads offer no mechanism to seed post-graduation liquidity. When a token migrates to a DEX with shallow liquidity, price impact on the first trades is severe, holders dump immediately, and the token rarely recovers.</P>
          <H>CREATOR OWNERSHIP IS INFLEXIBLE</H>
          <P>Revenue is tied to a static wallet address. No team splits, no transfers, no delegation. Creators need off-chain workarounds for anything complex.</P>
          <H>EARLY USERS ARE NOT REWARDED</H>
          <P>Launchpads accumulate protocol fees from the very first trade but have no mechanism to redistribute value back to users who took the early adoption risk.</P>
        </Section>

        <Section number="03" title="Solution">
          <H>CREATOR-FIRST FEE STRUCTURE</H>
          <P>SuiPump charges 1.00% total per trade — lower than the incumbent. Creators receive 0.40% (40%), the protocol receives 0.50% (50%), and 0.10% is retained inside the bonding curve as an LP contribution.</P>
          <H>LP FEES RETAINED IN THE CURVE</H>
          <P>The 0.10% LP share accumulates inside the curve's SUI reserve. Every trade deepens liquidity for all participants. At graduation, this migrates into the DEX pool alongside the 200M tokens reserved for liquidity.</P>
          <H>TRANSFERABLE CREATORCAP</H>
          <P>Each launched token is associated with a CreatorCap — a Move object that confers the right to claim creator fees and update payout configuration. The cap is transferable and supports up to 10 payout recipients with custom percentage splits.</P>
          <H>FRONT-RUN-SAFE GRADUATION</H>
          <P>At graduation, all fund routing is automatic and internal. The creator bonus is transferred directly to the creator's address, the protocol bonus is deposited into the protocol fee pool, and the LP tokens are minted and routed — all within the contract. No return values means no front-running opportunity. Anyone can trigger graduation, but the caller just pays gas — all value goes to predefined recipients.</P>
          <H>S1 AIRDROP</H>
          <P>At the end of Season 1, 50% of accumulated protocol fees are distributed to users in proportion to their points. Points are earned by trading, launching, referring, and holding graduated tokens.</P>
        </Section>

        <Section number="04" title="Fee Structure">
          <H>TRADING FEES (1.00% PER TRADE)</H>
          <Table
            cols={['', 'SuiPump', 'Leading Sol Launchpad']}
            rows={[
              ['Total trade fee', '1.00%', '1.25%'],
              ['Creator share', '0.40% (40%)', '0.30% (24%)'],
              ['Protocol share', '0.50%', '0.95%'],
              ['LP / liquidity share', '0.10% in curve', '0%'],
              ['Launch fee', '2 SUI (anti-spam)', 'None'],
              ['Creator revenue model', 'Transferable CreatorCap · up to 10 payouts', 'Single address'],
            ]}
          />
          <H>GRADUATION FEES (1.00% OF FINAL RESERVE)</H>
          <Table
            cols={['Recipient', 'Share', 'On ~88k SUI reserve']}
            rows={[
              ['Creator bonus', '0.50%', '~440 SUI'],
              ['Protocol bonus', '0.50%', '~440 SUI'],
              ['Total graduation fee', '1.00%', '~880 SUI'],
            ]}
          />
          <P>Trading fees are paid and claimed in SUI. Creator fees are held in each curve's creator_fees balance, claimable only by the CreatorCap holder. Protocol fees are held separately, claimable via AdminCap. Graduation bonuses are transferred automatically — creator bonus goes directly to the creator's address, protocol bonus is deposited into the protocol fee pool.</P>
        </Section>

        <Section number="05" title="Token Model">
          <Table
            cols={['Allocation', 'Supply', 'Notes']}
            rows={[
              ['Bonding curve (public sale)', '800M (80%)', 'Minted at launch, sold via exponential curve'],
              ['DEX liquidity (graduation)', '200M (20%)', 'Minted at graduation, paired with SUI, LP burned'],
              ['Team / VC / pre-mine', '0%', 'None. Every token enters via public bonding curve'],
            ]}
          />
          <P>Total supply is 1 billion tokens with 6 decimal places. The 200M LP allocation does not exist until graduation — it is minted by the contract only when the curve fully drains, then paired with the accumulated SUI reserve and deposited into a DEX pool. LP tokens are burned immediately, making the liquidity permanent.</P>
        </Section>

        <Section number="06" title="How It Works">
          <H>BONDING CURVE MECHANICS</H>
          <P>SuiPump uses a constant-product pricing model with virtual reserves: Vs = 30,000 SUI and Vt = 1,073,000,000 tokens. The curve drains at approximately 87,900 SUI of real reserves.</P>
          <H>LAUNCH FLOW</H>
          <P>Launching a token requires two wallet signatures. Tx 1: a fresh Move module is published with the creator's chosen name, symbol, description, icon, and social links (Telegram, X, website). Tx 2: the creator configures the curve — pays the 2 SUI launch fee, sets payout splits, and optionally executes a dev-buy in the same atomic transaction.</P>
          <H>SOCIAL LINKS</H>
          <P>Creators can add Telegram, X (Twitter), and website links during launch. These are permanently encoded in the token's on-chain metadata and displayed on the token page. Links are immutable after launch — ensuring transparency.</P>
          <H>TAIL-CLIP PROTECTION</H>
          <P>When a buy order would purchase more tokens than remain, SuiPump clips the order to exactly the remaining supply, re-prices the SUI cost, and refunds the excess. This prevents the curve from stalling with dust and ensures clean graduation.</P>
          <H>GRADUATION</H>
          <P>Triggers when token_reserve == 0. The contract automatically: (1) mints 200M LP tokens, (2) transfers 0.5% of the reserve to the creator as a graduation bonus, (3) deposits 0.5% into the protocol fee pool, (4) routes the remaining reserve and LP tokens for Cetus pool composition. All transfers are internal — no return values, no front-running opportunity. Anyone can trigger graduation by calling the function, but they only pay gas.</P>
        </Section>

        <Section number="07" title="Season 1 Airdrop">
          <P>Season 1 runs from the protocol's first transaction on mainnet through a closing date announced with at least 30 days' notice. At season close, 50% of all accumulated protocol fees are distributed to eligible wallets in proportion to their S1 points. Distribution is in liquid SUI — no vesting, no new token.</P>
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
          <P>Implemented in Move, deployed as a single package on Sui. Core module: suipump::bonding_curve — handles curve creation, trading, fee accounting, graduation, and the CreatorCap ownership model. Each token launch publishes a new independent Move package derived from a coin template, patched client-side via @mysten/move-bytecode-template.</P>
          <H>SECURITY MODEL</H>
          <P>Graduation is front-run safe: the graduate() function performs all transfers internally with no return values. The TreasuryCap is permanently locked inside the Curve object — no additional tokens can ever be minted. Creator authority lives in a transferable CreatorCap. Protocol authority lives in an AdminCap (multisig before mainnet). A comprehensive pre-audit security review has been conducted, with all medium+ findings addressed.</P>
          <H>EVENT PAGINATION</H>
          <P>All frontend components use cursor-based pagination to fetch complete event histories from the Sui RPC, eliminating the 100-event cap that affects naive implementations. This ensures accurate charts, holder lists, leaderboards, and trade histories regardless of trading volume.</P>
          <H>OBJECT MODEL</H>
          <P>Each launched token has its own isolated Curve&lt;T&gt; shared object. A failure or exploit in one token's curve cannot affect any other. Creator authority lives in a transferable CreatorCap owned object. Protocol authority lives in an AdminCap held by the deployer (multisig before mainnet).</P>
          <H>FRONTEND</H>
          <P>React + Vite + @mysten/dapp-kit. Connects to any Sui-compatible wallet including WalletConnect. Reads curve state directly from the Sui RPC — no backend or intermediary. The launch flow operates entirely client-side: bytecode is patched in the browser using WebAssembly and published directly from the user's wallet.</P>
        </Section>

        <Section number="09" title="Roadmap">
          <H>PHASE 1 — TESTNET (COMPLETE)</H>
          <Bullet>Move contracts deployed and verified (18/18 Move unit tests)</Bullet>
          <Bullet>Frontend trading UI live on testnet with full feature set</Bullet>
          <Bullet>Browser-based token launch flow with social links</Bullet>
          <Bullet>Front-run-safe graduation with 1% fee split</Bullet>
          <Bullet>Cursor-based event pagination across all components</Bullet>
          <Bullet>Pre-audit security review completed</Bullet>
          <H>PHASE 2 — PRE-MAINNET</H>
          <Bullet>Independent security audit of Move contracts (OtterSec / Movebit)</Bullet>
          <Bullet>AdminCap transferred to multisig</Bullet>
          <Bullet>Cetus CLMM auto-graduation PTB</Bullet>
          <Bullet>Dedicated RPC node + monitoring infrastructure</Bullet>
          <Bullet>Mobile app (iOS + Android)</Bullet>
          <H>PHASE 3 — MAINNET</H>
          <Bullet>Mainnet deployment post-audit</Bullet>
          <Bullet>S1 airdrop tracking activated from block 0</Bullet>
          <Bullet>First wave of real token launches and communities</Bullet>
          <Bullet>On-chain referral system</Bullet>
          <Bullet>Off-chain indexer for real-time trade history and charts</Bullet>
          <H>PHASE 4 — SCALE</H>
          <Bullet>$SUMP token — buyback-and-burn from protocol fees, governance</Bullet>
          <Bullet>Season 2 airdrop with enhanced point mechanics</Bullet>
          <Bullet>SuiPump Perps — derivatives market for graduated tokens</Bullet>
          <Bullet>Multi-chain expansion</Bullet>
        </Section>

        <Section number="10" title="Disclaimers">
          <P>This white paper is provided for informational purposes only and does not constitute an offer or solicitation to sell or purchase securities, investment products, or financial instruments of any kind. Nothing in this document should be construed as financial, legal, tax, or investment advice.</P>
          <P>SuiPump is an experimental protocol currently deployed only on testnet. The contracts described have not been independently audited. All figures, projections, and estimates are illustrative and subject to change without notice.</P>
          <P>Participating in token launches on any bonding-curve launchpad carries substantial financial risk, including the total loss of funds. SuiPump does not endorse or take responsibility for any token launched through the protocol.</P>
        </Section>

        <div className="text-center text-[10px] font-mono text-white/15 py-4">
          SUIPUMP · suipump.vercel.app · Testnet Preview 2026
        </div>

      </div>
    </div>
  );
}
