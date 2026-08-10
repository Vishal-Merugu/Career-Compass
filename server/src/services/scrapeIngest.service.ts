// ─── Scrape ingest ───────────────────────────────────────────────
//
// What to do with a scraped profile, independent of who scraped it.
//
// Two callers: the server-side scrape worker (the normal path now) and the
// `PROFILE_SCRAPED` WebSocket handler (the extension path, kept as a fallback).
// Both must write the same rows and advance the job the same way, so the logic
// lives here rather than being written twice and drifting.

import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { QualificationWorker } from '../workers/qualificationWorker.js';
import { checkJobStopCondition } from '../orchestrator/stopCondition.js';

/**
 * The shape the pipeline stores in `ScrapedProfile.rawData`.
 *
 * Mirrors what the extension used to send over `PROFILE_SCRAPED`, kept
 * identical on purpose: `qualificationWorker` reads `experience[].company`,
 * `summary` and `publicIdentifier` off it, and historical rows already have
 * this shape.
 */
export interface ScrapedRawData {
  name: string;
  headline?: string;
  location?: string;
  summary?: string;
  about?: string;
  publicIdentifier?: string;
  experience?: Array<{
    title?: string;
    company?: string;
    companyName?: string;
    /** "Work Study", "Internship", … — absent on rows scraped before 2026-08-10. */
    employmentType?: string;
    startDate?: unknown;
    endDate?: unknown;
    timePeriod?: unknown;
  }>;
  experiences?: unknown;
  education?: unknown;
  skills?: unknown;
}

/**
 * Record a successful scrape and move the job forward.
 *
 * `dispatchNext` is imported lazily because `dispatchNext` → `sendScrapeProfile`
 * → the ws-gateway, and the gateway imports back into the orchestrator. A static
 * import here closes that cycle at module load.
 */
export async function ingestScrapedProfile(
  jobId: string,
  urlId: string,
  rawData: ScrapedRawData,
): Promise<void> {
  await prisma.profileUrl.update({
    where: { id: urlId },
    data: { status: 'scraped', scrapedAt: new Date() },
  });

  const currentCompany = rawData.experience?.[0]?.company || null;

  const scrapedProfile = await prisma.scrapedProfile.upsert({
    where: { profileUrlId: urlId },
    update: {
      name: rawData.name,
      headline: rawData.headline || null,
      about: rawData.about || null,
      company: currentCompany,
      location: rawData.location || null,
      rawData: JSON.parse(JSON.stringify(rawData)),
      scrapedAt: new Date(),
    },
    create: {
      profileUrlId: urlId,
      name: rawData.name,
      headline: rawData.headline || null,
      about: rawData.about || null,
      company: currentCompany,
      location: rawData.location || null,
      rawData: JSON.parse(JSON.stringify(rawData)),
    },
  });

  // LLM evaluation and email discovery, out of band.
  QualificationWorker.getInstance().enqueue(jobId, urlId, scrapedProfile.id);

  const { dispatchNext } = await import('../orchestrator/dispatchNext.js');
  await dispatchNext(jobId);
}

/**
 * Record a failed scrape.
 *
 * `isPermanent` decides whether the URL is ever retried: a 403 or 404 means the
 * profile is out of reach for this account, and re-queuing it just burns
 * attempts against the daily budget.
 */
export async function ingestScrapeFailure(
  jobId: string,
  urlId: string,
  error: string,
  isPermanent: boolean,
): Promise<void> {
  logger.warn(
    `[ScrapeIngest] Scrape failed for job ${jobId}, url ${urlId} (${isPermanent ? 'permanent' : 'retryable'}): ${error}`,
  );

  await prisma.profileUrl.update({
    where: { id: urlId },
    data: {
      status: isPermanent ? 'failed_permanent' : 'failed_retryable',
      lastError: error,
    },
  });

  await checkJobStopCondition(jobId);
}

/**
 * A 403 or 404 is the profile's answer, not a transient fault.
 *
 * Note what is *not* here: a dead session also surfaces as a 403-ish failure,
 * but that is caught upstream as `LinkedInSessionError` and pauses the whole
 * job — marking a URL permanently failed because the session expired would
 * quietly skip profiles that are perfectly reachable.
 */
export function isPermanentScrapeError(message: string): boolean {
  return /(→|status)\s*40[34]/.test(message) || /\b40[34]\b/.test(message);
}
