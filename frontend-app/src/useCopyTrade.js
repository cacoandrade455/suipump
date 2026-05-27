// v2-fixed
// useCopyTrade.js
// Monitors the global SSE stream for trades from watched wallets.
// When a watched wallet buys or sells, mirrors the trade using the trading keypair.
//
// Fixes vs previous version:
//  - token_type not in SSE event → fetch from indexer
//  - getObject (1.x API) → indexer fetch for ISV + reserves
//  - getCoins → listCoins (2.x API), coins.objects not coins.data
//  - c.coinObjectId → c.objectId
//  - signature → signatures: [signature] (SuiGraphQLClient 2.x)

import { useState, useEffect, useRef, useCallback } from 'react';
import { SuiGraphQLClient } from '@mysten/sui/graphql';
import { Transaction } from '@mysten/sui/transactions';
import { curveShapeFor, isV5OrLater, isV7OrLater, isV9OrLater } from './constants.js';
import { buyQuote, sellQuote } from './curve.js';

const INDEXER_URL    = import.meta.env.VITE_INDEXER_URL || '';
const SUI_CLOCK_ID   = '0x6';
const TOKEN_DECIMALS = 6;
const COPY_KEY       = (addr) => `suipump_copytrade_${addr}`;
const MAX_LOG        = 50;

// ── Storage helpers ───────────────────────────────────────────────────────────

export function loadCopyConfig(walletAddress) {
  if (!walletAddress) return null;
  try {
    const raw = localStorage.getItem(COPY_KEY(walletAddress));
    return raw ? JSON.parse(raw) : { targets: [], log: [] };
  } catch { return { targets: [], log: [] }; }
}

function saveCopyConfig(walletAddress, config) {
  if (!walletAddress) return;
  try { localStorage.setItem(COPY_KEY(walletAddress), JSON.stringify(config)); } catch {}
}

function appendLog(walletAddress, entry) {
  const cfg = loadCopyConfig(walletAddress) ?? { targets: [], log: [] };
  cfg.log = [{ ...entry, ts: Date.now() }, ...(cfg.log ?? [])].slice(0, MAX_LOG);
  saveCopyConfig(walletAddress, cfg);
  return cfg.log;
}

// ── Fetch curve data from indexer (ISV + reserves + tokenType) ────────────────
async function fetchCurveData(curveId) {
  if (!INDEXER_URL) return null;
  try {
    const r = await fetch(`${INDEXER_URL}/token/${curveId}`, { signal: AbortSignal.timeout(4000) });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

// ── Main hook ─────────────────────────────────────────────────────────────────

export function useCopyTrade({ walletAddress, keypair }) {
  const [config, setConfig]   = useState(() => loadCopyConfig(walletAddress) ?? { targets: [], log: [] });
  const keypairRef             = useRef(keypair);
  const esRef                  = useRef(null);
  const timerRef               = useRef(null);
  const firingRef              = useRef(new Set());

  useEffect(() => { keypairRef.current = keypair; }, [keypair]);

  useEffect(() => {
    if (walletAddress) {
      setConfig(loadCopyConfig(walletAddress) ?? { targets: [], log: [] });
    }
  }, [walletAddress]);

  // ── Execute a mirrored buy ────────────────────────────────────────────────
  const executeMirrorBuy = useCallback(async (target, curveId, tokenType, pkgId, name, symbol) => {
    const kp = keypairRef.current;
    if (!kp || !walletAddress) return;

    const suiInMist = BigInt(Math.floor(target.scaleSui * 1e9));
    const myAddress = kp.getPublicKey().toSuiAddress();
    let logEntry = { targetAddress: target.address, action: 'buy', curveId, name, symbol, suiAmount: target.scaleSui, success: false };

    try {
      // Fetch curve data from indexer — avoids SuiGraphQLClient 2.x getObject API mismatch
      const curveData = await fetchCurveData(curveId);
      if (!curveData) throw new Error('Could not fetch curve from indexer');
      const isv = curveData.initialSharedVersion ?? curveData.initial_shared_version ?? null;
      if (!isv) throw new Error('Could not resolve curve version');

      const reserveMist     = BigInt(Math.round((curveData.stats?.reserve_sui ?? curveData.reserve_sui ?? 0) * 1e9));
      const tokensRemaining = BigInt(Math.round((curveData.stats?.token_reserve ?? curveData.token_reserve ?? 800_000_000) * 1e6));
      const { virtualSui, virtualTokens } = curveShapeFor(pkgId);

      const quote  = buyQuote(reserveMist, tokensRemaining, suiInMist, virtualSui, virtualTokens);
      const minOut = quote?.tokensOut != null
        ? BigInt(Math.floor(Number(quote.tokensOut) * (1 - target.slippage / 100)))
        : 0n;

      const client = new SuiGraphQLClient({ url: '/api/rpc' });
      const tx = new Transaction();
      tx.setSender(myAddress);
      const curveRef  = tx.sharedObjectRef({ objectId: curveId, initialSharedVersion: isv, mutable: true });
      const [payment] = tx.splitCoins(tx.gas, [tx.pure.u64(suiInMist)]);

      const buyArgs = isV9OrLater(pkgId)
        ? [curveRef, payment, tx.pure.u64(minOut), tx.pure.option('address', null), tx.object(SUI_CLOCK_ID), tx.pure.u64(0)]
        : isV5OrLater(pkgId)
          ? [curveRef, payment, tx.pure.u64(minOut), tx.pure.option('address', null), tx.object(SUI_CLOCK_ID)]
          : [curveRef, payment, tx.pure.u64(minOut)];

      const [tokens, refund] = tx.moveCall({
        target: `${pkgId}::bonding_curve::buy`,
        typeArguments: [tokenType],
        arguments: buyArgs,
      });
      tx.transferObjects([tokens, refund], myAddress);

      const builtTx          = await tx.build({ client });
      const { signature }    = await kp.signTransaction(builtTx);
      const result           = await client.executeTransaction({
        transaction: builtTx,
        signatures: [signature],
      });

      logEntry = { ...logEntry, success: result?.errors == null, digest: result?.data?.executeTransaction?.digest };
    } catch (err) {
      logEntry = { ...logEntry, success: false, error: err.message };
    }

    const newLog = appendLog(walletAddress, logEntry);
    setConfig(prev => ({ ...prev, log: newLog }));
  }, [walletAddress]);

  // ── Execute a mirrored sell ───────────────────────────────────────────────
  const executeMirrorSell = useCallback(async (target, curveId, tokenType, pkgId, name, symbol) => {
    const kp = keypairRef.current;
    if (!kp || !walletAddress) return;

    const myAddress = kp.getPublicKey().toSuiAddress();
    let logEntry = { targetAddress: target.address, action: 'sell', curveId, name, symbol, suiAmount: 0, success: false };

    try {
      const client = new SuiGraphQLClient({ url: '/api/rpc' });

      // Get our token balance — SuiGraphQLClient 2.x: listCoins, result.objects, c.objectId
      const coinsRes = await client.listCoins({ owner: myAddress, coinType: tokenType });
      const coins    = coinsRes?.objects ?? coinsRes?.data ?? [];
      if (!coins.length) throw new Error('No tokens to sell');

      // Fetch curve data from indexer
      const curveData = await fetchCurveData(curveId);
      if (!curveData) throw new Error('Could not fetch curve from indexer');
      const isv = curveData.initialSharedVersion ?? curveData.initial_shared_version ?? null;
      if (!isv) throw new Error('Could not resolve curve version');

      const reserveMist     = BigInt(Math.round((curveData.stats?.reserve_sui ?? curveData.reserve_sui ?? 0) * 1e9));
      const tokensRemaining = BigInt(Math.round((curveData.stats?.token_reserve ?? curveData.token_reserve ?? 800_000_000) * 1e6));
      const { virtualSui, virtualTokens } = curveShapeFor(pkgId);

      // Sell full balance
      const totalBalance = coins.reduce((sum, c) => sum + BigInt(c.balance ?? c.coinBalance ?? 0), 0n);
      if (totalBalance === 0n) throw new Error('Zero balance');

      const quote  = sellQuote(reserveMist, tokensRemaining, totalBalance, virtualSui, virtualTokens);
      const minOut = quote?.suiOut != null
        ? BigInt(Math.floor(Number(quote.suiOut) * (1 - target.slippage / 100)))
        : 0n;

      const tx = new Transaction();
      tx.setSender(myAddress);
      const curveRef = tx.sharedObjectRef({ objectId: curveId, initialSharedVersion: isv, mutable: true });

      // SuiGraphQLClient 2.x: objectId not coinObjectId
      const coinObjs = coins.map(c => tx.object(c.objectId ?? c.coinObjectId));
      if (coinObjs.length > 1) tx.mergeCoins(coinObjs[0], coinObjs.slice(1));
      const [tokenCoin] = tx.splitCoins(coinObjs[0], [tx.pure.u64(totalBalance)]);

      const sellArgs = isV7OrLater(pkgId)
        ? [curveRef, tokenCoin, tx.pure.u64(minOut), tx.pure.option('address', null)]
        : [curveRef, tokenCoin, tx.pure.u64(minOut)];

      const [suiOut] = tx.moveCall({
        target: `${pkgId}::bonding_curve::sell`,
        typeArguments: [tokenType],
        arguments: sellArgs,
      });
      tx.transferObjects([suiOut], myAddress);

      const builtTx       = await tx.build({ client });
      const { signature } = await kp.signTransaction(builtTx);
      const result        = await client.executeTransaction({
        transaction: builtTx,
        signatures: [signature],
      });

      const suiReceived = Number(quote?.suiOut ?? 0) / 1e9;
      logEntry = { ...logEntry, success: result?.errors == null, digest: result?.data?.executeTransaction?.digest, suiAmount: suiReceived };
    } catch (err) {
      logEntry = { ...logEntry, success: false, error: err.message };
    }

    const newLog = appendLog(walletAddress, logEntry);
    setConfig(prev => ({ ...prev, log: newLog }));
  }, [walletAddress]);

  // ── SSE listener ──────────────────────────────────────────────────────────
  useEffect(() => {
    const enabledTargets = config.targets?.filter(t => t.enabled) ?? [];
    if (!walletAddress || !enabledTargets.length) {
      esRef.current?.close();
      return;
    }

    function connect() {
      const es = new EventSource(`${INDEXER_URL}/stream`);
      esRef.current = es;

      es.onmessage = async (e) => {
        try {
          const event = JSON.parse(e.data);
          const isBuy  = event.type === 'TokensPurchased' || event.type === 'TokensBought';
          const isSell = event.type === 'TokensSold';
          if (!isBuy && !isSell) return;

          const d      = event.data ?? {};
          const trader = d.buyer ?? d.seller ?? '';
          if (!trader) return;

          // Dedupe by tx digest
          const digest = event.txDigest ?? d.tx_digest ?? '';
          if (digest && firingRef.current.has(digest)) return;
          if (digest) firingRef.current.add(digest);
          setTimeout(() => firingRef.current.delete(digest), 30_000);

          // Check watch list
          const cfg     = loadCopyConfig(walletAddress);
          const targets = cfg?.targets?.filter(t => t.enabled) ?? [];
          const target  = targets.find(t => t.address.toLowerCase() === trader.toLowerCase());
          if (!target) return;
          if (!keypairRef.current) return;

          // Don't copy our own trades
          const myAddress = keypairRef.current.getPublicKey().toSuiAddress();
          if (trader.toLowerCase() === myAddress.toLowerCase()) return;

          const curveId = d.curve_id ?? event.curveId;
          if (!curveId) return;

          const pkgId = event.eventType?.split('::')?.[0] ?? '';
          if (!pkgId) return;

          // token_type is NOT in SSE trade events — fetch from indexer
          let tokenType = d.token_type ?? d.type_name ?? null;
          let name      = d.name   ?? '';
          let symbol    = d.symbol ?? '';
          if (!tokenType) {
            const curveData = await fetchCurveData(curveId);
            tokenType = curveData?.token_type ?? curveData?.tokenType ?? null;
            name   = name   || curveData?.name   || '';
            symbol = symbol || curveData?.symbol  || '';
          }
          if (!tokenType) return; // indexer not yet enriched

          if (isBuy) {
            await executeMirrorBuy(target, curveId, tokenType, pkgId, name, symbol);
          } else if (isSell && target.mirrorSells) {
            await executeMirrorSell(target, curveId, tokenType, pkgId, name, symbol);
          }
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
  }, [walletAddress, config.targets, executeMirrorBuy, executeMirrorSell]);

  // ── Public API ────────────────────────────────────────────────────────────

  const addTarget = useCallback((address, label, scaleSui, mirrorSells, slippage) => {
    const updated = loadCopyConfig(walletAddress) ?? { targets: [], log: [] };
    updated.targets = [
      ...(updated.targets ?? []).filter(t => t.address.toLowerCase() !== address.toLowerCase()),
      { address: address.trim(), label: label.trim(), enabled: true, scaleSui, mirrorSells, slippage },
    ];
    saveCopyConfig(walletAddress, updated);
    setConfig(updated);
  }, [walletAddress]);

  const removeTarget = useCallback((address) => {
    const updated = loadCopyConfig(walletAddress) ?? { targets: [], log: [] };
    updated.targets = updated.targets.filter(t => t.address.toLowerCase() !== address.toLowerCase());
    saveCopyConfig(walletAddress, updated);
    setConfig(updated);
  }, [walletAddress]);

  const toggleTarget = useCallback((address) => {
    const updated = loadCopyConfig(walletAddress) ?? { targets: [], log: [] };
    updated.targets = updated.targets.map(t =>
      t.address.toLowerCase() === address.toLowerCase() ? { ...t, enabled: !t.enabled } : t
    );
    saveCopyConfig(walletAddress, updated);
    setConfig(updated);
  }, [walletAddress]);

  const clearLog = useCallback(() => {
    const updated = loadCopyConfig(walletAddress) ?? { targets: [], log: [] };
    updated.log = [];
    saveCopyConfig(walletAddress, updated);
    setConfig(prev => ({ ...prev, log: [] }));
  }, [walletAddress]);

  const activeCount = config.targets?.filter(t => t.enabled).length ?? 0;

  return {
    targets:     config.targets ?? [],
    log:         config.log     ?? [],
    addTarget,
    removeTarget,
    toggleTarget,
    clearLog,
    activeCount,
    isActive:    activeCount > 0 && !!keypair,
  };
}
