// ─── Voyager API Client ──────────────────────────────────────────
// Authenticated client for LinkedIn's internal Voyager API.
// All calls go through withRetry() from services/resilience.js for
// automatic retry with exponential backoff on transient failures.

const VOYAGER_BASE = 'https://www.linkedin.com/voyager/api';

// ─── Authentication ──────────────────────────────────────────────

async function getCsrfToken() {
  const cookie = await chrome.cookies.get({
    name: 'JSESSIONID',
    url: 'https://www.linkedin.com',
  });
  if (!cookie?.value) return null;
  return cookie.value.replaceAll('"', '');
}

async function getVoyagerHeaders() {
  const csrf = await getCsrfToken();
  if (!csrf)
    throw new Error('Not logged into LinkedIn — JSESSIONID cookie missing');
  return {
    'csrf-token': csrf,
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
    accept: 'application/vnd.linkedin.normalized+json+2.1',
  };
}

// ─── Session Validation ──────────────────────────────────────────

async function isLinkedInLoggedIn() {
  try {
    const csrf = await getCsrfToken();
    if (!csrf) return false;
    const res = await fetch(
      'https://www.linkedin.com/voyager/uas/authenticate',
      {
        method: 'GET',
        headers: { 'csrf-token': csrf },
        credentials: 'same-origin',
      },
    );
    return !res.url.includes('session_redirect');
  } catch {
    return false;
  }
}

// ─── Core HTTP Methods ───────────────────────────────────────────
// Built-in random delay (1.5–3.7 s) + withRetry for transient errors.

/**
 * Low-level fetch that adds the human-like delay before each request.
 * Callers should NOT add their own delay on top of this.
 */
async function _voyagerFetch(url, fetchOpts) {
  // Human-like delay to avoid 403s
  await delay(1500, 3700);
  return fetch(url, fetchOpts);
}

function _isRetryable(error) {
  const msg = error?.message || '';
  // Our errors contain "→ STATUS:" so we can extract the code
  const match = msg.match(/→ (\d{3})/);
  if (!match) return true; // network error → retry
  const code = parseInt(match[1], 10);
  return code === 429 || code >= 500;
}

async function voyagerGet(endpoint, accept) {
  return withRetry(
    async () => {
      const headers = await getVoyagerHeaders();
      if (accept) headers['accept'] = accept;
      const res = await _voyagerFetch(VOYAGER_BASE + endpoint, {
        method: 'GET',
        headers,
        credentials: 'same-origin',
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
      shouldRetry: _isRetryable,
    },
  );
}

async function voyagerPost(endpoint, body, accept) {
  return withRetry(
    async () => {
      const headers = await getVoyagerHeaders();
      headers['Content-Type'] = 'application/json';
      if (accept) headers['accept'] = accept;
      const res = await _voyagerFetch(VOYAGER_BASE + endpoint, {
        method: 'POST',
        headers,
        credentials: 'same-origin',
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
      shouldRetry: _isRetryable,
    },
  );
}

async function voyagerDelete(endpoint) {
  return withRetry(
    async () => {
      const headers = await getVoyagerHeaders();
      const res = await _voyagerFetch(VOYAGER_BASE + endpoint, {
        method: 'DELETE',
        headers,
        credentials: 'same-origin',
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
      shouldRetry: _isRetryable,
    },
  );
}

// ─── Endpoint Methods ────────────────────────────────────────────

/**
 * Search Jobs by keywords and location
 */
async function searchJobs(keywords, location, start = 0, count = 25) {
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
  return voyagerGet(endpoint, 'application/vnd.linkedin.normalized+json+2.1');
}

/**
 * Resolve company from universal name / slug
 */
async function resolveCompany(universalName) {
  const endpoint = `/organization/companies?decorationId=com.linkedin.voyager.deco.organization.web.WebFullCompanyMain-12&q=universalName&universalName=${encodeURIComponent(universalName)}`;
  return voyagerGet(endpoint);
}

/**
 * Resolve company from URN ID
 */
async function getCompanyById(companyId) {
  const endpoint = `/organization/companies/${companyId}`;
  return voyagerGet(endpoint, 'application/json');
}

/**
 * Search people at a company (ORGANIZATIONS_PEOPLE_ALUMNI — from HAR)
 */
async function searchPeople(
  companyId,
  geoId = '101282230',
  start = 0,
  count = 12,
) {
  const variables = `(start:${start},origin:FACETED_SEARCH,query:(flagshipSearchIntent:ORGANIZATIONS_PEOPLE_ALUMNI,queryParameters:List((key:currentCompany,value:List(${companyId})),(key:geoUrn,value:List(${geoId})),(key:resultType,value:List(ORGANIZATION_ALUMNI))),includeFiltersInResponse:true),count:${count})`;
  const endpoint = `/graphql?variables=${variables}&queryId=voyagerSearchDashClusters.843215f2a3455f1bed85762a45d71be8`;
  return voyagerGet(endpoint, 'application/vnd.linkedin.normalized+json+2.1');
}

/**
 * Fetch full profile by member identity (public identifier / slug)
 */
async function fetchProfile(memberIdentity) {
  const endpoint = `/identity/dash/profiles?q=memberIdentity&memberIdentity=${encodeURIComponent(memberIdentity)}&decorationId=com.linkedin.voyager.dash.deco.identity.profile.WebTopCardCore-3`;
  return voyagerGet(endpoint);
}

/**
 * Get full detailed profile
 */
async function fetchFullProfile(memberIdentity) {
  const endpoint = `/identity/dash/profiles?q=memberIdentity&memberIdentity=${encodeURIComponent(memberIdentity)}&decorationId=com.linkedin.voyager.dash.deco.identity.profile.FullProfileWithEntities-93`;
  return voyagerGet(endpoint);
}

/**
 * Check connection status / relationship
 */
async function checkRelationship(profileId) {
  const variables = `(vanityName:${profileId})`;
  const endpoint = `/graphql?variables=${variables}&queryId=voyagerIdentityDashProfiles.34ead06db82a2cc9a778fac97f69ad6a`;
  return voyagerGet(endpoint, 'application/vnd.linkedin.normalized+json+2.1');
}

/**
 * Send connection request with personalized note (Modern Dash API)
 */
async function sendConnectionRequest(memberId, message) {
  const profileUrn = `urn:li:fsd_profile:${memberId}`;
  const payload = {
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
  return voyagerPost(endpoint, payload);
}

/**
 * Withdraw a pending invitation
 */
async function withdrawInvitation(invitationId) {
  const endpoint = `/growth/normInvitations/${invitationId}`;
  return voyagerDelete(endpoint);
}

// ─── Utilities ───────────────────────────────────────────────────

function generateTrackingId() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes));
}

/**
 * Extract company slug/universalName from a LinkedIn company URL.
 */
function parseCompanyUrl(url) {
  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.split('/').filter(Boolean);
    if (parts[0] === 'company' && parts[1]) {
      return parts[1];
    }
    return null;
  } catch {
    return url.trim() || null;
  }
}

// ─── Exports ─────────────────────────────────────────────────────

if (typeof globalThis !== 'undefined') {
  Object.assign(globalThis, {
    getCsrfToken,
    getVoyagerHeaders,
    isLinkedInLoggedIn,
    voyagerGet,
    voyagerPost,
    voyagerDelete,
    searchJobs,
    resolveCompany,
    getCompanyById,
    searchPeople,
    fetchProfile,
    fetchFullProfile,
    checkRelationship,
    sendConnectionRequest,
    withdrawInvitation,
    generateTrackingId,
    parseCompanyUrl,
  });
}
