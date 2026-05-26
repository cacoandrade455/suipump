// dapp-kit.js — SuiPump dApp Kit instance
// Uses SuiGraphQLClient for July 31 2026 JSON-RPC shutdown safety.

import { createDAppKit } from '@mysten/dapp-kit-react';
import { SuiGraphQLClient } from '@mysten/sui/graphql';

export const dAppKit = createDAppKit({
  networks: ['testnet'],
  defaultNetwork: 'testnet',
  createClient: (network) => new SuiGraphQLClient({
    url: `https://graphql.${network}.sui.io/graphql`,
    network,
  }),
  autoConnect: true,
});
