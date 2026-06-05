// AgentPage.jsx — Autonomous agent console (routed page, renders inside <main>).
// Flow: natural-language goal -> Groq plans off-chain -> operator approves ->
// bridge runs the REAL Nexus DAG (`nexus dag execute`) -> nodes animate and the
// real Nexus tx digest is shown. Its own violet identity, distinct from the
// lime trading UI -- same "own world" feel as Strategies.
//
// Honest framing: the LLM plans off-chain (the Nexus LLM tool would expose the
// API key on testnet); the on-chain work runs through the published Nexus DAG.
import React, { useState, useCallback, useRef } from 'react';
import { ArrowLeft, Sparkles, Play, Check, X, Loader, ExternalLink, Bot } from 'lucide-react';

const BRIDGE_URL = import.meta.env.VITE_BRIDGE_URL   || 'https://suipump-bridge.onrender.com';
const DAG_ID     = import.meta.env.VITE_NEXUS_DAG_ID || '0xfd88d4d2f60340c268e77409b24fb129696d230a50fb21667de313531eb24c3b';

const NODES = [
  { id: 'launch', tool: 'xyz.suipump.launch@1', label: 'Launch',  desc: 'Create token on bonding curve' },
  { id: 'buy',    tool: 'xyz.suipump.buy@1',    label: 'Dev-buy', desc: 'Agent makes the first buy' },
  { id: 'alerts', tool: 'xyz.suipump.alerts@1', label: 'Monitor', desc: 'Watch graduation threshold' },
  { id: 'claim',  tool: 'xyz.suipump.claim@1',  label: 'Claim',   desc: 'Claim creator fees' },
];

const suiscanTx = (d) => `https://suiscan.xyz/testnet/tx/${d}`;

export default function AgentPage({ onBack }) {
  const [goal, setGoal]         = useState('');
  const [planning, setPlanning] = useState(false);
  const [plan, setPlan]         = useState(null);
  const [error, setError]       = useState(null);

  const [running, setRunning]     = useState(false);
  const [nodeState, setNodeState] = useState({});
  const [result, setResult]       = useState(null);
  const stagedCurve = useRef('');

  const makePlan = useCallback(async () => {
    if (!goal.trim()) return;
    setPlanning(true); setError(null); setPlan(null); setResult(null); setNodeState({});
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
  }, [goal]);

  const execute = useCallback(async () => {
    if (!plan) return;
    setRunning(true); setError(null); setResult(null);

    const input = {
      launch: {
        name:             plan.launch.name,
        symbol:           plan.launch.symbol,
        graduationTarget: plan.launch.graduationTarget,
        devBuyMist:       plan.launch.devBuyMist ?? 0,
        antiBotDelay:     plan.launch.antiBotDelay ?? 0,
      },
      buy:    { suiAmount: plan.buy.suiAmount, minTokensOut: 0 },
      alerts: { watchGraduation: true, pollIntervalMs: 30000 },
      claim:  {},
    };

    const staged      = stagedCurve.current.trim();
    const usingStaged = staged.startsWith('0x');
    const order       = usingStaged ? ['buy', 'alerts', 'claim'] : NODES.map(n => n.id);
    setNodeState(Object.fromEntries(order.map(id => [id, 'idle'])));

    const timers = [];
    order.forEach((id, i) => {
      timers.push(setTimeout(() => {
        setNodeState(prev => ({
          ...prev,
          ...(i > 0 ? { [order[i - 1]]: 'done' } : {}),
          [id]: 'running',
        }));
      }, i * 1200));
    });

    try {
      const payload = usingStaged
        ? { input: { ...input, launch: undefined }, dagId: DAG_ID, stagedCurve: staged }
        : { input, dagId: DAG_ID };
      const res  = await fetch(`${BRIDGE_URL}/run-dag`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      timers.forEach(clearTimeout);
      if (!res.ok || data.ok === false) throw new Error(data.error || 'DAG execution failed');

      setNodeState(Object.fromEntries(order.map(id => [id, 'done'])));
      setResult({ dagId: data.dagId, txDigest: data.txDigest, executionId: data.executionId });
    } catch (err) {
      timers.forEach(clearTimeout);
      setNodeState(prev => {
        const next = { ...prev };
        const runningId = Object.keys(next).find(k => next[k] === 'running');
        if (runningId) next[runningId] = 'error';
        return next;
      });
      setError(err.message);
    } finally {
      setRunning(false);
    }
  }, [plan]);

  const nodeColor = (s) =>
    s === 'done'    ? 'border-violet-400/60 bg-violet-400/10' :
    s === 'running' ? 'border-violet-400 bg-violet-400/5 animate-pulse' :
    s === 'error'   ? 'border-red-400/60 bg-red-400/10' :
                      'border-white/10 bg-white/[0.02]';

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
          State a goal in plain language. The agent plans with an LLM, then executes the full token lifecycle on-chain through a Nexus DAG -- launch, dev-buy, monitor, claim.
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
        <div className="flex items-center justify-between mt-3 gap-3">
          <input
            type="text"
            placeholder="(optional) pre-staged curve 0x... for fallback"
            onChange={(e) => { stagedCurve.current = e.target.value; }}
            className="flex-1 bg-transparent border-b border-white/10 text-[10px] font-mono text-white/50 placeholder:text-white/20 focus:border-violet-400/40 outline-none py-1"
          />
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
            <div>graduates to: <span className="text-white/80">{({0:'Cetus',1:'DeepBook',2:'Turbos'})[plan.launch.graduationTarget] ?? 'Turbos'}</span></div>
          </div>
          {!running && !result && (
            <button
              onClick={execute}
              className="w-full text-[11px] font-mono font-bold tracking-widest px-4 py-3 rounded-lg bg-violet-500 text-white hover:bg-violet-400 transition-colors flex items-center justify-center gap-2"
            >
              <Play size={12} /> APPROVE &amp; EXECUTE ON-CHAIN
            </button>
          )}
        </div>
      )}

      {(running || result || Object.keys(nodeState).length > 0) && (
        <div className="border border-white/10 rounded-xl p-4 bg-white/[0.02] mb-4">
          <div className="text-[10px] font-mono text-white/35 tracking-widest mb-4">NEXUS DAG EXECUTION</div>
          <div className="space-y-2">
            {NODES.filter(n => n.id in nodeState).map((n) => {
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

      {result && (
        <div className="border border-violet-400/30 rounded-xl p-4 bg-violet-400/[0.05]">
          <div className="text-[10px] font-mono text-violet-400/80 tracking-widest mb-3">EXECUTED ON-CHAIN VIA NEXUS</div>
          <div className="space-y-2 text-[10px] font-mono">
            <div className="text-white/40">DAG: <span className="text-white/70 break-all">{result.dagId}</span></div>
            {result.executionId && (
              <div className="text-white/40">execution: <span className="text-white/70 break-all">{result.executionId}</span></div>
            )}
            {result.txDigest && (
              <a href={suiscanTx(result.txDigest)} target="_blank" rel="noreferrer"
                 className="inline-flex items-center gap-1.5 text-violet-400 hover:text-violet-300 break-all">
                {result.txDigest} <ExternalLink size={11} />
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
