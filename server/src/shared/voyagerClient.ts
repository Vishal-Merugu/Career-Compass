import { withRetry } from './resilience.js';
import { delay } from './rateLimiter.js';
import { IVoyagerClient } from './types.js';
import { CookieJar, classifyFatal } from './cookieJar.js';
import { AppError, LinkedInSessionError } from '../errors/AppError.js';

const VOYAGER_BASE = 'https://www.linkedin.com/voyager/api';

/**
 * How the client authenticates.
 *
 * `jar` — server-side. The full exported cookie set, live CSRF, Set-Cookie
 * absorbed on every response. This is the only supported server-side mode; the
 * old `li_at` + `JSESSIONID` pair is gone (docs/adr/0002-full-cookie-jar.md).
 *
 * `csrfToken` — browser-side, for a caller running on linkedin.com where the
 * browser attaches the cookies itself and only the CSRF header is needed. The
 * extension has its own hand-mirrored copy in `extension/services/`, which
 * reads JSESSIONID from `chrome.cookies`; this branch exists for parity.
 */
export type IVoyagerSession =
  | { jar: CookieJar; csrfToken?: undefined }
  | { csrfToken: string; jar?: undefined };

export class VoyagerClient implements IVoyagerClient {
  private jar?: CookieJar;
  private csrfToken?: string;

  /** Set once a response proves the session is dead. Never unset. */
  public sessionDead = false;

  constructor(session: IVoyagerSession) {
    if (session.jar) {
      if (!session.jar.csrf()) {
        throw new LinkedInSessionError(
          'VoyagerClient: cookie jar has no JSESSIONID (the CSRF token)',
        );
      }
      const missing = session.jar.missingCritical();
      if (missing.length) {
        throw new LinkedInSessionError(
          `VoyagerClient: cookie jar is missing ${missing.join(', ')} — ` +
            'an auth token without the browser-identity cookies reads as a stolen session',
        );
      }
      this.jar = session.jar;
      return;
    }
    if (!session.csrfToken) {
      throw new LinkedInSessionError(
        'VoyagerClient: csrfToken (JSESSIONID) is required',
      );
    }
    this.csrfToken = session.csrfToken.replace(/"/g, '');
  }

  /** The live cookie jar, so a caller can persist it. Undefined in browser mode. */
  public getJar(): CookieJar | undefined {
    return this.jar;
  }

  /**
   * Get request headers with appropriate tokens and optional cookie payloads.
   *
   * In jar mode the CSRF token and the Cookie header are read from the jar on
   * every call: LinkedIn rotates JSESSIONID and lidc during normal use, and a
   * token snapshotted at construction goes stale at the first rotation.
   */
  public getVoyagerHeaders(accept?: string): Record<string, string> {
    const headers: Record<string, string> = {
      'csrf-token': this.jar ? this.jar.csrf() : (this.csrfToken ?? ''),
      'x-restli-protocol-version': '2.0.0',
      'x-li-lang': 'en_US',
      'x-li-track': JSON.stringify({
        clientVersion: '1.13.42510',
        mpVersion: '1.13.42510',
        osName: 'web',
        timezoneOffset: this.jar
          ? this.jar.timezoneOffset
          : -(new Date().getTimezoneOffset() / 60),
        deviceFormFactor: 'DESKTOP',
        mpName: 'voyager-web',
      }),
      'user-agent':
        this.jar?.userAgent ??
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      referer: 'https://www.linkedin.com/',
    };

    if (accept) {
      headers['accept'] = accept;
    } else {
      headers['accept'] = 'application/vnd.linkedin.normalized+json+2.1';
    }

    if (this.jar) {
      headers['cookie'] = this.jar.header();
      headers['referer'] = 'https://www.linkedin.com/feed/';
      headers['accept-language'] = 'en-US,en;q=0.9';
    }

    return headers;
  }

  /**
   * Validate LinkedIn session is still active
   */
  public async isLinkedInLoggedIn(): Promise<boolean> {
    try {
      await this._send(
        'GET',
        'https://www.linkedin.com/voyager/uas/authenticate',
      );
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Low-level fetch: human-like delay, then a request whose response is judged
   * before its body is handed back.
   *
   * `redirect: 'manual'` is load-bearing in jar mode. A dead session answers
   * with a 302 to the same URL carrying `li_at=…; Max-Age=0`; following it
   * turns that into a 200 with an HTML body and hides the kill entirely.
   */
  private async _send(
    method: string,
    url: string,
    opts: { accept?: string; body?: unknown } = {},
  ): Promise<{ status: number; text: string; contentType: string }> {
    await delay(1500, 3700);

    const headers = this.getVoyagerHeaders(opts.accept);
    const init: RequestInit = { method, headers };
    if (opts.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(opts.body);
    }
    if (this.jar) {
      init.redirect = 'manual';
    } else {
      init.credentials = 'same-origin';
    }

    const res = await fetch(url, init);
    const text = await res.text().catch(() => '');

    if (this.jar) {
      const { cleared } = this.jar.absorb(readSetCookie(res.headers));
      const fatal = classifyFatal(
        res.status,
        res.headers.get('location') ?? '',
        text,
        cleared,
      );
      if (fatal) {
        // Latched, so the caller knows never to write this jar back over a
        // good export — see docs/adr/0002-full-cookie-jar.md.
        this.sessionDead = true;
        throw new LinkedInSessionError(fatal);
      }
    }

    if (res.status < 200 || res.status >= 300) {
      throw new AppError(
        `Voyager ${method} ${url.replace(VOYAGER_BASE, '')} → ${res.status}: ${text.slice(0, 200)}`,
        502,
        undefined,
        { status: res.status },
      );
    }

    return {
      status: res.status,
      text,
      contentType: res.headers.get('content-type') ?? '',
    };
  }

  private _isRetryable(error: unknown): boolean {
    // A dead session is not a blip. Retrying it burns the rate budget and can
    // turn a soft block into a hard one.
    if (error instanceof LinkedInSessionError) return false;
    if (error instanceof AppError) {
      const status = (error.details as { status?: number } | undefined)?.status;
      if (typeof status !== 'number') return false;
      return status === 429 || status >= 500;
    }
    return true; // network error, retry
  }

  /**
   * Perform GET request
   */
  public async voyagerGet(endpoint: string, accept?: string): Promise<any> {
    return withRetry(
      async () => {
        const { text } = await this._send('GET', VOYAGER_BASE + endpoint, {
          accept,
        });
        return JSON.parse(text);
      },
      {
        maxRetries: 3,
        baseDelayMs: 5000,
        backoffFactor: 1.5,
        label: `GET ${endpoint.split('?')[0]}`,
        shouldRetry: this._isRetryable,
      },
    );
  }

  /**
   * Perform POST request
   */
  public async voyagerPost(
    endpoint: string,
    body: any,
    accept?: string,
  ): Promise<any> {
    return withRetry(
      async () => {
        const res = await this._send('POST', VOYAGER_BASE + endpoint, {
          accept,
          body,
        });
        if (res.contentType.includes('json')) return JSON.parse(res.text);
        return { status: res.status };
      },
      {
        maxRetries: 3,
        baseDelayMs: 5000,
        backoffFactor: 1.5,
        label: `POST ${endpoint.split('?')[0]}`,
        shouldRetry: this._isRetryable,
      },
    );
  }

  /**
   * Perform DELETE request
   */
  public async voyagerDelete(endpoint: string): Promise<any> {
    return withRetry(
      async () => {
        const { status } = await this._send('DELETE', VOYAGER_BASE + endpoint);
        return { status };
      },
      {
        maxRetries: 2,
        baseDelayMs: 5000,
        backoffFactor: 1.5,
        label: `DELETE ${endpoint.split('?')[0]}`,
        shouldRetry: this._isRetryable,
      },
    );
  }

  /**
   * Search Jobs by keywords and location
   */
  public async searchJobs(
    keywords: string,
    location: string,
    start = 0,
    count = 25,
  ): Promise<any> {
    const params = new URLSearchParams({
      decorationId:
        'com.linkedin.voyager.dash.deco.jobs.search.JobSearchCardsCollection-220',
      count: String(count),
      q: 'jobSearch',
      start: String(start),
    });

    const isGeoId = /^\d+$/.test(location);
    const locationPart = isGeoId
      ? `geoId:${location}`
      : `seoLocation:(location:${encodeURIComponent(location)})`;

    const queryStr = `keywords:${encodeURIComponent(keywords)},locationUnion:(${locationPart}),spellCorrectionEnabled:true`;
    const endpoint = `/voyagerJobsDashJobCards?${params.toString()}&query=(origin:JOB_SEARCH_PAGE_OTHER_ENTRY,${queryStr})`;
    return this.voyagerGet(
      endpoint,
      'application/vnd.linkedin.normalized+json+2.1',
    );
  }

  /**
   * Resolve company from universal name / slug
   */
  public async resolveCompany(universalName: string): Promise<any> {
    const endpoint = `/organization/companies?decorationId=com.linkedin.voyager.deco.organization.web.WebFullCompanyMain-12&q=universalName&universalName=${encodeURIComponent(universalName)}`;
    return this.voyagerGet(endpoint);
  }

  /**
   * Resolve company from URN ID
   */
  public async getCompanyById(companyId: string): Promise<any> {
    const endpoint = `/organization/companies/${companyId}`;
    return this.voyagerGet(endpoint, 'application/json');
  }

  /**
   * Search people at a company
   */
  public async searchPeople(
    companyId: string,
    geoId = '101282230',
    start = 0,
    count = 12,
  ): Promise<any> {
    const variables = `(start:${start},origin:FACETED_SEARCH,query:(flagshipSearchIntent:ORGANIZATIONS_PEOPLE_ALUMNI,queryParameters:List((key:currentCompany,value:List(${companyId})),(key:geoUrn,value:List(${geoId})),(key:resultType,value:List(ORGANIZATION_ALUMNI))),includeFiltersInResponse:true),count:${count})`;
    const endpoint = `/graphql?variables=${variables}&queryId=voyagerSearchDashClusters.843215f2a3455f1bed85762a45d71be8`;
    return this.voyagerGet(
      endpoint,
      'application/vnd.linkedin.normalized+json+2.1',
    );
  }

  /**
   * Fetch full profile by member identity
   */
  public async fetchProfile(memberIdentity: string): Promise<any> {
    const endpoint = `/identity/dash/profiles?q=memberIdentity&memberIdentity=${encodeURIComponent(memberIdentity)}&decorationId=com.linkedin.voyager.dash.deco.identity.profile.WebTopCardCore-3`;
    return this.voyagerGet(endpoint);
  }

  /**
   * Get full detailed profile
   */
  public async fetchFullProfile(memberIdentity: string): Promise<any> {
    const endpoint = `/identity/dash/profiles?q=memberIdentity&memberIdentity=${encodeURIComponent(memberIdentity)}&decorationId=com.linkedin.voyager.dash.deco.identity.profile.FullProfileWithEntities-93`;
    return this.voyagerGet(endpoint);
  }

  /**
   * Check connection status / relationship
   */
  public async checkRelationship(profileId: string): Promise<any> {
    const variables = `(vanityName:${profileId})`;
    const endpoint = `/graphql?variables=${variables}&queryId=voyagerIdentityDashProfiles.34ead06db82a2cc9a778fac97f69ad6a`;
    return this.voyagerGet(
      endpoint,
      'application/vnd.linkedin.normalized+json+2.1',
    );
  }

  /**
   * Send connection request with personalized note
   */
  public async sendConnectionRequest(
    memberId: string,
    message?: string,
  ): Promise<any> {
    const profileUrn = `urn:li:fsd_profile:${memberId}`;
    const payload: Record<string, any> = {
      invitee: {
        inviteeUnion: {
          memberProfile: profileUrn,
        },
      },
    };
    if (message?.trim()) {
      payload.customMessage = message.trim();
    }

    const endpoint =
      '/voyagerRelationshipsDashMemberRelationships?action=verifyQuotaAndCreateV2&decorationId=com.linkedin.voyager.dash.deco.relationships.InvitationCreationResultWithInvitee-2';
    return this.voyagerPost(endpoint, payload);
  }

  /**
   * Withdraw a pending invitation
   */
  public async withdrawInvitation(invitationId: string): Promise<any> {
    const endpoint = `/growth/normInvitations/${invitationId}`;
    return this.voyagerDelete(endpoint);
  }
}

/**
 * Read every Set-Cookie line off a response.
 *
 * `Headers.getSetCookie()` is the only accessor that does not fold repeated
 * Set-Cookie headers into one comma-joined string — folding them corrupts the
 * `Expires=Thu, 01-Jan-1970` dates that signal a killed session. It is present
 * in Node 18.14+ and every browser the extension targets; the fallback exists
 * so an older runtime degrades to "no rotation seen" rather than throwing.
 */
function readSetCookie(headers: Headers): string[] {
  if (typeof headers.getSetCookie === 'function') return headers.getSetCookie();
  const single = headers.get('set-cookie');
  return single ? [single] : [];
}

/**
 * Generate a random tracking ID for LinkedIn telemetry requests
 */
export function generateTrackingId(): string {
  const bytes = new Uint8Array(16);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i++) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64');
  } else {
    return btoa(String.fromCharCode(...bytes));
  }
}

/**
 * Extract company slug/universalName from a LinkedIn company URL.
 */
export function parseCompanyUrl(url?: string | null): string | null {
  if (!url) return null;
  let cleanUrl = url.trim();

  if (!/^https?:\/\//i.test(cleanUrl)) {
    cleanUrl = 'https://' + cleanUrl;
  }

  try {
    const parsed = new URL(cleanUrl);
    const parts = parsed.pathname.split('/').filter(Boolean);
    const companyIdx = parts.indexOf('company');
    if (companyIdx !== -1 && parts[companyIdx + 1]) {
      return parts[companyIdx + 1];
    }
    if (parts.length > 0) {
      return parts[parts.length - 1];
    }
    return null;
  } catch {
    const match = cleanUrl.match(/\/company\/([^\/\?#]+)/i);
    if (match && match[1]) {
      return match[1];
    }
    return url.trim() || null;
  }
}
