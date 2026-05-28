// useLimitOrder.js
// Non-custodial limit orders for SuiPump tokens.
//
// Buy limit:  executes when live price ≤ targetPriceSui (buy the dip)
// Sell limit: executes when live price ≥ targetPriceSui (sell into strength)
//
// Requires the trade keypair from useTradeKey — fully autonomous, no wallet popup.
// Polls every TICK_MS, groups pending orders by curveId to minimise fetches.
//
// Storage key: suipump_limitorders_${walletAddress}
// Order schema:
//   id, curveId, tokenType, pkgId, name, symbol,
//   side: 'buy' | 'sell',
//   targetPriceSui: number,   // trigger price in SUI per whole token
//   suiAmount: number,        // SUI to spend  (buy orders)
//   tokenAmount: number,      // whole tokens to sell (sell orders)
//   slippage: number,         // % slippage tolerance (default 2)
//   status: 'pending' | 'filled' | 'error' | 'cancelled',
//   createdAt, filledAt, digest, error

import { useState, useEffect, useRef, useCallback } from 'react';
import { SuiGraphQLClient } from '@mysten/sui/graphql';
import { Transaction }      from '@mysten/sui/transactions';
import {
  isV5OrLater, isV7OrLater, isV9OrLater, curveShapeFor,
} from './constants.js';
import { buyQuote, sellQuote } from './curve.js';

const INDEXER_URL    = import.meta.env.VITE_INDEXER_URL || '';
const SUI_CLOCK_ID   = '0x6';
const TOKEN_DECIMALS = 6;
const TICK_MS        = 5_000;
const MAX_ORDERS     = 20;
const ORDERS_KEY     = (addr) => `suipump_limitorders_${addr}`;

// ── Storage helpers ───────────────────────────────────────────────────────────

export function loadLimitOrders(walletAddress) {
  if (!walletAddress) return [];
  try { return JSON.parse(localStorage.getItem(ORDERS_KEY(walletAddress)) || '[]'); }
  catch { return []; }
}

function saveLimitOrders(walletAddress, orders) {
  if (!walletAddress) return;
  try { localStorage.setItem(ORDERS_KEY(walletAddress), JSON.stringify(orders)); } catch {}
}

function patchOrder(walletAddress, id, patch) {
  const orders  = loadLimitOrders(walletAddress);
  const updated = orders.map(o => o.id === id ? { ...o, ...patch } : o);
  saveLimitOrders(walletAddress, updated);
  return updated;
}

// ── Price fetch ───────────────────────────────────────────────────────────────
// Uses indexer's stored last_price (SUI per whole token) if available,
// falls back to computing from reserve via the CP formula.

async function fetchCurrentPrice(curveId, pkgId) {
  if (!INDEXER_URL) return null;
  try {
    const r = await fetch(`${INDEXER_URL}/token/${curveId}`, { signal: AbortSignal.timeout(3000) });
    if (!r.ok) return null;
    const d = await r.json();
    if (d.stats?.last_price > 0) return d.stats.last_price;
    // Fallback: derive from reserve
    const reserveSui = Number(d.stats?.reserve_sui ?? d.reserve_sui ?? 0);
    const { virtualSui, virtualTokens } = curveShapeFor(pkgId);
    const effSui = virtualSui + reserveSui;
    return (effSui * effSui) / (virtualSui * virtualTokens);
  } catch { return null; }
}

// ── Execute buy ───────────────────────────────────────────────────────────────

async function execBuy(kp, order) {
  const myAddress = kp.getPublicKey().toSuiAddress();
  const suiInMist = BigInt(Math.floor(order.suiAmount * 1e9));

  const curveData = await fetch(`${INDEXER_URL}/token/${order.curveId}`, { signal: AbortSignal.timeout(4000) })
    .then(r => r.ok ? r.json() : null);
  if (!curveData) throw new Error('Could not fetch curve from indexer');

  const isv = curveData.initialSharedVersion ?? curveData.initial_shared_version ?? null;
  if (!isv) throw new Error('Could not resolve curve ISV');

  const { virtualSui: vSui, virtualTokens: vTok } = curveShapeFor(order.pkgId);
  const reserveMist     = BigInt(Math.round((curveData.stats?.reserve_sui ?? 0) * 1e9));
  const tokensRemaining = BigInt(Math.round((curveData.stats?.token_reserve ?? 800_000_000) * 1e6));

  const quote  = buyQuote(reserveMist, tokensRemaining, suiInMist, vSui, vTok);
  const minOut = quote?.tokensOut != null
    ? BigInt(Math.floor(Number(quote.tokensOut) * (1 - (order.slippage ?? 2) / 100)))
    : 0n;

  const client   = new SuiGraphQLClient({ url: '/api/rpc' });
  const tx       = new Transaction();
  tx.setSender(myAddress);

  const curveRef  = tx.sharedObjectRef({ objectId: order.curveId, initialSharedVersion: String(isv), mutable: true });
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

  const builtTx = await tx.build({ client });
  const { signature } = await kp.signTransaction(builtTx);
  return client.executeTransaction({ transaction: builtTx, signatures: [signature] });
}

// ── Execute sell ──────────────────────────────────────────────────────────────

async function execSell(kp, order) {
  const myAddress   = kp.getPublicKey().toSuiAddress();
  const tokInAtomic = BigInt(Math.floor(order.tokenAmount * 10 ** TOKEN_DECIMALS));

  const curveData = await fetch(`${INDEXER_URL}/token/${order.curveId}`, { signal: AbortSignal.timeout(4000) })
    .then(r => r.ok ? r.json() : null);
  if (!curveData) throw new Error('Could not fetch curve from indexer');

  const isv = curveData.initialSharedVersion ?? curveData.initial_shared_version ?? null;
  if (!isv) throw new Error('Could not resolve curve ISV');

  const { virtualSui: vSui, virtualTokens: vTok } = curveShapeFor(order.pkgId);
  const reserveMist     = BigInt(Math.round((curveData.stats?.reserve_sui ?? 0) * 1e9));
  const tokensRemaining = BigInt(Math.round((curveData.stats?.token_reserve ?? 800_000_000) * 1e6));

  const sq     = sellQuote(reserveMist, tokensRemaining, tokInAtomic, vSui, vTok);
  const minOut = sq?.suiOut != null
    ? BigInt(Math.floor(Number(sq.suiOut) * (1 - (order.slippage ?? 2) / 100)))
    : 0n;

  const client = new SuiGraphQLClient({ url: '/api/rpc' });

  // Fetch token coins owned by the trading wallet
  const coinsResult = await client.getCoins({ owner: myAddress, coinType: order.tokenType });
  const coinObjs    = coinsResult?.data ?? [];
  if (!coinObjs.length) throw new Error('No token balance in trading wallet');

  const tx = new Transaction();
  tx.setSender(myAddress);

  const curveRef = tx.sharedObjectRef({ objectId: order.curveId, initialSharedVersion: String(isv), mutable: true });
  const objs     = coinObjs.map(c => tx.object(c.coinObjectId));
  if (objs.length > 1) tx.mergeCoins(objs[0], objs.slice(1));
  const [tokenCoin] = tx.splitCoins(objs[0], [tx.pure.u64(tokInAtomic)]);

  // V7+ sell adds referral option; V4-V6 is just (curve, coin, min_out)
  const sellArgs = isV7OrLater(order.pkgId)
    ? [curveRef, tokenCoin, tx.pure.u64(minOut), tx.pure.option('address', null)]
    : [curveRef, tokenCoin, tx.pure.u64(minOut)];

  const [suiOut] = tx.moveCall({
    target: `${order.pkgId}::bonding_curve::sell`,
    typeArguments: [order.tokenType],
    arguments: sellArgs,
  });
  tx.transferObjects([suiOut], myAddress);

  const builtTx = await tx.build({ client });
  const { signature } = await kp.signTransaction(builtTx);
  return client.executeTransaction({ transaction: builtTx, signatures: [signature] });
}

// ── Main hook ─────────────────────────────────────────────────────────────────

export function useLimitOrder({ walletAddress, keypair }) {
  const [orders, setOrders] = useState(() => loadLimitOrders(walletAddress));
  const keypairRef = useRef(keypair);
  const firingRef  = useRef(new Set()); // order IDs currently executing

  // Keep keypair ref fresh without restarting the tick effect
  useEffect(() => { keypairRef.current = keypair; }, [keypair]);

  // ── Create order ──────────────────────────────────────────────────────────
  const createOrder = useCallback((params) => {
    const {
      curveId, tokenType, pkgId,
      name, symbol,
      side,            // 'buy' | 'sell'
      targetPriceSui,  // SUI per whole token
      suiAmount,       // buy: SUI to spend
      tokenAmount,     // sell: whole tokens to sell
      slippage = 2,
    } = params;

    if (!curveId || !tokenType || !pkgId || !side || !targetPriceSui) return null;
    if (side === 'buy'  && (!suiAmount   || suiAmount   <= 0)) return null;
    if (side === 'sell' && (!tokenAmount || tokenAmount <= 0)) return null;

    const existing = loadLimitOrders(walletAddress);
    if (existing.filter(o => o.status === 'pending').length >= MAX_ORDERS) return null;

    const order = {
      id:             `lo_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      curveId,        tokenType, pkgId,
      name:           name   || curveId.slice(0, 8),
      symbol:         symbol || '???',
      side,           targetPriceSui,
      suiAmount:      suiAmount   ?? null,
      tokenAmount:    tokenAmount ?? null,
      slippage,
      status:         'pending',
      createdAt:      Date.now(),
      filledAt:       null,
      digest:         null,
      error:          null,
    };

    const updated = [...existing, order];
    saveLimitOrders(walletAddress, updated);
    setOrders(updated);
    return order.id;
  }, [walletAddress]);

  // ── Cancel a pending order ────────────────────────────────────────────────
  const cancelOrder = useCallback((id) => {
    const updated = patchOrder(walletAddress, id, { status: 'cancelled' });
    setOrders(updated);
  }, [walletAddress]);

  // ── Remove all filled / cancelled / errored orders ────────────────────────
  const clearCompleted = useCallback(() => {
    const remaining = loadLimitOrders(walletAddress).filter(o => o.status === 'pending');
    saveLimitOrders(walletAddress, remaining);
    setOrders(remaining);
  }, [walletAddress]);

  // ── Tick: price-check all pending orders and fire on trigger ──────────────
  useEffect(() => {
    if (!walletAddress) return;

    const tick = async () => {
      const kp      = keypairRef.current;
      const pending = loadLimitOrders(walletAddress).filter(o => o.status === 'pending');
      if (!kp || !pending.length) return;

      // Cache prices per curveId so we only fetch once per tick per token
      const priceCache = {};

      for (const order of pending) {
        if (firingRef.current.has(order.id)) continue;

        if (priceCache[order.curveId] === undefined) {
          priceCache[order.curveId] = await fetchCurrentPrice(order.curveId, order.pkgId);
        }
        const price = priceCache[order.curveId];
        if (!price) continue;

        const triggered =
          (order.side === 'buy'  && price <= order.targetPriceSui) ||
          (order.side === 'sell' && price >= order.targetPriceSui);

        if (!triggered) continue;

        firingRef.current.add(order.id);

        try {
          const result = order.side === 'buy'
            ? await execBuy(kp, order)
            : await execSell(kp, order);

          const digest  = result?.data?.executeTransaction?.digest ?? null;
          const success = !result?.errors?.length;

          const updated = patchOrder(walletAddress, order.id, {
            status:  success ? 'filled' : 'error',
            filledAt: success ? Date.now() : null,
            digest,
            error: success ? null : (result?.errors?.[0]?.message ?? 'Execution failed'),
          });
          setOrders(updated);
        } catch (err) {
          const updated = patchOrder(walletAddress, order.id, {
            status: 'error',
            error:  err.message || String(err),
          });
          setOrders(updated);
        } finally {
          firingRef.current.delete(order.id);
        }
      }
    };

    tick();
    const timer = setInterval(tick, TICK_MS);
    return () => clearInterval(timer);
  }, [walletAddress]);

  const pendingOrders   = orders.filter(o => o.status === 'pending');
  const completedOrders = orders.filter(o => o.status !== 'pending');

  return {
    orders,
    pendingOrders,
    completedOrders,
    createOrder,
    cancelOrder,
    clearCompleted,
    isActive: pendingOrders.length > 0,
  };
}
