// RoadmapPage.jsx - Terminal design (3a / 6d). Content preserved from the repo
// (D-4.2: port the design STYLE, keep the current page's real phase content).
import React from 'react';
import { ArrowLeft, Star } from 'lucide-react';
import { t } from './i18n.js';

const phases = [
  {
    id: 1,
    phase: 'PHASE 1',
    status: 'complete',
    label: 'COMPLETE',
    items: [
      { text: 'Move contracts + 55/55 tests, 59/59 Python harness', done: true },
      { text: 'Full trading UI live', done: true },
      { text: '2-tx token launch flow', done: true },
      { text: 'Comments, leaderboard, portfolio, search & sort', done: true },
      { text: 'USD price display + OHLC charts', done: true },
      { text: '8 autonomous trading strategies', done: true },
      { text: 'gRPC streaming indexer live', done: true },
      { text: '6-language i18n rollout', done: true },
      { text: 'Vercel Analytics + Discord community', done: true },
    ],
  },
  {
    id: 2,
    phase: 'PHASE 2',
    status: 'active',
    label: 'PRE-MAINNET',
    items: [
      { text: 'Security audit (hard gate)', done: false },
      { text: 'DeepBook / Cetus / Turbos auto-graduation PTB', done: true },
      { text: 'Dedicated gRPC RPC infra', done: true },
      { text: '24/7 autonomous agent execution', done: false },
      { text: 'KOL + creator partnerships', done: false },
    ],
  },
  {
    id: 3,
    phase: 'PHASE 3',
    status: 'upcoming',
    label: 'MAINNET',
    items: [
      { text: 'Mainnet deployment', done: false },
      { text: 'S1 airdrop tracking live', done: false },
      { text: 'First wave token launches', done: false },
      { text: 'Mobile app (iOS + Android)', done: false },
      { text: 'On-chain referral system', done: false },
      { text: 'Off-chain indexer', done: true },
      { text: 'Live streaming and voice chat', done: false },
    ],
  },
  {
    id: 4,
    phase: 'PHASE 4',
    status: 'upcoming',
    label: 'SCALE',
    items: [
      { text: '$SUMP token + governance', done: false },
      { text: 'Season 2 airdrop', done: false },
      { text: 'SuiPump Perps', done: false },
      { text: 'Multi-chain expansion', done: false },
      { text: 'DAO treasury management', done: false },
    ],
  },
];

// Terminal card tints per phase status (design rmPhases: complete = lime tint,
// active/upcoming = neutral).
const cardColors = {
  complete: 'border-lime-400/[0.22] bg-lime-400/[0.035]',
  active:   'border-white/[0.09] bg-white/[0.015]',
  upcoming: 'border-white/[0.09] bg-white/[0.015]',
};

const labelColors = {
  complete: 'text-lime-400 bg-lime-400/[0.07] border-lime-400/30',
  active:   'text-lime-400 bg-lime-400/[0.07] border-lime-400/30',
  upcoming: 'text-white/40 bg-white/5 border-white/10',
};

const dotColors = {
  complete: 'bg-lime-400',
  active:   'bg-lime-400 animate-pulse',
  upcoming: 'bg-white/20',
};

export default function RoadmapPage({ onBack, lang = 'en' }) {
  return (
    <div>
      <button
        onClick={onBack}
        className="flex items-center gap-2 text-xs font-mono text-white/40 hover:text-lime-400 mb-6 transition-colors"
      >
        <ArrowLeft size={12} /> {t(lang, 'backToHome')}
      </button>

      <div className="max-w-4xl mx-auto space-y-4">

        {/* Header (Terminal lime card) */}
        <div className="rounded-2xl border border-lime-400/25 p-6 relative overflow-hidden bg-white/[0.015]"
             style={{ background: 'radial-gradient(circle at 15% 0%, rgba(132,204,22,.1), transparent 55%), rgba(255,255,255,.015)' }}>
          <div className="relative flex flex-col sm:flex-row items-start sm:items-center gap-5">
            <div className="flex-none">
              <div className="flex items-center gap-2.5">
                <Star className="text-lime-400" size={18} />
                <h1 className="text-xl font-extrabold font-mono tracking-tight text-white">{t(lang, 'roadmapTitle')}</h1>
              </div>
              <p className="text-[11px] font-mono text-white/40 mt-2 leading-relaxed max-w-xs">{t(lang, 'roadmapSub')}</p>
            </div>
            {/* Progress bar (4 segments) */}
            <div className="flex-1 flex gap-2 w-full sm:max-w-[420px] sm:mx-auto">
              {phases.map(p => (
                <div key={p.id} className={`h-[7px] flex-1 rounded ${
                  p.status === 'complete' ? 'bg-lime-400' :
                  p.status === 'active' ? 'bg-lime-400/40' : 'bg-white/10'
                }`} />
              ))}
            </div>
            <div className="text-left sm:text-right shrink-0">
              <div className="text-xl font-extrabold font-mono text-lime-400">$50M</div>
              <div className="text-[9px] font-mono text-white/35 mt-1.5 max-w-[150px] leading-relaxed">monthly volume target - 12mo post-mainnet</div>
            </div>
          </div>
        </div>

        {/* Phases (2-column grid; single column on mobile serves 6d) */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-start">
          {phases.map(phase => (
            <div key={phase.id} className={`rounded-2xl border p-[18px] ${cardColors[phase.status]}`}>
              <div className="flex items-center gap-2.5 mb-3.5">
                <div className={`w-2.5 h-2.5 rounded-full ${dotColors[phase.status]}`} />
                <span className="text-[11px] font-mono font-bold text-white/60 tracking-[0.16em]">{phase.phase}</span>
                <span className={`text-[8.5px] font-mono px-2 py-1 rounded-full border ${labelColors[phase.status]}`}>
                  {phase.label}
                </span>
              </div>
              <div className="space-y-2.5">
                {phase.items.map((item, i) => (
                  <div key={i} className="flex items-start gap-2.5">
                    <div className={`mt-px w-[13px] h-[13px] rounded border flex-shrink-0 flex items-center justify-center ${
                      item.done ? 'bg-lime-400/[0.12] border-lime-400/45' : 'border-white/12'
                    }`}>
                      {item.done && <div className="w-[5px] h-[5px] rounded-full bg-lime-400" />}
                    </div>
                    <span className={`text-[11px] font-mono leading-relaxed ${
                      item.done ? 'text-white/60' : phase.status === 'active' ? 'text-white/50' : 'text-white/28'
                    }`}>
                      {item.text}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>

        {/* Target (projection corrected to the C-5 model) */}
        <div className="rounded-2xl border border-white/[0.08] bg-white/[0.015] p-5 text-center">
          <div className="text-[10px] font-mono font-semibold text-white/30 tracking-[0.16em] mb-2">{t(lang, 'target')}</div>
          <div className="text-3xl font-extrabold text-white font-mono mb-1">$50M</div>
          <div className="text-xs font-mono text-white/40">monthly trading volume within 12 months of mainnet</div>
          <div className="mt-3 text-[9px] font-mono text-white/25 leading-relaxed">
            At $50M/month volume, ~$500,000/month total fees, ~$125,000 to the S1 airdrop pool (0.25% of volume).
          </div>
        </div>

        <div className="text-center text-[9px] font-mono text-white/20 py-2">
          SUIPUMP - TESTNET PREVIEW 2026 - SUBJECT TO CHANGE
        </div>
      </div>
    </div>
  );
}
