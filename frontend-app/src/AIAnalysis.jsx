// AIAnalysis.jsx -- AI-powered token analysis card
//
// Risk model rationale (rewritten):
//   On a memecoin launchpad EVERYTHING is speculative, so a flat High/Med/Low
//   "risk" badge is information-free -- when a healthy-distribution token and a
//   genuinely dangerous one both read "HIGH", the signal is useless and trains
//   users to ignore it. So we DON'T score "how risky is this asset" (answer:
//   always very). We surface SPECIFIC, DETECTABLE red flags relative to a normal
//   early launchpad token, plus a neutral STAGE for context.
//
//   - Flags are computed deterministically in code from on-chain holder/trade
//     data -- the LLM never decides them, it only writes explanatory prose.
//   - Flags render INSTANTLY (client-side) the moment holder data loads; only
//     the prose waits on the model. This also kills the old lag where the card
//     re-fetched everything and showed numbers inconsistent with the page.
//   - "new = risky" is gone. Thin/early data is a neutral STAGE ("Early --
//     limited data"), never a red flag. Absence of data is never a positive
//     signal and never a danger signal -- it's just limited data.
//
//   Concentration (the real, detectable danger):
//     - excludes the bonding curve (never a holder here -- curve isn't a buyer)
//     - excludes VESTED/LOCKED balances (creator who locked tokens is LOW risk)
//     - measured against CIRCULATING supply (the tokensSoldWhole prop --
//       tokens actually sold out of the curve), with the same wallet's share
//       of the full 1B total kept as secondary context inside the flag text
//     - too-early gate: no concentration flags until the token has >= 10
//       distinct holders AND >= 40M circulating -- below that any percentage
//       is noise and the stage stays "Early"
//     - single non-creator wallet > 30% of circulating   -> strong flag
//     - top-10 wallets combined > 60% of circulating     -> strong flag
//     - top-10 combined 40-60% of circulating            -> moderate flag
//
//   Creator:
//     - holding mostly LOCKED/vested      -> positive context (not a flag)
//     - holding large & LIQUID            -> flag (dump risk)
//     - creator fees claimed              -> NEVER a flag (it's their reward)
//     - if lock data is unavailable (older indexer) -> contextual, never flagged
//
//   Wash/thin liquidity:
//     - trades concentrated in 1-2 wallets -> flag (possible wash volume)
//     - many buys from few wallets (churn), round-trip flippers, and
//       whale-dominated buy volume are moderate flags too
//
//   Launch window (sniper + early-volume signals):
//     - the /trades fetch is DESC; when it returns < 500 rows it spans the
//       whole history so local launch-window math is valid. At the 500-row
//       cap the true first trades are re-fetched from /trades/first (ASC);
//       if that endpoint is unavailable the launch-window signals are
//       SUPPRESSED (null), never computed from the wrong window.
//     - creator buys are excluded from the first-5-buyers sniper window;
//       creator selling stays its own separate signal.
//
//   Bundles (optional /bundles endpoint -- degrades silently when absent):
//     - largest kind='funding' cluster's pct_of_circulating:
//       >= 25% of circulating -> strong flag, >= 12% -> moderate flag

import React, { useState } from 'react';

const INDEXER_URL = import.meta.env.VITE_INDEXER_URL || '';
const TOKEN_SCALE = 1e6;

// Event-type row filters -- shared by the DESC trades fetch and the ASC
// launch-window fetch so both windows split rows identically.
const isBuyRow  = (r) => r.event_type.includes('TokensPurchased') || r.event_type.includes('TokensBought');
const isSellRow = (r) => r.event_type.includes('TokensSold');

function fmt(n, d = 2) {
  if (n == null) return '-';
  return Number(n).toLocaleString(undefined, { maximumFractionDigits: d });
}

// -- Neutral stage from curve progress -- CONTEXT, not risk ------------------
function computeStage({ graduated, progress }) {
  if (graduated)         return { label: 'Graduated', note: 'Now trading on a DEX' };
  const p = Number(progress) || 0;
  if (p < 5)             return { label: 'Early',           note: 'Limited data — recently launched' };
  if (p < 60)            return { label: 'Active',          note: 'Filling the bonding curve' };
  return { label: 'Near graduation', note: 'Approaching the DEX listing threshold' };
}

// -- Deterministic flags from on-chain data. The LLM never decides these. ----
// holders: [{ address, balance, locked, liquid, isCreator }]  (whole tokens)
//   `locked`/`liquid`/`isCreator` may be absent on older indexer deploys -- in
//   that case we degrade gracefully: treat full balance as liquid and the
//   creator axis as contextual (never a false flag).
// computeTradeSignals -- derive trader-grade signals from the raw trade rows the
// page already fetches. All amounts come straight off the indexer event `data`:
//   buys:  data.sui_in (MIST), data.tokens_out (atomic x1e6), data.buyer
//   sells: data.sui_out (MIST), data.tokens_in (atomic x1e6), data.seller
//   every row: timestamp_ms (epoch ms string)
// launchRows: rows known to cover the token's TRUE first trades (the full DESC
// fetch when it came back complete, or the ASC /trades/first page when the
// DESC fetch was capped), or null when the launch window is unavailable -- in
// that case the launch-window signals (sniper, early-volume share) stay null.
// Returns raw metrics; computeFlags turns them into flags/positives so the
// thresholds live in one place.
function computeTradeSignals({ buyRows, sellRows, creator, launchRows }) {
  const MIST = 1e9;
  const num = (v) => Number(v || 0);

  // -- Net SUI flow (accumulation vs bleed) ----------------------------------
  const buyVol  = buyRows.reduce((a, r) => a + num(r.data?.sui_in)  / MIST, 0);
  const sellVol = sellRows.reduce((a, r) => a + num(r.data?.sui_out) / MIST, 0);
  const netFlowSui = buyVol - sellVol;
  const totalVol = buyVol + sellVol;
  const sellShare = totalVol > 0 ? sellVol / totalVol : 0;

  // -- Creator sold? (compare creator sells vs creator buys, by tokens) ------
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
  // Clamped at 1 so off-curve supply sources can never read as ">100% of position".
  const creatorSoldFrac = Math.min(1, creatorBoughtTokens > 0
    ? creatorSoldTokens / creatorBoughtTokens
    : (creatorSoldTokens > 0 ? 1 : 0));

  // -- Launch-window signals (sniper + early-volume share) -------------------
  // Computed ONLY from launchRows -- rows that provably cover the token's
  // first trades. launchRows == null means the window is unavailable (DESC
  // fetch capped at 500 and no ASC endpoint), so both signals stay null
  // rather than being miscomputed from the wrong window.
  const launchWindowOk = launchRows != null;
  let earlyBuyerPct = null, enoughForSniper = false, earlyVolShare = null;
  let minsSinceLast = null;
  const allRows = [...buyRows, ...sellRows];
  if (launchWindowOk) {
    const launchByTime = [...launchRows].sort((a, b) => num(a.timestamp_ms) - num(b.timestamp_ms));

    // Sniper: first 5 NON-CREATOR buys' share of all tokens bought. Creator
    // buys are excluded from the window (creator selling is its own signal).
    const launchBuys = launchByTime.filter(r => isBuyRow(r) && (creator == null || r.data?.buyer !== creator));
    const totalTokensBought = buyRows.reduce((a, r) => a + num(r.data?.tokens_out), 0);
    if (launchBuys.length >= 5 && totalTokensBought > 0) { // need a real sample
      const first5Tokens = launchBuys.slice(0, 5).reduce((a, r) => a + num(r.data?.tokens_out), 0);
      // Clamped: at the 500-row DESC cap the denominator is the capped window,
      // not the true total (unknowable), so the raw ratio can exceed 1.
      earlyBuyerPct = Math.min(1, first5Tokens / totalTokensBought) * 100;
      enoughForSniper = true;
    }

    // Early-volume share: first 10 minutes after launch vs everything fetched.
    if (launchByTime.length >= 4) {
      const t0 = num(launchByTime[0].timestamp_ms);
      const tenMin = 10 * 60 * 1000;
      const volOf = (r) => (r.data?.sui_in ? num(r.data.sui_in) : num(r.data?.sui_out)) / MIST;
      const earlyVol = launchByTime.filter(r => num(r.timestamp_ms) - t0 <= tenMin).reduce((a, r) => a + volOf(r), 0);
      // Clamped: capped DESC history makes the true total unknowable; the
      // clamp keeps the flag prose sane when the ASC window exceeds it.
      earlyVolShare = totalVol > 0 ? Math.min(1, earlyVol / totalVol) : 0;
    }
  }
  // "Gone quiet" reads off the DESC fetch -- the newest rows are always there.
  if (allRows.length >= 4) {
    const tLast = allRows.reduce((a, r) => Math.max(a, num(r.timestamp_ms)), 0);
    minsSinceLast = (Date.now() - tLast) / 60000;
  }

  // -- NEW: buy-size distribution (organic crowd vs whale-driven) ------------
  // Average buy size and the share of buy volume from the single largest buy.
  // Many small buys = organic; a few large buys = whale-driven (different token).
  const buySizes = buyRows.map(r => num(r.data?.sui_in) / MIST).filter(v => v > 0).sort((a, b) => b - a);
  const avgBuySui = buySizes.length ? buyVol / buySizes.length : 0;
  const largestBuySui = buySizes[0] ?? 0;
  const largestBuyShare = buyVol > 0 ? largestBuySui / buyVol : 0;       // 0..1
  // Top-3 buys' share of all buy volume -- a concentration-of-demand read.
  const top3BuyShare = buyVol > 0 ? (buySizes.slice(0, 3).reduce((a, b) => a + b, 0) / buyVol) : 0;

  // -- NEW: wash / same-wallet churn -----------------------------------------
  // Distinct buyers vs total buys. A low ratio (many buys, few wallets) suggests
  // wash trading or a small group cycling -- inflates apparent activity.
  const distinctBuyersN = new Set(buyRows.map(r => r.data?.buyer).filter(Boolean)).size;
  const buyerChurnRatio = buyRows.length > 0 ? distinctBuyersN / buyRows.length : null; // ~1 organic, low = churn
  // Wallets that BOTH bought and sold (round-trippers) -- flips, not holders.
  const buyerSet = new Set(buyRows.map(r => r.data?.buyer).filter(Boolean));
  const sellerSet = new Set(sellRows.map(r => r.data?.seller).filter(Boolean));
  let roundTrippers = 0;
  for (const w of sellerSet) if (buyerSet.has(w)) roundTrippers++;
  const distinctSellersN = sellerSet.size;

  // -- NEW: holder/trade acceleration (last 15 min vs prior hour) ------------
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
    earlyBuyerPct, enoughForSniper, launchWindowOk,
    earlyVolShare, minsSinceLast,
    tradeCount: buyRows.length + sellRows.length,
    avgBuySui, largestBuySui, largestBuyShare, top3BuyShare,
    buyerChurnRatio, roundTrippers, distinctBuyersN, distinctSellersN,
    recent15, prior45, accel,
  };
}

function computeFlags({ holders, creator, buys, sells, distinctBuyers, signals, circulatingWhole, bundleTop }) {
  const flags = [];      // [{ level: 'strong'|'moderate', text }]
  const positives = [];  // ['...']

  const TOTAL_SUPPLY = 1_000_000_000; // 1B mint cap -- secondary context only
  // Primary concentration denominator: CIRCULATING supply in whole tokens
  // (the tokensSoldWhole prop -- tokens actually sold out of the curve).
  const circulating = Math.max(0, Number(circulatingWhole) || 0);

  const hasLockData = holders.some(h => h.liquid != null || h.locked != null);

  // Liquid (sellable) balance per wallet. Concentration risk is about what can
  // hit the market NOW, so flags use liquid only, measured against CIRCULATING
  // supply with the share of the 1B total kept as secondary context.
  const liquidOf = (h) => {
    if (h.liquid != null) return Math.max(0, Number(h.liquid));
    return Math.max(0, Number(h.balance) || 0); // no lock data -> full balance is liquid
  };
  const lockedOf = (h) => Math.max(0, Number(h.locked) || 0);
  const isCreatorRow = (h) =>
    (h.isCreator === true) || (creator != null && h.address === creator);

  // -- Concentration (non-creator wallets, LIQUID only, vs circulating) ------
  // Locked tokens NEVER count toward a flag -- they can't be dumped while
  // locked, so they don't represent sell pressure. They surface as a POSITIVE
  // signal below instead.
  // Too-early gate: with < 10 distinct holders or < 40M circulating any
  // percentage is noise -- emit no concentration flag (stage stays "Early").
  const nonCreatorLiquid = holders
    .filter(h => !isCreatorRow(h))
    .map(liquidOf)
    .sort((a, b) => b - a);

  const CIRC_GATE_WHOLE = 40_000_000; // min circulating (whole tokens) to judge concentration
  if (holders.length >= 10 && circulating >= CIRC_GATE_WHOLE) {
    const topSingle = nonCreatorLiquid[0] ?? 0;
    const top10 = nonCreatorLiquid.slice(0, 10).reduce((a, b) => a + b, 0);
    const topSinglePct = (topSingle / circulating) * 100;
    const top10Pct = (top10 / circulating) * 100;

    if (topSinglePct > 30) {
      flags.push({ level: 'strong', text: `One wallet holds ${fmt(topSinglePct, 0)}% of circulating supply (${fmt((topSingle / TOTAL_SUPPLY) * 100, 0)}% of total)` });
    }
    if (top10Pct > 60) {
      flags.push({ level: 'strong', text: `Top 10 wallets hold ${fmt(top10Pct, 0)}% of circulating supply (${fmt((top10 / TOTAL_SUPPLY) * 100, 0)}% of total)` });
    } else if (top10Pct >= 40) {
      flags.push({ level: 'moderate', text: `Top 10 wallets hold ${fmt(top10Pct, 0)}% of circulating supply (${fmt((top10 / TOTAL_SUPPLY) * 100, 0)}% of total)` });
    }
  }

  // -- Locked supply = POSITIVE signal (can't be dumped while locked) --------
  const totalLocked = holders.reduce((a, h) => a + lockedOf(h), 0);
  if (hasLockData && totalLocked > 0) {
    const lockedPct = (totalLocked / TOTAL_SUPPLY) * 100;
    if (lockedPct >= 1) {
      positives.push(`${fmt(lockedPct, 0)}% of supply is locked/vested — cannot be dumped while locked`);
    }
  }

  // -- Creator: locked holding is a positive; liquid holding is NOT flagged --
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

  // -- Wash / thin liquidity -------------------------------------------------
  const totalTrades = buys + sells;
  if (totalTrades >= 8 && distinctBuyers != null && distinctBuyers <= 2) {
    flags.push({ level: 'moderate', text: `Trades concentrated in ${distinctBuyers} wallet${distinctBuyers === 1 ? '' : 's'} — possible wash volume` });
  }

  // -- Trader signals (from raw trade rows) ----------------------------------
  if (signals) {
    // 1) Early-buyer / sniper concentration -- highest-signal pre-buy check.
    if (signals.enoughForSniper) {
      if (signals.earlyBuyerPct > 50) {
        flags.push({ level: 'strong', text: `First 5 buyers captured ${fmt(signals.earlyBuyerPct, 0)}% of all tokens bought — snipers hold the float` });
      } else if (signals.earlyBuyerPct >= 35) {
        flags.push({ level: 'moderate', text: `First 5 buyers captured ${fmt(signals.earlyBuyerPct, 0)}% of tokens bought — early-buyer heavy` });
      }
    }

    // 2) Creator sold -- the other half of the insider-dump picture.
    if (signals.creatorSold) {
      if (signals.creatorSoldFrac >= 0.25) {
        flags.push({ level: 'strong', text: `Creator has sold ${fmt(signals.creatorSoldFrac * 100, 0)}% of their position (${fmt(signals.creatorSoldSui, 1)} SUI) — creator is exiting` });
      } else {
        flags.push({ level: 'moderate', text: `Creator has sold part of their position (${fmt(signals.creatorSoldSui, 1)} SUI)` });
      }
    }

    // 3) Net SUI flow -- flag sustained outflow, not a single sell.
    if (signals.netFlowSui < 0 && signals.sellShare > 0.40) {
      flags.push({ level: 'moderate', text: `More SUI leaving than entering — net outflow ${fmt(Math.abs(signals.netFlowSui), 1)} SUI, sells are ${fmt(signals.sellShare * 100, 0)}% of volume` });
    } else if (signals.netFlowSui > 0 && signals.sellShare < 0.25 && signals.buyVol > 0) {
      positives.push(`Net SUI inflow (+${fmt(signals.netFlowSui, 1)} SUI) with light selling — accumulation, not distribution`);
    }

    // 4) Momentum / fade -- early spike then silence. earlyVolShare is null
    //    when the launch window is unavailable, which fails the > test.
    if (signals.earlyVolShare > 0.60 && signals.minsSinceLast != null && signals.minsSinceLast > 60) {
      flags.push({ level: 'moderate', text: `${fmt(signals.earlyVolShare * 100, 0)}% of volume hit in the first 10 minutes and it has been quiet for ${fmt(signals.minsSinceLast / 60, 1)}h — early spike, gone quiet` });
    }

    // 5) Buyer churn -- many buys recycled through few wallets.
    if (signals.buyerChurnRatio != null && signals.buyerChurnRatio < 0.35 && buys >= 10) {
      flags.push({ level: 'moderate', text: `Many buys from few wallets (${signals.distinctBuyersN} wallets across ${buys} buys) — possible churn/wash` });
    }

    // 6) Round-trippers -- most sellers are flippers, not holders.
    if (signals.distinctSellersN >= 6 && signals.roundTrippers >= signals.distinctSellersN * 0.5) {
      flags.push({ level: 'moderate', text: `${signals.roundTrippers} of ${signals.distinctSellersN} sellers also bought in — round-trip flipping, not holding` });
    }

    // 7) Whale-driven demand -- top 3 buys dominate buy volume.
    if (signals.top3BuyShare > 0.70 && buys >= 8) {
      flags.push({ level: 'moderate', text: `Whale-driven demand — top 3 buys are ${fmt(signals.top3BuyShare * 100, 0)}% of buy volume` });
    }
  }

  // -- Bundle: wallets sharing one funding source (optional /bundles data) ---
  // bundleTop = { wallets, pct } for the largest kind='funding' cluster, or
  // null when the endpoint is unavailable -- no data is never a flag.
  if (bundleTop && bundleTop.pct != null) {
    if (bundleTop.pct >= 25) {
      flags.push({ level: 'strong', text: `${fmt(bundleTop.wallets, 0)} wallets sharing one funding source hold ${fmt(bundleTop.pct, 0)}% of circulating supply — likely bundle` });
    } else if (bundleTop.pct >= 12) {
      flags.push({ level: 'moderate', text: `${fmt(bundleTop.wallets, 0)} wallets sharing one funding source hold ${fmt(bundleTop.pct, 0)}% of circulating supply — possible bundle` });
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
  const [dataFail, setDataFail] = useState(false); // BOTH data fetches failed -> honest neutral state

  // Fetch holder + trade data once, compute flags client-side (instant),
  // then ask the LLM only for prose. Returns the computed read so analyze()
  // can render flags immediately before the model responds.
  async function fetchAndCompute() {
    let holders = [];
    let buys = 0, sells = 0, volumeSui = 0, distinctBuyers = null;
    let buyRows = [], sellRows = [];
    let holdersOk = false, tradesOk = false;
    let launchRows = null; // rows covering the true launch window; null = unavailable
    let bundleTop = null;  // largest kind='funding' cluster { wallets, pct } from /bundles

    if (INDEXER_URL && curveId) {
      // Holders (with liquid/locked/isCreator when available)
      try {
        const hr = await fetch(`${INDEXER_URL}/token/${curveId}/holders`, { signal: AbortSignal.timeout(5000) });
        if (hr.ok) { holders = await hr.json(); holdersOk = true; }
      } catch {}

      // Trades
      try {
        const tr = await fetch(`${INDEXER_URL}/token/${curveId}/trades?limit=500`, { signal: AbortSignal.timeout(5000) });
        if (tr.ok) {
          const rows = await tr.json();
          tradesOk = true;
          buyRows  = rows.filter(isBuyRow);
          sellRows = rows.filter(isSellRow);
          buys  = buyRows.length;
          sells = sellRows.length;
          volumeSui =
            buyRows.reduce((a, r)  => a + Number(r.data?.sui_in  ?? 0), 0) / 1e9 +
            sellRows.reduce((a, r) => a + Number(r.data?.sui_out ?? 0), 0) / 1e9;
          distinctBuyers = new Set(buyRows.map(r => r.data?.buyer).filter(Boolean)).size;

          // Launch-window integrity: the fetch above is DESC. Under 500 rows
          // it spans the whole history -> valid launch window. At the 500-row
          // cap the oldest trades are missing, so fetch the true first trades
          // (ASC); if that endpoint is unavailable launchRows stays null and
          // the launch-window signals are suppressed, never miscomputed.
          if (rows.length < 500) {
            launchRows = rows;
          } else {
            try {
              const fr = await fetch(`${INDEXER_URL}/token/${curveId}/trades/first?limit=25`, { signal: AbortSignal.timeout(5000) });
              if (fr.ok) {
                const firstRows = await fr.json();
                if (Array.isArray(firstRows) && firstRows.length) launchRows = firstRows;
              }
            } catch {}
          }
        }
      } catch {}

      // Bundles (optional endpoint -- degrade silently when absent/erroring).
      try {
        const br = await fetch(`${INDEXER_URL}/token/${curveId}/bundles`, { signal: AbortSignal.timeout(5000) });
        if (br.ok) {
          const bd = await br.json();
          const clusters = Array.isArray(bd) ? bd : (Array.isArray(bd?.clusters) ? bd.clusters : []);
          for (const c of clusters) {
            if (c?.kind !== 'funding') continue;
            const pct = Number(c.pct_of_circulating);
            if (!Number.isFinite(pct)) continue;
            const wallets = Array.isArray(c.wallets) ? c.wallets.length
              : Number(c.wallet_count ?? c.addresses?.length ?? c.size ?? 0);
            if (!bundleTop || pct > bundleTop.pct) bundleTop = { wallets, pct };
          }
        }
      } catch {}
    }

    // Trader signals from the raw rows (net flow, creator-sold, sniper, momentum).
    const signals = computeTradeSignals({ buyRows, sellRows, creator, launchRows });

    const stage = computeStage({ graduated, progress });
    const { flags, positives, hasLockData, totalLocked } =
      computeFlags({ holders, creator, buys, sells, distinctBuyers, signals, circulatingWhole: tokensSoldWhole, bundleTop });

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
      launchWindowOk: signals.launchWindowOk,
      creatorSold: signals.creatorSold,
      creatorSoldSui: signals.creatorSoldSui,
      minsSinceLast: signals.minsSinceLast,
      nearGraduation,
      avgBuySui: signals.avgBuySui,
      largestBuyShare: signals.largestBuyShare,
      top3BuyShare: signals.top3BuyShare,
      buyerChurnRatio: signals.buyerChurnRatio,
      roundTrippers: signals.roundTrippers,
      distinctSellers: signals.distinctSellersN,
      // Infinity does not survive JSON (stringifies to null), so "fresh
      // activity, no baseline" travels as its own boolean.
      accel: Number.isFinite(signals.accel) ? signals.accel : null,
      accelFresh: signals.accel === Infinity,
      recent15: signals.recent15,
      bundlePct: bundleTop ? bundleTop.pct : null,
      bundleWallets: bundleTop ? bundleTop.wallets : null,
      // Props the server renders into the data block:
      progress: Number(progress) || 0,
      reserveSui: Number(reserveSui) || 0,
      creatorFeesSui: Number(creatorFeesSui) || 0,
    };
    return { stage, flags, positives, stats, dataOk: holdersOk || tradesOk };
  }

  const analyze = async () => {
    setLoading(true);
    setError(null);
    setProse(null);
    setDone(false);
    setRead(null);
    setDataFail(false);

    try {
      const computed = await fetchAndCompute();

      // Honest failure: BOTH fetches failed -> no verdict, no LLM call.
      if (!computed.dataOk) {
        setDataFail(true);
        return;
      }

      // Render flags + stage IMMEDIATELY -- no wait on the model.
      setRead(computed);

      // The server owns the prompt template; the client ships structured
      // data only (never a prompt field -- the server rejects those).
      const { stage, flags, positives, stats } = computed;
      const res = await fetch('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-SP-Key': import.meta.env.VITE_SP_INTERNAL_KEY ?? '' },
        body: JSON.stringify({ curveId, name, symbol, stage, stats, flags, positives }),
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

      {/* Honest failure: both data fetches failed -- no verdict, no LLM call */}
      {dataFail && !loading && (
        <div className="text-[11px] font-mono text-[#f59e0b]/80 py-1">
          {"Couldn't load on-chain data — try again."}
        </div>
      )}

      {/* Prose */}
      {prose && !loading && (
        <p className="text-[10.5px] font-mono text-white/60 leading-[1.55]">
          {proseLines.join(' ')}
          <span className="text-white/40">{' NFA — Not Financial Advice.'}</span>
        </p>
      )}

      {/* Idle */}
      {!loading && !read && !error && !dataFail && (
        <p className="text-[10px] font-mono text-white/25 leading-relaxed">
          Get an on-chain read: holder concentration (excluding vested/locked), trading activity, and curve stage. Flags are computed from chain data, not guessed.
        </p>
      )}

      {/* Always-on baseline disclaimer */}
      {read && (
        <p className="text-[9px] font-mono text-white/22 leading-snug mt-2.5 pt-2.5 border-t border-white/[0.06]">
          {'All launchpad tokens are highly speculative. Flags show risks beyond that baseline — absence of flags is not a safety signal.'}
        </p>
      )}

      <div className="mt-3 pt-2.5 border-t border-white/[0.06] text-[8.5px] font-mono text-white/22 leading-[1.5]">
        computed from on-chain events {'·'} analysis by Groq {'·'} not financial advice
      </div>
    </div>
  );
}
