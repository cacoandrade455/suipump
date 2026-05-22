import React from 'react';
import ReactDOM from 'react-dom/client';
import { createDAppKit, DAppKitProvider } from '@mysten/dapp-kit-react';
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { GrpcWebFetchTransport } from '@protobuf-ts/grpcweb-transport';
import { BrowserRouter } from 'react-router-dom';
import { Analytics } from '@vercel/analytics/react';

import App from './App.jsx';
import './index.css';

// ── BlockVision gRPC-Web with x-api-key auth ─────────────────────────────────
// SuiGrpcClient ignores `meta` in its options (only forwards `baseUrl`), so
// we build our own GrpcWebFetchTransport with the api key in meta and pass it
// via the `transport` option.
const GRPC_WEB_BASE = 'https://sui-testnet-grpc-web.blockvision.org';
const API_KEY = '3E5yGg2pwBkloflndd4oQPQU08w';

const transport = new GrpcWebFetchTransport({
  baseUrl: GRPC_WEB_BASE,
  meta: {
    'x-api-key': API_KEY,
  },
});

export const dAppKit = createDAppKit({
  networks: ['testnet'],
  defaultNetwork: 'testnet',
  createClient: (network) =>
    new SuiGrpcClient({
      network,
      transport,
    }),
});

console.log('[SUIPUMP] gRPC-Web base:', GRPC_WEB_BASE);
console.log('[SUIPUMP] API key set:', !!API_KEY, 'len:', API_KEY.length);

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
