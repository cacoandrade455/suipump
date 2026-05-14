// useTokenList.js
// Queries CurveCreated events from ALL deployed suipump packages (v4 + v5).
// Uses cursor-based pagination to fetch ALL events (not capped at 50).
// V5 tokens include graduation_target and anti_bot_delay fields.

import { useState, useEffect } from 'react';
import { useSuiClient } from '@mysten/dapp-kit';
import { ALL_PACKAGE_IDS, PACKAGE_ID_V4, PACKAGE_ID_V5 } from './constants.js';
import { paginateEvents } from './paginateEvents.js';

export function useTokenList() {
  const client = useSuiClient();
  const [tokens, setTokens]   = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        setLoading(true);
        setError(null);

        // Fetch CurveCreated events from all package versions in parallel
        const eventArrays = await Promise.all(
          ALL_PACKAGE_IDS.map(pkgId =>
            paginateEvents(
              client,
              `${pkgId}::bonding_curve::CurveCreated`,
              { order: 'descending', maxPages: 20 }
            ).catch(() => []) // gracefully skip if package has no events
          )
        );

        if (cancelled) return;

        // Flatten + tag each event with its source package version
        const allEvents = eventArrays.flatMap((events, idx) =>
          events.map(evt => ({ ...evt, _pkgId: ALL_PACKAGE_IDS[idx] }))
        );

        // Sort all events descending by timestamp
        allEvents.sort((a, b) => {
          const ta = a.timestampMs ? Number(a.timestampMs) : 0;
          const tb = b.timestampMs ? Number(b.timestampMs) : 0;
          return tb - ta;
        });

        const list = allEvents.map((evt) => {
          const j = evt.parsedJson;
          const isV5 = evt._pkgId === PACKAGE_ID_V5;
          return {
            curveId:           j.curve_id,
            creator:           j.creator,
            name:              j.name,
            symbol:            j.symbol,
            timestamp:         evt.timestampMs ? Number(evt.timestampMs) : null,
            packageId:         evt._pkgId,
            isV5,
            // V5-only fields (undefined on v4 tokens)
            graduationTarget:  isV5 ? j.graduation_target  : undefined,
            antiBotDelay:      isV5 ? j.anti_bot_delay      : undefined,
          };
        });

        // Enrich with tokenType from on-chain object
        const enriched = await Promise.all(list.map(async (token) => {
          try {
            const obj = await client.getObject({
              id: token.curveId,
              options: { showType: true },
            });
            const typeStr = obj.data?.type ?? '';
            const match   = typeStr.match(/Curve<(.+)>$/);
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
