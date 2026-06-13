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

  const tpDesc = tp.length ? `take-profit ${tp.map(r => `+${Math.round((r.multiple - 1) * 100)}% (sell ${r.sellPct}%)`).join(', ')}` : '';
  const slDesc = stopLoss ? `stop-loss -${Math.round((1 - stopLoss.multiple) * 100)}%` : '';
  const summary = `Arm a standing strategy on ${curveId.slice(0, 10)}…: ${[tpDesc, slDesc].filter(Boolean).join(' · ')}. The agent watches the price and sells automatically when a trigger is hit.`;

  return { workflow: 'tpsl', summary, tpsl: { curveId, takeProfit: tp, stopLoss } };
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
      default:
        throw new Error(`Unknown workflow: ${p.workflow}`);
    }
  }

  // Settle the swap through the bridge — the path that actually moves tokens
  // (the Nexus DAG request emits the on-chain execution digest but does not
  // settle, so we settle here, the same bridge every working SuiPump trade uses).
  // Maps the runner payload's fields to the bridge's body. The bridge signs with
  // its own SUI_PRIVATE_KEY, so no key is sent. Returns the settlement txDigest,
  // or null for workflows the bridge doesn't settle (claim/alerts go DAG-only).
  async function settleViaBridge(payload) {
    const wf = payload.workflow;
    let url, body;
    if (wf === 'buy') {
      url = `${BRIDGE_URL}/buy`;
      body = { curveId: payload.buy.curveId, suiAmount: payload.buy.amountSui };
    } else if (wf === 'sell') {
      url = `${BRIDGE_URL}/sell`;
      body = { curveId: payload.sell.curveId, tokenAmount: payload.sell.tokenAmount, minSuiOut: 0 };
    } else if (wf === 'launch_and_buy') {
      // Launch settles through the bridge /launch; the buy leg rides with it.
      url = `${BRIDGE_URL}/launch`;
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
    const r = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
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
          setPhase('done');
        } catch (e) {
          clearAnim();
          setNodeState({ arm: 'error' });
          setError(`Could not arm strategy: ${e.message}`);
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
        const res = await fetch(`${RUNNER_URL}/run-dag`, {
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

      {result && result.workflow === 'tpsl' && (
        <div className="border border-emerald-400/30 rounded-xl p-4 bg-emerald-400/[0.05]">
          <div className="text-[10px] font-mono text-emerald-400/80 tracking-widest mb-3">✓ STRATEGY ARMED — AGENT IS WATCHING</div>
          <div className="space-y-2 text-[10px] font-mono">
            {result.orderId && (
              <div className="text-white/40">order id: <span className="text-white/70 break-all">{result.orderId}</span></div>
            )}
            <div className="text-white/50 leading-relaxed">
              The agent now watches this curve's price and sells automatically through Nexus when a trigger is hit. No further action needed.
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
    </div>
  );
}
