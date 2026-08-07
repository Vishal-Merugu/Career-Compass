import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { MantineProvider } from '@mantine/core';
import { Notifications } from '@mantine/notifications';
import {
  QueryCache,
  QueryClient,
  QueryClientProvider,
} from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';

// ─── Stylesheets ─────────────────────────────────────────────────
//
// These MUST come before any local component import, and the order is load
// bearing rather than tidiness.
//
// ES imports evaluate top to bottom, and a `*.module.css` is emitted when the
// component importing it is evaluated. With `./App` above this block, every
// module stylesheet in the app landed BEFORE Mantine's, and Mantine's own
// rules are single-class — same specificity as a CSS module — so the later
// sheet won every tie.
//
// What that cost: `.navLink { padding: 10px 12px }` lost to
// `UnstyledButton`'s `padding: 0`, so the nav items had no padding at all and
// the hover fill sat flush against the icon. The `!important`s in
// ResultsPage.module.css are the same bug, worked around one rule at a time.
//
// Self-hosted fonts: the VM is VPN-only and may not reach a font CDN, and an
// http:// page fetching a webfont is a render-blocking request we do not need.
//
// Three families, each with one job, which is why three is not extravagant:
// Plus Jakarta Sans for every control and every table cell, Instrument Serif
// for the page title only, JetBrains Mono for the email column. Inter was
// replaced because it is the house font of every dashboard built since 2020 —
// correct, and completely anonymous.
//
// Only the weight axes are imported. The italic axis is a second file and
// nothing here is set in italic.
import '@fontsource-variable/plus-jakarta-sans/wght.css';
import '@fontsource/instrument-serif/400.css';
import '@fontsource-variable/jetbrains-mono/wght.css';
import '@mantine/core/styles.css';
import '@mantine/notifications/styles.css';
import './theme/global.css';

// Local modules last, so their CSS modules are emitted after Mantine's and
// win the ties they are written to win.
import { App } from './App';
import { AuthProvider, ME_QUERY_KEY } from './auth/AuthProvider';
import { ApiError } from './api/client';
import { theme, cssVariablesResolver } from './theme/theme';

const queryClient = new QueryClient({
  // A 401 from ANY query means the session is gone — a cookie expiring while
  // the tab sits open looks exactly like this. Record it centrally so the route
  // guard redirects to /login, instead of each screen rendering its own "not
  // authenticated" error while the header still shows the signed-in user.
  queryCache: new QueryCache({
    onError: (error, query) => {
      if (
        error instanceof ApiError &&
        error.isUnauthorized &&
        query.queryKey[0] !== ME_QUERY_KEY[0]
      ) {
        queryClient.setQueryData(ME_QUERY_KEY, null);
      }
    },
  }),
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
