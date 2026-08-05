import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Tests live alongside source as *.test.ts, not in a __tests__/ folder.
    include: ['src/**/*.test.ts'],
    environment: 'node',
    setupFiles: ['./vitest.setup.ts'],
    // These are pure-function tests; nothing here should touch the network,
    // the database, or the clock for more than a moment.
    testTimeout: 5_000,
  },
});
