// v19-save-and-run
// StrategiesModal.jsx
// Strategy hooks (useSniper, useDCA, useCopyTrade) are passed in as props
// from App.jsx where they live permanently — closing this modal does NOT
// stop strategies. Each tab has an explicit "Save & Run in Background" button.

import React, { useState, useEffect, useCallback } from 'react';
import { useCurrentAccount } from '@mysten/dapp-kit-react';
import { X, Key, Eye, EyeOff, Trash2, CheckCircle2, Loader2, AlertTriangle,
         Zap, Crosshair, ToggleLeft, ToggleRight, ExternalLink, Play, Save } from 'lucide-react';
import { INTERVAL_OPTIONS } from './useDCA.js';
import { loadTPSL, clearTPSL } from './useTPSL.js';

const INDEXER_URL = import.meta.env.VITE_INDEXER_URL || '';

// ── Helper ────────────────────────────────────────────────────────────────────
function loadAllTPSL(walletAddress) {
  if (!walletAddress) return [];
  const configs = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key?.startsWith(`suipump_tpsl_${walletAddress}_`)) continue;
    try {
      const curveId = key.replace(`suipump_tpsl_${walletAddress}_`, '');
      const config  = JSON.parse(localStorage.getItem(key) || '{}');
      if (config.enabled) configs.push({ curveId, config });
    } catch {}
  }
  return configs;
}

function StatusIcon({ status }) {
  if (status === 'signing' || status === 'encrypting' || status === 'decrypting')
    return <Loader2 size={14} className="animate-spin text-lime-400" />;
  if (status === 'ready')  return <CheckCircle2 size={14} className="text-lime-400" />;
  if (status === 'error')  return <AlertTriangle size={14} className="text-red-400" />;
  return null;
}

// ── Shared: Save & Run button ─────────────────────────────────────────────────
function SaveRunButton({ onClick, active, label = 'Save & Run in Background', disabled = false }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`w-full py-3 rounded-xl text-[11px] font-mono font-bold transition-all flex items-center justify-center gap-2 ${
        disabled
          ? 'bg-white/5 text-white/20 cursor-not-allowed'
          : active
          ? 'bg-lime-950/40 border border-lime-400/40 text-lime-400 hover:bg-lime-950/60'
          : 'bg-lime-400 text-black hover:bg-lime-300'
      }`}
    >
      {active
        ? <><span className="w-2 h-2 rounded-full bg-lime-400 animate-pulse" />{label}</>
        : <><Play size={12} />{label}</>
      }
    </button>
  );
}

// ── Trading Key tab ───────────────────────────────────────────────────────────
function TradingKeyTab({ hasKey, keypair, status, error, saveKey, loadKey, removeKey, isReady }) {
  const [input,   setInput]   = useState('');
  const [showKey, setShowKey] = useState(false);
  const [msg,     setMsg]     = useState('');

  const handleSave = async () => {
    if (!input.trim()) return;
    try {
      await saveKey(input.trim());
      setInput('');
      setMsg('Trading key saved and encrypted ✓');
      setTimeout(() => setMsg(''), 3000);
    } catch (e) { setMsg(e.message); setTimeout(() => setMsg(''), 4000); }
  };

  const handleLoad = async () => {
    try {
      await loadKey();
      setMsg('Key unlocked — strategies active ✓');
      setTimeout(() => setMsg(''), 3000);
    } catch (e) { setMsg(e.message); setTimeout(() => setMsg(''), 4000); }
  };

  const handleRemove = async () => {
    if (!window.confirm('Remove trading key? Strategies will stop.')) return;
    try { await removeKey(); setMsg('Key removed'); setTimeout(() => setMsg(''), 2000); }
    catch (e) { setMsg(e.message); }
  };

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <div className="text-[9px] font-mono text-white/30 tracking-widest">TRADING KEY</div>
        <p className="text-[10px] font-mono text-white/40 leading-relaxed">
          A dedicated hot wallet that signs sniper/DCA/copy trades automatically — no Slush popup.
          Strategies run in the background even when this modal is closed.
        </p>
        <p className="text-[9px] font-mono text-white/20 leading-relaxed">
          Encrypted with your Slush signature, stored in localStorage only.
        </p>
      </div>

      {hasKey && (
        <div className={`rounded-xl border p-3 flex items-center justify-between ${
          isReady ? 'border-lime-400/25 bg-lime-950/15' : 'border-white/8 bg-white/[0.02]'
        }`}>
          <div className="flex items-center gap-2">
            <StatusIcon status={status} />
            <span className="text-[10px] font-mono text-white/60">
              {isReady ? 'Key unlocked — strategies active' : 'Key saved — locked'}
            </span>
          </div>
          <div className="flex items-center gap-2">
            {!isReady && (
              <button onClick={handleLoad} disabled={status === 'signing' || status === 'decrypting'}
                className="text-[9px] font-mono text-lime-400 hover:text-lime-300 transition-colors disabled:opacity-40">
                UNLOCK
              </button>
            )}
            <button onClick={handleRemove} className="text-white/20 hover:text-red-400 transition-colors">
              <Trash2 size={11} />
            </button>
          </div>
        </div>
      )}

      <div className="space-y-2">
        <div className="text-[9px] font-mono text-white/30 tracking-widest">
          {hasKey ? 'REPLACE TRADING KEY' : 'PASTE PRIVATE KEY'}
        </div>
        <div className="relative">
          <input
            type={showKey ? 'text' : 'password'}
            value={input}
            onChange={e => setInput(e.target.value)}
            placeholder="0x... or suiprivkey..."
            className="w-full bg-white/[0.04] border border-white/10 rounded-xl px-4 py-3 text-[11px] font-mono text-white placeholder-white/15 focus:outline-none focus:border-lime-400/30 transition-colors pr-10"
          />
          <button onClick={() => setShowKey(s => !s)}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-white/20 hover:text-white/50 transition-colors">
            {showKey ? <EyeOff size={12} /> : <Eye size={12} />}
          </button>
        </div>
        <button onClick={handleSave}
          disabled={!input.trim() || status === 'signing' || status === 'encrypting'}
          className={`w-full py-2.5 rounded-xl text-[11px] font-mono font-bold transition-colors flex items-center justify-center gap-2 ${
            !input.trim() || status === 'signing' || status === 'encrypting'
              ? 'bg-white/5 text-white/20 cursor-not-allowed'
              : 'bg-lime-400 text-black hover:bg-lime-300'
          }`}>
          {(status === 'signing' || status === 'encrypting')
            ? <><Loader2 size={12} className="animate-spin" /> {status === 'signing' ? 'Sign in Slush…' : 'Encrypting…'}</>
            : <><Key size={12} /> SAVE & ENCRYPT KEY</>
          }
        </button>
      </div>

      {(msg || error) && (
        <div className={`text-[10px] font-mono text-center ${msg.includes('✓') ? 'text-lime-400' : 'text-red-400'}`}>
          {msg || error}
        </div>
      )}
      <div className="text-[8px] font-mono text-white/15 leading-relaxed text-center">
        Slush: Settings → Security → Export Private Key · Use a dedicated wallet with limited funds only
      </div>
    </div>
  );
}

// ── Sniper tab ────────────────────────────────────────────────────────────────
function SniperTab({ sniper, hasKey, isReady, onClose }) {
  const account = useCurrentAccount();
  const { config, updateConfig, enable, disable, log, clearLog, sniping, isActive } = sniper;
  const [saved, setSaved] = useState(false);

  const handleSaveRun = useCallback(() => {
    enable();
    setSaved(true);
    setTimeout(() => { setSaved(false); onClose(); }, 900);
  }, [enable, onClose]);

  const handleStop = useCallback(() => {
    disable();
  }, [disable]);

  if (!account) return (
    <div className="py-12 text-center text-[11px] font-mono text-white/30">
      Connect your wallet to use the sniper
    </div>
  );
  if (!hasKey || !isReady) return (
    <div className="py-12 text-center space-y-2">
      <Crosshair size={24} className="text-white/10 mx-auto" />
      <div className="text-[11px] font-mono text-white/25">Trading key required</div>
      <div className="text-[9px] font-mono text-white/15">Set up your trading key in the Key tab first</div>
    </div>
  );

  return (
    <div className="space-y-4">
      {/* Status pill */}
      <div className={`rounded-xl border p-3 flex items-center justify-between ${
        isActive ? 'border-lime-400/25 bg-lime-950/10' : 'border-white/8 bg-white/[0.02]'
      }`}>
        <div className="flex items-center gap-2">
          {sniping
            ? <Loader2 size={13} className="animate-spin text-lime-400" />
            : <span className={`w-2 h-2 rounded-full ${isActive ? 'bg-lime-400 animate-pulse' : 'bg-white/15'}`} />
          }
          <span className="text-[11px] font-mono font-bold text-white">
            {sniping ? 'Sniping…' : isActive ? 'Running in background' : 'Sniper off'}
          </span>
          {isActive && !sniping && (
            <span className="text-[9px] font-mono text-white/30">watching for new tokens</span>
          )}
        </div>
        {isActive && (
          <button onClick={handleStop}
            className="text-[9px] font-mono text-red-400/60 hover:text-red-400 transition-colors">
            STOP
          </button>
        )}
      </div>

      {/* Config */}
      <div className="space-y-3">
        <div className="text-[9px] font-mono text-white/30 tracking-widest">CONFIG</div>

        <div className="flex items-center justify-between gap-3">
          <span className="text-[10px] font-mono text-white/50">Max SUI per snipe</span>
          <div className="relative w-28">
            <input type="number" min="0.1" step="0.1"
              value={config.maxSuiPerSnipe}
              onChange={e => updateConfig({ maxSuiPerSnipe: parseFloat(e.target.value) || 1 })}
              className="w-full bg-white/5 border border-white/10 rounded-lg px-2 py-1.5 text-[11px] font-mono text-white text-right focus:outline-none focus:border-lime-400/40" />
            <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[8px] font-mono text-white/20 pointer-events-none">SUI</span>
          </div>
        </div>

        <div className="flex items-center justify-between gap-3">
          <span className="text-[10px] font-mono text-white/50">Max dev buy %</span>
          <div className="relative w-28">
            <input type="number" min="0" max="100" step="1"
              value={config.maxDevBuyPct}
              onChange={e => updateConfig({ maxDevBuyPct: parseFloat(e.target.value) || 0 })}
              className="w-full bg-white/5 border border-white/10 rounded-lg px-2 py-1.5 text-[11px] font-mono text-white text-right focus:outline-none focus:border-lime-400/40" />
            <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[8px] font-mono text-white/20 pointer-events-none">%</span>
          </div>
        </div>

        <div className="flex items-center justify-between gap-3">
          <span className="text-[10px] font-mono text-white/50">Slippage</span>
          <div className="relative w-28">
            <input type="number" min="0.1" max="50" step="0.1"
              value={config.slippage}
              onChange={e => updateConfig({ slippage: parseFloat(e.target.value) || 5 })}
              className="w-full bg-white/5 border border-white/10 rounded-lg px-2 py-1.5 text-[11px] font-mono text-white text-right focus:outline-none focus:border-lime-400/40" />
            <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[8px] font-mono text-white/20 pointer-events-none">%</span>
          </div>
        </div>

        <div className="flex items-center justify-between gap-3">
          <span className="text-[10px] font-mono text-white/50">Keyword filter</span>
          <input type="text" placeholder="any" value={config.keyword ?? ''}
            onChange={e => updateConfig({ keyword: e.target.value })}
            className="w-28 bg-white/5 border border-white/10 rounded-lg px-2 py-1.5 text-[11px] font-mono text-white text-right focus:outline-none focus:border-lime-400/40" />
        </div>

        {/* Auto TP/SL row */}
        <div className="rounded-xl border border-white/8 p-3 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-mono text-white/50">Auto TP/SL after snipe</span>
            <button onClick={() => updateConfig({ autoTPSL: !(config.autoTPSL ?? true) })}>
              {(config.autoTPSL ?? true)
                ? <ToggleRight size={18} className="text-lime-400" />
                : <ToggleLeft  size={18} className="text-white/20" />
              }
            </button>
          </div>
          {(config.autoTPSL ?? true) && (
            <div className="grid grid-cols-2 gap-2 pt-1">
              <div className="space-y-1">
                <label className="text-[8px] font-mono text-white/25">TAKE PROFIT %</label>
                <input type="number" value={config.tpPct ?? 200}
                  onChange={e => updateConfig({ tpPct: parseFloat(e.target.value) || 200 })}
                  className="w-full bg-white/[0.04] border border-white/8 rounded-lg px-2 py-1 text-[10px] font-mono text-white focus:outline-none" />
              </div>
              <div className="space-y-1">
                <label className="text-[8px] font-mono text-white/25">STOP LOSS %</label>
                <input type="number" value={config.slPct ?? -30}
                  onChange={e => updateConfig({ slPct: parseFloat(e.target.value) || -30 })}
                  className="w-full bg-white/[0.04] border border-white/8 rounded-lg px-2 py-1 text-[10px] font-mono text-white focus:outline-none" />
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Snipe log */}
      {log.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-[9px] font-mono text-white/30 tracking-widest">SNIPE LOG</span>
            <button onClick={clearLog} className="text-[9px] font-mono text-white/20 hover:text-red-400 transition-colors">clear</button>
          </div>
          <div className="space-y-1 max-h-28 overflow-y-auto">
            {log.slice(0, 8).map((entry, i) => (
              <div key={i} className="flex items-start justify-between gap-2 py-1 border-b border-white/[0.03]">
                <div className="min-w-0">
                  <span className={`text-[9px] font-mono ${entry.success ? 'text-white/70' : 'text-red-400/70'}`}>
                    {entry.success ? '✓' : '✗'} {entry.name} <span className="text-lime-400/70">${entry.symbol}</span>
                  </span>
                  <div className="text-[8px] text-white/20 mt-0.5">
                    {entry.suiSpent} SUI{entry.error && ` · ${entry.error}`}
                  </div>
                </div>
                {entry.digest && (
                  <a href={`https://suiexplorer.com/txblock/${entry.digest}?network=testnet`}
                    target="_blank" rel="noreferrer"
                    className="text-white/20 hover:text-lime-400 transition-colors shrink-0">
                    <ExternalLink size={10} />
                  </a>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Save & Run */}
      {saved ? (
        <div className="w-full py-3 rounded-xl bg-lime-950/40 border border-lime-400/40 text-lime-400 text-[11px] font-mono font-bold flex items-center justify-center gap-2">
          <CheckCircle2 size={13} /> Sniper running — closing modal…
        </div>
      ) : isActive ? (
        <div className="space-y-2">
          <div className="w-full py-2.5 rounded-xl bg-lime-950/30 border border-lime-400/25 text-lime-400/80 text-[10px] font-mono flex items-center justify-center gap-2">
            <span className="w-1.5 h-1.5 rounded-full bg-lime-400 animate-pulse" />
            Sniper is running in the background
          </div>
          <button onClick={onClose}
            className="w-full py-2.5 rounded-xl border border-white/10 text-white/40 text-[11px] font-mono font-bold hover:border-white/20 hover:text-white/60 transition-all">
            Close — sniper keeps running
          </button>
        </div>
      ) : (
        <SaveRunButton onClick={handleSaveRun} active={false} />
      )}
    </div>
  );
}

// ── DCA tab ───────────────────────────────────────────────────────────────────
function DCATab({ dca, hasKey, isReady, onClose }) {
  const account = useCurrentAccount();
  const { orders, activeOrders = [], doneOrders = [], createOrder, cancelOrder, clearDone } = dca;

  const [curveId,      setCurveId]      = useState('');
  const [totalSui,     setTotalSui]     = useState('10');
  const [tranches,     setTranches]     = useState('5');
  const [intervalMs,   setIntervalMs]   = useState(INTERVAL_OPTIONS[1]?.ms ?? 300_000);
  const [slippage,     setSlippage]     = useState('2');
  const [resolving,    setResolving]    = useState(false);
  const [resolvedName, setResolvedName] = useState('');
  const [resolvedSym,  setResolvedSym]  = useState('');
  const [resolvedType, setResolvedType] = useState('');
  const [resolvedPkg,  setResolvedPkg]  = useState('');
  const [formMsg,      setFormMsg]      = useState('');
  const [saved,        setSaved]        = useState(false);

  const resolveCurve = async (id) => {
    if (!id || id.length < 10) { setResolvedName(''); setResolvedType(''); return; }
    setResolving(true);
    try {
      const res = await fetch(`${INDEXER_URL}/token/${id}`, { signal: AbortSignal.timeout(5000) });
      if (res.ok) {
        const d = await res.json();
        setResolvedName(d.name   ?? '');
        setResolvedSym(d.symbol  ?? '');
        setResolvedType(d.token_type ?? d.tokenType ?? '');
        setResolvedPkg(d.package_id  ?? d.packageId  ?? '');
      }
    } catch {} finally { setResolving(false); }
  };

  const handleCreateAndRun = () => {
    if (!resolvedType || !resolvedPkg) { setFormMsg('Paste a valid curve ID first'); return; }
    const total = parseFloat(totalSui);
    const n     = parseInt(tranches);
    if (!total || total <= 0) { setFormMsg('Enter total SUI'); return; }
    if (!n || n < 2)          { setFormMsg('Minimum 2 tranches'); return; }

    createOrder({
      curveId: curveId.trim(), tokenType: resolvedType, pkgId: resolvedPkg,
      name: resolvedName, symbol: resolvedSym,
      totalSui: total, trancheCount: n,
      intervalMs: parseInt(intervalMs),
      slippage: parseFloat(slippage) || 2,
    });

    setSaved(true);
    setCurveId(''); setResolvedName(''); setResolvedType(''); setResolvedPkg('');
    setTotalSui('10'); setTranches('5');
    setTimeout(() => { setSaved(false); onClose(); }, 900);
  };

  if (!account) return (
    <div className="py-12 text-center text-[11px] font-mono text-white/30">Connect your wallet to use DCA</div>
  );
  if (!hasKey || !isReady) return (
    <div className="py-12 text-center space-y-2">
      <div className="text-[11px] font-mono text-white/25">Trading key required</div>
      <div className="text-[9px] font-mono text-white/15">Set up your trading key in the Key tab first</div>
    </div>
  );

  return (
    <div className="space-y-4">
      {/* Active orders */}
      {activeOrders.length > 0 && (
        <div className="space-y-2">
          <div className="text-[9px] font-mono text-white/30 tracking-widest">RUNNING ORDERS</div>
          {activeOrders.map(order => {
            const pct      = Math.round(((order.executed ?? order.tranchesFired ?? 0) / order.trancheCount) * 100);
            const interval = INTERVAL_OPTIONS.find(o => o.ms === order.intervalMs)?.label ?? `${order.intervalMs/60000}m`;
            const nextIn   = order.nextFireAt ? Math.max(0, Math.ceil((order.nextFireAt - Date.now()) / 1000)) : null;
            return (
              <div key={order.id} className="rounded-xl border border-lime-400/15 bg-lime-950/10 overflow-hidden">
                <div className="px-3 py-2.5 flex items-center justify-between">
                  <div className="min-w-0">
                    <div className="text-[10px] font-mono font-bold text-white truncate">
                      {order.name || order.curveId.slice(0,8)+'…'}
                      {order.symbol && <span className="text-lime-400/70 ml-1">${order.symbol}</span>}
                    </div>
                    <div className="text-[8px] font-mono text-white/30 mt-0.5">
                      {order.executed ?? order.tranchesFired ?? 0}/{order.trancheCount} tranches · {(order.totalSui/order.trancheCount).toFixed(2)} SUI each · every {interval}
                    </div>
                    {nextIn !== null && (
                      <div className="text-[8px] font-mono text-lime-400/50 mt-0.5">
                        next in {nextIn < 60 ? `${nextIn}s` : `${Math.ceil(nextIn/60)}m`}
                      </div>
                    )}
                  </div>
                  <button onClick={() => cancelOrder(order.id)}
                    className="text-white/20 hover:text-red-400 transition-colors ml-3 shrink-0">
                    <Trash2 size={11} />
                  </button>
                </div>
                <div className="h-1 bg-white/5">
                  <div className="h-full bg-lime-400/60 transition-all" style={{ width: `${pct}%` }} />
                </div>
              </div>
            );
          })}

          {/* Close — orders keep running */}
          <button onClick={onClose}
            className="w-full py-2.5 rounded-xl border border-white/10 text-white/40 text-[11px] font-mono font-bold hover:border-white/20 hover:text-white/60 transition-all">
            Close — orders keep running
          </button>
        </div>
      )}

      {/* New order form */}
      <div className="space-y-3">
        <div className="text-[9px] font-mono text-white/30 tracking-widest">NEW DCA ORDER</div>

        <div className="space-y-1">
          <label className="text-[9px] font-mono text-white/30">TOKEN CURVE ID</label>
          <input value={curveId}
            onChange={e => { setCurveId(e.target.value); setResolvedName(''); setResolvedType(''); }}
            onBlur={e => resolveCurve(e.target.value.trim())}
            placeholder="0x… paste from token page URL"
            className="w-full bg-white/[0.04] border border-white/8 rounded-lg px-3 py-1.5 text-[11px] font-mono text-white placeholder-white/15 focus:outline-none focus:border-lime-400/30" />
          {resolving && <div className="text-[8px] font-mono text-white/30">Resolving…</div>}
          {resolvedName && (
            <div className="text-[9px] font-mono text-lime-400">
              ✓ {resolvedName} <span className="text-white/40">${resolvedSym}</span>
            </div>
          )}
        </div>

        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1">
            <label className="text-[9px] font-mono text-white/30">TOTAL SUI</label>
            <input type="number" min="0.1" step="0.1" value={totalSui}
              onChange={e => setTotalSui(e.target.value)}
              className="w-full bg-white/[0.04] border border-white/8 rounded-lg px-3 py-1.5 text-[11px] font-mono text-white focus:outline-none focus:border-lime-400/30" />
          </div>
          <div className="space-y-1">
            <label className="text-[9px] font-mono text-white/30">TRANCHES</label>
            <input type="number" min="2" step="1" value={tranches}
              onChange={e => setTranches(e.target.value)}
              className="w-full bg-white/[0.04] border border-white/8 rounded-lg px-3 py-1.5 text-[11px] font-mono text-white focus:outline-none focus:border-lime-400/30" />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1">
            <label className="text-[9px] font-mono text-white/30">INTERVAL</label>
            <select value={intervalMs} onChange={e => setIntervalMs(parseInt(e.target.value))}
              className="w-full bg-white/[0.04] border border-white/8 rounded-lg px-3 py-1.5 text-[11px] font-mono text-white focus:outline-none focus:border-lime-400/30">
              {(INTERVAL_OPTIONS ?? []).map(o => (
                <option key={o.ms} value={o.ms} className="bg-[#0d0d0d]">{o.label}</option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <label className="text-[9px] font-mono text-white/30">SLIPPAGE %</label>
            <input type="number" min="0.1" max="50" step="0.1" value={slippage}
              onChange={e => setSlippage(e.target.value)}
              className="w-full bg-white/[0.04] border border-white/8 rounded-lg px-3 py-1.5 text-[11px] font-mono text-white focus:outline-none focus:border-lime-400/30" />
          </div>
        </div>

        {totalSui && tranches && parseFloat(totalSui) > 0 && parseInt(tranches) > 0 && (
          <div className="text-[9px] font-mono text-white/30 text-center">
            {(parseFloat(totalSui) / parseInt(tranches)).toFixed(3)} SUI every {INTERVAL_OPTIONS.find(o => o.ms === intervalMs)?.label ?? '?'}
          </div>
        )}

        {formMsg && (
          <div className={`text-[10px] font-mono text-center ${formMsg.includes('✓') ? 'text-lime-400' : 'text-red-400'}`}>
            {formMsg}
          </div>
        )}

        {saved ? (
          <div className="w-full py-3 rounded-xl bg-lime-950/40 border border-lime-400/40 text-lime-400 text-[11px] font-mono font-bold flex items-center justify-center gap-2">
            <CheckCircle2 size={13} /> DCA running — closing modal…
          </div>
        ) : (
          <SaveRunButton
            onClick={handleCreateAndRun}
            active={false}
            label="Save & Run in Background"
            disabled={!resolvedType}
          />
        )}
      </div>

      {/* Done orders */}
      {doneOrders.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-[9px] font-mono text-white/20 tracking-widest">COMPLETED</span>
            <button onClick={clearDone} className="text-[9px] font-mono text-white/20 hover:text-red-400 transition-colors">clear</button>
          </div>
          {doneOrders.map(order => (
            <div key={order.id} className="rounded-xl border border-white/5 px-3 py-2 text-[10px] font-mono text-white/30">
              ✓ {order.name || order.curveId.slice(0,8)+'…'} — {order.trancheCount} tranches · {order.totalSui} SUI total
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Copy Trade tab ────────────────────────────────────────────────────────────
function CopyTradeTab({ copyTrade, hasKey, isReady, onClose }) {
  const account = useCurrentAccount();
  const { targets = [], log = [], addTarget, removeTarget, toggleTarget, clearLog, isActive } = copyTrade;

  const [address,     setAddress]     = useState('');
  const [label,       setLabel]       = useState('');
  const [scaleSui,    setScaleSui]    = useState('1');
  const [mirrorSells, setMirrorSells] = useState(false);
  const [slippage,    setSlippage]    = useState('2');
  const [formMsg,     setFormMsg]     = useState('');
  const [saved,       setSaved]       = useState(false);

  const handleAddAndRun = () => {
    if (!address.trim() || !address.startsWith('0x')) {
      setFormMsg('Enter a valid Sui wallet address (0x…)'); return;
    }
    const sui = parseFloat(scaleSui);
    if (!sui || sui <= 0) { setFormMsg('Enter a valid SUI amount'); return; }

    addTarget(address.trim(), label.trim(), sui, mirrorSells, parseFloat(slippage) || 2);
    setAddress(''); setLabel('');
    setSaved(true);
    setTimeout(() => { setSaved(false); onClose(); }, 900);
  };

  if (!account) return (
    <div className="py-12 text-center text-[11px] font-mono text-white/30">Connect your wallet to use copy trading</div>
  );
  if (!hasKey || !isReady) return (
    <div className="py-12 text-center space-y-2">
      <div className="text-[11px] font-mono text-white/25">Trading key required</div>
      <div className="text-[9px] font-mono text-white/15">Set up your trading key in the Key tab first</div>
    </div>
  );

  return (
    <div className="space-y-4">
      {/* Active targets */}
      {targets.length > 0 && (
        <div className="space-y-2">
          <div className="text-[9px] font-mono text-white/30 tracking-widest">WATCHING</div>
          {targets.map(t => (
            <div key={t.address} className={`rounded-xl border px-3 py-2.5 flex items-center justify-between ${
              t.enabled ? 'border-lime-400/15 bg-lime-950/10' : 'border-white/8 bg-white/[0.02]'
            }`}>
              <div className="min-w-0">
                {t.label && <div className="text-[10px] font-mono font-bold text-white truncate">{t.label}</div>}
                <div className="text-[9px] font-mono text-white/30 truncate">{t.address.slice(0,8)}…{t.address.slice(-6)}</div>
                <div className="text-[8px] font-mono text-white/20 mt-0.5">
                  {t.scaleSui} SUI/buy{t.mirrorSells ? ' · mirror sells' : ''} · {t.slippage}% slip
                </div>
              </div>
              <div className="flex items-center gap-2 ml-3 shrink-0">
                <button onClick={() => toggleTarget(t.address)}>
                  {t.enabled
                    ? <ToggleRight size={18} className="text-lime-400" />
                    : <ToggleLeft  size={18} className="text-white/20" />
                  }
                </button>
                <button onClick={() => removeTarget(t.address)} className="text-white/20 hover:text-red-400 transition-colors">
                  <Trash2 size={11} />
                </button>
              </div>
            </div>
          ))}

          {/* Close — copy trade keeps running */}
          {isActive && (
            <button onClick={onClose}
              className="w-full py-2.5 rounded-xl border border-white/10 text-white/40 text-[11px] font-mono font-bold hover:border-white/20 hover:text-white/60 transition-all">
              Close — copy trading keeps running
            </button>
          )}
        </div>
      )}

      {/* Add wallet form */}
      <div className="space-y-3">
        <div className="text-[9px] font-mono text-white/30 tracking-widest">
          {targets.length > 0 ? 'ADD ANOTHER WALLET' : 'WATCH A WALLET'}
        </div>

        <input value={address} onChange={e => setAddress(e.target.value)}
          placeholder="0x… wallet to copy"
          className="w-full bg-white/[0.04] border border-white/8 rounded-lg px-3 py-1.5 text-[11px] font-mono text-white placeholder-white/15 focus:outline-none focus:border-lime-400/30" />

        <input value={label} onChange={e => setLabel(e.target.value)}
          placeholder="Label (optional, e.g. 'whale1')"
          className="w-full bg-white/[0.04] border border-white/8 rounded-lg px-3 py-1.5 text-[11px] font-mono text-white placeholder-white/15 focus:outline-none focus:border-lime-400/30" />

        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1">
            <label className="text-[9px] font-mono text-white/30">SUI PER BUY</label>
            <input type="number" min="0.1" step="0.1" value={scaleSui}
              onChange={e => setScaleSui(e.target.value)}
              className="w-full bg-white/[0.04] border border-white/8 rounded-lg px-3 py-1.5 text-[11px] font-mono text-white focus:outline-none" />
          </div>
          <div className="space-y-1">
            <label className="text-[9px] font-mono text-white/30">SLIPPAGE %</label>
            <input type="number" min="0.1" max="50" step="0.1" value={slippage}
              onChange={e => setSlippage(e.target.value)}
              className="w-full bg-white/[0.04] border border-white/8 rounded-lg px-3 py-1.5 text-[11px] font-mono text-white focus:outline-none" />
          </div>
        </div>

        <div className="flex items-center justify-between">
          <span className="text-[10px] font-mono text-white/40">Mirror sells too</span>
          <button onClick={() => setMirrorSells(v => !v)}>
            {mirrorSells
              ? <ToggleRight size={18} className="text-lime-400" />
              : <ToggleLeft  size={18} className="text-white/20" />
            }
          </button>
        </div>

        {formMsg && (
          <div className={`text-[10px] font-mono text-center ${formMsg.includes('✓') ? 'text-lime-400' : 'text-red-400'}`}>
            {formMsg}
          </div>
        )}

        {saved ? (
          <div className="w-full py-3 rounded-xl bg-lime-950/40 border border-lime-400/40 text-lime-400 text-[11px] font-mono font-bold flex items-center justify-center gap-2">
            <CheckCircle2 size={13} /> Copy trading running — closing modal…
          </div>
        ) : (
          <SaveRunButton
            onClick={handleAddAndRun}
            active={false}
            label="Save & Run in Background"
            disabled={!address.trim()}
          />
        )}
      </div>

      {/* Log */}
      {log.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-[9px] font-mono text-white/30 tracking-widest">COPY LOG</span>
            <button onClick={clearLog} className="text-[9px] font-mono text-white/20 hover:text-red-400 transition-colors">clear</button>
          </div>
          <div className="space-y-1 max-h-28 overflow-y-auto">
            {log.slice(0, 8).map((entry, i) => (
              <div key={i} className="text-[9px] font-mono py-1 border-b border-white/[0.03]">
                <span className={entry.success ? 'text-white/60' : 'text-red-400/60'}>
                  {entry.success ? '✓' : '✗'} {entry.action} {entry.name} — {entry.suiAmount} SUI
                </span>
                {entry.error && <div className="text-[8px] text-red-400/40">{entry.error}</div>}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Active strategies tab ─────────────────────────────────────────────────────
function ActiveStrategiesTab({ sniper, dca, copyTrade }) {
  const account = useCurrentAccount();
  const [tpslConfigs, setTpslConfigs] = useState([]);

  useEffect(() => {
    if (account?.address) setTpslConfigs(loadAllTPSL(account.address));
  }, [account?.address]);

  const handleClearTPSL = (curveId) => {
    clearTPSL(account.address, curveId);
    setTpslConfigs(prev => prev.filter(c => c.curveId !== curveId));
  };

  const hasAnything = sniper?.isActive || (dca?.activeOrders?.length ?? 0) > 0 || copyTrade?.isActive || tpslConfigs.length > 0;

  if (!account) return (
    <div className="py-12 text-center text-[11px] font-mono text-white/30">Connect your wallet</div>
  );
  if (!hasAnything) return (
    <div className="py-12 text-center space-y-2">
      <div className="text-[11px] font-mono text-white/20">No active strategies</div>
      <div className="text-[9px] font-mono text-white/15">Enable sniper, DCA, or copy trade to see them here</div>
    </div>
  );

  return (
    <div className="space-y-4">
      {/* Sniper status */}
      {sniper?.isActive && (
        <div className="rounded-xl border border-lime-400/20 bg-lime-950/10 px-3 py-2.5 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="w-1.5 h-1.5 rounded-full bg-lime-400 animate-pulse" />
            <span className="text-[10px] font-mono font-bold text-white">Sniper</span>
            <span className="text-[9px] font-mono text-white/30">watching for new tokens · {sniper.config?.maxSuiPerSnipe} SUI/snipe</span>
          </div>
          <button onClick={() => sniper.disable()} className="text-[9px] font-mono text-red-400/60 hover:text-red-400 transition-colors">STOP</button>
        </div>
      )}

      {/* DCA orders */}
      {(dca?.activeOrders?.length ?? 0) > 0 && (
        <div className="space-y-2">
          <div className="text-[9px] font-mono text-white/30 tracking-widest">DCA ORDERS</div>
          {dca.activeOrders.map(order => (
            <div key={order.id} className="rounded-xl border border-lime-400/15 bg-lime-950/10 px-3 py-2.5 flex items-center justify-between">
              <div className="min-w-0">
                <div className="text-[10px] font-mono font-bold text-white truncate">
                  {order.name || order.curveId.slice(0,8)+'…'}
                  {order.symbol && <span className="text-lime-400/70 ml-1">${order.symbol}</span>}
                </div>
                <div className="text-[8px] font-mono text-white/30 mt-0.5">
                  {order.executed ?? 0}/{order.trancheCount} tranches · {order.totalSui} SUI total
                </div>
              </div>
              <button onClick={() => dca.cancelOrder(order.id)} className="text-white/20 hover:text-red-400 transition-colors ml-3 shrink-0">
                <Trash2 size={11} />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Copy trade targets */}
      {copyTrade?.isActive && (copyTrade?.targets?.length ?? 0) > 0 && (
        <div className="space-y-2">
          <div className="text-[9px] font-mono text-white/30 tracking-widest">COPY TRADE</div>
          {copyTrade.targets.filter(t => t.enabled).map(t => (
            <div key={t.address} className="rounded-xl border border-lime-400/15 bg-lime-950/10 px-3 py-2.5 flex items-center justify-between">
              <div>
                {t.label && <div className="text-[10px] font-mono font-bold text-white">{t.label}</div>}
                <div className="text-[9px] font-mono text-white/30">{t.address.slice(0,8)}…{t.address.slice(-6)}</div>
                <div className="text-[8px] font-mono text-white/20">{t.scaleSui} SUI/buy</div>
              </div>
              <button onClick={() => copyTrade.toggleTarget(t.address)} className="text-[9px] font-mono text-white/30 hover:text-white/60 transition-colors">PAUSE</button>
            </div>
          ))}
        </div>
      )}

      {/* TP/SL configs */}
      {tpslConfigs.length > 0 && (
        <div className="space-y-2">
          <div className="text-[9px] font-mono text-white/30 tracking-widest">ACTIVE TP/SL</div>
          {tpslConfigs.map(({ curveId, config }) => (
            <div key={curveId} className="rounded-xl border border-white/8 bg-white/[0.02] px-3 py-2.5">
              <div className="flex items-center justify-between mb-1">
                <div className="text-[9px] font-mono text-white/50 truncate">{curveId.slice(0,14)}…</div>
                <button onClick={() => handleClearTPSL(curveId)}
                  className="text-white/20 hover:text-red-400 transition-colors ml-2 shrink-0">
                  <Trash2 size={11} />
                </button>
              </div>
              <div className="space-y-0.5">
                {(config.levels ?? []).map((level, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <span className={`text-[9px] font-mono ${
                      level.triggered ? 'text-white/20 line-through' :
                      level.type === 'tp' ? 'text-lime-400' : 'text-red-400'
                    }`}>
                      {level.type === 'tp' ? '▲' : '▼'} {level.pct > 0 ? '+' : ''}{level.pct}%
                    </span>
                    <span className="text-[8px] font-mono text-white/30">
                      sell {level.sellPct}%{level.triggered ? ' · triggered' : ''}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Main modal ────────────────────────────────────────────────────────────────
export default function StrategiesModal({ onClose, tradeKey, sniper, dca, copyTrade }) {
  const [tab, setTab] = useState('key');
  const { keypair, isReady, hasKey } = tradeKey;

  const anyActive = sniper?.isActive || (dca?.activeOrders?.length ?? 0) > 0 || copyTrade?.isActive;

  useEffect(() => {
    const handler = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  return (
    <>
      <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-40" onClick={onClose} />
      <div
        className="fixed bottom-0 left-0 right-0 sm:bottom-auto sm:top-1/2 sm:left-1/2 sm:-translate-x-1/2 sm:-translate-y-1/2 sm:max-w-md sm:w-full z-50 rounded-t-2xl sm:rounded-2xl border border-white/10 bg-[#0d0d0d] overflow-hidden flex flex-col"
        style={{ fontFamily: "'JetBrains Mono', ui-monospace, monospace", maxHeight: '88vh' }}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-white/8 shrink-0">
          <div className="flex items-center gap-2">
            <Zap size={13} className="text-lime-400" />
            <span className="text-[11px] font-mono font-bold text-white tracking-widest">TRADING STRATEGIES</span>
            {anyActive && (
              <span className="w-1.5 h-1.5 rounded-full bg-lime-400 animate-pulse" title="Strategies running" />
            )}
          </div>
          <button onClick={onClose} className="text-white/30 hover:text-white transition-colors">
            <X size={16} />
          </button>
        </div>

        {/* Active status strip */}
        {anyActive && (
          <div className="px-5 py-2 bg-lime-950/20 border-b border-lime-400/10 flex items-center gap-3 shrink-0">
            <span className="w-1.5 h-1.5 rounded-full bg-lime-400 animate-pulse shrink-0" />
            <span className="text-[9px] font-mono text-lime-400/70 flex-1">
              {[
                sniper?.isActive && 'Sniper active',
                (dca?.activeOrders?.length ?? 0) > 0 && `${dca.activeOrders.length} DCA order${dca.activeOrders.length !== 1 ? 's' : ''}`,
                copyTrade?.isActive && 'Copy trade active',
              ].filter(Boolean).join(' · ')}
            </span>
            <span className="text-[9px] font-mono text-lime-400/40">running in background</span>
          </div>
        )}

        {/* Tabs */}
        <div className="flex border-b border-white/8 shrink-0">
          {[
            { id: 'key',    label: '🔑 Key'    },
            { id: 'sniper', label: '🔫 Sniper' },
            { id: 'dca',    label: '📅 DCA'    },
            { id: 'copy',   label: '👁️ Copy'   },
            { id: 'active', label: '⚡ Active' },
          ].map(tb => (
            <button key={tb.id} onClick={() => setTab(tb.id)}
              className={`flex-1 py-3 text-[10px] font-mono font-bold tracking-wider transition-colors relative ${
                tab === tb.id
                  ? 'text-lime-400 border-b-2 border-lime-400 bg-lime-400/5'
                  : 'text-white/30 hover:text-white/60'
              }`}>
              {tb.label}
              {/* Active dot per tab */}
              {tb.id === 'sniper' && sniper?.isActive && (
                <span className="absolute top-2 right-2 w-1 h-1 rounded-full bg-lime-400" />
              )}
              {tb.id === 'dca' && (dca?.activeOrders?.length ?? 0) > 0 && (
                <span className="absolute top-2 right-2 w-1 h-1 rounded-full bg-lime-400" />
              )}
              {tb.id === 'copy' && copyTrade?.isActive && (
                <span className="absolute top-2 right-2 w-1 h-1 rounded-full bg-lime-400" />
              )}
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="px-5 py-5 overflow-y-auto flex-1">
          {tab === 'key'    && <TradingKeyTab {...tradeKey} />}
          {tab === 'sniper' && <SniperTab    sniper={sniper}       hasKey={hasKey} isReady={isReady} onClose={onClose} />}
          {tab === 'dca'    && <DCATab       dca={dca}             hasKey={hasKey} isReady={isReady} onClose={onClose} />}
          {tab === 'copy'   && <CopyTradeTab copyTrade={copyTrade} hasKey={hasKey} isReady={isReady} onClose={onClose} />}
          {tab === 'active' && <ActiveStrategiesTab sniper={sniper} dca={dca} copyTrade={copyTrade} />}
        </div>

        {/* Footer — always visible */}
        <div className="px-5 py-3 border-t border-white/5 shrink-0">
          <button onClick={onClose}
            className="w-full py-2 rounded-xl text-[10px] font-mono text-white/25 hover:text-white/50 transition-colors">
            {anyActive ? '✓ Close — all strategies keep running' : 'Close'}
          </button>
        </div>
      </div>
    </>
  );
}
