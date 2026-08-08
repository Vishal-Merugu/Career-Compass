// ─── URL collection (server side) ────────────────────────────────
//
// Turns a LinkedIn company search URL into `ProfileUrl` rows, replacing the
// `FETCH_URL_BATCH` → `URL_BATCH_ITEM` → `URL_BATCH_COMPLETE` conversation with
// the extension.
//
// Two Voyager calls live here: `resolveCompany` (slug → numeric company id) and
// `searchPeople` (paged people search). Both are read-only and low-volume — one
// company resolution and a handful of search pages per batch — which is why they
// were the safest of the calls to move.
//
// See docs/adr/0007-server-side-linkedin-calls.md.

import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { LinkedInSessionError, ValidationError } from '../errors/AppError.js';
import {
  parsePaginationMetadata,
  parsePeopleSearchResults,
} from '../shared/parsers.js';
import { apiDelay } from '../shared/rateLimiter.js';
import {
  JOB_STATUS_PAUSED_SESSION,
  withVoyager,
} from './linkedinSession.service.js';

/** Voyager's people-search page size. Not ours to choose. */
const SEARCH_PAGE_SIZE = 12;

export interface CollectResult {
  collected: number;
  companyId: string;
  exhausted: boolean;
  /** True when a pause or cancel ended the loop early. */
  interrupted: boolean;
}

interface SearchTarget {
  companyId: string;
  geoId: string;
}

/**
 * Pull the company and geo out of a saved search URL.
 *
 * Ported from the extension's `getSearchParamsFromUrl`. LinkedIn writes the geo
 * filter as a JSON array in `geoUrn`, sometimes with the brackets URL-encoded
 * away, so both forms are handled.
 */
export function parseSearchUrl(searchUrl: string): {
  companyId: string;
  geoId: string;
  companySlug: string;
} {
  let companyId = '';
  // Same default the extension shipped. `searchPeople` cannot substitute its own
  // for an empty string, so dropping this sent `(key:geoUrn,value:List())` for
  // any company URL without a `geoUrn` param.
  let geoId = '101282230';
  let companySlug = '';

  try {
    const url = new URL(searchUrl);

    companyId =
      url.searchParams.get('currentCompany')?.replace(/\D/g, '') ?? '';

    const geoUrn = url.searchParams.get('geoUrn');
    if (geoUrn) {
      try {
        const parsed: unknown = JSON.parse(geoUrn);
        geoId = Array.isArray(parsed) ? String(parsed[0]) : String(parsed);
      } catch {
        // `["103644278"]` arrives unparseable often enough to be worth a regex.
        const match = /"([^"]+)"/.exec(geoUrn);
        geoId = match ? match[1] : geoUrn;
      }
    }

    if (!companyId) {
      const parts = url.pathname.split('/').filter(Boolean);
      const idx = parts.indexOf('company');
      companySlug =
        idx !== -1 && parts[idx + 1]
          ? parts[idx + 1]
          : (url.searchParams.get('keywords') ?? '');
    }
  } catch (err) {
    logger.error(err, `[UrlCollector] Unparseable search URL: ${searchUrl}`);
  }

  return { companyId, geoId, companySlug };
}

/** Voyager returns the company as an urn; the search API wants the trailing id. */
function companyIdFromResolve(response: unknown): string {
  const body = response as
    | {
        data?: { '*elements'?: unknown[] };
        '*elements'?: unknown[];
      }
    | undefined;

  const elements = body?.data?.['*elements'] ?? body?.['*elements'] ?? [];
  const first = elements[0];

  if (typeof first === 'string') return first.split(':').pop() ?? '';

  const targetUrn = (first as { targetUrn?: unknown } | undefined)?.targetUrn;
  return typeof targetUrn === 'string'
    ? (targetUrn.split(':').pop() ?? '')
    : '';
}

async function resolveTarget(
  userId: string,
  searchUrl: string,
): Promise<SearchTarget> {
  const { companyId, geoId, companySlug } = parseSearchUrl(searchUrl);

  if (companyId) return { companyId, geoId };

  if (!companySlug) {
    throw new ValidationError(
      `Could not find a company in the search URL: ${searchUrl}`,
    );
  }

  logger.info(`[UrlCollector] Resolving company slug "${companySlug}"`);

  const resolved = await withVoyager(userId, (client) =>
    client.resolveCompany(companySlug),
  );

  const id = companyIdFromResolve(resolved);

  if (!id) {
    throw new ValidationError(
      `LinkedIn returned no company for "${companySlug}"`,
    );
  }

  return { companyId: id, geoId };
}

/**
 * Collect up to `targetCount` profile URLs for a batch.
 *
 * Idempotent per URL: the `(jobId, url)` unique constraint means re-running a
 * batch tops it up rather than duplicating, and a URL already scraped keeps its
 * status instead of being reset to `queued`.
 */
export async function collectProfileUrls(
  userId: string,
  jobId: string,
  batchNumber: number,
  targetCount: number,
  searchUrl: string,
): Promise<CollectResult> {
  const { companyId, geoId } = await resolveTarget(userId, searchUrl);

  let collected = 0;
  let start = (batchNumber - 1) * targetCount;
  let exhausted = false;
  let interrupted = false;

  while (collected < targetCount) {
    // Re-read the job each page: a cancel or pause arriving mid-collection
    // should stop us, and this loop can run for a minute or more.
    const job = await prisma.searchJob.findUnique({
      where: { id: jobId },
      select: { status: true },
    });

    if (
      !job ||
      !['collecting_urls', 'initializing', 'scraping'].includes(job.status)
    ) {
      logger.info(
        `[UrlCollector] Job ${jobId} left the collecting state (${job?.status ?? 'gone'}); stopping`,
      );
      interrupted = true;
      break;
    }

    logger.info(
      `[UrlCollector] Search page start=${start} for company ${companyId}`,
    );

    const response = await withVoyager(userId, (client) =>
      client.searchPeople(companyId, geoId, start, SEARCH_PAGE_SIZE),
    );

    const people = parsePeopleSearchResults(response);

    if (people.length === 0) {
      exhausted = true;
      break;
    }

    for (const person of people) {
      if (collected >= targetCount) break;
      if (!person.profileId) continue;

      await prisma.profileUrl.upsert({
        where: {
          jobId_url: {
            jobId,
            url: `https://www.linkedin.com/in/${person.profileId}/`,
          },
        },
        create: {
          jobId,
          batchNumber,
          url: `https://www.linkedin.com/in/${person.profileId}/`,
          status: 'queued',
          attempts: 0,
        },
        // Deliberately empty: a URL already collected keeps whatever status it
        // reached. Resetting it here would re-scrape people already done.
        update: {},
      });

      collected += 1;
    }

    const meta = parsePaginationMetadata(response);
    start += meta?.count || SEARCH_PAGE_SIZE;

    await apiDelay();
  }

  logger.info(
    `[UrlCollector] Collected ${collected} URL(s) for job ${jobId} batch ${batchNumber}${exhausted ? ' (results exhausted)' : ''}`,
  );

  return { collected, companyId, exhausted, interrupted };
}

/**
 * Collect, then move the job into scraping — the state the scrape worker acts
 * on.
 *
 * A dead session pauses the job instead of failing it: nothing is wrong with the
 * search, and every subsequent call would fail the same way until a fresh jar
 * arrives.
 */
export async function runCollection(
  userId: string,
  jobId: string,
  batchNumber: number,
  targetCount: number,
  searchUrl: string,
): Promise<void> {
  try {
    await prisma.searchJob.update({
      where: { id: jobId },
      data: { status: 'collecting_urls', currentBatchNumber: batchNumber },
    });

    const { collected, exhausted, interrupted } = await collectProfileUrls(
      userId,
      jobId,
      batchNumber,
      targetCount,
      searchUrl,
    );

    // The loop noticed a pause or cancel and stopped. Writing `scraping` here
    // would undo exactly the state the user asked for — the pause would appear
    // to do nothing.
    if (interrupted) {
      logger.info(
        `[UrlCollector] Job ${jobId} was paused or cancelled mid-collection; leaving its status alone`,
      );
      return;
    }

    if (collected === 0 && exhausted) {
      logger.warn(
        `[UrlCollector] No URLs found for job ${jobId}; marking completed`,
      );
      await prisma.searchJob.update({
        where: { id: jobId },
        data: { status: 'completed' },
      });
      return;
    }

    await prisma.searchJob.update({
      where: { id: jobId },
      data: { status: 'scraping' },
    });
  } catch (err) {
    const paused = err instanceof LinkedInSessionError;

    logger.error(
      err,
      `[UrlCollector] Collection failed for job ${jobId}${paused ? ' (session)' : ''}`,
    );

    await prisma.searchJob.update({
      where: { id: jobId },
      // A session pause is resumable by pushing a fresh jar; anything else needs
      // a human, so it stays `paused_error`.
      data: { status: paused ? JOB_STATUS_PAUSED_SESSION : 'paused_error' },
    });

    if (!paused) throw err;
  }
}
