// useTokenList.js
// Queries CurveCreated events from the current suipump package.
// Uses cursor-based pagination to fetch ALL events (not capped at 50).
// Throttled: enriches tokens in batches of 3 to avoid hitting RPC QPS limits.

import { useState, useEffect } from 'react';
import { useSuiClient } from '@mysten/dapp-kit';
import { PACKAGE_ID } from './constants.js';
import { paginateEvents } from './paginateEvents.js';

// Process array in batches of `size` with optional delay between batches
async function batchedMap(arr, size, fn, delayMs = 150) {
  const results = [];
  for (let i = 0; i < arr.length; i += size) {
    const batch = arr.slice(i, i + size);
    const batchResults = await Promise.all(batch.map(fn));
    results.push(...batchResults);
    if (i + size < arr.length) {
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
  return results;
}

export function useTokenList() {
  const client = useSuiClient();
  const [tokens, setTokens] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        setLoading(true);
        setError(null);

        const events = await paginateEvents(
          client,
          `${PACKAGE_ID}::bonding_curve::CurveCreated`,
          { order: 'descending', maxPages: 20 }
        );

        if (cancelled) return;

        const list = events.map((evt) => {
          const j = evt.parsedJson;
          return {
            curveId: j.curve_id,
            creator: j.creator,
            name: j.name,
            symbol: j.symbol,
            timestamp: evt.timestampMs ? Number(evt.timestampMs) : null,
          };
        });

        // Enrich in batches of 3 to avoid QPS spikes
        const enriched = await batchedMap(list, 3, async (token) => {
          if (cancelled) return { ...token, tokenType: null };
          try {
            const obj = await client.getObject({ id: token.curveId, options: { showType: true } });
            const typeStr = obj.data?.type ?? '';
            const match = typeStr.match(/Curve<(.+)>$/);
            const tokenType = match ? match[1] : null;
            return { ...token, tokenType };
          } catch {
            return { ...token, tokenType: null };
          }
        }, 150);

        if (!cancelled) setTokens(enriched);
      } catch (err) {
        if (!cancelled) setError(err.message || String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    const interval = setInterval(load, 30_000); // slowed from 15s to 30s
    return () => { cancelled = true; clearInterval(interval); };
  }, [client]);

  return { tokens, loading, error };
}

export async function fetchCurveState(client, curveId) {
  const obj = await client.getObject({ id: curveId, options: { showContent: true } });
  return obj.data?.content?.fields ?? null;
}
