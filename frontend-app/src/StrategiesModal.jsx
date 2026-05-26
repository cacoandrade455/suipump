// v20-rebalance
// StrategiesModal.jsx — lifted hooks from App.jsx, Save & Run UX, + Rebalance tab

import React, { useState, useEffect, useCallback } from 'react';
import { useCurrentAccount } from '@mysten/dapp-kit-react';
import { X, Key, Eye, EyeOff, Trash2, CheckCircle2, Loader2, AlertTriangle,
         Zap, Crosshair, ToggleLeft, ToggleRight, ExternalLink, Play, RefreshCw } from 'lucide-react';
import { INTERVAL_OPTIONS } from './useDCA.js';
import { REBALANCE_INTERVALS } from './useRebalance.js';
import { loadTPSL, clearTPSL } from './useTPSL.js';

const INDEXER_URL = import.meta.env.VITE_INDEXER_URL || '';

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
  if (status === 'ready') return <CheckCircle2 size={14} className="text-lime-400" />;
  if (status === 'error') return <AlertTriangle size={14} className="text-red-400" />;
  return null;
}

function SaveRunButton({ onClick, active, label = 'Save & Run in Background', disabled = false }) {
  return (
    <button onClick={onClick} disabled={disabled}
      className={`w-full py-3 rounded-xl text-[11px] font-mono font-bold transition-all flex items-center justify-center gap-2 ${
        disabled ? 'bg-white/5 text-white/20 cursor-not-allowed'
        : active  ? 'bg-lime-950/40 border border-lime-400/40 text-lime-400 hover:bg-lime-950/60'
        :           'bg-lime-400 text-black hover:bg-lime-300'
      }`}>
      {active ? <><span className="w-2 h-2 rounded-full bg-lime-400 animate-pulse" />{label}</>
              : <><Play size={12} />{label}</>}
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
    try { await saveKey(input.trim()); setInput(''); setMsg('Trading key saved and encrypted ✓'); setTimeout(() => setMsg(''), 3000); }
    catch (e) { setMsg(e.message); setTimeout(() => setMsg(''), 4000); }
  };
  const handleLoad = async () => {
    try { await loadKey(); setMsg('Key unlocked — strategies active ✓'); setTimeout(() => setMsg(''), 3000); }
    catch (e) { setMsg(e.message); setTimeout(() => setMsg(''), 4000); }
  };
  const handleRemove = async () => {
    if (!window.confirm('Remove trading key? Strategies will stop.')) return;
    try { await removeKey(); setMsg('Key removed'); setTimeout(() => setMsg(''), 2000); } catch (e) { setMsg(e.message); }
  };

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <div className="text-[9px] font-mono text-white/30 tracking-widest">TRADING KEY</div>
        <p className="text-[10px] font-mono text-white/40 leading-relaxed">
          A dedicated hot wallet that signs sniper/DCA/copy/rebalance trades automatically — no wallet popup.
          Strategies run in the background even when this modal is closed.
        </p>
      </div>

      {hasKey && (
        <div className={`rounded-xl border p-3 flex items-center justify-between ${isReady ? 'border-lime-400/25 bg-lime-950/15' : 'border-white/8 bg-white/[0.02]'}`}>
          <div className="flex items-center gap-2">
            <StatusIcon status={status} />
            <span className="text-[10px] font-mono text-white/60">{isReady ? 'Key unlocked — strategies active' : 'Key saved — locked'}</span>
          </div>
          <div className="flex items-center gap-2">
            {!isReady && (
              <button onClick={handleLoad} disabled={status === 'signing' || status === 'decrypting'}
                className="text-[9px] font-mono text-lime-400 hover:text-lime-300 transition-colors disabled:opacity-40">UNLOCK</button>
            )}
            <button onClick={handleRemove} className="text-white/20 hover:text-red-400 transition-colors"><Trash2 size={11} /></button>
          </div>
        </div>
      )}

      <div className="space-y-2">
        <div className="text-[9px] font-mono text-white/30 tracking-widest">{hasKey ? 'REPLACE TRADING KEY' : 'PASTE PRIVATE KEY'}</div>
        <div className="relative">
          <input type={showKey ? 'text' : 'password'} value={input} onChange={e => setInput(e.target.value)}
            placeholder="0x... or suiprivkey..."
            className="w-full bg-white/[0.04] border border-white/10 rounded-xl px-4 py-3 text-[11px] font-mono text-white placeholder-white/15 focus:outline-none focus:border-lime-400/30 pr-10" />
          <button onClick={() => setShowKey(s => !s)} className="absolute right-3 top-1/2 -translate-y-1/2 text-white/20 hover:text-white/50">
            {showKey ? <EyeOff size={12} /> : <Eye size={12} />}
          </button>
        </div>
        <button onClick={handleSave} disabled={!input.trim() || status === 'signing' || status === 'encrypting'}
          className={`w-full py-2.5 rounded-xl text-[11px] font-mono font-bold transition-colors flex items-center justify-center gap-2 ${
            !input.trim() || status === 'signing' || status === 'encrypting'
              ? 'bg-white/5 text-white/20 cursor-not-allowed' : 'bg-lime-400 text-black hover:bg-lime-300'}`}>
          {(status === 'signing' || status === 'encrypting')
            ? <><Loader2 size={12} className="animate-spin" /> {status === 'signing' ? 'Sign in Slush…' : 'Encrypting…'}</>
            : <><Key size={12} /> SAVE & ENCRYPT KEY</>}
        </button>
      </div>

      {(msg || error) && (
        <div className={`text-[10px] font-mono text-center ${msg.includes('✓') ? 'text-lime-400' : 'text-red-400'}`}>{msg || error}</div>
      )}
      <div className="text-[8px] font-mono text-white/15 text-center">
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
    enable(); setSaved(true);
    setTimeout(() => { setSaved(false); onClose(); }, 900);
  }, [enable, onClose]);

  if (!account) return <div className="py-12 text-center text-[11px] font-mono text-white/30">Connect your wallet to use the sniper</div>;
  if (!hasKey || !isReady) return (
    <div className="py-12 text-center space-y-2">
      <Crosshair size={24} className="text-white/10 mx-auto" />
      <div className="text-[11px] font-mono text-white/25">Trading key required</div>
      <div className="text-[9px] font-mono text-white/15">Set up your trading key in the Key tab first</div>
    </div>
  );

  return (
    <div className="space-y-4">
      <div className={`rounded-xl border p-3 flex items-center justify-between ${isActive ? 'border-lime-400/25 bg-lime-950/10' : 'border-white/8 bg-white/[0.02]'}`}>
        <div className="flex items-center gap-2">
          {sniping ? <Loader2 size={13} className="animate-spin text-lime-400" />
                   : <span className={`w-2 h-2 rounded-full ${isActive ? 'bg-lime-400 animate-pulse' : 'bg-white/15'}`} />}
          <span className="text-[11px] font-mono font-bold text-white">{sniping ? 'Sniping…' : isActive ? 'Running in background' : 'Sniper off'}</span>
          {isActive && !sniping && <span className="text-[9px] font-mono text-white/30">watching for new tokens</span>}
        </div>
        {isActive && <button onClick={disable} className="text-[9px] font-mono text-red-400/60 hover:text-red-400">STOP</button>}
      </div>

      <div className="space-y-3">
        <div className="text-[9px] font-mono text-white/30 tracking-widest">CONFIG</div>
        {[
          { label: 'Max SUI per snipe', key: 'maxSuiPerSnipe', min: 0.1, step: 0.1, suffix: 'SUI' },
          { label: 'Max dev buy %',     key: 'maxDevBuyPct',   min: 0,   step: 1,   suffix: '%' },
          { label: 'Slippage',          key: 'slippage',        min: 0.1, step: 0.1, suffix: '%' },
        ].map(({ label, key, min, step, suffix }) => (
          <div key={key} className="flex items-center justify-between gap-3">
            <span className="text-[10px] font-mono text-white/50">{label}</span>
            <div className="relative w-28">
              <input type="number" min={min} step={step} value={config[key] ?? 0}
                onChange={e => updateConfig({ [key]: parseFloat(e.target.value) || 0 })}
                className="w-full bg-white/5 border border-white/10 rounded-lg px-2 py-1.5 text-[11px] font-mono text-white text-right focus:outline-none focus:border-lime-400/40" />
              <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[8px] font-mono text-white/20 pointer-events-none">{suffix}</span>
            </div>
          </div>
        ))}

        <div className="rounded-xl border border-white/8 p-3 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-mono text-white/50">Auto TP/SL after snipe</span>
            <button onClick={() => updateConfig({ autoTPSL: !(config.autoTPSL ?? true) })}>
              {(config.autoTPSL ?? true) ? <ToggleRight size={18} className="text-lime-400" /> : <ToggleLeft size={18} className="text-white/20" />}
            </button>
          </div>
          {(config.autoTPSL ?? true) && (
            <div className="grid grid-cols-2 gap-2 pt-1">
              {[
                { label: 'TAKE PROFIT %', key: 'tpPct', def: 200 },
                { label: 'STOP LOSS %',  key: 'slPct', def: -30 },
              ].map(({ label, key, def }) => (
                <div key={key} className="space-y-1">
                  <label className="text-[8px] font-mono text-white/25">{label}</label>
                  <input type="number" value={config[key] ?? def}
                    onChange={e => updateConfig({ [key]: parseFloat(e.target.value) || def })}
                    className="w-full bg-white/[0.04] border border-white/8 rounded-lg px-2 py-1 text-[10px] font-mono text-white focus:outline-none" />
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {log.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-[9px] font-mono text-white/30 tracking-widest">SNIPE LOG</span>
            <button onClick={clearLog} className="text-[9px] font-mono text-white/20 hover:text-red-400">clear</button>
          </div>
          <div className="space-y-1 max-h-28 overflow-y-auto">
            {log.slice(0, 8).map((entry, i) => (
              <div key={i} className="flex items-start justify-between gap-2 py-1 border-b border-white/[0.03]">
                <div className="min-w-0">
                  <span className={`text-[9px] font-mono ${entry.success ? 'text-white/70' : 'text-red-400/70'}`}>
                    {entry.success ? '✓' : '✗'} {entry.name} <span className="text-lime-400/70">${entry.symbol}</span>
                  </span>
                  {entry.error && <div className="text-[8px] text-red-400/40">{entry.error}</div>}
                </div>
                {entry.digest && (
                  <a href={`https://suiexplorer.com/txblock/${entry.digest}?network=testnet`} target="_blank" rel="noreferrer" className="text-white/20 hover:text-lime-400 shrink-0">
                    <ExternalLink size={10} />
                  </a>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {saved ? (
        <div className="w-full py-3 rounded-xl bg-lime-950/40 border border-lime-400/40 text-lime-400 text-[11px] font-mono font-bold flex items-center justify-center gap-2">
          <CheckCircle2 size={13} /> Sniper running — closing modal…
        </div>
      ) : isActive ? (
        <div className="space-y-2">
          <div className="w-full py-2.5 rounded-xl bg-lime-950/30 border border-lime-400/25 text-lime-400/80 text-[10px] font-mono flex items-center justify-center gap-2">
            <span className="w-1.5 h-1.5 rounded-full bg-lime-400 animate-pulse" /> Sniper is running in the background
          </div>
          <button onClick={onClose} className="w-full py-2.5 rounded-xl border border-white/10 text-white/40 text-[11px] font-mono font-bold hover:border-white/20 hover:text-white/60">
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
// ── DCA tab ───────────────────────────────────────────────────────────────────
function DCATab({ dca, hasKey, isReady, onClose }) {
  const account = useCurrentAccount();
  const { activeOrders = [], doneOrders = [], createOrder, cancelOrder, clearDone } = dca;

  const [dcaMode,         setDcaMode]         = React.useState('time');
  const [curveId,         setCurveId]         = useState('');
  const [totalSui,        setTotalSui]        = useState('10');
  const [tranches,        setTranches]        = useState('5');
  const [intervalMs,      setIntervalMs]      = useState(INTERVAL_OPTIONS[1]?.ms ?? 300_000);
  const [slippage,        setSlippage]        = useState('2');
  const [resolving,       setResolving]       = useState(false);
  const [resolvedName,    setResolvedName]    = useState('');
  const [resolvedSym,     setResolvedSym]     = useState('');
  const [resolvedType,    setResolvedType]    = useState('');
  const [resolvedPkg,     setResolvedPkg]     = useState('');
  const [resolvedPrice,   setResolvedPrice]   = useState(null);

  const [dipCurveId,      setDipCurveId]      = useState('');
  const [suiPerDip,       setSuiPerDip]       = useState('2');
  const [dipPct,          setDipPct]          = useState('10');
  const [cooldownMin,     setCooldownMin]     = useState('5');
  const [maxDipBuys,      setMaxDipBuys]      = useState('0');
  const [dipSlippage,     setDipSlippage]     = useState('2');
  const [dipResolving,    setDipResolving]    = useState(false);
  const [dipResolvedName, setDipResolvedName] = useState('');
  const [dipResolvedSym,  setDipResolvedSym]  = useState('');
  const [dipResolvedType, setDipResolvedType] = useState('');
  const [dipResolvedPkg,  setDipResolvedPkg]  = useState('');
  const [dipCurrentPrice, setDipCurrentPrice] = useState(null);

  const [formMsg, setFormMsg] = useState('');
  const [saved,   setSaved]   = useState(false);

  const IURL = import.meta.env.VITE_INDEXER_URL || '';

  const resolveCurve = async (id, isDip = false) => {
    if (!id || id.length < 10) return;
    isDip ? setDipResolving(true) : setResolving(true);
    try {
      const r = await fetch(`${IURL}/token/${id}`, { signal: AbortSignal.timeout(5000) });
      if (r.ok) {
        const d = await r.json();
        const name = d.name ?? '';
        const sym  = d.symbol ?? '';
        const type = d.token_type ?? d.tokenType ?? '';
        const pkg  = d.package_id ?? d.packageId ?? '';
        const reserveSui = d.stats?.reserve_sui ?? d.reserve_sui ?? 0;
        if (isDip) {
          setDipResolvedName(name); setDipResolvedSym(sym);
          setDipResolvedType(type); setDipResolvedPkg(pkg);
          if (pkg) {
            const { curveShapeFor } = await import('./constants.js');
            const { virtualSui } = curveShapeFor(pkg);
            setDipCurrentPrice((reserveSui + virtualSui) / 1_000_000_000);
          }
        } else {
          setResolvedName(name); setResolvedSym(sym);
          setResolvedType(type); setResolvedPkg(pkg);
          if (pkg) {
            const { curveShapeFor } = await import('./constants.js');
            const { virtualSui } = curveShapeFor(pkg);
            setResolvedPrice((reserveSui + virtualSui) / 1_000_000_000);
          }
        }
      }
    } catch {}
    isDip ? setDipResolving(false) : setResolving(false);
  };

  const handleCreateTime = () => {
    if (!resolvedType || !resolvedPkg) { setFormMsg('Paste a valid curve ID first'); return; }
    const total = parseFloat(totalSui);
    const n     = parseInt(tranches);
    if (!total || total <= 0) { setFormMsg('Enter total SUI'); return; }
    if (!n || n < 2)          { setFormMsg('Minimum 2 tranches'); return; }
    createOrder({
      mode: 'time', curveId: curveId.trim(), tokenType: resolvedType, pkgId: resolvedPkg,
      name: resolvedName, symbol: resolvedSym, totalSui: total, trancheCount: n,
      intervalMs: parseInt(intervalMs), slippage: parseFloat(slippage) || 2,
    });
    setCurveId(''); setResolvedName(''); setResolvedType(''); setResolvedPkg('');
    setSaved(true);
    setTimeout(() => { setSaved(false); onClose(); }, 900);
  };

  const handleCreateDip = () => {
    if (!dipResolvedType || !dipResolvedPkg) { setFormMsg('Paste a valid curve ID first'); return; }
    const sui = parseFloat(suiPerDip);
    const pct = parseFloat(dipPct);
    if (!sui || sui <= 0) { setFormMsg('Enter SUI per dip buy'); return; }
    if (!pct || pct <= 0) { setFormMsg('Enter dip % threshold'); return; }
    createOrder({
      mode: 'dip', curveId: dipCurveId.trim(), tokenType: dipResolvedType, pkgId: dipResolvedPkg,
      name: dipResolvedName, symbol: dipResolvedSym,
      suiPerDip: sui, dipPct: pct,
      cooldownMin: parseInt(cooldownMin) || 5,
      maxDipBuys:  parseInt(maxDipBuys)  || 0,
      refPrice:    dipCurrentPrice,
      slippage:    parseFloat(dipSlippage) || 2,
    });
    setDipCurveId(''); setDipResolvedName(''); setDipResolvedType(''); setDipResolvedPkg('');
    setSaved(true);
    setTimeout(() => { setSaved(false); onClose(); }, 900);
  };

  if (!account) return <div className="py-12 text-center text-[11px] font-mono text-white/30">Connect your wallet to use DCA</div>;
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
            const isTime  = !order.mode || order.mode === 'time';
            const pct     = isTime ? Math.round(((order.executed ?? 0) / order.trancheCount) * 100) : null;
            const buysLeft = !isTime && order.maxDipBuys > 0 ? order.maxDipBuys - (order.dipBuyCount ?? 0) : null;
            return (
              <div key={order.id} className="rounded-xl border border-lime-400/15 bg-lime-950/10 overflow-hidden">
                <div className="px-3 py-2.5 flex items-center justify-between">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 mb-0.5">
                      <div className="text-[10px] font-mono font-bold text-white truncate">
                        {order.name || order.curveId.slice(0,8)+'…'}
                        {order.symbol && <span className="text-lime-400/70 ml-1">${order.symbol}</span>}
                      </div>
                      <span className={`text-[8px] font-mono px-1.5 py-0.5 rounded-full ${
                        isTime ? 'bg-blue-400/10 text-blue-400/70' : 'bg-orange-400/10 text-orange-400/70'
                      }`}>{isTime ? 'TIME' : 'DIP'}</span>
                    </div>
                    {isTime ? (
                      <div className="text-[8px] font-mono text-white/30">
                        {order.executed ?? 0}/{order.trancheCount} tranches · {(order.totalSui / order.trancheCount).toFixed(2)} SUI each
                      </div>
                    ) : (
                      <div className="text-[8px] font-mono text-white/30">
                        Buy {order.suiPerDip} SUI on -{order.dipPct}% dip
                        {buysLeft !== null ? ` · ${buysLeft} buys left` : ' · unlimited'}
                        {(order.dipBuyCount ?? 0) > 0 && ` · ${order.dipBuyCount} done`}
                      </div>
                    )}
                  </div>
                  <button onClick={() => cancelOrder(order.id)} className="text-white/20 hover:text-red-400 ml-3 shrink-0">
                    <Trash2 size={11} />
                  </button>
                </div>
                {isTime && pct != null && (
                  <div className="h-1 bg-white/5">
                    <div className="h-full bg-lime-400/60" style={{ width: `${pct}%` }} />
                  </div>
                )}
              </div>
            );
          })}
          <button onClick={onClose} className="w-full py-2.5 rounded-xl border border-white/10 text-white/40 text-[11px] font-mono font-bold hover:border-white/20 hover:text-white/60">
            Close — orders keep running
          </button>
        </div>
      )}

      {/* Mode toggle */}
      <div className="flex rounded-xl overflow-hidden border border-white/10">
        {[['time', '⏱ Time-based'], ['dip', '📉 Buy the Dip']].map(([mode, label]) => (
          <button key={mode} onClick={() => { setDcaMode(mode); setFormMsg(''); }}
            className={`flex-1 py-2.5 text-[10px] font-mono font-bold transition-colors ${
              dcaMode === mode ? 'bg-lime-400 text-black' : 'bg-white/[0.03] text-white/30 hover:text-white/60'
            }`}>{label}</button>
        ))}
      </div>

      {/* Time-based form */}
      {dcaMode === 'time' && (
        <div className="space-y-3">
          <div className="text-[9px] font-mono text-white/30 tracking-widest">NEW TIME-BASED ORDER</div>
          <div className="space-y-1">
            <label className="text-[9px] font-mono text-white/30">TOKEN CURVE ID</label>
            <input value={curveId}
              onChange={e => { setCurveId(e.target.value); setResolvedName(''); setResolvedType(''); }}
              onBlur={e => resolveCurve(e.target.value.trim(), false)}
              placeholder="0x… paste from token page URL"
              className="w-full bg-white/[0.04] border border-white/8 rounded-lg px-3 py-1.5 text-[11px] font-mono text-white placeholder-white/15 focus:outline-none focus:border-lime-400/30" />
            {resolving && <div className="text-[8px] font-mono text-white/30">Resolving…</div>}
            {resolvedName && <div className="text-[9px] font-mono text-lime-400">✓ {resolvedName} <span className="text-white/40">${resolvedSym}</span></div>}
          </div>
          <div className="grid grid-cols-2 gap-2">
            {[['TOTAL SUI', totalSui, setTotalSui], ['TRANCHES', tranches, setTranches]].map(([label, val, set]) => (
              <div key={label} className="space-y-1">
                <label className="text-[9px] font-mono text-white/30">{label}</label>
                <input type="number" min="1" step="1" value={val} onChange={e => set(e.target.value)}
                  className="w-full bg-white/[0.04] border border-white/8 rounded-lg px-3 py-1.5 text-[11px] font-mono text-white focus:outline-none focus:border-lime-400/30" />
              </div>
            ))}
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <label className="text-[9px] font-mono text-white/30">INTERVAL</label>
              <select value={intervalMs} onChange={e => setIntervalMs(parseInt(e.target.value))}
                className="w-full bg-white/[0.04] border border-white/8 rounded-lg px-3 py-1.5 text-[11px] font-mono text-white focus:outline-none">
                {(INTERVAL_OPTIONS ?? []).map(o => <option key={o.ms} value={o.ms} className="bg-[#0d0d0d]">{o.label}</option>)}
              </select>
            </div>
            <div className="space-y-1">
              <label className="text-[9px] font-mono text-white/30">SLIPPAGE %</label>
              <input type="number" min="0.1" max="50" step="0.1" value={slippage} onChange={e => setSlippage(e.target.value)}
                className="w-full bg-white/[0.04] border border-white/8 rounded-lg px-3 py-1.5 text-[11px] font-mono text-white focus:outline-none" />
            </div>
          </div>
          {resolvedPrice && (
            <div className="text-[9px] font-mono text-white/30 bg-white/[0.02] rounded-lg px-3 py-2">
              Current price: <span className="text-white/60">{resolvedPrice.toFixed(8)} SUI/token</span>
              {totalSui && tranches && (
                <span className="text-white/40 ml-2">· {(parseFloat(totalSui) / parseInt(tranches)).toFixed(2)} SUI/tranche</span>
              )}
            </div>
          )}
          {formMsg && <div className="text-[10px] font-mono text-red-400 text-center">{formMsg}</div>}
          {saved ? (
            <div className="w-full py-3 rounded-xl bg-lime-950/40 border border-lime-400/40 text-lime-400 text-[11px] font-mono font-bold flex items-center justify-center gap-2">
              <CheckCircle2 size={13} /> DCA running — closing modal…
            </div>
          ) : (
            <SaveRunButton onClick={handleCreateTime} active={false} label="Save & Run in Background" disabled={!resolvedType} />
          )}
        </div>
      )}

      {/* Dip-based form */}
      {dcaMode === 'dip' && (
        <div className="space-y-3">
          <div className="text-[9px] font-mono text-white/30 tracking-widest">NEW DIP ORDER</div>
          <div className="space-y-1">
            <label className="text-[9px] font-mono text-white/30">TOKEN CURVE ID</label>
            <input value={dipCurveId}
              onChange={e => { setDipCurveId(e.target.value); setDipResolvedName(''); setDipResolvedType(''); }}
              onBlur={e => resolveCurve(e.target.value.trim(), true)}
              placeholder="0x… paste from token page URL"
              className="w-full bg-white/[0.04] border border-white/8 rounded-lg px-3 py-1.5 text-[11px] font-mono text-white placeholder-white/15 focus:outline-none focus:border-lime-400/30" />
            {dipResolving && <div className="text-[8px] font-mono text-white/30">Resolving…</div>}
            {dipResolvedName && <div className="text-[9px] font-mono text-lime-400">✓ {dipResolvedName} <span className="text-white/40">${dipResolvedSym}</span></div>}
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <label className="text-[9px] font-mono text-white/30">BUY ON DIP OF</label>
              <div className="relative">
                <input type="number" min="1" max="90" step="1" value={dipPct} onChange={e => setDipPct(e.target.value)}
                  className="w-full bg-white/[0.04] border border-white/8 rounded-lg px-3 py-1.5 pr-7 text-[11px] font-mono text-white focus:outline-none focus:border-lime-400/30" />
                <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[9px] font-mono text-white/25">%</span>
              </div>
              <div className="text-[8px] font-mono text-white/20">from last buy price</div>
            </div>
            <div className="space-y-1">
              <label className="text-[9px] font-mono text-white/30">SUI PER BUY</label>
              <input type="number" min="0.1" step="0.1" value={suiPerDip} onChange={e => setSuiPerDip(e.target.value)}
                className="w-full bg-white/[0.04] border border-white/8 rounded-lg px-3 py-1.5 text-[11px] font-mono text-white focus:outline-none focus:border-lime-400/30" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <label className="text-[9px] font-mono text-white/30">COOLDOWN (MIN)</label>
              <input type="number" min="1" step="1" value={cooldownMin} onChange={e => setCooldownMin(e.target.value)}
                className="w-full bg-white/[0.04] border border-white/8 rounded-lg px-3 py-1.5 text-[11px] font-mono text-white focus:outline-none" />
              <div className="text-[8px] font-mono text-white/20">min between buys</div>
            </div>
            <div className="space-y-1">
              <label className="text-[9px] font-mono text-white/30">MAX BUYS</label>
              <input type="number" min="0" step="1" value={maxDipBuys} onChange={e => setMaxDipBuys(e.target.value)}
                className="w-full bg-white/[0.04] border border-white/8 rounded-lg px-3 py-1.5 text-[11px] font-mono text-white focus:outline-none" />
              <div className="text-[8px] font-mono text-white/20">0 = unlimited</div>
            </div>
          </div>
          <div className="space-y-1">
            <label className="text-[9px] font-mono text-white/30">SLIPPAGE %</label>
            <input type="number" min="0.1" max="50" step="0.1" value={dipSlippage} onChange={e => setDipSlippage(e.target.value)}
              className="w-full bg-white/[0.04] border border-white/8 rounded-lg px-3 py-1.5 text-[11px] font-mono text-white focus:outline-none" />
          </div>
          {dipCurrentPrice && (
            <div className="text-[9px] font-mono text-white/30 bg-white/[0.02] rounded-lg px-3 py-2">
              Current price: <span className="text-white/60">{dipCurrentPrice.toFixed(8)} SUI/token</span>
              {dipPct && (
                <span className="text-orange-400/60 ml-2">
                  · triggers at {(dipCurrentPrice * (1 - parseFloat(dipPct) / 100)).toFixed(8)}
                </span>
              )}
            </div>
          )}
          {formMsg && <div className="text-[10px] font-mono text-red-400 text-center">{formMsg}</div>}
          {saved ? (
            <div className="w-full py-3 rounded-xl bg-lime-950/40 border border-lime-400/40 text-lime-400 text-[11px] font-mono font-bold flex items-center justify-center gap-2">
              <CheckCircle2 size={13} /> Dip watcher running — closing modal…
            </div>
          ) : (
            <SaveRunButton onClick={handleCreateDip} active={false} label="Save & Run in Background" disabled={!dipResolvedType} />
          )}
        </div>
      )}

      {/* Done orders */}
      {doneOrders.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-[9px] font-mono text-white/20 tracking-widest">COMPLETED</span>
            <button onClick={clearDone} className="text-[9px] font-mono text-white/20 hover:text-red-400">clear</button>
          </div>
          {doneOrders.map(order => (
            <div key={order.id} className="rounded-xl border border-white/5 px-3 py-2 text-[10px] font-mono text-white/30">
              ✓ {order.name || order.curveId.slice(0,8)+'…'} —{' '}
              {order.mode === 'dip'
                ? `${order.dipBuyCount} dip buys`
                : `${order.trancheCount} tranches · ${order.totalSui} SUI`}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

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
    if (!address.trim() || !address.startsWith('0x')) { setFormMsg('Enter a valid Sui wallet address (0x…)'); return; }
    const sui = parseFloat(scaleSui);
    if (!sui || sui <= 0) { setFormMsg('Enter a valid SUI amount'); return; }
    addTarget(address.trim(), label.trim(), sui, mirrorSells, parseFloat(slippage) || 2);
    setAddress(''); setLabel('');
    setSaved(true);
    setTimeout(() => { setSaved(false); onClose(); }, 900);
  };

  if (!account) return <div className="py-12 text-center text-[11px] font-mono text-white/30">Connect your wallet to use copy trading</div>;
  if (!hasKey || !isReady) return (
    <div className="py-12 text-center space-y-2">
      <div className="text-[11px] font-mono text-white/25">Trading key required</div>
      <div className="text-[9px] font-mono text-white/15">Set up your trading key in the Key tab first</div>
    </div>
  );

  return (
    <div className="space-y-4">
      {targets.length > 0 && (
        <div className="space-y-2">
          <div className="text-[9px] font-mono text-white/30 tracking-widest">WATCHING</div>
          {targets.map(t => (
            <div key={t.address} className={`rounded-xl border px-3 py-2.5 flex items-center justify-between ${t.enabled ? 'border-lime-400/15 bg-lime-950/10' : 'border-white/8 bg-white/[0.02]'}`}>
              <div className="min-w-0">
                {t.label && <div className="text-[10px] font-mono font-bold text-white truncate">{t.label}</div>}
                <div className="text-[9px] font-mono text-white/30 truncate">{t.address.slice(0,8)}…{t.address.slice(-6)}</div>
                <div className="text-[8px] font-mono text-white/20 mt-0.5">{t.scaleSui} SUI/buy{t.mirrorSells ? ' · mirror sells' : ''} · {t.slippage}% slip</div>
              </div>
              <div className="flex items-center gap-2 ml-3 shrink-0">
                <button onClick={() => toggleTarget(t.address)}>{t.enabled ? <ToggleRight size={18} className="text-lime-400" /> : <ToggleLeft size={18} className="text-white/20" />}</button>
                <button onClick={() => removeTarget(t.address)} className="text-white/20 hover:text-red-400"><Trash2 size={11} /></button>
              </div>
            </div>
          ))}
          {isActive && <button onClick={onClose} className="w-full py-2.5 rounded-xl border border-white/10 text-white/40 text-[11px] font-mono font-bold hover:border-white/20 hover:text-white/60">Close — copy trading keeps running</button>}
        </div>
      )}

      <div className="space-y-3">
        <div className="text-[9px] font-mono text-white/30 tracking-widest">{targets.length > 0 ? 'ADD ANOTHER WALLET' : 'WATCH A WALLET'}</div>
        <input value={address} onChange={e => setAddress(e.target.value)} placeholder="0x… wallet to copy"
          className="w-full bg-white/[0.04] border border-white/8 rounded-lg px-3 py-1.5 text-[11px] font-mono text-white placeholder-white/15 focus:outline-none focus:border-lime-400/30" />
        <input value={label} onChange={e => setLabel(e.target.value)} placeholder="Label (optional)"
          className="w-full bg-white/[0.04] border border-white/8 rounded-lg px-3 py-1.5 text-[11px] font-mono text-white placeholder-white/15 focus:outline-none focus:border-lime-400/30" />
        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1">
            <label className="text-[9px] font-mono text-white/30">SUI PER BUY</label>
            <input type="number" min="0.1" step="0.1" value={scaleSui} onChange={e => setScaleSui(e.target.value)}
              className="w-full bg-white/[0.04] border border-white/8 rounded-lg px-3 py-1.5 text-[11px] font-mono text-white focus:outline-none" />
          </div>
          <div className="space-y-1">
            <label className="text-[9px] font-mono text-white/30">SLIPPAGE %</label>
            <input type="number" min="0.1" max="50" step="0.1" value={slippage} onChange={e => setSlippage(e.target.value)}
              className="w-full bg-white/[0.04] border border-white/8 rounded-lg px-3 py-1.5 text-[11px] font-mono text-white focus:outline-none" />
          </div>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-[10px] font-mono text-white/40">Mirror sells too</span>
          <button onClick={() => setMirrorSells(v => !v)}>{mirrorSells ? <ToggleRight size={18} className="text-lime-400" /> : <ToggleLeft size={18} className="text-white/20" />}</button>
        </div>
        {formMsg && <div className={`text-[10px] font-mono text-center ${formMsg.includes('✓') ? 'text-lime-400' : 'text-red-400'}`}>{formMsg}</div>}
        {saved ? (
          <div className="w-full py-3 rounded-xl bg-lime-950/40 border border-lime-400/40 text-lime-400 text-[11px] font-mono font-bold flex items-center justify-center gap-2">
            <CheckCircle2 size={13} /> Copy trading running — closing modal…
          </div>
        ) : (
          <SaveRunButton onClick={handleAddAndRun} active={false} label="Save & Run in Background" disabled={!address.trim()} />
        )}
      </div>

      {log.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-[9px] font-mono text-white/30 tracking-widest">COPY LOG</span>
            <button onClick={clearLog} className="text-[9px] font-mono text-white/20 hover:text-red-400">clear</button>
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

// ── Rebalance tab ─────────────────────────────────────────────────────────────
function RebalanceTab({ rebalance, hasKey, isReady, onClose }) {
  const account = useCurrentAccount();
  const { config, updateConfig, checking, lastCheck, checkAndRebalance, clearLog, log = [], isActive } = rebalance;
  const [saved, setSaved] = useState(false);

  const handleSaveRun = useCallback(() => {
    updateConfig({ enabled: true });
    setSaved(true);
    setTimeout(() => { setSaved(false); onClose(); }, 900);
  }, [updateConfig, onClose]);

  const handleStop = () => updateConfig({ enabled: false });

  const fmtTime = (ts) => {
    if (!ts) return '—';
    const diff = Date.now() - ts;
    if (diff < 60_000) return 'just now';
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
    return `${Math.floor(diff / 3_600_000)}h ago`;
  };

  if (!account) return <div className="py-12 text-center text-[11px] font-mono text-white/30">Connect your wallet to use rebalance</div>;
  if (!hasKey || !isReady) return (
    <div className="py-12 text-center space-y-2">
      <RefreshCw size={24} className="text-white/10 mx-auto" />
      <div className="text-[11px] font-mono text-white/25">Trading key required</div>
      <div className="text-[9px] font-mono text-white/15">Set up your trading key in the Key tab first</div>
    </div>
  );

  return (
    <div className="space-y-4">
      {/* Status */}
      <div className={`rounded-xl border p-3 flex items-center justify-between ${isActive ? 'border-lime-400/25 bg-lime-950/10' : 'border-white/8 bg-white/[0.02]'}`}>
        <div className="flex items-center gap-2">
          {checking ? <Loader2 size={13} className="animate-spin text-lime-400" />
                    : <span className={`w-2 h-2 rounded-full ${isActive ? 'bg-lime-400 animate-pulse' : 'bg-white/15'}`} />}
          <div>
            <span className="text-[11px] font-mono font-bold text-white">{checking ? 'Checking…' : isActive ? 'Running in background' : 'Rebalance off'}</span>
            {lastCheck && <div className="text-[8px] font-mono text-white/25">Last check: {fmtTime(lastCheck)}</div>}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {isActive && (
            <button onClick={checkAndRebalance} disabled={checking}
              className="text-[9px] font-mono text-lime-400/60 hover:text-lime-400 transition-colors disabled:opacity-30">
              CHECK NOW
            </button>
          )}
          {isActive && <button onClick={handleStop} className="text-[9px] font-mono text-red-400/60 hover:text-red-400">STOP</button>}
        </div>
      </div>

      {/* Config */}
      <div className="space-y-3">
        <div className="text-[9px] font-mono text-white/30 tracking-widest">CONFIG</div>

        <div className="flex items-center justify-between gap-3">
          <div>
            <span className="text-[10px] font-mono text-white/50">Max allocation per token</span>
            <div className="text-[8px] font-mono text-white/25">Sell excess when any token exceeds this % of portfolio</div>
          </div>
          <div className="relative w-24 shrink-0">
            <input type="number" min="5" max="100" step="1" value={config.maxAllocPct}
              onChange={e => updateConfig({ maxAllocPct: parseFloat(e.target.value) || 30 })}
              className="w-full bg-white/5 border border-white/10 rounded-lg px-2 py-1.5 text-[11px] font-mono text-white text-right focus:outline-none focus:border-lime-400/40" />
            <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[8px] font-mono text-white/20 pointer-events-none">%</span>
          </div>
        </div>

        <div className="flex items-center justify-between gap-3">
          <span className="text-[10px] font-mono text-white/50">Check interval</span>
          <select value={config.checkIntervalMs} onChange={e => updateConfig({ checkIntervalMs: parseInt(e.target.value) })}
            className="w-32 bg-white/[0.04] border border-white/8 rounded-lg px-3 py-1.5 text-[11px] font-mono text-white focus:outline-none">
            {REBALANCE_INTERVALS.map(o => <option key={o.ms} value={o.ms} className="bg-[#0d0d0d]">{o.label}</option>)}
          </select>
        </div>

        <div className="flex items-center justify-between gap-3">
          <span className="text-[10px] font-mono text-white/50">Slippage</span>
          <div className="relative w-24 shrink-0">
            <input type="number" min="0.1" max="50" step="0.1" value={config.slippage}
              onChange={e => updateConfig({ slippage: parseFloat(e.target.value) || 2 })}
              className="w-full bg-white/5 border border-white/10 rounded-lg px-2 py-1.5 text-[11px] font-mono text-white text-right focus:outline-none focus:border-lime-400/40" />
            <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[8px] font-mono text-white/20 pointer-events-none">%</span>
          </div>
        </div>
      </div>

      {/* Log */}
      {log.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-[9px] font-mono text-white/30 tracking-widest">REBALANCE LOG</span>
            <button onClick={clearLog} className="text-[9px] font-mono text-white/20 hover:text-red-400">clear</button>
          </div>
          <div className="space-y-1 max-h-28 overflow-y-auto">
            {log.slice(0, 8).map((entry, i) => (
              <div key={i} className="py-1 border-b border-white/[0.03]">
                <span className={`text-[9px] font-mono ${entry.success ? 'text-white/60' : 'text-red-400/60'}`}>
                  {entry.success ? '✓' : '✗'} {entry.symbol || entry.curveId?.slice(0,8)} — {entry.soldTokens?.toFixed(0)} tokens
                </span>
                {entry.reason && <div className="text-[8px] font-mono text-white/25">{entry.reason}</div>}
                {entry.error  && <div className="text-[8px] font-mono text-red-400/40">{entry.error}</div>}
              </div>
            ))}
          </div>
        </div>
      )}

      {saved ? (
        <div className="w-full py-3 rounded-xl bg-lime-950/40 border border-lime-400/40 text-lime-400 text-[11px] font-mono font-bold flex items-center justify-center gap-2">
          <CheckCircle2 size={13} /> Rebalance running — closing modal…
        </div>
      ) : isActive ? (
        <div className="space-y-2">
          <div className="w-full py-2.5 rounded-xl bg-lime-950/30 border border-lime-400/25 text-lime-400/80 text-[10px] font-mono flex items-center justify-center gap-2">
            <span className="w-1.5 h-1.5 rounded-full bg-lime-400 animate-pulse" /> Rebalance is running in the background
          </div>
          <button onClick={onClose} className="w-full py-2.5 rounded-xl border border-white/10 text-white/40 text-[11px] font-mono font-bold hover:border-white/20 hover:text-white/60">
            Close — rebalance keeps running
          </button>
        </div>
      ) : (
        <SaveRunButton onClick={handleSaveRun} active={false} label="Save & Run in Background" />
      )}
    </div>
  );
}

// ── Active strategies tab ─────────────────────────────────────────────────────
function ActiveStrategiesTab({ sniper, dca, copyTrade, rebalance }) {
  const account = useCurrentAccount();
  const [tpslConfigs, setTpslConfigs] = useState([]);

  useEffect(() => {
    if (account?.address) setTpslConfigs(loadAllTPSL(account.address));
  }, [account?.address]);

  const handleClearTPSL = (curveId) => {
    clearTPSL(account.address, curveId);
    setTpslConfigs(prev => prev.filter(c => c.curveId !== curveId));
  };

  const hasAnything = sniper?.isActive || (dca?.activeOrders?.length ?? 0) > 0
    || copyTrade?.isActive || rebalance?.isActive || tpslConfigs.length > 0;

  if (!account) return <div className="py-12 text-center text-[11px] font-mono text-white/30">Connect your wallet</div>;
  if (!hasAnything) return (
    <div className="py-12 text-center space-y-2">
      <div className="text-[11px] font-mono text-white/20">No active strategies</div>
      <div className="text-[9px] font-mono text-white/15">Enable sniper, DCA, copy trade, or rebalance to see them here</div>
    </div>
  );

  return (
    <div className="space-y-3">
      {sniper?.isActive && (
        <div className="rounded-xl border border-lime-400/20 bg-lime-950/10 px-3 py-2.5 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="w-1.5 h-1.5 rounded-full bg-lime-400 animate-pulse" />
            <span className="text-[10px] font-mono font-bold text-white">Sniper</span>
            <span className="text-[9px] font-mono text-white/30">{sniper.config?.maxSuiPerSnipe} SUI/snipe</span>
          </div>
          <button onClick={() => sniper.disable()} className="text-[9px] font-mono text-red-400/60 hover:text-red-400">STOP</button>
        </div>
      )}

      {(dca?.activeOrders?.length ?? 0) > 0 && (
        <div className="space-y-1.5">
          <div className="text-[9px] font-mono text-white/30 tracking-widest">DCA ORDERS</div>
          {dca.activeOrders.map(order => (
            <div key={order.id} className="rounded-xl border border-lime-400/15 bg-lime-950/10 px-3 py-2.5 flex items-center justify-between">
              <div className="min-w-0">
                <div className="text-[10px] font-mono font-bold text-white truncate">{order.name || order.curveId.slice(0,8)+'…'}{order.symbol && <span className="text-lime-400/70 ml-1">${order.symbol}</span>}</div>
                <div className="text-[8px] font-mono text-white/30">{order.executed ?? 0}/{order.trancheCount} tranches · {order.totalSui} SUI total</div>
              </div>
              <button onClick={() => dca.cancelOrder(order.id)} className="text-white/20 hover:text-red-400 ml-3 shrink-0"><Trash2 size={11} /></button>
            </div>
          ))}
        </div>
      )}

      {copyTrade?.isActive && (copyTrade?.targets?.filter(t => t.enabled).length ?? 0) > 0 && (
        <div className="space-y-1.5">
          <div className="text-[9px] font-mono text-white/30 tracking-widest">COPY TRADE</div>
          {copyTrade.targets.filter(t => t.enabled).map(t => (
            <div key={t.address} className="rounded-xl border border-lime-400/15 bg-lime-950/10 px-3 py-2.5 flex items-center justify-between">
              <div>
                {t.label && <div className="text-[10px] font-mono font-bold text-white">{t.label}</div>}
                <div className="text-[9px] font-mono text-white/30">{t.address.slice(0,8)}…{t.address.slice(-6)}</div>
                <div className="text-[8px] font-mono text-white/20">{t.scaleSui} SUI/buy</div>
              </div>
              <button onClick={() => copyTrade.toggleTarget(t.address)} className="text-[9px] font-mono text-white/30 hover:text-white/60">PAUSE</button>
            </div>
          ))}
        </div>
      )}

      {rebalance?.isActive && (
        <div className="rounded-xl border border-lime-400/20 bg-lime-950/10 px-3 py-2.5 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="w-1.5 h-1.5 rounded-full bg-lime-400 animate-pulse" />
            <span className="text-[10px] font-mono font-bold text-white">Rebalance</span>
            <span className="text-[9px] font-mono text-white/30">max {rebalance.config?.maxAllocPct}% per token</span>
          </div>
          <button onClick={() => rebalance.updateConfig({ enabled: false })} className="text-[9px] font-mono text-red-400/60 hover:text-red-400">STOP</button>
        </div>
      )}

      {tpslConfigs.length > 0 && (
        <div className="space-y-1.5">
          <div className="text-[9px] font-mono text-white/30 tracking-widest">ACTIVE TP/SL</div>
          {tpslConfigs.map(({ curveId, config }) => (
            <div key={curveId} className="rounded-xl border border-white/8 bg-white/[0.02] px-3 py-2.5">
              <div className="flex items-center justify-between mb-1">
                <div className="text-[9px] font-mono text-white/50 truncate">{curveId.slice(0,14)}…</div>
                <button onClick={() => handleClearTPSL(curveId)} className="text-white/20 hover:text-red-400 ml-2 shrink-0"><Trash2 size={11} /></button>
              </div>
              <div className="space-y-0.5">
                {(config.levels ?? []).map((level, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <span className={`text-[9px] font-mono ${level.triggered ? 'text-white/20 line-through' : level.type === 'tp' ? 'text-lime-400' : 'text-red-400'}`}>
                      {level.type === 'tp' ? '▲' : '▼'} {level.pct > 0 ? '+' : ''}{level.pct}%
                    </span>
                    <span className="text-[8px] font-mono text-white/30">sell {level.sellPct}%{level.triggered ? ' · triggered' : ''}</span>
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
export default function StrategiesModal({ onClose, tradeKey, sniper, dca, copyTrade, rebalance }) {
  const [tab, setTab] = useState('key');
  const { keypair, isReady, hasKey } = tradeKey;

  const anyActive = sniper?.isActive || (dca?.activeOrders?.length ?? 0) > 0
    || copyTrade?.isActive || rebalance?.isActive;

  useEffect(() => {
    const handler = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  const TABS = [
    { id: 'key',      label: '🔑 Key'      },
    { id: 'sniper',   label: '🔫 Sniper'   },
    { id: 'dca',      label: '📅 DCA'      },
    { id: 'copy',     label: '👁️ Copy'     },
    { id: 'rebal',    label: '⚖️ Rebal'    },
    { id: 'active',   label: '⚡ Active'   },
  ];

  const activeDot = {
    sniper: sniper?.isActive,
    dca:    (dca?.activeOrders?.length ?? 0) > 0,
    copy:   copyTrade?.isActive,
    rebal:  rebalance?.isActive,
  };

  return (
    <>
      <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-40" onClick={onClose} />
      <div className="fixed bottom-0 left-0 right-0 sm:bottom-auto sm:top-1/2 sm:left-1/2 sm:-translate-x-1/2 sm:-translate-y-1/2 sm:max-w-lg sm:w-full z-50 rounded-t-2xl sm:rounded-2xl border border-white/10 bg-[#0d0d0d] overflow-hidden flex flex-col"
        style={{ fontFamily: "'JetBrains Mono', ui-monospace, monospace", maxHeight: '88vh' }}>

        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-white/8 shrink-0">
          <div className="flex items-center gap-2">
            <Zap size={13} className="text-lime-400" />
            <span className="text-[11px] font-mono font-bold text-white tracking-widest">TRADING STRATEGIES</span>
            {anyActive && <span className="w-1.5 h-1.5 rounded-full bg-lime-400 animate-pulse" />}
          </div>
          <button onClick={onClose} className="text-white/30 hover:text-white"><X size={16} /></button>
        </div>

        {/* Active strip */}
        {anyActive && (
          <div className="px-5 py-2 bg-lime-950/20 border-b border-lime-400/10 flex items-center gap-3 shrink-0">
            <span className="w-1.5 h-1.5 rounded-full bg-lime-400 animate-pulse shrink-0" />
            <span className="text-[9px] font-mono text-lime-400/70 flex-1">
              {[
                sniper?.isActive && 'Sniper active',
                (dca?.activeOrders?.length ?? 0) > 0 && `${dca.activeOrders.length} DCA order${dca.activeOrders.length !== 1 ? 's' : ''}`,
                copyTrade?.isActive && 'Copy trade active',
                rebalance?.isActive && 'Rebalance active',
              ].filter(Boolean).join(' · ')}
            </span>
            <span className="text-[9px] font-mono text-lime-400/40">running in background</span>
          </div>
        )}

        {/* Tabs */}
        <div className="flex border-b border-white/8 shrink-0 overflow-x-auto scrollbar-hide">
          {TABS.map(tb => (
            <button key={tb.id} onClick={() => setTab(tb.id)}
              className={`shrink-0 px-3 py-3 text-[10px] font-mono font-bold tracking-wider transition-colors relative ${
                tab === tb.id ? 'text-lime-400 border-b-2 border-lime-400 bg-lime-400/5' : 'text-white/30 hover:text-white/60'
              }`}>
              {tb.label}
              {activeDot[tb.id] && <span className="absolute top-2 right-1 w-1 h-1 rounded-full bg-lime-400" />}
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="px-5 py-5 overflow-y-auto flex-1">
          {tab === 'key'    && <TradingKeyTab {...tradeKey} />}
          {tab === 'sniper' && <SniperTab    sniper={sniper}           hasKey={hasKey} isReady={isReady} onClose={onClose} />}
          {tab === 'dca'    && <DCATab       dca={dca}                 hasKey={hasKey} isReady={isReady} onClose={onClose} />}
          {tab === 'copy'   && <CopyTradeTab copyTrade={copyTrade}     hasKey={hasKey} isReady={isReady} onClose={onClose} />}
          {tab === 'rebal'  && <RebalanceTab rebalance={rebalance}     hasKey={hasKey} isReady={isReady} onClose={onClose} />}
          {tab === 'active' && <ActiveStrategiesTab sniper={sniper} dca={dca} copyTrade={copyTrade} rebalance={rebalance} />}
        </div>
      </div>
    </>
  );
}
