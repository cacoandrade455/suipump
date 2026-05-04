// useTokenList.js
// Queries CurveCreated events from the current suipump package.

import { useState, useEffect } from 'react';
import { useSuiClient } from '@mysten/dapp-kit';
import { PACKAGE_ID } from './constants.js';

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

        const result = await client.queryEvents({
          query: { MoveEventType: `${PACKAGE_ID}::bonding_curve::CurveCreated` },
          limit: 50,
          order: 'descending',
        });

        if (cancelled) return;

        const list = result.data.map((evt) => {
          const j = evt.parsedJson;
          return {
            curveId: j.curve_id,
            creator: j.creator,
            name: j.name,
            symbol: j.symbol,
            timestamp: evt.timestampMs ? Number(evt.timestampMs) : null,
          };
        });

        const enriched = await Promise.all(list.map(async (token) => {
          try {
            const obj = await client.getObject({ id: token.curveId, options: { showType: true } });
            const typeStr = obj.data?.type ?? '';
            const match = typeStr.match(/Curve<(.+)>$/);
            const tokenType = match ? match[1] : null;
            return { ...token, tokenType };
          } catch {
            return { ...token, tokenType: null };
          }
        }));

        if (!cancelled) setTokens(enriched);
      } catch (err) {
        if (!cancelled) setError(err.message || String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    const interval = setInterval(load, 15_000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [client]);

  return { tokens, loading, error };
}

export async function fetchCurveState(client, curveId) {
  const obj = await client.getObject({ id: curveId, options: { showContent: true } });
  return obj.data?.content?.fields ?? null;
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

        // Query CurveCreated events from all package versions in parallel
        const allResults = await Promise.all(
          ALL_PACKAGE_IDS.map(pkgId =>
            client.queryEvents({
              query: { MoveEventType: `${pkgId}::bonding_curve::CurveCreated` },
              limit: 50,
              order: 'descending',
            }).catch(() => ({ data: [] }))
          )
        );

        if (cancelled) return;

        // Merge and deduplicate by curveId
        const seen = new Set();
        const merged = [];
        for (const result of allResults) {
          for (const evt of result.data) {
            const j = evt.parsedJson;
            if (!j?.curve_id || seen.has(j.curve_id)) continue;
            seen.add(j.curve_id);
            merged.push({
              curveId: j.curve_id,
              creator: j.creator,
              name: j.name,
              symbol: j.symbol,
              timestamp: evt.timestampMs ? Number(evt.timestampMs) : null,
            });
          }
        }

        // Sort newest first
        merged.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

        // For tokens with the same name+symbol, keep only the newest one.
        // This removes duplicate Example Tokens from multiple redeploys.
        const seenNameSymbol = new Set();
        const deduped = merged.filter(t => {
          const key = `${t.name?.toLowerCase()}:${t.symbol?.toLowerCase()}`;
          if (seenNameSymbol.has(key)) return false;
          seenNameSymbol.add(key);
          return true;
        });

        // Enrich with token type from curve object
        const enriched = await Promise.all(deduped.map(async (token) => {
          try {
            const obj = await client.getObject({ id: token.curveId, options: { showType: true } });
            const typeStr = obj.data?.type ?? '';
            const match = typeStr.match(/Curve<(.+)>$/);
            const tokenType = match ? match[1] : null;
            return { ...token, tokenType };
          } catch {
            return { ...token, tokenType: null };
          }
        }));

        if (!cancelled) setTokens(enriched);
      } catch (err) {
        if (!cancelled) setError(err.message || String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    const interval = setInterval(load, 15_000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [client]);

  return { tokens, loading, error };
}

export async function fetchCurveState(client, curveId) {
  const obj = await client.getObject({ id: curveId, options: { showContent: true } });
  return obj.data?.content?.fields ?? null;
}
