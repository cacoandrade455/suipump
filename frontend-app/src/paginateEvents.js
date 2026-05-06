// paginateEvents.js
// Shared utility for cursor-based pagination of Sui queryEvents.
// The Sui RPC caps each queryEvents call at ~100 results per page.
// This helper fetches ALL pages (up to maxPages * pageSize events)
// using the cursor returned by each response.
//
// Usage:
//   import { paginateEvents } from './paginateEvents.js';
//   const allEvents = await paginateEvents(client, eventType, { order: 'descending', maxPages: 10 });

/**
 * Fetch all events of a given type, paginating through cursor results.
 *
 * @param {SuiClient} client - The Sui RPC client from @mysten/dapp-kit or @mysten/sui
 * @param {string} eventType - Full MoveEventType string, e.g. `${PACKAGE_ID}::bonding_curve::TokensPurchased`
 * @param {object} [opts]
 * @param {'ascending'|'descending'} [opts.order='descending'] - Sort order
 * @param {number} [opts.pageSize=50] - Events per page (Sui RPC max is ~50 reliably)
 * @param {number} [opts.maxPages=20] - Safety cap on total pages to prevent runaway fetches
 * @returns {Promise<Array>} All event objects from result.data across all pages
 */
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

/**
 * Fetch paginated events for MULTIPLE event types in parallel,
 * then return them as a map: { [eventType]: events[] }
 *
 * @param {SuiClient} client
 * @param {string[]} eventTypes - Array of MoveEventType strings
 * @param {object} [opts] - Same opts as paginateEvents
 * @returns {Promise<Object>} Map of eventType -> events[]
 */
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
