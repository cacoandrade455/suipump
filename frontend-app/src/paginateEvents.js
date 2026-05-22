// paginateEvents.js — gRPC migration stub
//
// The old JSON-RPC `client.queryEvents` does not exist in the gRPC client.
// Event queries now require @mysten/sui/graphql (SuiGraphQLClient).
//
// All call sites of paginateEvents/paginateMultipleEvents already have an
// indexer-first path with these functions as fallback. In the new architecture,
// the indexer is the single source of truth for events — these stubs return
// empty results so the indexer path is always used.
//
// If the indexer is down, components will show "loading" or empty states
// instead of trying (and failing) to hit gRPC. That's the correct behavior:
// browsers can't efficiently query historical events from a node anyway.

export async function paginateEvents(/* client, eventType, opts */) {
  // Indexer-only mode — no on-chain fallback
  return [];
}

export async function paginateMultipleEvents(/* client, eventTypes, opts */) {
  // Returns an empty map; callers should handle the no-events case via indexer
  return {};
}
