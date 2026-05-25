import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SuiClientProvider, WalletProvider } from '@mysten/dapp-kit';
import { SuiGraphQLClient } from '@mysten/sui/graphql';
import { BrowserRouter } from 'react-router-dom';
import { Analytics } from '@vercel/analytics/react';

import App from './App.jsx';
import './index.css';

// Use SuiGraphQLClient — JSON-RPC fullnode endpoint shuts down July 31 2026.
// useSuiClient() throughout the app will return this GraphQL-backed client.
const graphqlClient = new SuiGraphQLClient({
  url: 'https://graphql.testnet.sui.io/graphql',
});

const queryClient = new QueryClient();

const WALLET_CONNECT_PROJECT_ID = import.meta.env.VITE_WALLETCONNECT_PROJECT_ID || '';

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <SuiClientProvider
        networks={{ testnet: graphqlClient }}
        defaultNetwork="testnet"
      >
        <WalletProvider
          autoConnect
          walletConnectProjectId={WALLET_CONNECT_PROJECT_ID || undefined}
        >
          <BrowserRouter>
            <App />
            <Analytics />
          </BrowserRouter>
        </WalletProvider>
      </SuiClientProvider>
    </QueryClientProvider>
  </React.StrictMode>
);
