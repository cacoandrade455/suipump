// useDCA.js v2 — Time-based + Dip-based DCA
//
// mode: 'time' — splits totalSui into N tranches on a fixed interval (original)
// mode: 'dip'  — watches price, buys suiPerDip when price drops dipPct% from refPrice
//                refPrice resets after each buy (tracks last-buy price)
//
// Storage: suipump_dca_${walletAddress} — array of orders

import { useState, useEffect, useRef, useCallback } from 'react';
import { SuiGraphQLClient } from '@mysten/sui/graphql';
import { Transaction } from '@mysten/sui/transactions';
import { saveTPSL, makeLevel } from './useTPSL.js';
import { isV5OrLater, isV9OrLater, curveShapeFor } from './constants.js';
import { buyQuote } from './curve.js';

const INDEXER_URL  = import.meta.env.VITE_INDEXER_URL || '';
const SUI_CLOCK_ID = '0x6';
const DCA_KEY      = (addr) => `suipump_dca_${addr}`;
const TICK_MS      = 5_000;

export const INTERVAL_OPTIONS = [
  { label: '1 min',   ms: 60_000 },
  { label: '5 min',   ms: 300_000 },
  { label: '15 min',  ms: 900_000 },
  { label: '30 min',  ms: 1_800_000 },
  { label: '1 hour',  ms: 3_600_000 },
  { label: '4 hours', ms: 14_400_000 },
  { label: '1 day',   ms: 86_400_000 },
];

// ── Storage ───────────────────────────────────────────────────────────────────

export function loadDCAOrders(walletAddress) {
  if (!walletAddress) return [];
  try { return JSON.parse(localStorage.getItem(DCA_KEY(walletAddress)) || '[]'); }
  catch { return []; }
}

function saveDCAOrders(walletAddress, orders) {
  if (!walletAddress) return;
  try { localStorage.setItem(DCA_KEY(walletAddress), JSON.stringify(orders)); } catch {}
}

function updateOrder(walletAddress, id, patch) {
  const orders  = loadDCAOrders(walletAddress);
  const updated = orders.map(o => o.id === id ? { ...o, ...patch } : o);
  saveDCAOrders(walletAddress, updated);
  return updated;
}

// ── Price fetch ───────────────────────────────────────────────────────────────

async function fetchCurrentPrice(curveId, pkgId) {
  if (!INDEXER_URL) return null;
  try {
    const r = await fetch(`${INDEXER_URL}/token/${curveId}`, { signal: AbortSignal.timeout(3000) });
    if (!r.ok) return null;
    const d = await r.json();
    const reserveSui   = d.stats?.reserve_sui ?? d.reserve_sui ?? 0;
    const { virtualSui } = curveShapeFor(pkgId);
    // price = (virtualSui + reserveSui) / TOTAL_SUPPLY
    return (reserveSui + virtualSui) / 1_000_000_000;
  } catch { return null; }
}

// ── Core buy ─────────────────────────────────────────────────────────────────

async function executeBuy({ kp, order, suiAmount, walletAddress }) {
  const suiInMist = BigInt(Math.floor(suiAmount * 1e9));
  const myAddress = kp.getPublicKey().toSuiAddress();

  const curveData = await fetch(`${INDEXER_URL}/token/${order.curveId}`, { signal: AbortSignal.timeout(4000) })
    .then(r => r.ok ? r.json() : null);
  if (!curveData) throw new Error('Could not fetch curve from indexer');
  const isv = curveData.initialSharedVersion ?? curveData.initial_shared_version ?? null;
  if (!isv) throw new Error('Could not resolve curve version');

  const reserveMist     = BigInt(Math.round((curveData.stats?.reserve_sui ?? curveData.reserve_sui ?? 0) * 1e9));
  const tokensRemaining = BigInt(Math.round((curveData.stats?.token_reserve ?? curveData.token_reserve ?? 800_000_000) * 1e6));
  const { virtualSui, virtualTokens } = curveShapeFor(order.pkgId);

  const quote  = buyQuote(reserveMist, tokensRemaining, suiInMist, virtualSui, virtualTokens);
  const minOut = quote?.tokensOut != null
    ? BigInt(Math.floor(Number(quote.tokensOut) * (1 - order.slippage / 100)))
    : 0n;

  const client = new SuiGraphQLClient({ url: '/api/rpc' });
  const tx = new Transaction();
  tx.setSender(myAddress);

  const curveRef  = tx.sharedObjectRef({ objectId: order.curveId, initialSharedVersion: isv, mutable: true });
  const [payment] = tx.splitCoins(tx.gas, [tx.pure.u64(suiInMist)]);

  const buyArgs = isV9OrLater(order.pkgId)
    ? [curveRef, payment, tx.pure.u64(minOut), tx.pure.option('address', null), tx.object(SUI_CLOCK_ID), tx.pure.u64(0)]
    : isV5OrLater(order.pkgId)
      ? [curveRef, payment, tx.pure.u64(minOut), tx.pure.option('address', null), tx.object(SUI_CLOCK_ID)]
      : [curveRef, payment, tx.pure.u64(minOut)];

  const [tokens, refund] = tx.moveCall({
    target: `${order.pkgId}::bonding_curve::buy`,
    typeArguments: [order.tokenType],
    arguments: buyArgs,
  });
  tx.transferObjects([tokens, refund], myAddress);

  const builtTx       = await tx.build({ client });
  const { signature } = await kp.signTransaction(builtTx);
  const result        = await client.executeTransaction({
    transaction: builtTx,
    signatures: [signature],
  });

  const newPriceSui = (Number(reserveMist) / 1e9 + virtualSui) / 1_000_000_000;
  return { result, newPriceSui };
}

// ── Main hook ─────────────────────────────────────────────────────────────────

export function useDCA({ walletAddress, keypair }) {
  const [orders, setOrders] = useState(() => loadDCAOrders(walletAddress));
  const keypairRef          = useRef(keypair);
  const tickRef             = useRef(null);
  const firingRef           = useRef(new Set());

  useEffect(() => { keypairRef.current = keypair; }, [keypair]);
  useEffect(() => { setOrders(loadDCAOrders(walletAddress)); }, [walletAddress]);

  // ── Execute time-based tranche ────────────────────────────────────────────
  const executeTimeTranche = useCallback(async (order) => {
    const kp = keypairRef.current;
    if (!kp || !walletAddress) return;
    if (firingRef.current.has(order.id)) return;
    firingRef.current.add(order.id);

    const suiPerTranche = order.totalSui / order.trancheCount;
    let logEntry = { ts: Date.now(), suiSpent: suiPerTranche, success: false, mode: 'time' };

    try {
      const { result, newPriceSui } = await executeBuy({ kp, order, suiAmount: suiPerTranche, walletAddress });
      const success = result?.errors == null;
      logEntry = { ...logEntry, success, digest: result?.data?.executeTransaction?.digest };

      if (success && order.autoTPSL && order.executed === 0) {
        const levels = [];
        if (order.tpPct) levels.push(makeLevel('tp', order.tpPct, order.tpSellPct ?? 100));
        if (order.slPct) levels.push(makeLevel('sl', order.slPct, order.slSellPct ?? 100));
        if (levels.length) saveTPSL(walletAddress, order.curveId, { enabled: true, entryPriceSui: newPriceSui, levels, createdAt: Date.now(), autoFromDCA: true });
      }
    } catch (err) {
      logEntry = { ...logEntry, success: false, error: err.message };
    } finally {
      firingRef.current.delete(order.id);
    }

    const newExecuted = order.executed + 1;
    const isDone      = newExecuted >= order.trancheCount;
    const updated = updateOrder(walletAddress, order.id, {
      executed:   newExecuted,
      done:       isDone,
      nextFireAt: isDone ? null : Date.now() + order.intervalMs,
      log:        [logEntry, ...(order.log ?? [])].slice(0, 20),
    });
    setOrders(updated);
  }, [walletAddress]);

  // ── Execute dip buy ───────────────────────────────────────────────────────
  const executeDipBuy = useCallback(async (order, currentPrice) => {
    const kp = keypairRef.current;
    if (!kp || !walletAddress) return;
    if (firingRef.current.has(order.id)) return;
    firingRef.current.add(order.id);

    let logEntry = { ts: Date.now(), suiSpent: order.suiPerDip, success: false, mode: 'dip',
      priceTrigger: currentPrice, refPrice: order.refPrice };

    try {
      const { result, newPriceSui } = await executeBuy({ kp, order, suiAmount: order.suiPerDip, walletAddress });
      const success = result?.errors == null;
      logEntry = { ...logEntry, success, digest: result?.data?.executeTransaction?.digest };

      if (success) {
        const newBuyCount = (order.dipBuyCount ?? 0) + 1;
        const isDone = order.maxDipBuys > 0 && newBuyCount >= order.maxDipBuys;
        const updated = updateOrder(walletAddress, order.id, {
          dipBuyCount:  newBuyCount,
          done:         isDone,
          refPrice:     newPriceSui,         // reset reference to last buy price
          lastDipBuyAt: Date.now(),          // cooldown starts now
          log: [logEntry, ...(order.log ?? [])].slice(0, 20),
        });
        setOrders(updated);
        firingRef.current.delete(order.id);
        return;
      }
    } catch (err) {
      logEntry = { ...logEntry, success: false, error: err.message };
    }

    firingRef.current.delete(order.id);
    const updated = updateOrder(walletAddress, order.id, {
      log: [logEntry, ...(order.log ?? [])].slice(0, 20),
    });
    setOrders(updated);
  }, [walletAddress]);

  // ── Tick ──────────────────────────────────────────────────────────────────
  useEffect(() => {
    tickRef.current = setInterval(async () => {
      const kp = keypairRef.current;
      if (!kp || !walletAddress) return;

      const now     = Date.now();
      const current = loadDCAOrders(walletAddress);

      for (const order of current) {
        if (order.done) continue;
        if (firingRef.current.has(order.id)) continue;

        if (order.mode === 'time' || !order.mode) {
          // Time-based
          if (!order.nextFireAt || now < order.nextFireAt) continue;
          executeTimeTranche(order);

        } else if (order.mode === 'dip') {
          // Dip-based — check cooldown first
          const cooldownMs = (order.cooldownMin ?? 5) * 60_000;
          if (order.lastDipBuyAt && now - order.lastDipBuyAt < cooldownMs) continue;

          // Fetch current price
          const currentPrice = await fetchCurrentPrice(order.curveId, order.pkgId);
          if (!currentPrice || !order.refPrice) continue;

          const dropPct = ((order.refPrice - currentPrice) / order.refPrice) * 100;
          if (dropPct >= order.dipPct) {
            executeDipBuy(order, currentPrice);
          }
        }
      }
    }, TICK_MS);
    return () => clearInterval(tickRef.current);
  }, [walletAddress, executeTimeTranche, executeDipBuy]);

  // ── Public API ────────────────────────────────────────────────────────────

  const createOrder = useCallback((params) => {
    const base = {
      id:        `dca_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      curveId:   params.curveId,
      tokenType: params.tokenType,
      pkgId:     params.pkgId,
      slippage:  params.slippage ?? 2,
      mode:      params.mode ?? 'time',
      createdAt: Date.now(),
      done:      false,
      log:       [],
      name:      params.name   ?? '',
      symbol:    params.symbol ?? '',
    };

    let order;
    if (params.mode === 'dip') {
      order = {
        ...base,
        suiPerDip:    params.suiPerDip,
        dipPct:       params.dipPct,       // % drop to trigger
        cooldownMin:  params.cooldownMin ?? 5,
        maxDipBuys:   params.maxDipBuys ?? 0,  // 0 = unlimited
        refPrice:     params.refPrice,     // current price at creation
        dipBuyCount:  0,
        lastDipBuyAt: null,
      };
    } else {
      order = {
        ...base,
        totalSui:     params.totalSui,
        trancheCount: params.trancheCount,
        intervalMs:   params.intervalMs,
        autoTPSL:     params.autoTPSL  ?? false,
        tpPct:        params.tpPct     ?? 200,
        tpSellPct:    params.tpSellPct ?? 100,
        slPct:        params.slPct     ?? -30,
        slSellPct:    params.slSellPct ?? 100,
        executed:     0,
        nextFireAt:   Date.now(),
      };
    }

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

  return { orders, activeOrders, doneOrders, createOrder, cancelOrder, clearDone,
    isActive: activeOrders.length > 0 && !!keypair };
}
