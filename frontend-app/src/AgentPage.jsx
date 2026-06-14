// AgentPage.jsx — Autonomous agent console (routed page, renders inside <main>).
//
// Flow:
//   1. Natural-language goal -> Groq plans off-chain (/api/agent-plan) into a
//      per-workflow plan: launch_and_buy | buy | sell | claim | alerts.
//   2. Operator approves. The browser resolves any runtime values it must supply
//      (sell "ALL" -> real token balance; claim tokenType from the curve), then
//      posts { workflow, ... } to the agent-runner (/run-dag).
//   3. The runner maps workflow -> published Nexus DAG id, executes via the
//      `nexus` CLI, returns the on-chain DAGExecution id + tx digest.
//
// The LLM plans OFF-CHAIN; the DAG does the on-chain work. Violet identity.
import React, { useState, useCallback, useRef, useEffect } from 'react';
import { ArrowLeft, Sparkles, Play, Check, X, Loader, ExternalLink, Bot } from 'lucide-react';
import { useCurrentAccount } from '@mysten/dapp-kit-react';
import { SuiGraphQLClient } from '@mysten/sui/graphql';

const RUNNER_URL  = import.meta.env.VITE_AGENT_RUNNER_URL || 'https://suipump-agent-runner.onrender.com';
const BRIDGE_URL  = import.meta.env.VITE_SUIPUMP_BRIDGE_URL || 'https://suipump-bridge.onrender.com';
const INDEXER_URL = import.meta.env.VITE_INDEXER_URL || 'https://suipump-62s2.onrender.com';
const TOKEN_DECIMALS = 6;

const suiscanObject = (id) => `https://suiscan.xyz/testnet/object/${id}`;
const suiscanTx     = (d)  => `https://suiscan.xyz/testnet/tx/${d}`;

const GRAD = { 0: 'Cetus', 1: 'DeepBook', 2: 'Turbos' };

// Tool node metadata per workflow — drives the execution animation.
const WORKFLOW_NODES = {
  launch_and_buy: [
    { id: 'launch', tool: 'xyz.suipump.launch@1', label: 'Launch',  desc: 'Create token on bonding curve' },
    { id: 'buy',    tool: 'xyz.suipump.buy@1',    label: 'Dev-buy', desc: 'Agent makes the first buy' },
  ],
  buy:    [{ id: 'buy',    tool: 'xyz.suipump.buy@1',    label: 'Buy',    desc: 'Buy tokens on the curve' }],
  sell:   [{ id: 'sell',   tool: 'xyz.suipump.sell@1',   label: 'Sell',   desc: 'Sell tokens back to SUI' }],
  claim:  [{ id: 'claim',  tool: 'xyz.suipump.claim@1',  label: 'Claim',  desc: 'Claim creator fees' }],
  alerts: [{ id: 'alerts', tool: 'xyz.suipump.alerts@1', label: 'Monitor', desc: 'Watch graduation / price' }],
  tpsl:   [{ id: 'arm',    tool: 'strategy.tpsl@1',      label: 'Arm strategy', desc: 'Standing TP/SL order the agent watches' }],
  sniper: [{ id: 'arm',    tool: 'strategy.sniper@1',    label: 'Arm sniper',   desc: 'Standing buy that fires on every matching launch' }],
  dca:    [{ id: 'arm',    tool: 'strategy.dca@1',       label: 'Arm DCA',      desc: 'Standing accumulation: buys on a schedule or on each dip' }],
  buy_then_tpsl: [
    { id: 'buy', tool: 'xyz.suipump.buy@1', label: 'Buy',          desc: 'Buy the position now' },
    { id: 'arm', tool: 'strategy.tpsl@1',   label: 'Arm strategy', desc: 'Then watch price and auto-sell at the target' },
  ],
};

// Client-side strategy intent parser. The LLM planner only emits one-shot
// workflows (buy/sell/claim/alerts/launch); a take-profit / stop-loss is a
// STANDING order, so we recognize it here and build a `tpsl` plan that creates
// an order in the strategy store. Returns a plan object or null (not a strategy).
//
// Recognized shapes (case-insensitive):
//   "take profit ... at +20%"          -> TP rung at 1.20x, sell 100%
//   "take profit ... at +20% sell 50%" -> TP rung at 1.20x, sell 50%
//   "dump all ... at +20%"             -> TP rung at 1.20x, sell 100%
//   "sell 50% ... at +30%"             -> TP rung at 1.30x, sell 50%
//   "stop loss ... at -15%"            -> SL at 0.85x
// A curve 0x... must be present. TP and SL can appear together.
function parseStrategyGoal(text) {
  const g = String(text || '');
  const curveMatch = g.match(/0x[0-9a-fA-F]{4,}/);
  if (!curveMatch) return null;
  const curveId = curveMatch[0];

  const lower = g.toLowerCase();
  const hasStrategyWord = /\b(take\s*profit|tp|stop\s*loss|sl|dump\s+all)\b/.test(lower);
  if (!hasStrategyWord) return null;

  // Take-profit: a "+N%" near a take-profit / dump / sell intent.
  const tp = [];
  const tpPct = lower.match(/(?:take\s*profit|tp|dump\s+all|profit)[^+\-]*\+?\s*(\d+(?:\.\d+)?)\s*%/);
  if (tpPct) {
    const pct = Number(tpPct[1]);
    // sell size: "sell 50%" / "dump all" / "100%"; default 100.
    let sellPct = 100;
    const sellMatch = lower.match(/sell\s+(\d+(?:\.\d+)?)\s*%/);
    if (sellMatch) sellPct = Number(sellMatch[1]);
    else if (/dump\s+all|sell\s+all/.test(lower)) sellPct = 100;
    if (pct > 0) tp.push({ multiple: 1 + pct / 100, sellPct });
  }

  // Stop-loss: a "-N%" near a stop-loss intent.
  let stopLoss = null;
  const slPct = lower.match(/(?:stop\s*loss|sl)[^+\-]*-\s*(\d+(?:\.\d+)?)\s*%/);
  if (slPct) {
    const pct = Number(slPct[1]);
    if (pct > 0 && pct < 100) stopLoss = { multiple: 1 - pct / 100 };
  }

  if (!tp.length && !stopLoss) return null;

  // Compound: a leading "buy N sui" in the SAME goal means buy first, then arm
  // the take-profit/stop-loss on the bought position. e.g.
  //   "buy 500 sui of 0x… , take profit at +20% sell all"
  // The buy settles immediately via the bridge; the TP/SL is then armed at the
  // post-buy fill price so "+20%" is measured from what we actually paid.
  const buyMatch = lower.match(/buy\s+(\d+(?:\.\d+)?)\s*sui/);
  if (buyMatch) {
    const amountSui = Number(buyMatch[1]);
    if (amountSui > 0) {
      const tpDescC = tp.length ? `take-profit ${tp.map(r => `+${Math.round((r.multiple - 1) * 100)}% (sell ${r.sellPct}%)`).join(', ')}` : '';
      const slDescC = stopLoss ? `stop-loss -${Math.round((1 - stopLoss.multiple) * 100)}%` : '';
      const summaryC = `Buy ${amountSui} SUI of ${curveId.slice(0, 10)}…, then arm ${[tpDescC, slDescC].filter(Boolean).join(' · ')}. The agent buys now and sells automatically when a trigger is hit.`;
      return {
        workflow: 'buy_then_tpsl',
        summary: summaryC,
        buy: { curveId, amountSui },
        tpsl: { curveId, takeProfit: tp, stopLoss },
      };
    }
  }

  const tpDesc = tp.length ? `take-profit ${tp.map(r => `+${Math.round((r.multiple - 1) * 100)}% (sell ${r.sellPct}%)`).join(', ')}` : '';
  const slDesc = stopLoss ? `stop-loss -${Math.round((1 - stopLoss.multiple) * 100)}%` : '';
  const summary = `Arm a standing strategy on ${curveId.slice(0, 10)}…: ${[tpDesc, slDesc].filter(Boolean).join(' · ')}. The agent watches the price and sells automatically when a trigger is hit.`;

  return { workflow: 'tpsl', summary, tpsl: { curveId, takeProfit: tp, stopLoss } };
}

// Client-side sniper intent parser. Sniper is a STANDING order keyed on a filter
// (creator wallet / symbol / name) that fires a buy on every NEW launch the brain
// sees match. Like TP/SL it is recognized here so the 64-hex creator address is
// never handed to the LLM (which mangles it) and no network round-trip is needed
// to plan. Returns a sniper plan or null.
//
// Trigger verb required ("snipe"/"sniper", or a "buy/ape every|all token(s)"
// standing-buy phrasing) so a stray "every" in a normal buy never misroutes.
// The `then` field is reserved (null) so sniper -> TP/SL chaining is additive.
function parseSniperGoal(text) {
  const g = String(text || '');
  const lower = g.toLowerCase();

  const isSnipe =
    /\bsnipe\b|\bsniper\b/.test(lower) ||
    /\b(?:buy|ape|grab|get)\b[\s\S]*\b(?:every|all)\b[\s\S]*\b(?:token|launch|coin)/.test(lower) ||
    /\b(?:every|all)\b[\s\S]*\b(?:token|launch|coin)s?\b[\s\S]*\b(?:launched\s+)?by\b/.test(lower);
  if (!isSnipe) return null;

  // All 64-hex ids -> creator filters (a creator is a wallet; same shape as a CA).
  const hexes = g.match(/0x[a-fA-F0-9]{60,66}/g);
  const creators = hexes ? Array.from(new Set(hexes.map(s => s.toLowerCase()))) : [];

  // amount: "snipe N sui" / "buy N sui" / "N sui"; default 0.1.
  let amountSui = 0.1;
  const amt = lower.match(/(?:dev[\s-]?buy|buy|ape|snipe)\s+(\d+(?:\.\d+)?)\s*sui/) || lower.match(/(\d+(?:\.\d+)?)\s*sui/);
  if (amt) amountSui = Number(amt[1]);

  // symbols: "symbol: PEPE" / "ticker PEPE".
  const symbols = [];
  { let m; const re = /(?:symbol|ticker)\s*[:\-]?\s*\$?([a-z0-9]{1,12})/ig;
    while ((m = re.exec(g)) !== null) symbols.push(m[1].toUpperCase()); }

  // nameIncludes: "named X" / "called X" / "name contains X" — stop at a clause
  // boundary or a 0x address so it doesn't swallow "by 0x…".
  let nameIncludes = null;
  {
    const m = g.match(/(?:name\s+(?:contains|includes|with)|named|called)\s*[:\-]?\s*["']?([a-z0-9][a-z0-9 ]{0,38}?)["']?(?=\s+(?:by|from|launched|with|and|or|symbol|ticker|max|first|up\s+to|limit)\b|\s+0x|["']|$)/i);
    if (m) { let v = m[1].trim().toLowerCase().replace(/\s+(?:by|from|launched|with|and|or)$/i, '').trim(); if (v) nameIncludes = v.slice(0, 64); }
  }

  // match: any/or across categories -> "any"; default "all" (AND).
  const match = /\b(?:any of|or|either)\b/i.test(g) ? 'any' : 'all';

  // maxSnipes: "first N" / "up to N" / "max N" / "N snipes|times|buys". null = unbounded.
  let maxSnipes = null;
  {
    const m = lower.match(/(?:first|up\s+to|max(?:imum)?|limit(?:\s+to)?)\s+(\d+)/) || lower.match(/(\d+)\s*(?:snipes?|times|buys?)\b/);
    if (m) { const n = parseInt(m[1], 10); if (Number.isFinite(n) && n > 0) maxSnipes = n; }
  }

  const hasFilter = creators.length > 0 || symbols.length > 0 || nameIncludes != null;

  const sniper = { amountSui, match };
  if (creators.length)      sniper.creators = creators;
  if (symbols.length)       sniper.symbols = symbols;
  if (nameIncludes != null) sniper.nameIncludes = nameIncludes;
  if (!hasFilter)           sniper.all = true;   // explicit opt-in to every launch
  if (maxSnipes != null)    sniper.maxSnipes = maxSnipes;

  // ── then.tpsl: a "dump all / take profit at +X%" (and/or "stop loss at -Y%")
  // in the SAME sentence means "after each snipe, arm a TP/SL on that curve".
  // The brain reads the real post-buy fill price and seeds entry, so "+X%" is
  // measured from what the snipe actually paid. Same extraction shape as
  // parseStrategyGoal. `then` stays null when no exit leg is present.
  let then = null;
  {
    const tp = [];
    const tpPct = lower.match(/(?:take\s*profit|tp|dump\s+all|dump|profit)[^+\-]*\+?\s*(\d+(?:\.\d+)?)\s*%/);
    if (tpPct) {
      const pct = Number(tpPct[1]);
      let sellPct = 100;
      const sellMatch = lower.match(/sell\s+(\d+(?:\.\d+)?)\s*%/);
      if (sellMatch) sellPct = Number(sellMatch[1]);
      else if (/dump\s+all|sell\s+all/.test(lower)) sellPct = 100;
      if (pct > 0) tp.push({ multiple: 1 + pct / 100, sellPct });
    }
    let stopLoss = null;
    const slPct = lower.match(/(?:stop\s*loss|sl)[^+\-]*-\s*(\d+(?:\.\d+)?)\s*%/);
    if (slPct) {
      const pct = Number(slPct[1]);
      if (pct > 0 && pct < 100) stopLoss = { multiple: 1 - pct / 100 };
    }
    if (tp.length || stopLoss) then = { tpsl: { takeProfit: tp, stopLoss } };
  }
  if (then) sniper.then = then;

  const scope = hasFilter
    ? [
        creators.length ? `${creators.length} creator${creators.length > 1 ? 's' : ''}` : null,
        symbols.length ? `symbol ${symbols.join('/')}` : null,
        nameIncludes ? `name~"${nameIncludes}"` : null,
      ].filter(Boolean).join(match === 'any' ? ' OR ' : ' AND ')
    : 'every new launch';

  const thenDesc = then
    ? `, then arm ${[
        then.tpsl.takeProfit.length ? `take-profit ${then.tpsl.takeProfit.map(r => `+${Math.round((r.multiple - 1) * 100)}% (sell ${r.sellPct}%)`).join(', ')}` : '',
        then.tpsl.stopLoss ? `stop-loss -${Math.round((1 - then.tpsl.stopLoss.multiple) * 100)}%` : '',
      ].filter(Boolean).join(' · ')} on each buy`
    : '';

  const summary = `Arm a standing sniper: buy ${amountSui} SUI of ${scope}${maxSnipes != null ? `, first ${maxSnipes} only` : ' (unbounded)'}${thenDesc}. The agent watches new launches, buys automatically the moment one matches${then ? ', then auto-sells each position when its trigger is hit' : ''}.`;

  return { workflow: 'sniper', summary, sniper, then };
}

// Client-side DCA / scale-in parser. DCA is a STANDING accumulation order on a
// SPECIFIC curve (so a CA is required in the goal). Two trigger shapes:
//   • time: "buy 10 sui of <CA> every day for 10"  -> intervalMs + buys
//   • dip:  "buy 5 sui of <CA>, 10 more each -10% drop, 3 buys" -> dropPct + buys
// Recognized here (not via the LLM) so the 64-hex CA is never mangled and the
// amount/interval/drop are parsed deterministically. `then.tpsl` in the same
// goal arms an exit on the blended average cost after the final buy.
// Returns a dca plan or null. (parseSniperGoal runs FIRST, so "every token
// launched by 0x…" routes to sniper, not here.)
function parseDcaGoal(text) {
  const g = String(text || '');
  const lower = g.toLowerCase();

  // Trigger: must look like DCA/accumulation. Either an explicit "dca", or a
  // recurring/scale-in phrasing ("every <time>", a percentage drop, "N more").
  // Requires a SUI buy amount somewhere.
  const hasDcaWord = /\bdca\b|\bdollar[\s-]?cost\b|\baverage\s+(?:in|down)\b|\bscale\s+in\b|\baccumulate\b/.test(lower);
  const hasEveryTime = /\bevery\s+(?:\d+\s*)?(?:second|sec|minute|min|hour|hr|day|week)s?\b/.test(lower);
  // Dip: any percentage tied to a fall — "drops/falls/dips/down/lower X%",
  // "if it drops 10%", "each -10%", "on a 10% dip", or "N more" (scale-in) with a %.
  const dropPhrase =
    /(?:drops?|falls?|dips?|down|lower|loses?)\s*(?:by\s*)?-?\s*\d+(?:\.\d+)?\s*%/.test(lower) ||
    /-?\s*\d+(?:\.\d+)?\s*%\s*(?:drop|dip|down|lower)/.test(lower) ||
    /(?:each|every|per|on\s+(?:a|each|every))\s*-?\s*\d+(?:\.\d+)?\s*%/.test(lower);
  const scaleInMore = /\b\d+\s*(?:sui\s+)?more\b/.test(lower) || /\bbuy\s+more\b/.test(lower);
  const hasDip = dropPhrase || (scaleInMore && /\d+(?:\.\d+)?\s*%/.test(lower));
  if (!hasDcaWord && !hasEveryTime && !hasDip) return null;

  // Must target a specific curve (a CA). DCA has no launch-time discovery.
  const ca = g.match(/0x[a-fA-F0-9]{60,66}/);
  const curveId = ca ? ca[0].toLowerCase() : null;
  if (!curveId) return null; // can't DCA without a target curve

  // Per-buy SUI. Your phrasing can carry TWO sizes: an anchor ("buy 5 sui …")
  // and a per-dip rung ("…buy 10 more each -10%"). Capture both; the rung size is
  // the one tied to "more". If only one amount, it is both anchor and rung.
  const allAmts = [...lower.matchAll(/(\d+(?:\.\d+)?)\s*sui/g)].map(m => Number(m[1]));
  const moreMatch = lower.match(/(\d+(?:\.\d+)?)\s*(?:sui\s+)?more/);
  let anchorSui = allAmts.length ? allAmts[0] : null;
  let rungSui   = moreMatch ? Number(moreMatch[1]) : (allAmts.length ? allAmts[allAmts.length - 1] : null);
  // If there are two distinct amounts and no explicit "more", treat first as
  // anchor and second as rung (e.g. "buy 5 then 10 each dip").
  if (!moreMatch && allAmts.length >= 2) { anchorSui = allAmts[0]; rungSui = allAmts[1]; }
  const suiPerBuy = rungSui ?? anchorSui;
  if (!(suiPerBuy > 0)) return null;

  // Dip percentage: "drops/falls/dips/down/lower X%", "X% drop", or "each -X%".
  const dipPct =
    lower.match(/(?:drops?|falls?|dips?|down|lower|loses?)\s*(?:by\s*)?-?\s*(\d+(?:\.\d+)?)\s*%/) ||
    lower.match(/-?\s*(\d+(?:\.\d+)?)\s*%\s*(?:drop|dip|down|lower)/) ||
    lower.match(/(?:each|every|per|on)\s*-?\s*(\d+(?:\.\d+)?)\s*%/);
  const isDip = hasDip && dipPct;

  // buys / rungs: "for N", "N buys", "N rungs", "N times", "N more" (+1 for anchor).
  let buys = null;
  {
    const m =
      lower.match(/\bfor\s+(\d+)\b/) ||
      lower.match(/(\d+)\s*(?:buys?|rungs?|times|orders?|fills?)\b/);
    if (m) buys = parseInt(m[1], 10);
    // "buy 5, 10 more each -10%" with no explicit count: anchor + the rungs we can
    // infer. If a single "N more" appears, treat as 2 total (anchor + 1). Default 3.
    if (buys == null && isDip) {
      const moreN = lower.match(/(\d+)\s*sui\s*more|\bmore\b/);
      buys = moreN ? 2 : 3;
    }
    if (buys == null) buys = 1;
  }
  if (!(buys > 0)) buys = 1;

  const dca = { curveId, suiPerBuy, buys };
  // If the anchor (first buy) differs from the per-dip rung size, carry it so the
  // brain buys `anchorSui` on rung 0 and `suiPerBuy` on each subsequent dip.
  if (anchorSui > 0 && anchorSui !== suiPerBuy) dca.anchorSui = anchorSui;
  let modeDesc;
  if (isDip) {
    dca.mode = 'dip';
    dca.dropPct = Number(dipPct[1]);
    modeDesc = `on each -${dca.dropPct}% drop from entry`;
  } else {
    // time mode: parse "every N <unit>"; default 1 day.
    const unitMs = { second: 1000, sec: 1000, minute: 60000, min: 60000, hour: 3600000, hr: 3600000, day: 86400000, week: 604800000 };
    const m = lower.match(/every\s+(\d+)?\s*(second|sec|minute|min|hour|hr|day|week)s?/);
    let intervalMs = 86400000, label = 'day';
    if (m) {
      const n = m[1] ? parseInt(m[1], 10) : 1;
      const u = m[2];
      intervalMs = (unitMs[u] ?? 86400000) * (n > 0 ? n : 1);
      label = `${n > 1 ? n + ' ' : ''}${u}${n > 1 ? 's' : ''}`;
    }
    dca.intervalMs = intervalMs;
    modeDesc = `every ${label}`;
  }

  // then.tpsl — shared extraction (same shape as sniper / parseStrategyGoal). The
  // brain arms this on the BLENDED average cost after the final buy.
  let then = null;
  {
    const tp = [];
    const tpPct = lower.match(/(?:take\s*profit|tp|profit|exit)\s*(?:at|@|of|by)?\s*\+?\s*(\d+(?:\.\d+)?)\s*%/);
    if (tpPct) {
      const pct = Number(tpPct[1]);
      let sellPct = 100;
      const sellMatch = lower.match(/sell\s+(\d+(?:\.\d+)?)\s*%/);
      if (sellMatch) sellPct = Number(sellMatch[1]);
      if (pct > 0) tp.push({ multiple: 1 + pct / 100, sellPct });
    }
    let stopLoss = null;
    const slPct = lower.match(/(?:stop\s*loss|sl)\s*(?:at|@|of|by)?\s*-?\s*(\d+(?:\.\d+)?)\s*%/);
    if (slPct) {
      const pct = Number(slPct[1]);
      if (pct > 0 && pct < 100) stopLoss = { multiple: 1 - pct / 100 };
    }
    if (tp.length || stopLoss) then = { tpsl: { takeProfit: tp, stopLoss } };
  }
  if (then) dca.then = then;

  const thenDesc = then
    ? `, then arm ${[
        then.tpsl.takeProfit.length ? `take-profit +${Math.round((then.tpsl.takeProfit[0].multiple - 1) * 100)}%` : '',
        then.tpsl.stopLoss ? `stop-loss -${Math.round((1 - then.tpsl.stopLoss.multiple) * 100)}%` : '',
      ].filter(Boolean).join(' · ')} on the average cost`
    : '';

  const summary = `Arm DCA on ${curveId.slice(0, 10)}…: buy ${suiPerBuy} SUI ${modeDesc}, ${buys} buy${buys > 1 ? 's' : ''} total${thenDesc}. The agent accumulates automatically and tracks the average cost${then ? ', then auto-exits against that average' : ''}.`;

  return { workflow: 'dca', summary, dca, then };
}

// ── Active-strategies helpers ─────────────────────────────────────────────────
const ORDER_LABEL = { tpsl: 'TP / SL', sniper: 'Sniper', dca: 'DCA', copytrade: 'Copy-trade' };
const shortId  = (s) => (typeof s === 'string' && s.startsWith('0x') && s.length > 14) ? `${s.slice(0, 8)}…${s.slice(-4)}` : s;
const shortType = (t) => {
  if (typeof t !== 'string') return '';
  const m = t.match(/::([^:]+)::([^>]+)$/);
  return m ? m[2] : t.slice(0, 14);
};

// One-line human summary of any standing order, for the panel.
function describeOrder(o) {
  const p = o.params || {};
  if (o.type === 'sniper') {
    const bits = [];
    if (Array.isArray(p.creators) && p.creators.length) bits.push(`creator ${shortId(p.creators[0])}${p.creators.length > 1 ? ` +${p.creators.length - 1}` : ''}`);
    if (Array.isArray(p.symbols) && p.symbols.length)   bits.push(`$${p.symbols.join('/$')}`);
    if (p.nameIncludes) bits.push(`name~"${p.nameIncludes}"`);
    if (!bits.length && p.all) bits.push('every launch');
    const cap = p.maxSnipes ? ` · ${p.fired || 0}/${p.maxSnipes} fired` : ` · ${p.fired || 0} fired`;
    const then = p.then?.tpsl ? ' → then TP/SL' : '';
    return `Buy ${p.amountSui} SUI on ${bits.join(p.match === 'any' ? ' or ' : ' & ')}${cap}${then}`;
  }
  if (o.type === 'dca') {
    const every = p.intervalMs >= 60000 ? `${Math.round(p.intervalMs / 60000)}m` : `${Math.round((p.intervalMs || 0) / 1000)}s`;
    const then = p.then?.tpsl ? ' → then TP/SL' : '';
    return `Buy ${p.suiPerBuy} SUI every ${every} · ${p.done || 0}/${p.buys} done${then}`;
  }
  if (o.type === 'copytrade') {
    const size = p.suiPerTrade ? `${p.suiPerTrade} SUI/trade` : `${p.ratio}× their size`;
    const then = p.then?.tpsl ? ' → then TP/SL' : '';
    return `Mirror ${shortId(p.targetWallet)} at ${size}${then}`;
  }
  // tpsl
  const tp = Array.isArray(o.takeProfit) ? o.takeProfit : [];
  const tpStr = tp.length
    ? 'TP ' + tp.map((r) => (r.multiple ? `${r.multiple}×` : `${r.priceSui} SUI`) + ` (${r.sellPct}%)`).join(', ')
    : '';
  const sl = o.stopLoss ? `SL ${o.stopLoss.multiple ? `${o.stopLoss.multiple}×` : `${o.stopLoss.priceSui} SUI`}` : '';
  return [tpStr, sl].filter(Boolean).join(' · ') || 'TP/SL order';
}

export default function AgentPage({ onBack }) {
  const account = useCurrentAccount();

  const [goal, setGoal]         = useState('');
  const [planning, setPlanning] = useState(false);
  const [plan, setPlan]         = useState(null);
  const [error, setError]       = useState(null);

  const [phase, setPhase]         = useState('idle'); // idle | running | done | failed
  const [nodeState, setNodeState] = useState({});
  const [result, setResult]       = useState(null);

  // Active-strategies panel: standing orders the brain is currently tracking.
  const [orders, setOrders]           = useState([]);
  const [ordersLoading, setOrdersL]   = useState(true);
  const [ordersError, setOrdersError] = useState(null);
  const [confirmId, setConfirmId]     = useState(null);   // order pending cancel-confirm
  const [cancelingId, setCancelingId] = useState(null);   // order mid-cancel

  // Load active orders straight from the indexer (GET is unguarded; cancel goes
  // through the /api/cancel-order proxy so the key never reaches the browser).
  const loadOrders = useCallback(async () => {
    setOrdersError(null);
    try {
      const r = await fetch(`${INDEXER_URL}/orders?status=active`, { signal: AbortSignal.timeout(8000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = await r.json();
      setOrders(Array.isArray(d) ? d : []);
    } catch (e) {
      setOrdersError(e.message || 'could not load strategies');
    } finally {
      setOrdersL(false);
    }
  }, []);

  useEffect(() => {
    loadOrders();
    const t = setInterval(loadOrders, 15000); // light refresh; SSE not needed here
    return () => clearInterval(t);
  }, [loadOrders]);

  const cancelOrder = useCallback(async (id) => {
    setCancelingId(id);
    try {
      const r = await fetch('/api/cancel-order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || `cancel failed (${r.status})`);
      // Drop it from the list immediately; the next refresh confirms.
      setOrders((prev) => prev.filter((o) => o.id !== id));
    } catch (e) {
      setOrdersError(e.message || 'cancel failed');
    } finally {
      setCancelingId(null);
      setConfirmId(null);
    }
  }, []);

  const animTimers = useRef([]);
  const clearAnim = useCallback(() => {
    animTimers.current.forEach(clearTimeout);
    animTimers.current = [];
  }, []);
  useEffect(() => () => clearAnim(), [clearAnim]);

  const makePlan = useCallback(async () => {
    if (!goal.trim()) return;
    setPlanning(true); setError(null); setPlan(null); setResult(null);
    setNodeState({}); setPhase('idle'); clearAnim();
    try {
      // Strategy goals (take-profit / stop-loss) are standing orders, not one-shot
      // workflows. Recognize them client-side so the LLM can't collapse them into
      // a plain immediate sell. If it's not a strategy, fall through to the planner.
      // Standing-order goals are recognized client-side so the LLM can't collapse
      // them into a one-shot trade (and so 64-hex addresses aren't LLM-mangled).
      // Sniper is checked first: it is the most specific standing intent.
      const snipe = parseSniperGoal(goal.trim());
      if (snipe) { setPlan(snipe); setPlanning(false); return; }

      const dca = parseDcaGoal(goal.trim());
      if (dca) { setPlan(dca); setPlanning(false); return; }

      const strat = parseStrategyGoal(goal.trim());
      if (strat) { setPlan(strat); setPlanning(false); return; }

      const res = await fetch('/api/agent-plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ goal: goal.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Planning failed');
      setPlan(data.plan);
    } catch (err) {
      setError(err.message);
    } finally {
      setPlanning(false);
    }
  }, [goal, clearAnim]);

  // ── Runtime resolvers (browser supplies what the planner can't) ───────────

  // Resolve curve -> { tokenType, pkgId } from the indexer.
  async function fetchCurveMeta(curveId) {
    const r = await fetch(`${INDEXER_URL}/token/${curveId}`, { signal: AbortSignal.timeout(6000) });
    if (!r.ok) throw new Error('Could not fetch curve from indexer');
    const d = await r.json();
    const tokenType = d.token_type ?? d.tokenType ?? null;
    if (!tokenType) throw new Error('Curve has no token type yet (indexer not enriched)');
    return { tokenType };
  }

  // Resolve "ALL" -> whole-token balance held by the connected wallet.
  async function resolveSellAmount(curveId, tokenAmount) {
    if (tokenAmount !== 'ALL' && Number(tokenAmount) > 0) {
      return { tokenAmount: Number(tokenAmount) };
    }
    if (!account?.address) throw new Error('Connect your wallet to sell ALL (need the balance)');
    const { tokenType } = await fetchCurveMeta(curveId);
    const client = new SuiGraphQLClient({ url: '/api/rpc' });
    const coinsRes = await client.listCoins({ owner: account.address, coinType: tokenType });
    const coins = coinsRes?.objects ?? coinsRes?.data ?? [];
    const atomic = coins.reduce((s, c) => s + BigInt(c.balance ?? c.coinBalance ?? 0), 0n);
    const whole = Number(atomic) / 10 ** TOKEN_DECIMALS;
    if (!(whole > 0)) throw new Error('No token balance to sell for this curve');
    return { tokenAmount: whole };
  }

  // Build the { workflow, ... } payload the runner expects.
  async function buildPayload(p) {
    switch (p.workflow) {
      case 'launch_and_buy':
        return {
          workflow: 'launch_and_buy',
          launch: {
            name: p.launch.name,
            symbol: p.launch.symbol,
            description: p.summary || `${p.launch.name} via SuiPump agent`,
            graduationTarget: p.launch.graduationTarget,
            devBuySui: p.launch.devBuySui,
            antiBotDelay: p.launch.antiBotDelay ?? 0,
          },
          buy: { amountSui: p.buy?.amountSui ?? p.launch.devBuySui ?? 0 },
        };
      case 'buy':
        if (!p.buy?.curveId) throw new Error('No curve id for buy — paste the token CA in your goal');
        return { workflow: 'buy', buy: { curveId: p.buy.curveId, amountSui: p.buy.amountSui } };
      case 'sell': {
        if (!p.sell?.curveId) throw new Error('No curve id for sell — paste the token CA in your goal');
        const { tokenAmount } = await resolveSellAmount(p.sell.curveId, p.sell.tokenAmount);
        return { workflow: 'sell', sell: { curveId: p.sell.curveId, tokenAmount } };
      }
      case 'claim': {
        if (!p.claim?.curveId) throw new Error('No curve id for claim — paste the token CA in your goal');
        const { tokenType } = await fetchCurveMeta(p.claim.curveId);
        return { workflow: 'claim', claim: { curveId: p.claim.curveId, tokenType } };
      }
      case 'alerts':
        if (!p.alerts?.curveIds?.length) throw new Error('No curve ids for alerts');
        return { workflow: 'alerts', alerts: { curveIds: p.alerts.curveIds } };
      case 'tpsl': {
        if (!p.tpsl?.curveId) throw new Error('No curve id for the strategy — paste the token CA in your goal');
        const { tokenType } = await fetchCurveMeta(p.tpsl.curveId);
        return {
          workflow: 'tpsl',
          tpsl: {
            curveId: p.tpsl.curveId,
            tokenType,
            takeProfit: p.tpsl.takeProfit ?? [],
            stopLoss: p.tpsl.stopLoss ?? null,
          },
        };
      }
      case 'buy_then_tpsl': {
        if (!p.buy?.curveId) throw new Error('No curve id — paste the token CA in your goal');
        const { tokenType } = await fetchCurveMeta(p.buy.curveId);
        return {
          workflow: 'buy_then_tpsl',
          buy: { curveId: p.buy.curveId, amountSui: p.buy.amountSui },
          tpsl: {
            curveId: p.buy.curveId,
            tokenType,
            takeProfit: p.tpsl.takeProfit ?? [],
            stopLoss: p.tpsl.stopLoss ?? null,
          },
        };
      }
      case 'sniper': {
        // Standing order: no curve to resolve (the target is discovered at launch
        // time). Pass the validated filter params straight to the store.
        const s = p.sniper ?? {};
        if (!(Number(s.amountSui) > 0)) throw new Error('Sniper needs a SUI amount (e.g. "snipe 1 sui …")');
        const hasFilter = (Array.isArray(s.creators) && s.creators.length) ||
                          (Array.isArray(s.symbols) && s.symbols.length) || !!s.nameIncludes;
        if (!hasFilter && s.all !== true) {
          throw new Error('Sniper needs a filter (creator / symbol / name) or say "every token"');
        }
        return { workflow: 'sniper', sniper: s };
      }
      case 'dca': {
        const d = p.dca ?? {};
        if (!d.curveId) throw new Error('DCA needs a curve — paste the token CA in your goal');
        if (!(Number(d.suiPerBuy) > 0)) throw new Error('DCA needs a SUI amount (e.g. "buy 5 sui …")');
        // Resolve tokenType so a then.tpsl child can sell the right coin.
        const { tokenType } = await fetchCurveMeta(d.curveId);
        return { workflow: 'dca', dca: { ...d, tokenType } };
      }
      default:
        throw new Error(`Unknown workflow: ${p.workflow}`);
    }
  }

  // Settle the swap through the bridge — the path that actually moves tokens
  // (the Nexus DAG request emits the on-chain execution digest but does not
  // settle, so we settle here, the same bridge every working SuiPump trade uses).
  // Maps the runner payload's fields to the bridge's body. Calls go through the
  // same-origin Vercel proxy (/api/agent-bridge), which injects AGENT_API_KEY
  // server-side and forwards to the bridge's gated write endpoints. The key never
  // ships to the browser, so only our deployed UI (via this proxy) can spend the
  // agent wallet — a direct browser/curl to the bridge gets 401. We pass the
  // target bridge path in `path`. Returns the settlement txDigest, or null for
  // workflows the bridge doesn't settle (claim/alerts go DAG-only).
  async function settleViaBridge(payload) {
    const wf = payload.workflow;
    let path, body;
    if (wf === 'buy') {
      path = '/buy';
      body = { curveId: payload.buy.curveId, suiAmount: payload.buy.amountSui };
    } else if (wf === 'sell') {
      path = '/sell';
      body = { curveId: payload.sell.curveId, tokenAmount: payload.sell.tokenAmount, minSuiOut: 0 };
    } else if (wf === 'launch_and_buy') {
      path = '/launch';
      body = {
        name: payload.launch.name,
        symbol: payload.launch.symbol,
        description: payload.launch.description,
        graduationTarget: payload.launch.graduationTarget,
        antiBotDelay: payload.launch.antiBotDelay,
        devBuySui: payload.buy?.amountSui ?? payload.launch.devBuySui ?? 0,
      };
    } else {
      return null; // claim / alerts: no bridge settlement
    }
    const r = await fetch(`/api/agent-bridge`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, ...body }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || d.ok === false) throw new Error(d.error || `bridge ${wf} failed (${r.status})`);
    return d.txDigest ?? null;
  }

  const approve = useCallback(async () => {
    if (!plan || phase === 'running') return;
    setError(null); setResult(null); setPhase('running');
    clearAnim();

    const nodes = WORKFLOW_NODES[plan.workflow] ?? [];
    setNodeState(Object.fromEntries(nodes.map((n, i) => [n.id, i === 0 ? 'running' : 'idle'])));
    if (nodes.length > 1) {
      animTimers.current.push(setTimeout(() => {
        setNodeState(s => ({ ...s, [nodes[0].id]: 'done', [nodes[1].id]: 'running' }));
      }, 1500));
    }

    try {
      const payload = await buildPayload(plan);

      // COMPOUND (buy_then_tpsl): buy first (settles immediately via the bridge),
      // then arm a standing TP/SL on the bought position, seeded at the post-buy
      // fill price so "+X%" is measured from what we actually paid. Two real
      // actions from one instruction.
      if (payload.workflow === 'buy_then_tpsl') {
        // 1) BUY — settle through the bridge (the path that moves tokens).
        let buyDigest = null;
        try {
          buyDigest = await settleViaBridge({ workflow: 'buy', buy: payload.buy });
        } catch (e) {
          clearAnim();
          setNodeState({ buy: 'error' });
          setError(`Buy failed: ${e.message}`);
          setPhase('failed');
          return;
        }

        // 2) Read the post-buy price from the curve so the TP/SL entry is the
        //    real fill basis (not a stale pre-buy quote). Best-effort: if the
        //    read fails, omit entryPriceSui and let the brain seed on load.
        let entryPriceSui = null;
        try {
          const sr = await fetch(`${INDEXER_URL}/token/${payload.buy.curveId}/stats`, { signal: AbortSignal.timeout(6000) });
          if (sr.ok) { const sd = await sr.json(); entryPriceSui = Number(sd.last_price) || null; }
        } catch { /* seed on brain load */ }

        // 3) ARM the standing TP/SL via the secure create-order proxy.
        try {
          const r = await fetch(`/api/create-order`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              curveId: payload.tpsl.curveId,
              tokenType: payload.tpsl.tokenType,
              type: 'tpsl',
              entryPriceSui,
              takeProfit: payload.tpsl.takeProfit,
              stopLoss: payload.tpsl.stopLoss,
            }),
          });
          const d = await r.json().catch(() => ({}));
          if (!r.ok) throw new Error(d.error || `order create failed (${r.status})`);
          clearAnim();
          setNodeState({ buy: 'done', arm: 'done' });
          setResult({ workflow: 'buy_then_tpsl', buyDigest, orderId: d.id ?? null, order: d, entryPriceSui });
          loadOrders();
          setPhase('done');
        } catch (e) {
          // Buy already settled; only the arm failed. Surface it but keep the buy.
          clearAnim();
          setNodeState({ buy: 'done', arm: 'error' });
          setResult({ workflow: 'buy_then_tpsl', buyDigest, orderId: null });
          setError(`Bought OK, but could not arm strategy: ${e.message}`);
          setPhase('failed');
        }
        return;
      }

      // STRATEGY (tpsl): not a one-shot trade — create a STANDING order in the
      // strategy store. The strategy engine polls these and fires the sell
      // through the bridge automatically when a trigger is hit. Nothing settles
      // now; settlement happens later when the price crosses a rung.
      if (payload.workflow === 'tpsl') {
        try {
          // Create via the same-origin Vercel proxy (/api/create-order), which
          // injects the STRATEGY_API_KEY server-side. The key never ships to the
          // browser, so the indexer's write guard is satisfied without exposing it.
          const r = await fetch(`/api/create-order`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              curveId: payload.tpsl.curveId,
              tokenType: payload.tpsl.tokenType,
              type: 'tpsl',
              takeProfit: payload.tpsl.takeProfit,
              stopLoss: payload.tpsl.stopLoss,
            }),
          });
          const d = await r.json().catch(() => ({}));
          if (!r.ok) throw new Error(d.error || `order create failed (${r.status})`);
          clearAnim();
          setNodeState({ arm: 'done' });
          setResult({ workflow: 'tpsl', orderId: d.id ?? null, order: d });
          loadOrders();
          setPhase('done');
        } catch (e) {
          clearAnim();
          setNodeState({ arm: 'error' });
          setError(`Could not arm strategy: ${e.message}`);
          setPhase('failed');
        }
        return;
      }

      // STRATEGY (sniper): standing buy keyed on a launch filter. Like tpsl, it
      // creates an order in the strategy store and nothing settles now — the brain
      // fires a buy (real Nexus scheduler task) on every NEW launch that matches.
      if (payload.workflow === 'sniper') {
        try {
          const r = await fetch(`/api/create-order`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: 'sniper', params: payload.sniper }),
          });
          const d = await r.json().catch(() => ({}));
          if (!r.ok) throw new Error(d.error || `order create failed (${r.status})`);
          clearAnim();
          setNodeState({ arm: 'done' });
          setResult({ workflow: 'sniper', orderId: d.id ?? null, order: d });
          loadOrders();
          setPhase('done');
        } catch (e) {
          clearAnim();
          setNodeState({ arm: 'error' });
          setError(`Could not arm sniper: ${e.message}`);
          setPhase('failed');
        }
        return;
      }

      // STRATEGY (dca): standing accumulation on a specific curve. Like sniper it
      // creates a store order and nothing settles now — the brain fires each buy
      // (Nexus task + bridge settle) on its schedule / dip trigger, tracks the
      // average cost, and arms the `then` exit on that average after the final buy.
      if (payload.workflow === 'dca') {
        try {
          const r = await fetch(`/api/create-order`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              type: 'dca',
              curveId: payload.dca.curveId,
              tokenType: payload.dca.tokenType,
              params: payload.dca,
            }),
          });
          const d = await r.json().catch(() => ({}));
          if (!r.ok) throw new Error(d.error || `order create failed (${r.status})`);
          clearAnim();
          setNodeState({ arm: 'done' });
          setResult({ workflow: 'dca', orderId: d.id ?? null, order: d });
          loadOrders();
          setPhase('done');
        } catch (e) {
          clearAnim();
          setNodeState({ arm: 'error' });
          setError(`Could not arm DCA: ${e.message}`);
          setPhase('failed');
        }
        return;
      }

      // STEP 1 — Emit the Nexus DAG request (agentic-decision proof). This is
      // BEST-EFFORT: the on-chain walk request is the orchestration paper trail,
      // not the settlement path. A slow/failed /run-dag must NEVER block the trade
      // from settling. We capture whatever the runner returns and move on.
      let data = {};
      try {
        const res = await fetch(`/api/agent-run`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        data = await res.json().catch(() => ({}));
        if (!res.ok || data.ok === false) {
          // Emission failed — log it, keep going. Settlement is independent.
          console.warn('[agent] Nexus emit failed, settling anyway:', data.error || res.status);
          data = {};
        }
      } catch (e) {
        console.warn('[agent] Nexus emit threw, settling anyway:', e.message);
        data = {};
      }
      clearAnim();

      // STEP 2 — Settle the swap through the bridge so the tokens actually move.
      // This is the money path and runs REGARDLESS of whether the Nexus emit
      // above succeeded. Only this step's failure fails the action.
      let settleDigest = null;
      try {
        settleDigest = await settleViaBridge(payload);
      } catch (e) {
        clearAnim();
        setNodeState(Object.fromEntries(nodes.map(n => [n.id, 'error'])));
        setResult({
          workflow:    data.workflow ?? plan.workflow,
          executionId: data.executionId ?? null,
          digest:      data.digest ?? null,
          checkpoint:  data.checkpoint ?? null,
          dagId:       data.dagId ?? null,
          settleDigest: null,
        });
        setError(`Settlement failed: ${e.message}`);
        setPhase('failed');
        return;
      }

      setNodeState(Object.fromEntries(nodes.map(n => [n.id, 'done'])));
      setResult({
        workflow:    data.workflow ?? plan.workflow,
        executionId: data.executionId ?? null,
        digest:      data.digest ?? null,
        checkpoint:  data.checkpoint ?? null,
        dagId:       data.dagId ?? null,
        settleDigest,
      });
      setPhase('done');
    } catch (err) {
      clearAnim();
      setNodeState(s => {
        const next = { ...s };
        const runningId = Object.keys(next).find(k => next[k] === 'running');
        if (runningId) next[runningId] = 'error';
        return next;
      });
      setError(err.message);
      setPhase('failed');
    }
  }, [plan, phase, clearAnim, account]);

  const nodeColor = (s) =>
    s === 'done'    ? 'border-violet-400/60 bg-violet-400/10' :
    s === 'running' ? 'border-violet-400 bg-violet-400/5 animate-pulse' :
    s === 'error'   ? 'border-red-400/60 bg-red-400/10' :
                      'border-white/10 bg-white/[0.02]';

  const showExecutionPanel = phase !== 'idle';
  const nodes = plan ? (WORKFLOW_NODES[plan.workflow] ?? []) : [];

  // Per-workflow plan summary rows (no launch fields bleed onto non-launch plans).
  function planRows(p) {
    switch (p.workflow) {
      case 'launch_and_buy':
        return [
          ['workflow', p.workflow],
          ['token', `${p.launch.name} ($${p.launch.symbol})`],
          ['dev-buy', `${p.buy?.amountSui ?? p.launch.devBuySui ?? 0} SUI`],
          ['graduates to', GRAD[p.launch.graduationTarget] ?? 'Turbos'],
        ];
      case 'buy':
        return [
          ['workflow', p.workflow],
          ['curve', p.buy?.curveId ? `${p.buy.curveId.slice(0, 10)}…` : '(missing — paste CA)'],
          ['amount', `${p.buy?.amountSui ?? 0} SUI`],
        ];
      case 'sell':
        return [
          ['workflow', p.workflow],
          ['curve', p.sell?.curveId ? `${p.sell.curveId.slice(0, 10)}…` : '(missing — paste CA)'],
          ['amount', p.sell?.tokenAmount === 'ALL' ? 'ALL tokens' : `${p.sell?.tokenAmount} tokens`],
        ];
      case 'claim':
        return [
          ['workflow', p.workflow],
          ['curve', p.claim?.curveId ? `${p.claim.curveId.slice(0, 10)}…` : '(missing — paste CA)'],
        ];
      case 'alerts':
        return [
          ['workflow', p.workflow],
          ['monitoring', `${p.alerts?.curveIds?.length ?? 0} curve(s)`],
        ];
      case 'tpsl': {
        const rows = [
          ['workflow', 'tp/sl strategy'],
          ['curve', p.tpsl?.curveId ? `${p.tpsl.curveId.slice(0, 10)}…` : '(missing — paste CA)'],
        ];
        (p.tpsl?.takeProfit ?? []).forEach((r, i) =>
          rows.push([`take-profit ${i + 1}`, `+${Math.round((r.multiple - 1) * 100)}% · sell ${r.sellPct}%`]));
        if (p.tpsl?.stopLoss)
          rows.push(['stop-loss', `-${Math.round((1 - p.tpsl.stopLoss.multiple) * 100)}%`]);
        return rows;
      }
      case 'buy_then_tpsl': {
        const rows = [
          ['workflow', 'buy + tp/sl'],
          ['buy', `${p.buy?.amountSui ?? 0} SUI`],
          ['curve', p.buy?.curveId ? `${p.buy.curveId.slice(0, 10)}…` : '(missing — paste CA)'],
        ];
        (p.tpsl?.takeProfit ?? []).forEach((r, i) =>
          rows.push([`take-profit ${i + 1}`, `+${Math.round((r.multiple - 1) * 100)}% · sell ${r.sellPct}%`]));
        if (p.tpsl?.stopLoss)
          rows.push(['stop-loss', `-${Math.round((1 - p.tpsl.stopLoss.multiple) * 100)}%`]);
        return rows;
      }
      case 'sniper': {
        const s = p.sniper ?? {};
        const rows = [
          ['workflow', 'sniper (standing buy)'],
          ['buy size', `${s.amountSui ?? 0} SUI per launch`],
        ];
        if (Array.isArray(s.creators) && s.creators.length)
          rows.push(['creators', s.creators.map(c => `${c.slice(0, 10)}…`).join(', ')]);
        if (Array.isArray(s.symbols) && s.symbols.length)
          rows.push(['symbols', s.symbols.join(', ')]);
        if (s.nameIncludes)
          rows.push(['name contains', `"${s.nameIncludes}"`]);
        if ((Array.isArray(s.creators) && s.creators.length ? 1 : 0) +
            (Array.isArray(s.symbols) && s.symbols.length ? 1 : 0) +
            (s.nameIncludes ? 1 : 0) > 1)
          rows.push(['match', s.match === 'any' ? 'ANY (OR)' : 'ALL (AND)']);
        if (!s.creators && !s.symbols && !s.nameIncludes && s.all)
          rows.push(['scope', 'EVERY new launch']);
        rows.push(['limit', s.maxSnipes != null ? `${s.maxSnipes} snipes` : 'unbounded']);
        if (s.then?.tpsl) {
          (s.then.tpsl.takeProfit ?? []).forEach((r, i) =>
            rows.push([`then take-profit ${i + 1}`, `+${Math.round((r.multiple - 1) * 100)}% · sell ${r.sellPct}%`]));
          if (s.then.tpsl.stopLoss)
            rows.push(['then stop-loss', `-${Math.round((1 - s.then.tpsl.stopLoss.multiple) * 100)}%`]);
        }
        return rows;
      }
      case 'dca': {
        const d = p.dca ?? {};
        const rows = [
          ['workflow', 'dca (standing accumulation)'],
          ['curve', d.curveId ? `${d.curveId.slice(0, 10)}…` : '(missing — paste CA)'],
          ['buy size', `${d.suiPerBuy ?? 0} SUI per buy`],
          ['trigger', d.mode === 'dip' ? `each -${d.dropPct}% drop from entry` : `every ${Math.round((d.intervalMs ?? 86400000) / 1000)}s`],
          ['total buys', `${d.buys ?? 1}`],
        ];
        if (d.then?.tpsl) {
          (d.then.tpsl.takeProfit ?? []).forEach((r, i) =>
            rows.push([`then take-profit ${i + 1}`, `+${Math.round((r.multiple - 1) * 100)}% · sell ${r.sellPct}% (on avg cost)`]));
          if (d.then.tpsl.stopLoss)
            rows.push(['then stop-loss', `-${Math.round((1 - d.then.tpsl.stopLoss.multiple) * 100)}% (on avg cost)`]);
        }
        return rows;
      }
      default:
        return [['workflow', p.workflow]];
    }
  }

  return (
    <div>
      <button onClick={onBack} className="flex items-center gap-2 text-white/40 hover:text-white/70 text-[10px] font-mono tracking-widest mb-6">
        <ArrowLeft size={13} /> BACK
      </button>

      <div className="border border-violet-400/20 rounded-2xl p-6 bg-gradient-to-br from-violet-500/[0.07] to-transparent mb-6">
        <div className="flex items-center gap-2.5 mb-2">
          <Bot size={20} className="text-violet-400" />
          <h1 className="text-xl font-bold tracking-tight text-white" style={{ fontFamily: "'Space Grotesk', sans-serif" }}>AUTONOMOUS AGENT</h1>
        </div>
        <p className="text-white/40 text-[11px] font-mono leading-relaxed max-w-xl">
          State a goal in plain language. The agent plans with an LLM, then executes it on-chain through a published Nexus DAG — launch, buy, sell, claim, or monitor.
        </p>
      </div>

      <div className="border border-white/10 rounded-xl p-4 bg-white/[0.02] mb-4">
        <div className="flex items-center gap-2 mb-3">
          <Sparkles size={11} className="text-violet-400" />
          <span className="text-[10px] font-mono text-white/35 tracking-widest">GOAL</span>
        </div>
        <textarea
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          placeholder="e.g. Launch a dog token called MoonCat, dev-buy 1 SUI  ·  or  ·  Sell all tokens of 0xCURVE…"
          rows={2}
          className="w-full bg-black/40 border border-white/10 rounded-lg p-3 text-[12px] font-mono text-white/80 placeholder:text-white/20 focus:border-violet-400/40 outline-none resize-none"
        />
        <div className="flex items-center justify-end mt-3">
          <button
            onClick={makePlan}
            disabled={planning || !goal.trim()}
            className="shrink-0 text-[10px] font-mono font-bold tracking-widest px-4 py-2 rounded-lg border border-violet-400/60 text-violet-400 hover:bg-violet-400/10 disabled:opacity-30 transition-colors flex items-center gap-2"
          >
            {planning ? <Loader size={12} className="animate-spin" /> : <Sparkles size={12} />}
            {planning ? 'PLANNING...' : 'PLAN'}
          </button>
        </div>
      </div>

      {plan && (
        <div className="border border-violet-400/20 rounded-xl p-4 bg-violet-400/[0.03] mb-4">
          <div className="text-[10px] font-mono text-violet-400/70 tracking-widest mb-2">AGENT PLAN</div>
          <p className="text-[12px] font-mono text-white/80 mb-3 leading-relaxed">{plan.summary}</p>
          <div className="grid grid-cols-2 gap-2 text-[10px] font-mono text-white/45 mb-4">
            {planRows(plan).map(([k, v]) => (
              <div key={k}>{k}: <span className="text-white/80">{v}</span></div>
            ))}
          </div>
          {(phase === 'idle' || phase === 'failed') && (
            <button
              onClick={approve}
              className="w-full text-[11px] font-mono font-bold tracking-widest px-4 py-3 rounded-lg bg-violet-500 text-white hover:bg-violet-400 transition-colors flex items-center justify-center gap-2"
            >
              <Play size={12} /> {phase === 'failed' ? 'RETRY — EXECUTE ON-CHAIN' : 'APPROVE & EXECUTE ON-CHAIN'}
            </button>
          )}
        </div>
      )}

      {phase === 'running' && (
        <div className="border border-violet-400/20 rounded-xl p-5 bg-violet-400/[0.03] mb-4">
          <div className="flex items-center gap-3">
            <div className="relative">
              <Bot size={18} className="text-violet-400" />
              <span className="absolute -right-1 -top-1 w-2 h-2 rounded-full bg-violet-400 animate-ping" />
            </div>
            <div className="flex-1">
              <div className="text-[12px] font-mono text-white/90 font-bold">Agent executing autonomously on Nexus</div>
              <div className="text-[10px] font-mono text-white/40">Running the {plan?.workflow} DAG on-chain.</div>
            </div>
            <Loader size={14} className="text-violet-400 animate-spin" />
          </div>
        </div>
      )}

      {showExecutionPanel && (
        <div className="border border-white/10 rounded-xl p-4 bg-white/[0.02] mb-4">
          <div className="text-[10px] font-mono text-white/35 tracking-widest mb-4">NEXUS DAG EXECUTION</div>
          <div className="space-y-2">
            {nodes.map((n) => {
              const s = nodeState[n.id] ?? 'idle';
              return (
                <div key={n.id} className={`flex items-center gap-3 border rounded-lg p-3 transition-colors ${nodeColor(s)}`}>
                  <div className="w-6 flex justify-center">
                    {s === 'done'    && <Check  size={14} className="text-violet-400" />}
                    {s === 'running' && <Loader size={14} className="text-violet-400 animate-spin" />}
                    {s === 'error'   && <X      size={14} className="text-red-400" />}
                    {s === 'idle'    && <div className="w-2 h-2 rounded-full bg-white/20" />}
                  </div>
                  <div className="flex-1">
                    <div className="text-[12px] font-mono text-white/80">{n.label}</div>
                    <div className="text-[9px] font-mono text-white/30">{n.tool} · {n.desc}</div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {result && (result.workflow === 'tpsl' || result.workflow === 'buy_then_tpsl' || result.workflow === 'sniper' || result.workflow === 'dca') && (
        <div className="border border-emerald-400/30 rounded-xl p-4 bg-emerald-400/[0.05]">
          <div className="text-[10px] font-mono text-emerald-400/80 tracking-widest mb-3">
            {result.workflow === 'buy_then_tpsl'
              ? '✓ BOUGHT & STRATEGY ARMED — AGENT IS WATCHING'
              : result.workflow === 'sniper'
              ? '✓ SNIPER ARMED — AGENT IS WATCHING LAUNCHES'
              : result.workflow === 'dca'
              ? '✓ DCA ARMED — AGENT IS ACCUMULATING'
              : '✓ STRATEGY ARMED — AGENT IS WATCHING'}
          </div>
          <div className="space-y-2 text-[10px] font-mono">
            {result.buyDigest && (
              <div className="text-white/40">buy settled: <span className="text-emerald-300/80 break-all">{result.buyDigest}</span></div>
            )}
            {result.entryPriceSui && (
              <div className="text-white/40">entry price: <span className="text-white/70">{result.entryPriceSui} SUI</span></div>
            )}
            {result.orderId && (
              <div className="text-white/40">order id: <span className="text-white/70 break-all">{result.orderId}</span></div>
            )}
            <div className="text-white/50 leading-relaxed">
              {result.workflow === 'sniper'
                ? "The agent now watches new launches and fires a buy through Nexus the moment one matches your filter. No further action needed."
                : result.workflow === 'dca'
                ? "The agent now accumulates on this curve automatically through Nexus — on schedule or on each dip — tracking your average cost. Watch it in Active Strategies below."
                : "The agent now watches this curve's price and sells automatically through Nexus when a trigger is hit. No further action needed."}
            </div>
          </div>
        </div>
      )}

      {result && (result.executionId || result.digest) && (
        <div className="border border-violet-400/30 rounded-xl p-4 bg-violet-400/[0.05]">
          <div className="text-[10px] font-mono text-violet-400/80 tracking-widest mb-3">✓ EXECUTED ON-CHAIN VIA NEXUS</div>
          <div className="space-y-2 text-[10px] font-mono">
            {result.dagId && (
              <div className="text-white/40">DAG: <span className="text-white/70 break-all">{result.dagId}</span></div>
            )}
            {result.executionId && (
              <a href={suiscanObject(result.executionId)} target="_blank" rel="noreferrer"
                 className="inline-flex items-center gap-1.5 text-violet-400 hover:text-violet-300 break-all">
                execution: {result.executionId} <ExternalLink size={11} />
              </a>
            )}
            {result.checkpoint && (
              <div className="text-white/40">checkpoint: <span className="text-white/70">{result.checkpoint}</span></div>
            )}
            {result.digest && (
              <a href={suiscanTx(result.digest)} target="_blank" rel="noreferrer"
                 className="inline-flex items-center gap-1.5 text-violet-400 hover:text-violet-300 break-all">
                nexus request: {result.digest} <ExternalLink size={11} />
              </a>
            )}
            {result.settleDigest && (
              <a href={suiscanTx(result.settleDigest)} target="_blank" rel="noreferrer"
                 className="inline-flex items-center gap-1.5 text-emerald-400 hover:text-emerald-300 break-all">
                settled: {result.settleDigest} <ExternalLink size={11} />
              </a>
            )}
          </div>
        </div>
      )}

      {error && (
        <div className="border border-red-400/30 rounded-xl p-3 bg-red-400/[0.04] text-[11px] font-mono text-red-400/80 mt-4">
          {error}
        </div>
      )}

      {/* ── Active strategies ─────────────────────────────────────────────── */}
      <div className="mt-10 pt-6 border-t border-white/10">
        <div className="flex items-center justify-between mb-4">
          <div className="text-[10px] font-mono text-violet-400/70 tracking-widest">
            ACTIVE STRATEGIES{orders.length ? ` · ${orders.length}` : ''}
          </div>
          <button
            onClick={loadOrders}
            className="text-[9px] font-mono text-white/30 hover:text-white/60 tracking-widest"
          >
            REFRESH
          </button>
        </div>

        {ordersLoading ? (
          <div className="flex items-center gap-2 text-[11px] font-mono text-white/30">
            <Loader size={13} className="animate-spin" /> loading…
          </div>
        ) : ordersError ? (
          <div className="text-[11px] font-mono text-red-400/70">{ordersError}</div>
        ) : orders.length === 0 ? (
          <div className="border border-white/10 rounded-xl p-4 text-[11px] font-mono text-white/30">
            No active strategies. Arm one above and it will appear here.
          </div>
        ) : (
          <div className="space-y-2">
            {orders.map((o) => {
              const isConfirm = confirmId === o.id;
              const isCanceling = cancelingId === o.id;
              return (
                <div
                  key={o.id}
                  className="border border-white/10 rounded-xl p-3 bg-white/[0.02] flex items-start justify-between gap-3"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-[9px] font-mono text-violet-300/90 bg-violet-400/10 border border-violet-400/20 rounded px-1.5 py-0.5 tracking-wider">
                        {ORDER_LABEL[o.type] || o.type}
                      </span>
                      {o.tokenType && (
                        <span className="text-[9px] font-mono text-white/35">${shortType(o.tokenType)}</span>
                      )}
                    </div>
                    <div className="text-[11px] font-mono text-white/70 leading-relaxed break-words">
                      {describeOrder(o)}
                    </div>
                    {o.curveId && (
                      <a
                        href={suiscanObject(o.curveId)}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 text-[9px] font-mono text-white/25 hover:text-violet-400/80 mt-1"
                      >
                        {shortId(o.curveId)} <ExternalLink size={9} />
                      </a>
                    )}
                  </div>

                  <div className="shrink-0">
                    {isConfirm ? (
                      <div className="flex items-center gap-1.5">
                        <button
                          onClick={() => cancelOrder(o.id)}
                          disabled={isCanceling}
                          className="text-[9px] font-mono text-red-400 hover:text-red-300 border border-red-400/30 rounded px-2 py-1 tracking-widest disabled:opacity-50"
                        >
                          {isCanceling ? '…' : 'CONFIRM'}
                        </button>
                        <button
                          onClick={() => setConfirmId(null)}
                          disabled={isCanceling}
                          className="text-[9px] font-mono text-white/40 hover:text-white/70 px-1 tracking-widest disabled:opacity-50"
                        >
                          KEEP
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => { setConfirmId(o.id); setOrdersError(null); }}
                        className="text-[9px] font-mono text-white/30 hover:text-red-400/90 border border-white/10 hover:border-red-400/30 rounded px-2 py-1 tracking-widest transition-colors"
                      >
                        CANCEL
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
