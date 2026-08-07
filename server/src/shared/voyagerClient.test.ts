import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  VoyagerClient,
  generateTrackingId,
  parseCompanyUrl,
} from './voyagerClient.js';
import { CookieJar, type CookieExport } from './cookieJar.js';
import { LinkedInSessionError } from '../errors/AppError.js';

// The client paces itself 1.5–3.7 s per call. Real for LinkedIn, absurd for a
// test suite — stub it out rather than making every request test take seconds.
vi.mock('./rateLimiter.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./rateLimiter.js')>()),
  delay: vi.fn(async () => {}),
}));

const FULL_JAR: CookieExport['cookies'] = {
  li_at: 'AQEDA-token',
  JSESSIONID: '"ajax:1"',
  bcookie: 'v=2&abc',
  bscookie: 'v=1&def',
  lidc: 'b=OB01:s=O',
  li_rm: 'AQE-rm',
};

const jar = (over: Record<string, string> = {}) =>
  new CookieJar({
    cookies: { ...FULL_JAR, ...over },
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/126.0.0.0',
    timezoneOffset: 5.5,
  });

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

  it('refuses a jar with no JSESSIONID', () => {
    const bare = new CookieJar({
      cookies: { li_at: 'AQEDA-token' },
      userAgent: 'ua',
    });
    expect(() => new VoyagerClient({ jar: bare })).toThrow(
      'cookie jar has no JSESSIONID',
    );
  });

  it('refuses a jar missing the browser-identity cookies', () => {
    // The whole point of ADR 0002: li_at + JSESSIONID alone reads as a stolen
    // cookie to LinkedIn's risk engine, so it is rejected at construction
    // rather than at the first 403.
    const twoCookie = new CookieJar({
      cookies: { li_at: 'AQEDA-token', JSESSIONID: '"ajax:1"' },
      userAgent: 'ua',
    });
    expect(() => new VoyagerClient({ jar: twoCookie })).toThrow(
      /missing bcookie, lidc/,
    );
  });
});

describe('getVoyagerHeaders', () => {
  const client = () => new VoyagerClient({ jar: jar() });

  it('sends the Voyager protocol headers', () => {
    const h = client().getVoyagerHeaders();
    expect(h['x-restli-protocol-version']).toBe('2.0.0');
    expect(h['x-li-lang']).toBe('en_US');
    expect(h['referer']).toBe('https://www.linkedin.com/feed/');
    expect(h['user-agent']).toContain('Chrome/');
  });

  it('sends the exported browser user-agent, not a hardcoded one', () => {
    expect(client().getVoyagerHeaders()['user-agent']).toBe(
      'Mozilla/5.0 (X11; Linux x86_64) Chrome/126.0.0.0',
    );
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

  it('takes the timezone offset from the export, not from the server clock', () => {
    const track = JSON.parse(client().getVoyagerHeaders()['x-li-track']);
    expect(track.timezoneOffset).toBe(5.5);
  });

  it('omits the Cookie header when running inside the browser', () => {
    // No jar means the caller is on a linkedin.com context and the browser
    // attaches its own cookies via credentials: same-origin.
    const h = new VoyagerClient({ csrfToken: 'ajax:1' }).getVoyagerHeaders();
    expect(h['cookie']).toBeUndefined();
  });

  it('serialises the whole jar, not just li_at and JSESSIONID', () => {
    // ADR 0002: the browser-identity cookies are what keep an auth token from
    // reading as a replayed one. Never narrow this back to two cookies.
    expect(client().getVoyagerHeaders()['cookie']).toBe(
      'li_at=AQEDA-token; JSESSIONID="ajax:1"; bcookie=v=2&abc; ' +
        'bscookie=v=1&def; lidc=b=OB01:s=O; li_rm=AQE-rm',
    );
  });

  it('reads the CSRF token live, so a rotation is picked up mid-session', () => {
    // JSESSIONID *is* the CSRF token and LinkedIn rotates it during normal
    // use. Snapshotting it at construction is what produced the 403s.
    const j = jar();
    const c = new VoyagerClient({ jar: j });
    expect(c.getVoyagerHeaders()['csrf-token']).toBe('ajax:1');

    j.absorb(['JSESSIONID="ajax:2"; Path=/; Domain=.linkedin.com']);

    expect(c.getVoyagerHeaders()['csrf-token']).toBe('ajax:2');
    expect(c.getVoyagerHeaders()['cookie']).toContain('JSESSIONID="ajax:2"');
  });

  it('hands back the live jar so a caller can persist it', () => {
    const j = jar();
    expect(new VoyagerClient({ jar: j }).getJar()).toBe(j);
    expect(new VoyagerClient({ csrfToken: 'ajax:1' }).getJar()).toBeUndefined();
  });
});

describe('request handling in jar mode', () => {
  afterEach(() => vi.unstubAllGlobals());

  const respond = (
    init: { status?: number; body?: string; headers?: [string, string][] } = {},
  ) => {
    const headers = new Headers(init.headers ?? []);
    headers.set('content-type', 'application/json');
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(init.body ?? '{"ok":true}', {
          status: init.status ?? 200,
          headers,
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  };

  /** The RequestInit the client actually passed to fetch on its first call. */
  const initOf = (fetchMock: ReturnType<typeof respond>): RequestInit =>
    fetchMock.mock.calls[0][1] ?? {};

  it('never follows a redirect — a 302 is how a dead session looks', async () => {
    const fetchMock = respond();
    await new VoyagerClient({ jar: jar() }).voyagerGet('/me');
    expect(initOf(fetchMock)).toMatchObject({ redirect: 'manual' });
  });

  it('absorbs Set-Cookie so the next call carries the rotated value', async () => {
    respond({
      headers: [['set-cookie', 'lidc="b=OB01:s=O:r=NEW"; Path=/']],
    });
    const j = jar();
    await new VoyagerClient({ jar: j }).voyagerGet('/me');
    expect(j.get('lidc')).toBe('"b=OB01:s=O:r=NEW"');
  });

  it('treats an expired auth cookie as fatal, whatever the status', async () => {
    respond({
      status: 302,
      headers: [
        ['set-cookie', 'li_at=delete me; Max-Age=0'],
        ['location', 'https://www.linkedin.com/voyager/api/me'],
      ],
    });
    const client = new VoyagerClient({ jar: jar() });
    await expect(client.voyagerGet('/me')).rejects.toThrow(
      LinkedInSessionError,
    );
    expect(client.sessionDead).toBe(true);
  });

  it('does not write "delete me" into the jar', async () => {
    respond({
      status: 302,
      headers: [['set-cookie', 'li_at=delete me; Max-Age=0']],
    });
    const j = jar();
    await new VoyagerClient({ jar: j }).voyagerGet('/me').catch(() => {});
    expect(j.get('li_at')).toBeUndefined();
  });

  it('rejects an HTML body behind a 200 — that is an auth wall', async () => {
    respond({ body: '<!DOCTYPE html><html>...' });
    await expect(
      new VoyagerClient({ jar: jar() }).voyagerGet('/me'),
    ).rejects.toThrow('auth wall behind a 200');
  });

  it('does not retry a dead session', async () => {
    // Retrying burns the rate budget and can turn a soft block into a hard one.
    const fetchMock = respond({ status: 401 });
    await expect(
      new VoyagerClient({ jar: jar() }).voyagerGet('/me'),
    ).rejects.toThrow(LinkedInSessionError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not retry a 404 either', async () => {
    const fetchMock = respond({ status: 404 });
    await expect(
      new VoyagerClient({ jar: jar() }).voyagerGet('/nope'),
    ).rejects.toThrow('→ 404');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('sends the browser its own cookies in browser mode', async () => {
    const fetchMock = respond();
    await new VoyagerClient({ csrfToken: 'ajax:1' }).voyagerGet('/me');
    const init = initOf(fetchMock);
    expect(init.credentials).toBe('same-origin');
    expect(init.redirect).toBeUndefined();
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
