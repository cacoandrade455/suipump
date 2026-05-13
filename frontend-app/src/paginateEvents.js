// paginateEvents.js
// Fetches events via the SuiPump indexer API when available.
// Falls back to direct RPC pagination if the API is unreachable.
// 30s in-memory cache on all results.

const INDEXER_URL = import.meta.env?.VITE_INDEXER_URL || '';
const cache = {};
const CACHE_TTL = 30_000;

// ── Indexer API fetch ─────────────────────────────────────────────────────────

async function fetchFromIndexer(endpoint) {
  if (!INDEXER_URL) return null;
  try {
    const res = await fetch(`${INDEXER_URL}${endpoint}`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// ── RPC fallback ──────────────────────────────────────────────────────────────

async function paginateEventsRpc(client, eventType, opts = {}) {
  const {
    order    = 'descending',
    pageSize = 100,
    maxPages = 100,
  } = opts;

  const cacheKey = `rpc:${eventType}:${order}:${maxPages}`;
  const now = Date.now();
  if (cache[cacheKey] && now - cache[cacheKey].ts < CACHE_TTL) {
    return cache[cacheKey].data;
  }

  const allEvents = [];
  let cursor  = null;
  let hasNext = true;
  let page    = 0;

  while (hasNext && page < maxPages) {
    const query = {
      query: { MoveEventType: eventType },
      limit: pageSize,
      order,
    };
    if (cursor) query.cursor = cursor;

    const result = await client.queryEvents(query);
    if (result.data?.length > 0) allEvents.push(...result.data);
    hasNext = result.hasNextPage === true && result.data.length > 0;
    cursor  = result.nextCursor ?? null;
    page++;
  }

  cache[cacheKey] = { data: allEvents, ts: now };
  return allEvents;
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function paginateEvents(client, eventType, opts = {}) {
  return paginateEventsRpc(client, eventType, opts);
}

export async function paginateMultipleEvents(client, eventTypes, opts = {}) {
  const results = await Promise.all(
    eventTypes.map(type => paginateEvents(client, type, opts))
  );
  const map = {};
  eventTypes.forEach((type, i) => { map[type] = results[i]; });
  return map;
}

// ── Indexer-specific helpers ──────────────────────────────────────────────────

export async function fetchGlobalStats() {
  const cacheKey = 'indexer:stats';
  const now = Date.now();
  if (cache[cacheKey] && now - cache[cacheKey].ts < CACHE_TTL) {
    return cache[cacheKey].data;
  }
  const data = await fetchFromIndexer('/stats');
  if (data) { cache[cacheKey] = { data, ts: now }; return data; }
  return null;
}

export async function fetchAllTokenStats() {
  const cacheKey = 'indexer:all-tokens';
  const now = Date.now();
  if (cache[cacheKey] && now - cache[cacheKey].ts < CACHE_TTL) {
    return cache[cacheKey].data;
  }
  const data = await fetchFromIndexer('/tokens');
  if (data) { cache[cacheKey] = { data, ts: now }; return data; }
  return null;
}

export async function fetchRecentTrades(limit = 50) {
  return fetchFromIndexer(`/trades/recent?limit=${limit}`);
}
