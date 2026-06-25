// autopilot.js — the Analyzer-armed standing strategy ("personal agent autopilot")
//
// WHAT IT IS
//   A sixth strategy handler for the brain (agent-runner/strategy.js), alongside
//   tpsl / sniper / dca / copytrade. It is an ADDITION, not a replacement: it
//   rides the dispatcher that is ALREADY 24/7, reuses the same Nexus-emit + bridge-
//   settle + armThen + recordFire machinery every other strategy uses, and records
//   into the same agent_actions history with `settled · leader` proof.
//
//   Where sniper fires on launch events and copytrade mirrors a wallet, autopilot
//   SCANS THE MARKET on a timer, scores candidates off the indexer's existing
//   /trending momentum engine, vetoes the dangerous ones with deterministic on-chain
//   signals (concentration + graduation + freshness), and enters the best survivor
//   each tick — strictly inside the user's mandate (spend cap + per-entry size +
//   max open positions). Each entry optionally arms a TP/SL exit on the real fill
//   price via the shared armThen, so the agent both enters AND manages the exit.
//
//   This is the "decision policy" node: it turns /trending signals into INTENTS,
//   then settles those intents through the SAME path as the proven strategies
//   (Nexus emit = agentic proof, bridge = the money path). Execution never routes
//   around Nexus.
//
// 24/7
//   wakesOn: 'timer'. The brain's dcaTick() already schedules every non-done
//   timer order on its interval, so autopilot is picked up automatically with no
//   new loop. It runs forever, like the dispatcher.
//
// THE MANDATE (off-chain today; the on-chain AgentAuthority box hardens it later)
//   Step 1 of process() enforces the spend cap in params (spentSui >= spendCapSui
//   => done). That is the off-chain mirror of the on-chain AgentAuthority cap.
//   When the AgentAuthority contract ships, the bridge call passes the authority
//   object ref and the CONTRACT enforces the cap; spentSui becomes a UI mirror.
//   Same control surface, hardened underneath — the policy behavior proven here is
//   exactly what the contract will enforce.
//
// PARAMS (per order)
//   {
//     spendCapSui,        // total SUI the agent may deploy across all entries
//     perEntrySui,        // size of each position (default 0.5)
//     minMomentum,        // enter only if /trending momentum_score > this
//     maxConcentrationPct,// veto if top non-creator holder liquid % > this (default 35)
//     maxOpenPositions,   // cap concurrent distinct holdings (default 5)
//     minHolders,         // skip ultra-thin curves (default 3)
//     scanTopN,           // how many trending candidates to consider per tick (default 10)
//     cooldownMs,         // min gap between entries (default 60000)
//     then,               // optional exit leg, e.g. { tpsl: { takeProfit:[...], stopLoss:{...} } }
//     // ── runtime, persisted ──
//     spentSui,           // running total deployed
//     entered,            // [curveId,...] already entered (dedup; never re-enter)
//     fired, done, lastFireMs,
//   }
//
// INTEGRATION (see HANDOFF for the 4 edits to strategy.js):
//   import { makeAutopilotHandler } from './autopilot.js';
//   const autopilot = makeAutopilotHandler({
//     log, err, num2, onCooldown, scaffoldNormalize,
//     fireScheduleTask, fireBridgeBuy, armThen, recordFire, persistParams,
//     getCurveState, priceFromReserve, getVSui, getBalanceWhole,
//     INDEXER_URL, INVOKER_ADDRESS,
//   });
//   HANDLERS.autopilot = autopilot;

export function makeAutopilotHandler(deps) {
  const {
    log, err, num2, onCooldown, scaffoldNormalize,
    fireScheduleTask, fireBridgeBuy, armThen, recordFire, persistParams,
    getCurveState, priceFromReserve, getVSui, getBalanceWhole,
    INDEXER_URL, INVOKER_ADDRESS,
  } = deps;

  // ── Indexer reads (all existing endpoints) ─────────────────────────────────
  async function fetchTrending(limit) {
    const r = await fetch(`${INDEXER_URL}/trending?limit=${limit}`, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error(`trending ${r.status}`);
    return await r.json();
  }

  // Concentration veto: top NON-CREATOR holder's LIQUID share of total supply.
  // GET /token/:curveId/holders returns [{ address, balance, locked, liquid,
  // isCreator }] sorted by balance desc (see indexer/api.js). We ignore the
  // creator and locked tokens — locked can't be dumped, creator holding is
  // expected — and look at the largest liquid outsider position as a fraction of
  // the 1B total supply. This mirrors AIAnalysis.jsx's concentration logic, which
  // also measures liquid non-creator holdings against the 1B total.
  const TOTAL_SUPPLY_WHOLE = 1_000_000_000;
  async function topHolderConcentrationPct(curveId) {
    try {
      const r = await fetch(`${INDEXER_URL}/token/${curveId}/holders`, { signal: AbortSignal.timeout(8000) });
      if (!r.ok) return null; // unknown => do not veto on this axis
      const holders = await r.json();
      if (!Array.isArray(holders) || !holders.length) return null;
      let topLiquid = 0, count = 0;
      for (const h of holders) {
        count++;
        if (h.isCreator) continue;
        const liquid = Number(h.liquid ?? h.balance ?? 0);
        if (liquid > topLiquid) topLiquid = liquid;
      }
      return { pct: (topLiquid / TOTAL_SUPPLY_WHOLE) * 100, holderCount: count };
    } catch {
      return null; // read failure => do not veto on concentration
    }
  }

  return {
    label: 'autopilot',
    wakesOn: 'timer',
    normalize: scaffoldNormalize, // entered[] survives restart via params, like sniper's snipedCurves
    summarize: (o) => {
      const p = o.params || {};
      const spent = num2(p.spentSui, 0), cap = num2(p.spendCapSui, 0);
      const open = Array.isArray(p.entered) ? p.entered.length : 0;
      return `${o.id} autopilot ${num2(p.perEntrySui, 0.5)} SUI/entry · ${spent.toFixed(2)}/${cap} SUI deployed · ${open}/${num2(p.maxOpenPositions, 5)} open · momentum>${num2(p.minMomentum, 0)}`;
    },

    process: async (order) => {
      const p = order.params || {};

      // ── Mandate gate (off-chain cap; AgentAuthority hardens this later) ──────
      const spendCapSui = num2(p.spendCapSui, 0);
      const perEntrySui = num2(p.perEntrySui, 0.5);
      const spentSui    = num2(p.spentSui, 0);
      if (!(spendCapSui > 0) || !(perEntrySui > 0)) {
        if (!order._warned) { err(`${order.id}: autopilot needs spendCapSui & perEntrySui`); order._warned = true; }
        return;
      }
      if (spentSui + perEntrySui > spendCapSui + 1e-9) {
        log(`${order.id}: autopilot spend cap reached (${spentSui.toFixed(2)}/${spendCapSui} SUI) — closing`);
        order.done = true; await persistParams(order); return;
      }

      // Per-order spacing so we never enter in the settle-shadow of the last buy.
      const cooldownMs = num2(p.cooldownMs, 60000);
      const now = Date.now();
      if (num2(p.lastFireMs, 0) > 0 && now - num2(p.lastFireMs, 0) < cooldownMs) return;

      const entered = Array.isArray(p.entered) ? p.entered : [];
      const maxOpen = Math.trunc(num2(p.maxOpenPositions, 5));
      if (maxOpen > 0 && entered.length >= maxOpen) {
        // Holding the max number of positions; nothing new until the exit legs
        // (TP/SL children) close some out. Stay idle this tick.
        return;
      }

      // ── Scan: pull trending candidates ──────────────────────────────────────
      const scanTopN = Math.trunc(num2(p.scanTopN, 10));
      const minMomentum = num2(p.minMomentum, 0);
      const maxConcentrationPct = num2(p.maxConcentrationPct, 35);
      const minHolders = Math.trunc(num2(p.minHolders, 3));

      let candidates;
      try {
        candidates = await fetchTrending(scanTopN);
      } catch (e) {
        err(`${order.id}: autopilot trending read failed (${e.message}); skipping tick`);
        return;
      }
      if (!Array.isArray(candidates) || !candidates.length) return;

      // ── Decide: first survivor of the policy filter wins this tick ──────────
      // One entry per tick keeps the agent calm, auditable, and within cooldown.
      let pick = null;
      for (const c of candidates) {
        const curveId = c.curve_id ?? c.curveId;
        if (!curveId) continue;
        if (entered.includes(curveId)) continue;             // never re-enter
        if (c.graduated) continue;                            // can't curve-trade graduated
        const momentum = Number(c.momentum_score ?? 0);
        if (!(momentum > minMomentum)) continue;             // below the user's momentum floor

        // Veto: concentration + freshness. Deterministic, on-chain-derived.
        const conc = await topHolderConcentrationPct(curveId);
        if (conc) {
          if (minHolders > 0 && conc.holderCount < minHolders) {
            log(`${order.id}: autopilot skip ${curveId.slice(0, 10)}… — only ${conc.holderCount} holders (< ${minHolders})`);
            continue;
          }
          if (conc.pct > maxConcentrationPct) {
            log(`${order.id}: autopilot skip ${curveId.slice(0, 10)}… — top holder ${conc.pct.toFixed(1)}% liquid (> ${maxConcentrationPct}%)`);
            continue;
          }
        }

        // Confirm tradeable + not graduated via live curve read (trending can lag).
        try {
          const st = await getCurveState(curveId);
          if (st.graduated) continue;
          pick = { curveId, momentum, tokenType: st.tokenType ?? null };
          break;
        } catch (e) {
          err(`${order.id}: autopilot curve read failed for ${curveId.slice(0, 10)}… (${e.message}); next candidate`);
          continue;
        }
      }

      if (!pick) return; // nothing passed the policy this tick — wait for the next

      // ── Act: enter exactly like dca/sniper (Nexus proof + bridge settle) ────
      if (onCooldown(order)) return; // double-fire guard within a tick window
      const { curveId } = pick;

      let taskId = null;
      try {
        const d = await fireScheduleTask('buy', { buy: { curveId, amountSui: perEntrySui } }, { generator: 'queue' });
        taskId = d?.taskId ?? null;
      } catch (e) {
        err(`${order.id}: autopilot emit failed: ${e.message} (continuing to settle)`);
      }

      let settleDigest;
      try {
        settleDigest = await fireBridgeBuy(curveId, perEntrySui);
      } catch (e) {
        err(`${order.id}: autopilot settle failed on ${curveId.slice(0, 10)}…: ${e.message}`);
        return; // do not count an entry that didn't settle
      }

      // DRY-BUY GUARD: a real entry must produce a NEW on-chain digest. No digest,
      // or a digest already seen on this order, means no tokens moved — don't count it.
      if (!settleDigest || settleDigest === p._lastSettleDigest) {
        err(`${order.id}: autopilot dry-buy detected (digest=${settleDigest ?? 'null'}) — not counting, backing off`);
        order._cooldownUntil = Date.now() + cooldownMs; // back off so a genuine retry can happen later
        return;
      }

      // Settled. Record the entry, advance the mandate, optionally arm the exit.
      entered.push(curveId);
      p.entered          = entered;
      p.spentSui         = spentSui + perEntrySui;
      p.fired            = num2(p.fired, 0) + 1;
      p.lastFireMs       = Date.now();
      p._lastSettleDigest = settleDigest;
      order.params       = p;

      // EXIT LEG: arm TP/SL on the real post-buy fill price (shared armThen, same
      // as sniper/dca). The child closes the position; when it does, a future
      // version can free the slot in `entered` — for now maxOpenPositions counts
      // entries opened, which is the conservative cap.
      if (p.then) await armThen(order.id, curveId, p.then);

      // Close the order if the cap is now exhausted.
      if (p.spentSui + perEntrySui > spendCapSui + 1e-9) {
        order.done = true;
        log(`${order.id}: autopilot cap exhausted after entry — closing`);
      }

      await persistParams(order);
      await recordFire(order, { kind: 'buy', curveId, nexusTask: taskId, settle: settleDigest });
      log(`${order.id}: AUTOPILOT ENTRY ${curveId.slice(0, 10)}… momentum=${pick.momentum.toFixed(1)} size=${perEntrySui} SUI task=${taskId ?? 'n/a'} settle=${settleDigest} deployed=${p.spentSui.toFixed(2)}/${spendCapSui}${order.done ? ' — cap reached, closing' : ''}`);
    },
  };
}
