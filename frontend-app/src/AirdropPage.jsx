// AirdropPage.jsx — dedicated Season 1 airdrop information page

import React from 'react';
import { ArrowLeft, Gift } from 'lucide-react';
import S1AirdropCounter from './S1AirdropCounter.jsx';

export default function AirdropPage({ onBack }) {
  return (
    <div>
      <button
        onClick={onBack}
        className="flex items-center gap-2 text-xs font-mono text-lime-700 hover:text-lime-400 mb-6"
      >
        <ArrowLeft size={12} /> BACK TO HOME
      </button>

      <div className="max-w-2xl mx-auto space-y-6">

        {/* Live counter */}
        <S1AirdropCounter />

        {/* How it works */}
        <div className="border border-lime-900/30 bg-black p-6 space-y-4">
          <div className="text-xs font-mono tracking-widest text-lime-600">HOW IT WORKS</div>
          <p className="text-sm font-mono text-lime-700 leading-relaxed">
            SuiPump charges a 1% fee on every trade. Of that, 0.50% goes to the protocol.
            At the end of Season 1, we will take 50% of all accumulated protocol fees and
            distribute them proportionally to users based on their points. The final amount
            is determined at season close — nothing is locked ahead of time.
          </p>
          <p className="text-sm font-mono text-lime-700 leading-relaxed">
            Distribution happens in SUI. No vesting. No governance token. No strings.
            You traded, you helped build this, you get paid back.
          </p>
        </div>

        {/* Points table */}
        <div className="border border-lime-900/30 bg-black p-6">
          <div className="text-xs font-mono tracking-widest text-lime-600 mb-4">HOW TO EARN POINTS</div>
          <div className="space-y-2">
            {[
              { action: 'Buy on any SuiPump curve', pts: '1 pt per 0.01 SUI spent' },
              { action: 'Sell on any SuiPump curve', pts: '0.5 pts per 0.01 SUI received' },
              { action: 'Launch a token', pts: '500 pts flat' },
              { action: 'Token reaches 25% graduation', pts: '250 bonus pts (creator)' },
              { action: 'Token reaches 50% graduation', pts: '500 bonus pts (creator)' },
              { action: 'Token graduates to DEX', pts: '2,000 bonus pts (creator)' },
              { action: 'Refer a new launcher', pts: '20% of referee\'s launch points' },
              { action: 'Early adopter (first 1,000 wallets)', pts: '2× multiplier on all points' },
            ].map(({ action, pts }) => (
              <div key={action} className="flex items-center justify-between py-2 border-b border-lime-950 last:border-0">
                <span className="text-xs font-mono text-lime-400">{action}</span>
                <span className="text-xs font-mono text-lime-600">{pts}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Eligibility */}
        <div className="border border-lime-900/30 bg-black p-6 space-y-3">
          <div className="text-xs font-mono tracking-widest text-lime-600">ELIGIBILITY</div>
          <div className="space-y-2 text-xs font-mono text-lime-700 leading-relaxed">
            <p>· Minimum 100 points required to claim</p>
            <p>· Sybil wallets (wash trading, cluster farms) will be excluded</p>
            <p>· Anti-sybil methodology published before snapshot</p>
            <p>· 7-day challenge period after snapshot before distribution</p>
            <p>· No registration needed — every on-chain interaction counts automatically</p>
          </div>
        </div>

        {/* Timeline */}
        <div className="border border-lime-900/30 bg-black p-6 space-y-3">
          <div className="text-xs font-mono tracking-widest text-lime-600">TIMELINE</div>
          <div className="space-y-3">
            {[
              { status: 'pending', label: 'Testnet preview', desc: 'You are here. Counter shows estimated pool from testnet activity.' },
              { status: 'pending', label: 'Security audit', desc: 'Independent Move contract audit. Gate for mainnet.' },
              { status: 'pending', label: 'Mainnet deployment', desc: 'S1 counter resets to zero. All trades from block 0 count.' },
              { status: 'pending', label: 'Season 1 close', desc: 'Announced with ≥30 days notice. Snapshot taken.' },
              { status: 'pending', label: '7-day challenge period', desc: 'Community reviews snapshot, disputes resolved.' },
              { status: 'pending', label: 'Airdrop distribution', desc: 'SUI sent directly to eligible wallets.' },
            ].map(({ label, desc }, i) => (
              <div key={label} className="flex gap-4">
                <div className="flex flex-col items-center">
                  <div className="w-2 h-2 rounded-full border border-lime-800 mt-1 shrink-0" />
                  {i < 5 && <div className="w-px flex-1 bg-lime-950 mt-1" />}
                </div>
                <div className="pb-3">
                  <div className="text-xs font-mono text-lime-400 font-bold">{label}</div>
                  <div className="text-[11px] font-mono text-lime-800 mt-0.5">{desc}</div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Disclaimer */}
        <div className="border border-lime-900/20 p-4">
          <p className="text-[10px] font-mono text-lime-900 leading-relaxed">
            TESTNET PREVIEW — Testnet activity does not count toward the real S1 airdrop.
            The counter above is illustrative only. Final distribution amount, eligibility rules,
            and timeline are subject to change. This is not financial advice. SuiPump contracts
            are unaudited. DYOR.
          </p>
        </div>

      </div>
    </div>
  );
}
