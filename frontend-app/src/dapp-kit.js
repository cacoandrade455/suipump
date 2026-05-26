// dapp-kit.js — SuiPump dApp Kit instance
// Uses SuiGraphQLClient for July 31 2026 JSON-RPC shutdown safety.
// Import this instance into main.jsx and any component needing direct dAppKit access.

import { createDAppKit } from '@mysten/dapp-kit-react';
import { SuiGraphQLClient } from '@mysten/sui/graphql';

export const dAppKit = createDAppKit({
  networks: ['testnet'],
  createClient: (network) => new SuiGraphQLClient({
    url: `https://graphql.${network}.sui.io/graphql`,
  }),
  autoConnect: true,
});

// Global type registration — enables hook type inference without passing dAppKit explicitly
// This is a JS file so no TypeScript declare module, but the runtime registration still works.
