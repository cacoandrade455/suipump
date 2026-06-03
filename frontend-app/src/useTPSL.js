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

export function makeLevel(type, pct, sellPct, extra = {}) {
  return {
    id:        `${type}_${pct}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    type,           // 'tp' | 'sl' | 'trail'
    pct,            // tp/sl: +50 means +50% for TP, -20 for SL. trail: unused (see trailPct)
    trailPct:  extra.trailPct ?? null,  // trail: % drop from peak that triggers (positive)
    sellPct,        // number — % of position to sell when triggered (1–100)
    ocoGroup:  extra.ocoGroup ?? null,  // optional — levels sharing a group cancel each other
    triggered: false,
    cancelled: false,  // set when an OCO sibling fired first
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
  // Runs on every price tick. Tracks the running peak (for trailing stops),
  // evaluates tp / sl / trail levels, and enforces OCO: when one level in a
  // group fires, its siblings are cancelled. Same-tick gaps fire at most one
  // level per OCO group.
  const checkLevels = useCallback((priceSui) => {
    if (!config?.enabled || !config.entryPriceSui || !priceSui) return;
    const entry    = config.entryPriceSui;
    const prevPeak = config.peakPrice ?? entry;
    const newPeak  = Math.max(prevPeak, priceSui);

    const fired       = [];
    const firedGroups = new Set();

    for (const level of (config.levels ?? [])) {
      if (level.triggered || level.cancelled || triggeredRef.current.has(level.id)) continue;
      // An OCO sibling already fired on this same tick — skip.
      if (level.ocoGroup && firedGroups.has(level.ocoGroup)) continue;

      const changePct = ((priceSui - entry) / entry) * 100;
      let hit = false;
      if (level.type === 'tp')         hit = changePct >= level.pct;
      else if (level.type === 'sl')    hit = changePct <= level.pct;
      else if (level.type === 'trail') {
        const dropPct = newPeak > 0 ? ((newPeak - priceSui) / newPeak) * 100 : 0;
        hit = dropPct >= (level.trailPct ?? Infinity);
      }

      if (hit) {
        fired.push(level);
        if (level.ocoGroup) firedGroups.add(level.ocoGroup);
      }
    }

    if (fired.length === 0) {
      // Persist a new peak even when nothing fired, so trailing stops ratchet up.
      if (newPeak > prevPeak) {
        setConfig(prev => {
          if (!prev) return prev;
          const updated = { ...prev, peakPrice: newPeak };
          saveTPSL(walletAddress, curveId, updated);
          return updated;
        });
      }
      return;
    }

    const firedIds = new Set(fired.map(l => l.id));
    fired.forEach(l => triggeredRef.current.add(l.id));

    setConfig(prev => {
      if (!prev) return prev;
      const updated = {
        ...prev,
        peakPrice: newPeak,
        levels: prev.levels.map(l => {
          if (firedIds.has(l.id)) return { ...l, triggered: true };
          // Cancel non-fired siblings in any group that fired this pass.
          if (l.ocoGroup && firedGroups.has(l.ocoGroup) && !l.triggered) {
            triggeredRef.current.add(l.id);
            return { ...l, cancelled: true };
          }
          return l;
        }),
      };
      saveTPSL(walletAddress, curveId, updated);
      return updated;
    });

    // Only the levels that actually fired execute a sell (cancelled siblings don't).
    fired.forEach(level => onTrigger({ level, currentPriceSui: priceSui }));
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
    const newConfig = { enabled: true, entryPriceSui, peakPrice: entryPriceSui, levels, createdAt: Date.now() };
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
