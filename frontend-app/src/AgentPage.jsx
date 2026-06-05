// AgentPage.jsx — Autonomous agent console (routed page, renders inside <main>).
//
// Flow (true autonomous execution):
//   1. Natural-language goal -> Groq plans off-chain (/api/agent-plan).
//   2. Operator clicks APPROVE.
//   3. The browser calls the agent-runner service (/run-dag), which executes the
//      REAL Nexus DAG via the `nexus` CLI server-side and returns the on-chain
//      DAGExecution object id. No terminal, no human step.
//   4. The UI animates the tool nodes and shows the real DAGExecution id linked
//      to Suiscan.
//
// The LLM plans OFF-CHAIN (the Nexus LLM tool would expose the API key on
// testnet); the DAG does the on-chain work. Violet identity, distinct from the
// lime trading UI.
import React, { useState, useCallback, useRef, useEffect } from 'react';
import { ArrowLeft, Sparkles, Play, Check, X, Loader, ExternalLink, Bot } from 'lucide-react';

const RUNNER_URL = import.meta.env.VITE_AGENT_RUNNER_URL || 'https://suipump-agent-runner.onrender.com';
const DAG_ID     = import.meta.env.VITE_NEXUS_DAG_ID || '0xfd88d4d2f60340c268e77409b24fb129696d230a50fb21667de313531eb24c3b';

const suiscanObject = (id) => `https://suiscan.xyz/testnet/object/${id}`;
const suiscanTx     = (d)  => `https://suiscan.xyz/testnet/tx/${d}`;

const NODES = [
  { id: 'launch', tool: 'xyz.suipump.launch@1', label: 'Launch',  desc: 'Create token on bonding curve' },
  { id: 'buy',    tool: 'xyz.suipump.buy@1',    label: 'Dev-buy', desc: 'Agent makes the first buy' },
  { id: 'alerts', tool: 'xyz.suipump.alerts@1', label: 'Monitor', desc: 'Watch graduation threshold' },
  { id: 'claim',  tool: 'xyz.suipump.claim@1',  label: 'Claim',   desc: 'Claim creator fees' },
];

const GRAD = { 0: 'Cetus', 1: 'DeepBook', 2: 'Turbos' };

export default function AgentPage({ onBack }) {
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

  const approve = useCallback(async () => {
    if (!plan || phase === 'running') return;
    setError(null); setResult(null); setPhase('running');
    clearAnim();

    setNodeState({ launch: 'running', buy: 'idle', alerts: 'idle', claim: 'idle' });
    animTimers.current.push(setTimeout(() => {
      setNodeState(s => ({ ...s, launch: 'done', buy: 'running' }));
    }, 1500));

    const payload = {
      dagId: DAG_ID,
      launch: {
        name:        plan.launch.name,
        symbol:      plan.launch.symbol,
        description: plan.summary || `${plan.launch.name} via SuiPump agent`,
      },
      buy: { amount_sui: plan.buy.suiAmount },
    };

    try {
      const res  = await fetch(`${RUNNER_URL}/run-dag`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      clearAnim();
      if (!res.ok || data.ok === false) throw new Error(data.error || 'DAG execution failed');

      setNodeState({ launch: 'done', buy: 'done', alerts: 'idle', claim: 'idle' });
      setResult({
        executionId: data.executionId ?? null,
        digest:      data.digest ?? null,
        checkpoint:  data.checkpoint ?? null,
        dagId:       data.dagId ?? DAG_ID,
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
  }, [plan, phase, clearAnim]);

  const nodeColor = (s) =>
    s === 'done'    ? 'border-violet-400/60 bg-violet-400/10' :
    s === 'running' ? 'border-violet-400 bg-violet-400/5 animate-pulse' :
    s === 'error'   ? 'border-red-400/60 bg-red-400/10' :
                      'border-white/10 bg-white/[0.02]';

  const showExecutionPanel = phase !== 'idle';

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
          State a goal in plain language. The agent plans with an LLM, then executes the full token lifecycle on-chain through a Nexus DAG — launch, dev-buy, monitor, claim.
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
          placeholder="e.g. Launch a dog-themed token called MoonCat, dev-buy 1 SUI, and claim fees at graduation"
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
            <div>workflow: <span className="text-white/80">{plan.workflow}</span></div>
            <div>token: <span className="text-white/80">{plan.launch.name} (${plan.launch.symbol})</span></div>
            <div>dev-buy: <span className="text-white/80">{plan.buy.suiAmount} SUI</span></div>
            <div>graduates to: <span className="text-white/80">{GRAD[plan.launch.graduationTarget] ?? 'Turbos'}</span></div>
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
              <div className="text-[10px] font-mono text-white/40">Running the DAG on-chain — launch then dev-buy.</div>
            </div>
            <Loader size={14} className="text-violet-400 animate-spin" />
          </div>
        </div>
      )}

      {showExecutionPanel && (
        <div className="border border-white/10 rounded-xl p-4 bg-white/[0.02] mb-4">
          <div className="text-[10px] font-mono text-white/35 tracking-widest mb-4">NEXUS DAG EXECUTION</div>
          <div className="space-y-2">
            {NODES.map((n) => {
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
          <div className="text-[10px] font-mono text-violet-400/80 tracking-widest mb-3">
            {phase === 'failed' ? 'NEXUS EXECUTION — PARTIAL' : 'EXECUTED ON-CHAIN VIA NEXUS'}
          </div>

          {result.executionId && (
            <a href={suiscanObject(result.executionId)} target="_blank" rel="noreferrer"
               className="block rounded-lg border border-violet-400/40 bg-black/40 p-3 mb-3 hover:border-violet-400/70 transition-colors group">
              <div className="text-[9px] font-mono text-violet-400/70 tracking-widest mb-1 flex items-center gap-1.5">
                NEXUS DAG EXECUTION ID <ExternalLink size={10} className="opacity-60 group-hover:opacity-100" />
              </div>
              <div className="text-[12px] font-mono text-violet-300 break-all leading-relaxed">{result.executionId}</div>
            </a>
          )}

          <div className="space-y-2 text-[10px] font-mono">
            <div className="text-white/40">DAG: <span className="text-white/70 break-all">{result.dagId}</span></div>
            {result.checkpoint && (
              <div className="text-white/40">checkpoint: <span className="text-white/70">{result.checkpoint}</span></div>
            )}
            {result.digest && (
              <div className="text-white/40">
                tx:{' '}
                <a href={suiscanTx(result.digest)} target="_blank" rel="noreferrer"
                   className="inline-flex items-center gap-1.5 text-violet-400 hover:text-violet-300 break-all">
                  {result.digest} <ExternalLink size={11} />
                </a>
              </div>
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
