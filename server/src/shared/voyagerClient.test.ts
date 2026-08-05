import { describe, it, expect } from 'vitest';
import {
  VoyagerClient,
  generateTrackingId,
  parseCompanyUrl,
} from './voyagerClient.js';

describe('VoyagerClient construction', () => {
  it('refuses to build without a CSRF token', () => {
    expect(() => new VoyagerClient({ csrfToken: '' })).toThrow(
      'VoyagerClient: csrfToken (JSESSIONID) is required',
    );
  });

  it('strips the quotes LinkedIn wraps JSESSIONID in', () => {
    const client = new VoyagerClient({ csrfToken: '"ajax:1"' });
    expect(client.getVoyagerHeaders()['csrf-token']).toBe('ajax:1');
  });
});

describe('getVoyagerHeaders', () => {
  const client = () =>
    new VoyagerClient({
      csrfToken: '"ajax:1"',
      liAtCookie: 'AQEDA-token',
    });

  it('sends the Voyager protocol headers', () => {
    const h = client().getVoyagerHeaders();
    expect(h['x-restli-protocol-version']).toBe('2.0.0');
    expect(h['x-li-lang']).toBe('en_US');
    expect(h['referer']).toBe('https://www.linkedin.com/');
    expect(h['user-agent']).toContain('Chrome/');
  });

  it('defaults Accept to the normalized Voyager media type', () => {
    expect(client().getVoyagerHeaders()['accept']).toBe(
      'application/vnd.linkedin.normalized+json+2.1',
    );
  });

  it('honours an explicit Accept override', () => {
    expect(client().getVoyagerHeaders('application/json')['accept']).toBe(
      'application/json',
    );
  });

  it('encodes a well-formed x-li-track payload', () => {
    const track = JSON.parse(client().getVoyagerHeaders()['x-li-track']);
    expect(track).toMatchObject({
      osName: 'web',
      deviceFormFactor: 'DESKTOP',
      mpName: 'voyager-web',
    });
    expect(typeof track.timezoneOffset).toBe('number');
  });

  it('omits the Cookie header when running inside the browser', () => {
    // No li_at means the extension is calling from a linkedin.com context and
    // the browser attaches its own cookies via credentials: same-origin.
    const h = new VoyagerClient({ csrfToken: 'ajax:1' }).getVoyagerHeaders();
    expect(h['cookie']).toBeUndefined();
  });

  it('sends only li_at and JSESSIONID — the known-insufficient 2-cookie jar', () => {
    // Pinned deliberately. LinkedIn's risk engine also expects bcookie,
    // bscookie, lidc and li_rm; an auth token without browser-identity cookies
    // reads as a stolen cookie. scratch-voyager-probe.ts has the full jar, and
    // this client must adopt it before any server-side execution path ships.
    // See docs/adr/0002-full-cookie-jar.md. Update this test when it does.
    expect(client().getVoyagerHeaders()['cookie']).toBe(
      'li_at=AQEDA-token; JSESSIONID="ajax:1"',
    );
  });
});

describe('generateTrackingId', () => {
  it('produces a 16-byte base64 value', () => {
    const id = generateTrackingId();
    expect(id).toHaveLength(24);
    expect(id.endsWith('==')).toBe(true);
    expect(Buffer.from(id, 'base64')).toHaveLength(16);
  });

  it('produces a different value each call', () => {
    const ids = new Set(Array.from({ length: 50 }, generateTrackingId));
    expect(ids.size).toBe(50);
  });
});

describe('parseCompanyUrl', () => {
  it('extracts the slug from a canonical company URL', () => {
    expect(parseCompanyUrl('https://www.linkedin.com/company/acme/')).toBe(
      'acme',
    );
  });

  it('ignores trailing path segments and query strings', () => {
    expect(
      parseCompanyUrl('https://www.linkedin.com/company/acme/about/'),
    ).toBe('acme');
    expect(
      parseCompanyUrl('https://www.linkedin.com/company/acme?trk=public'),
    ).toBe('acme');
  });

  it('adds a missing scheme', () => {
    expect(parseCompanyUrl('linkedin.com/company/acme')).toBe('acme');
    expect(parseCompanyUrl('  www.linkedin.com/company/acme  ')).toBe('acme');
  });

  it('returns null for empty input', () => {
    expect(parseCompanyUrl(null)).toBeNull();
    expect(parseCompanyUrl(undefined)).toBeNull();
    expect(parseCompanyUrl('')).toBeNull();
  });

  it('returns null when there is no path to read', () => {
    expect(parseCompanyUrl('https://www.linkedin.com/')).toBeNull();
  });

  it('falls back to the last path segment on a non-company URL', () => {
    // Loose on purpose — callers pass half-typed slugs, not just clean URLs.
    expect(parseCompanyUrl('https://www.linkedin.com/in/marie-uibel')).toBe(
      'marie-uibel',
    );
  });
});
