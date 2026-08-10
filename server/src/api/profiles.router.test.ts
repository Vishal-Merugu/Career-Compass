import { describe, expect, it } from 'vitest';
import { profilesRouter } from './profiles.router.js';

/**
 * Route *order*, not route behaviour.
 *
 * Express matches in registration order, so a `:id` route registered above a
 * literal sibling swallows it — and the failure is a plausible-looking 404 from
 * the wrong handler, not an error anyone traces back to ordering. That is
 * exactly what happened: `GET /profiles/:id` sat above `GET
 * /profiles/find-emails`, which therefore answered 404 "Profile not found" for
 * every call the dashboard made.
 *
 * Asserted off the router's own layer stack so it needs no server, no database
 * and no auth — the property being pinned is static.
 */

type Layer = {
  route?: { path: string; methods: Record<string, boolean> };
};

const layers = (profilesRouter as unknown as { stack: Layer[] }).stack;

const routes = layers.flatMap((layer) =>
  layer.route
    ? Object.keys(layer.route.methods).map((method) => ({
        method,
        path: layer.route!.path,
      }))
    : [],
);

describe('profiles router registration order', () => {
  it('registers every literal /profiles/* route before the :id pattern', () => {
    for (const method of ['get', 'delete']) {
      const forMethod = routes.filter((r) => r.method === method);
      const patternAt = forMethod.findIndex((r) => r.path === '/profiles/:id');
      if (patternAt === -1) continue;

      const shadowed = forMethod
        .slice(patternAt + 1)
        .filter(
          (r) =>
            r.path.startsWith('/profiles/') &&
            !r.path.includes(':') &&
            r.path.split('/').length === 3,
        )
        .map((r) => `${method.toUpperCase()} ${r.path}`);

      expect(shadowed).toEqual([]);
    }
  });

  it('still exposes the find-emails routes', () => {
    const paths = routes.map((r) => `${r.method} ${r.path}`);
    expect(paths).toContain('get /profiles/find-emails');
    expect(paths).toContain('post /profiles/find-emails');
    expect(paths).toContain('delete /profiles/find-emails');
  });
});
