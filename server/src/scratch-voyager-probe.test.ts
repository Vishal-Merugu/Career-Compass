import { describe, it, expect } from 'vitest';
import {
  CookieJar,
  classifyFatal,
  pick,
  normaliseEgress,
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

describe('egress field extraction', () => {
  it('reads nested paths without assuming a shape', () => {
    const body = { asn: { org: 'AS680 DFN' }, location: { city: 'Erlangen' } };
    expect(pick(body, 'asn.org')).toBe('AS680 DFN');
    expect(pick(body, 'location.city')).toBe('Erlangen');
  });

  it('returns undefined for missing paths instead of throwing', () => {
    expect(pick({ ip: '1.2.3.4' }, 'asn.org')).toBeUndefined();
    expect(pick(null, 'ip')).toBeUndefined();
    expect(pick('not an object', 'ip')).toBeUndefined();
    expect(pick({ asn: 'a string' }, 'asn.org')).toBeUndefined();
  });

  it('stringifies numbers and booleans — providers disagree on both', () => {
    expect(pick({ asn: 680 }, 'asn')).toBe('680');
    expect(pick({ is_datacenter: false }, 'is_datacenter')).toBe('false');
  });

  it('treats blank strings as absent', () => {
    expect(pick({ city: '   ' }, 'city')).toBeUndefined();
  });
});

describe('egress normalisation', () => {
  it('keeps a result with a plausible IP and tags its source', () => {
    expect(
      normaliseEgress('ipinfo.io', {
        ip: '192.44.85.26',
        city: 'Erlangen',
        country: 'DE',
        org: 'AS680 DFN',
      }),
    ).toEqual({
      ip: '192.44.85.26',
      source: 'ipinfo.io',
      city: 'Erlangen',
      country: 'DE',
      org: 'AS680 DFN',
    });
  });

  it('accepts IPv6', () => {
    expect(normaliseEgress('geojs.io', { ip: '2a06:98c1:3109::1' })?.ip).toBe(
      '2a06:98c1:3109::1',
    );
  });

  // An error page or captive portal answers 200 with JSON that has no IP.
  // Recording `ip: "?"` from that is worse than recording nothing: the report
  // would claim the run was attributed when it wasn't.
  it('rejects a response with no usable IP', () => {
    expect(normaliseEgress('ipapi.co', {})).toBeNull();
    expect(normaliseEgress('ipapi.co', { ip: 'RateLimited' })).toBeNull();
    expect(normaliseEgress('ipapi.co', { ip: '' })).toBeNull();
  });

  it('omits fields the provider did not supply rather than filling in "?"', () => {
    const info = normaliseEgress('ifconfig.co', {
      ip: '1.2.3.4',
      org: 'AS1 X',
    });
    expect(info).toEqual({
      ip: '1.2.3.4',
      source: 'ifconfig.co',
      org: 'AS1 X',
    });
    expect(info).not.toHaveProperty('city');
  });

  it('carries the datacenter flag through — it is the risk-relevant field', () => {
    expect(
      normaliseEgress('ipapi.is', { ip: '1.2.3.4', datacenter: 'true' })
        ?.datacenter,
    ).toBe('true');
  });
});
