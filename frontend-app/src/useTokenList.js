// useTokenList.js
// Queries CurveCreated events from the suipump package to build a live
// list of all launched tokens. Returns curve IDs, names, symbols, and
// creator addresses. Token trading state (reserve, price) is fetched
// per-token on the individual token page to avoid N simultaneous queries
// on the homepage.

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

    async function fetch() {
      try {
        setLoading(true);
        setError(null);

        // Query all CurveCreated events emitted by the suipump package.
        // Each event has: curve_id, creator, name, symbol.
        const result = await client.queryEvents({
          query: {
            MoveEventType: `${PACKAGE_ID}::bonding_curve::CurveCreated`,
          },
          limit: 50,
          order: 'descending', // newest first
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

        // Fetch each curve object to extract the real token type from its
        // type string: Curve<PACKAGE::module::TYPE> → PACKAGE::module::TYPE
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

    fetch();

    // Refresh every 15s to pick up new launches
    const interval = setInterval(fetch, 15_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [client]);

  return { tokens, loading, error };
}

// Fetch live state for a single curve (reserve, price, graduated).
// Used on the token page and optionally on token cards.
export async function fetchCurveState(client, curveId) {
  const obj = await client.getObject({
    id: curveId,
    options: { showContent: true },
  });
  return obj.data?.content?.fields ?? null;
}
