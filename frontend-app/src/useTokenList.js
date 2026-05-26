// useTokenList.js
import { useState, useEffect } from 'react';
import { ALL_PACKAGE_IDS, isV5OrLater } from './constants.js';
import { paginateEvents } from './paginateEvents.js';

const INDEXER_URL = import.meta.env.VITE_INDEXER_URL || '';

export function useTokenList() {
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
        iconUrl:               r.iconUrl,
        timestamp:             r.createdAt ? Number(r.createdAt) : null,
        packageId:             r.packageId,
        isV5:                  isV5OrLater(r.packageId),
        graduationTarget:      r.graduationTarget,
        antiBotDelay:          r.antiBotDelay,
        tokenType:             r.tokenType,
        initialSharedVersion:  r.initialSharedVersion ?? null,
      }));
    }

    async function loadFromRpc() {
      return []; // RPC fallback removed (CORS blocked on browser)
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
          enriched.forEach(t => {
            if (t.iconUrl) { const img = new window.Image(); img.src = t.iconUrl; }
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
  }, []);

  return { tokens, loading, error };
}

export async function fetchCurveState(client, curveId) {
  // New API: include json for fields
  const obj = await client.getObject({ objectId: curveId, include: { json: true } });
  return obj.object?.json ?? null;
}
