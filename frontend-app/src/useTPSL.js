// useTPSL.js — Take-Profit / Stop-Loss hook
// Monitors current token price via the SSE stream.
// When a TP or SL level is hit, calls onTrigger({ reason, pct, level })
// so the parent can prompt the user's Slush wallet to execute the sell.
//
// Storage: localStorage key = `suipump_tpsl_${walletAddress}_${curveId}`
// Schema:
// {
//   enabled: boolean,
//   entryPriceSui: number,        // price per whole token in SUI at time of set
//   levels: [
//     { id, type: 'tp'|'sl', pct: number, sellPct: number, triggered: boolean }
//   ]
// }

import { useState, useEffect, useRef, useCallback } from 'react';

const INDEXER_URL = import.meta.env.VITE_INDEXER_URL || '';

// ── Storage helpers ───────────────────────────────────────────────────────────

function storageKey(walletAddress, curveId) {
  return `suipump_tpsl_${walletAddress}_${curveId}`;
}

export function loadTPSL(walletAddress, curveId) {
  if (!walletAddress || !curveId) return null;
  try {
    const raw = localStorage.getItem(storageKey(walletAddress, curveId));
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

export function saveTPSL(walletAddress, curveId, config) {
  if (!walletAddress || !curveId) return;
  try {
    localStorage.setItem(storageKey(walletAddress, curveId), JSON.stringify(config));
  } catch {}
}

export function clearTPSL(walletAddress, curveId) {
  if (!walletAddress || !curveId) return;
  try {
    localStorage.removeItem(storageKey(walletAddress, curveId));
  } catch {}
}

function makeLevel(type, pct, sellPct) {
  return {
    id:        `${type}_${pct}_${Date.now()}`,
    type,      // 'tp' | 'sl'
    pct,       // number — e.g. 50 means +50% for TP, -20 means -20% for SL
    sellPct,   // number — % of position to sell when triggered (1–100)
    triggered: false,
  };
}

// ── Main hook ─────────────────────────────────────────────────────────────────

export function useTPSL({
  walletAddress,
  curveId,
  currentPriceSui,   // number — current price per whole token in SUI
  onTrigger,         // ({ level, currentPriceSui }) => void — called when a level hits
}) {
  const [config, setConfig] = useState(() => loadTPSL(walletAddress, curveId));
  const esRef    = useRef(null);
  const timerRef = useRef(null);
  // Prevent double-triggers on the same level across re-renders
  const triggeredRef = useRef(new Set());

  // ── Persist to localStorage whenever config changes ───────────────────────
  useEffect(() => {
    if (config) saveTPSL(walletAddress, curveId, config);
  }, [config, walletAddress, curveId]);

  // ── Price check: called on every SSE price update ────────────────────────
  const checkLevels = useCallback((priceSui) => {
    if (!config?.enabled || !config.entryPriceSui || !priceSui) return;
    const entry = config.entryPriceSui;

    config.levels?.forEach(level => {
      if (level.triggered || triggeredRef.current.has(level.id)) return;

      const changePct = ((priceSui - entry) / entry) * 100;

      let hit = false;
      if (level.type === 'tp' && changePct >= level.pct) hit = true;
      if (level.type === 'sl' && changePct <= level.pct) hit = true;

      if (hit) {
        triggeredRef.current.add(level.id);
        // Mark triggered in storage before calling onTrigger
        // so a page refresh doesn't re-fire it
        setConfig(prev => {
          if (!prev) return prev;
          const updated = {
            ...prev,
            levels: prev.levels.map(l =>
              l.id === level.id ? { ...l, triggered: true } : l
            ),
          };
          saveTPSL(walletAddress, curveId, updated);
          return updated;
        });
        onTrigger({ level, currentPriceSui: priceSui });
      }
    });
  }, [config, walletAddress, curveId, onTrigger]);

  // ── SSE subscription ──────────────────────────────────────────────────────
  useEffect(() => {
    if (!curveId || !INDEXER_URL || !config?.enabled) return;

    function connect() {
      const es = new EventSource(`${INDEXER_URL}/stream?curveId=${curveId}`);
      esRef.current = es;

      es.onmessage = (e) => {
        try {
          const event = JSON.parse(e.data);
          if (event.type === 'connected') return;
          const isTrade =
            event.type === 'TokensPurchased' ||
            event.type === 'TokensBought'    ||
            event.type === 'TokensSold';
          if (!isTrade) return;

          // Compute spot price from event data using the same formula as PriceChart
          // price = (virtual_sui + new_sui_reserve) / total_supply
          const d = event.data ?? {};
          const newReserveMist = Number(d.new_sui_reserve ?? 0);
          if (!newReserveMist) return;

          // We need the virtual SUI for this curve's package version.
          // The event doesn't carry it but we can use a safe default (3500 for V8)
          // or read it from the parent prop. We pass it through via curveVSui prop.
          // For now derive from event.eventType package prefix:
          const evtPkg = event.eventType?.split('::')?.[0] ?? '';
          let vSuiWhole = 3500;
          if (evtPkg.startsWith('0x2154')) vSuiWhole = 30000;
          else if (evtPkg.startsWith('0x785c') || evtPkg.startsWith('0x21d5')) vSuiWhole = 10000;
          else if (evtPkg.startsWith('0xfb8f')) vSuiWhole = 5000;

          const totalPoolSui = (vSuiWhole + newReserveMist / 1e9);
          const priceSui = totalPoolSui / 1_000_000_000; // per whole token

          checkLevels(priceSui);
        } catch {}
      };

      es.onerror = () => {
        es.close();
        timerRef.current = setTimeout(connect, 3000);
      };
    }

    connect();
    return () => {
      esRef.current?.close();
      clearTimeout(timerRef.current);
    };
  }, [curveId, config?.enabled, checkLevels]);

  // ── Also check on every currentPriceSui prop change (handles tab-open case) ─
  useEffect(() => {
    if (currentPriceSui > 0) checkLevels(currentPriceSui);
  }, [currentPriceSui, checkLevels]);

  // ── Public API ────────────────────────────────────────────────────────────

  const activate = useCallback((entryPriceSui, levels) => {
    const newConfig = { enabled: true, entryPriceSui, levels, createdAt: Date.now() };
    triggeredRef.current.clear();
    setConfig(newConfig);
    saveTPSL(walletAddress, curveId, newConfig);
  }, [walletAddress, curveId]);

  const deactivate = useCallback(() => {
    clearTPSL(walletAddress, curveId);
    triggeredRef.current.clear();
    setConfig(null);
  }, [walletAddress, curveId]);

  const dismissLevel = useCallback((levelId) => {
    setConfig(prev => {
      if (!prev) return prev;
      return { ...prev, levels: prev.levels.filter(l => l.id !== levelId) };
    });
  }, []);

  return {
    config,         // current TP/SL config or null
    activate,       // (entryPriceSui, levels[]) => void
    deactivate,     // () => void
    dismissLevel,   // (levelId) => void
    makeLevel,      // helper: makeLevel(type, pct, sellPct)
    isActive: !!config?.enabled,
  };
}
