import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The dashboard is served same-origin by the Express server in production, so
// every request is a relative /api/... path and there is no API base URL to
// configure. See docs/adr/0004-same-origin-web-dashboard.md.
export default defineConfig({
  plugins: [react()],
  build: {
    // Express serves `server/public`; this is the only wiring between the two.
    outDir: '../server/public',
    emptyOutDir: true,
  },
  server: {
    // `npm run dev` serves the app from Vite but proxies the API to the real
    // server, which keeps dev same-origin too — no CORS, and the httpOnly
    // session cookie is stored and returned exactly as it is in production.
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: false,
      },
    },
  },
});
