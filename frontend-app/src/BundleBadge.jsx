// BundleBadge.jsx -- compact at-a-glance bundle indicator for a token.
//
// Fed by the precomputed `bundle_score` (0..1 fraction = largest wallet
// cluster's share of circulating supply) that the indexer keeps on each curve
// row. A cheap cached read on the board; the BubbleMap modal shows the full
// per-wallet detail and both take the SAME largest-cluster number.
//
// Buckets (thresholds match the AIAnalysis bundle flag exactly -- strong >= 25%,
// moderate >= 12%):
//   null            -> render nothing (not enough data; NEVER green-for-unknown)
//   < 0.12          -> green  CLEAN
//   0.12 to < 0.25  -> amber  CLUSTERED
//   >= 0.25         -> red    BUNDLED
//
// Honest empty state: absent means unmeasured, green means measured-and-low.
import React from 'react';

export default function BundleBadge({ score, className = '' }) {
  // null / undefined / non-finite -> unmeasured -> no badge at all.
  if (score == null) return null;
  const n = Number(score);
  if (!Number.isFinite(n)) return null;

  const pct = Math.round(n * 100);
  let label, tone;
  if (n >= 0.25)      { label = 'BUNDLED';   tone = { border: 'border-red-400/35',  bg: 'bg-red-400/[0.08]',  text: 'text-red-400',  dot: '#f87171' }; }
  else if (n >= 0.12) { label = 'CLUSTERED'; tone = { border: 'border-amber-500/35', bg: 'bg-amber-500/[0.08]', text: 'text-[#f59e0b]', dot: '#f59e0b' }; }
  else                { label = 'CLEAN';     tone = { border: 'border-lime-400/30',  bg: 'bg-lime-400/[0.08]',  text: 'text-lime-400', dot: '#a3e635' }; }

  return (
    <span
      title={`Largest wallet cluster: ${pct}% of circulating supply`}
      className={`inline-flex items-center gap-1 shrink-0 border rounded-full px-1.5 py-0.5 text-[7.5px] font-mono font-bold tracking-wide ${tone.border} ${tone.bg} ${tone.text} ${className}`}
    >
      <span className="w-[5px] h-[5px] rounded-full flex-none" style={{ background: tone.dot }} />
      {label}
    </span>
  );
}
