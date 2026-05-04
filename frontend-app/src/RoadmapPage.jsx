// RoadmapPage.jsx
import React from 'react';
import { ArrowLeft, CheckCircle, Circle, Zap, Globe, TrendingUp, Star } from 'lucide-react';

const phases = [
  {
    id: 'phase1',
    label: 'PHASE 1',
    title: 'Testnet',
    status: 'complete',
    icon: <CheckCircle size={18} className="text-lime-400" />,
    color: 'lime',
    items: [
      { done: true,  text: 'Move contracts deployed — 18/18 unit tests passing' },
      { done: true,  text: 'Constant-product bonding curve with virtual reserves' },
      { done: true,  text: 'Creator-first fee model (40% creator / 50% protocol / 10% LP)' },
      { done: true,  text: 'Transferable CreatorCap with up to 10 payout splits' },
      { done: true,  text: 'Browser-based two-tx token launch flow' },
      { done: true,  text: 'Live trading UI with price chart' },
      { done: true,  text: 'On-chain social comments per token' },
      { done: true,  text: 'Leaderboard, portfolio view, token search and sort' },
      { done: true,  text: 'Season 1 airdrop counter' },
      { done: true,  text: 'Graduation state with Cetus DEX link' },
    ],
  },
  {
    id: 'phase2',
    label: 'PHASE 2',
    title: 'Pre-Mainnet',
    status: 'active',
    icon: <Zap size={18} className="text-amber-400" />,
    color: 'amber',
    items: [
      { done: false, text: 'Independent Move security audit (OtterSec / Movebit / Zellic)' },
      { done: false, text: 'AdminCap transferred to multisig' },
      { done: false, text: 'Cetus CLMM auto-graduation PTB' },
      { done: false, text: 'Dedicated RPC node + monitoring infrastructure' },
      { done: false, text: 'Mobile app (iOS + Android)' },
      { done: false, text: 'KOL partnerships and creator incentive program' },
    ],
  },
  {
    id: 'phase3',
    label: 'PHASE 3',
    title: 'Mainnet',
    status: 'upcoming',
    icon: <Globe size={18} className="text-white/30" />,
    color: 'white',
    items: [
      { done: false, text: 'Mainnet deployment post-audit' },
      { done: false, text: 'Season 1 airdrop tracking activated from block 0' },
      { done: false, text: 'First wave of real token launches and communities' },
      { done: false, text: 'Referral system — on-chain, permissionless' },
      { done: false, text: 'Off-chain indexer for real-time trade history and charts' },
      { done: false, text: 'Season 1 close and SUI airdrop distribution' },
    ],
  },
  {
    id: 'phase4',
    label: 'PHASE 4',
    title: 'Scale',
    status: 'upcoming',
    icon: <TrendingUp size={18} className="text-white/30" />,
    color: 'white',
    items: [
      { done: false, text: '$SUMP token — buyback-and-burn from protocol fees' },
      { done: false, text: 'Season 2 airdrop with enhanced point mechanics' },
      { done: false, text: 'SuiPump Perps — derivatives market for graduated tokens' },
      { done: false, text: 'Multi-chain expansion (post Sui dominance)' },
      { done: false, text: 'DAO governance via $SUMP' },
    ],
  },
];

const statusColors = {
  complete: 'border-lime-400/30 bg-lime-950/10',
  active:   'border-amber-400/30 bg-amber-950/10',
  upcoming: 'border-white/10 bg-white/[0.03]',
};

const labelColors = {
  complete: 'text-lime-400 bg-lime-400/10 border-lime-400/20',
  active:   'text-amber-400 bg-amber-400/10 border-amber-400/20',
  upcoming: 'text-white/30 bg-white/5 border-white/10',
};

const dotColors = {
  complete: 'bg-lime-400',
  active:   'bg-amber-400 animate-pulse',
  upcoming: 'bg-white/20',
};

export default function RoadmapPage({ onBack }) {
  return (
    <div>
      <button
        onClick={onBack}
        className="flex items-center gap-2 text-xs font-mono text-white/40 hover:text-white mb-6 transition-colors"
      >
        <ArrowLeft size={12} /> BACK TO HOME
      </button>

      <div className="max-w-2xl mx-auto space-y-6">

        {/* Header */}
        <div className="rounded-3xl border border-white/10 bg-gradient-to-br from-lime-950/20 via-black to-black p-8 text-center relative overflow-hidden">
          <div className="absolute top-0 left-1/2 -translate-x-1/2 w-64 h-24 bg-lime-400/10 blur-3xl rounded-full pointer-events-none" />
          <div className="relative">
            <div className="flex items-center justify-center gap-2 mb-3">
              <Star className="text-lime-400" size={18} />
              <h1 className="text-2xl font-bold text-white" style={{ fontFamily: "'Space Grotesk', sans-serif" }}>
                ROADMAP
              </h1>
            </div>
            <p className="text-xs font-mono text-white/40 mb-4">
              From testnet to the leading token launchpad on Sui.
            </p>
            {/* Progress bar */}
            <div className="flex gap-1.5 justify-center">
              {phases.map(p => (
                <div key={p.id} className={`h-1.5 flex-1 rounded-full max-w-[60px] ${
                  p.status === 'complete' ? 'bg-lime-400' :
                  p.status === 'active' ? 'bg-amber-400/60 animate-pulse' :
                  'bg-white/10'
                }`} />
              ))}
            </div>
            <div className="mt-2 text-[9px] font-mono text-white/20">PHASE 1 COMPLETE · PHASE 2 IN PROGRESS</div>
          </div>
        </div>

        {/* Phases */}
        {phases.map((phase) => (
          <div key={phase.id} className={`rounded-2xl border p-5 ${statusColors[phase.status]}`}>
            {/* Phase header */}
            <div className="flex items-center gap-3 mb-4">
              <div className={`w-2 h-2 rounded-full shrink-0 ${dotColors[phase.status]}`} />
              <span className={`text-[10px] font-mono font-bold px-2 py-0.5 rounded-full border ${labelColors[phase.status]}`}>
                {phase.label}
              </span>
              <span className="text-sm font-bold text-white font-mono">{phase.title}</span>
              {phase.status === 'complete' && (
                <span className="ml-auto text-[10px] font-mono text-lime-400">✓ COMPLETE</span>
              )}
              {phase.status === 'active' && (
                <span className="ml-auto text-[10px] font-mono text-amber-400">⬡ IN PROGRESS</span>
              )}
            </div>

            {/* Items */}
            <div className="space-y-2.5">
              {phase.items.map((item, i) => (
                <div key={i} className="flex items-start gap-3">
                  <div className={`mt-0.5 w-4 h-4 rounded-full border flex items-center justify-center shrink-0 ${
                    item.done
                      ? 'bg-lime-400/20 border-lime-400/40'
                      : phase.status === 'active'
                      ? 'border-amber-400/20'
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
          <div className="text-[10px] font-mono text-white/20 tracking-widest mb-2">TARGET</div>
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
