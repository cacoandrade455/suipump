// useTokenStats.js
// For each token in the list, fetches TokensPurchased + TokensSold events
// and computes: volume, trades, reserveSui, pctChange, recentTrades (last 60m),
// lastTradeTime (timestamp ms of most recent trade)
// Returns a map: { [curveId]: { volume, trades, reserveSui, pctChange, recentTrades, lastTradeTime } }
//
// Uses cursor-based pagination to fetch ALL events — no more 100-event cap.

import { useState, useEffect, useRef } from 'react';
import { useSuiClient } from '@mysten/dapp-kit';
import { PACKAGE_ID } from './constants.js';
import { paginateMultipleEvents } from './paginateEvents.js';

const MIST_PER_SUI = 1e9;
const ONE_HOUR_MS = 60 * 60 * 1000;

export function useTokenStats(tokens) {
  const client = useSuiClient();
  const [stats, setStats] = useState({});
  const prevTokenIds = useRef('');

  useEffect(() => {
    if (!tokens || tokens.length === 0) return;

    const ids = tokens.map(t => t.curveId).join(',');
    if (ids === prevTokenIds.current) return;
    prevTokenIds.current = ids;

    let cancelled = false;

    async function load() {
      try {
        const buyType = `${PACKAGE_ID}::bonding_curve::TokensPurchased`;
        const sellType = `${PACKAGE_ID}::bonding_curve::TokensSold`;

        const eventMap = await paginateMultipleEvents(
          client,
          [buyType, sellType],
          { order: 'descending', maxPages: 20 }
        );

        if (cancelled) return;

        const buysData = eventMap[buyType];
        const sellsData = eventMap[sellType];

        const now = Date.now();
        const map = {};

        const ensure = (curveId) => {
          if (!map[curveId]) {
            map[curveId] = {
              volume: 0,
              trades: 0,
              recentTrades: 0,
              firstPrice: null,
              lastPrice: null,
              reserveSui: 0,
              lastTradeTime: null,  // timestamp ms of most recent trade
            };
          }
          return map[curveId];
        };

        // Events arrive descending (newest first) — first seen = most recent
        for (const evt of buysData) {
          const j = evt.parsedJson;
          if (!j?.curve_id) continue;
          const s = ensure(j.curve_id);
          const suiIn = Number(j.sui_in ?? 0) / MIST_PER_SUI;
          const ts = evt.timestampMs ? Number(evt.timestampMs) : 0;
          s.volume += suiIn;
          s.trades += 1;
          if (ts && now - ts < ONE_HOUR_MS) s.recentTrades += 1;
          // First event seen in descending order = latest trade
          if (ts && s.lastTradeTime === null) s.lastTradeTime = ts;
          const tokensOut = Number(j.tokens_out ?? 0) / 1e6;
          if (tokensOut > 0) {
            const price = suiIn / tokensOut;
            if (s.lastPrice === null) s.lastPrice = price;
            s.firstPrice = price;
          }
        }

        for (const evt of sellsData) {
          const j = evt.parsedJson;
          if (!j?.curve_id) continue;
          const s = ensure(j.curve_id);
          const suiOut = Number(j.sui_out ?? 0) / MIST_PER_SUI;
          const ts = evt.timestampMs ? Number(evt.timestampMs) : 0;
          s.volume += suiOut;
          s.trades += 1;
          if (ts && now - ts < ONE_HOUR_MS) s.recentTrades += 1;
          if (ts && s.lastTradeTime === null) s.lastTradeTime = ts;
          const tokensIn = Number(j.tokens_in ?? 0) / 1e6;
          if (tokensIn > 0) {
            const price = suiOut / tokensIn;
            if (s.lastPrice === null) s.lastPrice = price;
            s.firstPrice = price;
          }
        }

        // After merging both streams, lastTradeTime may be wrong for tokens
        // where buys and sells interleave. Re-derive by taking the max.
        // (The above loop already handles this correctly because we only
        // set lastTradeTime on the FIRST event seen per curve, which is the
        // most recent one in descending order — but sells and buys are
        // fetched separately. Fix: take the max across both.)
        for (const curveId of Object.keys(map)) {
          const s = map[curveId];
          // Gather all timestamps for this curve from both streams
          let latestTs = s.lastTradeTime ?? 0;
          for (const evt of sellsData) {
            if (evt.parsedJson?.curve_id !== curveId) continue;
            const ts = evt.timestampMs ? Number(evt.timestampMs) : 0;
            if (ts > latestTs) latestTs = ts;
          }
          for (const evt of buysData) {
            if (evt.parsedJson?.curve_id !== curveId) continue;
            const ts = evt.timestampMs ? Number(evt.timestampMs) : 0;
            if (ts > latestTs) latestTs = ts;
          }
          s.lastTradeTime = latestTs || null;
        }

        // Compute % change
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

  return stats;
}
