// useDCA.js
// Dollar-cost averaging — splits a total SUI amount into N tranches
// and buys on a fixed interval using the trading keypair (no Slush popup).
// Optionally sets TP/SL after each tranche.
//
// Storage key: suipump_dca_${walletAddress}
// Schema: array of DCA orders:
// [{
//   id: string,
//   curveId: string,
//   tokenType: string,
//   pkgId: string,
//   totalSui: number,
//   trancheCount: number,
//   intervalMs: number,
//   slippage: number,
//   autoTPSL: boolean,
//   tpPct: number, tpSellPct: number,
//   slPct: number, slSellPct: number,
//   executed: number,        // tranches executed so far
//   nextFireAt: number,      // timestamp ms of next tranche
//   createdAt: number,
//   done: boolean,
//   log: [{ ts, success, digest?, error?, suiSpent }]
// }]

import { useState, useEffect, useRef, useCallback } from 'react';
import { SuiGraphQLClient } from '@mysten/sui/graphql';
import { Transaction } from '@mysten/sui/transactions';
import { saveTPSL, makeLevel } from './useTPSL.js';
import {
  PACKAGE_ID_V8, MIST_PER_SUI,
  isV5OrLater, isV7OrLater, curveShapeFor,
} from './constants.js';
import { buyQuote } from './curve.js';

const SUI_CLOCK_ID   = '0x6';
const TOKEN_DECIMALS = 6;
const DCA_KEY        = (addr) => `suipump_dca_${addr}`;
const TICK_MS        = 5_000; // check every 5s

export const INTERVAL_OPTIONS = [
  { label: '1 min',   ms: 60_000 },
  { label: '5 min',   ms: 300_000 },
  { label: '15 min',  ms: 900_000 },
  { label: '30 min',  ms: 1_800_000 },
  { label: '1 hour',  ms: 3_600_000 },
  { label: '4 hours', ms: 14_400_000 },
  { label: '1 day',   ms: 86_400_000 },
];

// ── Storage helpers ───────────────────────────────────────────────────────────

export function loadDCAOrders(walletAddress) {
  if (!walletAddress) return [];
  try {
    const raw = localStorage.getItem(DCA_KEY(walletAddress));
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

function saveDCAOrders(walletAddress, orders) {
  if (!walletAddress) return;
  try { localStorage.setItem(DCA_KEY(walletAddress), JSON.stringify(orders)); } catch {}
}

function updateOrder(walletAddress, id, patch) {
  const orders = loadDCAOrders(walletAddress);
  const updated = orders.map(o => o.id === id ? { ...o, ...patch } : o);
  saveDCAOrders(walletAddress, updated);
  return updated;
}

// ── Main hook ─────────────────────────────────────────────────────────────────

export function useDCA({ walletAddress, keypair }) {
  const [orders, setOrders] = useState(() => loadDCAOrders(walletAddress));
  const keypairRef          = useRef(keypair);
  const tickRef             = useRef(null);
  const firingRef           = useRef(new Set()); // order IDs currently executing

  useEffect(() => { keypairRef.current = keypair; }, [keypair]);

  // ── Execute one tranche ───────────────────────────────────────────────────
  const executeTranche = useCallback(async (order) => {
    const kp = keypairRef.current;
    if (!kp || !walletAddress) return;
    if (firingRef.current.has(order.id)) return;
    firingRef.current.add(order.id);

    const suiPerTranche = order.totalSui / order.trancheCount;
    const suiInMist     = BigInt(Math.floor(suiPerTranche * 1e9));

    let logEntry = { ts: Date.now(), suiSpent: suiPerTranche, success: false };

    try {
      const client = new SuiGraphQLClient({ url: 'https://graphql.testnet.sui.io/graphql' });

      const objForRef = await client.getObject({
        id: order.curveId,
        options: { showOwner: true, showContent: true },
      });
      const isv    = objForRef.data?.owner?.Shared?.initial_shared_version;
      if (!isv) throw new Error('Could not resolve curve version');

      const fields         = objForRef.data?.content?.fields ?? {};
      const reserveMist    = BigInt(fields.sui_reserve    ?? 0);
      const tokensRemaining = BigInt(fields.token_reserve ?? 0);

      const vSui  = curveShapeFor(order.pkgId).virtualSui;
      const vTok  = curveShapeFor(order.pkgId).virtualTokens;
      const quote = buyQuote(reserveMist, tokensRemaining, suiInMist, vSui, vTok);
      const minOut = quote?.tokensOut != null
        ? BigInt(Math.floor(Number(quote.tokensOut) * (1 - order.slippage / 100)))
        : 0n;

      const tx = new Transaction();
      tx.setSender(kp.getPublicKey().toSuiAddress());

      const curveRef  = tx.sharedObjectRef({ objectId: order.curveId, initialSharedVersion: isv, mutable: true });
      const [payment] = tx.splitCoins(tx.gas, [tx.pure.u64(suiInMist)]);

      const buyArgs = isV5OrLater(order.pkgId)
        ? [curveRef, payment, tx.pure.u64(minOut), tx.pure.option('address', null), tx.object(SUI_CLOCK_ID)]
        : [curveRef, payment, tx.pure.u64(minOut)];

      const [tokens, refund] = tx.moveCall({
        target: `${order.pkgId}::bonding_curve::buy`,
        typeArguments: [order.tokenType],
        arguments: buyArgs,
      });
      tx.transferObjects([tokens, refund], kp.getPublicKey().toSuiAddress());

      const builtTx           = await tx.build({ client });
      const { signature }     = await kp.signTransaction(builtTx);
      const result            = await client.executeTransaction({
        transaction: builtTx,
        signature,
      });

      const success = result?.errors == null;
      logEntry = { ...logEntry, success, digest: result?.data?.executeTransaction?.digest };

      // Auto TP/SL on first tranche only (entry price set once)
      if (success && order.autoTPSL && order.executed === 0) {
        const entryPriceSui = (Number(reserveMist) / 1e9 + curveShapeFor(order.pkgId).virtualSui) / 1_000_000_000;
        const levels = [];
        if (order.tpPct) levels.push(makeLevel('tp', order.tpPct, order.tpSellPct));
        if (order.slPct) levels.push(makeLevel('sl', order.slPct, order.slSellPct));
        if (levels.length) {
          saveTPSL(walletAddress, order.curveId, {
            enabled: true,
            entryPriceSui,
            levels,
            createdAt: Date.now(),
            autoFromDCA: true,
          });
        }
      }
    } catch (err) {
      logEntry = { ...logEntry, success: false, error: err.message };
    } finally {
      firingRef.current.delete(order.id);
    }

    // Update order state
    const newExecuted = order.executed + 1;
    const isDone      = newExecuted >= order.trancheCount;
    const patch = {
      executed:   newExecuted,
      done:       isDone,
      nextFireAt: isDone ? null : Date.now() + order.intervalMs,
      log:        [logEntry, ...(order.log ?? [])].slice(0, 20),
    };
    const updated = updateOrder(walletAddress, order.id, patch);
    setOrders(updated);
  }, [walletAddress]);

  // ── Tick: check for due tranches ──────────────────────────────────────────
  useEffect(() => {
    tickRef.current = setInterval(() => {
      if (!keypairRef.current || !walletAddress) return;
      const now    = Date.now();
      const current = loadDCAOrders(walletAddress);
      for (const order of current) {
        if (order.done) continue;
        if (!order.nextFireAt || now < order.nextFireAt) continue;
        executeTranche(order);
      }
    }, TICK_MS);
    return () => clearInterval(tickRef.current);
  }, [walletAddress, executeTranche]);

  // ── Public API ────────────────────────────────────────────────────────────

  const createOrder = useCallback((params) => {
    const order = {
      id:           `dca_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      curveId:      params.curveId,
      tokenType:    params.tokenType,
      pkgId:        params.pkgId,
      totalSui:     params.totalSui,
      trancheCount: params.trancheCount,
      intervalMs:   params.intervalMs,
      slippage:     params.slippage ?? 2,
      autoTPSL:     params.autoTPSL ?? false,
      tpPct:        params.tpPct    ?? 200,
      tpSellPct:    params.tpSellPct ?? 100,
      slPct:        params.slPct    ?? -30,
      slSellPct:    params.slSellPct ?? 100,
      executed:     0,
      nextFireAt:   Date.now(), // fire first tranche immediately
      createdAt:    Date.now(),
      done:         false,
      log:          [],
      name:         params.name   ?? '',
      symbol:       params.symbol ?? '',
    };
    const updated = [...loadDCAOrders(walletAddress), order];
    saveDCAOrders(walletAddress, updated);
    setOrders(updated);
    return order;
  }, [walletAddress]);

  const cancelOrder = useCallback((id) => {
    const updated = loadDCAOrders(walletAddress).filter(o => o.id !== id);
    saveDCAOrders(walletAddress, updated);
    setOrders(updated);
  }, [walletAddress]);

  const clearDone = useCallback(() => {
    const updated = loadDCAOrders(walletAddress).filter(o => !o.done);
    saveDCAOrders(walletAddress, updated);
    setOrders(updated);
  }, [walletAddress]);

  const activeOrders = orders.filter(o => !o.done);
  const doneOrders   = orders.filter(o => o.done);

  return {
    orders,
    activeOrders,
    doneOrders,
    createOrder,
    cancelOrder,
    clearDone,
    isActive: activeOrders.length > 0 && !!keypair,
  };
}
