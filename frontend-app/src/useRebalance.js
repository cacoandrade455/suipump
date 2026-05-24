// useRebalance.js
// Monitors the user's trading wallet portfolio via the indexer.
// When any token's value exceeds maxAllocPct% of total portfolio value,
// sells the excess back to SUI using the trading keypair.
//
// Storage key: suipump_rebalance_${walletAddress}
// Schema: {
//   enabled: boolean,
//   maxAllocPct: number,     // max % any single token can be of total portfolio
//   checkIntervalMs: number, // how often to check (default: 60s)
//   slippage: number,
//   log: [{ ts, curveId, name, symbol, soldTokens, reason, success, digest?, error? }]
// }

import { useState, useEffect, useRef, useCallback } from 'react';
import { SuiClient, getFullnodeUrl } from '@mysten/sui/client';
import { Transaction } from '@mysten/sui/transactions';
import { curveShapeFor, isV7OrLater } from './constants.js';
import { sellQuote } from './curve.js';

const INDEXER_URL    = import.meta.env.VITE_INDEXER_URL || '';
const SUI_CLOCK_ID   = '0x6';
const TOKEN_DECIMALS = 6;
const REBAL_KEY      = (addr) => `suipump_rebalance_${addr}`;
const MAX_LOG        = 30;

export const REBALANCE_INTERVALS = [
  { label: '1 min',   ms: 60_000 },
  { label: '5 min',   ms: 300_000 },
  { label: '15 min',  ms: 900_000 },
  { label: '30 min',  ms: 1_800_000 },
  { label: '1 hour',  ms: 3_600_000 },
];

export const DEFAULT_REBALANCE_CONFIG = {
  enabled:         false,
  maxAllocPct:     30,
  checkIntervalMs: 300_000,
  slippage:        2,
  log:             [],
};

// ── Storage helpers ───────────────────────────────────────────────────────────

export function loadRebalanceConfig(walletAddress) {
  if (!walletAddress) return null;
  try {
    const raw = localStorage.getItem(REBAL_KEY(walletAddress));
    return raw ? JSON.parse(raw) : { ...DEFAULT_REBALANCE_CONFIG };
  } catch { return { ...DEFAULT_REBALANCE_CONFIG }; }
}

function saveRebalanceConfig(walletAddress, config) {
  if (!walletAddress) return;
  try { localStorage.setItem(REBAL_KEY(walletAddress), JSON.stringify(config)); } catch {}
}

function appendRebalanceLog(walletAddress, entry) {
  const cfg = loadRebalanceConfig(walletAddress) ?? { ...DEFAULT_REBALANCE_CONFIG };
  cfg.log = [{ ...entry, ts: Date.now() }, ...(cfg.log ?? [])].slice(0, MAX_LOG);
  saveRebalanceConfig(walletAddress, cfg);
  return cfg.log;
}

// ── Main hook ─────────────────────────────────────────────────────────────────

export function useRebalance({ walletAddress, keypair }) {
  const [config, setConfig]       = useState(() => loadRebalanceConfig(walletAddress) ?? { ...DEFAULT_REBALANCE_CONFIG });
  const [checking, setChecking]   = useState(false);
  const [lastCheck, setLastCheck] = useState(null);
  const keypairRef                = useRef(keypair);
  const tickRef                   = useRef(null);
  const firingRef                 = useRef(new Set());

  useEffect(() => { keypairRef.current = keypair; }, [keypair]);

  useEffect(() => {
    saveRebalanceConfig(walletAddress, config);
  }, [config, walletAddress]);

  // ── Check and rebalance ───────────────────────────────────────────────────
  const checkAndRebalance = useCallback(async () => {
    const kp = keypairRef.current;
    if (!kp || !walletAddress || checking) return;

    const cfg = loadRebalanceConfig(walletAddress) ?? config;
    if (!cfg.enabled) return;

    setChecking(true);
    setLastCheck(Date.now());

    try {
      const myAddress = kp.getPublicKey().toSuiAddress();

      // Fetch portfolio from indexer
      const res = await fetch(`${INDEXER_URL}/trader/${myAddress}`, {
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) throw new Error('Failed to fetch portfolio');
      const positions = await res.json();
      if (!positions.length) { setChecking(false); return; }

      // Fetch current SUI price for value calculations
      let suiUsd = 0;
      try {
        const pr = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=SUIUSDT', { signal: AbortSignal.timeout(3000) });
        const pj = await pr.json();
        suiUsd = parseFloat(pj.price) || 0;
      } catch {}

      // Get current token prices from indexer stats
      const client = new SuiClient({ url: getFullnodeUrl('testnet') });
      const posWithValue = [];

      for (const pos of positions) {
        if (!pos.curve_id || !pos.token_type) continue;
        try {
          const obj = await client.getObject({ id: pos.curve_id, options: { showContent: true } });
          const fields = obj.data?.content?.fields ?? {};
          const reserveMist    = Number(fields.sui_reserve ?? 0);
          const { virtualSui } = curveShapeFor(pos.package_id);
          const totalPoolSui   = reserveMist / 1e9 + virtualSui;
          const priceSui       = totalPoolSui / 1_000_000_000;

          // Get actual token balance
          const coins = await client.getCoins({ owner: myAddress, coinType: pos.token_type });
          const balanceAtomic = coins.data.reduce((s, c) => s + Number(c.balance), 0);
          const balanceWhole  = balanceAtomic / 10 ** TOKEN_DECIMALS;
          const valueSui      = balanceWhole * priceSui;

          if (valueSui > 0) {
            posWithValue.push({
              ...pos,
              balanceAtomic: BigInt(balanceAtomic),
              balanceWhole,
              valueSui,
              priceSui,
              reserveMist: BigInt(Math.round(reserveMist)),
              tokensRemaining: BigInt(fields.token_reserve ?? 0),
            });
          }
        } catch {}
      }

      if (!posWithValue.length) { setChecking(false); return; }

      // Total portfolio value in SUI
      const totalValueSui = posWithValue.reduce((s, p) => s + p.valueSui, 0);

      // Check each position
      for (const pos of posWithValue) {
        const allocPct = (pos.valueSui / totalValueSui) * 100;
        if (allocPct <= cfg.maxAllocPct) continue;
        if (firingRef.current.has(pos.curve_id)) continue;

        // How many tokens to sell to bring allocation down to maxAllocPct
        const targetValueSui  = totalValueSui * (cfg.maxAllocPct / 100);
        const excessValueSui  = pos.valueSui - targetValueSui;
        const tokensToSell    = Math.floor(excessValueSui / pos.priceSui * 10 ** TOKEN_DECIMALS);
        if (tokensToSell <= 0) continue;

        firingRef.current.add(pos.curve_id);

        let logEntry = {
          curveId: pos.curve_id,
          name:    pos.name   ?? '',
          symbol:  pos.symbol ?? '',
          soldTokens: tokensToSell / 10 ** TOKEN_DECIMALS,
          reason:  `${allocPct.toFixed(1)}% → ${cfg.maxAllocPct}%`,
          success: false,
        };

        try {
          const objForRef = await client.getObject({ id: pos.curve_id, options: { showOwner: true } });
          const isv = objForRef.data?.owner?.Shared?.initial_shared_version;
          if (!isv) throw new Error('Could not resolve curve version');

          const tokInAtomic = BigInt(tokensToSell);
          const sq = sellQuote(pos.reserveMist, pos.tokensRemaining, tokInAtomic,
            curveShapeFor(pos.package_id).virtualSui,
            curveShapeFor(pos.package_id).virtualTokens);
          const minOut = sq?.suiOut != null
            ? BigInt(Math.floor(Number(sq.suiOut) * (1 - cfg.slippage / 100)))
            : 0n;

          const tx = new Transaction();
          tx.setSender(myAddress);
          const curveRef = tx.sharedObjectRef({ objectId: pos.curve_id, initialSharedVersion: isv, mutable: true });

          const coins    = await client.getCoins({ owner: myAddress, coinType: pos.token_type });
          const coinObjs = coins.data.map(c => tx.object(c.coinObjectId));
          if (coinObjs.length > 1) tx.mergeCoins(coinObjs[0], coinObjs.slice(1));
          const [tokenCoin] = tx.splitCoins(coinObjs[0], [tx.pure.u64(tokInAtomic)]);

          const sellArgs = isV7OrLater(pos.package_id)
            ? [curveRef, tokenCoin, tx.pure.u64(minOut), tx.pure.option('address', null)]
            : [curveRef, tokenCoin, tx.pure.u64(minOut)];

          const [suiOut] = tx.moveCall({
            target: `${pos.package_id}::bonding_curve::sell`,
            typeArguments: [pos.token_type],
            arguments: sellArgs,
          });
          tx.transferObjects([suiOut], myAddress);

          const builtTx       = await tx.build({ client });
          const { signature } = await kp.signTransaction(builtTx);
          const result        = await client.executeTransactionBlock({
            transactionBlock: builtTx,
            signature,
            options: { showEffects: true },
          });

          logEntry = { ...logEntry, success: result.effects?.status?.status === 'success', digest: result.digest };
        } catch (err) {
          logEntry = { ...logEntry, success: false, error: err.message };
        } finally {
          setTimeout(() => firingRef.current.delete(pos.curve_id), 60_000);
        }

        const newLog = appendRebalanceLog(walletAddress, logEntry);
        setConfig(prev => ({ ...prev, log: newLog }));
      }
    } catch {}

    setChecking(false);
  }, [walletAddress, checking, config]);

  // ── Tick ──────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!config.enabled) { clearInterval(tickRef.current); return; }
    tickRef.current = setInterval(() => {
      if (keypairRef.current && walletAddress) checkAndRebalance();
    }, config.checkIntervalMs);
    return () => clearInterval(tickRef.current);
  }, [config.enabled, config.checkIntervalMs, walletAddress, checkAndRebalance]);

  // ── Public API ────────────────────────────────────────────────────────────

  const updateConfig = useCallback((patch) => {
    setConfig(prev => ({ ...prev, ...patch }));
  }, []);

  const clearLog = useCallback(() => {
    const updated = loadRebalanceConfig(walletAddress) ?? { ...DEFAULT_REBALANCE_CONFIG };
    updated.log = [];
    saveRebalanceConfig(walletAddress, updated);
    setConfig(prev => ({ ...prev, log: [] }));
  }, [walletAddress]);

  return {
    config,
    updateConfig,
    checking,
    lastCheck,
    checkAndRebalance,
    clearLog,
    log: config.log ?? [],
    isActive: config.enabled && !!keypair,
  };
}
