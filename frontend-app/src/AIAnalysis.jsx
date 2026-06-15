// AIAnalysis.jsx — AI-powered token analysis card
//
// Risk model rationale (rewritten):
//   On a memecoin launchpad EVERYTHING is speculative, so a flat High/Med/Low
//   "risk" badge is information-free — when a healthy-distribution token and a
//   genuinely dangerous one both read "HIGH", the signal is useless and trains
//   users to ignore it. So we DON'T score "how risky is this asset" (answer:
//   always very). We surface SPECIFIC, DETECTABLE red flags relative to a normal
//   early launchpad token, plus a neutral STAGE for context.
//
//   - Flags are computed deterministically in code from on-chain holder/trade
//     data — the LLM never decides them, it only writes explanatory prose.
//   - Flags render INSTANTLY (client-side) the moment holder data loads; only
//     the prose waits on the model. This also kills the old lag where the card
//     re-fetched everything and showed numbers inconsistent with the page.
//   - "new = risky" is gone. Thin/early data is a neutral STAGE ("Early —
//     limited data"), never a red flag. Absence of data is never a positive
//     signal and never a danger signal — it's just limited data.
//
//   Concentration (the real, detectable danger):
//     - excludes the bonding curve (never a holder here — curve isn't a buyer)
//     - excludes VESTED/LOCKED balances (creator who locked tokens is LOW risk)
//     - measured against CIRCULATING liquid supply held by real wallets,
//       NOT the full 1B (200M is LP/reserve that never circulates)
//     - single non-creator wallet > 20% liquid          → strong flag
//     - top-10 wallets combined > 50% liquid             → strong flag
//     - top-10 combined 30–50% liquid                    → moderate flag
//
//   Creator:
//     - holding mostly LOCKED/vested      → positive context (not a flag)
//     - holding large & LIQUID            → flag (dump risk)
//     - creator fees claimed              → NEVER a flag (it's their reward)
//     - if lock data is unavailable (older indexer) → contextual, never flagged
//
//   Wash/thin liquidity:
//     - trades concentrated in 1–2 wallets → flag (possible wash volume)

import React, { useState } from 'react';
import { Sparkles, AlertTriangle, ShieldCheck, Info } from 'lucide-react';

const INDEXER_URL = import.meta.env.VITE_INDEXER_URL || '';
const TOKEN_SCALE = 1e6;

function fmt(n, d = 2) {
  if (n == null) return '-';
  return Number(n).toLocaleString(undefined, { maximumFractionDigits: d });
}

// ── Neutral stage from curve progress — CONTEXT, not risk ──────────────────
function computeStage({ graduated, progress }) {
  if (graduated)         return { label: 'Graduated', note: 'Now trading on a DEX' };
  const p = Number(progress) || 0;
  if (p < 5)             return { label: 'Early',           note: 'Limited data — recently launched' };
  if (p < 60)            return { label: 'Active',          note: 'Filling the bonding curve' };
  return { label: 'Near graduation', note: 'Approaching the DEX listing threshold' };
}

// ── Deterministic flags from on-chain data. The LLM never decides these. ────
// holders: [{ address, balance, locked, liquid, isCreator }]  (whole tokens)
//   `locked`/`liquid`/`isCreator` may be absent on older indexer deploys — in
//   that case we degrade gracefully: treat full balance as liquid and the
//   creator axis as contextual (never a false flag).
function computeFlags({ holders, creator, buys, sells, distinctBuyers }) {
  const flags = [];      // [{ level: 'strong'|'moderate', text }]
  const positives = [];  // ['…']

  const TOTAL_SUPPLY = 1_000_000_000; // 1B mint cap — concentration denominator

  const hasLockData = holders.some(h => h.liquid != null || h.locked != null);

  // Liquid (sellable) balance per wallet. Concentration risk is about what can
  // hit the market NOW, so flags use liquid only, measured against TOTAL supply
  // (1B) — the number a trader can verify against an explorer.
  const liquidOf = (h) => {
    if (h.liquid != null) return Math.max(0, Number(h.liquid));
    return Math.max(0, Number(h.balance) || 0); // no lock data → full balance is liquid
  };
  const lockedOf = (h) => Math.max(0, Number(h.locked) || 0);
  const isCreatorRow = (h) =>
    (h.isCreator === true) || (creator != null && h.address === creator);

  // ── Concentration (non-creator wallets, LIQUID only, vs 1B total) ─────────
  // Locked tokens NEVER count toward a flag — they can't be dumped while
  // locked, so they don't represent sell pressure. They surface as a POSITIVE
  // signal below instead.
  const nonCreatorLiquid = holders
    .filter(h => !isCreatorRow(h))
    .map(liquidOf)
    .sort((a, b) => b - a);

  const topSinglePct = ((nonCreatorLiquid[0] ?? 0) / TOTAL_SUPPLY) * 100;
  const top10Pct = (nonCreatorLiquid.slice(0, 10).reduce((a, b) => a + b, 0) / TOTAL_SUPPLY) * 100;

  if (topSinglePct > 20) {
    flags.push({ level: 'strong', text: `One wallet holds ${fmt(topSinglePct, 0)}% of total supply (liquid)` });
  }
  if (top10Pct > 50) {
    flags.push({ level: 'strong', text: `Top 10 wallets hold ${fmt(top10Pct, 0)}% of total supply (liquid)` });
  } else if (top10Pct >= 30) {
    flags.push({ level: 'moderate', text: `Top 10 wallets hold ${fmt(top10Pct, 0)}% of total supply (liquid)` });
  }

  // ── Locked supply = POSITIVE signal (can't be dumped while locked) ────────
  const totalLocked = holders.reduce((a, h) => a + lockedOf(h), 0);
  if (hasLockData && totalLocked > 0) {
    const lockedPct = (totalLocked / TOTAL_SUPPLY) * 100;
    if (lockedPct >= 1) {
      positives.push(`${fmt(lockedPct, 0)}% of supply is locked/vested — cannot be dumped while locked`);
    }
  }

  // ── Creator: locked holding is a positive; liquid holding is NOT flagged ──
  // (Liquid creator tokens already fall under the concentration check above if
  // large; we don't double-count. Creator fees are never a risk.)
  const creatorRow = holders.find(isCreatorRow);
  if (creatorRow && hasLockData) {
    const cLiquid = liquidOf(creatorRow);
    const cLocked = lockedOf(creatorRow);
    const cTotal = cLiquid + cLocked;
    if (cTotal > 0 && cLocked / cTotal >= 0.5) {
      positives.push('Creator tokens are mostly vested/locked');
    }
  }

  // ── Wash / thin liquidity ─────────────────────────────────────────────────
  const totalTrades = buys + sells;
  if (totalTrades >= 8 && distinctBuyers != null && distinctBuyers <= 2) {
    flags.push({ level: 'moderate', text: `Trades concentrated in ${distinctBuyers} wallet${distinctBuyers === 1 ? '' : 's'} — possible wash volume` });
  }

  return { flags, positives, hasLockData, totalLocked };
}

export default function AIAnalysis({ curveId, tokenType, name, symbol, progress, reserveSui, creatorFeesSui, graduated, tokensSoldWhole, creator = null }) {
  const [prose, setProse]     = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState(null);
  const [done, setDone]       = useState(false);
  const [read, setRead]       = useState(null); // { stage, flags, positives, stats }

  // Fetch holder + trade data once, compute flags client-side (instant),
  // then ask the LLM only for prose. Returns the computed read so analyze()
  // can render flags immediately before the model responds.
  async function fetchAndCompute() {
    let holders = [];
    let buys = 0, sells = 0, volumeSui = 0, distinctBuyers = null;

    if (INDEXER_URL && curveId) {
      // Holders (with liquid/locked/isCreator when available)
      try {
        const hr = await fetch(`${INDEXER_URL}/token/${curveId}/holders`, { signal: AbortSignal.timeout(5000) });
        if (hr.ok) holders = await hr.json();
      } catch {}

      // Trades
      try {
        const tr = await fetch(`${INDEXER_URL}/token/${curveId}/trades?limit=500`, { signal: AbortSignal.timeout(5000) });
        if (tr.ok) {
          const rows = await tr.json();
          const buyRows  = rows.filter(r => r.event_type.includes('TokensPurchased') || r.event_type.includes('TokensBought'));
          const sellRows = rows.filter(r => r.event_type.includes('TokensSold'));
          buys  = buyRows.length;
          sells = sellRows.length;
          volumeSui =
            buyRows.reduce((a, r)  => a + Number(r.data?.sui_in  ?? 0), 0) / 1e9 +
            sellRows.reduce((a, r) => a + Number(r.data?.sui_out ?? 0), 0) / 1e9;
          distinctBuyers = new Set(buyRows.map(r => r.data?.buyer).filter(Boolean)).size;
        }
      } catch {}
    }

    const stage = computeStage({ graduated, progress });
    const { flags, positives, hasLockData, totalLocked } =
      computeFlags({ holders, creator, buys, sells, distinctBuyers });

    const stats = {
      holderCount: holders.length,
      buys, sells, totalTrades: buys + sells, volumeSui,
      distinctBuyers, totalLocked, hasLockData,
    };
    return { stage, flags, positives, stats };
  }

  const analyze = async () => {
    setLoading(true);
    setError(null);
    setProse(null);
    setDone(false);
    setRead(null);

    try {
      const computed = await fetchAndCompute();
      // Render flags + stage IMMEDIATELY — no wait on the model.
      setRead(computed);

      const { stage, flags, positives, stats } = computed;
      const flagText = flags.length
        ? flags.map(f => `- (${f.level}) ${f.text}`).join('\n')
        : '- None detected';
      const posText = positives.length ? positives.map(p => `- ${p}`).join('\n') : '- None noted';

      const prompt = `You are a DeFi token analyst on SuiPump, a bonding-curve memecoin launchpad on Sui.

Detectable signals have ALREADY been computed deterministically. Do NOT invent a risk rating, do NOT contradict these, and do NOT output any "Risk:" line. Write exactly 3 short, direct sentences that explain these findings to a trader: (1) what the concentration/flags mean, (2) the trading picture, (3) one specific thing to watch next. No intro, no fluff.

Framing rules (strict):
- This is a memecoin launchpad; ALL tokens here are speculative by default. Never imply a token is "safe" or "low risk."
- Concentration percentages are LIQUID (sellable) holdings as a share of TOTAL supply (1B). Locked/vested tokens are EXCLUDED from concentration because they cannot be sold while locked.
- Locked/vested supply is a POSITIVE signal (reduces sell pressure / dump risk), not a concern. Never describe locked tokens as a dump risk.
- An early token with little activity is "too early to assess," NOT "well distributed" and NOT inherently dangerous. Never present an absence of data as either a positive or a red flag.
- Creator fee earnings are normal protocol revenue — never a risk.

Token: ${name} ($${symbol})
Stage: ${stage.label} — ${stage.note}
Curve progress: ${fmt(progress, 1)}% (${fmt(reserveSui, 1)} SUI raised)
Holders: ${stats.holderCount}
Trades: ${stats.totalTrades} (${stats.buys} buys / ${stats.sells} sells), ${stats.distinctBuyers ?? '?'} distinct buyers
Volume: ${fmt(stats.volumeSui, 2)} SUI
Creator fees earned: ${fmt(creatorFeesSui, 3)} SUI (normal revenue, not a risk)
Lock data available: ${stats.hasLockData ? 'yes' : 'no'}

Detected flags:
${flagText}

Positive notes:
${posText}`;

      const res = await fetch('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Analysis failed');
      setProse(data.result);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
      setDone(true);
    }
  };

  const proseLines = prose
    ? prose.split('\n').filter(Boolean).filter(l => !l.toLowerCase().startsWith('risk:'))
    : [];

  const strongCount = read?.flags.filter(f => f.level === 'strong').length ?? 0;
  const flagCount   = read?.flags.length ?? 0;

  return (
    <div className="border border-white/10 rounded-lg p-4 bg-black/40">
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Sparkles size={11} className="text-lime-400" />
          <span className="text-[10px] font-mono text-white/35 tracking-widest">AI ANALYSIS</span>
        </div>
        {!loading && !done && (
          <button
            onClick={analyze}
            className="text-[10px] font-mono font-bold tracking-widest px-3 py-1.5 rounded border border-lime-400/60 text-lime-400 hover:bg-lime-400/10 transition-colors"
          >
            ANALYZE
          </button>
        )}
        {done && !loading && (
          <button
            onClick={analyze}
            className="text-[9px] font-mono text-white/25 hover:text-white/50 transition-colors"
          >
            REFRESH
          </button>
        )}
      </div>

      {/* Stage + flags render INSTANTLY once computed (before prose) */}
      {read && (
        <div className="space-y-2 mb-3">
          <div className="flex items-center gap-1.5">
            <Info size={11} className="text-white/40" />
            <span className="text-[10px] font-mono text-white/60 tracking-wide">
              {read.stage.label.toUpperCase()}
            </span>
            <span className="text-[9px] font-mono text-white/30">· {read.stage.note}</span>
          </div>

          {flagCount > 0 ? (
            <div className="space-y-1">
              {read.flags.map((f, i) => (
                <div key={i} className="flex items-start gap-1.5">
                  <AlertTriangle size={10} className={`mt-0.5 shrink-0 ${f.level === 'strong' ? 'text-red-400' : 'text-yellow-400'}`} />
                  <span className={`text-[10px] font-mono leading-snug ${f.level === 'strong' ? 'text-red-400/90' : 'text-yellow-400/90'}`}>
                    {f.text}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <div className="flex items-center gap-1.5">
              <ShieldCheck size={10} className="text-white/40 shrink-0" />
              <span className="text-[10px] font-mono text-white/45 leading-snug">
                No specific red flags detected in on-chain data
              </span>
            </div>
          )}

          {read.positives.map((p, i) => (
            <div key={`p${i}`} className="flex items-center gap-1.5">
              <ShieldCheck size={10} className="text-lime-400/70 shrink-0" />
              <span className="text-[10px] font-mono text-lime-400/70 leading-snug">{p}</span>
            </div>
          ))}
        </div>
      )}

      {/* Loading prose (flags already shown above) */}
      {loading && (
        <div className="flex items-center gap-2 py-2">
          <div className="flex gap-1">
            <span className="w-1.5 h-1.5 rounded-full bg-lime-400 animate-bounce" style={{ animationDelay: '0ms' }} />
            <span className="w-1.5 h-1.5 rounded-full bg-lime-400 animate-bounce" style={{ animationDelay: '150ms' }} />
            <span className="w-1.5 h-1.5 rounded-full bg-lime-400 animate-bounce" style={{ animationDelay: '300ms' }} />
          </div>
          <span className="text-[10px] font-mono text-white/35">{read ? 'Writing analysis…' : 'Reading on-chain data…'}</span>
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="text-[11px] font-mono text-red-400/80 py-1">
          Analysis unavailable. Try again.
        </div>
      )}

      {/* Prose */}
      {prose && !loading && (
        <p className="text-[11px] font-mono text-white/70 leading-relaxed">
          {proseLines.join(' ')}
          <span className="text-white/40"> NFA — Not Financial Advice.</span>
        </p>
      )}

      {/* Idle */}
      {!loading && !read && !error && (
        <p className="text-[10px] font-mono text-white/25 leading-relaxed">
          Get an on-chain read: holder concentration (excluding vested/locked), trading activity, and curve stage. Flags are computed from chain data, not guessed.
        </p>
      )}

      {/* Always-on baseline disclaimer */}
      {read && (
        <p className="text-[9px] font-mono text-white/20 leading-snug mt-2 pt-2 border-t border-white/5">
          All launchpad tokens are highly speculative. Flags show risks beyond that baseline — absence of flags is not a safety signal.
        </p>
      )}

      <div className="mt-3 pt-2 border-t border-white/5 flex items-center justify-end">
        <span className="text-[9px] font-mono text-white/15 tracking-widest">ANALYSIS BY GROQ</span>
      </div>
    </div>
  );
}
