import { describe, it, expect } from 'vitest';
import { generateEmailPatterns, splitFullName } from './patterns.js';
import { domainCandidates, extractHost } from './domain.js';

describe('generateEmailPatterns', () => {
  it('orders formats by how common they are', () => {
    const patterns = generateEmailPatterns('Jane', 'Doe', 'acme.com');

    expect(patterns[0]).toMatchObject({
      email: 'jane.doe@acme.com',
      format: 'first.last',
    });
    // Weights must be non-increasing, since the SMTP layer probes in order.
    const weights = patterns.map((p) => p.weight);
    expect([...weights].sort((a, b) => b - a)).toEqual(weights);
  });

  it('strips diacritics rather than emitting them into an address', () => {
    const patterns = generateEmailPatterns('Jean-François', 'Müller', 'x.com');

    expect(patterns[0].email).toBe('jeanfrancois.muller@x.com');
    expect(patterns.every((p) => /^[a-z0-9._@-]+$/.test(p.email))).toBe(true);
  });

  it('returns nothing when a name part or domain is missing', () => {
    expect(generateEmailPatterns('', 'Doe', 'acme.com')).toEqual([]);
    expect(generateEmailPatterns('Jane', '', 'acme.com')).toEqual([]);
    expect(generateEmailPatterns('Jane', 'Doe', '')).toEqual([]);
  });

  it('drops name parts that normalise to nothing', () => {
    // A name that is punctuation-only must not become "@acme.com".
    expect(generateEmailPatterns('...', 'Doe', 'acme.com')).toEqual([]);
  });
});

describe('splitFullName', () => {
  it('treats the trailing token as the surname', () => {
    expect(splitFullName('Jane Doe')).toEqual({
      firstName: 'Jane',
      lastName: 'Doe',
    });
    expect(splitFullName('Jane Q Public')).toEqual({
      firstName: 'Jane',
      lastName: 'Public',
    });
  });

  it('handles single names and blanks', () => {
    expect(splitFullName('Cher')).toEqual({
      firstName: 'Cher',
      lastName: '',
    });
    expect(splitFullName('   ')).toEqual({ firstName: '', lastName: '' });
  });
});

describe('domainCandidates', () => {
  it('strips legal forms and offers the brand word as a fallback', () => {
    const candidates = domainCandidates('Siemens Digital Industries GmbH');

    expect(candidates[0]).toBe('siemensdigitalindustries.com');
    expect(candidates).toContain('siemens.com');
  });

  it('does not emit a duplicate stem for single-word companies', () => {
    const candidates = domainCandidates('Stripe');

    expect(candidates[0]).toBe('stripe.com');
    expect(new Set(candidates).size).toBe(candidates.length);
  });

  it('returns nothing for a name that is entirely noise', () => {
    expect(domainCandidates('The Company Ltd')).toEqual([]);
    expect(domainCandidates('')).toEqual([]);
  });
});

describe('extractHost', () => {
  it('reduces a website to a registrable host', () => {
    expect(extractHost('https://www.acme.com/careers?x=1')).toBe('acme.com');
    expect(extractHost('acme.com')).toBe('acme.com');
    expect(extractHost('http://sub.acme.co.uk')).toBe('sub.acme.co.uk');
  });

  it('returns null for junk', () => {
    expect(extractHost('')).toBeNull();
    expect(extractHost('   ')).toBeNull();
  });
});
