// ─── Response Parsers ─────────────────────────────────────────────
// Extracted from voyagerClient.js for modularity.
// Parses raw Voyager API responses into clean data structures.

/**
 * Build a canonical public LinkedIn profile URL.
 *
 * Prefers the vanity slug (publicIdentifier, e.g. "marie-uibel") which produces
 * a human-readable URL. Falls back to the raw internal member key (ACoA...)
 * if no vanity slug is available.
 *
 * @param {string} publicIdentifier  – Vanity slug (e.g. "marie-uibel") or null.
 * @param {string} memberKey         – Internal member key (ACoA...) used as fallback.
 * @returns {string}                 – Full canonical URL.
 */
function buildLinkedInProfileUrl(publicIdentifier, memberKey) {
  const slug = publicIdentifier || memberKey || '';
  return `https://www.linkedin.com/in/${slug}`;
}

/**
 * Helper to extract text from Voyager TextViewModel or plain string
 */
function getText(val) {
  if (!val) return '';
  if (typeof val === 'string') return val;
  if (typeof val === 'object' && val.text) return val.text;
  return '';
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
    const cardUrn = element.jobCardUnion?.['*jobPostingCard'];
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
        '';

      if (title) {
        jobs.push({
          jobTitle: title,
          companyName: company || 'Unknown Company',
          companyUrn: companyUrn,
          location: location || 'Unknown Location',
          entityUrn: card.entityUrn || '',
        });
      }
    }
  }

  // 2. Fallback Strategy: If elements are empty or miss some jobs, scan included
  if (jobs.length === 0) {
    const seenUrns = new Set();
    for (const item of included) {
      const type = item.$type || '';
      if (
        (type.includes('JobPosting') || item.jobPostingTitle || item.title) &&
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
              '',
            location: getText(
              item.secondaryDescription || item.formattedLocation,
            ),
            entityUrn: item.entityUrn || '',
          });
        }
      }
    }
  }

  return jobs;
}

/**
 * Helper to check if a parsed profile name represents a generic, out-of-network
 * "LinkedIn Member" placeholder (which throws 403 Forbidden on individual profile fetches).
 */
function _isOutOfNetworkMember(name) {
  if (!name) return true;
  const nameLower = name.toLowerCase().trim();
  return (
    nameLower.includes('linkedin') &&
    (nameLower.includes('member') ||
      nameLower.includes('mitglied') ||
      nameLower.includes('membre') ||
      nameLower.includes('miembro') ||
      nameLower.includes('mitglieder') ||
      nameLower.includes('médico') ||
      nameLower.includes('utente'))
  );
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
      const resultUrn = entry.item?.['*entityResult'];
      if (resultUrn && includedMap[resultUrn]) {
        const viewModel = includedMap[resultUrn];

        // Extract profile ID from entityUrn (e.g. urn:li:fsd_profile:ACoAA...)
        let profileId = '';
        const profileUrn = viewModel.entityUrn || viewModel.profileUrn || '';
        if (profileUrn.includes('fsd_profile:')) {
          profileId = profileUrn.split('fsd_profile:')[1].split(',')[0];
        } else if (profileUrn.includes('member:')) {
          profileId = profileUrn.split('member:')[1].split(',')[0];
        }

        const name = getText(viewModel.title);
        const headline = getText(viewModel.primarySubtitle);

        // Avoid parsing out-of-network placeholder profiles
        if (_isOutOfNetworkMember(name)) {
          console.log(
            `[Parser] Skipping out-of-network placeholder profile: "${name}"`,
          );
          continue;
        }

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
      if (item.$type?.includes('MiniProfile') || item.publicIdentifier) {
        const pid = item.publicIdentifier || '';
        const name =
          `${getText(item.firstName)} ${getText(item.lastName)}`.trim();

        if (_isOutOfNetworkMember(name)) {
          continue;
        }

        if (pid && !seenProfileIds.has(pid)) {
          seenProfileIds.add(pid);
          people.push({
            name: name,
            profileId: pid,
            headline: getText(item.headline || item.occupation),
            entityUrn: item.entityUrn || '',
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
    firstName: '',
    lastName: '',
    headline: '',
    about: '',
    experiences: [],
    education: [],
    skills: [],
    location: '',
  };
  for (const item of included) {
    const type = item.$type || '';
    if (type.includes('Profile') && (item.firstName || item.firstNameV2)) {
      profile.firstName = getText(item.firstName || item.firstNameV2);
      profile.lastName = getText(item.lastName || item.lastNameV2);
      profile.headline = getText(item.headline || item.headlineV2);
      profile.publicIdentifier = item.publicIdentifier || '';
      profile.entityUrn = item.entityUrn || '';
      profile.location = item.locationName || item.geoLocationName || '';
      // Extract persistent member ID (ACoAA...)
      if (profile.entityUrn.includes('fsd_profile:')) {
        profile.memberId = profile.entityUrn
          .split('fsd_profile:')[1]
          .split(',')[0];
      }
    }
    if (type.includes('Summary') || item.summary || item.summaryV2) {
      profile.about = getText(item.summary || item.summaryV2 || profile.about);
    }
    if (type.includes('Position') && (item.title || item.titleV2)) {
      const timePeriod = item.timePeriod || item.dateRange || item.period || {};
      const startDate = timePeriod.startDate || timePeriod.start || {};
      const endDate = timePeriod.endDate || timePeriod.end || {};

      profile.experiences.push({
        title: getText(item.title || item.titleV2),
        companyName: getText(item.companyName),
        timePeriod: {
          startDate: {
            year: startDate.year || '',
            month: startDate.month || '',
          },
          endDate: {
            year: endDate.year || '',
            month: endDate.month || '',
          },
        },
      });
    }
    if (type.includes('Education') && item.schoolName) {
      profile.education.push({
        school: getText(item.schoolName),
        degree: getText(item.degreeName),
        fieldOfStudy: getText(item.fieldOfStudy),
      });
    }
    if (type.includes('Skill') && item.name) {
      profile.skills.push(getText(item.name));
    }
  }

  // Sort experiences: current first, then by start date descending
  profile.experiences.sort((a, b) => {
    const aEnd = a.timePeriod?.endDate;
    const bEnd = b.timePeriod?.endDate;
    const aCurrent = !aEnd || !aEnd.year;
    const bCurrent = !bEnd || !bEnd.year;

    if (aCurrent && !bCurrent) return -1;
    if (!aCurrent && bCurrent) return 1;

    const aStartYear = parseInt(a.timePeriod?.startDate?.year, 10) || 0;
    const aStartMonth = parseInt(a.timePeriod?.startDate?.month, 10) || 0;
    const bStartYear = parseInt(b.timePeriod?.startDate?.year, 10) || 0;
    const bStartMonth = parseInt(b.timePeriod?.startDate?.month, 10) || 0;

    if (aStartYear !== bStartYear) {
      return bStartYear - aStartYear;
    }
    return bStartMonth - aStartMonth;
  });

  return profile;
}

/**
 * Parse network info / relationship
 */
function parseRelationship(response) {
  const included = response.included || [];
  let distance = 'OUT_OF_NETWORK';
  let isConnected = false;
  let isPending = false;

  // 1. Find relationship info in the 'included' array (GraphQL/Dash response)
  const rel = included.find((i) => i.$type?.includes('MemberRelationship'));
  if (rel) {
    distance = rel.distance?.value || rel.distance || 'OUT_OF_NETWORK';
    isConnected = distance === 'DISTANCE_1';
  }

  // 2. Check for pending sent invitations in 'included'
  const hasSentInvite = included.some(
    (i) =>
      (i.$type?.includes('Invitation') || i.invitationType) &&
      i.invitationType === 'SENT',
  );

  if (hasSentInvite) {
    isPending = true;
  }

  // Fallback for legacy format (if still encountered)
  if (!rel && response.distance) {
    distance = response.distance?.value || response.distance;
    isConnected = distance === 'DISTANCE_1';
    isPending = !!(response.invitation || response.pendingInvitation);
  }

  return { distance, isConnected, isPending };
}

/**
 * Extract pagination metadata from search response
 */
function parsePaginationMetadata(response) {
  const root =
    response.data?.data?.searchDashClustersByAll ||
    response.data?.searchDashClustersByAll ||
    response;

  const paging = root.paging || response.paging || {};
  return {
    start: paging.start || 0,
    count: paging.count || 10,
    total: paging.total || 0,
  };
}

// ─── Exports ─────────────────────────────────────────────────────

if (typeof globalThis !== 'undefined') {
  Object.assign(globalThis, {
    getText,
    buildLinkedInProfileUrl,
    parseJobSearchResults,
    parsePeopleSearchResults,
    parseFullProfile,
    parseRelationship,
    parsePaginationMetadata,
  });
}
