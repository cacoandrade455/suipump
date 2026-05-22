// useTokenList.js
// Queries CurveCreated events from ALL deployed suipump packages (v4 + v5).
// Uses cursor-based pagination to fetch ALL events (not capped at 50).
// V5 tokens include graduation_target and anti_bot_delay fields.

import { useState, useEffect } from 'react';
import { useCurrentClient } from '@mysten/dapp-kit-react';
import { ALL_PACKAGE_IDS, PACKAGE_ID_V4, PACKAGE_ID_V5, PACKAGE_ID_V6, isV5OrLater } from './constants.js';
import { paginateEvents } from './paginateEvents.js';

const INDEXER_URL = import.meta.env.VITE_INDEXER_URL || '';

export function useTokenList() {
  const client = useCurrentClient();
  const [tokens, setTokens]   = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);

  useEffect(() => {
    let cancelled = false;

    async function loadFromIndexer() {
      const res = await fetch(`${INDEXER_URL}/tokens`, {
        signal: AbortSignal.timeout(6000),
      });
      if (!res.ok) throw new Error('indexer not ok');
      const rows = await res.json();
      return rows.map(r => ({
        curveId:          r.curveId,
        creator:          r.creator,
        name:             r.name,
        symbol:           r.symbol,
        description:      r.description?.trim() || '',
        iconUrl:          r.iconUrl?.trim() || '',
        timestamp:        r.createdAt ? Number(r.createdAt) : null,
        packageId:        r.packageId,
        isV5:             isV5OrLater(r.packageId),
        graduationTarget: r.graduationTarget,
        antiBotDelay:     r.antiBotDelay,
        tokenType:        r.tokenType,
      }));
    }

    async function loadFromRpc() {
      // Fetch CurveCreated events from all package versions in parallel
      const eventArrays = await Promise.all(
        ALL_PACKAGE_IDS.map(pkgId =>
          paginateEvents(
            client,
            `${pkgId}::bonding_curve::CurveCreated`,
            { order: 'descending', maxPages: 20 }
          ).catch(() => [])
        )
      );

      const allEvents = eventArrays.flatMap((events, idx) =>
        events.map(evt => ({ ...evt, _pkgId: ALL_PACKAGE_IDS[idx] }))
      );

      allEvents.sort((a, b) => {
        const ta = a.timestampMs ? Number(a.timestampMs) : 0;
        const tb = b.timestampMs ? Number(b.timestampMs) : 0;
        return tb - ta;
      });

      const list = allEvents.map((evt) => {
        const j = evt.parsedJson;
        const isV5 = isV5OrLater(evt._pkgId);
        return {
          curveId:          j.curve_id,
          creator:          j.creator,
          name:             j.name,
          symbol:           j.symbol,
          timestamp:        evt.timestampMs ? Number(evt.timestampMs) : null,
          packageId:        evt._pkgId,
          isV5,
          graduationTarget: isV5 ? j.graduation_target : undefined,
          antiBotDelay:     isV5 ? j.anti_bot_delay    : undefined,
        };
      });

      // Enrich with tokenType from on-chain object
      return await Promise.all(list.map(async (token) => {
        try {
          const obj = await client.getObject({ objectId: token.curveId });
          const typeStr = obj.object?.type ?? '';
          const match   = typeStr.match(/Curve<(.+)>$/);
          return { ...token, tokenType: match ? match[1] : null };
        } catch {
          return { ...token, tokenType: null };
        }
      }));
    }

    async function load() {
      try {
        setLoading(true);
        setError(null);

        console.log('[SUIPUMP] useTokenList load() — INDEXER_URL =', INDEXER_URL);
        let enriched;
        if (INDEXER_URL) {
          try {
            enriched = await loadFromIndexer();
            console.log('[SUIPUMP] useTokenList: loaded', enriched.length, 'tokens from indexer');
          } catch (e) {
            console.warn('[SUIPUMP] useTokenList: indexer failed, falling back to RPC:', e);
            enriched = await loadFromRpc();
          }
        } else {
          console.warn('[SUIPUMP] useTokenList: no INDEXER_URL set, using RPC');
          enriched = await loadFromRpc();
        }

        if (!cancelled) setTokens(enriched);
      } catch (err) {
        console.error('[SUIPUMP] useTokenList load failed:', err);
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
  const obj = await client.getObject({ objectId: curveId, include: { json: true } });
  return obj.object?.json ?? null;
}
