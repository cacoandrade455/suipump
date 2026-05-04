// useTokenList.js
// Queries CurveCreated events from ALL suipump package deployments
// so tokens launched on previous versions still appear.

import { useState, useEffect } from 'react';
import { useSuiClient } from '@mysten/dapp-kit';
import { PACKAGE_ID } from './constants.js';

// All historical package IDs — add new ones here after each redeploy.
const ALL_PACKAGE_IDS = [
  '0x22839b3e46129a42ebc2518013105bbf91f435e6664640cb922815659985d349', // v2
  '0x87d24b0242c1fe503c5b7d72489eeed0361b19be485de0bd49b749be6d3b2c4c', // v3 comments attempt 1
  PACKAGE_ID, // current — always included
].filter((v, i, a) => a.indexOf(v) === i); // deduplicate

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
