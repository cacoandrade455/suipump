// StrategiesModal.jsx
// Slide-up modal accessible from the nav bar.
// Tab 1: Trading Key — paste private key, sign with Slush to encrypt, store locally.
// Tab 2: Sniper — auto-buy new tokens matching filters + auto TP/SL.
// Tab 3: Active — overview of all TP/SL configs + snipe log.

import React, { useState, useEffect } from 'react';
import { useCurrentAccount } from '@mysten/dapp-kit';
import { X, Key, ShieldAlert, Eye, EyeOff, Trash2, CheckCircle2, Loader2, AlertTriangle, ChevronRight, Zap, Crosshair, ToggleLeft, ToggleRight, ExternalLink } from 'lucide-react';
import { useTradeKey } from './useTradeKey.js';
import { loadTPSL, clearTPSL } from './useTPSL.js';
import { useSniper, DEFAULT_SNIPER_CONFIG, loadSnipeLog } from './useSniper.js';

const INDEXER_URL = import.meta.env.VITE_INDEXER_URL || '';

// ── Helper: load all TP/SL configs for this wallet ───────────────────────────
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

// ── Status icon ───────────────────────────────────────────────────────────────
function StatusIcon({ status }) {
  if (status === 'signing' || status === 'encrypting' || status === 'decrypting') {
    return <Loader2 size={14} className="animate-spin text-lime-400" />;
  }
  if (status === 'ready') return <CheckCircle2 size={14} className="text-lime-400" />;
  if (status === 'error') return <AlertTriangle size={14} className="text-red-400" />;
  return null;
}

// ── Trading key tab ───────────────────────────────────────────────────────────
function TradingKeyTab() {
  const account = useCurrentAccount();
  const { hasKey, keypair, status, error, saveKey, loadKey, removeKey, isReady } = useTradeKey();

  const [input, setInput]       = useState('');
  const [showKey, setShowKey]   = useState(false);
  const [msg, setMsg]           = useState('');

  const handleSave = async () => {
    if (!input.trim()) return;
    try {
      await saveKey(input.trim());
      setInput('');
      setMsg('Trading key saved and encrypted ✓');
      setTimeout(() => setMsg(''), 3000);
    } catch (e) {
      setMsg(e.message);
      setTimeout(() => setMsg(''), 4000);
    }
  };

  const handleLoad = async () => {
    try {
      await loadKey();
      setMsg('Key unlocked — strategies are active ✓');
      setTimeout(() => setMsg(''), 3000);
    } catch (e) {
      setMsg(e.message);
      setTimeout(() => setMsg(''), 4000);
    }
  };

  const handleRemove = () => {
    removeKey();
    setMsg('Trading key removed');
    setTimeout(() => setMsg(''), 2000);
  };

  if (!account) {
    return (
      <div className="py-12 text-center text-[11px] font-mono text-white/30">
        Connect your Slush wallet to set up a trading key
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Explainer */}
      <div className="rounded-xl border border-white/8 bg-white/[0.02] p-4 space-y-2">
        <div className="flex items-center gap-2">
          <Key size={11} className="text-lime-400/70" />
          <span className="text-[10px] font-mono font-bold text-white/60 tracking-widest">HOW IT WORKS</span>
        </div>
        <ul className="text-[10px] font-mono text-white/35 space-y-1.5 leading-relaxed">
          <li>→ Paste your Sui private key below</li>
          <li>→ Slush signs a message to derive an encryption key</li>
          <li>→ Your key is encrypted and stored in <span className="text-white/60">this browser only</span></li>
          <li>→ We never see your key. It never leaves your device.</li>
          <li>→ All strategies (TP/SL, sniper, DCA) use it to sign autonomously</li>
        </ul>
      </div>

      {/* Warning */}
      <div className="rounded-xl border border-yellow-400/15 bg-yellow-950/10 p-3 flex gap-2">
        <AlertTriangle size={11} className="text-yellow-400/60 shrink-0 mt-0.5" />
        <p className="text-[9px] font-mono text-yellow-400/50 leading-relaxed">
          Use a dedicated trading wallet with limited funds. Never paste your main wallet key. You are responsible for keeping your key safe.
        </p>
      </div>

      {/* Local storage disclaimer */}
      <div className="rounded-xl border border-white/5 bg-white/[0.02] px-4 py-3 flex items-start gap-2">
        <span className="text-lime-400/50 text-[11px] mt-0.5">🔒</span>
        <p className="text-[9px] font-mono text-white/35 leading-relaxed">
          Your encrypted key is stored <span className="text-white/60 font-bold">exclusively in your browser's localStorage</span>. It is never transmitted to any server, never stored in our database, and never accessible to anyone but you. Clearing your browser data will remove it.
        </p>
      </div>

      {/* Current status */}
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
              <button
                onClick={handleLoad}
                disabled={status === 'signing' || status === 'decrypting'}
                className="text-[9px] font-mono text-lime-400 hover:text-lime-300 transition-colors disabled:opacity-40"
              >
                UNLOCK
              </button>
            )}
            <button onClick={handleRemove} className="text-white/20 hover:text-red-400 transition-colors">
              <Trash2 size={11} />
            </button>
          </div>
        </div>
      )}

      {/* Paste key input */}
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
          <button
            onClick={() => setShowKey(s => !s)}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-white/20 hover:text-white/50 transition-colors"
          >
            {showKey ? <EyeOff size={12} /> : <Eye size={12} />}
          </button>
        </div>

        <button
          onClick={handleSave}
          disabled={!input.trim() || status === 'signing' || status === 'encrypting'}
          className={`w-full py-2.5 rounded-xl text-[11px] font-mono font-bold transition-colors flex items-center justify-center gap-2 ${
            !input.trim() || status === 'signing' || status === 'encrypting'
              ? 'bg-white/5 text-white/20 cursor-not-allowed'
              : 'bg-lime-400 text-black hover:bg-lime-300'
          }`}
        >
          {(status === 'signing' || status === 'encrypting')
            ? <><Loader2 size={12} className="animate-spin" /> {status === 'signing' ? 'Sign in Slush…' : 'Encrypting…'}</>
            : <><Key size={12} /> SAVE & ENCRYPT KEY</>
          }
        </button>
      </div>

      {/* Status message */}
      {(msg || error) && (
        <div className={`text-[10px] font-mono text-center ${
          msg.includes('✓') ? 'text-lime-400' : 'text-red-400'
        }`}>
          {msg || error}
        </div>
      )}

      {/* How to get private key hint */}
      <div className="text-[8px] font-mono text-white/15 leading-relaxed text-center">
        Slush: Settings → Security → Export Private Key · Use a dedicated wallet with limited funds only
      </div>
    </div>
  );
}

// ── Sniper tab ────────────────────────────────────────────────────────────────
function SniperTab({ keypair }) {
  const account = useCurrentAccount();
  const { config, updateConfig, enable, disable, log, clearLog, sniping, isActive } = useSniper({
    walletAddress: account?.address,
    keypair,
  });

  const [showAutoTPSL, setShowAutoTPSL] = useState(config.autoTPSL ?? true);

  const handleToggle = () => {
    if (isActive) disable();
    else enable();
  };

  if (!account) {
    return (
      <div className="py-12 text-center text-[11px] font-mono text-white/30">
        Connect your wallet to use the sniper
      </div>
    );
  }

  if (!keypair) {
    return (
      <div className="py-12 text-center space-y-2">
        <Crosshair size={24} className="text-white/10 mx-auto" />
        <div className="text-[11px] font-mono text-white/25">Trading key required</div>
        <div className="text-[9px] font-mono text-white/15">Set up your trading key first → it signs snipe transactions autonomously</div>
      </div>
    );
  }

  return (
    <div className="space-y-4">

      {/* Enable toggle */}
      <div className={`rounded-xl border p-3 flex items-center justify-between ${
        isActive ? 'border-lime-400/25 bg-lime-950/10' : 'border-white/8 bg-white/[0.02]'
      }`}>
        <div className="flex items-center gap-2">
          {sniping ? (
            <Loader2 size={13} className="animate-spin text-lime-400" />
          ) : (
            <span className={`w-2 h-2 rounded-full ${isActive ? 'bg-lime-400 animate-pulse' : 'bg-white/15'}`} />
          )}
          <span className="text-[11px] font-mono font-bold text-white">
            {sniping ? `Sniping…` : isActive ? 'Sniper Active' : 'Sniper Off'}
          </span>
          {isActive && !sniping && (
            <span className="text-[9px] font-mono text-white/30">watching for new tokens</span>
          )}
        </div>
        <button onClick={handleToggle} className="transition-colors">
          {isActive
            ? <ToggleRight size={22} className="text-lime-400" />
            : <ToggleLeft  size={22} className="text-white/25" />
          }
        </button>
      </div>

      {/* Filters */}
      <div className="space-y-3">
        <div className="text-[9px] font-mono text-white/30 tracking-widest">FILTERS</div>

        {/* Max SUI per snipe */}
        <div className="flex items-center justify-between gap-3">
          <span className="text-[10px] font-mono text-white/50 flex-1">Max SUI per snipe</span>
          <div className="relative w-24">
            <input
              type="number" min="0.1" step="0.1"
              value={config.maxSuiPerSnipe}
              onChange={e => updateConfig({ maxSuiPerSnipe: parseFloat(e.target.value) || 1 })}
              className="w-full bg-white/5 border border-white/10 rounded-lg px-2 py-1.5 text-[11px] font-mono text-white text-right focus:outline-none focus:border-lime-400/40 transition-colors"
            />
            <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[8px] font-mono text-white/20 pointer-events-none">SUI</span>
          </div>
        </div>

        {/* Max dev buy % */}
        <div className="flex items-center justify-between gap-3">
          <span className="text-[10px] font-mono text-white/50 flex-1">Max dev buy</span>
          <div className="relative w-24">
            <input
              type="number" min="0" max="100" step="1"
              value={config.maxDevBuyPct}
              onChange={e => updateConfig({ maxDevBuyPct: parseFloat(e.target.value) || 0 })}
              className="w-full bg-white/5 border border-white/10 rounded-lg px-2 py-1.5 text-[11px] font-mono text-white text-right focus:outline-none focus:border-lime-400/40 transition-colors"
            />
            <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[8px] font-mono text-white/20 pointer-events-none">%</span>
          </div>
        </div>

        {/* Min/max mcap */}
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-mono text-white/50 w-20 flex-shrink-0">Mcap range</span>
          <input
            type="number" min="0" placeholder="min SUI"
            value={config.minMcapSui || ''}
            onChange={e => updateConfig({ minMcapSui: parseFloat(e.target.value) || 0 })}
            className="flex-1 bg-white/5 border border-white/10 rounded-lg px-2 py-1.5 text-[11px] font-mono text-white placeholder-white/15 focus:outline-none focus:border-lime-400/40 transition-colors"
          />
          <span className="text-[9px] font-mono text-white/20">–</span>
          <input
            type="number" min="0" placeholder="max SUI"
            value={config.maxMcapSui || ''}
            onChange={e => updateConfig({ maxMcapSui: parseFloat(e.target.value) || 0 })}
            className="flex-1 bg-white/5 border border-white/10 rounded-lg px-2 py-1.5 text-[11px] font-mono text-white placeholder-white/15 focus:outline-none focus:border-lime-400/40 transition-colors"
          />
        </div>

        {/* Keyword */}
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-mono text-white/50 w-20 flex-shrink-0">Must contain</span>
          <input
            type="text" placeholder="keyword (optional)"
            value={config.keyword}
            onChange={e => updateConfig({ keyword: e.target.value })}
            className="flex-1 bg-white/5 border border-white/10 rounded-lg px-2 py-1.5 text-[11px] font-mono text-white placeholder-white/15 focus:outline-none focus:border-lime-400/40 transition-colors"
          />
        </div>

        {/* Exclude keyword */}
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-mono text-white/50 w-20 flex-shrink-0">Exclude</span>
          <input
            type="text" placeholder="skip if name contains…"
            value={config.excludeKeyword}
            onChange={e => updateConfig({ excludeKeyword: e.target.value })}
            className="flex-1 bg-white/5 border border-white/10 rounded-lg px-2 py-1.5 text-[11px] font-mono text-white placeholder-white/15 focus:outline-none focus:border-lime-400/40 transition-colors"
          />
        </div>

        {/* Graduation target */}
        <div className="flex items-center justify-between gap-3">
          <span className="text-[10px] font-mono text-white/50">Grad target</span>
          <div className="flex gap-1">
            {['any', 'cetus', 'turbos', 'deepbook'].map(v => (
              <button
                key={v}
                onClick={() => updateConfig({ gradTarget: v })}
                className={`px-2 py-1 rounded-lg text-[9px] font-mono transition-colors ${
                  config.gradTarget === v
                    ? 'bg-lime-400/10 border border-lime-400/30 text-lime-400'
                    : 'border border-white/8 text-white/30 hover:text-white/60'
                }`}
              >
                {v}
              </button>
            ))}
          </div>
        </div>

        {/* Slippage */}
        <div className="flex items-center justify-between gap-3">
          <span className="text-[10px] font-mono text-white/50">Slippage</span>
          <div className="flex gap-1">
            {['1', '2', '5', '10'].map(v => (
              <button
                key={v}
                onClick={() => updateConfig({ slippage: parseFloat(v) })}
                className={`px-2.5 py-1 rounded-lg text-[9px] font-mono transition-colors ${
                  config.slippage === parseFloat(v)
                    ? 'bg-lime-400/10 border border-lime-400/30 text-lime-400'
                    : 'border border-white/8 text-white/30 hover:text-white/60'
                }`}
              >
                {v}%
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Auto TP/SL */}
      <div className="rounded-xl border border-white/8 overflow-hidden">
        <button
          onClick={() => {
            const next = !config.autoTPSL;
            updateConfig({ autoTPSL: next });
            setShowAutoTPSL(next);
          }}
          className="w-full flex items-center justify-between px-4 py-3"
        >
          <div className="flex items-center gap-2">
            <ShieldAlert size={11} className={config.autoTPSL ? 'text-lime-400' : 'text-white/25'} />
            <span className="text-[10px] font-mono font-bold text-white/60">AUTO TP/SL ON SNIPE</span>
          </div>
          {config.autoTPSL
            ? <ToggleRight size={18} className="text-lime-400" />
            : <ToggleLeft  size={18} className="text-white/25" />
          }
        </button>

        {config.autoTPSL && (
          <div className="px-4 pb-3 space-y-2.5 border-t border-white/5 pt-3">
            <div className="text-[8px] font-mono text-white/20">Applied automatically after every successful snipe.</div>

            {/* TP row */}
            <div className="flex items-center gap-2">
              <span className="text-[9px] font-mono text-lime-400 w-6">TP</span>
              <div className="relative flex-1">
                <input
                  type="number" step="10"
                  value={config.tpPct}
                  onChange={e => updateConfig({ tpPct: parseFloat(e.target.value) || 100 })}
                  className="w-full bg-white/5 border border-lime-400/20 rounded-lg px-2 py-1.5 text-[11px] font-mono text-white text-right focus:outline-none focus:border-lime-400/40"
                />
                <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[8px] font-mono text-white/20">%</span>
              </div>
              <span className="text-[9px] font-mono text-white/25">sell</span>
              <div className="relative w-16">
                <input
                  type="number" min="1" max="100" step="5"
                  value={config.tpSellPct}
                  onChange={e => updateConfig({ tpSellPct: parseFloat(e.target.value) || 100 })}
                  className="w-full bg-white/5 border border-lime-400/20 rounded-lg px-2 py-1.5 text-[11px] font-mono text-white text-right focus:outline-none focus:border-lime-400/40"
                />
                <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[8px] font-mono text-white/20">%</span>
              </div>
            </div>

            {/* SL row */}
            <div className="flex items-center gap-2">
              <span className="text-[9px] font-mono text-red-400 w-6">SL</span>
              <div className="relative flex-1">
                <input
                  type="number" step="5"
                  value={config.slPct}
                  onChange={e => updateConfig({ slPct: parseFloat(e.target.value) || -20 })}
                  className="w-full bg-white/5 border border-red-400/20 rounded-lg px-2 py-1.5 text-[11px] font-mono text-white text-right focus:outline-none focus:border-red-400/40"
                />
                <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[8px] font-mono text-white/20">%</span>
              </div>
              <span className="text-[9px] font-mono text-white/25">sell</span>
              <div className="relative w-16">
                <input
                  type="number" min="1" max="100" step="5"
                  value={config.slSellPct}
                  onChange={e => updateConfig({ slSellPct: parseFloat(e.target.value) || 100 })}
                  className="w-full bg-white/5 border border-red-400/20 rounded-lg px-2 py-1.5 text-[11px] font-mono text-white text-right focus:outline-none focus:border-red-400/40"
                />
                <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[8px] font-mono text-white/20">%</span>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Snipe log */}
      {log.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-[9px] font-mono text-white/30 tracking-widest">RECENT SNIPES</span>
            <button onClick={clearLog} className="text-[9px] font-mono text-white/20 hover:text-red-400 transition-colors">
              clear
            </button>
          </div>
          <div className="space-y-1.5 max-h-48 overflow-y-auto">
            {log.map((entry, i) => (
              <div key={i} className={`rounded-lg border px-3 py-2 text-[10px] font-mono flex items-center justify-between ${
                entry.success ? 'border-lime-400/15 bg-lime-950/10' : 'border-red-400/15 bg-red-950/10'
              }`}>
                <div>
                  <span className={entry.success ? 'text-white/70' : 'text-red-400/70'}>
                    {entry.success ? '✓' : '✗'} {entry.name} <span className="text-lime-400/70">${entry.symbol}</span>
                  </span>
                  <div className="text-[8px] text-white/20 mt-0.5">
                    {entry.suiSpent} SUI · {entry.autoTPSL ? 'TP/SL set' : 'no TP/SL'}
                    {entry.error && ` · ${entry.error}`}
                  </div>
                </div>
                {entry.digest && (
                  <a
                    href={`https://suiexplorer.com/txblock/${entry.digest}?network=testnet`}
                    target="_blank" rel="noreferrer"
                    className="text-white/20 hover:text-lime-400 transition-colors"
                  >
                    <ExternalLink size={10} />
                  </a>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Tab-open warning */}
      <div className="text-[8px] font-mono text-white/15 text-center">
        Sniper runs while this tab is open · close tab = sniper stops
      </div>
    </div>
  );
}

// ── Active strategies tab ─────────────────────────────────────────────────────
function ActiveStrategiesTab() {
  const account = useCurrentAccount();
  const [configs, setConfigs]   = useState([]);
  const [tokens, setTokens]     = useState({}); // curveId → { name, symbol }
  const [, forceUpdate]         = useState(0);

  useEffect(() => {
    if (!account?.address) return;
    const loaded = loadAllTPSL(account.address);
    setConfigs(loaded);

    // Fetch token names from indexer
    loaded.forEach(async ({ curveId }) => {
      try {
        const res = await fetch(`${INDEXER_URL}/token/${curveId}`, { signal: AbortSignal.timeout(4000) });
        if (res.ok) {
          const data = await res.json();
          setTokens(prev => ({ ...prev, [curveId]: { name: data.name, symbol: data.symbol } }));
        }
      } catch {}
    });
  }, [account?.address]);

  const handleCancel = (walletAddress, curveId) => {
    clearTPSL(walletAddress, curveId);
    setConfigs(prev => prev.filter(c => c.curveId !== curveId));
    forceUpdate(n => n + 1);
  };

  if (!account) {
    return (
      <div className="py-12 text-center text-[11px] font-mono text-white/30">
        Connect your wallet to view active strategies
      </div>
    );
  }

  if (configs.length === 0) {
    return (
      <div className="py-12 text-center space-y-2">
        <ShieldAlert size={24} className="text-white/10 mx-auto" />
        <div className="text-[11px] font-mono text-white/25">No active strategies</div>
        <div className="text-[9px] font-mono text-white/15">Set up TP/SL on any token page</div>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {configs.map(({ curveId, config }) => {
        const tok     = tokens[curveId];
        const pending = config.levels?.filter(l => !l.triggered) ?? [];
        const done    = config.levels?.filter(l => l.triggered)  ?? [];

        return (
          <div key={curveId} className="rounded-xl border border-white/8 bg-white/[0.02] overflow-hidden">
            {/* Header */}
            <div className="px-4 py-3 flex items-center justify-between border-b border-white/5">
              <div className="flex items-center gap-2">
                <span className="w-1.5 h-1.5 rounded-full bg-lime-400 animate-pulse inline-block" />
                <span className="text-[11px] font-mono font-bold text-white">
                  {tok?.name ?? 'Loading…'}
                </span>
                {tok?.symbol && (
                  <span className="text-[10px] font-mono text-lime-400/70">${tok.symbol}</span>
                )}
              </div>
              <div className="flex items-center gap-3">
                <a
                  href={`/token/${curveId}`}
                  className="text-[9px] font-mono text-white/25 hover:text-lime-400 transition-colors flex items-center gap-0.5"
                >
                  VIEW <ChevronRight size={8} />
                </a>
                <button
                  onClick={() => handleCancel(account.address, curveId)}
                  className="text-white/20 hover:text-red-400 transition-colors"
                >
                  <Trash2 size={11} />
                </button>
              </div>
            </div>

            {/* Levels */}
            <div className="px-4 py-2.5 space-y-1.5">
              {config.levels?.map(level => (
                <div key={level.id} className="flex items-center justify-between text-[10px] font-mono">
                  <span className={`flex items-center gap-1.5 ${
                    level.triggered ? 'text-white/20 line-through' :
                    level.type === 'tp' ? 'text-lime-400' : 'text-red-400'
                  }`}>
                    {level.type === 'tp' ? '▲ TP' : '▼ SL'} {level.pct > 0 ? '+' : ''}{level.pct}%
                  </span>
                  <span className={level.triggered ? 'text-white/15' : 'text-white/35'}>
                    sell {level.sellPct}%{level.triggered ? ' · triggered' : ''}
                  </span>
                </div>
              ))}
              <div className="text-[9px] font-mono text-white/20 pt-1">
                Entry: {config.entryPriceSui?.toFixed(8)} SUI
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Main modal ────────────────────────────────────────────────────────────────
export default function StrategiesModal({ onClose }) {
  const [tab, setTab] = useState('key');
  const { keypair, isReady } = useTradeKey();

  // Close on Escape
  useEffect(() => {
    const handler = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/70 backdrop-blur-sm z-40"
        onClick={onClose}
      />

      {/* Modal */}
      <div className="fixed bottom-0 left-0 right-0 sm:bottom-auto sm:top-1/2 sm:left-1/2 sm:-translate-x-1/2 sm:-translate-y-1/2 sm:max-w-md sm:w-full z-50 rounded-t-2xl sm:rounded-2xl border border-white/10 bg-[#0d0d0d] overflow-hidden"
        style={{ fontFamily: "'JetBrains Mono', ui-monospace, monospace" }}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-white/8">
          <div className="flex items-center gap-2">
            <Zap size={13} className="text-lime-400" />
            <span className="text-[11px] font-mono font-bold text-white tracking-widest">TRADING STRATEGIES</span>
          </div>
          <button onClick={onClose} className="text-white/30 hover:text-white transition-colors">
            <X size={16} />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-white/8">
          {[
            { id: 'key',      label: '🔑 Key'     },
            { id: 'sniper',   label: '🔫 Sniper'  },
            { id: 'active',   label: '⚡ Active'  },
          ].map(t => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`flex-1 py-3 text-[10px] font-mono font-bold tracking-wider transition-colors ${
                tab === t.id
                  ? 'text-lime-400 border-b-2 border-lime-400 bg-lime-400/5'
                  : 'text-white/30 hover:text-white/60'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="px-5 py-5 max-h-[70vh] overflow-y-auto">
          {tab === 'key'    && <TradingKeyTab />}
          {tab === 'sniper' && <SniperTab keypair={isReady ? keypair : null} />}
          {tab === 'active' && <ActiveStrategiesTab />}
        </div>
      </div>
    </>
  );
}
