// paginateEvents.js
// Shared utility for cursor-based pagination of Sui queryEvents.
// Includes in-memory cache (30s TTL) and 100 events/page for fewer RPC calls.

const cache = {};
const CACHE_TTL = 30_000;

export async function paginateEvents(client, eventType, opts = {}) {
  const {
    order    = 'descending',
    pageSize = 100,   // max supported by Sui RPC — halves round trips vs 50
    maxPages = 100,
  } = opts;

  const cacheKey = `${eventType}:${order}:${maxPages}`;
  const now = Date.now();

  // Return cached result if fresh
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

    if (result.data && result.data.length > 0) {
      allEvents.push(...result.data);
    }

    hasNext = result.hasNextPage === true && result.data.length > 0;
    cursor  = result.nextCursor ?? null;
    page++;
  }

  // Cache the result
  cache[cacheKey] = { data: allEvents, ts: now };

  return allEvents;
}

export async function paginateMultipleEvents(client, eventTypes, opts = {}) {
  const results = await Promise.all(
    eventTypes.map(type => paginateEvents(client, type, opts))
  );
  const map = {};
  eventTypes.forEach((type, i) => { map[type] = results[i]; });
  return map;
}
