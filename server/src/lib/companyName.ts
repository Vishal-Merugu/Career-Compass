// ─── The company a run is actually targeting ─────────────────────
//
// `searchParams.companyUrl` is the only record of what the user asked for, and
// three call sites were each pulling a name out of it by hand. Two of them used
// `split('/').pop()`, which returns "people" for the URL the dashboard tells
// people to paste (`/company/<slug>/people/`).
//
// Kept in `lib/` rather than `shared/` on purpose: `shared/` is mirrored by hand
// into the extension, and the extension has no notion of a search job.

/**
 * The path segment that carries an organization's slug.
 *
 * `showcase` is the same kind of page as `company` — a division or product
 * line LinkedIn hangs off a parent, like `/showcase/siemens-mobility/`. It
 * resolves through the very same `q=universalName` call and its people search
 * returns staff (measured 2026-08-12: `siemens-mobility` → company 18049058,
 * 12 hits), so refusing the URL shape only forced a user to go find a
 * `/company/` page that may not exist.
 */
const ORG_SEGMENTS = ['company', 'showcase'];

/** `…/company/siemens-healthineers/people/` → `siemens-healthineers`. */
export function companySlugFromUrl(companyUrl?: string | null): string {
  if (!companyUrl) return '';

  try {
    const parts = new URL(companyUrl).pathname.split('/').filter(Boolean);
    const idx = parts.findIndex((part) => ORG_SEGMENTS.includes(part));
    return idx !== -1 && parts[idx + 1] ? parts[idx + 1] : '';
  } catch {
    return '';
  }
}

/**
 * The searched company in the words a person (or a model) would use.
 *
 * `siemens-healthineers` → `Siemens Healthineers`. Approximate by nature — the
 * slug is all we have without another Voyager call — which is why the prompt
 * that consumes it is told to match company names loosely.
 */
export function companyNameFromUrl(companyUrl?: string | null): string {
  const slug = companySlugFromUrl(companyUrl);
  if (!slug) return '';

  return slug
    .split('-')
    .filter(Boolean)
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(' ');
}
