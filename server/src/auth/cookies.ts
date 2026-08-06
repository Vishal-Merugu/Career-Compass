import type { Response } from 'express';
import { env } from '../config/env.js';

/**
 * Name of the httpOnly cookie carrying the browser session JWT.
 *
 * The web dashboard authenticates with this; the Chrome extension keeps using
 * `x-api-key`. Two independent credentials on purpose — see
 * docs/adr/0004-same-origin-web-dashboard.md.
 */
export const SESSION_COOKIE = 'cc_session';

/** Matches the JWT lifetime so the cookie never outlives the token it carries. */
const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Issue the browser session cookie.
 *
 * httpOnly so JavaScript cannot read it — a token in localStorage is readable by
 * any XSS, and this app can control a real LinkedIn account.
 *
 * `sameSite: 'lax'` is the CSRF defence. It is sufficient here because the
 * dashboard is served same-origin with the API, so no cross-site request ever
 * legitimately carries this cookie.
 *
 * `secure` only in production: the VM currently serves plain HTTP over the
 * university network, and a `secure` cookie would simply never be stored there.
 */
export function setSessionCookie(res: Response, token: string): void {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: env.NODE_ENV === 'production' && process.env.HTTPS === 'true',
    maxAge: SESSION_MAX_AGE_MS,
    path: '/',
  });
}

/** Clear the session cookie. Options must match those used to set it. */
export function clearSessionCookie(res: Response): void {
  res.clearCookie(SESSION_COOKIE, { path: '/', sameSite: 'lax' });
}
