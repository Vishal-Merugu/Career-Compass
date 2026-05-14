// ─── Voyager API Client ──────────────────────────────────────────
// Authenticated client for LinkedIn's internal Voyager API.
// Pattern adapted from reference repo VoyagerCommon class.

const VOYAGER_BASE = "https://www.linkedin.com/voyager/api";

// ─── Authentication ──────────────────────────────────────────────

async function getCsrfToken() {
  const cookie = await chrome.cookies.get({
    name: "JSESSIONID",
    url: "https://www.linkedin.com",
  });
  if (!cookie?.value) return null;
  return cookie.value.replaceAll('"', "");
}

async function getVoyagerHeaders() {
  const csrf = await getCsrfToken();
  if (!csrf)
    throw new Error("Not logged into LinkedIn — JSESSIONID cookie missing");
  return {
    "csrf-token": csrf,
    "x-restli-protocol-version": "2.0.0",
    "x-li-lang": "en_US",
    "x-li-track": JSON.stringify({
      clientVersion: "1.13.42510",
      mpVersion: "1.13.42510",
      osName: "web",
      timezoneOffset: 5.5,
      deviceFormFactor: "DESKTOP",
      mpName: "voyager-web",
    }),
    accept: "application/vnd.linkedin.normalized+json+2.1",
  };
}

// ─── Session Validation ──────────────────────────────────────────

async function isLinkedInLoggedIn() {
  try {
    const csrf = await getCsrfToken();
    if (!csrf) return false;
    const res = await fetch(
      "https://www.linkedin.com/voyager/uas/authenticate",
      {
        method: "GET",
        headers: { "csrf-token": csrf },
        credentials: "same-origin",
      },
    );
    return !res.url.includes("session_redirect");
  } catch {
    return false;
  }
}

// ─── Core HTTP Methods ───────────────────────────────────────────

async function voyagerGet(endpoint, accept) {
  const headers = await getVoyagerHeaders();
  if (accept) headers["accept"] = accept;
  const res = await fetch(VOYAGER_BASE + endpoint, {
    method: "GET",
    headers,
    credentials: "same-origin",
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Voyager GET ${endpoint} → ${res.status}: ${text.slice(0, 200)}`,
    );
  }
  return res.json();
}

async function voyagerPost(endpoint, body, accept) {
  const headers = await getVoyagerHeaders();
  headers["Content-Type"] = "application/json";
  if (accept) headers["accept"] = accept;
  const res = await fetch(VOYAGER_BASE + endpoint, {
    method: "POST",
    headers,
    credentials: "same-origin",
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Voyager POST ${endpoint} → ${res.status}: ${text.slice(0, 200)}`,
    );
  }
  // Some POST endpoints return 201 with no body
  const contentType = res.headers.get("content-type") || "";
  if (contentType.includes("json")) return res.json();
  return { status: res.status };
}

async function voyagerDelete(endpoint) {
  const headers = await getVoyagerHeaders();
  const res = await fetch(VOYAGER_BASE + endpoint, {
    method: "DELETE",
    headers,
    credentials: "same-origin",
  });
  if (!res.ok) {
    throw new Error(`Voyager DELETE ${endpoint} → ${res.status}`);
  }
  return { status: res.status };
}

// ─── Endpoint Methods ────────────────────────────────────────────

/**
 * F1: Search Jobs by keywords and location
 */
async function searchJobs(keywords, location, start = 0, count = 25) {
  const params = new URLSearchParams({
    decorationId:
      "com.linkedin.voyager.dash.deco.jobs.search.JobSearchCardsCollection-220",
    count: String(count),
    q: "jobSearch",
    start: String(start),
  });

  // Build the query string for job search using the precise Voyager syntax identified from XHR inspection:
  // (origin:JOB_SEARCH_PAGE_OTHER_ENTRY,keywords:XXX,locationUnion:(seoLocation:(location:YYY)),spellCorrectionEnabled:true)
  const isGeoId = /^\d+$/.test(location);
  const locationPart = isGeoId
    ? `geoId:${location}`
    : `seoLocation:(location:${encodeURIComponent(location)})`;

  const queryStr = `keywords:${encodeURIComponent(keywords)},locationUnion:(${locationPart}),spellCorrectionEnabled:true`;
  const endpoint = `/voyagerJobsDashJobCards?${params.toString()}&query=(origin:JOB_SEARCH_PAGE_OTHER_ENTRY,${queryStr})`;
  return voyagerGet(endpoint, "application/vnd.linkedin.normalized+json+2.1");
}

/**
 * F1: Resolve company from universal name / slug
 */
async function resolveCompany(universalName) {
  const endpoint = `/organization/companies?decorationId=com.linkedin.voyager.deco.organization.web.WebFullCompanyMain-12&q=universalName&universalName=${encodeURIComponent(universalName)}`;
  return voyagerGet(endpoint);
}

/**
 * F1: Resolve company from URN ID
 */
async function getCompanyById(companyId) {
  const endpoint = `/organization/companies/${companyId}`;
  return voyagerGet(endpoint, "application/json");
}

/**
 * F1: Search people at a company with HR-related keywords
 */
async function searchPeople(
  companyId,
  keywords = "HR OR Recruiter OR Talent OR Hiring OR People",
  geoId = "101282230", // Default: Germany
  start = 0,
  count = 10,
) {
  const variables = `(start:${start},origin:FACETED_SEARCH,query:(keywords:${encodeURIComponent(keywords)},flagshipSearchIntent:SEARCH_SRP,queryParameters:List((key:currentCompany,value:List(${companyId})),(key:location,value:List(${geoId})),(key:resultType,value:List(PEOPLE))),includeFiltersInResponse:false))`;
  const endpoint = `/graphql?variables=${variables}&queryId=voyagerSearchDashClusters.b0928897b71bd00a5a7291755dcd64f0`;
  return voyagerGet(endpoint, "application/vnd.linkedin.normalized+json+2.1");
}

/**
 * F1: Fetch full profile by member identity (public identifier / slug)
 */
async function fetchProfile(memberIdentity) {
  const endpoint = `/identity/dash/profiles?q=memberIdentity&memberIdentity=${encodeURIComponent(memberIdentity)}&decorationId=com.linkedin.voyager.dash.deco.identity.profile.WebTopCardCore-3`;
  return voyagerGet(endpoint);
}

/**
 * F1: Get full detailed profile
 */
async function fetchFullProfile(memberIdentity) {
  const endpoint = `/identity/dash/profiles?q=memberIdentity&memberIdentity=${encodeURIComponent(memberIdentity)}&decorationId=com.linkedin.voyager.dash.deco.identity.profile.FullProfileWithEntities-93`;
  return voyagerGet(endpoint);
}

/**
 * F1: Check connection status / relationship
 */
async function checkRelationship(profileId) {
  const variables = `(vanityName:${profileId})`;
  const endpoint = `/graphql?variables=${variables}&queryId=voyagerIdentityDashProfiles.34ead06db82a2cc9a778fac97f69ad6a`;
  return voyagerGet(endpoint, "application/vnd.linkedin.normalized+json+2.1");
}

/**
 * F1: Send connection request with personalized note (Modern Dash API)
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
    "/voyagerRelationshipsDashMemberRelationships?action=verifyQuotaAndCreateV2&decorationId=com.linkedin.voyager.dash.deco.relationships.InvitationCreationResultWithInvitee-2";
  return voyagerPost(endpoint, payload);
}

/**
 * F1: Withdraw a pending invitation
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

// ─── Response Parsers ────────────────────────────────────────────

/**
 * Helper to extract text from Voyager TextViewModel or plain string
 */
function getText(val) {
  if (!val) return "";
  if (typeof val === "string") return val;
  if (typeof val === "object" && val.text) return val.text;
  return "";
}

/**
 * Extract job cards from search response
 */
function parseJobSearchResults(response) {
  // If response is an array (Voyager batch), use the first result that has data
  let root = response;
  if (Array.isArray(response)) {
    root = response.find((r) => r.data || r.included) || response[0] || {};
  }

  const jobs = [];
  const included = root.included || [];
  const data = root.data || root;
  const elements = data.elements || [];

  // Build a map of included objects for quick lookup
  const includedMap = {};
  for (const item of included) {
    if (item.entityUrn) {
      includedMap[item.entityUrn] = item;
    }
  }

  // 1. Primary Strategy: Use the 'elements' array as the source of truth
  for (const element of elements) {
    const cardUrn = element.jobCardUnion?.["*jobPostingCard"];
    if (cardUrn && includedMap[cardUrn]) {
      const card = includedMap[cardUrn];
      const title = getText(card.jobPostingTitle || card.title);
      // Primary description usually contains company name, secondary usually location
      const company = getText(card.primaryDescription || card.subtitle);
      const location = getText(
        card.secondaryDescription || card.formattedLocation,
      );

      const companyUrn =
        card.logo?.attributes?.[0]?.detailDataUnion?.companyLogo ||
        card.companyDetails?.company ||
        "";

      if (title) {
        jobs.push({
          jobTitle: title,
          companyName: company || "Unknown Company",
          companyUrn: companyUrn,
          location: location || "Unknown Location",
          entityUrn: card.entityUrn || "",
        });
      }
    }
  }

  // 2. Fallback Strategy: If elements are empty or miss some jobs, scan included
  if (jobs.length === 0) {
    const seenUrns = new Set();
    for (const item of included) {
      const type = item.$type || "";
      if (
        (type.includes("JobPosting") || item.jobPostingTitle || item.title) &&
        !seenUrns.has(item.entityUrn)
      ) {
        const title = getText(item.jobPostingTitle || item.title);
        if (title) {
          seenUrns.add(item.entityUrn);
          jobs.push({
            jobTitle: title,
            companyName: getText(
              item.primaryDescription ||
                item.companyDetails?.companyName ||
                item.subtitle,
            ),
            companyUrn:
              item.companyDetails?.company ||
              item.logo?.attributes?.[0]?.detailDataUnion?.companyLogo ||
              "",
            location: getText(
              item.secondaryDescription || item.formattedLocation,
            ),
            entityUrn: item.entityUrn || "",
          });
        }
      }
    }
  }

  return jobs;
}

/**
 * Parse people search results to extract profile targets
 */
function parsePeopleSearchResults(response) {
  // Handle GraphQL/Dash wrapper variations
  let root =
    response.data?.data?.searchDashClustersByAll ||
    response.data?.searchDashClustersByAll ||
    response;

  const people = [];
  const included = response.included || [];
  const elements = root.elements || [];

  // Build a map of included objects for quick lookup
  const includedMap = {};
  for (const item of included) {
    if (item.entityUrn) {
      includedMap[item.entityUrn] = item;
    }
  }

  const seenProfileIds = new Set();

  for (const cluster of elements) {
    const items = cluster.items || [];
    for (const entry of items) {
      const resultUrn = entry.item?.["*entityResult"];
      if (resultUrn && includedMap[resultUrn]) {
        const viewModel = includedMap[resultUrn];

        // Extract profile ID from entityUrn (e.g. urn:li:fsd_profile:ACoAA...)
        let profileId = "";
        const profileUrn = viewModel.entityUrn || viewModel.profileUrn || "";
        if (profileUrn.includes("fsd_profile:")) {
          profileId = profileUrn.split("fsd_profile:")[1].split(",")[0];
        } else if (profileUrn.includes("member:")) {
          profileId = profileUrn.split("member:")[1].split(",")[0];
        }

        const name = getText(viewModel.title);
        const headline = getText(viewModel.primarySubtitle);

        if (profileId && !seenProfileIds.has(profileId)) {
          seenProfileIds.add(profileId);
          people.push({
            name: name,
            profileId: profileId,
            headline: headline,
            location: getText(viewModel.secondarySubtitle),
            entityUrn: profileUrn,
          });
        }
      }
    }
  }

  // Fallback: If elements-based parsing failed, scan included for MiniProfiles
  if (people.length === 0) {
    for (const item of included) {
      if (item.$type?.includes("MiniProfile") || item.publicIdentifier) {
        const pid = item.publicIdentifier || "";
        if (pid && !seenProfileIds.has(pid)) {
          seenProfileIds.add(pid);
          people.push({
            name: `${getText(item.firstName)} ${getText(item.lastName)}`.trim(),
            profileId: pid,
            headline: getText(item.headline || item.occupation),
            entityUrn: item.entityUrn || "",
          });
        }
      }
    }
  }

  return people;
}

/**
 * Parse full profile response
 */
function parseFullProfile(response) {
  const included = response.included || [];
  const profile = {
    firstName: "",
    lastName: "",
    headline: "",
    about: "",
    experiences: [],
    education: [],
    skills: [],
  };
  for (const item of included) {
    const type = item.$type || "";
    if (type.includes("Profile") && (item.firstName || item.firstNameV2)) {
      profile.firstName = getText(item.firstName || item.firstNameV2);
      profile.lastName = getText(item.lastName || item.lastNameV2);
      profile.headline = getText(item.headline || item.headlineV2);
      profile.publicIdentifier = item.publicIdentifier || "";
      profile.entityUrn = item.entityUrn || "";
      // Extract persistent member ID (ACoAA...)
      if (profile.entityUrn.includes("fsd_profile:")) {
        profile.memberId = profile.entityUrn
          .split("fsd_profile:")[1]
          .split(",")[0];
      }
    }
    if (type.includes("Summary") || item.summary || item.summaryV2) {
      profile.about = getText(item.summary || item.summaryV2 || profile.about);
    }
    if (type.includes("Position") && (item.title || item.titleV2)) {
      profile.experiences.push({
        title: getText(item.title || item.titleV2),
        companyName: getText(item.companyName),
        timePeriod: item.timePeriod || {},
      });
    }
    if (type.includes("Education") && item.schoolName) {
      profile.education.push({
        school: getText(item.schoolName),
        degree: getText(item.degreeName),
        fieldOfStudy: getText(item.fieldOfStudy),
      });
    }
    if (type.includes("Skill") && item.name) {
      profile.skills.push(getText(item.name));
    }
  }
  return profile;
}

/**
 * Parse network info / relationship
 */
function parseRelationship(response) {
  const included = response.included || [];
  let distance = "OUT_OF_NETWORK";
  let isConnected = false;
  let isPending = false;

  // 1. Find relationship info in the 'included' array (GraphQL/Dash response)
  const rel = included.find((i) => i.$type?.includes("MemberRelationship"));
  if (rel) {
    distance = rel.distance?.value || rel.distance || "OUT_OF_NETWORK";
    isConnected = distance === "DISTANCE_1";
  }

  // 2. Check for pending sent invitations in 'included'
  const hasSentInvite = included.some(
    (i) =>
      (i.$type?.includes("Invitation") || i.invitationType) &&
      i.invitationType === "SENT",
  );

  if (hasSentInvite) {
    isPending = true;
  }

  // Fallback for legacy format (if still encountered)
  if (!rel && response.distance) {
    distance = response.distance?.value || response.distance;
    isConnected = distance === "DISTANCE_1";
    isPending = !!(response.invitation || response.pendingInvitation);
  }

  return { distance, isConnected, isPending };
}

// ─── Exports ─────────────────────────────────────────────────────

if (typeof globalThis !== "undefined") {
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
    parseJobSearchResults,
    parsePeopleSearchResults,
    parseFullProfile,
    parseRelationship,
  });
}
