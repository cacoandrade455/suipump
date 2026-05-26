import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { DAppKitProvider } from '@mysten/dapp-kit-react';
import { BrowserRouter } from 'react-router-dom';
import { Analytics } from '@vercel/analytics/react';

import { dAppKit } from './dapp-kit.js';
import App from './App.jsx';
import './index.css';

const queryClient = new QueryClient();

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <DAppKitProvider dAppKit={dAppKit}>
        <BrowserRouter>
          <App />
          <Analytics />
        </BrowserRouter>
      </DAppKitProvider>
    </QueryClientProvider>
  </React.StrictMode>
);
