// useCreatorBuyback.js
// Config storage and helpers for the creator fee auto-buyback feature.
//
// When enabled, the creator's "Claim Fees" button becomes "Claim & Reinvest X%"
// which executes two sequential transactions:
//   Tx1: claim_creator_fees → SUI lands in creator wallet
//   Tx2: buy() with X% of claimed SUI → tokens transferred to creator wallet
//
// Two Slush signatures required (atomic single-PTB not possible because
// claim_creator_fees uses transfer::public_transfer internally).
//
// Config stored in localStorage:
//   Key:   suipump_buyback_${walletAddress}_${curveId}
//   Value: { enabled, pct, curveId, tokenType, pkgId, symbol, name, createdAt }
//
// History stored separately:
//   Key:   suipump_buyback_log_${walletAddress}_${curveId}
//   Value: [{ ts, claimedSui, reinvestedSui, digest, success }]

import { useState, useCallback } from 'react';

const BUYBACK_THRESHOLD_MIST = 5_000_000_000n; // 5 SUI

const configKey = (wallet, curveId) => `suipump_buyback_${wallet}_${curveId}`;
const logKey    = (wallet, curveId) => `suipump_buyback_log_${wallet}_${curveId}`;

// ── Storage helpers ───────────────────────────────────────────────────────────

export function loadBuybackConfig(walletAddress, curveId) {
  if (!walletAddress || !curveId) return null;
  try {
    const raw = localStorage.getItem(configKey(walletAddress, curveId));
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

export function saveBuybackConfig(walletAddress, curveId, config) {
  if (!walletAddress || !curveId) return;
  try {
    localStorage.setItem(configKey(walletAddress, curveId), JSON.stringify(config));
  } catch {}
}

export function clearBuybackConfig(walletAddress, curveId) {
  if (!walletAddress || !curveId) return;
  try {
    localStorage.removeItem(configKey(walletAddress, curveId));
  } catch {}
}

export function loadBuybackLog(walletAddress, curveId) {
  if (!walletAddress || !curveId) return [];
  try {
    const raw = localStorage.getItem(logKey(walletAddress, curveId));
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

export function appendBuybackLog(walletAddress, curveId, entry) {
  const existing = loadBuybackLog(walletAddress, curveId);
  const updated  = [{ ...entry, ts: Date.now() }, ...existing].slice(0, 20);
  try { localStorage.setItem(logKey(walletAddress, curveId), JSON.stringify(updated)); } catch {}
  return updated;
}

// Scan all localStorage keys for a wallet's buyback configs (for StrategiesModal)
export function loadAllBuybackConfigs(walletAddress) {
  if (!walletAddress) return [];
  const prefix  = `suipump_buyback_${walletAddress}_`;
  const configs = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key?.startsWith(prefix) || key.includes('_log_')) continue;
      try {
        const config = JSON.parse(localStorage.getItem(key) || '{}');
        if (config.enabled) configs.push(config);
      } catch {}
    }
  } catch {}
  return configs;
}

// ── Threshold check ───────────────────────────────────────────────────────────

export const BUYBACK_THRESHOLD_SUI = Number(BUYBACK_THRESHOLD_MIST) / 1e9; // 5

export function buybackReady(creatorFeesMist) {
  return BigInt(creatorFeesMist ?? 0) >= BUYBACK_THRESHOLD_MIST;
}

// ── Hook ──────────────────────────────────────────────────────────────────────

export function useBuybackConfig(walletAddress, curveId) {
  const [config, setConfig] = useState(() => loadBuybackConfig(walletAddress, curveId));

  const save = useCallback((cfg) => {
    saveBuybackConfig(walletAddress, curveId, cfg);
    setConfig(cfg);
  }, [walletAddress, curveId]);

  const clear = useCallback(() => {
    clearBuybackConfig(walletAddress, curveId);
    setConfig(null);
  }, [walletAddress, curveId]);

  return {
    config,
    save,
    clear,
    isEnabled:   !!config?.enabled,
    pct:         config?.pct ?? 50,
  };
}
