// ─── Email Pattern Generation ────────────────────────────────────
// Ported from extension/services/emailFinder.js. Pure functions, no I/O —
// the domain guessing that used to live alongside them is gone, because
// string-mangling a company name into `${name}.com` is wrong often enough
// that it poisoned every pattern built on top of it. Domain resolution now
// lives in domain.ts, where a candidate has to survive an MX lookup.

export interface EmailPattern {
  email: string;
  format: string;
  /** Rough share of companies using this format, as a percentage. */
  weight: number;
}

/**
 * Strip diacritics and anything that is not a latin letter.
 * "Jose-Maria" with accents becomes "josemaria".
 */
function normalizeNamePart(part: string): string {
  return part
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z]/g, '');
}

/**
 * Generate likely email patterns for a person at a domain, ordered by how
 * commonly each format is used. `first.last` alone covers about half of all
 * companies, which is why the verification layer tries these in order.
 */
export function generateEmailPatterns(
  firstName: string,
  lastName: string,
  domain: string,
): EmailPattern[] {
  const f = normalizeNamePart(firstName);
  const l = normalizeNamePart(lastName);

  if (!f || !l || !domain) return [];

  const fi = f[0];
  const li = l[0];

  return [
    { email: `${f}.${l}@${domain}`, format: 'first.last', weight: 50 },
    { email: `${f}${l}@${domain}`, format: 'firstlast', weight: 15 },
    { email: `${fi}${l}@${domain}`, format: 'flast', weight: 12 },
    { email: `${fi}.${l}@${domain}`, format: 'f.last', weight: 8 },
    { email: `${f}${li}@${domain}`, format: 'firstl', weight: 5 },
    { email: `${f}_${l}@${domain}`, format: 'first_last', weight: 3 },
    { email: `${f}-${l}@${domain}`, format: 'first-last', weight: 3 },
    { email: `${l}.${f}@${domain}`, format: 'last.first', weight: 2 },
    { email: `${l}${f}@${domain}`, format: 'lastfirst', weight: 1 },
    { email: `${f}@${domain}`, format: 'first', weight: 1 },
  ];
}

/**
 * Split a display name into first and last.
 * LinkedIn names arrive as a single string, and the trailing token is the
 * surname often enough to be the right default. Middle names are dropped.
 */
export function splitFullName(fullName: string): {
  firstName: string;
  lastName: string;
} {
  const parts = (fullName || '').trim().split(/\s+/).filter(Boolean);

  if (parts.length === 0) return { firstName: '', lastName: '' };
  if (parts.length === 1) return { firstName: parts[0], lastName: '' };

  return {
    firstName: parts[0],
    lastName: parts[parts.length - 1],
  };
}
