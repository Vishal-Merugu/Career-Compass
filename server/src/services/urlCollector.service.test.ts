import { describe, it, expect } from 'vitest';
import { parseSearchUrl } from './urlCollector.service.js';

/**
 * Only the URL parsing. Everything else in this module needs a live LinkedIn
 * session, which belongs in the probe rather than the suite.
 */
describe('parseSearchUrl', () => {
  it('prefers the numeric company id when the URL carries one', () => {
    const { companyId, companySlug } = parseSearchUrl(
      'https://www.linkedin.com/search/results/people/?currentCompany=%5B%221234%22%5D',
    );

    expect(companyId).toBe('1234');
    // No slug needed: a numeric id skips the resolve call entirely.
    expect(companySlug).toBe('');
  });

  it('reads the slug from a company page', () => {
    expect(
      parseSearchUrl('https://www.linkedin.com/company/siemens-energy/people/')
        .companySlug,
    ).toBe('siemens-energy');
  });

  // Measured 2026-08-12: `siemens-mobility` resolves to company 18049058 and
  // its people search returns hits, so a showcase page is a usable target.
  // Before this it fell through to `keywords`, came back empty, and the run
  // died with "Could not find a company in the search URL".
  it('reads the slug from a showcase page', () => {
    expect(
      parseSearchUrl('https://www.linkedin.com/showcase/siemens-mobility/')
        .companySlug,
    ).toBe('siemens-mobility');
  });

  it('falls back to the default geo when the URL has none', () => {
    expect(parseSearchUrl('https://www.linkedin.com/company/acme/').geoId).toBe(
      '101282230',
    );
  });

  it('unwraps a geoUrn whether or not it parses as JSON', () => {
    expect(
      parseSearchUrl(
        'https://www.linkedin.com/search/results/people/?geoUrn=%5B%22103644278%22%5D',
      ).geoId,
    ).toBe('103644278');
  });
});
