// useSniper.js
// Monitors the global SSE stream for CurveCreated events.
// When a new token matches the user's filters, buys instantly using
// the stored trading keypair (no Slush popup).
// After a successful buy, automatically activates TP/SL on the position.
//
// Sniper config stored in localStorage:
// Key: suipump_sniper_${walletAddress}
// Schema: {
//   enabled: boolean,
//   maxSuiPerSnipe: number,       // SUI to spend per snipe
//   maxDevBuyPct: number,         // 0-100, skip if dev bought more than this %
//   minMcapSui: number,           // minimum starting mcap in SUI (0 = no min)
//   maxMcapSui: number,           // maximum starting mcap in SUI (0 = no max)
//   keyword: string,              // name/symbol must contain this (empty = any)
//   excludeKeyword: string,       // name/symbol must NOT contain this
//   gradTarget: string,           // 'any'|'cetus'|'turbos'|'deepbook'
//   slippage: number,             // % slippage tolerance
//   autoTPSL: boolean,            // auto-set TP/SL after snipe
//   tpPct: number,                // take-profit %
//   tpSellPct: number,            // % of position to sell at TP
//   slPct: number,                // stop-loss % (negative)
//   slSellPct: number,            // % of position to sell at SL
// }

import { useState, useEffect, useRef, useCallback } from 'react';
import { SuiGraphQLClient } from '@mysten/sui/graphql';
import { Transaction } from '@mysten/sui/transactions';
import { saveTPSL, makeLevel } from './useTPSL.js';
import {
  PACKAGE_ID_V8, MIST_PER_SUI,
  isV5OrLater, isV7OrLater, curveShapeFor,
} from './constants.js';
import { buyQuote, sellQuote } from './curve.js';

const INDEXER_URL  = import.meta.env.VITE_INDEXER_URL || '';
const SUI_CLOCK_ID = '0x6';
const TOKEN_DECIMALS = 6;

// ── Storage helpers ───────────────────────────────────────────────────────────

const SNIPER_KEY   = (addr) => `suipump_sniper_${addr}`;
const SNIPE_LOG_KEY = (addr) => `suipump_snipelog_${addr}`;

export function loadSniperConfig(walletAddress) {
  if (!walletAddress) return null;
  try {
    const raw = localStorage.getItem(SNIPER_KEY(walletAddress));
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

export function saveSniperConfig(walletAddress, config) {
  if (!walletAddress) return;
  try { localStorage.setItem(SNIPER_KEY(walletAddress), JSON.stringify(config)); } catch {}
}

export function loadSnipeLog(walletAddress) {
  if (!walletAddress) return [];
  try {
    const raw = localStorage.getItem(SNIPE_LOG_KEY(walletAddress));
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

function appendSnipeLog(walletAddress, entry) {
  const log = loadSnipeLog(walletAddress);
  log.unshift({ ...entry, ts: Date.now() });
  const trimmed = log.slice(0, 50); // keep last 50
  try { localStorage.setItem(SNIPE_LOG_KEY(walletAddress), JSON.stringify(trimmed)); } catch {}
  return trimmed;
}

// ── Default config ────────────────────────────────────────────────────────────

export const DEFAULT_SNIPER_CONFIG = {
  enabled:        false,
  maxSuiPerSnipe: 1,
  maxDevBuyPct:   10,
  minMcapSui:     0,
  maxMcapSui:     0,
  keyword:        '',
  excludeKeyword: '',
  gradTarget:     'any',
  slippage:       2,
  autoTPSL:       true,
  tpPct:          200,
  tpSellPct:      50,
  slPct:          -30,
  slSellPct:      100,
  // Graduation snipe
  gradSnipeEnabled:    false,
  gradSnipeThreshold:  80,    // % progress to trigger buy
  gradSnipeSuiAmount:  1,     // SUI to spend
  gradSnipeSellOnGrad: true,  // auto-sell when Graduated event fires
  gradSnipeSlippage:   5,     // higher slippage for fast execution
};

// ── Filter checker ────────────────────────────────────────────────────────────

function passesFilters(event, config) {
  const d = event.data ?? {};

  // Name/symbol keyword filter
  const name   = (d.name   ?? '').toLowerCase();
  const symbol = (d.symbol ?? '').toLowerCase();
  const kw     = config.keyword?.toLowerCase()?.trim();
  const exkw   = config.excludeKeyword?.toLowerCase()?.trim();

  if (kw && !name.includes(kw) && !symbol.includes(kw)) return false;
  if (exkw && (name.includes(exkw) || symbol.includes(exkw))) return false;

  // Graduation target
  if (config.gradTarget && config.gradTarget !== 'any') {
    const dex = (d.dex ?? d.grad_target ?? 'cetus').toLowerCase();
    if (!dex.includes(config.gradTarget)) return false;
  }

  // Dev buy % — d.dev_buy_tokens / 800_000_000 * 100
  if (config.maxDevBuyPct > 0) {
    const devBuyTokens = Number(d.dev_buy_tokens ?? d.tokens_to_dev ?? 0);
    const devBuyPct    = (devBuyTokens / 800_000_000) * 100;
    if (devBuyPct > config.maxDevBuyPct) return false;
  }

  return true;
}

// ── Main hook ─────────────────────────────────────────────────────────────────

export function useSniper({ walletAddress, keypair }) {
  const [config, setConfig]   = useState(() => loadSniperConfig(walletAddress) ?? { ...DEFAULT_SNIPER_CONFIG });
  const [log, setLog]         = useState(() => loadSnipeLog(walletAddress));
  const [sniping, setSniping] = useState(null); // curveId being sniped right now

  const esRef      = useRef(null);
  const timerRef   = useRef(null);
  const sniping_   = useRef(null); // ref for use inside SSE closure
  const keypairRef = useRef(keypair);

  // Keep keypair ref fresh
  useEffect(() => { keypairRef.current = keypair; }, [keypair]);

  // Persist config
  useEffect(() => {
    if (walletAddress) saveSniperConfig(walletAddress, config);
  }, [config, walletAddress]);

  // ── Execute snipe ─────────────────────────────────────────────────────────
  const executeSnipe = useCallback(async (curveId, tokenType, pkgId, curveCreatedData) => {
    const kp = keypairRef.current;
    if (!kp || !walletAddress) return;
    if (sniping_.current === curveId) return; // already sniping this one

    sniping_.current = curveId;
    setSniping(curveId);

    const cfg = loadSniperConfig(walletAddress) ?? config;
    const suiInMist = BigInt(Math.floor(cfg.maxSuiPerSnipe * 1e9));

    try {
      // Create a fresh SuiGraphQLClient for signing (keypair path)
      const client = new SuiGraphQLClient({ url: 'https://graphql.testnet.sui.io/graphql' });

      // Get curve shared object ref
      const objForRef = await client.getObject({ id: curveId, options: { showOwner: true, showContent: true } });
      const isv = objForRef.data?.owner?.Shared?.initial_shared_version;
      if (!isv) throw new Error('Could not resolve curve version');

      const vSui  = curveShapeFor(pkgId).virtualSui;
      const vTok  = curveShapeFor(pkgId).virtualTokens;

      // Get current reserve for quote
      const fields = objForRef.data?.content?.fields ?? {};
      const reserveMist    = BigInt(fields.sui_reserve    ?? 0);
      const tokensRemaining = BigInt(fields.token_reserve ?? 0);

      const quote  = buyQuote(reserveMist, tokensRemaining, suiInMist, vSui, vTok);
      const minOut = quote?.tokensOut != null
        ? BigInt(Math.floor(Number(quote.tokensOut) * (1 - cfg.slippage / 100)))
        : 0n;

      const tx = new Transaction();
      tx.setSender(kp.getPublicKey().toSuiAddress());

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
      tx.transferObjects([tokens, refund], kp.getPublicKey().toSuiAddress());

      // Build + sign + execute
      const builtTx = await tx.build({ client });
      const { signature } = await kp.signTransaction(builtTx);
      const result = await client.executeTransaction({
        transaction: builtTx,
        signature,
      });

      const digest  = result?.data?.executeTransaction?.digest;
      const success = result?.errors == null;

      // Compute entry price
      const entryPriceSui = (Number(reserveMist) / 1e9 + curveShapeFor(pkgId).virtualSui) / 1_000_000_000;

      // Auto TP/SL
      if (success && cfg.autoTPSL) {
        const levels = [];
        if (cfg.tpPct)  levels.push(makeLevel('tp', cfg.tpPct,  cfg.tpSellPct));
        if (cfg.slPct)  levels.push(makeLevel('sl', cfg.slPct,  cfg.slSellPct));
        if (levels.length) {
          saveTPSL(walletAddress, curveId, {
            enabled: true,
            entryPriceSui,
            levels,
            createdAt: Date.now(),
            autoFromSniper: true,
          });
        }
      }

      const entry = {
        curveId,
        name:    curveCreatedData?.name   ?? '???',
        symbol:  curveCreatedData?.symbol ?? '???',
        suiSpent: cfg.maxSuiPerSnipe,
        digest,
        success,
        autoTPSL: cfg.autoTPSL && success,
        entryPriceSui,
      };

      const newLog = appendSnipeLog(walletAddress, entry);
      setLog(newLog);

    } catch (err) {
      const entry = {
        curveId,
        name:    curveCreatedData?.name   ?? '???',
        symbol:  curveCreatedData?.symbol ?? '???',
        suiSpent: cfg.maxSuiPerSnipe,
        success: false,
        error:   err.message,
      };
      const newLog = appendSnipeLog(walletAddress, entry);
      setLog(newLog);
    } finally {
      sniping_.current = null;
      setSniping(null);
    }
  }, [walletAddress, config]);

  // ── SSE listener ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (!walletAddress || !config.enabled) {
      esRef.current?.close();
      return;
    }

    function connect() {
      // Global stream — no curveId filter, we want ALL new tokens
      const es = new EventSource(`${INDEXER_URL}/stream`);
      esRef.current = es;

      es.onmessage = async (e) => {
        try {
          const event = JSON.parse(e.data);
          if (event.type !== 'CurveCreated') return;

          const cfg = loadSniperConfig(walletAddress);
          if (!cfg?.enabled) return;
          if (!keypairRef.current) return;

          const d       = event.data ?? {};
          const curveId = d.curve_id ?? event.curveId;
          if (!curveId) return;
          if (sniping_.current) return; // busy

          if (!passesFilters(event, cfg)) return;

          // Get token type from curve object
          // tokenType is the full generic type e.g. 0xPKG::module::TOKEN
          const tokenType = d.token_type ?? d.type_name ?? null;
          if (!tokenType) return;

          // Determine package from event type
          const pkgId = event.eventType?.split('::')?.[0] ?? PACKAGE_ID_V8;

          await executeSnipe(curveId, tokenType, pkgId, d);
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
  }, [walletAddress, config.enabled, executeSnipe]);

  // ── Graduation snipe ──────────────────────────────────────────────────────
  // Phase 1: watch trades → buy when curve hits threshold %.
  // Phase 2: watch Graduated events → sell if we hold tokens.

  const gradBought   = useRef(new Set());
  const gradEsRef    = useRef(null);
  const gradTimerRef = useRef(null);

  const executeGradSell = useCallback(async (curveId, tokenType, pkgId) => {
    const kp = keypairRef.current;
    if (!kp || !walletAddress) return;
    try {
      const client    = new SuiGraphQLClient({ url: 'https://graphql.testnet.sui.io/graphql' });
      const myAddress = kp.getPublicKey().toSuiAddress();
      const coins     = await client.getCoins({ owner: myAddress, coinType: tokenType });
      if (!coins.data.length) return;
      const cfg         = loadSniperConfig(walletAddress) ?? config;
      const totalAtomic = coins.data.reduce((s, c) => s + BigInt(c.balance), 0n);
      const objForRef   = await client.getObject({ id: curveId, options: { showOwner: true, showContent: true } });
      const isv         = objForRef.data?.owner?.Shared?.initial_shared_version;
      if (!isv) return;
      const fields          = objForRef.data?.content?.fields ?? {};
      const reserveMist     = BigInt(fields.sui_reserve    ?? 0);
      const tokensRemaining = BigInt(fields.token_reserve  ?? 0);
      const { virtualSui, virtualTokens } = curveShapeFor(pkgId);
      const sq      = sellQuote(reserveMist, tokensRemaining, totalAtomic, virtualSui, virtualTokens);
      const minOut  = sq?.suiOut != null ? BigInt(Math.floor(Number(sq.suiOut) * (1 - cfg.gradSnipeSlippage / 100))) : 0n;
      const tx      = new Transaction();
      tx.setSender(myAddress);
      const curveRef = tx.sharedObjectRef({ objectId: curveId, initialSharedVersion: isv, mutable: true });
      const coinObjs = coins.data.map(c => tx.object(c.coinObjectId));
      if (coinObjs.length > 1) tx.mergeCoins(coinObjs[0], coinObjs.slice(1));
      const [tokenCoin] = tx.splitCoins(coinObjs[0], [tx.pure.u64(totalAtomic)]);
      const sellArgs = isV7OrLater(pkgId)
        ? [curveRef, tokenCoin, tx.pure.u64(minOut), tx.pure.option('address', null)]
        : [curveRef, tokenCoin, tx.pure.u64(minOut)];
      const [suiOut] = tx.moveCall({ target: `${pkgId}::bonding_curve::sell`, typeArguments: [tokenType], arguments: sellArgs });
      tx.transferObjects([suiOut], myAddress);
      const builtTx       = await tx.build({ client });
      const { signature } = await kp.signTransaction(builtTx);
      await client.executeTransaction({ transaction: builtTx, signature });
      gradBought.current.delete(curveId);
      const newLog = appendSnipeLog(walletAddress, { curveId, name: '?', symbol: '?', suiSpent: 0, success: true, type: 'grad_sell' });
      setLog(newLog);
    } catch {}
  }, [walletAddress, config]);

  useEffect(() => {
    const cfg = loadSniperConfig(walletAddress) ?? config;
    if (!walletAddress || !cfg?.gradSnipeEnabled) { gradEsRef.current?.close(); return; }

    function connectGrad() {
      const es = new EventSource(`${INDEXER_URL}/stream`);
      gradEsRef.current = es;
      es.onmessage = async (e) => {
        try {
          const event = JSON.parse(e.data);
          const cfg2  = loadSniperConfig(walletAddress);
          if (!cfg2?.gradSnipeEnabled || !keypairRef.current) return;
          const d     = event.data ?? {};
          const pkgId = event.eventType?.split('::')?.[0] ?? PACKAGE_ID_V8;

          // Phase 2 — sell on graduation
          if (event.type === 'CurveGraduated' || event.type === 'Graduated') {
            const curveId   = d.curve_id ?? event.curveId;
            const tokenType = d.token_type ?? d.type_name ?? null;
            if (!curveId || !tokenType || !gradBought.current.has(curveId) || !cfg2.gradSnipeSellOnGrad) return;
            await executeGradSell(curveId, tokenType, pkgId);
            return;
          }

          // Phase 1 — buy near graduation threshold
          const isTrade = event.type === 'TokensPurchased' || event.type === 'TokensBought' || event.type === 'TokensSold';
          if (!isTrade) return;
          const curveId   = d.curve_id ?? event.curveId;
          const tokenType = d.token_type ?? d.type_name ?? null;
          if (!curveId || !tokenType || gradBought.current.has(curveId)) return;
          const reserveSui = Number(d.new_sui_reserve ?? d.sui_reserve ?? 0) / 1e9;
          const { drainSui, virtualSui, virtualTokens } = curveShapeFor(pkgId);
          if ((reserveSui / drainSui) * 100 < cfg2.gradSnipeThreshold) return;
          gradBought.current.add(curveId);
          const kp        = keypairRef.current;
          const client    = new SuiGraphQLClient({ url: 'https://graphql.testnet.sui.io/graphql' });
          const myAddress = kp.getPublicKey().toSuiAddress();
          const suiInMist = BigInt(Math.floor(cfg2.gradSnipeSuiAmount * 1e9));
          const objForRef = await client.getObject({ id: curveId, options: { showOwner: true, showContent: true } });
          const isv       = objForRef.data?.owner?.Shared?.initial_shared_version;
          if (!isv) { gradBought.current.delete(curveId); return; }
          const fields          = objForRef.data?.content?.fields ?? {};
          const reserveMist     = BigInt(fields.sui_reserve    ?? 0);
          const tokensRemaining = BigInt(fields.token_reserve  ?? 0);
          const quote  = buyQuote(reserveMist, tokensRemaining, suiInMist, virtualSui, virtualTokens);
          const minOut = quote?.tokensOut != null ? BigInt(Math.floor(Number(quote.tokensOut) * (1 - cfg2.gradSnipeSlippage / 100))) : 0n;
          const tx = new Transaction();
          tx.setSender(myAddress);
          const curveRef  = tx.sharedObjectRef({ objectId: curveId, initialSharedVersion: isv, mutable: true });
          const [payment] = tx.splitCoins(tx.gas, [tx.pure.u64(suiInMist)]);
          const buyArgs   = isV5OrLater(pkgId)
            ? [curveRef, payment, tx.pure.u64(minOut), tx.pure.option('address', null), tx.object(SUI_CLOCK_ID)]
            : [curveRef, payment, tx.pure.u64(minOut)];
          const [tokens, refund] = tx.moveCall({ target: `${pkgId}::bonding_curve::buy`, typeArguments: [tokenType], arguments: buyArgs });
          tx.transferObjects([tokens, refund], myAddress);
          const builtTx       = await tx.build({ client });
          const { signature } = await kp.signTransaction(builtTx);
          const result        = await client.executeTransaction({ transaction: builtTx, signature });
          const success = result?.errors == null;
          if (!success) gradBought.current.delete(curveId);
          const newLog = appendSnipeLog(walletAddress, { curveId, name: d.name ?? '?', symbol: d.symbol ?? '?', suiSpent: cfg2.gradSnipeSuiAmount, success, type: 'grad_buy', digest: result?.data?.executeTransaction?.digest });
          setLog(newLog);
        } catch {}
      };
      es.onerror = () => { es.close(); gradTimerRef.current = setTimeout(connectGrad, 3000); };
    }

    connectGrad();
    return () => { gradEsRef.current?.close(); clearTimeout(gradTimerRef.current); };
  }, [walletAddress, config.gradSnipeEnabled, executeGradSell]);

  // ── Public API ────────────────────────────────────────────────────────────

  const updateConfig = useCallback((patch) => {
    setConfig(prev => ({ ...prev, ...patch }));
  }, []);

  const enable  = useCallback(() => updateConfig({ enabled: true }),  [updateConfig]);
  const disable = useCallback(() => updateConfig({ enabled: false }), [updateConfig]);
  const clearLog = useCallback(() => {
    try { localStorage.removeItem(SNIPE_LOG_KEY(walletAddress)); } catch {}
    setLog([]);
  }, [walletAddress]);

  return {
    config,
    updateConfig,
    enable,
    disable,
    log,
    clearLog,
    sniping,   // curveId currently being sniped, or null
    isActive: config.enabled && !!keypair,
  };
}