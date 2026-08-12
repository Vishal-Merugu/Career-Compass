import { describe, it, expect } from 'vitest';
import { companyNameFromUrl, companySlugFromUrl } from './companyName.js';

describe('companySlugFromUrl', () => {
  it('reads the segment after /company/, not the last one', () => {
    // The URL the dashboard tells people to paste. `split('/').pop()` said
    // "people" here, which is what put "for PEOPLE" in the Telegram messages.
    expect(
      companySlugFromUrl(
        'https://www.linkedin.com/company/siemens-healthineers/people/',
      ),
    ).toBe('siemens-healthineers');
  });

  it('handles a bare company URL', () => {
    expect(
      companySlugFromUrl(
        'https://www.linkedin.com/company/siemens-healthineers',
      ),
    ).toBe('siemens-healthineers');
  });

  // A division or product line: `/showcase/siemens-mobility/`. It resolves
  // through the same universalName call and its people search returns staff,
  // so it is a company URL for every purpose here.
  it('reads a showcase page the same way', () => {
    expect(
      companySlugFromUrl('https://www.linkedin.com/showcase/siemens-mobility/'),
    ).toBe('siemens-mobility');
    expect(
      companySlugFromUrl(
        'https://www.linkedin.com/showcase/siemens-mobility/people/',
      ),
    ).toBe('siemens-mobility');
  });

  it('is empty rather than throwing for junk', () => {
    expect(companySlugFromUrl('not a url')).toBe('');
    expect(companySlugFromUrl('')).toBe('');
    expect(companySlugFromUrl(null)).toBe('');
    expect(
      companySlugFromUrl('https://www.linkedin.com/search/results/people/'),
    ).toBe('');
  });
});

describe('companyNameFromUrl', () => {
  it('turns a slug into something a model can match on', () => {
    expect(
      companyNameFromUrl(
        'https://www.linkedin.com/company/siemens-healthineers/people/',
      ),
    ).toBe('Siemens Healthineers');
  });

  it('is empty when no company can be read', () => {
    expect(companyNameFromUrl('https://www.linkedin.com/feed/')).toBe('');
  });
});
