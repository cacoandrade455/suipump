// useTokenStats.js
// For each token in the list, fetches TokensPurchased + TokensSold events
// and computes: volume, trades, reserveSui, pctChange, recentTrades (last 60m)
// Returns a map: { [curveId]: { volume, trades, reserveSui, pctChange, recentTrades } }

import { useState, useEffect, useRef } from 'react';
import { useSuiClient } from '@mysten/dapp-kit';
import { PACKAGE_ID } from './constants.js';

const MIST_PER_SUI = 1e9;
const ONE_HOUR_MS = 60 * 60 * 1000;

export function useTokenStats(tokens) {
  const client = useSuiClient();
  const [stats, setStats] = useState({});
  const prevTokenIds = useRef('');

  useEffect(() => {
    if (!tokens || tokens.length === 0) return;

    const ids = tokens.map(t => t.curveId).join(',');
    if (ids === prevTokenIds.current) return; // no new tokens, skip re-fetch
    prevTokenIds.current = ids;

    let cancelled = false;

    async function load() {
      try {
        // Fetch all buy + sell events globally (covers all curves)
        const [buysResult, sellsResult] = await Promise.all([
          client.queryEvents({
            query: { MoveEventType: `${PACKAGE_ID}::bonding_curve::TokensPurchased` },
            limit: 500,
            order: 'descending',
          }),
          client.queryEvents({
            query: { MoveEventType: `${PACKAGE_ID}::bonding_curve::TokensSold` },
            limit: 500,
            order: 'descending',
          }),
        ]);

        if (cancelled) return;

        const now = Date.now();

        // Group by curveId
        const map = {};

        const ensure = (curveId) => {
          if (!map[curveId]) {
            map[curveId] = {
              volume: 0,
              trades: 0,
              recentTrades: 0,
              firstPrice: null,  // oldest price we have (approximate)
              lastPrice: null,   // most recent price
              reserveSui: 0,
            };
          }
          return map[curveId];
        };

        // Process buys (descending order = newest first)
        for (const evt of buysResult.data) {
          const j = evt.parsedJson;
          if (!j?.curve_id) continue;
          const s = ensure(j.curve_id);
          const suiIn = Number(j.sui_in ?? 0) / MIST_PER_SUI;
          const ts = evt.timestampMs ? Number(evt.timestampMs) : 0;
          s.volume += suiIn;
          s.trades += 1;
          if (ts && now - ts < ONE_HOUR_MS) s.recentTrades += 1;
          // price approximation: sui_in / tokens_out (in whole tokens)
          const tokensOut = Number(j.tokens_out ?? 0) / 1e6;
          if (tokensOut > 0) {
            const price = suiIn / tokensOut;
            if (s.lastPrice === null) s.lastPrice = price; // first seen = most recent
            s.firstPrice = price; // keep overwriting = oldest we've seen
          }
        }

        // Process sells
        for (const evt of sellsResult.data) {
          const j = evt.parsedJson;
          if (!j?.curve_id) continue;
          const s = ensure(j.curve_id);
          const suiOut = Number(j.sui_out ?? 0) / MIST_PER_SUI;
          const ts = evt.timestampMs ? Number(evt.timestampMs) : 0;
          s.volume += suiOut;
          s.trades += 1;
          if (ts && now - ts < ONE_HOUR_MS) s.recentTrades += 1;
          const tokensIn = Number(j.tokens_in ?? 0) / 1e6;
          if (tokensIn > 0) {
            const price = suiOut / tokensIn;
            if (s.lastPrice === null) s.lastPrice = price;
            s.firstPrice = price;
          }
        }

        // Compute % change: (lastPrice - firstPrice) / firstPrice * 100
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
