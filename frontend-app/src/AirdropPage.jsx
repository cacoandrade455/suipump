// AirdropPage.jsx v4 - Terminal design (2f). Ledger C-1 split: the S1 counter,
// composition, earn table, and timeline live here; the boards live on
// /leaderboard. Copy per C-2 (points-based share + fixed 10% NFT holders +
// fixed 10% testnet users; testnet points eliminated), C-3 (real mainnet earn
// numbers; testnet currently tracks BUY points only), C-5 (S1 pool = airdrop
// bucket = 0.25% of every trade; $50M volume -> $500k fees -> $125k S1 pool).
import React from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import S1AirdropCounter from './S1AirdropCounter.jsx';
import { t } from './i18n.js';

// Ledger C-3: real mainnet numbers. Testnet has been running BUY-ONLY points,
// so every row except the buy row is tagged AT MAINNET.
const EARN_ROWS = [
  { action: 'Buy on any SuiPump curve', pts: '1 pt per 0.01 SUI spent', live: true },
  { action: 'Sell on any SuiPump curve', pts: '0.5 pts per 0.01 SUI received', live: false },
  { action: 'Launch a token', pts: '500 pts flat', live: false },
  { action: 'Token reaches 25% graduation', pts: '250 bonus pts (creator)', live: false },
  { action: 'Token reaches 50% graduation', pts: '500 bonus pts (creator)', live: false },
  { action: 'Token graduates to DEX', pts: '2,000 bonus pts (creator)', live: false },
  { action: 'Refer a new launcher', pts: '20% of referee launch points', live: false },
  { action: 'Early adopter (first 1,000 wallets)', pts: '2x multiplier on all points', live: false },
];

// Ledger C-2: S1 distribution = points-based share + fixed 10% NFT holders +
// fixed 10% testnet users. Testnet points are eliminated; mainnet starts fresh.
const COMPOSITION_ROWS = [
  { share: '80%', label: 'POINTS', desc: 'Distributed pro-rata by Season 1 points. Points start fresh at mainnet launch - testnet points are eliminated.' },
  { share: '10%', label: 'NFT HOLDERS', desc: 'Fixed allocation to NFT holders at the season close snapshot.' },
  { share: '10%', label: 'TESTNET USERS', desc: 'Fixed allocation to testnet users - this replaces any carried-over testnet points.' },
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
  const navigate = useNavigate();

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <button
          onClick={onBack || (() => navigate('/'))}
          className="flex items-center gap-2 text-xs font-mono text-white/40 hover:text-lime-400 transition-colors group"
        >
          <ArrowLeft size={12} className="group-hover:-translate-x-0.5 transition-transform" />
          {t(lang, 'backToHome')}
        </button>
        <button
          onClick={() => navigate('/leaderboard')}
          className="text-[10px] font-mono font-semibold px-[13px] py-2 rounded-[9px] border border-white/10 text-white/45 hover:text-white/70 transition-colors"
        >
          POINTS LEADERBOARD {'->'}
        </button>
      </div>

      <div className="max-w-5xl mx-auto space-y-4">

        <S1AirdropCounter />

        <div className="grid grid-cols-1 lg:grid-cols-[1fr_420px] gap-4 items-start">

          {/* Left column: how the pool works */}
          <div className="space-y-4">

            <div className="rounded-2xl border border-white/[0.08] bg-white/[0.015] p-4">
              <div className="text-[10px] font-mono font-bold tracking-[0.16em] text-lime-400 mb-3">
                HOW THE POOL IS FUNDED
              </div>
              <p className="text-[10.5px] font-mono text-white/45 leading-relaxed">
                SuiPump charges a 1.00% fee on every trade, split five ways: 40% creator,
                25% protocol, 25% airdrop bucket, 10% LP. The S1 pool is the airdrop
                bucket - 0.25% of every trade. $50M monthly volume {'->'} $500k total fees
                {' '}{'->'} $125k S1 airdrop pool (0.25% of volume). Distributed at season
                close per the S1 composition below. Nothing is locked ahead of time.
              </p>
              <p className="text-[10.5px] font-mono text-white/45 leading-relaxed mt-2">
                Distribution happens in SUI. No vesting. No governance token. No strings.
              </p>
            </div>

            <div className="rounded-2xl border border-white/[0.08] bg-white/[0.015] p-4">
              <div className="text-[10px] font-mono font-bold tracking-[0.16em] text-lime-400 mb-2">
                S1 COMPOSITION
              </div>
              <div>
                {COMPOSITION_ROWS.map(function(row) {
                  return (
                    <div key={row.label} className="flex gap-3 py-2 border-b border-white/[0.045] last:border-0">
                      <span className="text-[19px] leading-none font-extrabold font-mono text-lime-400 w-12 shrink-0 mt-0.5">
                        {row.share}
                      </span>
                      <div>
                        <div className="text-[11px] font-mono font-semibold text-white/70">{row.label}</div>
                        <div className="text-[9.5px] font-mono text-white/[0.32] mt-[5px] leading-[1.5]">{row.desc}</div>
                      </div>
                    </div>
                  );
                })}
              </div>
              <div className="text-[9.5px] font-mono text-white/[0.32] mt-3 leading-relaxed">
                Min 100 pts to qualify · sybil clusters excluded · 7-day challenge period.
              </div>
            </div>

            <div className="rounded-2xl border border-white/[0.08] bg-white/[0.015] p-4">
              <div className="text-[10px] font-mono font-bold tracking-[0.16em] text-white/50 mb-3">
                {t(lang, 'eligibilityTitle')}
              </div>
              <div className="space-y-2 text-[10.5px] font-mono text-white/45 leading-relaxed">
                <p>- {t(lang, 'eligibility1')}</p>
                <p>- {t(lang, 'eligibility2')}</p>
                <p>- {t(lang, 'eligibility3')}</p>
                <p>- {t(lang, 'eligibility4')}</p>
              </div>
            </div>

          </div>

          {/* Right column: earn table + timeline (design 2f right rail, 420px) */}
          <div className="space-y-4">

            <div className="rounded-2xl border border-white/[0.08] bg-white/[0.015] p-4">
              <div className="text-[10px] font-mono font-bold tracking-[0.16em] text-lime-400 mb-2">
                HOW TO EARN
              </div>
              <div className="text-[9.5px] font-mono text-white/[0.32] leading-relaxed mb-2">
                Real mainnet numbers. Testnet currently tracks buy points only - rows
                tagged AT MAINNET go live with mainnet Season 1.
              </div>
              <div>
                {EARN_ROWS.map(function(row) {
                  return (
                    <div key={row.action} className="flex items-center justify-between gap-3 py-2 border-b border-white/[0.045] last:border-0">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="text-[10.5px] font-mono text-white/60 leading-[1.4]">{row.action}</span>
                        {row.live ? (
                          <span className="text-[8px] font-mono font-semibold text-lime-400 border border-lime-400/30 px-[5px] py-[2px] rounded shrink-0">LIVE</span>
                        ) : (
                          <span className="text-[8px] font-mono font-semibold text-white/30 border border-white/10 px-[5px] py-[2px] rounded shrink-0">AT MAINNET</span>
                        )}
                      </div>
                      <span className="text-[10px] font-mono font-semibold text-lime-400 text-right shrink-0 leading-[1.4]">{row.pts}</span>
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="rounded-2xl border border-white/[0.08] bg-white/[0.015] p-4">
              <div className="text-[10px] font-mono font-bold tracking-[0.16em] text-white/50 mb-3">TIMELINE</div>
              <div className="flex flex-col">
                {TIMELINE_ROWS.map(function(row, i) {
                  return (
                    <div key={row.label} className="flex gap-3">
                      <div className="flex flex-col items-center">
                        <span className={`w-2 h-2 rounded-full shrink-0 mt-[3px] ${i === 0 ? 'bg-lime-400 shadow-[0_0_9px_#a3e635]' : 'bg-white/15'}`} />
                        {i < TIMELINE_ROWS.length - 1 && (
                          <span className="w-px flex-1 bg-white/[0.08] my-[3px]" />
                        )}
                      </div>
                      <div className="pb-[13px]">
                        <div className="text-[11px] font-mono font-semibold text-white/70">{row.label}</div>
                        <div className="text-[9.5px] font-mono text-white/[0.32] mt-[5px] leading-[1.5]">{row.desc}</div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

          </div>
        </div>

        <div className="rounded-2xl border border-white/[0.05] p-4">
          <p className="text-[9px] font-mono text-white/25 leading-relaxed">
            TESTNET PREVIEW - Testnet activity does not count toward the real S1 airdrop.
            The counter above is illustrative only. Final distribution amount, eligibility
            rules, and timeline are subject to change. This is not financial advice. DYOR.
          </p>
        </div>

      </div>
    </div>
  );
}
