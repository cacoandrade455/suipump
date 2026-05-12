// paginateEvents.js
// Shared utility for cursor-based pagination of Sui queryEvents.
// Includes a small delay between pages to avoid hitting RPC QPS limits.

const PAGE_DELAY_MS = 300; // delay between pagination pages

export async function paginateEvents(client, eventType, opts = {}) {
  const {
    order = 'descending',
    pageSize = 50,
    maxPages = 20,
  } = opts;

  const allEvents = [];
  let cursor = null;
  let hasNext = true;
  let page = 0;

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
    cursor = result.nextCursor ?? null;
    page++;

    // Throttle: small delay between pages to avoid QPS spikes
    if (hasNext) {
      await new Promise(r => setTimeout(r, PAGE_DELAY_MS));
    }
  }

  return allEvents;
}

export async function paginateMultipleEvents(client, eventTypes, opts = {}) {
  // Sequential instead of parallel to reduce QPS pressure
  const map = {};
  for (const type of eventTypes) {
    map[type] = await paginateEvents(client, type, opts);
    // Small delay between event type fetches
    await new Promise(r => setTimeout(r, 100));
  }
  return map;
}
