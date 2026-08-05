// `src/config/env.ts` validates process.env at import time and calls
// process.exit(1) when it fails — which would kill the whole vitest run on CI,
// where no .env exists. Anything that transitively imports the logger pulls env
// in, so seed placeholder values before the module graph loads.
//
// These are never connected to; the suite is pure functions only.
process.env.NODE_ENV ||= 'test';
process.env.DATABASE_URL ||=
  'postgresql://test:test@localhost:5432/test?schema=public';
process.env.JWT_SECRET ||= 'test-secret-that-is-at-least-32-characters-long';
