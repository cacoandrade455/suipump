// useCopyTrade.js
// Monitors the global SSE stream for trades from watched wallets.
// When a watched wallet buys or sells, mirrors the trade proportionally
// using the trading keypair (no Slush popup).
//
// Storage key: suipump_copytrade_${walletAddress}
// Schema: {
//   targets: [{
//     address: string,       // wallet to copy
//     label: string,         // optional nickname
//     enabled: boolean,
//     scaleSui: number,      // fixed SUI to spend per copied buy (not proportional)
//     mirrorSells: boolean,  // also mirror sells
//     slippage: number,
//   }],
//   log: [{ ts, targetAddress, action, curveId, name, symbol, suiAmount, success, digest?, error? }]
// }

import { useState, useEffect, useRef, useCallback } from 'react';
import { SuiGraphQLClient } from '@mysten/sui/graphql';
import { Transaction } from '@mysten/sui/transactions';
import { curveShapeFor, isV5OrLater, isV7OrLater } from './constants.js';
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

// ── Main hook ─────────────────────────────────────────────────────────────────

export function useCopyTrade({ walletAddress, keypair }) {
  const [config, setConfig]   = useState(() => loadCopyConfig(walletAddress) ?? { targets: [], log: [] });
  const keypairRef             = useRef(keypair);
  const esRef                  = useRef(null);
  const timerRef               = useRef(null);
  const firingRef              = useRef(new Set()); // tx digests being mirrored

  useEffect(() => { keypairRef.current = keypair; }, [keypair]);

  // Reload config from storage on mount
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
      const client = new SuiGraphQLClient({ url: 'https://graphql.testnet.sui.io/graphql' });
      const objForRef = await client.getObject({ id: curveId, options: { showOwner: true, showContent: true } });
      const isv = objForRef.data?.owner?.Shared?.initial_shared_version;
      if (!isv) throw new Error('Could not resolve curve version');

      const fields          = objForRef.data?.content?.fields ?? {};
      const reserveMist     = BigInt(fields.sui_reserve    ?? 0);
      const tokensRemaining = BigInt(fields.token_reserve  ?? 0);
      const { virtualSui, virtualTokens } = curveShapeFor(pkgId);

      const quote  = buyQuote(reserveMist, tokensRemaining, suiInMist, virtualSui, virtualTokens);
      const minOut = quote?.tokensOut != null
        ? BigInt(Math.floor(Number(quote.tokensOut) * (1 - target.slippage / 100)))
        : 0n;

      const tx = new Transaction();
      tx.setSender(myAddress);
      const curveRef  = tx.sharedObjectRef({ objectId: curveId, initialSharedVersion: isv, mutable: true });
      const [payment] = tx.splitCoins(tx.gas, [tx.pure.u64(suiInMist)]);

      const buyArgs = isV5OrLater(pkgId)
        ? [curveRef, payment, tx.pure.u64(minOut), tx.pure.option('address', null), tx.object(SUI_CLOCK_ID)]
        : [curveRef, payment, tx.pure.u64(minOut)];

      const [tokens, refund] = tx.moveCall({
        target: `${pkgId}::bonding_curve::buy`,
        typeArguments: [tokenType],
        arguments: buyArgs,
      });
      tx.transferObjects([tokens, refund], myAddress);

      const builtTx       = await tx.build({ client });
      const { signature } = await kp.signTransaction(builtTx);
      const result        = await client.executeTransaction({
        transaction: builtTx,
        signature,
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
      const client = new SuiGraphQLClient({ url: 'https://graphql.testnet.sui.io/graphql' });

      // Get our token balance
      const coins = await client.getCoins({ owner: myAddress, coinType: tokenType });
      if (!coins.data.length) throw new Error('No tokens to sell');

      const objForRef = await client.getObject({ id: curveId, options: { showOwner: true, showContent: true } });
      const isv = objForRef.data?.owner?.Shared?.initial_shared_version;
      if (!isv) throw new Error('Could not resolve curve version');

      const fields          = objForRef.data?.content?.fields ?? {};
      const reserveMist     = BigInt(fields.sui_reserve    ?? 0);
      const tokensRemaining = BigInt(fields.token_reserve  ?? 0);
      const { virtualSui, virtualTokens } = curveShapeFor(pkgId);

      // Sell full balance
      const totalBalance = coins.data.reduce((sum, c) => sum + BigInt(c.balance), 0n);
      const quote  = sellQuote(reserveMist, tokensRemaining, totalBalance, virtualSui, virtualTokens);
      const minOut = quote?.suiOut != null
        ? BigInt(Math.floor(Number(quote.suiOut) * (1 - target.slippage / 100)))
        : 0n;

      const tx = new Transaction();
      tx.setSender(myAddress);
      const curveRef = tx.sharedObjectRef({ objectId: curveId, initialSharedVersion: isv, mutable: true });

      const coinObjs = coins.data.map(c => tx.object(c.coinObjectId));
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
        signature,
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

          // Check if this trader is in our watch list
          const cfg     = loadCopyConfig(walletAddress);
          const targets = cfg?.targets?.filter(t => t.enabled) ?? [];
          const target  = targets.find(t => t.address.toLowerCase() === trader.toLowerCase());
          if (!target) return;
          if (!keypairRef.current) return;

          // Don't copy our own trades
          const myAddress = keypairRef.current.getPublicKey().toSuiAddress();
          if (trader.toLowerCase() === myAddress.toLowerCase()) return;

          const curveId   = d.curve_id ?? event.curveId;
          const tokenType = d.token_type ?? d.type_name ?? null;
          const pkgId     = event.eventType?.split('::')?.[0] ?? '';
          const name      = d.name   ?? '';
          const symbol    = d.symbol ?? '';

          if (!curveId || !tokenType || !pkgId) return;

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
    const updated = {
      ...loadCopyConfig(walletAddress),
    };
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
    setConfig(updated);
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
