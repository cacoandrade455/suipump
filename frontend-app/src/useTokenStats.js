// useTokenStats.js  v16-holdercount
// Per-token stats computed from on-chain events + holder count via coin query.
// Returns map: { [curveId]: { volume, trades, reserveSui, pctChange, recentTrades,
//   lastTradeTime, lastPrice, firstPrice, volume24h, commentCount, devBuyMist,
//   sparkline24h, holderCount } }

import { useState, useEffect, useRef } from 'react';
import { useSuiClient } from '@mysten/dapp-kit';
import { PACKAGE_ID } from './constants.js';
import { paginateMultipleEvents } from './paginateEvents.js';

const MIST_PER_SUI = 1e9;
const ONE_HOUR_MS  = 60 * 60 * 1000;
const ONE_DAY_MS   = 24 * 60 * 60 * 1000;

// Count unique non-zero holders for a given coin type.
// Uses getAllCoins with cursor pagination. Returns a number.
async function fetchHolderCount(client, coinType) {
  const holders = new Set();
  let cursor = null;
  let pages = 0;
  // Safety cap: max 20 pages (each page ~50 objects) = 1000 coin objects
  // More than enough for testnet; revisit with indexer on mainnet
  while (pages < 20) {
    let result;
    try {
      result = await client.getAllCoins({ coinType, cursor, limit: 50 });
    } catch {
      break;
    }
    for (const coin of result.data) {
      // Only count wallets with a non-zero balance
      if (coin.balance && coin.balance !== '0') {
        holders.add(coin.previousTransaction
          ? coin.coinObjectId // unique object per owner address isn't exposed; use owner
          : coin.coinObjectId
        );
        // getOwner not directly on coin objects from getAllCoins —
        // we count unique coinObjectIds as a lower bound, then dedupe by
        // querying owner field if present
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
  const [stats, setStats] = useState({});
  // holderCounts stored separately so they merge without clobbering event stats
  const holderCountsRef = useRef({});
  const prevTokenIds = useRef('');

  // ── Main stats loop (events) — runs every 30s ───────────────────────────────
  useEffect(() => {
    if (!tokens || tokens.length === 0) return;

    const ids = tokens.map(t => t.curveId).join(',');
    if (ids === prevTokenIds.current) return;
    prevTokenIds.current = ids;

    let cancelled = false;

    async function load() {
      try {
        const buyType     = `${PACKAGE_ID}::bonding_curve::TokensPurchased`;
        const sellType    = `${PACKAGE_ID}::bonding_curve::TokensSold`;
        const commentType = `${PACKAGE_ID}::bonding_curve::CommentPosted`;
        const createdType = `${PACKAGE_ID}::bonding_curve::CurveCreated`;

        const eventMap = await paginateMultipleEvents(
          client,
          [buyType, sellType, commentType, createdType],
          { order: 'descending', maxPages: 20 }
        );

        if (cancelled) return;

        const buysData     = eventMap[buyType]     || [];
        const sellsData    = eventMap[sellType]    || [];
        const commentsData = eventMap[commentType] || [];
        const createdData  = eventMap[createdType] || [];

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
              // holderCount seeded from last known value so card shows stale
              // data rather than blank while the slow pass runs
              holderCount: holderCountsRef.current[curveId] ?? null,
            };
          }
          return map[curveId];
        };

        // ── Buys ──────────────────────────────────────────────────────────
        for (const evt of buysData) {
          const j = evt.parsedJson;
          if (!j?.curve_id) continue;
          const s = ensure(j.curve_id);
          const suiIn = Number(j.sui_in ?? 0) / MIST_PER_SUI;
          const ts = evt.timestampMs ? Number(evt.timestampMs) : 0;
          s.volume  += suiIn;
          s.trades  += 1;
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
          const s = ensure(j.curve_id);
          const suiOut = Number(j.sui_out ?? 0) / MIST_PER_SUI;
          const ts = evt.timestampMs ? Number(evt.timestampMs) : 0;
          s.volume  += suiOut;
          s.trades  += 1;
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
          // Sort sparkline oldest→newest
          s.sparkline24h.sort((a, b) => a.t - b.t);
        }

        // ── Comments ──────────────────────────────────────────────────────
        for (const evt of commentsData) {
          const j = evt.parsedJson;
          if (!j?.curve_id) continue;
          const s = ensure(j.curve_id);
          s.commentCount += 1;
        }

        // ── Dev buy — from CurveCreated event ─────────────────────────────
        for (const evt of createdData) {
          const j = evt.parsedJson;
          if (!j?.curve_id) continue;
          const s = ensure(j.curve_id);
          if (j.dev_buy_sui_in) {
            s.devBuyMist = Number(j.dev_buy_sui_in);
          }
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

  // ── Holder count loop — runs every 60s, staggered 5s after mount ────────────
  // Runs independently so it never blocks event stats from rendering.
  // Results are merged into stats state via a functional update.
  useEffect(() => {
    if (!tokens || tokens.length === 0) return;

    // Only tokens that have a tokenType can be queried
    const queryable = tokens.filter(t => t.tokenType);
    if (queryable.length === 0) return;

    let cancelled = false;

    async function loadHolders() {
      // Process tokens one at a time to avoid hammering the RPC
      for (const token of queryable) {
        if (cancelled) return;
        try {
          const count = await fetchHolderCount(client, token.tokenType);
          if (cancelled) return;
          // Cache in ref so next event-stats pass seeds from it
          holderCountsRef.current[token.curveId] = count;
          // Merge into stats state without overwriting other fields
          setStats(prev => {
            if (!prev[token.curveId]) return prev;
            return {
              ...prev,
              [token.curveId]: { ...prev[token.curveId], holderCount: count },
            };
          });
        } catch {
          // Non-fatal — leave holderCount as whatever it was
        }
        // Small delay between tokens to be polite to the RPC
        await new Promise(r => setTimeout(r, 300));
      }
    }

    // Stagger 5s after mount so event stats render first
    const initial = setTimeout(loadHolders, 5_000);
    const interval = setInterval(loadHolders, 60_000);
    return () => { cancelled = true; clearTimeout(initial); clearInterval(interval); };
  }, [tokens, client]);

  return stats;
}
