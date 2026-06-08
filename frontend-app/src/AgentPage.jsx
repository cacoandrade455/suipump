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
};

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
      default:
        throw new Error(`Unknown workflow: ${p.workflow}`);
    }
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
      const res  = await fetch(`${RUNNER_URL}/run-dag`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      clearAnim();
      if (!res.ok || data.ok === false) throw new Error(data.error || 'DAG execution failed');

      setNodeState(Object.fromEntries(nodes.map(n => [n.id, 'done'])));
      setResult({
        workflow:    data.workflow ?? plan.workflow,
        executionId: data.executionId ?? null,
        digest:      data.digest ?? null,
        checkpoint:  data.checkpoint ?? null,
        dagId:       data.dagId ?? null,
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
                tx: {result.digest} <ExternalLink size={11} />
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
