import { withRetry } from './resilience.js';
import { delay } from './rateLimiter.js';
import { IVoyagerClient } from './types.js';

const VOYAGER_BASE = 'https://www.linkedin.com/voyager/api';

export interface IVoyagerSession {
  csrfToken: string;
  liAtCookie?: string;
}

export class VoyagerClient implements IVoyagerClient {
  private csrfToken: string;
  private liAtCookie?: string;

  constructor(session: IVoyagerSession) {
    if (!session.csrfToken) {
      throw new Error('VoyagerClient: csrfToken (JSESSIONID) is required');
    }
    this.csrfToken = session.csrfToken.replace(/"/g, '');
    this.liAtCookie = session.liAtCookie;
  }

  /**
   * Get request headers with appropriate tokens and optional cookie payloads
   */
  public getVoyagerHeaders(accept?: string): Record<string, string> {
    const headers: Record<string, string> = {
      'csrf-token': this.csrfToken,
      'x-restli-protocol-version': '2.0.0',
      'x-li-lang': 'en_US',
      'x-li-track': JSON.stringify({
        clientVersion: '1.13.42510',
        mpVersion: '1.13.42510',
        osName: 'web',
        timezoneOffset: 5.5,
        deviceFormFactor: 'DESKTOP',
        mpName: 'voyager-web',
      }),
      'user-agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      referer: 'https://www.linkedin.com/',
    };

    if (accept) {
      headers['accept'] = accept;
    } else {
      headers['accept'] = 'application/vnd.linkedin.normalized+json+2.1';
    }

    if (this.liAtCookie) {
      headers['cookie'] =
        `li_at=${this.liAtCookie}; JSESSIONID="${this.csrfToken}"`;
    }

    return headers;
  }

  /**
   * Validate LinkedIn session is still active
   */
  public async isLinkedInLoggedIn(): Promise<boolean> {
    try {
      const headers = this.getVoyagerHeaders();
      const fetchOpts: RequestInit = {
        method: 'GET',
        headers,
      };
      if (!this.liAtCookie) {
        fetchOpts.credentials = 'same-origin';
      }
      const res = await fetch(
        'https://www.linkedin.com/voyager/uas/authenticate',
        fetchOpts,
      );
      return !res.redirected && res.status === 200;
    } catch {
      return false;
    }
  }

  /**
   * Low-level fetch that adds human-like delay and custom credentials if running locally
   */
  private async _voyagerFetch(
    url: string,
    fetchOpts: RequestInit,
  ): Promise<Response> {
    await delay(1500, 3700);
    if (!this.liAtCookie) {
      fetchOpts.credentials = 'same-origin';
    }
    return fetch(url, fetchOpts);
  }

  private _isRetryable(error: any): boolean {
    const msg = error?.message || '';
    const match = msg.match(/→ (\d{3})/);
    if (!match) return true; // network error, retry
    const code = parseInt(match[1], 10);
    return code === 429 || code >= 500;
  }

  /**
   * Perform GET request
   */
  public async voyagerGet(endpoint: string, accept?: string): Promise<any> {
    return withRetry(
      async () => {
        const headers = this.getVoyagerHeaders(accept);
        const res = await this._voyagerFetch(VOYAGER_BASE + endpoint, {
          method: 'GET',
          headers,
        });
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          throw new Error(
            `Voyager GET ${endpoint} → ${res.status}: ${text.slice(0, 200)}`,
          );
        }
        return res.json();
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
        const headers = this.getVoyagerHeaders(accept);
        headers['Content-Type'] = 'application/json';
        const res = await this._voyagerFetch(VOYAGER_BASE + endpoint, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          throw new Error(
            `Voyager POST ${endpoint} → ${res.status}: ${text.slice(0, 200)}`,
          );
        }
        const contentType = res.headers.get('content-type') || '';
        if (contentType.includes('json')) return res.json();
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
        const headers = this.getVoyagerHeaders();
        const res = await this._voyagerFetch(VOYAGER_BASE + endpoint, {
          method: 'DELETE',
          headers,
        });
        if (!res.ok) {
          throw new Error(`Voyager DELETE ${endpoint} → ${res.status}`);
        }
        return { status: res.status };
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
