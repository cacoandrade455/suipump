// useTokenStats.js  v17-dual-package
// Per-token stats computed from on-chain events + holder count via coin query.
// Queries events from ALL package IDs (v4 + v5) via paginateMultipleEvents.
// Returns map: { [curveId]: { volume, trades, reserveSui, pctChange, recentTrades,
//   lastTradeTime, lastPrice, firstPrice, volume24h, commentCount, devBuyMist,
//   sparkline24h, holderCount } }

import { useState, useEffect, useRef } from 'react';
import { useSuiClient } from '@mysten/dapp-kit';
import { ALL_PACKAGE_IDS } from './constants.js';
import { paginateMultipleEvents } from './paginateEvents.js';

const INDEXER_URL = import.meta.env.VITE_INDEXER_URL || '';

const MIST_PER_SUI = 1e9;
const ONE_HOUR_MS  = 60 * 60 * 1000;
const ONE_DAY_MS   = 24 * 60 * 60 * 1000;

// Count unique non-zero holders for a given coin type.
async function fetchHolderCount(client, coinType) {
  const holders = new Set();
  let cursor = null;
  let pages  = 0;
  while (pages < 20) {
    let result;
    try {
      result = await client.getAllCoins({ coinType, cursor, limit: 50 });
    } catch {
      break;
    }
    for (const coin of result.data) {
      if (coin.balance && coin.balance !== '0') {
        holders.add(coin.coinObjectId);
        if (coin.owner) {
          const ownerAddr =
            typeof coin.owner === 'string'
              ? coin.owner
              : coin.owner?.AddressOwner ?? coin.owner?.ObjectOwner ?? null;
          if (ownerAddr) holders.add(ownerAddr);
        }
      }
    }
    if (!result.hasNextPage) break;
    cursor = result.nextCursor;
    pages++;
  }
  return holders.size;
}

export function useTokenStats(tokens) {
  const client = useSuiClient();
  const [stats, setStats]         = useState({});
  const holderCountsRef           = useRef({});
  const prevTokenIds              = useRef('');

  // ── Main stats loop — runs every 30s ────────────────────────────────────────
  useEffect(() => {
    if (!tokens || tokens.length === 0) return;

    const ids = tokens.map(t => t.curveId).join(',');
    if (ids === prevTokenIds.current) return;
    prevTokenIds.current = ids;

    let cancelled = false;

    async function load() {
      // Try indexer first — single call covers all packages
      if (INDEXER_URL) {
        try {
          const res = await fetch(
            `${INDEXER_URL}/tokens/stats`,
            { signal: AbortSignal.timeout(5000) }
          );
          if (res.ok) {
            const indexerStats = await res.json();
            if (!cancelled) {
              const map = {};
              for (const s of indexerStats) {
                map[s.curve_id] = {
                  volume:        s.volume_sui,
                  trades:        s.trades,
                  buys:          s.buys,
                  sells:         s.sells,
                  recentTrades:  s.recent_trades,
                  lastTradeTime: s.last_trade_time,
                  lastPrice:     s.last_price,
                  firstPrice:    s.first_price,
                  volume24h:     s.volume_24h,
                  commentCount:  s.comment_count,
                  pctChange:     s.first_price && s.last_price && s.first_price > 0
                    ? ((s.last_price - s.first_price) / s.first_price) * 100
                    : null,
                  sparkline24h:  s.sparkline24h || [],
                  holderCount:   holderCountsRef.current[s.curve_id] ?? null,
                  devBuyMist:    0,
                  reserveSui:    0,
                };
              }
              setStats(map);
            }
            return;
          }
        } catch {}
      }

      // Fall back to RPC — query all event types across ALL package IDs
      try {
        // Build event type list for every package version
        const eventTypes = ALL_PACKAGE_IDS.flatMap(pkgId => [
          `${pkgId}::bonding_curve::TokensPurchased`,
          `${pkgId}::bonding_curve::TokensSold`,
          `${pkgId}::bonding_curve::CommentPosted`,
          `${pkgId}::bonding_curve::CurveCreated`,
        ]);

        const eventMap = await paginateMultipleEvents(
          client,
          eventTypes,
          { order: 'descending', maxPages: 100, pageSize: 100 }
        );

        if (cancelled) return;

        // Merge events across all package versions by type suffix
        const buysData     = ALL_PACKAGE_IDS.flatMap(p => eventMap[`${p}::bonding_curve::TokensPurchased`]  || []);
        const sellsData    = ALL_PACKAGE_IDS.flatMap(p => eventMap[`${p}::bonding_curve::TokensSold`]       || []);
        const commentsData = ALL_PACKAGE_IDS.flatMap(p => eventMap[`${p}::bonding_curve::CommentPosted`]    || []);
        const createdData  = ALL_PACKAGE_IDS.flatMap(p => eventMap[`${p}::bonding_curve::CurveCreated`]     || []);

        const now = Date.now();
        const map = {};

        const ensure = (curveId) => {
          if (!map[curveId]) {
            map[curveId] = {
              volume: 0, trades: 0, recentTrades: 0,
              firstPrice: null, lastPrice: null, reserveSui: 0,
              lastTradeTime: null,
              volume24h: 0,
              commentCount: 0,
              devBuyMist: 0,
              sparkline24h: [],
              holderCount: holderCountsRef.current[curveId] ?? null,
            };
          }
          return map[curveId];
        };

        // ── Buys ──────────────────────────────────────────────────────────
        for (const evt of buysData) {
          const j = evt.parsedJson;
          if (!j?.curve_id) continue;
          const s      = ensure(j.curve_id);
          const suiIn  = Number(j.sui_in ?? 0) / MIST_PER_SUI;
          const ts     = evt.timestampMs ? Number(evt.timestampMs) : 0;
          s.volume    += suiIn;
          s.trades    += 1;
          if (ts && now - ts < ONE_HOUR_MS) s.recentTrades += 1;
          if (ts && now - ts < ONE_DAY_MS)  s.volume24h    += suiIn;
          if (ts && s.lastTradeTime === null) s.lastTradeTime = ts;
          const tokensOut = Number(j.tokens_out ?? 0) / 1e6;
          if (tokensOut > 0) {
            const price = suiIn / tokensOut;
            if (s.lastPrice === null) s.lastPrice = price;
            s.firstPrice = price;
            if (ts && now - ts < ONE_DAY_MS) {
              s.sparkline24h.push({ t: ts, p: price });
            }
          }
        }

        // ── Sells ─────────────────────────────────────────────────────────
        for (const evt of sellsData) {
          const j = evt.parsedJson;
          if (!j?.curve_id) continue;
          const s       = ensure(j.curve_id);
          const suiOut  = Number(j.sui_out ?? 0) / MIST_PER_SUI;
          const ts      = evt.timestampMs ? Number(evt.timestampMs) : 0;
          s.volume     += suiOut;
          s.trades     += 1;
          if (ts && now - ts < ONE_HOUR_MS) s.recentTrades += 1;
          if (ts && now - ts < ONE_DAY_MS)  s.volume24h    += suiOut;
          if (ts && s.lastTradeTime === null) s.lastTradeTime = ts;
          const tokensIn = Number(j.tokens_in ?? 0) / 1e6;
          if (tokensIn > 0) {
            const price = suiOut / tokensIn;
            if (s.lastPrice === null) s.lastPrice = price;
            s.firstPrice = price;
            if (ts && now - ts < ONE_DAY_MS) {
              s.sparkline24h.push({ t: ts, p: price });
            }
          }
        }

        // Fix lastTradeTime — take max across both streams per curve
        for (const curveId of Object.keys(map)) {
          const s = map[curveId];
          let latestTs = s.lastTradeTime ?? 0;
          for (const evt of [...buysData, ...sellsData]) {
            if (evt.parsedJson?.curve_id !== curveId) continue;
            const ts = evt.timestampMs ? Number(evt.timestampMs) : 0;
            if (ts > latestTs) latestTs = ts;
          }
          s.lastTradeTime = latestTs || null;
          s.sparkline24h.sort((a, b) => a.t - b.t);
        }

        // ── Comments ──────────────────────────────────────────────────────
        for (const evt of commentsData) {
          const j = evt.parsedJson;
          if (!j?.curve_id) continue;
          ensure(j.curve_id).commentCount += 1;
        }

        // ── Dev buy ───────────────────────────────────────────────────────
        for (const evt of createdData) {
          const j = evt.parsedJson;
          if (!j?.curve_id) continue;
          const s = ensure(j.curve_id);
          if (j.dev_buy_sui_in) s.devBuyMist = Number(j.dev_buy_sui_in);
        }

        // ── % change ──────────────────────────────────────────────────────
        for (const s of Object.values(map)) {
          if (s.firstPrice && s.lastPrice && s.firstPrice > 0) {
            s.pctChange = ((s.lastPrice - s.firstPrice) / s.firstPrice) * 100;
          } else {
            s.pctChange = null;
          }
        }

        if (!cancelled) setStats(map);
      } catch (err) {
        console.error('useTokenStats error:', err);
      }
    }

    load();
    const interval = setInterval(load, 30_000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [tokens, client]);

  // ── Holder count loop — runs every 60s ──────────────────────────────────────
  useEffect(() => {
    if (!tokens || tokens.length === 0) return;
    const queryable = tokens.filter(t => t.tokenType);
    if (queryable.length === 0) return;

    let cancelled = false;

    async function loadHolders() {
      for (const token of queryable) {
        if (cancelled) return;
        try {
          const count = await fetchHolderCount(client, token.tokenType);
          if (cancelled) return;
          holderCountsRef.current[token.curveId] = count;
          setStats(prev => {
            if (!prev[token.curveId]) return prev;
            return {
              ...prev,
              [token.curveId]: { ...prev[token.curveId], holderCount: count },
            };
          });
        } catch {
          // Non-fatal
        }
        await new Promise(r => setTimeout(r, 300));
      }
    }

    const initial  = setTimeout(loadHolders, 5_000);
    const interval = setInterval(loadHolders, 60_000);
    return () => { cancelled = true; clearTimeout(initial); clearInterval(interval); };
  }, [tokens, client]);

  return stats;
}
