import { describe, it, expect } from 'vitest';
import {
  buildLinkedInProfileUrl,
  getText,
  _isOutOfNetworkMember,
  parseJobSearchResults,
  parsePeopleSearchResults,
  parseFullProfile,
  parseRelationship,
  parsePaginationMetadata,
  employmentTypeOf,
} from './parsers.js';

describe('buildLinkedInProfileUrl', () => {
  it('prefers the human-readable vanity slug', () => {
    expect(buildLinkedInProfileUrl('marie-uibel', 'ACoAAB123')).toBe(
      'https://www.linkedin.com/in/marie-uibel',
    );
  });

  it('falls back to the internal member key', () => {
    expect(buildLinkedInProfileUrl(null, 'ACoAAB123')).toBe(
      'https://www.linkedin.com/in/ACoAAB123',
    );
  });

  it('falls back again when the slug is an empty string', () => {
    expect(buildLinkedInProfileUrl('', 'ACoAAB123')).toBe(
      'https://www.linkedin.com/in/ACoAAB123',
    );
  });

  it('returns the bare /in/ URL when it has nothing to work with', () => {
    expect(buildLinkedInProfileUrl()).toBe('https://www.linkedin.com/in/');
  });
});

describe('getText', () => {
  it('passes plain strings through', () => {
    expect(getText('Senior Engineer')).toBe('Senior Engineer');
  });

  it('unwraps a Voyager TextViewModel', () => {
    expect(getText({ text: 'Senior Engineer' })).toBe('Senior Engineer');
  });

  it('returns empty string for null, undefined and empty values', () => {
    expect(getText(null)).toBe('');
    expect(getText(undefined)).toBe('');
    expect(getText('')).toBe('');
    expect(getText(0)).toBe('');
  });

  it('returns empty string for an object with no text field', () => {
    expect(getText({ attributes: [] })).toBe('');
  });
});

describe('_isOutOfNetworkMember', () => {
  it('treats a missing name as out of network', () => {
    expect(_isOutOfNetworkMember(null)).toBe(true);
    expect(_isOutOfNetworkMember(undefined)).toBe(true);
    expect(_isOutOfNetworkMember('')).toBe(true);
  });

  it('detects the placeholder in several locales', () => {
    expect(_isOutOfNetworkMember('LinkedIn Member')).toBe(true);
    expect(_isOutOfNetworkMember('linkedin member')).toBe(true);
    expect(_isOutOfNetworkMember('LinkedIn Mitglied')).toBe(true);
    expect(_isOutOfNetworkMember('Membre LinkedIn')).toBe(true);
    expect(_isOutOfNetworkMember('Miembro de LinkedIn')).toBe(true);
    expect(_isOutOfNetworkMember('Utente LinkedIn')).toBe(true);
  });

  it('does not flag a real person', () => {
    expect(_isOutOfNetworkMember('Marie Uibel')).toBe(false);
  });

  it('needs both halves — a surname alone is not a placeholder', () => {
    // "Member" without "LinkedIn" is a real (if unusual) surname.
    expect(_isOutOfNetworkMember('Sarah Member')).toBe(false);
    // …and "LinkedIn" alone is a company page, not the placeholder.
    expect(_isOutOfNetworkMember('LinkedIn')).toBe(false);
  });
});

describe('parseJobSearchResults', () => {
  const card = {
    entityUrn: 'urn:li:jobPostingCard:1',
    jobPostingTitle: { text: 'Senior Backend Engineer' },
    primaryDescription: { text: 'Acme GmbH' },
    secondaryDescription: { text: 'Berlin, Germany' },
    logo: {
      attributes: [
        { detailDataUnion: { companyLogo: 'urn:li:fsd_company:99' } },
      ],
    },
  };

  it('resolves job cards through the elements array', () => {
    const jobs = parseJobSearchResults({
      included: [card],
      data: {
        elements: [
          { jobCardUnion: { '*jobPostingCard': 'urn:li:jobPostingCard:1' } },
        ],
      },
    });

    expect(jobs).toEqual([
      {
        jobTitle: 'Senior Backend Engineer',
        companyName: 'Acme GmbH',
        companyUrn: 'urn:li:fsd_company:99',
        location: 'Berlin, Germany',
        entityUrn: 'urn:li:jobPostingCard:1',
      },
    ]);
  });

  it('unwraps an array-shaped response', () => {
    const jobs = parseJobSearchResults([
      { meta: 'noise' },
      {
        included: [card],
        data: {
          elements: [
            { jobCardUnion: { '*jobPostingCard': 'urn:li:jobPostingCard:1' } },
          ],
        },
      },
    ]);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].jobTitle).toBe('Senior Backend Engineer');
  });

  it('falls back to scanning `included` when elements yield nothing', () => {
    const jobs = parseJobSearchResults({
      included: [
        {
          $type: 'com.linkedin.voyager.dash.jobs.JobPosting',
          entityUrn: 'urn:li:fsd_jobPosting:7',
          title: { text: 'Data Scientist' },
          primaryDescription: { text: 'Globex' },
          formattedLocation: 'Munich',
        },
      ],
      data: { elements: [] },
    });

    expect(jobs).toEqual([
      {
        jobTitle: 'Data Scientist',
        companyName: 'Globex',
        companyUrn: '',
        location: 'Munich',
        entityUrn: 'urn:li:fsd_jobPosting:7',
      },
    ]);
  });

  it('substitutes placeholders for a missing company and location', () => {
    const jobs = parseJobSearchResults({
      included: [
        { entityUrn: 'urn:li:jobPostingCard:2', jobPostingTitle: 'Intern' },
      ],
      data: {
        elements: [
          { jobCardUnion: { '*jobPostingCard': 'urn:li:jobPostingCard:2' } },
        ],
      },
    });
    expect(jobs[0].companyName).toBe('Unknown Company');
    expect(jobs[0].location).toBe('Unknown Location');
  });

  it('drops cards with no title and survives an empty response', () => {
    expect(
      parseJobSearchResults({
        included: [{ entityUrn: 'urn:li:jobPostingCard:3' }],
        data: {
          elements: [
            { jobCardUnion: { '*jobPostingCard': 'urn:li:jobPostingCard:3' } },
          ],
        },
      }),
    ).toEqual([]);
    expect(parseJobSearchResults({})).toEqual([]);
  });
});

describe('parsePeopleSearchResults', () => {
  const entityResult = (
    urn: string,
    name: string,
  ): Record<string, unknown> => ({
    entityUrn: `urn:li:fsd_entityResultViewModel:(urn:li:fsd_profile:${urn},SEARCH,DEFAULT)`,
    title: { text: name },
    primarySubtitle: { text: 'Talent Acquisition at Acme' },
    secondarySubtitle: { text: 'Berlin, Germany' },
  });

  const wrap = (included: unknown[], resultUrns: string[]) => ({
    included,
    data: {
      data: {
        searchDashClustersByAll: {
          elements: [
            {
              items: resultUrns.map((u) => ({ item: { '*entityResult': u } })),
            },
          ],
        },
      },
    },
  });

  it('extracts the member id out of the fsd_profile URN', () => {
    const r = entityResult('ACoAAB123', 'Marie Uibel');
    const people = parsePeopleSearchResults(wrap([r], [r.entityUrn as string]));

    expect(people).toEqual([
      {
        name: 'Marie Uibel',
        profileId: 'ACoAAB123',
        headline: 'Talent Acquisition at Acme',
        location: 'Berlin, Germany',
        entityUrn: r.entityUrn,
      },
    ]);
  });

  it('skips out-of-network placeholders', () => {
    const real = entityResult('ACoAAB123', 'Marie Uibel');
    const ghost = entityResult('ACoAAB999', 'LinkedIn Member');
    const people = parsePeopleSearchResults(
      wrap(
        [real, ghost],
        [real.entityUrn as string, ghost.entityUrn as string],
      ),
    );
    expect(people.map((p) => p.profileId)).toEqual(['ACoAAB123']);
  });

  it('deduplicates a profile that appears in more than one cluster item', () => {
    const r = entityResult('ACoAAB123', 'Marie Uibel');
    const people = parsePeopleSearchResults(
      wrap([r], [r.entityUrn as string, r.entityUrn as string]),
    );
    expect(people).toHaveLength(1);
  });

  it('falls back to MiniProfiles in `included`', () => {
    const people = parsePeopleSearchResults({
      included: [
        {
          $type: 'com.linkedin.voyager.identity.shared.MiniProfile',
          publicIdentifier: 'marie-uibel',
          firstName: 'Marie',
          lastName: 'Uibel',
          occupation: 'Recruiter at Acme',
          entityUrn: 'urn:li:fs_miniProfile:ACoAAB123',
        },
      ],
      data: { data: { searchDashClustersByAll: { elements: [] } } },
    });

    expect(people).toEqual([
      {
        name: 'Marie Uibel',
        profileId: 'marie-uibel',
        headline: 'Recruiter at Acme',
        entityUrn: 'urn:li:fs_miniProfile:ACoAAB123',
      },
    ]);
  });

  it('returns an empty array for an empty response', () => {
    expect(parsePeopleSearchResults({})).toEqual([]);
  });
});

describe('employmentTypeOf', () => {
  it('reads a plain string', () => {
    expect(employmentTypeOf({ employmentType: 'Full-time' })).toBe('Full-time');
  });

  it('reads the older localizedName object', () => {
    expect(
      employmentTypeOf({ employmentType: { localizedName: 'Werkstudent' } }),
    ).toBe('Werkstudent');
  });

  it('un-slugs the dash urn, which is often the only form present', () => {
    expect(
      employmentTypeOf({
        employmentTypeUrn: 'urn:li:fsd_employmentType:WORK_STUDY',
      }),
    ).toBe('Work Study');
    expect(
      employmentTypeOf({
        employmentTypeUrn: 'urn:li:fsd_employmentType:INTERNSHIP',
      }),
    ).toBe('Internship');
  });

  it('is empty for a position that carries no type at all', () => {
    expect(employmentTypeOf({ title: 'Freelancer' })).toBe('');
    expect(employmentTypeOf(null)).toBe('');
    expect(employmentTypeOf('nonsense')).toBe('');
  });
});

describe('parseFullProfile', () => {
  const P = 'com.linkedin.voyager.dash.identity.profile.Profile';
  const POSITION = 'com.linkedin.voyager.dash.identity.profile.Position';
  const EDUCATION = 'com.linkedin.voyager.dash.identity.profile.Education';
  const SKILL = 'com.linkedin.voyager.dash.identity.profile.Skill';

  it('pulls identity, memberId, education and skills out of `included`', () => {
    const profile = parseFullProfile({
      included: [
        {
          $type: P,
          firstName: 'Marie',
          lastName: 'Uibel',
          headline: { text: 'Recruiter at Acme' },
          publicIdentifier: 'marie-uibel',
          entityUrn: 'urn:li:fsd_profile:ACoAAB123,SEARCH',
          summary: 'I hire engineers.',
        },
        {
          $type: EDUCATION,
          schoolName: 'FAU Erlangen',
          degreeName: 'MSc',
          fieldOfStudy: 'Computer Science',
          dateRange: { start: { year: 2024 }, end: { year: 2027 } },
        },
        { $type: SKILL, name: 'Recruiting' },
        { $type: SKILL, name: 'Sourcing' },
      ],
    });

    expect(profile.firstName).toBe('Marie');
    expect(profile.lastName).toBe('Uibel');
    expect(profile.headline).toBe('Recruiter at Acme');
    expect(profile.publicIdentifier).toBe('marie-uibel');
    expect(profile.memberId).toBe('ACoAAB123');
    expect(profile.about).toBe('I hire engineers.');
    expect(profile.education).toEqual([
      {
        school: 'FAU Erlangen',
        degree: 'MSc',
        fieldOfStudy: 'Computer Science',
        // An end year in the future is what tells the model the degree is
        // unfinished. It was parsed away until 2026-08-10.
        timePeriod: {
          startDate: { year: 2024 },
          endDate: { year: 2027 },
        },
      },
    ]);
    expect(profile.skills).toEqual(['Recruiting', 'Sourcing']);
  });

  it('sorts current roles first, then by start date descending', () => {
    const position = (
      title: string,
      start: { year: number; month: number },
      end?: { year: number; month: number },
    ) => ({
      $type: POSITION,
      title: { text: title },
      companyName: { text: 'Acme' },
      timePeriod: { startDate: start, ...(end ? { endDate: end } : {}) },
    });

    const profile = parseFullProfile({
      included: [
        position(
          'Older role',
          { year: 2018, month: 1 },
          { year: 2020, month: 1 },
        ),
        position(
          'Newer past role',
          { year: 2020, month: 3 },
          { year: 2022, month: 6 },
        ),
        position('Current role', { year: 2022, month: 7 }),
      ],
    });

    expect(profile.experiences.map((e) => e.title)).toEqual([
      'Current role',
      'Newer past role',
      'Older role',
    ]);
  });

  it('breaks a start-year tie by month', () => {
    const position = (title: string, month: number) => ({
      $type: POSITION,
      title,
      timePeriod: {
        startDate: { year: 2021, month },
        endDate: { year: 2022, month: 12 },
      },
    });

    const profile = parseFullProfile({
      included: [position('March', 3), position('September', 9)],
    });

    expect(profile.experiences.map((e) => e.title)).toEqual([
      'September',
      'March',
    ]);
  });

  it('keeps the employment type off a position', () => {
    const profile = parseFullProfile({
      included: [
        {
          $type: POSITION,
          title: { text: 'Software Engineer' },
          companyName: { text: 'Siemens Healthineers' },
          employmentTypeUrn: 'urn:li:fsd_employmentType:WORK_STUDY',
        },
      ],
    });

    expect(profile.experiences[0].employmentType).toBe('Work Study');
  });

  it('normalises a missing time period to empty strings', () => {
    const profile = parseFullProfile({
      included: [{ $type: POSITION, title: 'Freelancer' }],
    });
    expect(profile.experiences[0].timePeriod).toEqual({
      startDate: { year: '', month: '' },
      endDate: { year: '', month: '' },
    });
  });

  it('returns an empty profile shape for an empty response', () => {
    expect(parseFullProfile({})).toEqual({
      firstName: '',
      lastName: '',
      headline: '',
      about: '',
      experiences: [],
      education: [],
      skills: [],
    });
  });
});

describe('parseRelationship', () => {
  it('reads a first-degree connection', () => {
    expect(
      parseRelationship({
        included: [
          {
            $type: 'com.linkedin.voyager.dash.relationships.MemberRelationship',
            distance: { value: 'DISTANCE_1' },
          },
        ],
      }),
    ).toEqual({ distance: 'DISTANCE_1', isConnected: true, isPending: false });
  });

  it('flags a sent invitation as pending', () => {
    expect(
      parseRelationship({
        included: [
          {
            $type: 'com.linkedin.voyager.dash.relationships.MemberRelationship',
            distance: { value: 'DISTANCE_2' },
          },
          { $type: 'Invitation', invitationType: 'SENT' },
        ],
      }),
    ).toEqual({ distance: 'DISTANCE_2', isConnected: false, isPending: true });
  });

  it('does not flag a received invitation as pending', () => {
    const r = parseRelationship({
      included: [
        {
          $type: 'com.linkedin.voyager.dash.relationships.MemberRelationship',
          distance: { value: 'DISTANCE_2' },
        },
        { $type: 'Invitation', invitationType: 'RECEIVED' },
      ],
    });
    expect(r.isPending).toBe(false);
  });

  it('reads a top-level distance when `included` has no relationship', () => {
    expect(
      parseRelationship({
        included: [],
        distance: { value: 'DISTANCE_1' },
        invitation: null,
      }),
    ).toEqual({ distance: 'DISTANCE_1', isConnected: true, isPending: false });
  });

  it('defaults to out of network', () => {
    expect(parseRelationship({})).toEqual({
      distance: 'OUT_OF_NETWORK',
      isConnected: false,
      isPending: false,
    });
  });
});

describe('parsePaginationMetadata', () => {
  it('reads paging from the nested search cluster', () => {
    expect(
      parsePaginationMetadata({
        data: {
          data: {
            searchDashClustersByAll: {
              paging: { start: 20, count: 10, total: 314 },
            },
          },
        },
      }),
    ).toEqual({ start: 20, count: 10, total: 314 });
  });

  it('reads top-level paging', () => {
    expect(
      parsePaginationMetadata({ paging: { start: 0, count: 25, total: 7 } }),
    ).toEqual({ start: 0, count: 25, total: 7 });
  });

  it('defaults count to 10 and everything else to 0', () => {
    expect(parsePaginationMetadata({})).toEqual({
      start: 0,
      count: 10,
      total: 0,
    });
  });
});
