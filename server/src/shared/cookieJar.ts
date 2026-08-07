// ─── LinkedIn cookie jar ─────────────────────────────────────────
// Server-side session handling for anything that talks to Voyager from Node.
//
// The design this replaced hand-built a two-cookie header and froze the CSRF
// token at construction. That fails three ways: LinkedIn's risk engine expects
// the browser-identity cookies too, JSESSIONID rotates and *is* the CSRF token,
// and a killed session arrives as expired cookies on a self-redirect rather
// than as a login page. See docs/adr/0002-full-cookie-jar.md.
//
// Proven by `scratch-voyager-probe.ts`, which is now a thin driver over this.
// No file I/O here — persistence is the caller's decision, because a jar must
// never be written back after a fatal response.

/** Cookies LinkedIn's risk engine expects to see on a real session. */
export const CRITICAL_COOKIES = ['li_at', 'JSESSIONID', 'bcookie', 'lidc'];

/** Cookies whose removal by the server means the session is over. */
export const AUTH_COOKIES = ['li_at', 'liap', 'li_a'];

export interface CookieExport {
  cookies: Record<string, string>;
  userAgent: string;
  timezoneOffset?: number;
  exportedAt?: string;
}

export class CookieJar {
  private jar: Map<string, string>;
  public userAgent: string;
  public timezoneOffset: number;

  constructor(exported: CookieExport) {
    this.jar = new Map(Object.entries(exported.cookies));
    this.userAgent = exported.userAgent;
    this.timezoneOffset = exported.timezoneOffset ?? 5.5;
  }

  get(name: string): string | undefined {
    return this.jar.get(name);
  }

  /** JSESSIONID doubles as the CSRF token, quotes stripped. */
  csrf(): string {
    return (this.jar.get('JSESSIONID') ?? '').replace(/"/g, '');
  }

  header(): string {
    return [...this.jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  /**
   * Absorb Set-Cookie from a response.
   *
   * LinkedIn kills a session by *expiring* cookies, not by omitting them:
   *   set-cookie: li_at=delete me; Expires=Thu, 01-Jan-1970...; Max-Age=0
   * Treating that as a value rotation writes the literal string "delete me"
   * into the jar and corrupts the export, so expiry is detected by attribute
   * (Max-Age=0 / past Expires), never by sniffing the value.
   */
  absorb(setCookies: string[]): { rotated: string[]; cleared: string[] } {
    const rotated: string[] = [];
    const cleared: string[] = [];

    for (const raw of setCookies) {
      const [pair, ...attrs] = raw.split(';');
      const idx = pair.indexOf('=');
      if (idx < 1) continue;
      const name = pair.slice(0, idx).trim();
      const value = pair.slice(idx + 1).trim();

      let expired = false;
      for (const attr of attrs) {
        const [k, v = ''] = attr.split('=').map((s) => s.trim());
        if (/^max-age$/i.test(k) && Number(v) <= 0) expired = true;
        if (/^expires$/i.test(k)) {
          const t = Date.parse(v);
          if (!Number.isNaN(t) && t <= Date.now()) expired = true;
        }
      }

      if (expired) {
        if (this.jar.delete(name)) cleared.push(name);
        continue;
      }
      if (!value || value === '""') continue;
      if (this.jar.get(name) !== value) {
        if (this.jar.has(name)) rotated.push(name);
        this.jar.set(name, value);
      }
    }
    return { rotated, cleared };
  }

  /** Snapshot for persistence. The caller decides whether it is safe to write. */
  toExport(source: CookieExport): CookieExport {
    return {
      ...source,
      cookies: Object.fromEntries(this.jar),
      exportedAt: source.exportedAt,
    };
  }

  missingCritical(): string[] {
    return CRITICAL_COOKIES.filter((c) => !this.jar.get(c));
  }
}

/**
 * Decide whether a Voyager response means the session is dead.
 *
 * Returns a human-readable reason, or null when the response is survivable
 * (including a 429 — rate limiting is not session death).
 */
export function classifyFatal(
  status: number,
  location: string,
  body: string,
  cleared: string[],
): string | null {
  // Strongest signal, and the one the self-test surfaced: LinkedIn expires the
  // auth cookies outright. Check before status, since it rides on a 302.
  const killedAuth = cleared.filter((c) => AUTH_COOKIES.includes(c));
  if (killedAuth.length)
    return `Server expired auth cookie(s): ${killedAuth.join(', ')} — session rejected`;

  if (status === 401) return 'HTTP 401 — session rejected';
  if (/\/uas\/login|\/checkpoint\/|session_redirect|authwall/.test(location))
    return `Redirected to login/checkpoint (${location.slice(0, 80)})`;
  // The Voyager API never legitimately redirects. A bare 3xx — including the
  // self-redirect to the same URL that a dead session produces — is fatal.
  if (status >= 300 && status < 400)
    return `HTTP ${status} — Voyager redirected (${location.slice(0, 60) || 'no location'}); API never does this on a live session`;
  if (status === 403) {
    if (/csrf/i.test(body)) return 'HTTP 403 — CSRF token rejected';
    return 'HTTP 403 — blocked (rate/bot detection or dead session)';
  }
  if (status === 999) return 'HTTP 999 — LinkedIn bot wall';
  // A 200 whose body is HTML is a login page served behind a success status.
  if (status >= 200 && status < 300 && /^\s*</.test(body))
    return 'HTTP 200 but HTML body — auth wall behind a 200';
  return null;
}
