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
// computeTradeSignals — derive trader-grade signals from the raw trade rows the
// page already fetches. All amounts come straight off the indexer event `data`:
//   buys:  data.sui_in (MIST), data.tokens_out (atomic ×1e6), data.buyer
//   sells: data.sui_out (MIST), data.tokens_in (atomic ×1e6), data.seller
//   every row: timestamp_ms (epoch ms string)
// Returns raw metrics; computeFlags turns them into flags/positives so the
// thresholds live in one place.
function computeTradeSignals({ buyRows, sellRows, creator }) {
  const MIST = 1e9;
  const num = (v) => Number(v || 0);

  // ── Net SUI flow (accumulation vs bleed) ──────────────────────────────────
  const buyVol  = buyRows.reduce((a, r) => a + num(r.data?.sui_in)  / MIST, 0);
  const sellVol = sellRows.reduce((a, r) => a + num(r.data?.sui_out) / MIST, 0);
  const netFlowSui = buyVol - sellVol;
  const totalVol = buyVol + sellVol;
  const sellShare = totalVol > 0 ? sellVol / totalVol : 0;

  // ── Creator sold? (compare creator sells vs creator buys, by tokens) ──────
  let creatorSoldSui = 0, creatorBoughtTokens = 0, creatorSoldTokens = 0;
  if (creator) {
    for (const r of sellRows) {
      if (r.data?.seller === creator) {
        creatorSoldSui    += num(r.data?.sui_out) / MIST;
        creatorSoldTokens += num(r.data?.tokens_in);
      }
    }
    for (const r of buyRows) {
      if (r.data?.buyer === creator) creatorBoughtTokens += num(r.data?.tokens_out);
    }
  }
  // Fraction of the creator's acquired position that has been sold. If they never
  // bought on-curve but still sold (a pre-allocation), treat any sell as material.
  const creatorSoldFrac = creatorBoughtTokens > 0
    ? creatorSoldTokens / creatorBoughtTokens
    : (creatorSoldTokens > 0 ? 1 : 0);

  // ── Early-buyer / sniper concentration (first 5 buyers' share of all tokens) ─
  const buysByTime = [...buyRows].sort((a, b) => num(a.timestamp_ms) - num(b.timestamp_ms));
  const totalTokensBought = buyRows.reduce((a, r) => a + num(r.data?.tokens_out), 0);
  const first5Tokens = buysByTime.slice(0, 5).reduce((a, r) => a + num(r.data?.tokens_out), 0);
  const earlyBuyerPct = totalTokensBought > 0 ? (first5Tokens / totalTokensBought) * 100 : 0;
  const enoughForSniper = buyRows.length >= 5; // need a real sample

  // ── Momentum / fade (volume in first 10 min vs whether it's gone quiet) ───
  const allByTime = [...buyRows, ...sellRows].sort((a, b) => num(a.timestamp_ms) - num(b.timestamp_ms));
  let earlyVolShare = 0, minsSinceLast = null;
  if (allByTime.length >= 4) {
    const t0 = num(allByTime[0].timestamp_ms);
    const tLast = num(allByTime[allByTime.length - 1].timestamp_ms);
    const tenMin = 10 * 60 * 1000;
    const volOf = (r) => (r.data?.sui_in ? num(r.data.sui_in) : num(r.data?.sui_out)) / MIST;
    const earlyVol = allByTime.filter(r => num(r.timestamp_ms) - t0 <= tenMin).reduce((a, r) => a + volOf(r), 0);
    earlyVolShare = totalVol > 0 ? earlyVol / totalVol : 0;
    minsSinceLast = (Date.now() - tLast) / 60000;
  }

  // ── NEW: buy-size distribution (organic crowd vs whale-driven) ────────────
  // Average buy size and the share of buy volume from the single largest buy.
  // Many small buys = organic; a few large buys = whale-driven (different token).
  const buySizes = buyRows.map(r => num(r.data?.sui_in) / MIST).filter(v => v > 0).sort((a, b) => b - a);
  const avgBuySui = buySizes.length ? buyVol / buySizes.length : 0;
  const largestBuySui = buySizes[0] ?? 0;
  const largestBuyShare = buyVol > 0 ? largestBuySui / buyVol : 0;       // 0..1
  // Top-3 buys' share of all buy volume — a concentration-of-demand read.
  const top3BuyShare = buyVol > 0 ? (buySizes.slice(0, 3).reduce((a, b) => a + b, 0) / buyVol) : 0;

  // ── NEW: wash / same-wallet churn ─────────────────────────────────────────
  // Distinct buyers vs total buys. A low ratio (many buys, few wallets) suggests
  // wash trading or a small group cycling — inflates apparent activity.
  const distinctBuyersN = new Set(buyRows.map(r => r.data?.buyer).filter(Boolean)).size;
  const buyerChurnRatio = buyRows.length > 0 ? distinctBuyersN / buyRows.length : null; // ~1 organic, low = churn
  // Wallets that BOTH bought and sold (round-trippers) — flips, not holders.
  const buyerSet = new Set(buyRows.map(r => r.data?.buyer).filter(Boolean));
  const sellerSet = new Set(sellRows.map(r => r.data?.seller).filter(Boolean));
  let roundTrippers = 0;
  for (const w of sellerSet) if (buyerSet.has(w)) roundTrippers++;

  // ── NEW: holder/trade acceleration (last 15 min vs prior hour) ────────────
  // Momentum read from timestamps already on the rows. Compares recent trade
  // count to the preceding window to detect acceleration vs stall.
  let recent15 = 0, prior45 = 0, accel = null;
  {
    const now = Date.now();
    for (const r of [...buyRows, ...sellRows]) {
      const age = now - num(r.timestamp_ms);
      if (age <= 15 * 60000) recent15++;
      else if (age <= 60 * 60000) prior45++;
    }
    // Normalize to per-minute rates (15m vs 45m windows) for a fair ratio.
    const recentRate = recent15 / 15;
    const priorRate = prior45 / 45;
    if (priorRate > 0) accel = recentRate / priorRate;       // >1 accelerating, <1 cooling
    else if (recent15 > 0) accel = Infinity;                  // fresh activity, no prior baseline
  }

  return {
    buyVol, sellVol, netFlowSui, sellShare,
    creatorSoldSui, creatorSoldFrac, creatorSold: creatorSoldTokens > 0,
    earlyBuyerPct, enoughForSniper,
    earlyVolShare, minsSinceLast,
    tradeCount: buyRows.length + sellRows.length,
    // new:
    avgBuySui, largestBuySui, largestBuyShare, top3BuyShare,
    buyerChurnRatio, roundTrippers, distinctBuyersN,
    recent15, prior45, accel,
  };
}

function computeFlags({ holders, creator, buys, sells, distinctBuyers, signals }) {
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

  // ── Trader signals (from raw trade rows) ──────────────────────────────────
  if (signals) {
    // 1) Early-buyer / sniper concentration — highest-signal pre-buy check.
    if (signals.enoughForSniper) {
      if (signals.earlyBuyerPct > 50) {
        flags.push({ level: 'strong', text: `First 5 buyers captured ${fmt(signals.earlyBuyerPct, 0)}% of all tokens bought — snipers hold the float` });
      } else if (signals.earlyBuyerPct >= 35) {
        flags.push({ level: 'moderate', text: `First 5 buyers captured ${fmt(signals.earlyBuyerPct, 0)}% of tokens bought — early-buyer heavy` });
      }
    }

    // 2) Creator sold — the other half of the insider-dump picture.
    if (signals.creatorSold) {
      if (signals.creatorSoldFrac >= 0.25) {
        flags.push({ level: 'strong', text: `Creator has sold ${fmt(signals.creatorSoldFrac * 100, 0)}% of their position (${fmt(signals.creatorSoldSui, 1)} SUI) — creator is exiting` });
      } else {
        flags.push({ level: 'moderate', text: `Creator has sold part of their position (${fmt(signals.creatorSoldSui, 1)} SUI)` });
      }
    }

    // 3) Net SUI flow — flag sustained outflow, not a single sell.
    if (signals.netFlowSui < 0 && signals.sellShare > 0.40) {
      flags.push({ level: 'moderate', text: `More SUI leaving than entering — net outflow ${fmt(Math.abs(signals.netFlowSui), 1)} SUI, sells are ${fmt(signals.sellShare * 100, 0)}% of volume` });
    } else if (signals.netFlowSui > 0 && signals.sellShare < 0.25 && signals.buyVol > 0) {
      positives.push(`Net SUI inflow (+${fmt(signals.netFlowSui, 1)} SUI) with light selling — accumulation, not distribution`);
    }

    // 4) Momentum / fade — early spike then silence.
    if (signals.earlyVolShare > 0.60 && signals.minsSinceLast != null && signals.minsSinceLast > 60) {
      flags.push({ level: 'moderate', text: `${fmt(signals.earlyVolShare * 100, 0)}% of volume hit in the first 10 minutes and it has been quiet for ${fmt(signals.minsSinceLast / 60, 1)}h — early spike, gone quiet` });
    }
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
    let buyRows = [], sellRows = [];

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
          buyRows  = rows.filter(r => r.event_type.includes('TokensPurchased') || r.event_type.includes('TokensBought'));
          sellRows = rows.filter(r => r.event_type.includes('TokensSold'));
          buys  = buyRows.length;
          sells = sellRows.length;
          volumeSui =
            buyRows.reduce((a, r)  => a + Number(r.data?.sui_in  ?? 0), 0) / 1e9 +
            sellRows.reduce((a, r) => a + Number(r.data?.sui_out ?? 0), 0) / 1e9;
          distinctBuyers = new Set(buyRows.map(r => r.data?.buyer).filter(Boolean)).size;
        }
      } catch {}
    }

    // Trader signals from the raw rows (net flow, creator-sold, sniper, momentum).
    const signals = computeTradeSignals({ buyRows, sellRows, creator });

    const stage = computeStage({ graduated, progress });
    const { flags, positives, hasLockData, totalLocked } =
      computeFlags({ holders, creator, buys, sells, distinctBuyers, signals });

    // Graduation proximity is a near-term CATALYST (timing), never a risk. Surface
    // it as a positive-note style line for the trader to watch.
    const nearGraduation = !graduated && Number(progress) >= 85;

    const stats = {
      holderCount: holders.length,
      buys, sells, totalTrades: buys + sells, volumeSui,
      distinctBuyers, totalLocked, hasLockData,
      netFlowSui: signals.netFlowSui,
      buyVol: signals.buyVol, sellVol: signals.sellVol,
      sellSharePct: signals.sellShare * 100,
      earlyBuyerPct: signals.enoughForSniper ? signals.earlyBuyerPct : null,
      creatorSold: signals.creatorSold,
      creatorSoldSui: signals.creatorSoldSui,
      minsSinceLast: signals.minsSinceLast,
      nearGraduation,
      // new signals:
      avgBuySui: signals.avgBuySui,
      largestBuyShare: signals.largestBuyShare,
      top3BuyShare: signals.top3BuyShare,
      buyerChurnRatio: signals.buyerChurnRatio,
      roundTrippers: signals.roundTrippers,
      accel: signals.accel,
      recent15: signals.recent15,
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

Detectable signals have ALREADY been computed deterministically. Do NOT invent a risk rating, do NOT contradict these, and do NOT output any "Risk:" line. Write 2 to 4 short, direct sentences for a trader — scale the length to how much there is to say: use 2 sentences when the token is too early to assess (little data), 3 for a normal read, and up to 4 only when there are real flags AND a clear trading picture to explain. Cover, in order: (1) what the concentration/flags mean, (2) the trading picture (flow, buy-size shape, churn, momentum), (3) one specific thing to watch next. No intro, no fluff, no restating the numbers verbatim — interpret them.

Framing rules (strict):
- This is a memecoin launchpad; ALL tokens here are speculative by default. Never imply a token is "safe" or "low risk."
- Concentration percentages are LIQUID (sellable) holdings as a share of TOTAL supply (1B). Locked/vested tokens are EXCLUDED from concentration because they cannot be sold while locked.
- Locked/vested supply is a POSITIVE signal (reduces sell pressure / dump risk), not a concern. Never describe locked tokens as a dump risk.
- An early token with little activity is "too early to assess," NOT "well distributed" and NOT inherently dangerous. Never present an absence of data as either a positive or a red flag.
- Creator fee earnings are normal protocol revenue — never a risk.
- Net SUI outflow and a creator selling their position are genuine sell-pressure signals — weight them. Net inflow with light selling is accumulation, describe it as such without calling the token "safe."
- Early-buyer (sniper) concentration is a key pre-buy risk: if the first few buyers hold most of the float, say so plainly.
- "Near graduation" is a TIMING catalyst (a liquidity-migration volatility event is coming), not a safety judgment. Mention it as something to watch, never as reassurance.
- Buy-size shape matters: many small buys spread across wallets reads as organic demand; a few large buys (one buy = most of the volume) is whale-driven and fragile — say which it is when the data is clear.
- Buyer churn: if there are many buys but few distinct buyers, or many wallets that both bought and sold (round-trippers), the activity is likely flips/wash, not accumulation — discount it, do not call it strong demand.
- Momentum acceleration: trades speeding up vs the prior window is a live catalyst; cooling off after an early spike is a fade. Weight recent activity over stale totals.

Token: ${name} ($${symbol})
Stage: ${stage.label} — ${stage.note}
Curve progress: ${fmt(progress, 1)}% (${fmt(reserveSui, 1)} SUI raised)
Holders: ${stats.holderCount}
Trades: ${stats.totalTrades} (${stats.buys} buys / ${stats.sells} sells), ${stats.distinctBuyers ?? '?'} distinct buyers
Volume: ${fmt(stats.volumeSui, 2)} SUI (buys ${fmt(stats.buyVol, 1)} / sells ${fmt(stats.sellVol, 1)})
Net SUI flow: ${stats.netFlowSui >= 0 ? '+' : ''}${fmt(stats.netFlowSui, 1)} SUI (sells are ${fmt(stats.sellSharePct, 0)}% of volume)
Buy-size shape: avg buy ${fmt(stats.avgBuySui, 2)} SUI; largest single buy is ${fmt(stats.largestBuyShare * 100, 0)}% of buy volume; top 3 buys are ${fmt(stats.top3BuyShare * 100, 0)}%
Buyer churn: ${stats.buyerChurnRatio == null ? 'n/a' : fmt(stats.buyerChurnRatio, 2) + ' distinct-buyers-per-buy (1.0 = all unique)'}; ${stats.roundTrippers} wallet(s) both bought and sold
Momentum: ${stats.accel == null ? 'n/a (no baseline)' : (stats.accel === Infinity ? 'fresh activity, no prior baseline' : fmt(stats.accel, 1) + 'x vs prior window')} (${stats.recent15} trades in last 15 min)
Early-buyer concentration: ${stats.earlyBuyerPct == null ? 'n/a (too few trades)' : fmt(stats.earlyBuyerPct, 0) + '% of tokens taken by first 5 buyers'}
Creator selling: ${stats.creatorSold ? `yes — ${fmt(stats.creatorSoldSui, 1)} SUI sold` : 'none detected'}
Creator fees earned: ${fmt(creatorFeesSui, 3)} SUI (normal revenue, not a risk)
Near graduation: ${stats.nearGraduation ? 'yes — within 15% of graduating; a liquidity-migration volatility event is near' : 'no'}
Lock data available: ${stats.hasLockData ? 'yes' : 'no'}

Detected flags:
${flagText}

Positive notes:
${posText}`;

      const res = await fetch('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-SP-Key': import.meta.env.VITE_SP_INTERNAL_KEY ?? '' },
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

  // Verdict pill severity (drives the design's colored caution pill from the
  // deterministic flags already computed above - never fabricated).
  const verdictLevel = strongCount > 0 ? 'strong' : flagCount > 0 ? 'moderate' : 'clear';
  const verdictPill =
    verdictLevel === 'strong'   ? 'border-red-400/35 bg-red-400/[0.08]'
    : verdictLevel === 'moderate' ? 'border-amber-500/35 bg-amber-500/[0.08]'
    : 'border-lime-400/30 bg-lime-400/[0.08]';
  const verdictText =
    verdictLevel === 'strong'   ? 'text-red-400'
    : verdictLevel === 'moderate' ? 'text-[#f59e0b]'
    : 'text-lime-400';
  const verdictDot =
    verdictLevel === 'strong'   ? '#f87171'
    : verdictLevel === 'moderate' ? '#f59e0b'
    : '#a3e635';

  return (
    <div className="border border-white/[0.08] rounded-2xl p-4 bg-white/[0.015]">
      {/* Header */}
      <div className="flex items-center justify-between mb-3.5">
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] font-mono font-bold tracking-[0.16em] text-white/55">AI ANALYSIS</span>
          <span className="text-[8.5px] font-mono font-semibold text-black bg-lime-400 px-1.5 py-[3px] rounded">BETA</span>
        </div>
        {!loading && !done && (
          <button
            onClick={analyze}
            className="text-[10px] font-mono font-bold tracking-widest px-3 py-1.5 rounded-lg border border-lime-400/60 text-lime-400 hover:bg-lime-400/10 transition-colors"
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

      {/* Verdict pill + flag rows render INSTANTLY once computed (before prose) */}
      {read && (
        <div className="mb-3 space-y-3">
          <div className={`inline-flex items-center gap-[7px] border rounded-[9px] px-[11px] py-2 ${verdictPill}`}>
            <span className="w-[7px] h-[7px] rounded-full flex-none" style={{ background: verdictDot }} />
            <span className={`text-[11px] font-mono font-bold ${verdictText}`}>{read.stage.label.toUpperCase()}</span>
            <span className="text-[9.5px] font-mono text-white/40">{read.stage.note}</span>
          </div>

          <div className="flex flex-col gap-[9px]">
            {flagCount > 0 ? (
              read.flags.map((f, i) => (
                <div key={i} className="flex items-start gap-[9px]">
                  <span className="w-[6px] h-[6px] rounded-full flex-none mt-[6px]" style={{ background: f.level === 'strong' ? '#f87171' : '#f59e0b' }} />
                  <span className="text-[10.5px] font-mono text-white/55 leading-[1.55]">{f.text}</span>
                </div>
              ))
            ) : (
              <div className="flex items-start gap-[9px]">
                <span className="w-[6px] h-[6px] rounded-full flex-none mt-[6px] bg-white/30" />
                <span className="text-[10.5px] font-mono text-white/45 leading-[1.55]">No specific red flags detected in on-chain data</span>
              </div>
            )}

            {read.positives.map((p, i) => (
              <div key={`p${i}`} className="flex items-start gap-[9px]">
                <span className="w-[6px] h-[6px] rounded-full flex-none mt-[6px]" style={{ background: '#a3e635' }} />
                <span className="text-[10.5px] font-mono text-lime-400/70 leading-[1.55]">{p}</span>
              </div>
            ))}
          </div>
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
        <p className="text-[10.5px] font-mono text-white/60 leading-[1.55]">
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
        <p className="text-[9px] font-mono text-white/22 leading-snug mt-2.5 pt-2.5 border-t border-white/[0.06]">
          All launchpad tokens are highly speculative. Flags show risks beyond that baseline — absence of flags is not a safety signal.
        </p>
      )}

      <div className="mt-3 pt-2.5 border-t border-white/[0.06] text-[8.5px] font-mono text-white/22 leading-[1.5]">
        computed from on-chain events {'·'} analysis by Groq {'·'} not financial advice
      </div>
    </div>
  );
}
