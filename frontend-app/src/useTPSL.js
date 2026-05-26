// useTPSL.js — Take-Profit / Stop-Loss hook
// Price updates arrive via latestOhlcPoint prop from TokenPage (shared SSE feed).
// No internal SSE connection — zero extra connections per page.
//
// Storage: localStorage key = `suipump_tpsl_${walletAddress}_${curveId}`

import { useState, useEffect, useRef, useCallback } from 'react';

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

export function makeLevel(type, pct, sellPct) {
  return {
    id:        `${type}_${pct}_${Date.now()}`,
    type,      // 'tp' | 'sl'
    pct,       // number — e.g. 50 means +50% for TP, -20 means -20% for SL
    sellPct,   // number — % of position to sell when triggered (1–100)
    triggered: false,
  };
}

// ── Main hook ─────────────────────────────────────────────────────────────────
// latestOhlcPoint: { time, price, kind } | null — latest point from shared SSE feed
// currentPriceSui: number — derived price from curveState (handles tab-open case)

export function useTPSL({
  walletAddress,
  curveId,
  currentPriceSui,    // number — fallback for tab-open / pre-SSE case
  latestOhlcPoint,    // { time, price, kind } | null — from useTokenPageFeed
  onTrigger,          // ({ level, currentPriceSui }) => void
}) {
  const [config, setConfig] = useState(() => loadTPSL(walletAddress, curveId));
  const triggeredRef = useRef(new Set());

  // ── Persist to localStorage whenever config changes ───────────────────────
  useEffect(() => {
    if (config) saveTPSL(walletAddress, curveId, config);
  }, [config, walletAddress, curveId]);

  // ── Level checker ─────────────────────────────────────────────────────────
  const checkLevels = useCallback((priceSui) => {
    if (!config?.enabled || !config.entryPriceSui || !priceSui) return;
    const entry = config.entryPriceSui;

    config.levels?.forEach(level => {
      if (level.triggered || triggeredRef.current.has(level.id)) return;

      const changePct = ((priceSui - entry) / entry) * 100;
      const hit = (level.type === 'tp' && changePct >= level.pct) ||
                  (level.type === 'sl' && changePct <= level.pct);

      if (hit) {
        triggeredRef.current.add(level.id);
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

  // ── React to new SSE price point from shared feed ─────────────────────────
  useEffect(() => {
    if (latestOhlcPoint?.price > 0) checkLevels(latestOhlcPoint.price);
  }, [latestOhlcPoint, checkLevels]);

  // ── Fallback: check on curveState price change (tab-open / pre-SSE) ───────
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
    config,
    activate,
    deactivate,
    dismissLevel,
    makeLevel,
    isActive: !!config?.enabled,
  };
}
