import { describe, it, expect } from 'vitest';
import type { Request } from 'express';
import { extractSessionToken } from './middleware.js';
import { SESSION_COOKIE } from './cookies.js';

const req = (
  headers: Record<string, string> = {},
  cookies?: Record<string, string>,
): Request => ({ headers, cookies }) as unknown as Request;

describe('extractSessionToken', () => {
  it('reads a Bearer token from the Authorization header', () => {
    expect(
      extractSessionToken(req({ authorization: 'Bearer abc.def.ghi' })),
    ).toBe('abc.def.ghi');
  });

  it('reads the httpOnly session cookie', () => {
    expect(
      extractSessionToken(req({}, { [SESSION_COOKIE]: 'cookie.jwt.value' })),
    ).toBe('cookie.jwt.value');
  });

  it('prefers the Authorization header over the cookie', () => {
    // A script passing an explicit token should win over whatever the browser
    // happens to have stored.
    expect(
      extractSessionToken(
        req(
          { authorization: 'Bearer from.header' },
          { [SESSION_COOKIE]: 'from.cookie' },
        ),
      ),
    ).toBe('from.header');
  });

  it('returns null when neither is present', () => {
    expect(extractSessionToken(req())).toBeNull();
    expect(extractSessionToken(req({}, {}))).toBeNull();
  });

  it('returns null for a malformed Authorization header', () => {
    expect(
      extractSessionToken(req({ authorization: 'abc.def.ghi' })),
    ).toBeNull();
    expect(
      extractSessionToken(req({ authorization: 'Basic dXNlcjpwYXNz' })),
    ).toBeNull();
  });

  it('returns null for a Bearer header with an empty token', () => {
    // Must not return '' — an empty string would reach verifyToken and produce a
    // confusing "invalid token" instead of "no credentials".
    expect(extractSessionToken(req({ authorization: 'Bearer ' }))).toBeNull();
  });

  it('ignores unrelated cookies', () => {
    expect(extractSessionToken(req({}, { other: 'x', lang: 'en' }))).toBeNull();
  });

  it('survives a request with no cookie parser applied', () => {
    // cookieParser() runs before the routers, but a unit-level caller may not
    // have it — undefined `cookies` must not throw.
    expect(extractSessionToken({ headers: {} } as Request)).toBeNull();
  });
});
