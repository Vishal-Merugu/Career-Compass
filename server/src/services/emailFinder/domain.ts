// ─── Company Domain Resolution ───────────────────────────────────
// The extension guessed a domain by stripping suffixes off the company name
// and appending ".com". That is a coin flip, and every pattern built on a
// wrong domain is wrong. Here a candidate only counts once DNS says the
// domain actually receives mail.

import { promises as dns } from 'node:dns';
import { logger } from '../../lib/logger.js';

/** Legal-form and filler tokens that never appear in a mail domain. */
const COMPANY_NOISE =
  /\b(gmbh|ag|se|inc|corp|corporation|ltd|limited|llc|plc|co|company|group|holding|holdings|international|technologies|technology|solutions|services|systems|labs|the)\b/g;

/**
 * Turn a company display name into ordered domain candidates.
 * "Siemens Digital Industries GmbH" → ["siemensdigitalindustries.com",
 *  "siemens.com", "siemensdigitalindustries.io", ...]
 */
export function domainCandidates(companyName: string): string[] {
  if (!companyName) return [];

  const cleaned = companyName
    .toLowerCase()
    .replace(/[&+]/g, ' ')
    .replace(COMPANY_NOISE, ' ')
    .replace(/[^a-z0-9\s-]/g, '')
    .trim();

  const words = cleaned.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];

  const joined = words.join('');
  const firstWord = words[0];

  // Ordered by likelihood: the full name, then just the leading brand word.
  const stems = joined === firstWord ? [joined] : [joined, firstWord];
  const tlds = ['com', 'io', 'net', 'co'];

  const candidates: string[] = [];
  for (const stem of stems) {
    if (stem.length < 2) continue;
    for (const tld of tlds) {
      candidates.push(`${stem}.${tld}`);
    }
  }

  return candidates;
}

/**
 * Does this domain accept mail? Cheap, free, and the only honest way to tell
 * a real company domain from a plausible-looking string.
 */
export async function hasMailExchanger(domain: string): Promise<boolean> {
  try {
    const records = await dns.resolveMx(domain);
    return records.length > 0 && records.some((r) => Boolean(r.exchange));
  } catch {
    // NXDOMAIN / ENODATA / SERVFAIL all mean "not usable", not an error worth
    // surfacing — the caller is walking a candidate list.
    return false;
  }
}

/**
 * Resolve a usable mail domain for a company.
 *
 * @param companyName  LinkedIn's company display name.
 * @param knownWebsite Company website if one was scraped — always preferred,
 *                     since it is fact rather than inference.
 */
export async function resolveCompanyDomain(
  companyName: string,
  knownWebsite?: string,
): Promise<string | null> {
  // A scraped website beats any guess. Reduce it to a registrable host.
  if (knownWebsite) {
    const host = extractHost(knownWebsite);
    if (host && (await hasMailExchanger(host))) {
      logger.debug(`[EmailFinder] Domain from website: ${host}`);
      return host;
    }
  }

  for (const candidate of domainCandidates(companyName)) {
    if (await hasMailExchanger(candidate)) {
      logger.debug(
        `[EmailFinder] Domain resolved for "${companyName}": ${candidate}`,
      );
      return candidate;
    }
  }

  logger.debug(`[EmailFinder] No mail domain found for "${companyName}"`);
  return null;
}

/** Strip scheme, path, port and a leading `www.` from a website URL. */
export function extractHost(website: string): string | null {
  const raw = website.trim();
  if (!raw) return null;

  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw)
    ? raw
    : `https://${raw}`;

  try {
    const host = new URL(withScheme).hostname.toLowerCase();
    return host.replace(/^www\./, '') || null;
  } catch {
    return null;
  }
}
