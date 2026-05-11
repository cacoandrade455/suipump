// AirdropPage.jsx v3
import React from 'react';
import { ArrowLeft } from 'lucide-react';
import S1AirdropCounter from './S1AirdropCounter.jsx';
import { t } from './i18n.js';

const EARN_ROWS = [
  { action: 'Buy on any SuiPump curve', pts: '1 pt per 0.01 SUI spent' },
  { action: 'Sell on any SuiPump curve', pts: '0.5 pts per 0.01 SUI received' },
  { action: 'Launch a token', pts: '500 pts flat' },
  { action: 'Token reaches 25% graduation', pts: '250 bonus pts (creator)' },
  { action: 'Token reaches 50% graduation', pts: '500 bonus pts (creator)' },
  { action: 'Token graduates to DEX', pts: '2,000 bonus pts (creator)' },
  { action: 'Refer a new launcher', pts: '20% of referee launch points' },
  { action: 'Early adopter (first 1,000 wallets)', pts: '2x multiplier on all points' },
];

const TIMELINE_ROWS = [
  { label: 'Testnet preview', desc: 'You are here. Counter shows estimated pool from testnet activity.' },
  { label: 'Security audit', desc: 'Independent Move contract audit. Gate for mainnet.' },
  { label: 'Mainnet deployment', desc: 'S1 counter resets to zero. All trades from block 0 count.' },
  { label: 'Season 1 close', desc: 'Announced with 30+ days notice. Snapshot taken.' },
  { label: '7-day challenge period', desc: 'Community reviews snapshot, disputes resolved.' },
  { label: 'Airdrop distribution', desc: 'SUI sent directly to eligible wallets.' },
];

export default function AirdropPage({ onBack, lang = 'en' }) {
  return (
    <div>
      <button
        onClick={onBack}
        className="flex items-center gap-2 text-xs font-mono text-white/40 hover:text-white mb-6 transition-colors"
      >
        <ArrowLeft size={12} /> {t(lang, 'backToHome')}
      </button>

      <div className="max-w-2xl mx-auto space-y-4">

        <S1AirdropCounter />

        <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-6 space-y-4">
          <div className="text-[10px] font-mono tracking-widest text-lime-400">
            {t(lang, 'eligibilityTitle')}
          </div>
          <p className="text-sm font-mono text-white/50 leading-relaxed">
            SuiPump charges a 1% fee on every trade. Of that, 0.50% goes to the protocol.
            At the end of Season 1, 50% of all accumulated protocol fees are distributed
            proportionally to users based on their points. Final amount determined at season
            close. Nothing is locked ahead of time.
          </p>
          <p className="text-sm font-mono text-white/50 leading-relaxed">
            Distribution happens in SUI. No vesting. No governance token. No strings.
          </p>
        </div>

        <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-6 space-y-3">
          <div className="text-[10px] font-mono tracking-widest text-lime-400">
            {t(lang, 'eligibilityTitle')}
          </div>
          <div className="space-y-2 text-xs font-mono text-white/50 leading-relaxed">
            <p>- {t(lang, 'eligibility1')}</p>
            <p>- {t(lang, 'eligibility2')}</p>
            <p>- {t(lang, 'eligibility3')}</p>
            <p>- {t(lang, 'eligibility4')}</p>
          </div>
        </div>

        <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-6">
          <div className="text-[10px] font-mono tracking-widest text-lime-400 mb-4">
            HOW TO EARN POINTS
          </div>
          <div className="space-y-1">
            {EARN_ROWS.map(function(row) {
              return (
                <div key={row.action} className="flex items-center justify-between py-2.5 border-b border-white/5 last:border-0">
                  <span className="text-xs font-mono text-white/60">{row.action}</span>
                  <span className="text-xs font-mono text-lime-400/70 ml-4 text-right shrink-0">{row.pts}</span>
                </div>
              );
            })}
          </div>
        </div>

        <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-6 space-y-3">
          <div className="text-[10px] font-mono tracking-widest text-lime-400">TIMELINE</div>
          <div className="space-y-3">
            {TIMELINE_ROWS.map(function(row, i) {
              return (
                <div key={row.label} className="flex gap-4">
                  <div className="flex flex-col items-center">
                    <div className="w-2 h-2 rounded-full border border-lime-400/40 mt-1 shrink-0" />
                    {i < TIMELINE_ROWS.length - 1 && (
                      <div className="w-px flex-1 bg-white/5 mt-1" />
                    )}
                  </div>
                  <div className="pb-3">
                    <div className="text-xs font-mono text-white/70 font-bold">{row.label}</div>
                    <div className="text-[11px] font-mono text-white/30 mt-0.5">{row.desc}</div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div className="rounded-2xl border border-white/5 p-4">
          <p className="text-[10px] font-mono text-white/20 leading-relaxed">
            TESTNET PREVIEW - Testnet activity does not count toward the real S1 airdrop.
            The counter above is illustrative only. Final distribution amount, eligibility
            rules, and timeline are subject to change. This is not financial advice. DYOR.
          </p>
        </div>

      </div>
    </div>
  );
}
