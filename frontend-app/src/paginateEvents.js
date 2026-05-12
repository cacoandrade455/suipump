// paginateEvents.js
// Shared utility for cursor-based pagination of Sui queryEvents.
// The Sui RPC caps each queryEvents call at ~100 results per page.
// This helper fetches ALL pages (up to maxPages * pageSize events)
// using the cursor returned by each response.

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
  }

  return allEvents;
}

export async function paginateMultipleEvents(client, eventTypes, opts = {}) {
  const results = await Promise.all(
    eventTypes.map(type => paginateEvents(client, type, opts))
  );
  const map = {};
  eventTypes.forEach((type, i) => {
    map[type] = results[i];
  });
  return map;
}
