// useTokenStats.js
// Enriches the token list with on-chain stats: volume, trade count,
// sui_reserve, and graduated status. Used for sorting on the homepage.

import { useState, useEffect } from 'react';
import { useSuiClient } from '@mysten/dapp-kit';
import { PACKAGE_ID } from './constants.js';

const MIST_PER_SUI = 1e9;

export function useTokenStats(tokens) {
  const client = useSuiClient();
  const [stats, setStats] = useState({}); // curveId -> { volume, trades, reserveSui, graduated }

  useEffect(() => {
    if (!tokens.length) return;
    let cancelled = false;

    async function load() {
      try {
        const [buys, sells] = await Promise.all([
          client.queryEvents({
            query: { MoveEventType: `${PACKAGE_ID}::bonding_curve::TokensPurchased` },
            limit: 100,
            order: 'descending',
          }),
          client.queryEvents({
            query: { MoveEventType: `${PACKAGE_ID}::bonding_curve::TokensSold` },
            limit: 100,
            order: 'descending',
          }),
        ]);

        if (cancelled) return;

        const volumeMap = {};
        const tradeMap = {};

        for (const e of buys.data) {
          const id = e.parsedJson?.curve_id;
          if (!id) continue;
          volumeMap[id] = (volumeMap[id] || 0) + Number(e.parsedJson.sui_in) / MIST_PER_SUI;
          tradeMap[id] = (tradeMap[id] || 0) + 1;
        }
        for (const e of sells.data) {
          const id = e.parsedJson?.curve_id;
          if (!id) continue;
          volumeMap[id] = (volumeMap[id] || 0) + Number(e.parsedJson.sui_out) / MIST_PER_SUI;
          tradeMap[id] = (tradeMap[id] || 0) + 1;
        }

        // Fetch curve state for each token (reserve + graduated)
        const curveStates = await Promise.all(
          tokens.map(async (t) => {
            try {
              const obj = await client.getObject({ id: t.curveId, options: { showContent: true } });
              const f = obj.data?.content?.fields;
              return {
                curveId: t.curveId,
                reserveSui: f ? Number(f.sui_reserve) / MIST_PER_SUI : 0,
                graduated: f?.graduated ?? false,
              };
            } catch {
              return { curveId: t.curveId, reserveSui: 0, graduated: false };
            }
          })
        );

        if (cancelled) return;

        const result = {};
        for (const cs of curveStates) {
          result[cs.curveId] = {
            volume: volumeMap[cs.curveId] || 0,
            trades: tradeMap[cs.curveId] || 0,
            reserveSui: cs.reserveSui,
            graduated: cs.graduated,
          };
        }

        setStats(result);
      } catch { }
    }

    load();
    const t = setInterval(load, 30_000);
    return () => { cancelled = true; clearInterval(t); };
  }, [client, tokens.length]);

  return stats;
}
