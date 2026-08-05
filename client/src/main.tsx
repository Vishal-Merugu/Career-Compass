import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { MantineProvider } from '@mantine/core';
import { Notifications } from '@mantine/notifications';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import { AuthProvider } from './auth/AuthProvider';
import { ApiError } from './api/client';
import { theme, cssVariablesResolver } from './theme/theme';

// Self-hosted, bundled into server/public. The VM is VPN-only and a font CDN
// may not be reachable from it — and an http:// page fetching a webfont over
// the network is a render-blocking request we do not need.
import '@fontsource-variable/inter';

import '@mantine/core/styles.css';
import '@mantine/notifications/styles.css';
import './theme/global.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // A 401 means the session is gone; retrying cannot fix it and only
      // delays the redirect to /login.
      retry: (count, error) =>
        !(error instanceof ApiError && error.isUnauthorized) && count < 2,
      refetchOnWindowFocus: false,
    },
  },
});

const root = document.getElementById('root');
if (!root) {
  throw new Error('Missing #root element in index.html');
}

createRoot(root).render(
  <StrictMode>
    <MantineProvider
      theme={theme}
      cssVariablesResolver={cssVariablesResolver}
      defaultColorScheme="auto"
    >
      <Notifications position="top-right" />
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <AuthProvider>
            <App />
          </AuthProvider>
        </BrowserRouter>
      </QueryClientProvider>
    </MantineProvider>
  </StrictMode>,
);
