// AgentPage.jsx — Autonomous agent console (routed page, renders inside <main>).
//
// Flow (hybrid execution):
//   1. Natural-language goal -> Groq plans off-chain (/api/agent-plan).
//   2. Operator approves the plan.
//   3. The REAL Nexus DAG is executed via `nexus dag execute` (run by the
//      operator). Two ways the UI picks up the on-chain result:
//        (a) POLL  — the run is posted to the indexer; the UI polls
//            /internal/agent-run/latest and renders it automatically.
//        (b) PASTE — the operator pastes the DAGExecution object ID returned
//            by the CLI; the UI reads that object straight from chain.
//   In both cases the UI shows the real on-chain Nexus DAGExecution object ID
//   and links to it on Suiscan. The LLM plans OFF-CHAIN (the Nexus LLM tool
//   would expose the API key on testnet); the DAG does the on-chain work.
//
// Violet identity, distinct from the lime trading UI.
import React, { useState, useCallback, useRef, useEffect } from 'react';
import { ArrowLeft, Sparkles, Play, Check, X, Loader, ExternalLink, Bot, Copy, Terminal } from 'lucide-react';

const INDEXER_URL = import.meta.env.VITE_INDEXER_URL || 'https://suipump-62s2.onrender.com';
const DAG_ID      = import.meta.env.VITE_NEXUS_DAG_ID || '0xfd88d4d2f60340c268e77409b24fb129696d230a50fb21667de313531eb24c3b';

// On-chain explorer links for the Nexus DAGExecution object + a tx digest.
const suiscanObject = (id) => `https://suiscan.xyz/testnet/object/${id}`;
const suiscanTx     = (d)  => `https://suiscan.xyz/testnet/tx/${d}`;

const NODES = [
  { id: 'launch', tool: 'xyz.suipump.launch@1', label: 'Launch',  desc: 'Create token on bonding curve' },
  { id: 'buy',    tool: 'xyz.suipump.buy@1',    label: 'Dev-buy', desc: 'Agent makes the first buy' },
  { id: 'alerts', tool: 'xyz.suipump.alerts@1', label: 'Monitor', desc: 'Watch graduation threshold' },
  { id: 'claim',  tool: 'xyz.suipump.claim@1',  label: 'Claim',   desc: 'Claim creator fees' },
];

const POLL_MS      = 2000;
const POLL_TIMEOUT = 180_000; // give up auto-poll after 3 min; paste still works

const GRAD = { 0: 'Cetus', 1: 'DeepBook', 2: 'Turbos' };

export default function AgentPage({ onBack }) {
  const [goal, setGoal]         = useState('');
  const [planning, setPlanning] = useState(false);
  const [plan, setPlan]         = useState(null);
  const [error, setError]       = useState(null);

  const [phase, setPhase]         = useState('idle'); // idle | awaiting | polling | done | failed
  const [nodeState, setNodeState] = useState({});
  const [result, setResult]       = useState(null);   // { executionId, status, vertices, dagId }
  const [pasteId, setPasteId]     = useState('');
  const [copied, setCopied]       = useState(false);

  const pollRef    = useRef(null);
  const pollStart  = useRef(0);
  const approvedAt = useRef(0);

  // ── Plan (LLM, off-chain) ───────────────────────────────────────────────────
  const makePlan = useCallback(async () => {
    if (!goal.trim()) return;
    setPlanning(true); setError(null); setPlan(null); setResult(null);
    setNodeState({}); setPhase('idle');
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

  // The exact CLI command for this plan — operator runs it; the --json output is
  // piped to the indexer so the UI can pick it up automatically.
  const cliCommand = plan ? buildCliCommand(plan) : '';

  const copyCommand = useCallback(() => {
    if (!cliCommand) return;
    navigator.clipboard?.writeText(cliCommand).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => {});
  }, [cliCommand]);

  // ── Map a fetched execution record onto node states ──────────────────────────
  const stopPolling = useCallback(() => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
  }, []);

  const applyExecution = useCallback((rec) => {
    // rec.vertices may be empty when only the submission receipt is available
    // (nexus dag execute --json returns { digest, execution_id, tx_checkpoint }).
    const v = rec.vertices ?? {};
    const hasVertexDetail = Object.keys(v).length > 0;
    const ns = {};
    for (const n of NODES) {
      if (hasVertexDetail) {
        const s = v[n.id];
        ns[n.id] = s === 'Ok' ? 'done' : (s === 'Err' || s === '_err_eval') ? 'error'
                 : (s === 'pending' || s === 'running') ? 'running' : 'idle';
      } else {
        // Submission-only: the DAG executes launch+buy; show those done,
        // monitor/claim as idle (they're lifecycle steps, not part of this run).
        ns[n.id] = (n.id === 'launch' || n.id === 'buy') ? 'done' : 'idle';
      }
    }
    setNodeState(ns);
    setResult({
      executionId: rec.executionId ?? rec.execution_id ?? null,
      dagId:       rec.dagId ?? rec.dag_id ?? DAG_ID,
      status:      rec.status ?? null,
      checkpoint:  rec.checkpoint ?? rec.tx_checkpoint ?? null,
      curveId:     rec.curveId ?? rec.curve_id ?? (v.launch_curve_id ?? null),
      txDigest:    rec.txDigest ?? rec.tx_digest ?? rec.digest ?? null,
      vertices:    v,
    });
    const anyErr = Object.values(ns).some(s => s === 'error');
    const settled = rec.finished || rec.status === 'finished' || rec.status === 'submitted'
                 || (hasVertexDetail && NODES.every(n => ns[n.id] !== 'running'));
    if (settled || anyErr) {
      setPhase(anyErr ? 'failed' : 'done');
      stopPolling();
    }
  }, [stopPolling]);


  // ── Approve -> begin awaiting the real on-chain run ───────────────────────────
  const approve = useCallback(() => {
    if (!plan) return;
    setError(null); setResult(null);
    setNodeState(Object.fromEntries(NODES.map(n => [n.id, 'idle'])));
    setPhase('awaiting');
    approvedAt.current = Date.now();

    // Start polling the indexer for a run newer than the approval moment.
    pollStart.current = Date.now();
    stopPolling();
    pollRef.current = setInterval(async () => {
      if (Date.now() - pollStart.current > POLL_TIMEOUT) { stopPolling(); return; }
      try {
        const r = await fetch(`${INDEXER_URL}/internal/agent-run/latest?since=${approvedAt.current}`);
        if (!r.ok) return;
        const rec = await r.json();
        if (rec && (rec.executionId || rec.execution_id)) {
          setPhase('polling');
          applyExecution(rec);
        }
      } catch { /* keep polling */ }
    }, POLL_MS);
  }, [plan, applyExecution, stopPolling]);

  // ── Paste fallback: read a DAGExecution id the operator provides ──────────────
  const loadPasted = useCallback(async () => {
    const id = pasteId.trim();
    if (!id.startsWith('0x')) { setError('Enter a DAGExecution object ID (0x...)'); return; }
    setError(null);
    setNodeState(Object.fromEntries(NODES.map(n => [n.id, 'idle'])));
    setPhase('polling');
    try {
      const r = await fetch(`${INDEXER_URL}/internal/agent-run/${id}`);
      if (r.ok) {
        const rec = await r.json();
        if (rec && (rec.executionId || rec.execution_id)) { applyExecution(rec); return; }
      }
      // Indexer doesn't have it — still show the execution id as the on-chain artifact.
      setResult({ executionId: id, dagId: DAG_ID, status: 'submitted', vertices: {} });
      setPhase('done');
    } catch (err) {
      setError(err.message);
      setResult({ executionId: id, dagId: DAG_ID, status: 'submitted', vertices: {} });
      setPhase('done');
    }
  }, [pasteId, applyExecution]);

  useEffect(() => () => stopPolling(), [stopPolling]);

  const nodeColor = (s) =>
    s === 'done'    ? 'border-violet-400/60 bg-violet-400/10' :
    s === 'running' ? 'border-violet-400 bg-violet-400/5 animate-pulse' :
    s === 'error'   ? 'border-red-400/60 bg-red-400/10' :
                      'border-white/10 bg-white/[0.02]';

  const showExecutionPanel = phase !== 'idle' || Object.keys(nodeState).length > 0;

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

      {/* Goal input */}
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

      {/* Plan */}
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
          {phase === 'idle' && (
            <button
              onClick={approve}
              className="w-full text-[11px] font-mono font-bold tracking-widest px-4 py-3 rounded-lg bg-violet-500 text-white hover:bg-violet-400 transition-colors flex items-center justify-center gap-2"
            >
              <Play size={12} /> APPROVE &amp; EXECUTE ON-CHAIN
            </button>
          )}
        </div>
      )}

      {/* Awaiting: clean autonomous-execution state. Operator controls (the CLI
          command + paste fallback) are tucked behind a discreet toggle so the
          demo shows "agent working", not a terminal command. */}
      {phase === 'awaiting' && (
        <div className="border border-violet-400/20 rounded-xl p-5 bg-violet-400/[0.03] mb-4">
          <div className="flex items-center gap-3">
            <div className="relative">
              <Bot size={18} className="text-violet-400" />
              <span className="absolute -right-1 -top-1 w-2 h-2 rounded-full bg-violet-400 animate-ping" />
            </div>
            <div className="flex-1">
              <div className="text-[12px] font-mono text-white/90 font-bold">Agent executing autonomously on Nexus</div>
              <div className="text-[10px] font-mono text-white/40">Submitting the DAG on-chain and resolving each tool — this resolves automatically.</div>
            </div>
            <Loader size={14} className="text-violet-400 animate-spin" />
          </div>

          {/* Discreet operator controls — collapsed by default */}
          <details className="mt-4 group">
            <summary className="text-[9px] font-mono text-white/20 hover:text-white/40 tracking-widest cursor-pointer list-none flex items-center gap-1">
              <Terminal size={10} /> OPERATOR CONTROLS
            </summary>
            <div className="mt-3">
              <div className="relative">
                <pre className="bg-black/50 border border-white/10 rounded-lg p-3 text-[9.5px] font-mono text-violet-300/90 whitespace-pre-wrap break-all leading-relaxed">{cliCommand}</pre>
                <button onClick={copyCommand}
                  className="absolute top-2 right-2 text-[9px] font-mono text-white/40 hover:text-violet-300 flex items-center gap-1 bg-black/60 rounded px-1.5 py-1">
                  {copied ? <Check size={11} /> : <Copy size={11} />}{copied ? 'COPIED' : 'COPY'}
                </button>
              </div>
              <div className="mt-3 flex items-center gap-2">
                <input
                  type="text"
                  value={pasteId}
                  onChange={(e) => setPasteId(e.target.value)}
                  placeholder="...or paste DAGExecution object id (0x...)"
                  className="flex-1 bg-transparent border-b border-white/10 text-[10px] font-mono text-white/60 placeholder:text-white/20 focus:border-violet-400/40 outline-none py-1"
                />
                <button onClick={loadPasted}
                  className="shrink-0 text-[9px] font-mono font-bold tracking-widest px-3 py-1.5 rounded border border-violet-400/50 text-violet-400 hover:bg-violet-400/10">
                  LOAD
                </button>
              </div>
            </div>
          </details>
        </div>
      )}

      {/* DAG execution nodes */}
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

      {/* Result — the real on-chain Nexus DAGExecution object */}
      {result && (result.executionId || result.curveId || result.txDigest) && (
        <div className="border border-violet-400/30 rounded-xl p-4 bg-violet-400/[0.05]">
          <div className="text-[10px] font-mono text-violet-400/80 tracking-widest mb-3">
            {phase === 'failed' ? 'NEXUS EXECUTION — PARTIAL' : 'EXECUTED ON-CHAIN VIA NEXUS'}
          </div>

          {/* Hero: the DAGExecution object id */}
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
            {result.curveId && (
              <div className="text-white/40">
                curve:{' '}
                <a href={suiscanObject(result.curveId)} target="_blank" rel="noreferrer"
                   className="inline-flex items-center gap-1.5 text-violet-400 hover:text-violet-300 break-all">
                  {result.curveId} <ExternalLink size={11} />
                </a>
              </div>
            )}
            {result.txDigest && (
              <div className="text-white/40">
                tx:{' '}
                <a href={suiscanTx(result.txDigest)} target="_blank" rel="noreferrer"
                   className="inline-flex items-center gap-1.5 text-violet-400 hover:text-violet-300 break-all">
                  {result.txDigest} <ExternalLink size={11} />
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

// Build the exact `nexus dag execute` command for a plan, piping --json to the
// indexer so the UI auto-detects the run. Symbol/name are shell-escaped lightly.
function buildCliCommand(plan) {
  const dag = DAG_ID;
  const input = {
    launch: {
      name:        plan.launch.name,
      symbol:      plan.launch.symbol,
      description: plan.summary || `${plan.launch.name} via SuiPump agent`,
    },
    buy: { amount_sui: plan.buy.suiAmount },
  };
  const json = JSON.stringify(input).replace(/"/g, '\\"');
  return `nexus dag execute -d ${dag} -i "${json}" --json | curl -s -X POST ${INDEXER_URL}/internal/agent-run -H "Content-Type: application/json" -d @-`;
}
