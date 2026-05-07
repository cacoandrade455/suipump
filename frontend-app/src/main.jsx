import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SuiClientProvider, WalletProvider, createNetworkConfig } from '@mysten/dapp-kit';
import { getFullnodeUrl } from '@mysten/sui/client';
import { BrowserRouter } from 'react-router-dom';
import { inject } from '@vercel/analytics';

import App from './App.jsx';
import './index.css';

// Vercel Analytics — tracks pageviews, unique visitors, referrers, countries
inject();

const { networkConfig } = createNetworkConfig({
  testnet: { url: getFullnodeUrl('testnet') },
});

const queryClient = new QueryClient();

// Get your free WalletConnect project ID at https://cloud.walletconnect.com
// Create a project → copy the Project ID → paste in frontend-app/.env as:
// VITE_WALLETCONNECT_PROJECT_ID=your_id_here
const WALLET_CONNECT_PROJECT_ID = import.meta.env.VITE_WALLETCONNECT_PROJECT_ID || '';

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <SuiClientProvider networks={networkConfig} defaultNetwork="testnet">
        <WalletProvider
          autoConnect
          walletConnectProjectId={WALLET_CONNECT_PROJECT_ID || undefined}
        >
          <BrowserRouter>
            <App />
          </BrowserRouter>
        </WalletProvider>
      </SuiClientProvider>
    </QueryClientProvider>
  </React.StrictMode>
);
