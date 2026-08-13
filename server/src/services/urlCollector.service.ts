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
import { recordJobEvent } from './jobEvents.service.js';
import { pauseJobWithFailure } from './jobControl.service.js';

/** Voyager's people-search page size. Not ours to choose. */
const SEARCH_PAGE_SIZE = 12;

/**
 * How many search pages one batch may walk.
 *
 * Only reachable when page after page is people the job already has, which is
 * what a search running out looks like from here. Twice the pages a full batch
 * of new people would need, so a normal batch never sees it.
 */
const MAX_PAGES_PER_BATCH = 40;

export interface CollectResult {
  /**
   * URLs this batch actually added — **not** people it saw.
   *
   * The distinction is the whole batch loop: LinkedIn's people search happily
   * returns the same people again near the end of a company, and every one of
   * those upserts into a row that already exists. Counting them as collected
   * made a batch of pure duplicates look like 14 new people, so the run set
   * itself to `scraping` with nothing to scrape and stopped there forever
   * (job c1ee09f6, 2026-08-13, stuck at 13 of 50 with all 449 URLs decided).
   */
  collected: number;
  /** People the search returned, duplicates included. For the log line only. */
  seen: number;
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
      // `/showcase/` too: a showcase page is an organization like any other to
      // `q=universalName`, and its people search returns staff. See
      // `companySlugFromUrl`, which uses the same list for the run's label.
      const parts = url.pathname.split('/').filter(Boolean);
      const idx = parts.findIndex(
        (part) => part === 'company' || part === 'showcase',
      );
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
  let seen = 0;
  let pages = 0;
  let start = (batchNumber - 1) * targetCount;
  let exhausted = false;
  let interrupted = false;

  while (collected < targetCount) {
    if (pages >= MAX_PAGES_PER_BATCH) {
      // Pages of people the job already has. There is more to read in theory
      // and nothing new in practice, so treat it as the end of the search
      // rather than paging on until the rate limiter is the only brake.
      logger.warn(
        `[UrlCollector] Job ${jobId} batch ${batchNumber} walked ${pages} pages for ${collected} new URL(s); treating the search as exhausted`,
      );
      exhausted = true;
      break;
    }
    pages += 1;

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

    logger.debug(
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

      seen += 1;

      // `createMany` rather than `upsert` for the count it returns: 1 when the
      // row is new, 0 when this job already had the person. An upsert cannot
      // tell those apart, and the difference is what says whether the search
      // still has anything to give. `skipDuplicates` keeps the old behaviour —
      // a URL already collected keeps whatever status it reached, so nobody
      // gets re-scraped.
      const { count } = await prisma.profileUrl.createMany({
        data: [
          {
            jobId,
            batchNumber,
            url: `https://www.linkedin.com/in/${person.profileId}/`,
            status: 'queued',
            attempts: 0,
          },
        ],
        skipDuplicates: true,
      });

      collected += count;
    }

    const meta = parsePaginationMetadata(response);
    start += meta?.count || SEARCH_PAGE_SIZE;

    await apiDelay();
  }

  logger.info(
    `[UrlCollector] Collected ${collected} new URL(s) from ${seen} result(s) for job ${jobId} batch ${batchNumber}${exhausted ? ' (results exhausted)' : ''}`,
  );

  return { collected, seen, companyId, exhausted, interrupted };
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

    const { collected, seen, exhausted, interrupted } =
      await collectProfileUrls(
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

    // Nothing new, whether or not LinkedIn admitted the search was over.
    //
    // The `&& exhausted` this used to carry is why job c1ee09f6 hung: batch 14
    // returned 14 people the job already had, `collected` counted them, so the
    // run fell through to `scraping` with not one URL to scrape. Nothing
    // finishes, so nothing re-checks the stop condition, and a run that was
    // actually over sat at "reading profiles" for ten hours.
    if (collected === 0) {
      logger.warn(
        `[UrlCollector] No new URLs for job ${jobId} batch ${batchNumber} (${seen} duplicate result(s)); marking completed`,
      );
      await recordJobEvent(jobId, {
        stage: 'collect',
        code: 'NO_RESULTS',
        level: 'warn',
        message:
          seen > 0
            ? `LinkedIn has no more people for this search — the last ${seen} it returned were already collected, so the run is finished.`
            : 'LinkedIn returned no more people for this search, so the run is finished.',
      });
      await prisma.searchJob.update({
        where: { id: jobId },
        data: { status: 'completed' },
      });
      await recordJobEvent(jobId, {
        stage: 'run',
        code: 'RUN_COMPLETED',
        message: 'Finished — the search ran out of people before the target.',
      });
      return;
    }

    await recordJobEvent(jobId, {
      stage: 'collect',
      code: 'COLLECT_PROGRESS',
      message: `Batch ${batchNumber}: ${collected} new ${collected === 1 ? 'person' : 'people'} found${exhausted ? ' (no more available)' : ''}.`,
    });

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

    await pauseJobWithFailure(jobId, {
      stage: 'collect',
      // A session pause is resumable by pushing a fresh jar; anything else
      // needs a human, so it stays `paused_error`.
      status: paused ? JOB_STATUS_PAUSED_SESSION : undefined,
      code: paused
        ? 'SESSION_EXPIRED'
        : err instanceof ValidationError
          ? 'COMPANY_NOT_FOUND'
          : 'UNKNOWN',
      detail: err instanceof Error ? err.message : String(err),
    });

    if (!paused) throw err;
  }
}
