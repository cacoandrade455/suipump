// useTokenList.js
import { useState, useEffect } from 'react';
import { useSuiClient } from '@mysten/dapp-kit';
import { ALL_PACKAGE_IDS, isV5OrLater } from './constants.js';
import { paginateEvents } from './paginateEvents.js';

const INDEXER_URL = import.meta.env.VITE_INDEXER_URL || '';

export function useTokenList() {
  const client = useSuiClient();
  const [tokens, setTokens]   = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);

  useEffect(() => {
    let cancelled = false;

    async function loadFromIndexer() {
      const res = await fetch(`${INDEXER_URL}/tokens`, { signal: AbortSignal.timeout(6000) });
      if (!res.ok) throw new Error('indexer not ok');
      const rows = await res.json();
      return rows.map(r => ({
        curveId:          r.curveId,
        creator:          r.creator,
        name:             r.name,
        symbol:           r.symbol,
        description:      r.description,
        iconUrl:          r.iconUrl,
        timestamp:        r.createdAt ? Number(r.createdAt) : null,
        packageId:        r.packageId,
        isV5:             isV5OrLater(r.packageId),
        graduationTarget: r.graduationTarget,
        antiBotDelay:     r.antiBotDelay,
        tokenType:        r.tokenType,
      }));
    }

    async function loadFromRpc() {
      const eventArrays = await Promise.all(
        ALL_PACKAGE_IDS.map(pkgId =>
          paginateEvents(client, `${pkgId}::bonding_curve::CurveCreated`, { order: 'descending', maxPages: 20 }).catch(() => [])
        )
      );
      const allEvents = eventArrays.flatMap((events, idx) =>
        events.map(evt => ({ ...evt, _pkgId: ALL_PACKAGE_IDS[idx] }))
      );
      allEvents.sort((a, b) => (b.timestampMs ? Number(b.timestampMs) : 0) - (a.timestampMs ? Number(a.timestampMs) : 0));
      const list = allEvents.map(evt => {
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
          iconUrl:          j.icon_url ?? null,
          tokenType:        null,
        };
      });
      return await Promise.all(list.map(async (token) => {
        try {
          const obj = await client.getObject({ id: token.curveId, options: { showType: true } });
          const typeStr = obj.data?.type ?? '';
          const match   = typeStr.match(/Curve<(.+)>$/);
          return { ...token, tokenType: match ? match[1] : null };
        } catch { return token; }
      }));
    }

    async function load() {
      try {
        setLoading(true);
        setError(null);
        let enriched;
        if (INDEXER_URL) {
          try { enriched = await loadFromIndexer(); }
          catch { enriched = await loadFromRpc(); }
        } else {
          enriched = await loadFromRpc();
        }
        if (!cancelled) {
          setTokens(enriched);
          // Preload all icon images immediately so they're cached before cards render
          enriched.forEach(t => {
            if (t.iconUrl) {
              const img = new window.Image();
              img.src = t.iconUrl;
            }
          });
        }
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
