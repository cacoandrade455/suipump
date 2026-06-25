// parseAutopilotGoal — client-side intent parser for the AUTOPILOT strategy.
//
// Drop this into frontend-app/src/AgentPage.jsx next to parseSniperGoal /
// parseDcaGoal, and call it in the SAME parse chain. ORDER MATTERS: run it AFTER
// parseSniperGoal and parseDcaGoal (those need a specific curve / launch filter);
// autopilot is the "no specific token — you pick" catch-all for autonomous goals.
//
// Recognized phrasing (examples):
//   "autopilot 20 sui, 1 sui per trade, take profit +50% stop loss -30%"
//   "run my agent on autopilot with 10 sui budget"
//   "trade for me, 15 sui total, 0.5 each, only high momentum, max 4 positions"
//   "auto-trade trending tokens, 25 sui cap, tp +40%"
//
// Returns an autopilot plan or null. Like the other strategy parsers, the 64-hex
// CA is irrelevant here (autopilot has no fixed curve) so nothing is mangled.

function parseAutopilotGoal(text) {
  const g = String(text || '');
  const lower = g.toLowerCase();

  // Trigger: must look like a hands-off / autonomous market-trading goal.
  const isAutopilot =
    /\bautopilot\b/.test(lower) ||
    /\bauto[-\s]?trade\b/.test(lower) ||
    /\btrade for me\b/.test(lower) ||
    /\b(run|put).*(agent|bot).*(autopilot|loose|to work)\b/.test(lower) ||
    /\b(trade|buy).*(trending|the market|best tokens|for me)\b/.test(lower);
  if (!isAutopilot) return null;

  const numAfter = (re, d) => { const m = lower.match(re); return m ? Number(m[1]) : d; };

  // Spend cap / total budget.
  const spendCapSui =
    numAfter(/(\d+(?:\.\d+)?)\s*sui\s*(?:budget|cap|total|max|to (?:deploy|spend|trade))/, null) ??
    numAfter(/(?:budget|cap|total|deploy|spend)\s*(?:of\s*)?(\d+(?:\.\d+)?)\s*sui/, null) ??
    numAfter(/\bwith\s*(\d+(?:\.\d+)?)\s*sui/, null) ??
    numAfter(/(\d+(?:\.\d+)?)\s*sui\b/, 10); // last resort: first "<n> sui" seen

  // Per-entry position size.
  const perEntrySui =
    numAfter(/(\d+(?:\.\d+)?)\s*sui\s*(?:per|each|\/)\s*(?:trade|entry|buy|position)/, null) ??
    numAfter(/(?:per|each)\s*(?:trade|entry|buy|position)?\s*(\d+(?:\.\d+)?)\s*sui/, null) ??
    0.5;

  // Max concurrent positions.
  const maxOpenPositions =
    Math.trunc(numAfter(/max\s*(\d+)\s*(?:positions|tokens|holdings|trades|open)/, null) ??
               numAfter(/(\d+)\s*positions?\s*max/, null) ??
               5);

  // Momentum floor — "only high momentum" bumps the floor; an explicit number wins.
  let minMomentum = numAfter(/momentum\s*(?:>|over|above)?\s*(\d+(?:\.\d+)?)/, null);
  if (minMomentum == null) minMomentum = /high\s*momentum|strong\s*momentum|only\s*the\s*best/.test(lower) ? 50 : 0;

  // Concentration ceiling (whale veto).
  const maxConcentrationPct =
    numAfter(/(?:concentration|whale|top holder)\s*(?:<|under|below|max)?\s*(\d+(?:\.\d+)?)\s*%/, null) ?? 35;

  // Optional exit leg (TP/SL) — same extraction shape as the sniper/dca parsers.
  let then = null;
  {
    const tp = [];
    const tpPct = lower.match(/(?:take\s*profit|tp|profit)[^+\-]*\+?\s*(\d+(?:\.\d+)?)\s*%/);
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

  const autopilot = {
    spendCapSui,
    perEntrySui,
    minMomentum,
    maxConcentrationPct,
    maxOpenPositions,
    minHolders: 3,
    scanTopN: 10,
    cooldownMs: 60000,
  };
  if (then) autopilot.then = then;

  const thenDesc = then
    ? `, then arm ${[
        then.tpsl.takeProfit.length ? `take-profit ${then.tpsl.takeProfit.map(r => `+${Math.round((r.multiple - 1) * 100)}% (sell ${r.sellPct}%)`).join(', ')}` : '',
        then.tpsl.stopLoss ? `stop-loss -${Math.round((1 - then.tpsl.stopLoss.multiple) * 100)}%` : '',
      ].filter(Boolean).join(' · ')} on each entry`
    : '';

  const summary = `Arm autopilot: deploy up to ${spendCapSui} SUI, ${perEntrySui} SUI per entry, into trending tokens with momentum over ${minMomentum} and top-holder concentration under ${maxConcentrationPct}%, max ${maxOpenPositions} open positions${thenDesc}. The agent scans the market on its own 24/7, enters the best candidate that clears the filters, and never exceeds the spend cap. Revocable anytime.`;

  return { workflow: 'autopilot', summary, autopilot, then };
}

// ── Wiring in AgentPage.jsx ────────────────────────────────────────────────────
// 1) In the parse chain, AFTER sniper + dca, BEFORE the LLM planner:
//      const ap = parseAutopilotGoal(goal); if (ap) { setPlan(ap); return; }
//
// 2) In WORKFLOW_NODES, add:
//      autopilot: [{ id: 'arm', tool: 'strategy.autopilot@1', label: 'Arm autopilot',
//                    desc: 'Standing autonomous trader: scans the market and enters within your spend cap' }],
//
// 3) In approve(), add an autopilot branch mirroring the sniper/dca create-order block:
//      if (payload.workflow === 'autopilot') {
//        try {
//          const r = await fetch(`/api/create-order`, {
//            method: 'POST', headers: { 'Content-Type': 'application/json' },
//            body: JSON.stringify({ type: 'autopilot', params: payload.autopilot }),
//          });
//          const d = await r.json().catch(() => ({}));
//          if (!r.ok) throw new Error(d.error || `order create failed (${r.status})`);
//          clearAnim(); setNodeState({ arm: 'done' });
//          setResult({ workflow: 'autopilot', orderId: d.id ?? null, order: d });
//          loadOrders(); setPhase('done');
//        } catch (e) {
//          clearAnim(); setNodeState({ arm: 'error' });
//          setError(`Could not arm autopilot: ${e.message}`); setPhase('failed');
//        }
//        return;
//      }

export { parseAutopilotGoal };
