// RoadmapPage.jsx
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
      { text: 'Move contracts + 26/26 tests', done: true },
      { text: 'Full trading UI live', done: true },
      { text: '2-tx token launch flow', done: true },
      { text: 'Comments, leaderboard, portfolio, search & sort', done: true },
      { text: 'USD price display + OHLC charts', done: true },
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
      { text: 'DeepBook / Cetus auto-graduation PTB', done: false },
      { text: 'Dedicated RPC infra', done: false },
      { text: 'On-chain referral system', done: false },
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
      { text: 'Ambassador program', done: false },
      { text: 'Off-chain indexer', done: false },
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
      { text: 'DAO governance via $SUMP', done: false },
    ],
  },
];

const statusColors = {
  complete: 'border-lime-400/20 bg-lime-950/10',
  active:   'border-white/10 bg-white/[0.03]',
  upcoming: 'border-white/10 bg-white/[0.03]',
};

const labelColors = {
  complete: 'text-lime-400 bg-lime-400/10 border-lime-400/20',
  active:   'text-lime-400 bg-lime-400/10 border-lime-400/20',
  upcoming: 'text-white/30 bg-white/5 border-white/10',
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
        className="flex items-center gap-2 text-xs font-mono text-white/40 hover:text-white mb-6 transition-colors"
      >
        <ArrowLeft size={12} /> {t(lang, 'backToHome')}
      </button>

      <div className="max-w-2xl mx-auto space-y-6">

        {/* Header */}
        <div className="rounded-3xl border border-white/10 bg-gradient-to-br from-lime-950/20 via-black to-black p-8 text-center relative overflow-hidden">
          <div className="absolute top-0 left-1/2 -translate-x-1/2 w-64 h-24 bg-lime-400/10 blur-3xl rounded-full pointer-events-none" />
          <div className="relative">
            <div className="flex items-center justify-center gap-2 mb-3">
              <Star className="text-lime-400" size={18} />
              <h1 className="text-2xl font-bold text-white" style={{ fontFamily: "'Space Grotesk', sans-serif" }}>
                {t(lang, 'roadmapTitle')}
              </h1>
            </div>
            <p className="text-xs font-mono text-white/40 mb-4">
              {t(lang, 'roadmapSub')}
            </p>
            {/* Progress bar */}
            <div className="flex gap-1.5 justify-center">
              {phases.map(p => (
                <div key={p.id} className={`h-1.5 flex-1 rounded-full max-w-[60px] ${
                  p.status === 'complete' ? 'bg-lime-400' :
                  p.status === 'active' ? 'bg-lime-400/40' : 'bg-white/10'
                }`} />
              ))}
            </div>
          </div>
        </div>

        {/* Phases */}
        {phases.map(phase => (
          <div key={phase.id} className={`rounded-2xl border p-5 ${statusColors[phase.status]}`}>
            <div className="flex items-center gap-3 mb-4">
              <div className={`w-2.5 h-2.5 rounded-full ${dotColors[phase.status]}`} />
              <span className="text-[10px] font-mono font-bold text-white/50 tracking-widest">{phase.phase}</span>
              <span className={`text-[9px] font-mono px-2 py-0.5 rounded-full border ${labelColors[phase.status]}`}>
                {phase.label}
              </span>
            </div>
            <div className="space-y-2.5 pl-5">
              {phase.items.map((item, i) => (
                <div key={i} className="flex items-start gap-2.5">
                  <div className={`mt-1 w-3 h-3 rounded-sm border flex-shrink-0 flex items-center justify-center ${
                    item.done
                      ? 'bg-lime-400/20 border-lime-400/40'
                      : phase.status === 'active'
                      ? 'border-white/10'
                      : 'border-white/10'
                  }`}>
                    {item.done && <div className="w-1.5 h-1.5 rounded-full bg-lime-400" />}
                  </div>
                  <span className={`text-xs font-mono leading-relaxed ${
                    item.done ? 'text-white/60' : phase.status === 'active' ? 'text-white/50' : 'text-white/25'
                  }`}>
                    {item.text}
                  </span>
                </div>
              ))}
            </div>
          </div>
        ))}

        {/* Target */}
        <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-5 text-center">
          <div className="text-[10px] font-mono text-white/20 tracking-widest mb-2">{t(lang, 'target')}</div>
          <div className="text-3xl font-bold text-white font-mono mb-1">$50M</div>
          <div className="text-xs font-mono text-white/40">monthly trading volume within 12 months of mainnet</div>
          <div className="mt-3 text-[9px] font-mono text-white/15">
            At $50M/month volume → ~$500,000/month in protocol fees → ~$250,000 to S1 airdrop pool
          </div>
        </div>

        <div className="text-center text-[9px] font-mono text-white/15 py-2">
          SUIPUMP · TESTNET PREVIEW 2026 · SUBJECT TO CHANGE
        </div>
      </div>
    </div>
  );
}
