import { describe, it, expect } from 'vitest';
import {
  CookieJar,
  classifyFatal,
  type CookieExport,
} from './scratch-voyager-probe.js';

const exported = (
  cookies: Record<string, string>,
  extra: Partial<CookieExport> = {},
): CookieExport => ({
  cookies,
  userAgent: 'Mozilla/5.0 (Macintosh) Chrome/120.0.0.0',
  ...extra,
});

const liveJar = () =>
  new CookieJar(
    exported({
      li_at: 'AQEDA-real-token',
      JSESSIONID: '"ajax:1"',
      bcookie: '"v=2&abc"',
      lidc: 'b=OB01:s=O',
      li_rm: 'AQE-remember',
    }),
  );

describe('CookieJar basics', () => {
  it('exposes JSESSIONID as the CSRF token with quotes stripped', () => {
    expect(liveJar().csrf()).toBe('ajax:1');
  });

  it('returns an empty CSRF token when JSESSIONID is absent', () => {
    expect(new CookieJar(exported({ li_at: 'x' })).csrf()).toBe('');
  });

  it('serialises the whole jar into one Cookie header', () => {
    const jar = new CookieJar(
      exported({ li_at: 'token', JSESSIONID: '"ajax:1"' }),
    );
    expect(jar.header()).toBe('li_at=token; JSESSIONID="ajax:1"');
  });

  it('reports missing critical cookies', () => {
    // li_at alone is not a session — the risk engine wants browser identity too.
    expect(
      new CookieJar(exported({ li_at: 'token' })).missingCritical(),
    ).toEqual(['JSESSIONID', 'bcookie', 'lidc']);
    expect(liveJar().missingCritical()).toEqual([]);
  });

  it('defaults the timezone offset when the export omits it', () => {
    expect(new CookieJar(exported({})).timezoneOffset).toBe(5.5);
    expect(
      new CookieJar(exported({}, { timezoneOffset: 2 })).timezoneOffset,
    ).toBe(2);
  });
});

describe('CookieJar.absorb — rotation', () => {
  it('records a changed value as a rotation', () => {
    const jar = liveJar();
    const { rotated, cleared } = jar.absorb([
      'JSESSIONID="ajax:2"; Path=/; Domain=.linkedin.com; Secure',
    ]);

    expect(rotated).toEqual(['JSESSIONID']);
    expect(cleared).toEqual([]);
    // Read live, not frozen at construction — this is what fixed the 403s.
    expect(jar.csrf()).toBe('ajax:2');
  });

  it('does not report an unchanged value as a rotation', () => {
    const jar = liveJar();
    expect(jar.absorb(['lidc=b=OB01:s=O; Path=/']).rotated).toEqual([]);
  });

  it('adds a brand-new cookie without calling it a rotation', () => {
    const jar = liveJar();
    const { rotated } = jar.absorb(['__cf_bm=fresh-token; Max-Age=1800']);
    expect(rotated).toEqual([]);
    expect(jar.get('__cf_bm')).toBe('fresh-token');
  });

  it('ignores blank and malformed Set-Cookie entries', () => {
    const jar = liveJar();
    const before = jar.header();
    const { rotated, cleared } = jar.absorb([
      'lidc=; Path=/', // empty value
      'bcookie=""; Path=/', // quoted-empty value
      'garbage-with-no-equals', // unparseable
      '=novalue; Path=/', // no name
    ]);

    expect(rotated).toEqual([]);
    expect(cleared).toEqual([]);
    expect(jar.header()).toBe(before);
  });

  it('keeps a cookie whose Expires is in the future', () => {
    const jar = liveJar();
    const future = new Date(Date.now() + 86_400_000).toUTCString();
    const { rotated, cleared } = jar.absorb([
      `li_at=AQEDA-rotated; Expires=${future}; Path=/`,
    ]);

    expect(cleared).toEqual([]);
    expect(rotated).toEqual(['li_at']);
    expect(jar.get('li_at')).toBe('AQEDA-rotated');
  });
});

describe('CookieJar.absorb — expiry detection', () => {
  // The bug this guards: LinkedIn kills a session by *expiring* cookies, and
  // the expiry carries a junk value. Sniffing the value writes the literal
  // string "delete me" into the jar and corrupts the saved export.
  const KILL =
    'li_at=delete me; Expires=Thu, 01 Jan 1970 00:00:10 GMT; Max-Age=0; Path=/; Domain=.www.linkedin.com';

  it('treats Max-Age=0 as expiry, not as a value rotation', () => {
    const jar = liveJar();
    const { rotated, cleared } = jar.absorb([KILL]);

    expect(cleared).toEqual(['li_at']);
    expect(rotated).toEqual([]);
    expect(jar.get('li_at')).toBeUndefined();
    expect(jar.header()).not.toContain('delete me');
  });

  it('treats a past Expires as expiry even without Max-Age', () => {
    const jar = liveJar();
    const { cleared } = jar.absorb([
      'li_at=delete me; Expires=Thu, 01 Jan 1970 00:00:10 GMT; Path=/',
    ]);
    expect(cleared).toEqual(['li_at']);
    expect(jar.get('li_at')).toBeUndefined();
  });

  it('treats a negative Max-Age as expiry', () => {
    const jar = liveJar();
    expect(jar.absorb(['li_at=delete me; Max-Age=-1']).cleared).toEqual([
      'li_at',
    ]);
  });

  it('does not report a cookie that was never in the jar as cleared', () => {
    const jar = new CookieJar(exported({ JSESSIONID: '"ajax:1"' }));
    expect(jar.absorb([KILL]).cleared).toEqual([]);
  });

  it('ignores an unparseable Expires rather than dropping the cookie', () => {
    const jar = liveJar();
    const { cleared } = jar.absorb(['li_at=still-good; Expires=not-a-date']);
    expect(cleared).toEqual([]);
    expect(jar.get('li_at')).toBe('still-good');
  });

  it('handles a mixed batch of rotations and kills', () => {
    const jar = liveJar();
    const { rotated, cleared } = jar.absorb([
      'JSESSIONID="ajax:3"; Path=/',
      KILL,
      'lidc=b=OB02:s=O; Path=/',
    ]);

    expect(rotated.sort()).toEqual(['JSESSIONID', 'lidc']);
    expect(cleared).toEqual(['li_at']);
    expect(jar.missingCritical()).toEqual(['li_at']);
  });
});

describe('classifyFatal', () => {
  it('returns null for a healthy response', () => {
    expect(classifyFatal(200, '', '{"data":{}}', [])).toBeNull();
  });

  it('returns null for a rate limit — throttled is not dead', () => {
    expect(classifyFatal(429, '', 'slow down', [])).toBeNull();
  });

  it('reports an expired auth cookie ahead of the status code', () => {
    // Rides on a 302, so it must be checked before the redirect branch.
    const fatal = classifyFatal(302, '', '', ['li_at', 'lidc']);
    expect(fatal).toBe(
      'Server expired auth cookie(s): li_at — session rejected',
    );
  });

  it('recognises liap and li_a as auth cookies too', () => {
    expect(classifyFatal(200, '', '', ['liap'])).toContain('liap');
    expect(classifyFatal(200, '', '', ['li_a'])).toContain('li_a');
  });

  it('does not treat a cleared non-auth cookie as fatal', () => {
    expect(classifyFatal(200, '', '{}', ['lidc', 'bcookie'])).toBeNull();
  });

  it('reports a 401', () => {
    expect(classifyFatal(401, '', '', [])).toBe('HTTP 401 — session rejected');
  });

  it('names the destination when redirected to login or a checkpoint', () => {
    expect(
      classifyFatal(302, 'https://www.linkedin.com/uas/login', '', []),
    ).toContain('Redirected to login/checkpoint');
    expect(
      classifyFatal(
        302,
        'https://www.linkedin.com/checkpoint/challenge',
        '',
        [],
      ),
    ).toContain('Redirected to login/checkpoint');
    expect(
      classifyFatal(302, 'https://www.linkedin.com/authwall', '', []),
    ).toContain('Redirected to login/checkpoint');
  });

  it('treats a bare self-redirect as fatal — Voyager never redirects', () => {
    const fatal = classifyFatal(
      302,
      'https://www.linkedin.com/voyager/api/me',
      '',
      [],
    );
    expect(fatal).toContain('HTTP 302 — Voyager redirected');
  });

  it('separates a CSRF rejection from a generic block on a 403', () => {
    expect(classifyFatal(403, '', '{"message":"CSRF check failed"}', [])).toBe(
      'HTTP 403 — CSRF token rejected',
    );
    expect(classifyFatal(403, '', 'Forbidden', [])).toBe(
      'HTTP 403 — blocked (rate/bot detection or dead session)',
    );
  });

  it('recognises the 999 bot wall', () => {
    expect(classifyFatal(999, '', '', [])).toBe('HTTP 999 — LinkedIn bot wall');
  });
});
