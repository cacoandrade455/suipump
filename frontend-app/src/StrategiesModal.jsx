// StrategiesModal.jsx
// Slide-up modal accessible from the nav bar.
// Tab 1: Trading Key — paste private key, sign with Slush to encrypt, store locally.
// Tab 2: Active Strategies — overview of all TP/SL configs across all tokens.

import React, { useState, useEffect } from 'react';
import { useCurrentAccount } from '@mysten/dapp-kit';
import { X, Key, ShieldAlert, Eye, EyeOff, Trash2, CheckCircle2, Loader2, AlertTriangle, ChevronRight, Zap } from 'lucide-react';
import { useTradeKey } from './useTradeKey.js';
import { loadTPSL, clearTPSL } from './useTPSL.js';

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
            { id: 'key',        label: '🔑 Trading Key' },
            { id: 'strategies', label: '⚡ Active' },
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
          {tab === 'key'        && <TradingKeyTab />}
          {tab === 'strategies' && <ActiveStrategiesTab />}
        </div>
      </div>
    </>
  );
}
