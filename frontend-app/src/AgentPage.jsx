// AgentPage.jsx - Autonomous agent console (routed page, renders inside <main>).
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
import { normalizeGoalText, extractPerEntrySui, extractSpendCapSui, isAutopilotIntent, isTrendingDiscovery } from './agentVocab.js';
import { ArrowLeft, Sparkles, Play, Check, X, Loader, ExternalLink, Bot, ChevronDown } from 'lucide-react';
import { useCurrentAccount, useDAppKit, useCurrentClient } from '@mysten/dapp-kit-react';
import { Transaction } from '@mysten/sui/transactions';
import { useNavigate } from 'react-router-dom';
import { SuiGraphQLClient } from '@mysten/sui/graphql';
import { PACKAGE_ID, PACKAGE_ID_V10, PACKAGE_ID_V11, PACKAGE_ID_V12, MIST_PER_SUI } from './constants.js';
import { signOwnerAuth } from './authSign.js';

// The agent's execution wallet - the session_address authorized to trade the
// escrow. buy_with_session/sell_with_session are signed by THIS wallet
// server-side (the bridge), never the user. Opening a session deposits SUI the
// agent may spend up to spend_cap, until expiry or revoke/close.
const AGENT_SESSION_WALLET = import.meta.env.VITE_AGENT_SESSION_WALLET
  || '0x877af0fae3fa4f8ea936943b59bcd66104f67cf1895302e97761a28b3c3a5906';
const AGENT_SUI_CLOCK_ID = '0x6';

// Self-funded sessions: the OWNER's open transaction grants the fresh session
// address its gas (rides in the same PTB as the escrow deposit - one
// signature). This removes the bridge gas-treasury dependency entirely: a dry
// treasury can no longer fail provisioning into the silent shared-wallet
// fallback (2026-07-03 incident), and the protocol stops subsidizing gas that
// mainnet bots would farm. 0.5 SUI covers ~450 trades at ~0.0011 SUI each.
// Keep in sync with the bridge's TURNKEY_GAS_FUND_MIST (its legacy path).
const SESSION_GAS_GRANT_MIST = 500_000_000n; // 0.5 SUI

// Nautilus Phase 2: the live EnclaveRegistry pinning the enclave build's PCRs.
// open_and_share_attested requires session_address to be a key this registry
// approved via Sui's NATIVE Nitro attestation verification - "the signer is
// enclave-held" becomes a chain-verified fact instead of an operator claim.
const ENCLAVE_REGISTRY_ID = import.meta.env.VITE_ENCLAVE_REGISTRY_ID
  || '0xf001bf6b078879b95c969ea11ef07dd53ffed364c62d8832990077f67d4996a1';

const RUNNER_URL  = import.meta.env.VITE_AGENT_RUNNER_URL || 'https://suipump-agent-runner.onrender.com';
const BRIDGE_URL  = import.meta.env.VITE_SUIPUMP_BRIDGE_URL || 'https://suipump-bridge.onrender.com';
const INDEXER_URL = import.meta.env.VITE_INDEXER_URL || 'https://suipump-62s2.onrender.com';
const TOKEN_DECIMALS = 6;

// close_session drains escrow but does NOT delete the shared AgentSession
// object, so a closed session stays discoverable forever via events/indexer.
// Remember locally which sessions THIS browser closed so discovery skips them
// immediately; the chain-derived dead-state rule in loadSession covers other
// devices. Capped list; failures are non-fatal (private mode etc.).
const CLOSED_SESSIONS_KEY = 'suipump_closed_sessions';
function closedSessionIds() {
  try { const v = JSON.parse(localStorage.getItem(CLOSED_SESSIONS_KEY) ?? '[]'); return Array.isArray(v) ? v : []; }
  catch { return []; }
}
function rememberClosedSession(id) {
  try {
    const list = closedSessionIds().filter(x => x !== id);
    list.push(id);
    localStorage.setItem(CLOSED_SESSIONS_KEY, JSON.stringify(list.slice(-20)));
  } catch { /* storage unavailable - dead-state rule still applies */ }
}

const suiscanObject = (id) => `https://suiscan.xyz/testnet/object/${id}`;

// Published Nexus DAG IDs each strategy executes through (testnet). Shown on the
// plan/result so the on-chain orchestration path is visible at arm time.
const NEXUS_DAG = {
  buy:  '0x922f29c5a198503c83cf1cbd26193ed8255fdf5e5a6bb1f1843b8bc3994eb403',
  sell: '0xb48c4b8e5a68941af3a91169ebec81f6046b0e4fc58f6443c4013f6b6f13995d',
};
const WORKFLOW_DAGS = {
  sniper:    ['buy'],
  dca:       ['buy', 'sell'],
  copytrade: ['buy', 'sell'],
  tpsl:      ['sell'],
  buy_then_tpsl: ['buy', 'sell'],
};

// "How to operate" content for the agent-page accordion, in three tiers:
//   TOOLS      - the 5 atomic Nexus tools (xyz.suipump.*@1), from the Rust source.
//   STRATEGIES - the 4 standing behaviours built on those tools.
//   COMBINING  - the one real composition (a buy-strategy auto-arming an exit).
// Example goals match the deterministic parsers / planner verbatim; clicking one
// loads it into the goal box. Content is limited to what actually works on-chain.
const OPERATE_GUIDE = [
  {
    section: 'TOOLS',
    blurb: 'The five atomic Nexus tools the agent calls. Every strategy is built from these.',
    items: [
      {
        key: 'launch', title: 'Launch', fqn: 'xyz.suipump.launch@1',
        tagline: 'Create a new token (with an optional dev-buy)',
        body: 'Publishes a new token on SuiPump - handles the bytecode patching and publishing - and optionally does a dev-buy in the same transaction. You can set the graduation DEX (Cetus, DeepBook, or Turbos) and an anti-bot delay.',
        inputs: ['Name, symbol, description', 'Optional: icon URL', 'Optional: dev-buy in SUI', 'Optional: graduation target (cetus / deepbook / turbos)', 'Optional: anti-bot delay (0 / 15 / 30s)'],
        examples: ['Launch a dog token called MoonCat, symbol MCAT, dev-buy 1 SUI'],
      },
      {
        key: 'buy', title: 'Buy', fqn: 'xyz.suipump.buy@2',
        tagline: 'Spend SUI to buy a token on its curve',
        body: 'Buys tokens on a bonding curve for a set amount of SUI, with a slippage tolerance (default 2%). Optionally credits a referrer.',
        inputs: ['A token CA', 'An amount of SUI to spend', 'Optional: slippage tolerance', 'Optional: referrer address'],
        examples: ['Buy 2 SUI of 0xCURVE'],
      },
      {
        key: 'sell', title: 'Sell', fqn: 'xyz.suipump.sell@2',
        tagline: 'Sell tokens back to SUI',
        body: 'Sells tokens back to SUI on a curve. You can set a minimum-SUI-out as a slippage guard. Sell a specific amount or your whole position.',
        inputs: ['A token CA', 'How many tokens (or all)', 'Optional: minimum SUI out (slippage guard)'],
        examples: ['Sell all tokens of 0xCURVE'],
      },
      {
        key: 'claim', title: 'Claim', fqn: 'xyz.suipump.claim@2',
        tagline: 'Collect pending creator fees',
        body: 'Claims the creator fees that have accrued on a curve you launched. Does nothing if there are no fees pending. You can claim one curve by pasting its CA, or claim every curve you created at once - say "claim all" with no CA and the agent enumerates your curves and claims each one through Nexus.',
        inputs: ['A token CA you created - or "claim all" for every curve at once'],
        examples: ['Claim creator fees on 0xCURVE', 'Claim all my creator fees'],
      },
      {
        key: 'alerts', title: 'Alerts / Monitor', fqn: 'xyz.suipump.alerts@1',
        tagline: 'Watch curves for graduation, fees, and price moves',
        body: 'Monitors up to 10 curves and reports status: a graduation warning as a curve nears its threshold, a reminder when creator fees are worth claiming, and a price-movement alert past a set percentage.',
        inputs: ['One or more curve CAs (max 10)', 'Optional: graduation-warning SUI level', 'Optional: claim-reminder fee level', 'Optional: price-move % to flag'],
        examples: ['Monitor 0xCURVE and alert me when it nears graduation'],
      },
    ],
  },
  {
    section: 'STRATEGIES',
    blurb: 'Standing behaviours the agent runs on its own, orchestrating the tools above.',
    items: [
      {
        key: 'sniper', title: 'Sniper', fqn: 'strategy.sniper@1',
        tagline: 'Auto-buy new launches the moment they appear',
        body: 'A standing order that watches for new token launches and fires a buy through Nexus the instant one is created - every launch, or only launches from a specific creator. Runs until cancelled or an optional cap is hit.',
        inputs: ['A SUI amount per snipe', 'Optional: a creator wallet to restrict to', 'Optional: a max number of snipes', 'Optional: an exit armed on each buy'],
        examples: ['Snipe 1 SUI of every new token launch', 'Snipe 2 SUI of every token launched by 0xCREATOR, take profit at 50%'],
      },
      {
        key: 'dca', title: 'DCA / Scale-in', fqn: 'strategy.dca@1',
        tagline: 'Accumulate over time, or buy each dip - tracking average cost',
        body: 'A standing accumulation order on one curve. TIME mode buys on a schedule; DIP mode buys each time price drops a set %. The agent tracks your blended average cost across fills and can auto-arm a take-profit measured against that average.',
        inputs: ['A token CA', 'A SUI amount per buy', 'A trigger: an interval (time) OR a % drop (dip)', 'How many buys total', 'Optional: a take-profit on the average cost'],
        examples: ['Buy 5 SUI of 0xCURVE every day for 10', 'Buy 5 SUI of 0xCURVE, buy 5 more if it drops 10%, take profit at 20%'],
      },
      {
        key: 'copytrade', title: 'Copy-trade', fqn: 'strategy.copytrade@1',
        tagline: 'Mirror a wallet: buy when it buys, sell when it sells',
        body: 'Follows a target wallet across every curve it trades. When the target buys, the agent buys a fixed SUI amount. When the target sells, the agent sells the same proportion of its own position. It never mirrors its own execution wallet.',
        inputs: ['A target wallet to follow', 'A SUI amount per mirrored buy'],
        examples: ['Copy wallet 0xWALLET buying 5 SUI per trade', 'Mirror 0xWALLET at 2 SUI each'],
      },
      {
        key: 'tpsl', title: 'Take-profit / Stop-loss', fqn: 'strategy.tpsl@1',
        tagline: 'Auto-sell a position at a price target',
        body: 'Watches a curve you hold and sells automatically through Nexus when price hits a take-profit multiple or falls to a stop-loss. Take-profit can be tiered - sell part at one level, the rest higher.',
        inputs: ['A token CA you hold', 'A take-profit target and/or a stop-loss'],
        examples: ['Take profit on 0xCURVE at 50% and stop loss at 20%', 'Sell 50% of 0xCURVE at +30%, sell the rest at +100%'],
      },
    ],
  },
  {
    section: 'COMBINING',
    blurb: 'How strategies fit together.',
    items: [
      {
        key: 'combining', title: 'Entry strategy + automatic TP/SL exit', fqn: null,
        tagline: 'Pair Sniper or DCA with a hands-off take-profit / stop-loss',
        body: 'Two pairings are supported today, both adding a TP/SL exit onto an entry strategy:\n\n* Sniper + TP/SL - each snipe auto-arms an exit, seeded at that buy\'s real fill price.\n* DCA + TP/SL - after the accumulation completes, an exit arms on the blended average cost.\n\nIn both cases you just add "take profit at X%" and/or "stop loss at Y%" to the same goal; the exit then watches and sells on its own. Copy-trade does not take an added exit - its selling is already driven by the target wallet. These two entry->exit pairings are the only compositions: strategies otherwise run independently, and there is no multi-step chaining of one strategy into another (e.g. no Sniper->DCA, no DCA->Copy-trade).',
        inputs: null,
        examples: ['Snipe 1 SUI of every new launch, take profit at 50%', 'Buy 5 SUI of 0xCURVE, buy 5 more if it drops 10%, take profit at 20% and stop loss at 15%'],
      },
    ],
  },
];
const suiscanTx     = (d)  => `https://suiscan.xyz/testnet/tx/${d}`;

const GRAD = { 0: 'Cetus', 1: 'DeepBook', 2: 'Turbos' };

// Token avatar with the app's standard fallback: if the icon URL is missing or
// fails to load, show the 🔥 placeholder (same convention as TokenCard / token
// header). Symbol kept in the signature for the alt text only.
function TokenIcon({ url, symbol, size = 28 }) {
  const [failed, setFailed] = useState(false);
  const dim = { width: size, height: size };
  return (
    <div
      style={dim}
      className="rounded-full flex-shrink-0 overflow-hidden bg-white/[0.06] flex items-center justify-center"
    >
      {url && !failed
        ? <img
            src={url}
            alt={symbol || ''}
            onError={() => setFailed(true)}
            className="w-full h-full object-cover"
          />
        : <span className="text-sm leading-none">🔥</span>}
    </div>
  );
}

// Tool node metadata per workflow - drives the execution animation.
const WORKFLOW_NODES = {
  launch_and_buy: [
    { id: 'launch', tool: 'xyz.suipump.launch@1', label: 'Launch',  desc: 'Create token on bonding curve' },
    { id: 'buy',    tool: 'xyz.suipump.buy@2',    label: 'Dev-buy', desc: 'Agent makes the first buy' },
  ],
  buy:    [{ id: 'buy',    tool: 'xyz.suipump.buy@2',    label: 'Buy',    desc: 'Buy tokens on the curve' }],
  sell:   [{ id: 'sell',   tool: 'xyz.suipump.sell@2',   label: 'Sell',   desc: 'Sell tokens back to SUI' }],
  claim:  [{ id: 'claim',  tool: 'xyz.suipump.claim@2',  label: 'Claim',  desc: 'Claim creator fees' }],
  claim_all: [{ id: 'claim', tool: 'xyz.suipump.claim@2', label: 'Claim all', desc: 'Claim creator fees from every curve you created' }],
  alerts: [{ id: 'alerts', tool: 'xyz.suipump.alerts@1', label: 'Monitor', desc: 'Watch graduation / price' }],
  tpsl:   [{ id: 'arm',    tool: 'strategy.tpsl@1',      label: 'Arm strategy', desc: 'Standing TP/SL order the agent watches' }],
  sniper: [{ id: 'arm',    tool: 'strategy.sniper@1',    label: 'Arm sniper',   desc: 'Standing buy that fires on every matching launch' }],
  dca:    [{ id: 'arm',    tool: 'strategy.dca@1',       label: 'Arm DCA',      desc: 'Standing accumulation: buys on a schedule or on each dip' }],
  copytrade: [{ id: 'arm', tool: 'strategy.copytrade@1', label: 'Arm copy-trade', desc: 'Mirror a target wallet: buy when it buys, sell when it sells' }],
  autopilot: [{ id: 'arm', tool: 'strategy.autopilot@1', label: 'Arm autopilot', desc: 'Standing autonomous trader: scans the market and enters within your spend cap' }],
  buy_then_tpsl: [
    { id: 'buy', tool: 'xyz.suipump.buy@2', label: 'Buy',          desc: 'Buy the position now' },
    { id: 'arm', tool: 'strategy.tpsl@1',   label: 'Arm strategy', desc: 'Then watch price and auto-sell at the target' },
  ],
};

// extractTakeProfitRungs - pull EVERY take-profit rung from a goal, in order.
// Splits the goal into clauses on connectors (commas, "and", "then", ";") and
// parses each clause independently: a take-profit trigger plus the sell-size in
// that SAME clause ("sell 50%" / "sell all" / "dump all"), defaulting to 100%.
// Clause splitting means a later "sell all" can never be attributed to an earlier
// rung, so "sell 50% at +10% and sell all at +20%" yields TWO rungs.
//
// A take-profit trigger is recognized as either:
//   * an explicit "+N%"  (e.g. "+20%"), OR
//   * a bare "to/at N%" / standalone "N%" WITHOUT any stop-loss keyword in the
//     clause (e.g. "to 5% sell all", "sell all at 5%"). Bare percentages default
//     to take-profit; stop-loss only ever arms on an explicit keyword (handled in
//     parseStrategyGoal), so a bare percentage is never a stop-loss.
// The sell-size percentage ("sell 50%") is NEVER mistaken for the trigger.
// sanitizePercents - repair common fat-finger typos INSIDE numeric percent
// tokens so "sell !00%" reads as "sell 100%" and "5O%" as "50%". Only digits
// adjacent to a % are touched; the rest of the goal is left alone. ! -> 1
// (shift+1 slip), O/o -> 0, l/I -> 1 when wedged among digits before a %.
export function sanitizePercents(s) {
  return String(s || '').replace(/[\d!OolI]{1,4}\s*%/g, (tok) =>
    tok.replace(/!/g, '1').replace(/[Oo]/g, '0').replace(/[lI]/g, '1'));
}

// extractTakeProfitRungs - pull EVERY take-profit rung from a goal, in order.
// Splits the goal into clauses on connectors (commas, "and", "then", ";"), then
// within each clause keeps ONLY the portion BEFORE any stop-loss keyword (so a
// single breath like "tp 5% sell 100% sl -5% sell 100%" contributes the +5% TP
// and leaves the -5% to the stop-loss parser). Each take-profit trigger ("+N%"
// or a bare "to/at N%") is paired with the sell-size in its own clause,
// defaulting to 100%. Multi-rung tiered exits are supported.
export function extractTakeProfitRungs(lower) {
  const rungs = [];
  const seen = new Set();
  const SL_KW = /\b(stop[\s-]*loss|sl|stop)\b/;
  const clauses = sanitizePercents(lower).split(/\s*(?:,|;|\band\b|\bthen\b)\s*/);
  for (let clause of clauses) {
    // If a stop-loss keyword appears mid-clause, the take-profit is whatever
    // comes BEFORE it. Slice the clause at the first SL keyword.
    const slIdx = clause.search(SL_KW);
    if (slIdx >= 0) clause = clause.slice(0, slIdx);
    if (!clause.trim()) continue;

    const hasPlus = /\+\s*\d+(?:\.\d+)?\s*%/.test(clause);
    // An explicit negative percentage in the TP portion is not a take-profit.
    if (!hasPlus && /-\s*\d+(?:\.\d+)?\s*%/.test(clause)) continue;

    // Determine the sell-size first so we can exclude it from trigger matching.
    let sellPct = 100;
    const sizeM = clause.match(/sell\s+(\d+(?:\.\d+)?)\s*%/);
    if (sizeM) sellPct = Number(sizeM[1]);
    else if (/sell\s+all|dump\s+all|sell\s+the\s+rest|sell\s+rest|sell\s+everything/.test(clause)) sellPct = 100;

    // Trigger: prefer an explicit "+N%". Otherwise accept a bare "to/at N%" or a
    // standalone "N%" that is NOT the "sell N%" size. We blank out the sell-size
    // token before scanning so "sell 50% at 10%" reads the 10% as the trigger.
    let pct = null;
    const plus = clause.match(/\+\s*(\d+(?:\.\d+)?)\s*%/);
    if (plus) {
      pct = Number(plus[1]);
    } else {
      const scan = clause.replace(/sell\s+\d+(?:\.\d+)?\s*%/g, ' '); // drop the size token
      const at = scan.match(/(?:to|at|@|of)\s*\+?\s*(\d+(?:\.\d+)?)\s*%/);
      const bare = at || scan.match(/(\d+(?:\.\d+)?)\s*%/);
      if (bare) pct = Number(bare[1]);
    }
    if (pct == null || !(pct > 0)) continue;

    const key = `${pct}:${sellPct}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rungs.push({ multiple: 1 + pct / 100, sellPct });
  }
  return rungs;
}

// Client-side strategy intent parser. The LLM planner only emits one-shot
// workflows (buy/sell/claim/alerts/launch); a take-profit / stop-loss is a
// STANDING order, so we recognize it here and build a `tpsl` plan that creates
// an order in the strategy store. Returns a plan object or null (not a strategy).
//
// Recognized shapes (case-insensitive):
//   "take profit ... at +20%"               -> ONE TP rung at 1.20x, sell 100%
//   "take profit ... at +20% sell 50%"       -> ONE TP rung at 1.20x, sell 50%
//   "dump all ... at +20%"                   -> ONE TP rung at 1.20x, sell 100%
//   "sell 50% ... at +30%"                   -> ONE TP rung at 1.30x, sell 50%
//   "sell 50% at +10% and sell all at +20%"  -> TWO TP rungs (tiered exit)
//   "stop loss ... at -15%"                  -> SL at 0.85x
// A curve 0x... must be present. TP (one or more rungs) and SL can appear together.
export function parseStrategyGoal(text) {
  const g = String(text || '');
  const curveMatch = g.match(/0x[0-9a-fA-F]{4,}/);
  if (!curveMatch) return null;
  const curveId = curveMatch[0];

  const lower = sanitizePercents(g.toLowerCase());
  // A "sell ... at/to M%" phrasing is a take-profit intent (tiered exit), even
  // without the literal words "take profit" and even without a "+" sign. Detect
  // it so phrasings like "sell all at 5%", "to 5% sell all", or "sell 50% at +30%"
  // arm an exit rather than dropping it. Requires a sell intent (sell N% / sell
  // all / dump all) together with a percentage that is NOT a stop-loss (stop-loss
  // requires an explicit keyword). This keeps a plain "sell all" (no %) from
  // matching, and keeps a bare percentage from hijacking non-sell goals.
  const sellIntent = /sell\s+(?:\d+(?:\.\d+)?\s*%|all|the\s+rest|rest|everything)|dump\s+all/.test(lower);
  const hasPct = /\d+(?:\.\d+)?\s*%/.test(lower);
  const sellAtPct = sellIntent && hasPct;
  const hasStrategyWord = /\b(take[\s-]*profit|tp|stop[\s-]*loss|sl|stop|dump\s+all)\b/.test(lower) || sellAtPct;
  if (!hasStrategyWord) return null;

  // Take-profit: collect ALL rungs (tiered exits supported). Each trigger ("+N%"
  // or a bare "to/at N%") is paired with the sell-size in its own clause; a clause
  // with no sell-size defaults to 100%. Stop-loss clauses are excluded.
  const tp = extractTakeProfitRungs(lower);

  // Stop-loss: ONLY arms on an explicit keyword (stop loss / stop-loss / sl /
  // stop). A bare percentage is never a stop-loss (it is a take-profit). Accepts
  // "to / at / @ / of / by" and an optional minus sign before the number.
  let stopLoss = null;
  const slPct = lower.match(/\b(?:stop[\s-]*loss|sl|stop)\b\s*(?:to|at|@|of|by)?\s*-?\s*(\d+(?:\.\d+)?)\s*%/);
  if (slPct) {
    const pct = Number(slPct[1]);
    if (pct > 0 && pct < 100) stopLoss = { multiple: 1 - pct / 100 };
  }

  if (!tp.length && !stopLoss) return null;

  // Compound: a leading "buy N sui" in the SAME goal means buy first, then arm
  // the take-profit/stop-loss on the bought position. e.g.
  //   "buy 500 sui of 0x... , take profit at +20% sell all"
  // The buy settles immediately via the bridge; the TP/SL is then armed at the
  // post-buy fill price so "+20%" is measured from what we actually paid.
  const buyMatch = lower.match(/buy\s+(\d*\.?\d+)\s*sui/);
  if (buyMatch) {
    const amountSui = Number(buyMatch[1]);
    if (amountSui > 0) {
      const tpDescC = tp.length ? `take-profit ${tp.map(r => `+${Math.round((r.multiple - 1) * 100)}% (sell ${r.sellPct}%)`).join(', ')}` : '';
      const slDescC = stopLoss ? `stop-loss -${Math.round((1 - stopLoss.multiple) * 100)}%` : '';
      const summaryC = `Buy ${amountSui} SUI of ${curveId.slice(0, 10)}..., then arm ${[tpDescC, slDescC].filter(Boolean).join(' . ')}. The agent buys now and sells automatically when a trigger is hit.`;
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
  const summary = `Arm a standing strategy on ${curveId.slice(0, 10)}...: ${[tpDesc, slDesc].filter(Boolean).join(' . ')}. The agent watches the price and sells automatically when a trigger is hit.`;

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

  // Yield to AUTOPILOT when the goal is trending-DISCOVERY rather than launch-
  // sniping. "ape into every token that's trending" matches sniper's
  // "every ... token" net, but the word "trending" (with no launch word) means
  // the user wants the agent to discover already-trending tokens - that is
  // autopilot, which runs next in the chain. An EXPLICIT "snipe/sniper" keyword
  // overrides (the user literally asked to snipe), so this only yields for the
  // generic "ape/buy every token" phrasings.
  const explicitSnipe = /\bsnipe\b|\bsniper\b/.test(lower);
  if (!explicitSnipe && isTrendingDiscovery(lower)) return null;

  // All 64-hex ids -> creator filters (a creator is a wallet; same shape as a CA).
  const hexes = g.match(/0x[a-fA-F0-9]{60,66}/g);
  const creators = hexes ? Array.from(new Set(hexes.map(s => s.toLowerCase()))) : [];

  // amount: "snipe N sui" / "buy N sui" / "N sui"; default 0.1.
  let amountSui = 0.1;
  const amt = lower.match(/(?:dev[\s-]?buy|buy|ape|snipe)\s+(\d*\.?\d+)\s*sui/) || lower.match(/(\d*\.?\d+)\s*sui/);
  if (amt) amountSui = Number(amt[1]);

  // symbols: "symbol: PEPE" / "ticker PEPE".
  const symbols = [];
  { let m; const re = /(?:symbol|ticker)\s*[:\-]?\s*\$?([a-z0-9]{1,12})/ig;
    while ((m = re.exec(g)) !== null) symbols.push(m[1].toUpperCase()); }

  // nameIncludes: "named X" / "called X" / "name contains X" - stop at a clause
  // boundary or a 0x address so it doesn't swallow "by 0x...".
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

  // -- then.tpsl: a "dump all / take profit at +X%" (and/or "stop loss at -Y%")
  // in the SAME sentence means "after each snipe, arm a TP/SL on that curve".
  // The brain reads the real post-buy fill price and seeds entry, so "+X%" is
  // measured from what the snipe actually paid. Same extraction shape as
  // parseStrategyGoal. `then` stays null when no exit leg is present.
  let then = null;
  {
    const tp = [];
    const tpPct = lower.match(/(?:take[\s-]*profit|tp|dump\s+all|dump|profit)\s*(?:at|@|of|by)?\s*\+?\s*(\d+(?:\.\d+)?)\s*%/);
    if (tpPct) {
      const pct = Number(tpPct[1]);
      let sellPct = 100;
      const sellMatch = lower.match(/sell\s+(\d+(?:\.\d+)?)\s*%/);
      if (sellMatch) sellPct = Number(sellMatch[1]);
      else if (/dump\s+all|sell\s+all/.test(lower)) sellPct = 100;
      if (pct > 0) tp.push({ multiple: 1 + pct / 100, sellPct });
    }
    let stopLoss = null;
    const slPct = lower.match(/(?:stop[\s-]*loss|sl)\s*(?:at|@|of|by)?\s*-?\s*(\d+(?:\.\d+)?)\s*%/);
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
      ].filter(Boolean).join(' . ')} on each buy`
    : '';

  const summary = `Arm a standing sniper: buy ${amountSui} SUI of ${scope}${maxSnipes != null ? `, first ${maxSnipes} only` : ' (unbounded)'}${thenDesc}. The agent watches new launches, buys automatically the moment one matches${then ? ', then auto-sells each position when its trigger is hit' : ''}.`;

  return { workflow: 'sniper', summary, sniper, then };
}

// Client-side DCA / scale-in parser. DCA is a STANDING accumulation order on a
// SPECIFIC curve (so a CA is required in the goal). Two trigger shapes:
//   * time: "buy 10 sui of <CA> every day for 10"  -> intervalMs + buys
//   * dip:  "buy 5 sui of <CA>, 10 more each -10% drop, 3 buys" -> dropPct + buys
// Recognized here (not via the LLM) so the 64-hex CA is never mangled and the
// amount/interval/drop are parsed deterministically. `then.tpsl` in the same
// goal arms an exit on the blended average cost after the final buy.
// Returns a dca plan or null. (parseSniperGoal runs FIRST, so "every token
// launched by 0x..." routes to sniper, not here.)
function parseDcaGoal(text) {
  const g = String(text || '');
  const lower = g.toLowerCase();

  // Trigger: must look like DCA/accumulation. Either an explicit "dca", or a
  // recurring/scale-in phrasing ("every <time>", a percentage drop, "N more").
  // Requires a SUI buy amount somewhere.
  const hasDcaWord = /\bdca\b|\bdollar[\s-]?cost\b|\baverage\s+(?:in|down)\b|\bscale\s+in\b|\baccumulate\b/.test(lower);
  const hasEveryTime = /\bevery\s+(?:\d+\s*)?(?:second|sec|minute|min|hour|hr|day|week)s?\b/.test(lower);
  // Dip: any percentage tied to a fall - "drops/falls/dips/down/lower X%",
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

  // Per-buy SUI. Your phrasing can carry TWO sizes: an anchor ("buy 5 sui ...")
  // and a per-dip rung ("...buy 10 more each -10%"). Capture both; the rung size is
  // the one tied to "more". If only one amount, it is both anchor and rung.
  const allAmts = [...lower.matchAll(/(\d*\.?\d+)\s*sui/g)].map(m => Number(m[1]));
  const moreMatch = lower.match(/(\d*\.?\d+)\s*(?:sui\s+)?more/);
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

  // then.tpsl - shared extraction (same shape as sniper / parseStrategyGoal). The
  // brain arms this on the BLENDED average cost after the final buy.
  let then = null;
  {
    const tp = [];
    const tpPct = lower.match(/(?:take[\s-]*profit|tp|profit|exit)\s*(?:at|@|of|by)?\s*\+?\s*(\d+(?:\.\d+)?)\s*%/);
    if (tpPct) {
      const pct = Number(tpPct[1]);
      let sellPct = 100;
      const sellMatch = lower.match(/sell\s+(\d+(?:\.\d+)?)\s*%/);
      if (sellMatch) sellPct = Number(sellMatch[1]);
      if (pct > 0) tp.push({ multiple: 1 + pct / 100, sellPct });
    }
    let stopLoss = null;
    const slPct = lower.match(/(?:stop[\s-]*loss|sl)\s*(?:at|@|of|by)?\s*-?\s*(\d+(?:\.\d+)?)\s*%/);
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
      ].filter(Boolean).join(' . ')} on the average cost`
    : '';

  const summary = `Arm DCA on ${curveId.slice(0, 10)}...: buy ${suiPerBuy} SUI ${modeDesc}, ${buys} buy${buys > 1 ? 's' : ''} total${thenDesc}. The agent accumulates automatically and tracks the average cost${then ? ', then auto-exits against that average' : ''}.`;

  return { workflow: 'dca', summary, dca, then };
}

// Client-side copy-trade parser. Copy-trade FOLLOWS A TARGET WALLET across any
// curve: when the target buys, the agent buys a fixed `suiPerTrade` SUI; when the
// target sells, the agent sells the SAME FRACTION of its position (proportional).
// Recognized here so the 64-hex target wallet is never handed to the LLM. The
// target is a wallet, not a curve, so NO curve CA is needed (curves are
// discovered at runtime from the target's trades). Returns a copytrade plan or
// null. (parseSniperGoal / parseDcaGoal run first; "copy/mirror/follow <wallet>"
// is distinctive enough not to collide.)
function parseCopytradeGoal(text) {
  const g = String(text || '');
  const lower = g.toLowerCase();

  // Trigger verb: copy / mirror / follow / shadow a wallet/trader/address.
  const isCopy =
    /\b(copy|mirror|shadow|follow|copytrade|copy[\s-]?trade)\b/.test(lower) &&
    /\b(wallet|trader|address|0x[a-f0-9]{6,})\b/.test(lower);
  if (!isCopy) return null;

  // Target wallet: the 64-hex address.
  const ca = g.match(/0x[a-fA-F0-9]{60,66}/);
  const targetWallet = ca ? ca[0].toLowerCase() : null;
  if (!targetWallet) return null;

  // Per-trade SUI size: "5 sui per trade" / "buy 5 sui" / "5 sui each" / "5 sui".
  let suiPerTrade = null;
  const amt =
    lower.match(/(\d*\.?\d+)\s*sui\s*(?:per\s*(?:trade|buy)|each|a\s*trade)/) ||
    lower.match(/(?:buy|at|with|use)\s+(\d*\.?\d+)\s*sui/) ||
    lower.match(/(\d*\.?\d+)\s*sui/);
  if (amt) suiPerTrade = Number(amt[1]);
  if (!(suiPerTrade > 0)) return null;

  const copytrade = { targetWallet, suiPerTrade };

  const summary = `Arm copy-trade on ${targetWallet.slice(0, 10)}...: when they buy, the agent buys ${suiPerTrade} SUI; when they sell, the agent sells the same proportion of its position. Mirrors across every curve the target trades, automatically through Nexus.`;

  return { workflow: 'copytrade', summary, copytrade };
}

// parseAutopilotGoal - the AUTOPILOT strategy: a hands-off, 24/7 autonomous trader.
// Runs AFTER sniper/dca/copytrade in the parse chain (those need a specific curve);
// autopilot is the "no specific token - you pick" catch-all for autonomous goals.
// Returns an autopilot plan or null.
function parseAutopilotGoal(text) {
  const g = String(text || '');
  // Normalize spoken amounts (half a sui, point five, 1.5k, a couple) into digits
  // via the SHARED vocabulary so the parser and the LLM planner read goals the
  // same way. All matching below runs on the normalized text.
  const lower = normalizeGoalText(g);

  // Autopilot is the curve-less autonomous intent. isAutopilotIntent() returns
  // false when a 0x curve id is present (that's a targeted buy/strategy, not
  // autopilot) - this is the fix for the autopilot<->buy ambiguity.
  if (!isAutopilotIntent(lower)) return null;

  const numAfter = (re, d) => { const m = lower.match(re); return m ? Number(m[1]) : d; };

  // Shared extractors: same logic the LLM planner's normalizer mirrors.
  const spendCapSui = extractSpendCapSui(lower, 10);
  const perEntrySui = extractPerEntrySui(lower, 0.5);

  const maxOpenPositions =
    Math.trunc(numAfter(/max\s*(\d+)\s*(?:positions|tokens|holdings|trades|open)/, null) ??
               numAfter(/(\d+)\s*positions?\s*max/, null) ??
               5);

  let minMomentum = numAfter(/momentum\s*(?:>|over|above)?\s*(\d+(?:\.\d+)?)/, null);
  if (minMomentum == null) minMomentum = /high\s*momentum|strong\s*momentum|only\s*the\s*best/.test(lower) ? 50 : 0;

  const maxConcentrationPct =
    numAfter(/(?:concentration|whale|top holder)\s*(?:<|under|below|max)?\s*(\d+(?:\.\d+)?)\s*%/, null) ?? 35;

  // Exit (TP/SL) on each entry. Use the SAME robust extraction the standalone
  // TP/SL parser uses so autopilot understands every exit phrasing:
  //   percentage-form: "take profit 50%", "+50%", "sell 50% at +30%", tiered
  //   multiple-form:   "sell at 2x", "tp 1.5x", "2x" (1.5x -> multiple 1.5)
  // Previously the inline block only caught "tp/profit ... N%", so "sell at 2x"
  // silently dropped and autopilot entered positions with NO exit armed.
  let then = null;
  {
    // 1) Percentage-form take-profit rungs (tiered) via the shared extractor.
    const tp = extractTakeProfitRungs(lower);

    // 2) Multiple-form take-profit: "Nx" (optionally after tp/profit/sell/at).
    //    Each distinct multiple > 1 becomes a rung; sell-size defaults to 100%
    //    unless a "sell M%" appears in the same goal.
    const seenMult = new Set(tp.map(r => r.multiple));
    let defaultSell = 100;
    const sellSize = lower.match(/sell\s+(\d+(?:\.\d+)?)\s*%/);
    if (sellSize) defaultSell = Number(sellSize[1]);
    const multRe = /(?:take\s*profit|tp|profit|sell|at|@)?\s*(\d+(?:\.\d+)?)\s*x\b/g;
    let mm;
    while ((mm = multRe.exec(lower)) !== null) {
      const mult = Number(mm[1]);
      if (mult > 1 && !seenMult.has(mult)) { seenMult.add(mult); tp.push({ multiple: mult, sellPct: defaultSell }); }
    }
    // Keep rungs ordered by trigger so tiered exits read low->high.
    tp.sort((a, b) => a.multiple - b.multiple);

    // 3) Stop-loss: percentage-form ("-30%", "stop loss 30%") OR multiple-form
    //    ("0.7x", "sl at 0.8x"). Multiple < 1 is a stop.
    let stopLoss = null;
    const slPct = lower.match(/(?:stop\s*loss|sl|stop)[^+\-x]*-?\s*(\d+(?:\.\d+)?)\s*%/);
    if (slPct) {
      const pct = Number(slPct[1]);
      if (pct > 0 && pct < 100) stopLoss = { multiple: 1 - pct / 100 };
    }
    if (!stopLoss) {
      const slMult = lower.match(/(?:stop\s*loss|sl|stop)[^x]*?(\d*\.\d+)\s*x\b/);
      if (slMult) { const m = Number(slMult[1]); if (m > 0 && m < 1) stopLoss = { multiple: m }; }
    }

    if (tp.length || stopLoss) then = { tpsl: { takeProfit: tp, stopLoss } };
  }

  const autopilot = {
    spendCapSui, perEntrySui, minMomentum, maxConcentrationPct,
    maxOpenPositions, minHolders: 3, scanTopN: 10, cooldownMs: 60000,
  };
  if (then) autopilot.then = then;

  const thenDesc = then
    ? `, then arm ${[
        then.tpsl.takeProfit.length ? `take-profit ${then.tpsl.takeProfit.map(r => `+${Math.round((r.multiple - 1) * 100)}% (sell ${r.sellPct}%)`).join(', ')}` : '',
        then.tpsl.stopLoss ? `stop-loss -${Math.round((1 - then.tpsl.stopLoss.multiple) * 100)}%` : '',
      ].filter(Boolean).join(' \u00b7 ')} on each entry`
    : '';

  const summary = `Arm autopilot: deploy up to ${spendCapSui} SUI, ${perEntrySui} SUI per entry, into trending tokens with momentum over ${minMomentum} and top-holder concentration under ${maxConcentrationPct}%, max ${maxOpenPositions} open positions${thenDesc}. The agent scans the market on its own 24/7, enters the best candidate that clears the filters, and never exceeds the spend cap. Revocable anytime.`;

  return { workflow: 'autopilot', summary, autopilot, then };
}

// -- Active-strategies helpers -------------------------------------------------
const ORDER_LABEL = { tpsl: 'TP / SL', sniper: 'Sniper', dca: 'DCA', copytrade: 'Copy-trade', autopilot: 'Autopilot' };
const shortId  = (s) => (typeof s === 'string' && s.startsWith('0x') && s.length > 14) ? `${s.slice(0, 8)}...${s.slice(-4)}` : s;
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
    const cap = p.maxSnipes ? ` . ${p.fired || 0}/${p.maxSnipes} fired` : ` . ${p.fired || 0} fired`;
    const then = p.then?.tpsl ? ' -> then TP/SL' : '';
    return `Buy ${p.amountSui} SUI on ${bits.join(p.match === 'any' ? ' or ' : ' & ')}${cap}${then}`;
  }
  if (o.type === 'dca') {
    const every = p.intervalMs >= 60000 ? `${Math.round(p.intervalMs / 60000)}m` : `${Math.round((p.intervalMs || 0) / 1000)}s`;
    const then = p.then?.tpsl ? ' -> then TP/SL' : '';
    return `Buy ${p.suiPerBuy} SUI every ${every} . ${p.done || 0}/${p.buys} done${then}`;
  }
  if (o.type === 'copytrade') {
    const size = p.suiPerTrade ? `${p.suiPerTrade} SUI/trade` : `${p.ratio}x their size`;
    const then = p.then?.tpsl ? ' -> then TP/SL' : '';
    return `Mirror ${shortId(p.targetWallet)} at ${size}${then}`;
  }
  if (o.type === 'autopilot') {
    const p = o.params || {};
    const deployed = Number(p.spentSui ?? 0);
    const cap = Number(p.spendCapSui ?? 0);
    const open = Array.isArray(p.entered) ? p.entered.length : (Number(p.openCount ?? 0) || 0);
    const per = Number(p.perEntrySui ?? 0);
    const maxOpen = Number(p.maxOpenPositions ?? 0);
    const then = p.then?.tpsl ? ' -> TP/SL per entry' : '';
    return `Autopilot . ${per} SUI/entry . ${deployed.toFixed(2)}/${cap} SUI deployed . ${open}${maxOpen ? `/${maxOpen}` : ''} open${then}`;
  }

  // tpsl
  const tp = Array.isArray(o.takeProfit) ? o.takeProfit : [];
  const tpStr = tp.length
    ? 'TP ' + tp.map((r) => (r.multiple ? `${r.multiple}x` : `${r.priceSui} SUI`) + ` (${r.sellPct}%)`).join(', ')
    : '';
  const sl = o.stopLoss ? `SL ${o.stopLoss.multiple ? `${o.stopLoss.multiple}x` : `${o.stopLoss.priceSui} SUI`}` : '';
  return [tpStr, sl].filter(Boolean).join(' . ') || 'TP/SL order';
}

// -- Agent session (escrow authorization) --------------------------------------
// A user opens an AgentSession to let the agent's execution wallet trade on their
// behalf without per-trade signing: deposit SUI into escrow, set a spend cap and
// expiry, and the agent (session_address) spends up to the cap until expiry or
// until the user revokes/closes. Funds never leave the user's control beyond the
// escrow; close_session returns the unspent remainder. buy_with_session /
// sell_with_session are signed server-side by the agent wallet, not here.
const GQL_URL = 'https://graphql.testnet.sui.io/graphql';

// UNIVERSAL TRADING is SCOPED OUT of mainnet v1. It exists only to trade LEGACY
// (V4-V9) or graduated-pool curves from a session, via the borrow/settle path -
// the widest session risk envelope (a compromised key can exfiltrate up to
// remaining spend-cap headroom, per agent_session.move) and NOT needed on a
// clean mainnet where every curve launches on the current lineage and trades
// natively (buy_with_session/sell_with_session). With this false, arming a
// strategy on a lineage curve proceeds on the native path with NO prompt; a
// legacy curve is refused with a plain message instead of the deprecated
// enable-universal popup. Flip to true (and confirm the enable-tx result read)
// to bring legacy/graduated-pool session trading back for a future package.
const UNIVERSAL_TRADING_ENABLED = false;

function fmtSui(mist) {
  if (mist == null) return '-';
  const n = Number(BigInt(mist)) / 1e9;
  return n.toLocaleString(undefined, { maximumFractionDigits: 4 });
}

function AgentSessionPanel({ account, onSessionChange }) {
  const dAppKit = useDAppKit();
  const client  = useCurrentClient();

  const [session, setSession] = useState(null); // { id, sharedVersion, escrow, spent, spendCap, expiryMs, revoked }
  // Survives session=null (after close/no-session-found) so sweep_token can
  // still target the last session this wallet had, since a stuck token can
  // legitimately be discovered AFTER the SUI side has already been closed.
  const [lastSessionRef, setLastSessionRef] = useState(null); // { id, sharedVersion }
  const [loading, setLoading] = useState(true);
  const [busy, setBusy]       = useState(false);
  const [msg, setMsg]         = useState('');
  // V11 universal trading: owner opt-in flag stored as a dynamic field on the
  // session. null = unknown/loading. Read by scanning the session's dynamic
  // fields for the b"universal_trading" key (tolerant across client versions:
  // the key may render as a utf8 string, a decimal byte array, or base64).
  const [universalTrading, setUniversalTrading] = useState(null);

  useEffect(() => {
    if (!session?.id || !client) { setUniversalTrading(null); return; }
    let cancelled = false;
    (async () => {
      try {
        const res = await client.listDynamicFields({ parentId: session.id });
        const fields = res?.dynamicFields ?? res?.data ?? [];
        const SIG_UTF8  = 'universal_trading';
        const SIG_BYTES = '117,110,105,118,101,114,115,97,108,95,116,114,97,100,105,110,103';
        const SIG_B64   = 'dW5pdmVyc2FsX3RyYWRpbmc';
        const on = fields.some(f => {
          const s = JSON.stringify(f) ?? '';
          return s.includes(SIG_UTF8) || s.includes(SIG_BYTES) || s.includes(SIG_B64);
        });
        if (!cancelled) setUniversalTrading(on);
      } catch { if (!cancelled) setUniversalTrading(null); }
    })();
    return () => { cancelled = true; };
  }, [session?.id, client]);

  async function doToggleUniversal() {
    if (busy || !session || universalTrading === null) return;
    setBusy(true); setMsg('');
    try {
      const tx = new Transaction();
      const fn = universalTrading ? 'disable_universal_trading' : 'enable_universal_trading';
      const ref = session.sharedVersion
        ? tx.sharedObjectRef({ objectId: session.id, initialSharedVersion: String(session.sharedVersion), mutable: true })
        : tx.object(session.id);
      tx.moveCall({ target: `${PACKAGE_ID}::agent_session::${fn}`, arguments: [ref] });
      const res = await dAppKit.signAndExecuteTransaction({ transaction: tx });
      if (res.FailedTransaction) throw new Error(res.FailedTransaction.status.error ?? 'Toggle failed');
      setUniversalTrading(!universalTrading);
      setMsg(!universalTrading
        ? 'Universal trading ENABLED - the agent can now trade legacy-version tokens from this session.'
        : 'Universal trading disabled - the agent is restricted to current-version tokens.');
    } catch (e) { setMsg(e.message || 'Toggle failed'); }
    finally { setBusy(false); }
  }


  // Open/top-up form
  const [depositSui, setDepositSui] = useState('1');
  const [capSui, setCapSui]         = useState('5');
  const [days, setDays]             = useState('7');
  const [now, setNow]               = useState(Date.now());

  // Signing-key mode for NEW sessions. TURNKEY (default): per-session key in
  // Turnkey's TEE, operator-attested, always available. ENCLAVE (Nautilus):
  // key born in a Nitro enclave and CHAIN-attested via
  // open_and_share_attested - selectable only while the bridge reports a live
  // enclave signer (ENCLAVE_SIGNER_URL set); greyed out otherwise so users
  // can never pick a mode that cannot sign.
  const [signerMode, setSignerMode] = useState('turnkey');
  const [enclaveAvailable, setEnclaveAvailable] = useState(false);

  useEffect(() => {
    let dead = false;
    (async () => {
      try {
        // Bridge /health is POST-only (GET returns 405) and reports a flat
        // { enclave: boolean } - enclaveConfigured() means ENCLAVE_SIGNER_URL
        // is set on Render, i.e. a live enclave signer exists. Missing or
        // unreachable => unavailable: the safe default is the ENCLAVE option
        // greying out, never a session that cannot sign.
        const r = await fetch(`${BRIDGE_URL}/health`, { method: 'POST', signal: AbortSignal.timeout(8000) });
        const h = await r.json().catch(() => ({}));
        if (!dead) setEnclaveAvailable(h?.enclave === true);
      } catch { /* bridge unreachable - leave enclave mode greyed */ }
    })();
    return () => { dead = true; };
  }, []);

  useEffect(() => {
    if (!enclaveAvailable && signerMode === 'enclave') setSignerMode('turnkey');
  }, [enclaveAvailable, signerMode]);

  // Resolve the user's most-recent session object by reading SessionOpened
  // events for this owner, then fetching that object's live state on-chain.
  const loadSession = useCallback(async () => {
    if (!account) { setSession(null); setLoading(false); return; }
    setLoading(true);
    try {
      const INDEXER_URL = import.meta.env.VITE_INDEXER_URL || '';

      // Fast path: ask the indexer (one Postgres-backed request) instead of
      // scanning the last 50 SessionOpened events live via GraphQL. If the
      // indexer has no record yet (fresh session not backfilled/streamed
      // through, or the indexer is unreachable), fall back to the original
      // live GraphQL scan so a brand-new session is still discoverable.
      const idxData = INDEXER_URL
        ? await fetch(`${INDEXER_URL}/agent/session?owner=${account.address}`, { signal: AbortSignal.timeout(5000) })
            .then(r => r.ok ? r.json() : null)
            .catch(() => null)
        : null;

      let sessionId = idxData?.sessionId ?? null;
      let latest = null; // only populated if the fallback GraphQL path runs

      if (!sessionId) {
        // Event TYPES keep the lineage's DEFINING package id (V10) even when
        // emitted by upgraded (V11+) code -- PACKAGE_ID is the WRITE target
        // and moves with each upgrade, so it must not be used for event scans.
        const evType = `${PACKAGE_ID_V10}::agent_session::SessionOpened`;
        const q = `{ events(filter: { type: "${evType}" }, last: 50) { nodes { contents { json } } } }`;
        const r = await fetch(GQL_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: q }),
          signal: AbortSignal.timeout(8000),
        });
        const d = await r.json();
        const nodes = d?.data?.events?.nodes ?? [];
        const mine = nodes
          .map(n => n.contents?.json)
          .filter(j => j && (j.owner ?? '').toLowerCase() === account.address.toLowerCase());
        latest = mine.length ? mine[mine.length - 1] : null;
        sessionId = latest?.session_id ?? null;
      }

      if (!sessionId) { setSession(null); setLoading(false); return; }

      // This browser already closed this session - do not resurrect it. (The
      // object survives close on-chain, so discovery keeps returning it.)
      if (closedSessionIds().includes(sessionId)) { setSession(null); setLoading(false); return; }

      // Live object read - the chain is the source of truth for session state.
      // v2 SuiGraphQLClient shape: include:{json:true} puts the Move struct
      // fields at obj.object.json, and the owner at obj.object.owner (the old
      // code used the JSON-RPC options:{showContent} shape here, so fields
      // always parsed to {} - escrow showed "-", revoked read false, and the
      // badge said ACTIVE forever; same shape-class bug fixed in claim).
      const obj = await client.getObject({ objectId: sessionId, include: { json: true } })
        .catch(() => null);

      // No object on-chain => the session was CLOSED (close_session consumes
      // it). A stale indexer/event id must NOT resurrect it as a ghost ACTIVE
      // session - treat as "no session" so the open-a-new-session form shows.
      if (!obj?.object) { setSession(null); setLoading(false); return; }

      const fields = obj.object.json ?? {};
      const sharedVersion = obj.object.owner?.Shared?.initialSharedVersion
        ?? latest?.__sharedVersion
        ?? null;

      // Live fields win; indexer values are the fallback. The indexer cannot
      // know `revoked` at all (revoke_session emits no event), and its escrow
      // has the documented SessionBuy gap - the object's own state has neither
      // problem. Balance<SUI> may render as {value:"..."} or a bare string in
      // GraphQL json; tolerate both.
      const escrowRaw = (fields.escrow && typeof fields.escrow === 'object')
        ? fields.escrow.value : fields.escrow;
      const revoked = fields.revoked === true || fields.revoked === 'true'
        || (fields.revoked == null && !!idxData?.revoked);
      const escrowVal    = escrowRaw            ?? idxData?.escrow   ?? null;
      const spentVal     = fields.spent         ?? idxData?.spent    ?? '0';
      const spendCapVal  = fields.spend_cap     ?? idxData?.spendCap ?? latest?.spend_cap ?? '0';
      const expiryVal    = fields.expiry_ms     ?? idxData?.expiryMs ?? latest?.expiry_ms ?? 0;

      setLastSessionRef({ id: sessionId, sharedVersion });

      // Dead-state rule: a revoked or expired session with a drained escrow is
      // finished - it can never trade and there is nothing left to withdraw.
      // Showing it would block opening a new session (the open form only
      // renders when no session is set). lastSessionRef stays set above so the
      // STUCK TOKENS sweep remains reachable for it.
      const expiredNow = Number(expiryVal ?? 0) > 0 && Date.now() >= Number(expiryVal);
      const deadAndEmpty = (revoked || expiredNow) && Number(escrowVal ?? 0) <= 0;
      if (deadAndEmpty) { setSession(null); setLoading(false); return; }

      // A5.2 - custody visibility. The session's on-chain session_address is the
      // ONLY address that can sign its trades. When it equals the shared agent
      // wallet, this session signs via the SHARED keypair (Turnkey-mode fallback,
      // or a legacy open) rather than a per-user enclave/Turnkey key - a weaker
      // custody statement the user should be able to SEE. Read it here so the
      // badge is accurate and survives a refresh (not just the open flow).
      const sessAddr = typeof fields.session_address === 'string' ? fields.session_address.toLowerCase() : null;
      const isSharedWallet = sessAddr != null && sessAddr === AGENT_SESSION_WALLET.toLowerCase();

      setSession({
        id:            sessionId,
        sharedVersion,
        escrow:        escrowVal != null ? String(escrowVal) : null,
        spent:         spentVal != null ? String(spentVal) : '0',
        spendCap:      spendCapVal != null ? String(spendCapVal) : '0',
        expiryMs:      Number(expiryVal ?? 0),
        revoked,
        sessionAddress: sessAddr,
        isSharedWallet,
      });
    } catch (e) {
      // Degrade to "no session" rather than blocking the open flow.
      setSession(null);
    } finally {
      setLoading(false);
    }
  }, [account, client]);

  useEffect(() => { loadSession(); }, [loadSession]);
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);

  // Report the active, spendable session id up to AgentPage so strategy
  // arm-payloads can bind an order to it. A revoked or expired session is
  // reported as null -- it exists but a bridge /session-buy /session-sell
  // against it would fail on-chain, so orders should not be tagged with it.
  useEffect(() => {
    if (!onSessionChange) return;
    const expired = session && session.expiryMs > 0 && Date.now() >= session.expiryMs;
    const usable = session && !session.revoked && !expired ? session.id : null;
    onSessionChange(usable);
  }, [session, onSessionChange]);

  async function doOpen() {
    if (busy || !account) return;
    const dep = parseFloat(depositSui), cap = parseFloat(capSui), dd = parseFloat(days);
    if (!(dep > 0)) { setMsg('Enter a deposit amount'); return; }
    if (!(dd > 0)) { setMsg('Enter an expiry in days'); return; }
    setBusy(true); setMsg('');
    try {
      // Per-user enclave key (Phase 1 trust minimization). Ask the bridge to
      // provision a fresh Turnkey-held key for THIS session; its address goes
      // on-chain as session_address, so only that enclave key can ever sign
      // this session's trades - isolated from the shared agent wallet and from
      // every other user's session. If provisioning is unavailable (Turnkey
      // not configured yet, bridge down, timeout), fall back to the shared
      // agent wallet so opening a session NEVER breaks; the on-chain caps
      // (spend cap / expiry / revoke) protect the user on both paths.
      let sessionAddress = AGENT_SESSION_WALLET;
      let enclaveKey = false;   // per-session Turnkey-held key provisioned
      let attested = false;     // Nautilus: chain-attested enclave key
      try {
        setMsg(signerMode === 'enclave'
          ? 'Requesting the chain-attested enclave signing key...'
          : 'Provisioning a dedicated enclave signing key...');
        const pr = await fetch('/api/create-session-key', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          // skipGasFunding: the owner's open PTB below grants the session its
          // gas, so the bridge must NOT spend its treasury (self-funded flow).
          body: JSON.stringify({ ownerAddress: account.address, mode: signerMode, skipGasFunding: true }),
          signal: AbortSignal.timeout(30000),
        });
        const pd = await pr.json().catch(() => ({}));
        if (pr.ok && pd.ok !== false && pd.configured !== false
            && typeof pd.sessionAddress === 'string' && pd.sessionAddress.startsWith('0x')) {
          sessionAddress = pd.sessionAddress;
          enclaveKey = true;
          attested = signerMode === 'enclave';
        } else {
          // A5.1 loud fallback: provisioning responded but did NOT yield a
          // per-user key (Turnkey/DB not configured, or an unexpected shape).
          // In turnkey mode this silently downgrades to the shared wallet -
          // exactly the "looks like success" class that bit us. Make it visible.
          console.warn('[agent] session key provisioning did not return a dedicated key; ' +
            (signerMode === 'enclave' ? 'enclave mode will hard-fail below' : 'TURNKEY mode falling back to the SHARED agent wallet'),
            { status: pr.status, reason: pd?.reason ?? pd?.error ?? null, configured: pd?.configured });
        }
      } catch (e) {
        // A5.1 loud fallback: provisioning unreachable (bridge down / timeout).
        // Same silent-downgrade risk in turnkey mode - warn loudly.
        console.warn('[agent] session key provisioning unreachable; ' +
          (signerMode === 'enclave' ? 'enclave mode will hard-fail below' : 'TURNKEY mode falling back to the SHARED agent wallet'),
          e?.message ?? e);
      }

      // ENCLAVE mode is an explicit trust upgrade the user selected: NEVER
      // silently downgrade it to the shared wallet (that would hand back the
      // exact trust claim they asked to remove). TURNKEY mode keeps the
      // always-works shared-wallet fallback; on-chain caps protect both.
      if (signerMode === 'enclave' && !attested) {
        throw new Error('Enclave key unavailable - the enclave signer may be offline. Retry, or open in TURNKEY mode.');
      }

      const depMist = BigInt(Math.round(dep * 1e9));
      const capMist = BigInt(Math.round((cap > 0 ? cap : 0) * 1e9)); // 0 = unbounded
      const expiryMs = BigInt(Date.now() + Math.round(dd * 24 * 60 * 60 * 1000));
      const tx = new Transaction();
      const [coin] = tx.splitCoins(tx.gas, [tx.pure.u64(depMist)]);
      // Self-funded gas grant: only when a DEDICATED session key was
      // provisioned (a fresh address holds zero SUI and pays its own gas per
      // trade). The shared-wallet fallback carries its own gas - no grant.
      // For the enclave's single shared address this is a harmless top-up.
      if (enclaveKey) {
        const [gasGrant] = tx.splitCoins(tx.gas, [tx.pure.u64(SESSION_GAS_GRANT_MIST)]);
        tx.transferObjects([gasGrant], sessionAddress);
      }
      if (attested) {
        // V12 Nautilus path: the CHAIN verifies session_address is a key the
        // EnclaveRegistry approved (aborts with err 12 EKeyNotAttested
        // otherwise). The registry is a shared object, read immutably.
        tx.moveCall({
          target: `${PACKAGE_ID}::agent_session::open_and_share_attested`,
          arguments: [
            coin,
            tx.pure.address(sessionAddress),
            tx.pure.u64(capMist),
            tx.pure.u64(expiryMs),
            tx.object(ENCLAVE_REGISTRY_ID),
          ],
        });
      } else {
        tx.moveCall({
          target: `${PACKAGE_ID}::agent_session::open_and_share`,
          arguments: [
            coin,
            tx.pure.address(sessionAddress),
            tx.pure.u64(capMist),
            tx.pure.u64(expiryMs),
          ],
        });
      }
      const res = await dAppKit.signAndExecuteTransaction({ transaction: tx });
      if (res.FailedTransaction) {
        const raw = res.FailedTransaction.status?.error;
        const errStr = typeof raw === 'string' ? raw : JSON.stringify(raw ?? {});
        // err 12 EKeyNotAttested: the enclave restarted since its key was
        // registered (keys die with the instance by design), so the address
        // the bridge handed out is no longer the registered one.
        if (/EKeyNotAttested/i.test(errStr)
            || (/abort/i.test(errStr) && /agent_session/i.test(errStr) && /(\D|^)12(\D|$)/.test(errStr))) {
          throw new Error('The enclave key is not registered on-chain - the enclave likely restarted since registration. Re-register its key, or open in TURNKEY mode.');
        }
        throw new Error(errStr || 'Open failed');
      }
      setMsg(attested
        ? 'Session opened with a CHAIN-ATTESTED enclave key - Sui itself verified the signer is enclave-held (Nautilus). Gas grant (0.5 SUI) funded from your wallet.'
        : enclaveKey
          ? 'Session opened with a dedicated enclave key - trades are signed inside a secure enclave, isolated per session. Gas grant (0.5 SUI) funded from your wallet.'
          : 'Session opened - the agent can now trade your escrow.');
      setTimeout(loadSession, 1500);
    } catch (e) { setMsg(e.message || 'Open failed'); }
    finally { setBusy(false); }
  }

  const sessionRef = (tx, mutable) => (session?.sharedVersion
    ? tx.sharedObjectRef({ objectId: session.id, initialSharedVersion: String(session.sharedVersion), mutable })
    : tx.object(session.id));

  async function doTopUp() {
    if (busy || !session) return;
    const dep = parseFloat(depositSui);
    if (!(dep > 0)) { setMsg('Enter a top-up amount'); return; }
    setBusy(true); setMsg('');
    try {
      const depMist = BigInt(Math.round(dep * 1e9));
      const tx = new Transaction();
      const [coin] = tx.splitCoins(tx.gas, [tx.pure.u64(depMist)]);
      tx.moveCall({
        target: `${PACKAGE_ID}::agent_session::top_up_session`,
        arguments: [sessionRef(tx, true), coin],
      });
      const res = await dAppKit.signAndExecuteTransaction({ transaction: tx });
      if (res.FailedTransaction) throw new Error(res.FailedTransaction.status.error ?? 'Top-up failed');
      setMsg('Escrow topped up.');
      setTimeout(loadSession, 1500);
    } catch (e) { setMsg(e.message || 'Top-up failed'); }
    finally { setBusy(false); }
  }

  async function doRevoke() {
    if (busy || !session) return;
    setBusy(true); setMsg('');
    try {
      const tx = new Transaction();
      tx.moveCall({
        target: `${PACKAGE_ID}::agent_session::revoke_session`,
        arguments: [sessionRef(tx, true)],
      });
      const res = await dAppKit.signAndExecuteTransaction({ transaction: tx });
      if (res.FailedTransaction) throw new Error(res.FailedTransaction.status.error ?? 'Revoke failed');
      setMsg('Session revoked - the agent can no longer spend. Close to withdraw escrow.');
      setTimeout(loadSession, 1500);
    } catch (e) { setMsg(e.message || 'Revoke failed'); }
    finally { setBusy(false); }
  }

  // Enumerate the token types parked on a session as dynamic object fields
  // (Coin<T> keyed by TypeName - see park_tokens in agent_session.move). Move
  // CANNOT iterate dynamic fields on-chain, so close_session can never sweep
  // unknown types itself; this OFF-CHAIN enumeration is what lets one PTB
  // sweep everything at close. Tolerant parsing, same policy as the
  // universal_trading scan above: depending on client version the entry may
  // surface the full Coin<T> object type or only the TypeName key (no 0x).
  async function listParkedTokenTypes(sessionId) {
    const res = await client.listDynamicFields({ parentId: sessionId });
    const fields = res?.dynamicFields ?? res?.data ?? [];
    const types = new Set();
    for (const f of fields) {
      const s = JSON.stringify(f) ?? '';
      if (s.includes('universal_trading') || s.includes('dW5pdmVyc2FsX3RyYWRpbmc')) continue;
      const m = s.match(/Coin<(0x[0-9a-fA-F]+::[A-Za-z0-9_]+::[A-Za-z0-9_]+)>/);
      if (m) { types.add(m[1]); continue; }
      // TypeName KEY fallback (renders without 0x). Guard against the field's
      // own plumbing types leaking in as "parked tokens" - 0x1::type_name::
      // TypeName and 0x2::dynamic_object_field::Wrapper render with 64-char
      // ZERO-PADDED addresses in some client versions, and one garbage
      // sweep_token<T> would abort the whole atomic sweep PTB. Stripping
      // leading zeros and requiring 16+ significant hex digits excludes every
      // framework short id (0x1/0x2/0x3); the module blocklist catches the
      // rest. Short-form addresses parse identically on Sui.
      const all = [...s.matchAll(/(?:0x)?0*([1-9a-fA-F][0-9a-fA-F]{15,})::([A-Za-z_][A-Za-z0-9_]*)::([A-Za-z_][A-Za-z0-9_]*)/g)];
      for (const mm of all) {
        const mod = mm[2];
        if (mod === 'type_name' || mod === 'dynamic_object_field' || mod === 'dynamic_field'
            || mod === 'coin' || mod === 'balance' || mod === 'agent_session' || mod === 'bonding_curve') continue;
        types.add(`0x${mm[1]}::${mm[2]}::${mm[3]}`);
      }
    }
    return [...types];
  }

  async function doClose() {
    if (busy || !session) return;
    setBusy(true); setMsg('');
    try {
      // EVERYTHING to the owner in ONE atomic transaction: enumerate the
      // parked token types off-chain, then compose sweep_token<T> per type +
      // close_session in a single PTB (one signature). sweep_token transfers
      // each Coin<T> to the owner internally; the escrow refund is transferred
      // explicitly. If enumeration fails we still close - parked tokens stay
      // recoverable any time via the STUCK TOKENS sweep below (the shared
      // object survives close: expiry_ms == 0 sentinel, and sweep_token has
      // no closed-state assert).
      let parked = [];
      try { parked = await listParkedTokenTypes(session.id); } catch { /* recoverable later */ }
      const tx = new Transaction();
      const ref = sessionRef(tx, true);
      for (const t of parked) {
        tx.moveCall({
          target: `${PACKAGE_ID}::agent_session::sweep_token`,
          typeArguments: [t],
          arguments: [ref],
        });
      }
      const [refund] = tx.moveCall({
        target: `${PACKAGE_ID}::agent_session::close_session`,
        arguments: [ref],
      });
      tx.transferObjects([refund], account.address);
      const res = await dAppKit.signAndExecuteTransaction({ transaction: tx });
      if (res.FailedTransaction) throw new Error(res.FailedTransaction.status.error ?? 'Close failed');
      rememberClosedSession(session.id);
      // Best-effort leftover-gas sweep: the session's dedicated key still holds
      // the unburned remainder of its self-funded gas grant, and only that key
      // can move it. The bridge signs one final transfer back to this wallet
      // (owner-directed on the bridge side). Never blocks the close - a failed
      // or dust-skipped sweep just omits the note.
      let sweepNote = '';
      try {
        const sweepBody = { sessionId: session.id };
        const sweepAuth = await signOwnerAuth('sweep-session-gas', sweepBody);
        const sr = await fetch('/api/sweep-session-gas', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...sweepBody, ...sweepAuth }),
          signal: AbortSignal.timeout(30000),
        });
        const sd = await sr.json().catch(() => ({}));
        if (sr.ok && sd.swept === true && sd.sweptMist) {
          sweepNote = ` Leftover gas (${(Number(sd.sweptMist) / 1e9).toFixed(4)} SUI) swept back to your wallet.`;
        }
      } catch { /* non-fatal */ }
      setMsg(`Session closed - unspent escrow${parked.length > 0 ? ` and ${parked.length} parked token type${parked.length > 1 ? 's' : ''}` : ''} returned to your wallet.` + sweepNote);
      setSession(null);
      setTimeout(loadSession, 1500);
    } catch (e) { setMsg(e.message || 'Close failed'); }
    finally { setBusy(false); }
  }

  // sweep_token<T> recovers any tokens still parked on the session (from a prior
  // buy_with_session that was never sold back before revoke/expiry/close). It is
  // owner-gated on-chain but does NOT touch the SUI escrow, so it is a SEPARATE
  // action from close/revoke -- a user may need this even after already closing.
  // The contract has no way to enumerate which token types are parked (dynamic
  // object fields aren't queryable that way), so the user supplies the
  // coin type of the token they believe is stuck; a wrong guess simply aborts
  // on-chain with no funds at risk.
  // Optional narrowing: with an id here, SWEEP ALL targets just that session;
  // left empty, it discovers and sweeps EVERY session this wallet opened.
  // Safe by construction: sweep_token is owner-gated on-chain, so a wrong or
  // foreign id simply aborts (ENotOwner) with no funds at risk.
  const [sweepSession, setSweepSession] = useState('');

  // SWEEP ALL: "all" means ALL SESSIONS. With the id field empty, discover
  // every AgentSession this wallet ever opened (SessionOpened events define
  // under V10; V11/V12 code keeps emitting the V10-typed name, so one query
  // covers the whole lineage), probe each for parked Coin<T> dynamic fields,
  // and sweep everything in ONE transaction. Pasting an id narrows to that
  // session. Owner-gated on-chain (sweep_token), so the scan can only ever
  // return this wallet's own funds. Testnet-scale event read (last 200 via
  // GraphQL, up to 20 sessions probed); mainnet moves discovery behind an
  // indexer route.
  async function discoverMySessions() {
    // Mainnet path: the indexer's /agent/sessions route -- SessionOpened is
    // synced into its events table and owner-indexed, so history depth is not
    // capped by chain-RPC event pagination. The direct GraphQL scan below
    // stays as the FALLBACK so token recovery never depends on our own infra
    // being up.
    try {
      const r = await fetch(`${INDEXER_URL}/agent/sessions?owner=${account.address}`, { signal: AbortSignal.timeout(8000) });
      if (r.ok) {
        const rows = await r.json();
        if (Array.isArray(rows) && rows.length > 0) {
          return [...new Set(rows.map(x => x.session_id).filter(Boolean))].slice(0, 50);
        }
      }
    } catch { /* indexer unreachable - fall through to the chain scan */ }
    const evType = `${PACKAGE_ID_V10}::agent_session::SessionOpened`;
    const q = `{ events(filter: { type: "${evType}" }, last: 200) { nodes { contents { json } } } }`;
    const r = await fetch(GQL_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: q }), signal: AbortSignal.timeout(10000),
    });
    const d = await r.json();
    return [...new Set((d?.data?.events?.nodes ?? [])
      .map(n => n.contents?.json)
      .filter(j => j && (j.owner ?? '').toLowerCase() === account.address.toLowerCase())
      .map(j => j.session_id)
      .filter(Boolean))].slice(0, 20);
  }

  async function doSweepAll() {
    if (busy || !account) return;
    setBusy(true); setMsg('');
    try {
      // Build the target list: one explicit session, or every discovered one.
      const overrideId = sweepSession.trim();
      let sessionIds;
      if (overrideId) {
        if (!/^0x[0-9a-fA-F]+$/.test(overrideId)) throw new Error('Session id must be a 0x... object id');
        sessionIds = [overrideId];
      } else {
        setMsg('Finding your sessions...');
        sessionIds = await discoverMySessions();
        // The event scan can lag a just-opened session - make sure the last
        // session this tab knows about is always covered.
        if (lastSessionRef?.id && !sessionIds.includes(lastSessionRef.id)) sessionIds.push(lastSessionRef.id);
        if (sessionIds.length === 0) throw new Error('No sessions found for this wallet');
      }

      // Probe each session for parked tokens and resolve its shared version.
      // Parallel in bounded batches: 50 sessions sequentially would be a long
      // wait; unbounded parallelism hammers the RPC.
      setMsg(`Scanning ${sessionIds.length} session${sessionIds.length > 1 ? 's' : ''} for parked tokens...`);
      const targets = [];
      const CHUNK = 5;
      for (let i = 0; i < sessionIds.length; i += CHUNK) {
        const settled = await Promise.allSettled(sessionIds.slice(i, i + CHUNK).map(async (sid) => {
          const types = await listParkedTokenTypes(sid);
          if (types.length === 0) return null;
          const obj = await client.getObject({ objectId: sid });
          const sv = obj?.object?.owner?.Shared?.initialSharedVersion;
          if (!sv) return null;
          return { id: sid, sharedVersion: sv, types };
        }));
        for (const s of settled) if (s.status === 'fulfilled' && s.value) targets.push(s.value);
      }
      if (targets.length === 0) {
        setMsg(overrideId ? 'No parked tokens found on that session.' : 'No parked tokens found on any of your sessions.');
        return;
      }

      // ONE PTB, one signature: sweep_token<T> per parked type per session.
      // Each coin is transferred to the owner inside sweep_token itself.
      const tx = new Transaction();
      let n = 0;
      for (const t of targets) {
        const ref = tx.sharedObjectRef({ objectId: t.id, initialSharedVersion: String(t.sharedVersion), mutable: true });
        for (const ct of t.types) {
          tx.moveCall({
            target: `${PACKAGE_ID}::agent_session::sweep_token`,
            typeArguments: [ct],
            arguments: [ref],
          });
          n++;
        }
      }
      const res = await dAppKit.signAndExecuteTransaction({ transaction: tx });
      if (res.FailedTransaction) throw new Error(res.FailedTransaction.status.error ?? 'Sweep failed');
      setMsg(`Swept ${n} token balance${n > 1 ? 's' : ''} from ${targets.length} session${targets.length > 1 ? 's' : ''} - everything sent to your wallet.`);
    } catch (e) { setMsg(e.message || 'Sweep failed'); }
    finally { setBusy(false); }
  }

  if (!account) return null;

  const expired = session && session.expiryMs > 0 && now >= session.expiryMs;
  const capLabel = session
    ? (BigInt(session.spendCap || '0') === 0n ? 'unbounded' : `${fmtSui(session.spendCap)} SUI`)
    : '';
  const expiryLabel = (ms) => {
    if (!ms) return '-';
    const rem = ms - now;
    if (rem <= 0) return 'expired';
    const dys = Math.floor(rem / 86_400_000);
    const hrs = Math.floor((rem % 86_400_000) / 3_600_000);
    return dys > 0 ? `${dys}d ${hrs}h` : `${hrs}h`;
  };

  return (
    <div className="border border-violet-400/20 rounded-xl bg-violet-500/[0.04] p-4 mb-4 space-y-3">
      <div className="flex items-center gap-2">
        <Bot size={13} className="text-violet-400" />
        <span className="text-[10px] font-mono text-violet-300/80 tracking-widest">AGENT SESSION</span>
        {session && !session.revoked && !expired && (
          <span className="ml-auto text-[8px] font-mono text-lime-400 tracking-widest border border-lime-400/30 rounded-full px-2 py-0.5">ACTIVE</span>
        )}
        {session && (session.revoked || expired) && (
          <span className="ml-auto text-[8px] font-mono text-white/40 tracking-widest border border-white/15 rounded-full px-2 py-0.5">{expired ? 'EXPIRED' : 'REVOKED'}</span>
        )}
      </div>

      {loading ? (
        <div className="py-3 text-center text-white/20 text-[10px] font-mono">Loading...</div>
      ) : !session ? (
        <>
          <p className="text-[10px] font-mono text-white/35 leading-relaxed">
            Authorize the agent to trade a SUI escrow on your behalf - no per-trade signing.
            Set a spend cap and expiry; revoke or close anytime to reclaim unspent funds.
          </p>
          <div className="grid grid-cols-3 gap-2">
            <label className="block">
              <span className="text-[8px] font-mono text-white/30 tracking-widest">DEPOSIT (SUI)</span>
              <input value={depositSui} onChange={e => setDepositSui(e.target.value)} inputMode="decimal"
                className="mt-1 w-full bg-white/5 border border-white/10 rounded-lg px-2 py-1.5 text-xs text-white font-mono focus:outline-none focus:border-violet-400/40" />
            </label>
            <label className="block">
              <span className="text-[8px] font-mono text-white/30 tracking-widest">SPEND CAP</span>
              <input value={capSui} onChange={e => setCapSui(e.target.value)} inputMode="decimal" placeholder="0 = ∞"
                className="mt-1 w-full bg-white/5 border border-white/10 rounded-lg px-2 py-1.5 text-xs text-white font-mono focus:outline-none focus:border-violet-400/40" />
            </label>
            <label className="block">
              <span className="text-[8px] font-mono text-white/30 tracking-widest">EXPIRY (DAYS)</span>
              <input value={days} onChange={e => setDays(e.target.value)} inputMode="decimal"
                className="mt-1 w-full bg-white/5 border border-white/10 rounded-lg px-2 py-1.5 text-xs text-white font-mono focus:outline-none focus:border-violet-400/40" />
            </label>
          </div>
          <div>
            <span className="text-[8px] font-mono text-white/30 tracking-widest">SIGNING KEY</span>
            <div className="mt-1 grid grid-cols-2 gap-2">
              <button type="button" onClick={() => setSignerMode('turnkey')}
                title="Per-session key held in Turnkey's TEE; isolated from every other session"
                className={`py-1.5 rounded-lg text-[9px] font-mono tracking-widest border transition-colors ${signerMode === 'turnkey' ? 'bg-violet-500/20 text-violet-200 border-violet-400/40' : 'bg-white/5 text-white/40 border-white/10 hover:bg-white/10'}`}>
                TURNKEY
                <span className="block text-[7px] tracking-normal opacity-60 mt-0.5">per-session TEE key</span>
              </button>
              <button type="button" onClick={() => enclaveAvailable && setSignerMode('enclave')}
                disabled={!enclaveAvailable}
                title={enclaveAvailable
                  ? 'Key born inside a Nitro enclave; Sui natively verified its attestation on-chain'
                  : 'No live enclave signer right now - Turnkey secures this session instead'}
                className={`py-1.5 rounded-lg text-[9px] font-mono tracking-widest border transition-colors ${!enclaveAvailable ? 'bg-white/[0.02] text-white/15 border-white/5 cursor-not-allowed' : signerMode === 'enclave' ? 'bg-lime-400/15 text-lime-300 border-lime-400/40' : 'bg-white/5 text-white/40 border-white/10 hover:bg-white/10'}`}>
                ENCLAVE
                <span className="block text-[7px] tracking-normal opacity-60 mt-0.5">{enclaveAvailable ? 'chain-attested (Nautilus)' : 'offline'}</span>
              </button>
            </div>
          </div>
          <button onClick={doOpen} disabled={busy}
            className={`w-full py-2 rounded-lg text-[11px] font-mono tracking-widest transition-colors ${busy ? 'bg-white/5 text-white/25' : 'bg-violet-500/80 hover:bg-violet-500 text-white'}`}>
            {busy ? 'OPENING...' : 'OPEN SESSION'}
          </button>
        </>
      ) : (
        <>
          {!session.revoked && !expired && (
            <p className="text-[9px] font-mono text-violet-300/60 leading-relaxed">
              Strategies armed from here now spend this escrow, not the agent wallet.
            </p>
          )}
          <div className="grid grid-cols-3 gap-2 text-center">
            <div className="rounded-lg bg-white/[0.03] border border-white/5 py-2">
              <div className="text-[8px] font-mono text-white/30 tracking-widest">ESCROW</div>
              <div className="text-sm font-mono text-lime-400 mt-0.5">{fmtSui(session.escrow)}</div>
            </div>
            <div className="rounded-lg bg-white/[0.03] border border-white/5 py-2">
              <div className="text-[8px] font-mono text-white/30 tracking-widest">SPENT</div>
              <div className="text-sm font-mono text-white mt-0.5">{fmtSui(session.spent)}</div>
            </div>
            <div className="rounded-lg bg-white/[0.03] border border-white/5 py-2">
              <div className="text-[8px] font-mono text-white/30 tracking-widest">EXPIRES</div>
              <div className="text-sm font-mono text-white mt-0.5">{expiryLabel(session.expiryMs)}</div>
            </div>
          </div>
          <div className="text-[9px] font-mono text-white/30">Spend cap: <span className="text-white/60">{capLabel}</span></div>

          {/* A5.2 - custody visibility. Which key signs this session's trades:
              a dedicated per-user key (enclave/Turnkey, isolated) or the shared
              agent wallet (Turnkey-mode provisioning fell back, or a legacy
              open). On-chain caps/expiry/revoke protect the escrow either way,
              but the trust statement differs and the user should see it. */}
          {session.sessionAddress && (
            session.isSharedWallet ? (
              <div className="rounded-lg bg-amber-400/[0.06] border border-amber-400/20 px-2.5 py-1.5">
                <div className="text-[8px] font-mono text-amber-300/90 tracking-widest">SIGNER: SHARED AGENT WALLET</div>
                <div className="text-[8px] font-mono text-amber-200/50 leading-relaxed mt-0.5">
                  This session signs via the shared agent key, not a dedicated per-user key.
                  Your funds stay protected by the on-chain spend cap, expiry, and revoke - but
                  for isolated per-user custody, close and reopen once enclave signing is available.
                </div>
              </div>
            ) : (
              <div className="flex items-center gap-1.5 text-[8px] font-mono text-lime-400/80">
                <span className="inline-block w-1 h-1 rounded-full bg-lime-400" />
                SIGNER: DEDICATED PER-USER KEY (isolated)
              </div>
            )
          )}

          {!session.revoked && !expired && (
            <div className="flex gap-2">
              <input value={depositSui} onChange={e => setDepositSui(e.target.value)} inputMode="decimal" placeholder="SUI"
                className="w-24 bg-white/5 border border-white/10 rounded-lg px-2 py-1.5 text-xs text-white font-mono focus:outline-none focus:border-violet-400/40" />
              <button onClick={doTopUp} disabled={busy}
                className={`px-3 py-1.5 rounded-lg text-[10px] font-mono transition-colors ${busy ? 'bg-white/5 text-white/25' : 'bg-violet-500/15 text-violet-300 border border-violet-400/30 hover:bg-violet-500/25'}`}>
                TOP UP
              </button>
              <button onClick={doRevoke} disabled={busy}
                className={`px-3 py-1.5 rounded-lg text-[10px] font-mono transition-colors ${busy ? 'bg-white/5 text-white/25' : 'bg-white/5 text-white/60 border border-white/15 hover:bg-white/10'}`}>
                REVOKE
              </button>
            </div>
          )}
          {/* Universal trading (V11) - owner opt-in for legacy-version tokens.
              Scoped OUT of v1 (see UNIVERSAL_TRADING_ENABLED): hidden until a
              future package brings legacy/graduated-pool session trading back. */}
          {UNIVERSAL_TRADING_ENABLED && (
          <div className="flex items-center justify-between gap-3 py-1">
            <div className="min-w-0">
              <div className="text-[9px] font-mono text-white/50 tracking-widest">UNIVERSAL TRADING</div>
              <div className="text-[9px] font-mono text-white/25 leading-relaxed">
                Lets the agent trade tokens on older SuiPump versions from this
                session. You don't need to touch this - if a strategy targets a
                legacy-version token, we'll ask for one-tap approval right then.
                Enable it here to pre-approve, or disable anytime. Wider trade
                surface: risk is bounded by your spend cap, but coins transit
                outside the session module during each trade. Off by default.
              </div>
            </div>
            <button onClick={doToggleUniversal} disabled={busy || universalTrading === null}
              className={`shrink-0 px-3 py-1.5 rounded-lg text-[9px] font-mono tracking-widest border transition-colors ${universalTrading ? 'text-lime-400 border-lime-400/40 bg-lime-400/10 hover:bg-lime-400/20' : 'text-white/50 border-white/20 hover:text-white/80 hover:border-white/40'} disabled:opacity-40`}>
              {universalTrading === null ? '...' : universalTrading ? 'ON' : 'OFF'}
            </button>
          </div>
          )}

          <button onClick={doClose} disabled={busy}
            className={`w-full py-2 rounded-lg text-[10px] font-mono tracking-widest transition-colors ${busy ? 'bg-white/5 text-white/25' : 'bg-red-500/10 text-red-400 border border-red-400/30 hover:bg-red-500/20 hover:text-red-300'}`}>
            {busy ? 'WORKING...' : 'CLOSE & WITHDRAW ESCROW'}
          </button>
        </>
      )}

      {/* Sweep parked tokens -- independent of the SUI escrow above. Always
          reachable: parked tokens can be discovered on ANY of this wallet's
          sessions (even old, already-closed ones - paste the session id),
          since close_session does not touch parked dynamic fields. */}
      {(
        <details className="pt-1">
          <summary className="text-[9px] font-mono text-white/30 hover:text-white/50 cursor-pointer tracking-widest">
            STUCK TOKENS?
          </summary>
          <div className="mt-2 space-y-2">
            <p className="text-[9px] font-mono text-white/25 leading-relaxed">
              Tokens bought via a session are parked ON the session until sold
              back or swept - including after close/revoke/expiry. SWEEP ALL
              finds every session this wallet has opened and recovers every
              parked token in one transaction. To limit it to one session,
              paste its id below. A wrong id simply fails on-chain -- no funds
              are at risk.
            </p>
            <input value={sweepSession} onChange={e => setSweepSession(e.target.value)}
              placeholder="session id (optional - empty sweeps ALL your sessions)"
              className="w-full bg-white/5 border border-white/10 rounded-lg px-2 py-1.5 text-[11px] text-white placeholder-white/20 font-mono focus:outline-none focus:border-violet-400/40" />
            <button onClick={doSweepAll} disabled={busy}
              className={`w-full py-1.5 rounded-lg text-[10px] font-mono transition-colors ${busy ? 'bg-white/5 text-white/25 cursor-not-allowed' : 'bg-violet-500/15 text-violet-300 border border-violet-400/30 hover:bg-violet-500/25'}`}>
              SWEEP ALL PARKED TOKENS
            </button>
          </div>
        </details>
      )}

      {msg && <div className="text-[9px] font-mono text-white/40">{msg}</div>}
    </div>
  );
}

export default function AgentPage({ onBack }) {
  const account = useCurrentAccount();
  // Needed by the just-in-time universal-trading consent path (ensureUniversalIfNeeded).
  // These hooks were previously only pulled inside AgentSessionPanel; approve()
  // lives here in AgentPage, so without these the helper referenced an
  // undefined `client`/`dAppKit` and crashed the whole page on load.
  const dAppKit = useDAppKit();
  const client  = useCurrentClient();
  const navigate = useNavigate();

  // Reported by AgentSessionPanel below -- the user's active, spendable
  // AgentSession id (or null). When set, arm payloads bind the order to it so
  // the strategy brain routes that order's trades through the bridge's
  // /session-buy /session-sell (spending session escrow) instead of /buy /sell
  // (the agent wallet). See orders.js POST /orders for how it's persisted.
  const [activeSessionId, setActiveSessionId] = useState(null);

  const [goal, setGoal]         = useState('');
  const [guideOpen, setGuideOpen]     = useState(false);  // tutorial collapsed by default - page loads compact
  const [openStrategy, setOpenStrategy] = useState(null); // which accordion row is open
  const [planning, setPlanning] = useState(false);
  const [plan, setPlan]         = useState(null);
  const [error, setError]       = useState(null);

  // Ticker disambiguation: when a buy/sell/claim plan has no curve id (the user
  // named a token by ticker, not a pasted CA), we resolve via the indexer.
  // candidates = matches awaiting a pick (2+); resolvedNote = the auto-resolved
  // single match shown for confirmation (b-soft). Both cleared on re-plan.
  const [candidates, setCandidates]   = useState(null); // null = none pending; [] handled as 0
  const [resolvedNote, setResolvedNote] = useState(null); // {symbol, ...stats} for single match
  const [resolving, setResolving]     = useState(false);

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
    // Per-user view: strategies belong to the wallet that armed them. No
    // connected wallet => nothing to show (never the platform-wide firehose).
    if (!account?.address) { setOrders([]); setOrdersL(false); return; }
    const me = account.address.toLowerCase();
    try {
      const r = await fetch(`${INDEXER_URL}/orders?status=active&wallet=${encodeURIComponent(account.address)}`,
        { signal: AbortSignal.timeout(8000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = await r.json();
      // Belt over the server filter: only rows attributed to THIS wallet pass,
      // even against a stale indexer that ignores the param. Legacy ownerless
      // orders (armed before attribution existed) drop out by design.
      const all = (Array.isArray(d) ? d : [])
        .filter(o => (o.wallet ?? '').toLowerCase() === me);
      // Ids of autopilot mandates in this batch -> hide their _tp_ children.
      const autopilotIds = new Set(all.filter(o => o.type === 'autopilot').map(o => o.id));
      const visible = all.filter((o) => {
        const m = typeof o.id === 'string' && o.id.match(/^(ord_\d+_[a-z0-9]+)_tp_[0-9a-f]+$/i);
        if (m && autopilotIds.has(m[1])) return false; // autopilot child exit - folded into the autopilot row
        return true;
      });
      setOrders(visible);
    } catch (e) {
      setOrdersError(e.message || 'could not load strategies');
    } finally {
      setOrdersL(false);
    }
  }, [account?.address]);

  useEffect(() => {
    loadOrders();
    const t = setInterval(loadOrders, 15000); // light refresh; SSE not needed here
    return () => clearInterval(t);
  }, [loadOrders]);

  // Resolve tickers for autopilot ENTERED positions so the panel can show which
  // tokens were bought (curve ids -> $SYMBOL), reusing the shared tickerByCurve
  // cache. Best-effort: a failure leaves the short curve id as the fallback.
  useEffect(() => {
    const curves = [];
    for (const o of orders) {
      if (o.type === 'autopilot' && Array.isArray(o.params?.entered)) {
        for (const cid of o.params.entered) {
          if (typeof cid === 'string' && cid.startsWith('0x') && tickerByCurve[cid] === undefined) curves.push(cid);
        }
      }
    }
    if (!curves.length) return;
    let cancelled = false;
    (async () => {
      for (const cid of Array.from(new Set(curves))) {
        try {
          const r = await fetch(`${INDEXER_URL}/token/${cid}`, { signal: AbortSignal.timeout(6000) });
          if (!r.ok) continue;
          const d = await r.json();
          const sym = d?.symbol ?? d?.ticker ?? null;
          if (!cancelled && sym) setTickerByCurve(prev => ({ ...prev, [cid]: sym }));
        } catch {}
      }
    })();
    return () => { cancelled = true; };
  }, [orders]);  // tickerByCurve intentionally omitted (read-time cache; same pattern as history)

  // -- Agent action history (persistent, survives refresh) ---------------------
  // Backed by the indexer's agent_actions table via the /api/agent-actions proxy.
  // Manual fires record a row here (POST pending -> PATCH on settle/fallback);
  // autonomous fires are recorded by the strategy brain (strategy.js recordFire).
  const [history, setHistory]       = useState([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  // Read-time ticker resolution: some history rows (e.g. sniper/copytrade fires)
  // were written with no token_type, so they would show a raw curve id. When the
  // panel is open we resolve the ticker per curve from the indexer and cache it
  // by curveId so each curve is fetched once. Best-effort: a failure just leaves
  // the row showing the short curve id (the existing fallback).
  const [tickerByCurve, setTickerByCurve] = useState({});

  const loadHistory = useCallback(async () => {
    // Per-user view: the history is YOUR fires, not the platform firehose.
    if (!account?.address) { setHistory([]); return; }
    const me = account.address.toLowerCase();
    try {
      const r = await fetch(`/api/agent-actions?limit=50&wallet=${encodeURIComponent(account.address)}`,
        { signal: AbortSignal.timeout(8000) });
      if (!r.ok) return;
      const d = await r.json();
      // Belt over the server filter (see loadOrders). Legacy autonomous rows
      // stamped with the shared runner wallet drop out for everyone - they
      // were misattributed and carry no per-user meaning.
      setHistory((Array.isArray(d) ? d : [])
        .filter(a => (a.wallet ?? '').toLowerCase() === me));
    } catch { /* non-fatal */ }
  }, [account?.address]);

  useEffect(() => {
    loadHistory();
    const t = setInterval(loadHistory, 15000);
    return () => clearInterval(t);
  }, [loadHistory]);

  // When the history panel is open, resolve tickers for rows that have a curveId
  // but no token_type (so they render $TICKER instead of a raw curve id). Each
  // curve is fetched at most once. Reads the indexer's `symbol` field. The
  // in-flight set is a ref (NOT state) and tickerByCurve is intentionally NOT a
  // dependency, so marking a fetch in-flight does not retrigger this effect or
  // cancel the fetch before it resolves. Best-effort, non-blocking, never throws.
  const tickerFetching = useRef(new Set());
  useEffect(() => {
    if (!historyOpen) return;
    const need = Array.from(new Set(
      history
        .filter(a => a.curveId && !a.tokenType
          && tickerByCurve[a.curveId] === undefined
          && !tickerFetching.current.has(a.curveId))
        .map(a => a.curveId)
    ));
    if (!need.length) return;
    need.forEach(cid => tickerFetching.current.add(cid));
    (async () => {
      for (const cid of need) {
        try {
          const r = await fetch(`${INDEXER_URL}/token/${cid}`, { signal: AbortSignal.timeout(6000) });
          if (!r.ok) { tickerFetching.current.delete(cid); continue; }
          const d = await r.json();
          const sym = d.symbol
            ?? ((d.token_type ?? d.tokenType) ? shortType(d.token_type ?? d.tokenType) : null);
          if (sym) setTickerByCurve(prev => ({ ...prev, [cid]: sym }));
        } catch { /* leave unresolved -> row falls back to short curve id */ }
        finally { tickerFetching.current.delete(cid); }
      }
    })();
  }, [historyOpen, history]);  // tickerByCurve intentionally omitted (see note above)

  // Record a manual fire (returns the row id, or null on failure). Best-effort -
  // history must never block or fail a trade.
  const recordAction = useCallback(async (action) => {
    try {
      const r = await fetch(`/api/agent-actions`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(action),
      });
      const d = await r.json().catch(() => ({}));
      loadHistory();
      return d?.id ?? null;
    } catch { return null; }
  }, [loadHistory]);

  const cancelOrder = useCallback(async (id) => {
    setCancelingId(id);
    try {
      // Wallet-signed ownership proof: the server reads the order's stored
      // wallet and only cancels when this signature recovers to it.
      const cancelAuth = await signOwnerAuth('cancel-order', { id });
      const r = await fetch('/api/cancel-order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, ...cancelAuth }),
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
    setCandidates(null); setResolvedNote(null);
    setNodeState({}); setPhase('idle'); clearAnim();
    try {
      // -- A2: resolve a $ticker to a real curve id BEFORE the deterministic parsers
      // run. The parsers (parseStrategyGoal / sniper / dca) key on a 0x curve
      // address and bail on a bare "$TICKER", which previously let a goal like
      // "buy 5 sui of $Overflow and tp at 5%" fall through to the LLM, which then
      // hallucinated a launch_and_buy. By resolving the ticker up front and
      // injecting the 0x id into the goal text, the deterministic buy_then_tpsl
      // path fires correctly. parseStrategyGoal stays pure (no signature change).
      let workGoal = goal.trim();
      // Shared normalization: expand spoken amounts (half a sui, point five,
      // 1.5k, a couple) BEFORE any parser runs, so all parsers + the LLM read
      // the same digits. Pure text rewrite; intent is never changed.
      workGoal = normalizeGoalText(workGoal);
      const alreadyHasCurve = /0x[0-9a-fA-F]{4,}/.test(workGoal);
      if (!alreadyHasCurve) {
        const tk = preResolveTicker(workGoal);
        if (tk) {
          const resolved = await resolveTickerToCurve(tk);
          if (resolved === 'MULTI') {
            // 2+ matches: candidates are set; user picks, which re-triggers makePlan
            // with the chosen id injected (see chooseAndReplan). Stop here.
            setPlanning(false);
            return;
          }
          if (resolved) {
            // Inject the resolved 0x id right after the ticker so the parsers see it.
            workGoal = injectCurveId(workGoal, tk, resolved.curveId);
            setResolvedNote(resolved); // b-soft: show what got resolved
          }
          // 0 matches: leave workGoal as-is; LLM/guardrail handles it below.
        }
      }

      // Strategy goals (take-profit / stop-loss) are standing orders, not one-shot
      // workflows. Recognize them client-side so the LLM can't collapse them into
      // a plain immediate sell. If it's not a strategy, fall through to the planner.
      // Sniper is checked first: it is the most specific standing intent.
      const snipe = parseSniperGoal(workGoal);
      if (snipe) { setPlan(snipe); setPlanning(false); return; }

      const dca = parseDcaGoal(workGoal);
      if (dca) { setPlan(dca); setPlanning(false); return; }

      const copy = parseCopytradeGoal(workGoal);
      if (copy) { setPlan(copy); setPlanning(false); return; }

      const auto = parseAutopilotGoal(workGoal);
      if (auto) { setPlan(auto); setPlanning(false); return; }

      const strat = parseStrategyGoal(workGoal);
      if (strat) { setPlan(strat); setPlanning(false); return; }

      const res = await fetch('/api/agent-plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-SP-Key': import.meta.env.VITE_SP_INTERNAL_KEY ?? '' },
        body: JSON.stringify({ goal: workGoal }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Planning failed');

      // -- Guardrail: the LLM must NEVER turn a buy/sell intent into a launch. If
      // the goal has no explicit launch verb but the planner returned a launch
      // (it hallucinates "launch <unknown token>" when it can't resolve a ticker),
      // rewrite it to a buy so ticker resolution can run. A real launch requires
      // the user to actually say launch/create/deploy/mint a (new) token.
      let plan = data.plan;
      const hasLaunchVerb = /\b(launch|create|deploy|mint|make)\b[\s\S]*\b(token|coin|memecoin)\b/i.test(goal)
        || /\blaunch\b/i.test(goal);
      const hasBuyVerb = /\bbuy\b/i.test(goal);
      if ((plan?.workflow === 'launch_and_buy' || plan?.workflow === 'launch') && !hasLaunchVerb) {
        const amt = Number(plan.buy?.amountSui ?? plan.launch?.devBuySui ?? 0);
        if (hasBuyVerb && amt > 0) {
          // Reinterpret as a buy of the named token; ticker resolution fills curveId.
          plan = { workflow: 'buy', summary: `Buy ${amt} SUI`, buy: { curveId: null, amountSui: amt } };
        }
      }
      setPlan(plan);
      // If this is an existing-curve action with no curve id, the user named the
      // token by ticker. Resolve it via the indexer: 1 match -> auto-fill + show
      // a confirmation note (b-soft); 2+ -> open the picker; 0 -> leave as-is so
      // the existing "paste the CA" error fires on execute.
      await maybeResolveTicker(plan);
    } catch (err) {
      setError(err.message);
    } finally {
      setPlanning(false);
    }
  }, [goal, clearAnim]);

  // Ref mirror of makePlan so earlier-defined handlers (choosePick) can re-trigger
  // planning after a picker selection without a forward-reference.
  const makePlanRef = useRef(null);
  useEffect(() => { makePlanRef.current = makePlan; }, [makePlan]);
  // Pull a bare ticker from a goal ("$Overflow", "symbol: PEPE"). Same shape as
  // extractTickerFromGoal but usable before the plan exists.
  function preResolveTicker(g) {
    if (!g) return null;
    const dollar = g.match(/\$([a-z0-9]{1,12})\b/i);
    if (dollar) return dollar[1];
    const marked = g.match(/(?:symbol|ticker)\s*[:\-]?\s*([a-z0-9]{1,12})/i);
    if (marked) return marked[1];
    return null;
  }

  // Resolve a ticker to a single { curveId, ...stats } via the indexer.
  // Returns the match object for 1 hit, 'MULTI' (and sets candidates) for 2+,
  // or null for 0 / error (caller leaves the goal unresolved).
  async function resolveTickerToCurve(ticker) {
    try {
      const r = await fetch(`${INDEXER_URL}/search/by-symbol/${encodeURIComponent(ticker)}`, { signal: AbortSignal.timeout(6000) });
      if (!r.ok) return null;
      const matches = await r.json();
      if (!Array.isArray(matches) || matches.length === 0) return null;
      if (matches.length === 1) return matches[0];
      matches.sort((a, b) => (b.marketCapSui - a.marketCapSui) || (b.volumeSui - a.volumeSui));
      setCandidates(matches);
      return 'MULTI';
    } catch { return null; }
  }

  // Inject a resolved 0x curve id into the goal text right after the ticker token
  // so the deterministic parsers (which key on 0x) can see it. Falls back to
  // appending the id if the ticker can't be located.
  function injectCurveId(g, ticker, curveId) {
    const re = new RegExp(`\\$?${ticker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    if (re.test(g)) return g.replace(re, `${curveId}`);
    return `${g} ${curveId}`;
  }

  // A real curve id is a 0x + 64 hex address. Anything else (a "$ticker", a bare
  // word the LLM hallucinated into the slot, null) counts as UNRESOLVED.
  function isRealCurveId(v) {
    return typeof v === 'string' && /^0x[0-9a-fA-F]{64}$/.test(v.trim());
  }

  // Pull a bare ticker from the goal text ("buy 1 sui of $TEST" / "sell my TEST").
  // Mirrors the planner's symbol marker but also catches a leading $TICKER.
  function extractTickerFromGoal(g) {
    if (!g) return null;
    const dollar = g.match(/\$([a-z0-9]{1,12})\b/i);
    if (dollar) return dollar[1];
    const marked = g.match(/(?:symbol|ticker)\s*[:\-]?\s*([a-z0-9]{1,12})/i);
    if (marked) return marked[1];
    return null;
  }

  // For buy/sell/claim/tpsl/dca plans without a REAL curve id, resolve by ticker.
  async function maybeResolveTicker(p) {
    setCandidates(null); setResolvedNote(null);
    if (!p) return;
    const needsCurve = ['buy', 'sell', 'claim', 'tpsl', 'dca'].includes(p.workflow);
    if (!needsCurve) return;
    const slot = p.buy ?? p.sell ?? p.claim ?? p.tpsl ?? p.dca ?? {};
    if (isRealCurveId(slot.curveId)) return; // genuine pasted CA - nothing to do
    // Ticker comes from the goal, or from a hallucinated "$final"/"final" the LLM
    // dropped into the curveId slot. Clear that bad value so the slot is null.
    const ticker = extractTickerFromGoal(goal)
      ?? (typeof slot.curveId === 'string' ? slot.curveId.replace(/^\$/, '').trim() : null);
    clearBadCurveId();
    if (!ticker) return; // no ticker either - execute() will throw the CA error
    try {
      setResolving(true);
      const r = await fetch(`${INDEXER_URL}/search/by-symbol/${encodeURIComponent(ticker)}`, { signal: AbortSignal.timeout(6000) });
      if (!r.ok) return;
      const matches = await r.json();
      if (!Array.isArray(matches) || matches.length === 0) return; // 0 -> CA error later
      if (matches.length === 1) {
        applyCurveToPlan(matches[0].curveId);
        setResolvedNote(matches[0]); // b-soft: show what got resolved
      } else {
        // Strongest first so the obvious pick is on top: mcap, then volume.
        matches.sort((a, b) => (b.marketCapSui - a.marketCapSui) || (b.volumeSui - a.volumeSui));
        setCandidates(matches);
      }
    } catch { /* leave plan unresolved; execute() surfaces the CA error */ }
    finally { setResolving(false); }
  }

  // Null out a non-real curveId the LLM hallucinated into the slot, so the plan
  // display shows the picker (not "$final...") and execute() won't try to use it.
  function clearBadCurveId() {
    setPlan(prev => {
      if (!prev) return prev;
      const next = { ...prev };
      for (const k of ['buy', 'sell', 'claim', 'tpsl', 'dca']) {
        if (next[k] && !isRealCurveId(next[k].curveId)) next[k] = { ...next[k], curveId: null };
      }
      return next;
    });
  }

  // Inject a chosen curve id into whichever slot the current plan uses.
  function applyCurveToPlan(curveId) {
    setPlan(prev => {
      if (!prev) return prev;
      const next = { ...prev };
      if (next.buy)   next.buy   = { ...next.buy,   curveId };
      if (next.sell)  next.sell  = { ...next.sell,  curveId };
      if (next.claim) next.claim = { ...next.claim, curveId };
      if (next.tpsl)  next.tpsl  = { ...next.tpsl,  curveId };
      if (next.dca)   next.dca   = { ...next.dca,   curveId };
      return next;
    });
  }

  // User picked a candidate from the disambiguation list.
  function choosePick(c) {
    setCandidates(null);
    setResolvedNote(c);
    // A2 case: the picker fired BEFORE a plan existed (ticker resolved up front,
    // multiple matches). There is no plan to patch yet, so inject the chosen id
    // into the goal and re-run planning so the deterministic parsers see a 0x id.
    if (!plan) {
      const tk = preResolveTicker(goal.trim());
      if (tk) {
        const injected = injectCurveId(goal.trim(), tk, c.curveId);
        if (injected !== goal) { setGoal(injected); /* makePlan re-run below */ }
        // Re-plan against the injected goal on the next tick (state set is async).
        setTimeout(() => { makePlanRef.current && makePlanRef.current(); }, 0);
        return;
      }
    }
    // Legacy case: a plan already exists (LLM planned, then ticker disambiguated).
    applyCurveToPlan(c.curveId);
  }

  // -- Runtime resolvers (browser supplies what the planner can't) -----------

  // Resolve curve -> { tokenType, packageId, sharedVersion } from the indexer.
  async function fetchCurveMeta(curveId) {
    const r = await fetch(`${INDEXER_URL}/token/${curveId}`, { signal: AbortSignal.timeout(6000) });
    if (!r.ok) throw new Error('Could not fetch curve from indexer');
    const d = await r.json();
    const tokenType = d.token_type ?? d.tokenType ?? null;
    if (!tokenType) throw new Error('Curve has no token type yet (indexer not enriched)');
    const packageId = d.package_id ?? d.packageId ?? null;
    const sharedVersion = d.initial_shared_version ?? d.initialSharedVersion ?? null;
    return { tokenType, packageId, sharedVersion };
  }

  // Resolve a sell amount. Concrete amount -> pass through. "ALL" -> whole-token
  // balance to sell, checking the connected WALLET first and then, if the wallet
  // holds none, the active session's PARKED balance (a session-bought position
  // lives inside the session object, not at the wallet - listCoins returns empty
  // for it, which is why "sell all X" used to fail with "no balance"). When the
  // position is on the session, returns { sessionId } so the settle routes to
  // /session-sell with sellAll (the bridge resolves the exact parked amount).
  async function resolveSellAmount(curveId, tokenAmount) {
    if (tokenAmount !== 'ALL' && Number(tokenAmount) > 0) {
      return { tokenAmount: Number(tokenAmount) };
    }
    if (!account?.address) throw new Error('Connect your wallet to sell ALL (need the balance)');
    const { tokenType } = await fetchCurveMeta(curveId);
    const rpc = new SuiGraphQLClient({ url: '/api/rpc' });
    const coinsRes = await rpc.listCoins({ owner: account.address, coinType: tokenType });
    const coins = coinsRes?.objects ?? coinsRes?.data ?? [];
    const atomic = coins.reduce((s, c) => s + BigInt(c.balance ?? c.coinBalance ?? 0), 0n);
    const whole = Number(atomic) / 10 ** TOKEN_DECIMALS;
    if (whole > 0) return { tokenAmount: whole };

    // Wallet holds none - check the active session's parked balance for this type.
    if (activeSessionId) {
      const want = String(tokenType).toLowerCase();
      const q = `{ object(address: "${activeSessionId}") { dynamicFields { nodes { value { __typename ... on MoveObject { contents { type { repr } json } } } } } }`;
      try {
        const r = await fetch(GQL_URL, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: q }), signal: AbortSignal.timeout(8000),
        });
        const d = await r.json();
        const nodes = d?.data?.object?.dynamicFields?.nodes ?? [];
        for (const n of nodes) {
          const c = n?.value?.contents;
          const repr = String(c?.type?.repr ?? '').toLowerCase();
          if (!repr.includes('::coin::coin<') || !repr.includes(want)) continue;
          const bal = c?.json?.balance;
          if (bal != null && BigInt(bal) > 0n) {
            // Session sell: amount is resolved on-chain by the bridge (sellAll).
            return { tokenAmount: 'ALL', sessionId: activeSessionId };
          }
        }
      } catch (e) {
        // A5.1 loud fallback: the session parked-balance read failed, so we fall
        // through to "no balance" even though the session MIGHT hold the token.
        // This silent path cost a full debug session; make it visible.
        console.warn('[agent] session parked-balance read failed; treating as no balance for this curve', e?.message ?? e);
      }
    }
    throw new Error('No token balance to sell for this curve');
  }

  // Build the { workflow, ... } payload the runner expects.
  async function buildPayload(p) {
    switch (p.workflow) {
      case 'launch_and_buy': {
        const launchFields = {
          name: p.launch.name,
          symbol: p.launch.symbol,
          description: p.launch.description || p.summary || `${p.launch.name} via SuiPump agent`,
          graduationTarget: p.launch.graduationTarget ?? 0, // default Cetus (0)
          devBuySui: p.launch.devBuySui,
          antiBotDelay: p.launch.antiBotDelay ?? 0,
        };
        const buyAmount = Number(p.buy?.amountSui ?? p.launch.devBuySui ?? 0);
        // A launch with no dev-buy is, to the user, just a launch. Route it to the
        // standalone "launch" workflow (launch_only DAG), NOT the launch_and_buy
        // combo - the combo's curve_id edge cannot carry off-chain output, so its
        // buy vertex consumes and the walk never completes. launch_only settles
        // cleanly on its own. With a real dev-buy, keep launch_and_buy.
        if (!(buyAmount > 0)) {
          return { workflow: 'launch', launch: launchFields };
        }
        return {
          workflow: 'launch_and_buy',
          launch: launchFields,
          buy: { amountSui: buyAmount },
        };
      }
      case 'launch':
        return {
          workflow: 'launch',
          launch: {
            name: p.launch.name,
            symbol: p.launch.symbol,
            description: p.launch.description || p.summary || `${p.launch.name} via SuiPump agent`,
            graduationTarget: p.launch.graduationTarget ?? 0, // default Cetus (0)
            devBuySui: p.launch.devBuySui,
            antiBotDelay: p.launch.antiBotDelay ?? 0,
          },
        };
      case 'buy':
        if (!p.buy?.curveId) throw new Error('No curve id for buy - paste the token CA in your goal');
        return { workflow: 'buy', buy: { curveId: p.buy.curveId, amountSui: p.buy.amountSui } };
      case 'sell': {
        if (!p.sell?.curveId) throw new Error('No curve id for sell - paste the token CA in your goal');
        const { tokenAmount, sessionId } = await resolveSellAmount(p.sell.curveId, p.sell.tokenAmount);
        return { workflow: 'sell', sell: { curveId: p.sell.curveId, tokenAmount, sessionId: sessionId ?? null } };
      }
      case 'claim': {
        if (!p.claim?.curveId) throw new Error('No curve id for claim - paste the token CA in your goal');
        const { tokenType } = await fetchCurveMeta(p.claim.curveId);
        return { workflow: 'claim', claim: { curveId: p.claim.curveId, tokenType } };
      }
      case 'claim_all':
        // Fan-out claim. No CA and no per-curve metadata here - the server-side
        // proxy enumerates the connected wallet's curves and resolves each
        // tokenType itself. Just carry the workflow through.
        return { workflow: 'claim_all', claimAll: {} };
      case 'alerts':
        if (!p.alerts?.curveIds?.length) throw new Error('No curve ids for alerts');
        return { workflow: 'alerts', alerts: { curveIds: p.alerts.curveIds } };
      case 'tpsl': {
        if (!p.tpsl?.curveId) throw new Error('No curve id for the strategy - paste the token CA in your goal');
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
        if (!p.buy?.curveId) throw new Error('No curve id - paste the token CA in your goal');
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
        if (!(Number(s.amountSui) > 0)) throw new Error('Sniper needs a SUI amount (e.g. "snipe 1 sui ...")');
        const hasFilter = (Array.isArray(s.creators) && s.creators.length) ||
                          (Array.isArray(s.symbols) && s.symbols.length) || !!s.nameIncludes;
        if (!hasFilter && s.all !== true) {
          throw new Error('Sniper needs a filter (creator / symbol / name) or say "every token"');
        }
        return { workflow: 'sniper', sniper: s };
      }
      case 'dca': {
        const d = p.dca ?? {};
        if (!d.curveId) throw new Error('DCA needs a curve - paste the token CA in your goal');
        if (!(Number(d.suiPerBuy) > 0)) throw new Error('DCA needs a SUI amount (e.g. "buy 5 sui ...")');
        // Resolve tokenType so a then.tpsl child can sell the right coin.
        const { tokenType } = await fetchCurveMeta(d.curveId);
        return { workflow: 'dca', dca: { ...d, tokenType } };
      }
      case 'copytrade': {
        const c = p.copytrade ?? {};
        if (!/^0x[a-fA-F0-9]{60,66}$/.test(c.targetWallet ?? '')) throw new Error('Copy-trade needs a target wallet (paste the 0x address)');
        if (!(Number(c.suiPerTrade) > 0)) throw new Error('Copy-trade needs a SUI size (e.g. "5 sui per trade")');
        // No curve to resolve - the target's curves are discovered at runtime.
        return { workflow: 'copytrade', copytrade: c };
      }
      case 'autopilot': {
        // Curve-less autonomous mandate: the brain discovers curves at runtime.
        // Validate the spend amounts and pass the params straight to the store
        // (same shape parseAutopilotGoal / the LLM planner produce).
        const a = p.autopilot ?? {};
        if (!(Number(a.perEntrySui) > 0)) throw new Error('Autopilot needs a per-entry SUI amount (e.g. "0.5 sui per entry")');
        if (!(Number(a.spendCapSui) > 0)) throw new Error('Autopilot needs a total spend cap (e.g. "3 sui total")');
        if (Number(a.spendCapSui) < Number(a.perEntrySui)) throw new Error('Autopilot spend cap must be at least one entry');
        return { workflow: 'autopilot', autopilot: a };
      }
      default:
        throw new Error(`Unknown workflow: ${p.workflow}`);
    }
  }

  // -- User-signed manual trades (buy / sell) ---------------------------------
  // A MANUAL trade belongs to the USER: it must be signed by their connected
  // wallet, spend their SUI, and deliver tokens/proceeds to THEIR address - the
  // same custody rule the agent sessions already follow (each user owns their
  // own trades). The bridge's /buy /sell sign with the SHARED agent keypair and
  // send everything to the agent wallet; those are ONLY for the autonomous agent,
  // never for a user's manual trade. Routing a manual buy through /buy sent the
  // user's bought tokens to the shared agent wallet - the bug this replaces.
  //
  // Mainnet curves are all V10-lineage (V10/V11/V12 share the V10 defining pkg
  // and use the V9+ buy shape + V7+ sell shape), so we build that shape directly,
  // mirroring the bridge's proven executeBuy/handleSell PTBs. A non-lineage
  // (legacy V4-V9) curve is refused here rather than silently mis-signed - legacy
  // manual trading is out of scope for v1 (same call as universal trading).
  function isLineagePkg(pkg) {
    return pkg === PACKAGE_ID_V10 || pkg === PACKAGE_ID_V11 || pkg === PACKAGE_ID_V12;
  }

  async function suiPriceScaledArg() {
    // Oracle price for the V9+ buy() (u64 scaled x1000). Fallback 0 -> stored BASE_GRAD.
    try {
      const pr = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=SUIUSDT', { signal: AbortSignal.timeout(2000) });
      if (pr.ok) { const pd = await pr.json(); const p = parseFloat(pd.price ?? '0'); if (p > 0) return BigInt(Math.floor(p * 1000)); }
    } catch { /* fall through */ }
    return 0n;
  }

  // userBuy - user-wallet-signed buy on a V10-lineage curve. Splits payment from
  // the user's gas coin, calls bonding_curve::buy (V9+ shape), transfers the
  // bought tokens + refund to the USER. Returns the tx digest.
  async function userBuy({ curveId, amountSui }) {
    if (!account?.address) throw new Error('Connect your wallet to buy');
    const { tokenType, packageId, sharedVersion } = await fetchCurveMeta(curveId);
    if (!packageId || !sharedVersion) throw new Error('Curve not resolvable yet (indexer not enriched)');
    if (!isLineagePkg(packageId)) throw new Error('This token is on an older curve version that manual trading does not support in this release. Pick a current-version token.');

    const suiMist = BigInt(Math.floor(parseFloat(amountSui) * Number(MIST_PER_SUI)));
    if (suiMist <= 0n) throw new Error('Buy amount must be > 0');
    const suiPriceScaled = await suiPriceScaledArg();

    const tx = new Transaction();
    // Match TokenPage's proven curveRef construction exactly: raw ISV (no
    // String() wrapper - the SuiGrpcClient-backed wallet build is sensitive to
    // it), with a tx.object fallback when ISV is unresolved.
    const curveRef = sharedVersion
      ? tx.sharedObjectRef({ objectId: curveId, initialSharedVersion: sharedVersion, mutable: true })
      : tx.object(curveId);
    const [payment] = tx.splitCoins(tx.gas, [tx.pure.u64(suiMist)]);
    // V9+: buy(curve, payment, min_out, referral, sui_price_scaled, clock) -> (Coin<T>, Coin<SUI>)
    // Clock is passed via tx.object(0x6) - the SDK resolves it. (tx.sharedObjectRef
    // for the clock produced a malformed input that made the wallet SDK throw
    // "reading 'txSignatures'" AFTER signing. TokenPage's working buy uses tx.object.)
    const [tokens, refund] = tx.moveCall({
      target: `${packageId}::bonding_curve::buy`,
      typeArguments: [tokenType],
      arguments: [curveRef, payment, tx.pure.u64(0), tx.pure.option('address', null), tx.pure.u64(suiPriceScaled), tx.object(AGENT_SUI_CLOCK_ID)],
    });
    tx.transferObjects([tokens, refund], account.address);

    // Build -> wallet-sign -> execute, the SAME pattern the autonomous paths use
    // (useDCA / useLimitOrder / turnkey_signer): build the tx to bytes against a
    // client, get the signature, execute via the client. This is what avoids the
    // Slush "reading 'txSignatures'" crash: signAndExecuteTransaction makes the
    // WALLET build/serialize the tx itself (its SuiGrpcClient-backed build chokes
    // on the shared-object refs and throws inside dapp-interface.js), whereas
    // signTransaction just signs already-built bytes. tx.setSender is required so
    // the build can resolve gas for the connected wallet.
    tx.setSender(account.address);
    const execClient = new SuiGraphQLClient({ url: '/api/rpc' });
    let digest = null;
    try {
      const built = await tx.build({ client: execClient });
      const { signature } = await dAppKit.signTransaction({ transaction: tx });
      const res = await execClient.executeTransaction({ transaction: built, signatures: [signature] });
      if (res?.errors) throw new Error(Array.isArray(res.errors) ? (res.errors[0]?.message ?? JSON.stringify(res.errors)) : String(res.errors));
      digest = res?.digest ?? res?.data?.executeTransaction?.digest ?? res?.Transaction?.digest ?? null;
    } catch (e) {
      const msg = String(e?.message ?? e);
      if (/txSignatures/.test(msg)) throw new Error('Wallet returned an unexpected response after signing (the buy may have gone through - check your balance/history). If it did not, retry.');
      throw e;
    }
    return digest;
  }

  // userSell - user-wallet-signed sell on a V10-lineage curve. Sources the user's
  // own coins of the type (merges them), sells the whole balance (ALL) or an exact
  // amount, and transfers the SUI proceeds to the USER. Returns the tx digest.
  async function userSell({ curveId, tokenAmount }) {
    if (!account?.address) throw new Error('Connect your wallet to sell');
    const { tokenType, packageId, sharedVersion } = await fetchCurveMeta(curveId);
    if (!packageId || !sharedVersion) throw new Error('Curve not resolvable yet (indexer not enriched)');
    if (!isLineagePkg(packageId)) throw new Error('This token is on an older curve version that manual trading does not support in this release. Pick a current-version token.');

    const wantAll = tokenAmount === 'ALL' || (typeof tokenAmount === 'string' && /^(all|max)$/i.test(tokenAmount));
    const rpc = new SuiGraphQLClient({ url: '/api/rpc' });
    const coinsRes = await rpc.listCoins({ owner: account.address, coinType: tokenType });
    const coinList = coinsRes?.objects ?? coinsRes?.data ?? [];
    if (!coinList.length) throw new Error('No token balance to sell for this curve');
    const totalAtomic = coinList.reduce((s, c) => s + BigInt(c.balance ?? c.coinBalance ?? 0), 0n);
    const tokAtomic = wantAll ? totalAtomic : BigInt(Math.floor(parseFloat(tokenAmount) * 1e6));
    if (tokAtomic <= 0n) throw new Error('No token balance to sell for this curve');
    if (!wantAll && tokAtomic > totalAtomic) throw new Error(`You hold ${(Number(totalAtomic) / 1e6).toFixed(6)} tokens - cannot sell ${tokenAmount}`);

    const tx = new Transaction();
    const curveRef = sharedVersion
      ? tx.sharedObjectRef({ objectId: curveId, initialSharedVersion: sharedVersion, mutable: true })
      : tx.object(curveId);
    const coinObjs = coinList.map(c => tx.object(c.objectId ?? c.id ?? c.coinObjectId));
    if (coinObjs.length > 1) tx.mergeCoins(coinObjs[0], coinObjs.slice(1));
    const tokenCoin = wantAll ? coinObjs[0] : tx.splitCoins(coinObjs[0], [tx.pure.u64(tokAtomic)])[0];
    // V7+: sell(curve, tokens, min_out, referral) -> Coin<SUI>
    const [suiOut] = tx.moveCall({
      target: `${packageId}::bonding_curve::sell`,
      typeArguments: [tokenType],
      arguments: [curveRef, tokenCoin, tx.pure.u64(0), tx.pure.option('address', null)],
    });
    tx.transferObjects([suiOut], account.address);

    // Build -> wallet-sign -> execute (see userBuy for why this avoids the Slush
    // txSignatures crash). Reuse the rpc client built above for coin lookup.
    tx.setSender(account.address);
    let digest = null;
    try {
      const built = await tx.build({ client: rpc });
      const { signature } = await dAppKit.signTransaction({ transaction: tx });
      const res = await rpc.executeTransaction({ transaction: built, signatures: [signature] });
      if (res?.errors) throw new Error(Array.isArray(res.errors) ? (res.errors[0]?.message ?? JSON.stringify(res.errors)) : String(res.errors));
      digest = res?.digest ?? res?.data?.executeTransaction?.digest ?? res?.Transaction?.digest ?? null;
    } catch (e) {
      const msg = String(e?.message ?? e);
      if (/txSignatures/.test(msg)) throw new Error('Wallet returned an unexpected response after signing (the sell may have gone through - check your balance/history). If it did not, retry.');
      throw e;
    }
    return digest;
  }

  // Settle the swap through the bridge - the path that actually moves tokens
  // (the Nexus DAG request emits the on-chain execution digest but does not
  // settle, so we settle here, the same bridge every working SuiPump trade uses).
  // Maps the runner payload's fields to the bridge's body. Calls go through the
  // same-origin Vercel proxy (/api/agent-bridge), which injects AGENT_API_KEY
  // server-side and forwards to the bridge's gated write endpoints. The key never
  // ships to the browser, so only our deployed UI (via this proxy) can spend the
  // agent wallet - a direct browser/curl to the bridge gets 401. We pass the
  // target bridge path in `path`. Returns the settlement txDigest, or null for
  // workflows the bridge doesn't settle (claim/alerts go DAG-only).
  async function settleViaBridge(payload) {
    const wf = payload.workflow;

    // MANUAL buy/sell are USER-signed (their wallet, their funds) - NOT the shared
    // agent wallet. Session-parked sells still go through /session-sell (the
    // session key signs those). Everything else below stays on the bridge.
    if (wf === 'buy') {
      return await userBuy({ curveId: payload.buy.curveId, amountSui: payload.buy.amountSui });
    }
    if (wf === 'sell') {
      if (payload.sell.sessionId) {
        // Session-parked position: the SESSION key sells via the bridge with
        // sellAll (bridge resolves the exact parked amount on-chain).
        // Wallet-signed ownership proof (mirrors useSessionPositions.js
        // sellSessionPosition - keep the two in sync): the proxy verifies the
        // signer owns this session before forwarding to the bridge.
        const sellBody = { path: '/session-sell', sessionId: payload.sell.sessionId, curveId: payload.sell.curveId, sellAll: true, minSuiOut: 0 };
        const sellAuth = await signOwnerAuth('agent-bridge', sellBody);
        const r = await fetch(`/api/agent-bridge`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...sellBody, ...sellAuth }),
        });
        const d = await r.json().catch(() => ({}));
        if (!r.ok || d.ok === false) throw new Error(d.error || `bridge sell failed (${r.status})`);
        return d.txDigest ?? null;
      }
      // Plain manual sell: user-signed from their own wallet.
      return await userSell({ curveId: payload.sell.curveId, tokenAmount: payload.sell.tokenAmount });
    }

    let path, body;
    if (wf === 'launch_and_buy') {
      path = '/launch';
      body = {
        name: payload.launch.name,
        symbol: payload.launch.symbol,
        description: payload.launch.description,
        graduationTarget: payload.launch.graduationTarget ?? 0, // default Cetus (0) when unspecified
        antiBotDelay: payload.launch.antiBotDelay,
        devBuySui: payload.buy?.amountSui ?? payload.launch.devBuySui ?? 0,
      };
    } else if (wf === 'launch') {
      path = '/launch';
      body = {
        name: payload.launch.name,
        symbol: payload.launch.symbol,
        description: payload.launch.description,
        graduationTarget: payload.launch.graduationTarget ?? 0, // default Cetus (0) when unspecified
        antiBotDelay: payload.launch.antiBotDelay,
        devBuySui: 0,
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

  // -- Just-in-time universal-trading consent ---------------------------------
  // Native buy_with_session/sell_with_session only reach V10-lineage curves.
  // Trading a LEGACY curve (V4..V9) or a graduated DEX pool goes through the
  // borrow/settle path, which the module gates behind an explicit owner-signed
  // enable_universal_trading (OFF by default: it is a strictly wider risk
  // envelope - a compromised session key can exfiltrate up to remaining
  // spend-cap headroom, per agent_session.move). Rather than a global toggle
  // the user must remember, we prompt for that one signature JUST IN TIME:
  // only when a session-bound strategy actually targets a pre-lineage curve
  // and the marker is not already set. Returns true to proceed, false to abort
  // the arm (user rejected, or the enable failed).
  //
  // -- Pre-arm affordability read ---------------------------------------------
  // Reads the active session's live on-chain escrow / spent / spend_cap so an
  // arm path can refuse to queue a strategy the session cannot actually fund
  // (the drained-session class: a 2nd DCA rung that aborts EInsufficientEscrow /
  // ESpendCapExceeded on-chain and used to fail silently). Mirrors the exact
  // getObject json parsing AgentSessionPanel.loadSession uses (Balance<SUI>
  // renders as {value} or a bare string; tolerate both). Returns MIST BigInts,
  // or null when there is nothing to check (no session bound / unreadable) - the
  // caller then simply skips the gate and lets the on-chain path decide.
  const readSessionFunds = useCallback(async (sessionId) => {
    if (!sessionId) return null;
    try {
      const obj = await client.getObject({ objectId: sessionId, include: { json: true } }).catch(() => null);
      const fields = obj?.object?.json;
      if (!fields) return null;
      const escrowRaw = (fields.escrow && typeof fields.escrow === 'object') ? fields.escrow.value : fields.escrow;
      const escrow   = BigInt(escrowRaw ?? 0);
      const spent    = BigInt(fields.spent ?? 0);
      const spendCap = BigInt(fields.spend_cap ?? 0);
      return { escrow, spent, spendCap };
    } catch {
      return null; // unreadable -> skip the gate (fails open, on-chain still guards)
    }
  }, [client]);

  // curveIdForArm: the strategy's target curve, or null for market-scanning
  // strategies (sniper/autopilot) that have no single fixed target at arm time
  // - those trade whatever launches/scans surface, which on mainnet is
  // V10-lineage, so they never need this at arm time; a legacy target that
  // somehow arises still hard-fails safely on-chain rather than silently
  // downgrading.
  const ensureUniversalIfNeeded = useCallback(async (curveIdForArm) => {
    if (!activeSessionId || !curveIdForArm) return true; // no session bind, or no fixed target
    try {
      // 1. Resolve the target curve's package. Lineage curves (V10/V11/V12)
      //    use the native path - no universal trading required.
      const tr = await fetch(`${INDEXER_URL}/token/${curveIdForArm}`, { signal: AbortSignal.timeout(6000) });
      if (!tr.ok) return true; // cannot classify -> let the on-chain path decide (fails safe)
      const td = await tr.json();
      const pkg = td.package_id ?? td.packageId ?? '';
      const isLineage = pkg === PACKAGE_ID_V10 || pkg === PACKAGE_ID_V11 || pkg === PACKAGE_ID_V12;
      if (isLineage) return true; // native path covers it

      // v1: universal trading is scoped out (see UNIVERSAL_TRADING_ENABLED). A
      // non-lineage curve has no supported session path, so refuse cleanly here
      // rather than prompting the deprecated enable flow. The borrow/settle
      // prompt+enable below stays for a future package but is unreachable now.
      if (!UNIVERSAL_TRADING_ENABLED) {
        const ticker = td.symbol ? `$${td.symbol}` : 'this token';
        setError(`${ticker} runs on an older curve version that agent sessions do not trade in this release. Pick a current-version token.`);
        return false;
      }

      // 2. Legacy curve. Read the session object: is the marker already set,
      //    and what is its shared version (needed to build the enable tx)?
      const obj = await client.getObject({ objectId: activeSessionId });
      const sv = obj?.object?.owner?.Shared?.initialSharedVersion;
      if (!sv) { setError('Could not read the session to enable legacy-token trading.'); return false; }

      let enabled = false;
      try {
        const dfs = await client.listDynamicFields({ parentId: activeSessionId });
        const fields = dfs?.dynamicFields ?? dfs?.data ?? [];
        enabled = fields.some(f => {
          const s = JSON.stringify(f) ?? '';
          return s.includes('universal_trading') || s.includes('dW5pdmVyc2FsX3RyYWRpbmc');
        });
      } catch { /* treat as not enabled; the enable call is idempotent-safe to attempt */ }
      if (enabled) return true;

      // 3. Prompt for the one-time consent signature. This is the plain-language
      //    tradeoff the contract's comment requires the UI to present.
      const ticker = td.symbol ? `$${td.symbol}` : 'this token';
      const ok = window.confirm(
        `${ticker} runs on an older SuiPump version.\n\n` +
        `To let the agent trade it from your session, you'll approve UNIVERSAL TRADING for this session (one signature).\n\n` +
        `Tradeoff: this widens what the session can do - coins briefly leave the session module during each trade, so the risk envelope is your remaining spend cap rather than only named-curve trades. It stays bounded by your spend cap, expiry, and revoke, and you can disable it anytime.\n\n` +
        `Approve universal trading for this session?`
      );
      if (!ok) { setError('Universal trading not approved - strategy not armed. Pick a current-version token, or approve when prompted.'); return false; }

      const tx = new Transaction();
      const ref = tx.sharedObjectRef({ objectId: activeSessionId, initialSharedVersion: String(sv), mutable: true });
      tx.moveCall({ target: `${PACKAGE_ID}::agent_session::enable_universal_trading`, arguments: [ref] });
      const res = await dAppKit.signAndExecuteTransaction({ transaction: tx });
      if (res.FailedTransaction) throw new Error(res.FailedTransaction.status.error ?? 'enable failed');
      return true;
    } catch (e) {
      setError(`Could not enable universal trading: ${e.message || e}`);
      return false;
    }
  }, [activeSessionId, client, dAppKit]);

  const approve = useCallback(async () => {
    if (!plan || phase === 'running') return;
    setError(null); setResult(null); setPhase('running');
    clearAnim();

    const nodes = isBareLaunch(plan)
      ? [{ id: 'launch', tool: 'xyz.suipump.launch@1', label: 'Launch', desc: 'Create token on bonding curve' }]
      : (WORKFLOW_NODES[plan.workflow] ?? []);
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
        // Preflight: if this session-bound compound targets a legacy curve,
        // get universal-trading consent BEFORE the buy settles (the buy is the
        // first thing that touches the curve).
        if (!(await ensureUniversalIfNeeded(payload.buy?.curveId))) { clearAnim(); setPhase('idle'); return; }
        // 1) BUY - settle through the bridge (the path that moves tokens).
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

        // 2) Entry MUST be seeded on the SAME price basis the brain ticks use -
        //    priceFromReserve (current spot from reserve). The indexer's
        //    `last_price` is the fill price, which on a bonding curve sits BELOW
        //    the post-buy spot price (you move price as you buy). Seeding entry
        //    from fill made a freshly-armed position read ~+10% instantly (spot
        //    already above fill), firing a tight TP the moment it armed. Passing
        //    entryPriceSui=null makes the brain seed entry from its own spot read
        //    on first load, so a just-armed position reads ~1.00x. (TP/SL is a
        //    market-price trigger; cost-basis tracking is DCA's avgPrice path.)
        const entryPriceSui = null;

        // 3) ARM the standing TP/SL via the secure create-order proxy.
        try {
          // Wallet-signed ownership proof: the server verifies the signature
          // over these exact fields and requires signer == wallet (and, when
          // sessionId is bound, that the signer owns that session).
          const orderBody = {
            curveId: payload.tpsl.curveId,
            tokenType: payload.tpsl.tokenType,
            type: 'tpsl',
            entryPriceSui,
            takeProfit: payload.tpsl.takeProfit,
            stopLoss: payload.tpsl.stopLoss,
            sessionId: activeSessionId,
            wallet: account?.address ?? null,
          };
          const orderAuth = await signOwnerAuth('create-order', orderBody);
          const r = await fetch(`/api/create-order`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...orderBody, ...orderAuth }),
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

      // STRATEGY (tpsl): not a one-shot trade - create a STANDING order in the
      // strategy store. The strategy engine polls these and fires the sell
      // through the bridge automatically when a trigger is hit. Nothing settles
      // now; settlement happens later when the price crosses a rung.
      if (payload.workflow === 'tpsl') {
        if (!(await ensureUniversalIfNeeded(payload.tpsl?.curveId))) { clearAnim(); setPhase('idle'); return; }
        try {
          // Create via the same-origin Vercel proxy (/api/create-order), which
          // injects the STRATEGY_API_KEY server-side. The key never ships to the
          // browser, so the indexer's write guard is satisfied without exposing it.
          const orderBody = {
            curveId: payload.tpsl.curveId,
            tokenType: payload.tpsl.tokenType,
            type: 'tpsl',
            takeProfit: payload.tpsl.takeProfit,
            stopLoss: payload.tpsl.stopLoss,
            sessionId: activeSessionId,
            wallet: account?.address ?? null,
          };
          const orderAuth = await signOwnerAuth('create-order', orderBody);
          const r = await fetch(`/api/create-order`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...orderBody, ...orderAuth }),
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
      // creates an order in the strategy store and nothing settles now - the brain
      // fires a buy (real Nexus scheduler task) on every NEW launch that matches.
      if (payload.workflow === 'sniper') {
        try {
          const orderBody = { type: 'sniper', params: payload.sniper, sessionId: activeSessionId, wallet: account?.address ?? null };
          const orderAuth = await signOwnerAuth('create-order', orderBody);
          const r = await fetch(`/api/create-order`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...orderBody, ...orderAuth }),
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
      // creates a store order and nothing settles now - the brain fires each buy
      // (Nexus task + bridge settle) on its schedule / dip trigger, tracks the
      // average cost, and arms the `then` exit on that average after the final buy.
      if (payload.workflow === 'dca') {
        if (!(await ensureUniversalIfNeeded(payload.dca?.curveId))) { clearAnim(); setPhase('idle'); return; }
        // PRE-ARM AFFORDABILITY: only when bound to a session (a session-less DCA
        // spends the agent wallet, which this session read does not describe).
        // need = anchor rung + suiPerBuy x remaining rungs. Must fit BOTH the
        // escrow AND the remaining spend-cap headroom (capRemaining = cap - spent;
        // spendCap == 0 means unbounded, per agent_session.move). Blocks the arm
        // with the concrete shortfall rather than letting a later rung abort
        // on-chain and vanish (the drained-session silent-failure class).
        if (activeSessionId) {
          const funds = await readSessionFunds(activeSessionId);
          if (funds) {
            const suiPerBuy = Number(payload.dca?.suiPerBuy) || 0;
            const buys      = Math.max(1, Math.trunc(Number(payload.dca?.buys) || 1));
            const anchor    = Number(payload.dca?.anchorSui) || 0;
            const needSui   = anchor > 0 ? anchor + suiPerBuy * (buys - 1) : suiPerBuy * buys;
            const needMist  = BigInt(Math.ceil(needSui * 1e9));
            const capRemaining = funds.spendCap > 0n
              ? (funds.spendCap > funds.spent ? funds.spendCap - funds.spent : 0n)
              : null; // null = unbounded
            const escrowShort = needMist > funds.escrow;
            const capShort    = capRemaining != null && needMist > capRemaining;
            if (escrowShort || capShort) {
              const capText = capRemaining == null ? 'unbounded' : `${fmtSui(String(capRemaining))} SUI`;
              setError(
                `This DCA needs ${fmtSui(String(needMist))} SUI (${anchor > 0 ? `${anchor} + ${suiPerBuy} x ${buys - 1}` : `${suiPerBuy} x ${buys}`}), ` +
                `but the session has ${fmtSui(String(funds.escrow))} SUI escrow and ${capText} spend-cap headroom. ` +
                `Top up the escrow${capShort ? ' or raise the spend cap' : ''}, or lower the buy size / count.`
              );
              clearAnim(); setNodeState({ arm: 'error' }); setPhase('failed');
              return;
            }
          }
        }
        try {
          const orderBody = {
            type: 'dca',
            curveId: payload.dca.curveId,
            tokenType: payload.dca.tokenType,
            params: payload.dca,
            sessionId: activeSessionId,
            wallet: account?.address ?? null,
          };
          const orderAuth = await signOwnerAuth('create-order', orderBody);
          const r = await fetch(`/api/create-order`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...orderBody, ...orderAuth }),
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

      // STRATEGY (copytrade): standing wallet-follow. Creates a store order; the
      // brain mirrors the target's buys (fixed SUI) and sells (proportional) as
      // they happen, across any curve. Nothing settles now.
      if (payload.workflow === 'copytrade') {
        try {
          const orderBody = { type: 'copytrade', params: payload.copytrade, sessionId: activeSessionId, wallet: account?.address ?? null };
          const orderAuth = await signOwnerAuth('create-order', orderBody);
          const r = await fetch(`/api/create-order`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...orderBody, ...orderAuth }),
          });
          const d = await r.json().catch(() => ({}));
          if (!r.ok) throw new Error(d.error || `order create failed (${r.status})`);
          clearAnim();
          setNodeState({ arm: 'done' });
          setResult({ workflow: 'copytrade', orderId: d.id ?? null, order: d });
          loadOrders();
          setPhase('done');
        } catch (e) {
          clearAnim();
          setNodeState({ arm: 'error' });
          setError(`Could not arm copy-trade: ${e.message}`);
          setPhase('failed');
        }
        return;
      }

      // STRATEGY (autopilot): standing autonomous trader. Creates a store order;
      // the brain scans /trending each tick, enters the best candidate within the
      // spend cap (Nexus emit + bridge settle), and arms a TP/SL exit per entry.
      // Nothing settles now. Revocable by cancelling the order.
      if (payload.workflow === 'autopilot') {
        try {
          const orderBody = { type: 'autopilot', params: payload.autopilot, sessionId: activeSessionId, wallet: account?.address ?? null };
          const orderAuth = await signOwnerAuth('create-order', orderBody);
          const r = await fetch(`/api/create-order`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...orderBody, ...orderAuth }),
          });
          const d = await r.json().catch(() => ({}));
          if (!r.ok) throw new Error(d.error || `order create failed (${r.status})`);
          clearAnim();
          setNodeState({ arm: 'done' });
          setResult({ workflow: 'autopilot', orderId: d.id ?? null, order: d });
          loadOrders();
          setPhase('done');
        } catch (e) {
          clearAnim();
          setNodeState({ arm: 'error' });
          setError(`Could not arm autopilot: ${e.message}`);
          setPhase('failed');
        }
        return;
      }

      // FAN-OUT (claim_all): claim creator fees across every curve the connected
      // (agent) wallet created with fees pending. The server-side proxy
      // enumerates, filters, and fires the claim DAG per curve - each a real
      // Nexus walk. Nothing routes through the bridge (claim is DAG-only).
      if (payload.workflow === 'claim_all') {
        if (!account?.address) {
          clearAnim();
          setNodeState({ claim: 'error' });
          setError('Connect your wallet to claim - the agent claims fees for the curves this wallet created.');
          setPhase('failed');
          return;
        }
        try {
          // Wallet-signed ownership proof: signer must BE creatorAddress.
          const claimBody = { creatorAddress: account.address };
          const claimAuth = await signOwnerAuth('agent-claim-all', claimBody);
          const r = await fetch(`/api/agent-claim-all`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...claimBody, ...claimAuth }),
          });
          const d = await r.json().catch(() => ({}));
          if (!r.ok || d.ok === false) throw new Error(d.error || `claim-all failed (${r.status})`);
          clearAnim();
          setNodeState({ claim: 'done' });
          setResult({ workflow: 'claim_all', ...d });
          setPhase('done');
        } catch (e) {
          clearAnim();
          setNodeState({ claim: 'error' });
          setError(`Claim-all failed: ${e.message}`);
          setPhase('failed');
        }
        return;
      }

      // MANUAL TRADES ARE USER-SIGNED AND USER-EXECUTED. There is NO Nexus DAG
      // emit here: emitting /api/agent-run handed the trade to the Talus Leader,
      // which executed it from the SHARED AGENT WALLET - so every manual buy/sell
      // fired TWICE (once user-signed from the user's wallet in STEP 2 below, once
      // Leader-executed from the agent wallet). That is the agent-wallet duplicate.
      // The user's wallet is the sole executor of a manual trade; the autonomous
      // agent (sessions/strategies) is the only thing that runs through the Leader.
      const data = {};
      clearAnim();

      // Settle the swap - user-signed (userBuy/userSell) for buy/sell, bridge for
      // launch. This is the money path and the ONLY execution of a manual trade.
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
      // Record the manual fire (production path - bridge settled). Best-effort.
      recordAction({
        kind:               data.workflow ?? plan.workflow,
        source:             'manual',
        curveId:            payload?.buy?.curveId ?? payload?.sell?.curveId ?? null,
        tokenType:          payload?.sell?.tokenType ?? null,
        summary:            plan?.summary ?? (data.workflow ?? plan.workflow),
        executionId:        data.executionId ?? null,
        nexusRequestDigest: data.digest ?? null,
        settleDigest,
        settledVia:         'bridge',
        wallet:             account?.address ?? null,
        status:             'settled',
      });
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
  // A launch_and_buy with no dev-buy is, to the user, just a launch. We keep the
  // proven launch_and_buy DAG (0xfd88, buy=0 settles fine) under the hood but
  // relabel the display: single "Launch" node, "launch" workflow, no dev-buy row.
  function isBareLaunch(p) {
    return !!(p && p.workflow === 'launch_and_buy' && !(Number(p.buy?.amountSui ?? p.launch?.devBuySui ?? 0) > 0));
  }

  const nodes = plan
    ? (isBareLaunch(plan)
        ? [{ id: 'launch', tool: 'xyz.suipump.launch@1', label: 'Launch', desc: 'Create token on bonding curve' }]
        : (WORKFLOW_NODES[plan.workflow] ?? []))
    : [];

  // Per-workflow plan summary rows (no launch fields bleed onto non-launch plans).
  function planRows(p) {
    if (isBareLaunch(p)) {
      return [
        ['workflow', 'launch'],
        ['token', `${p.launch.name} ($${p.launch.symbol})`],
        ['graduates to', GRAD[p.launch.graduationTarget] ?? 'Cetus'],
      ];
    }
    switch (p.workflow) {
      case 'launch_and_buy':
        return [
          ['workflow', p.workflow],
          ['token', `${p.launch.name} ($${p.launch.symbol})`],
          ['dev-buy', `${p.buy?.amountSui ?? p.launch.devBuySui ?? 0} SUI`],
          ['graduates to', GRAD[p.launch.graduationTarget] ?? 'Cetus'],
        ];
      case 'buy':
        return [
          ['workflow', p.workflow],
          ['curve', p.buy?.curveId ? `${p.buy.curveId.slice(0, 10)}...` : '(missing - paste CA)'],
          ['amount', `${p.buy?.amountSui ?? 0} SUI`],
        ];
      case 'sell':
        return [
          ['workflow', p.workflow],
          ['curve', p.sell?.curveId ? `${p.sell.curveId.slice(0, 10)}...` : '(missing - paste CA)'],
          ['amount', p.sell?.tokenAmount === 'ALL' ? 'ALL tokens' : `${p.sell?.tokenAmount} tokens`],
        ];
      case 'claim':
        return [
          ['workflow', p.workflow],
          ['curve', p.claim?.curveId ? `${p.claim.curveId.slice(0, 10)}...` : '(missing - paste CA)'],
        ];
      case 'claim_all':
        return [
          ['workflow', 'claim all'],
          ['scope', 'every curve you created with fees pending'],
        ];
      case 'alerts':
        return [
          ['workflow', p.workflow],
          ['monitoring', `${p.alerts?.curveIds?.length ?? 0} curve(s)`],
        ];
      case 'tpsl': {
        const rows = [
          ['workflow', 'tp/sl strategy'],
          ['curve', p.tpsl?.curveId ? `${p.tpsl.curveId.slice(0, 10)}...` : '(missing - paste CA)'],
        ];
        (p.tpsl?.takeProfit ?? []).forEach((r, i) =>
          rows.push([`take-profit ${i + 1}`, `+${Math.round((r.multiple - 1) * 100)}% . sell ${r.sellPct}%`]));
        if (p.tpsl?.stopLoss)
          rows.push(['stop-loss', `-${Math.round((1 - p.tpsl.stopLoss.multiple) * 100)}%`]);
        return rows;
      }
      case 'buy_then_tpsl': {
        const rows = [
          ['workflow', 'buy + tp/sl'],
          ['buy', `${p.buy?.amountSui ?? 0} SUI`],
          ['curve', p.buy?.curveId ? `${p.buy.curveId.slice(0, 10)}...` : '(missing - paste CA)'],
        ];
        (p.tpsl?.takeProfit ?? []).forEach((r, i) =>
          rows.push([`take-profit ${i + 1}`, `+${Math.round((r.multiple - 1) * 100)}% . sell ${r.sellPct}%`]));
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
          rows.push(['creators', s.creators.map(c => `${c.slice(0, 10)}...`).join(', ')]);
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
            rows.push([`then take-profit ${i + 1}`, `+${Math.round((r.multiple - 1) * 100)}% . sell ${r.sellPct}%`]));
          if (s.then.tpsl.stopLoss)
            rows.push(['then stop-loss', `-${Math.round((1 - s.then.tpsl.stopLoss.multiple) * 100)}%`]);
        }
        return rows;
      }
      case 'dca': {
        const d = p.dca ?? {};
        const rows = [
          ['workflow', 'dca (standing accumulation)'],
          ['curve', d.curveId ? `${d.curveId.slice(0, 10)}...` : '(missing - paste CA)'],
          ['buy size', `${d.suiPerBuy ?? 0} SUI per buy`],
          ['trigger', d.mode === 'dip' ? `each -${d.dropPct}% drop from entry` : `every ${Math.round((d.intervalMs ?? 86400000) / 1000)}s`],
          ['total buys', `${d.buys ?? 1}`],
        ];
        if (d.then?.tpsl) {
          (d.then.tpsl.takeProfit ?? []).forEach((r, i) =>
            rows.push([`then take-profit ${i + 1}`, `+${Math.round((r.multiple - 1) * 100)}% . sell ${r.sellPct}% (on avg cost)`]));
          if (d.then.tpsl.stopLoss)
            rows.push(['then stop-loss', `-${Math.round((1 - d.then.tpsl.stopLoss.multiple) * 100)}% (on avg cost)`]);
        }
        return rows;
      }
      case 'copytrade': {
        const c = p.copytrade ?? {};
        return [
          ['workflow', 'copy-trade (wallet follow)'],
          ['target wallet', c.targetWallet ? `${c.targetWallet.slice(0, 10)}...${c.targetWallet.slice(-4)}` : '(missing - paste 0x)'],
          ['buy size', `${c.suiPerTrade ?? 0} SUI per trade`],
          ['sells', 'proportional to target'],
          ['scope', 'every curve the target trades'],
        ];
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
          <span className="ml-auto text-[9px] font-mono text-violet-300/50 tracking-widest border border-violet-400/20 rounded-full px-2.5 py-1 whitespace-nowrap">
            POWERED BY TALUS
          </span>
        </div>
        <p className="text-white/40 text-[11px] font-mono leading-relaxed max-w-xl">
          State a goal in plain language and the agent produces autonomous workflows - planning with an LLM, then executing on-chain through published Nexus DAGs. Five base tools - launch, buy, sell, claim, monitor - power four standing strategies (sniper, DCA, copy-trade, take-profit / stop-loss), which can be combined into entry-plus-exit setups. See HOW TO OPERATE below.
        </p>
      </div>

      {/* -- Agent session (escrow authorization) ------------------------- */}
      <AgentSessionPanel account={account} onSessionChange={setActiveSessionId} />

      {/* -- Strategy guide (accordion) ----------------------------------- */}
      <div className="border border-white/10 rounded-xl bg-white/[0.02] mb-4 overflow-hidden">
        <button
          onClick={() => setGuideOpen(v => !v)}
          className="w-full flex items-center justify-between px-4 py-3 text-left"
        >
          <span className="flex items-center gap-2">
            <Bot size={12} className="text-violet-400" />
            <span className="text-[10px] font-mono text-white/40 tracking-widest">HOW TO OPERATE</span>
          </span>
          <ChevronDown size={14} className={`text-white/30 transition-transform ${guideOpen ? 'rotate-180' : ''}`} />
        </button>
        {guideOpen && (
          <div className="px-3 pb-3 space-y-4">
            {OPERATE_GUIDE.map((sec) => (
              <div key={sec.section}>
                <div className="px-1 pt-1 pb-2">
                  <div className="text-[9px] font-mono text-violet-400/70 tracking-widest">{sec.section}</div>
                  <div className="text-[10px] font-mono text-white/30 mt-0.5">{sec.blurb}</div>
                </div>
                <div className="space-y-1.5">
                  {sec.items.map((s) => {
                    const open = openStrategy === s.key;
                    return (
                      <div key={s.key} className="border border-white/10 rounded-lg bg-black/30 overflow-hidden">
                        <button
                          onClick={() => setOpenStrategy(open ? null : s.key)}
                          className="w-full flex items-center justify-between px-3 py-2.5 text-left hover:bg-white/[0.03]"
                        >
                          <span className="min-w-0">
                            <span className="text-[12px] font-mono text-white/80">{s.title}</span>
                            {s.fqn && <span className="text-[9px] font-mono text-violet-300/40 ml-2">{s.fqn}</span>}
                            <span className="block text-[10px] font-mono text-white/35 mt-0.5">{s.tagline}</span>
                          </span>
                          <ChevronDown size={13} className={`shrink-0 text-violet-400/60 transition-transform ${open ? 'rotate-180' : ''}`} />
                        </button>
                        {open && (
                          <div className="px-3 pb-3 pt-1 space-y-3 border-t border-white/5">
                            <p className="text-[11px] font-mono text-white/55 leading-relaxed whitespace-pre-line">{s.body}</p>
                            {s.inputs && (
                              <div>
                                <div className="text-[9px] font-mono text-white/30 tracking-widest mb-1.5">YOU PROVIDE</div>
                                <ul className="space-y-1">
                                  {s.inputs.map((inp, i) => (
                                    <li key={i} className="text-[11px] font-mono text-white/55 flex gap-2">
                                      <span className="text-violet-400/50">.</span>{inp}
                                    </li>
                                  ))}
                                </ul>
                              </div>
                            )}
                            <div>
                              <div className="text-[9px] font-mono text-white/30 tracking-widest mb-1.5">EXAMPLES - CLICK TO USE</div>
                              <div className="space-y-1.5">
                                {s.examples.map((ex, i) => (
                                  <button
                                    key={i}
                                    onClick={() => { setGoal(ex); setGuideOpen(false); }}
                                    className="w-full text-left text-[11px] font-mono text-emerald-300/70 hover:text-emerald-300 bg-emerald-400/[0.04] hover:bg-emerald-400/[0.08] border border-emerald-400/15 rounded px-2.5 py-2 leading-relaxed"
                                  >
                                    {ex}
                                  </button>
                                ))}
                              </div>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="border border-white/10 rounded-xl p-4 bg-white/[0.02] mb-4">
        <div className="flex items-center gap-2 mb-3">
          <Sparkles size={11} className="text-violet-400" />
          <span className="text-[10px] font-mono text-white/35 tracking-widest">GOAL</span>
        </div>
        <textarea
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          placeholder="e.g. Launch a dog token called MoonCat, dev-buy 1 SUI  .  or  .  Sell all tokens of 0xCURVE..."
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
          <p className="text-[12px] font-mono text-white/80 mb-3 leading-relaxed">{isBareLaunch(plan) ? `Launch ${plan.launch?.name ?? 'token'} ($${plan.launch?.symbol ?? ''}) on the bonding curve.` : plan.summary}</p>

          {resolving && (
            <div className="text-[10px] font-mono text-white/40 mb-3 flex items-center gap-2">
              <Loader size={11} className="animate-spin text-violet-400" /> Finding matching tokens...
            </div>
          )}

          {/* Ticker disambiguation - multiple tokens share this ticker; pick one. */}
          {candidates && candidates.length > 1 && (
            <div className="mb-4">
              <div className="text-[10px] font-mono text-amber-400/80 tracking-widest mb-2">
                MULTIPLE TOKENS MATCH - PICK ONE
              </div>
              <div className="space-y-1.5 max-h-72 overflow-y-auto">
                {candidates.map(c => (
                  <button
                    key={c.curveId}
                    onClick={() => choosePick(c)}
                    className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg border border-white/10 bg-white/[0.02] hover:bg-violet-400/[0.08] hover:border-violet-400/40 transition-all text-left"
                  >
                    <TokenIcon url={c.iconUrl} symbol={c.symbol} />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="text-[12px] font-mono font-bold text-white/90">${c.symbol}</span>
                        <span className="text-[8px] font-mono text-violet-400/60 tracking-wider">{GRAD[c.graduationTarget] ?? ''}</span>
                      </div>
                      <div className="text-[9px] font-mono text-white/40 truncate">{c.name}</div>
                    </div>
                    <div className="text-right flex-shrink-0">
                      <div className="text-[10px] font-mono text-lime-400/80">{c.marketCapSui >= 1000 ? `${(c.marketCapSui/1000).toFixed(1)}K` : c.marketCapSui.toFixed(1)} SUI mcap</div>
                      <div className="text-[8.5px] font-mono text-white/35">{c.volumeSui.toFixed(1)} vol . {c.holders} holder{c.holders === 1 ? '' : 's'}</div>
                    </div>
                  </button>
                ))}
              </div>
              <div className="text-[8.5px] font-mono text-white/25 mt-1.5">Curve address resolved from your pick - the agent acts on the exact token you choose.</div>
            </div>
          )}

          {/* Single match auto-resolved - shown for confirmation (b-soft). */}
          {resolvedNote && (
            <div className="mb-4 flex items-center gap-3 px-3 py-2.5 rounded-lg border border-violet-400/25 bg-violet-400/[0.05]">
              <TokenIcon url={resolvedNote.iconUrl} symbol={resolvedNote.symbol} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className="text-[8px] font-mono text-violet-400/70 tracking-widest">RESOLVED</span>
                  <span className="text-[12px] font-mono font-bold text-white/90">${resolvedNote.symbol}</span>
                  <span className="text-[8px] font-mono text-violet-400/60 tracking-wider">{GRAD[resolvedNote.graduationTarget] ?? ''}</span>
                </div>
                <div className="text-[8.5px] font-mono text-white/40">{resolvedNote.marketCapSui >= 1000 ? `${(resolvedNote.marketCapSui/1000).toFixed(1)}K` : resolvedNote.marketCapSui.toFixed(1)} SUI mcap . {resolvedNote.volumeSui.toFixed(1)} vol . {resolvedNote.holders} holder{resolvedNote.holders === 1 ? '' : 's'}</div>
              </div>
            </div>
          )}

          <div className="grid grid-cols-2 gap-2 text-[10px] font-mono text-white/45 mb-4">
            {planRows(plan).map(([k, v]) => (
              <div key={k}>{k}: <span className="text-white/80">{v}</span></div>
            ))}
          </div>
          {(phase === 'idle' || phase === 'failed') && !(candidates && candidates.length > 1) && (
            <button
              onClick={approve}
              className="w-full text-[11px] font-mono font-bold tracking-widest px-4 py-3 rounded-lg bg-violet-500 text-white hover:bg-violet-400 transition-colors flex items-center justify-center gap-2"
            >
              <Play size={12} /> {phase === 'failed' ? 'RETRY - EXECUTE ON-CHAIN' : 'APPROVE & EXECUTE ON-CHAIN'}
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
              <div className="text-[10px] font-mono text-white/40">Running the {isBareLaunch(plan) ? 'launch' : plan?.workflow} DAG on-chain.</div>
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
                    <div className="text-[9px] font-mono text-white/30">{n.tool} . {n.desc}</div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {result && (result.workflow === 'tpsl' || result.workflow === 'buy_then_tpsl' || result.workflow === 'sniper' || result.workflow === 'dca' || result.workflow === 'copytrade') && (
        <div className="border border-emerald-400/30 rounded-xl p-4 bg-emerald-400/[0.05]">
          <div className="text-[10px] font-mono text-emerald-400/80 tracking-widest mb-3">
            {result.workflow === 'buy_then_tpsl'
              ? '✓ BOUGHT & STRATEGY ARMED - AGENT IS WATCHING'
              : result.workflow === 'sniper'
              ? '✓ SNIPER ARMED - AGENT IS WATCHING LAUNCHES'
              : result.workflow === 'dca'
              ? '✓ DCA ARMED - AGENT IS ACCUMULATING'
              : result.workflow === 'copytrade'
              ? '✓ COPY-TRADE ARMED - AGENT IS MIRRORING THE WALLET'
              : '✓ STRATEGY ARMED - AGENT IS WATCHING'}
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
            {WORKFLOW_DAGS[result.workflow] && (
              <div className="text-white/40 pt-1">
                executes through Nexus {WORKFLOW_DAGS[result.workflow].length > 1 ? 'DAGs' : 'DAG'}:
                <div className="mt-1 space-y-0.5">
                  {WORKFLOW_DAGS[result.workflow].map((k) => (
                    <a key={k} href={suiscanObject(NEXUS_DAG[k])} target="_blank" rel="noreferrer"
                       className="flex items-center gap-1 text-violet-300/70 hover:text-violet-300 break-all">
                      <span className="text-white/30 uppercase w-7 shrink-0">{k}</span>
                      {NEXUS_DAG[k].slice(0, 18)}... <ExternalLink size={9} />
                    </a>
                  ))}
                </div>
              </div>
            )}
            <div className="text-white/50 leading-relaxed">
              {result.workflow === 'sniper'
                ? "The agent now watches new launches and fires a buy through Nexus the moment one matches your filter. No further action needed."
                : result.workflow === 'dca'
                ? "The agent now accumulates on this curve automatically through Nexus - on schedule or on each dip - tracking your average cost. Watch it in Active Strategies below."
                : result.workflow === 'copytrade'
                ? "The agent now follows the target wallet through Nexus: buying when it buys, selling proportionally when it sells, across every curve it trades. Watch it in Active Strategies below."
                : "The agent now watches this curve's price and sells automatically through Nexus when a trigger is hit. No further action needed."}
            </div>
          </div>
        </div>
      )}

      {result && result.workflow === 'claim_all' && (
        <div className="border border-violet-400/30 rounded-xl p-4 bg-violet-400/[0.05]">
          <div className="text-[10px] font-mono text-violet-400/80 tracking-widest mb-3">✓ CLAIM ALL - VIA NEXUS</div>
          <div className="text-[11px] font-mono text-white/80 mb-3">
            Claimed {result.claimedCount ?? 0} of {result.attempted ?? 0} curve(s) with fees pending
            {Number(result.totalFeesSui) > 0 ? ` . ~${Number(result.totalFeesSui).toFixed(4)} SUI` : ''}.
            {(result.totalCurves != null) && <span className="text-white/30"> ({result.totalCurves} created total)</span>}
          </div>
          {(!result.results || result.results.length === 0) ? (
            <div className="text-[10px] font-mono text-white/40">{result.message || 'No curves with creator fees pending.'}</div>
          ) : (
            <div className="space-y-1.5 max-h-60 overflow-y-auto">
              {result.results.map((row, i) => (
                <div key={row.curveId ?? i} className="flex items-center justify-between gap-2 py-1 border-b border-white/[0.04]">
                  <div className="min-w-0 flex items-center gap-1.5">
                    <span className={`text-[10px] font-mono ${row.ok ? 'text-emerald-400' : 'text-red-400'}`}>{row.ok ? '✓' : '✗'}</span>
                    <span className="text-[10px] font-mono text-white/70 truncate">
                      {row.symbol ? `$${row.symbol}` : `${String(row.curveId).slice(0, 10)}...`}
                    </span>
                    <span className="text-[9px] font-mono text-white/30">{Number(row.feesSui).toFixed(4)} SUI</span>
                  </div>
                  {row.ok ? (
                    row.digest && (
                      <a href={suiscanTx(row.digest)} target="_blank" rel="noreferrer"
                         className="text-violet-400 hover:text-violet-300 shrink-0"><ExternalLink size={11} /></a>
                    )
                  ) : (
                    <span className="text-[9px] font-mono text-red-400/60 truncate max-w-[40%]">{row.error}</span>
                  )}
                </div>
              ))}
            </div>
          )}
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

      {/* -- Active strategies ----------------------------------------------- */}
      <div className="mt-10 pt-6 border-t border-white/10">
        <div className="flex items-center justify-between mb-4">
          <div className="text-[10px] font-mono text-violet-400/70 tracking-widest">
            ACTIVE STRATEGIES{orders.length ? ` . ${orders.length}` : ''}
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
            <Loader size={13} className="animate-spin" /> loading...
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
                    {o.type === 'autopilot' && Array.isArray(o.params?.entered) && o.params.entered.length > 0 && (
                      <div className="mt-1.5 flex flex-wrap items-center gap-1">
                        <span className="text-[9px] font-mono text-white/30 tracking-wider mr-0.5">POSITIONS</span>
                        {o.params.entered.map((cid) => (
                          <button
                            key={cid}
                            type="button"
                            onClick={() => navigate(`/token/${cid}`)}
                            className="inline-flex items-center gap-1 text-[9px] font-mono text-emerald-300/70 hover:text-emerald-300 bg-emerald-400/5 border border-emerald-400/15 rounded px-1.5 py-0.5"
                            title={cid}
                          >
                            {tickerByCurve[cid] ? `$${tickerByCurve[cid]}` : shortId(cid)} <ExternalLink size={8} />
                          </button>
                        ))}
                      </div>
                    )}
                    {o.curveId && (
                      <button
                        type="button"
                        onClick={() => navigate(`/token/${o.curveId}`)}
                        className="inline-flex items-center gap-1 text-[9px] font-mono text-white/25 hover:text-violet-400/80 mt-1"
                        title="Open token page"
                      >
                        {shortId(o.curveId)} <ExternalLink size={9} />
                      </button>
                    )}
                    {o.params?._lastFire && (o.params._lastFire.settle || o.params._lastFire.nexusDigest) && (
                      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[9px] font-mono">
                        <span className="text-emerald-400/60 tracking-wider">
                          LAST {String(o.params._lastFire.kind || 'fire').toUpperCase()}
                        </span>
                        {(o.params._lastFire.nexusDigest || o.params._lastFire.nexusTask) && (
                          <a
                            href={suiscanTx(o.params._lastFire.nexusDigest || o.params._lastFire.nexusTask)}
                            target="_blank" rel="noreferrer"
                            className="inline-flex items-center gap-1 text-violet-300/60 hover:text-violet-300"
                            title="Nexus DAG execution"
                          >
                            nexus {String(o.params._lastFire.nexusDigest || o.params._lastFire.nexusTask).slice(0, 10)}... <ExternalLink size={8} />
                          </a>
                        )}
                        {o.params._lastFire.settle && (
                          <a
                            href={suiscanTx(o.params._lastFire.settle)}
                            target="_blank" rel="noreferrer"
                            className="inline-flex items-center gap-1 text-emerald-300/60 hover:text-emerald-300"
                            title="bridge settlement"
                          >
                            settle {String(o.params._lastFire.settle).slice(0, 10)}... <ExternalLink size={8} />
                          </a>
                        )}
                      </div>
                    )}
                    {o.params?._lastError && o.params._lastError.reason && (
                      <div className="mt-1.5 flex items-center gap-1.5 text-[9px] font-mono">
                        <span className="text-red-400/80 tracking-wider">
                          LAST {String(o.params._lastError.kind || 'fire').toUpperCase()} FAILED
                        </span>
                        <span className="text-red-300/70">
                          {o.params._lastError.reason}
                          {o.params._lastError.code != null ? ` (code ${o.params._lastError.code})` : ''}
                        </span>
                      </div>
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
                          {isCanceling ? '...' : 'CONFIRM'}
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

      {/* -- Agent action history (persistent) ------------------------------- */}
      <div className="mt-10 pt-6 border-t border-white/10">
        <button
          onClick={() => setHistoryOpen(o => !o)}
          className="w-full flex items-center justify-between mb-4"
        >
          <div className="text-[10px] font-mono text-violet-400/70 tracking-widest">
            AGENT HISTORY{history.length ? ` . ${history.length}` : ''}
          </div>
          <ChevronDown size={14} className={`text-white/30 transition-transform ${historyOpen ? 'rotate-180' : ''}`} />
        </button>

        {historyOpen && (
          history.length === 0 ? (
            <div className="border border-white/10 rounded-xl p-4 text-[11px] font-mono text-white/30">
              No actions yet. Fired trades (manual and autonomous) appear here.
            </div>
          ) : (
            <div className="space-y-2">
              {history.map((a) => {
                const proof = a.leaderSettlementDigest || a.settleDigest || a.nexusRequestDigest;
                const via   = a.settledVia === 'leader' ? 'leader' : a.settledVia === 'bridge' ? 'bridge' : null;
                const when  = a.createdAt ? new Date(a.createdAt).toLocaleString() : '';
                return (
                  <div key={a.id} className="border border-white/10 rounded-xl p-3 text-[10px] font-mono">
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className={`shrink-0 px-1.5 py-0.5 rounded text-[8px] tracking-widest ${a.source === 'autonomous' ? 'bg-violet-400/15 text-violet-300/90' : 'bg-emerald-400/15 text-emerald-300/90'}`}>
                          {a.source === 'autonomous' ? 'AUTO' : 'MANUAL'}
                        </span>
                        <span className="text-white/70 truncate">{a.summary || a.kind}</span>
                      </div>
                      <span className={`shrink-0 text-[9px] tracking-widest ${a.status === 'settled' ? 'text-emerald-400/80' : a.status === 'pending' ? 'text-violet-300/70' : a.status === 'fallback' ? 'text-amber-300/70' : 'text-red-400/70'}`}>
                        {a.status}{via ? ` . ${via}` : ''}
                      </span>
                    </div>
                    {when && <div className="text-white/30 mt-1">{when}</div>}
                    {a.curveId && (
                      <button
                        type="button"
                        onClick={() => navigate(`/token/${a.curveId}`)}
                        className="inline-flex items-center gap-1.5 mt-1 text-violet-400 hover:text-violet-300 break-all"
                        title="Open token page"
                      >
                        token: {a.tokenType ? `$${shortType(a.tokenType)}` : tickerByCurve[a.curveId] ? `$${tickerByCurve[a.curveId]}` : shortId(a.curveId)} <ExternalLink size={10} />
                      </button>
                    )}
                    {a.wallet && (
                      <div className="text-white/30 mt-1 break-all">wallet: {shortId(a.wallet)}</div>
                    )}
                    {proof && (
                      <a href={suiscanTx(proof)} target="_blank" rel="noreferrer"
                         className="inline-flex items-center gap-1.5 mt-1 text-violet-400 hover:text-violet-300 break-all">
                        {a.leaderSettlementDigest ? 'leader settled' : a.settleDigest ? 'settled' : 'nexus request'}: {proof} <ExternalLink size={10} />
                      </a>
                    )}
                  </div>
                );
              })}
            </div>
          )
        )}
      </div>
    </div>
  );
}
