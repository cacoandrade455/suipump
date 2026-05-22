import React from 'react';
import ReactDOM from 'react-dom/client';
import { createDAppKit, DAppKitProvider } from '@mysten/dapp-kit-react';
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { BrowserRouter } from 'react-router-dom';
import { Analytics } from '@vercel/analytics/react';

import App from './App.jsx';
import './index.css';

// ── gRPC client (replaces JSON-RPC SuiClient) ─────────────────────────────────
// Public Mysten Labs gRPC endpoints — free, no API key, no rate limits.
// Replaces the deprecated JSON-RPC endpoint (removed July 31 2026).
const GRPC_URLS = {
  testnet: 'https://fullnode.testnet.sui.io:443',
  mainnet: 'https://fullnode.mainnet.sui.io:443',
};

export const dAppKit = createDAppKit({
  networks: ['testnet'],
  defaultNetwork: 'testnet',
  createClient: (network) =>
    new SuiGrpcClient({
      network,
      baseUrl: GRPC_URLS[network],
    }),
});

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <DAppKitProvider dAppKit={dAppKit} autoConnect>
      <BrowserRouter>
        <App />
        <Analytics />
      </BrowserRouter>
    </DAppKitProvider>
  </React.StrictMode>
);
