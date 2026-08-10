// ─── Scrape worker (server side) ─────────────────────────────────
//
// Calls LinkedIn's Voyager API from the server, replacing the
// `SCRAPE_PROFILE` → `PROFILE_SCRAPED` round trip through the extension.
//
// This reverses ADR 0001, which had the extension execute every LinkedIn call
// so the traffic came from a real logged-in browser. What made the reversal
// safe is measurement, not optimism: a `--long` probe ran 14/14 clean across
// 3.5 h from the deployment host, which egresses via the university NAT rather
// than a datacenter ASN. See docs/adr/0007-server-side-linkedin-calls.md.
//
// The pacing and buffer rules are unchanged from the orchestrator, because they
// were never about where the call came from:
//
//   * One profile in flight per job. Strictly serial.
//   * Stop when 20 scraped profiles are waiting on qualification.
//   * `apiDelay()` between calls. **Do not "optimise" this** — the ceiling is
//     15 connection requests/day, so a full day is under 10 minutes of runtime.
//
// A dead session pauses the job rather than failing the URL: the profile is
// fine, the credential is not, and marking URLs failed would silently skip
// reachable people.

import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { LinkedInSessionError } from '../errors/AppError.js';
import { parseFullProfile } from '../shared/parsers.js';
import { apiDelay } from '../shared/rateLimiter.js';
import {
  JOB_STATUS_PAUSED_SESSION,
  withVoyager,
} from '../services/linkedinSession.service.js';
import {
  ingestScrapeFailure,
  ingestScrapedProfile,
  isPermanentScrapeError,
  type ScrapedRawData,
} from '../services/scrapeIngest.service.js';
import { recordJobEvent } from '../services/jobEvents.service.js';
import { pauseJobWithFailure } from '../services/jobControl.service.js';

const POLL_INTERVAL_MS = 5_000;

/** Matches the orchestrator's buffer, for the same reason it exists there. */
const QUALIFY_BUFFER_LIMIT = 20;

let timer: NodeJS.Timeout | null = null;
let running = false;

/** `.../in/<slug>/...` → `<slug>`. Voyager wants the vanity name, not a URL. */
export function memberIdentityFromUrl(url: string): string | null {
  const parts = url.split('/in/');
  if (parts.length <= 1) return null;
  const identity = parts[1].split('/')[0].split('?')[0];
  return identity || null;
}

/**
 * Reshape a parsed profile into the `rawData` the pipeline already stores.
 *
 * Kept byte-compatible with what the extension used to emit: the qualification
 * worker reads `experience[].company`, `summary` and `publicIdentifier`, and
 * rows scraped before this change have exactly these keys.
 */
export function toRawData(
  parsed: ReturnType<typeof parseFullProfile>,
): ScrapedRawData {
  return {
    name: `${parsed.firstName} ${parsed.lastName}`.trim(),
    headline: parsed.headline,
    location: parsed.location || '',
    summary: parsed.about,
    about: parsed.about,
    publicIdentifier: parsed.publicIdentifier || '',
    experience: parsed.experiences.map((exp) => ({
      title: exp.title,
      company: exp.companyName,
      companyName: exp.companyName,
      startDate: exp.timePeriod?.startDate || {},
      endDate: exp.timePeriod?.endDate || {},
      timePeriod: exp.timePeriod || {},
    })),
    experiences: parsed.experiences,
    education: parsed.education,
    skills: parsed.skills,
  };
}

/**
 * Claim one queued URL for a job, or null.
 *
 * The `status: 'queued'` guard on `updateMany` is what makes this safe to call
 * from more than one place — a row can only be claimed once, so the WS path and
 * this worker cannot both scrape the same profile.
 */
async function claimNextUrl(
  jobId: string,
): Promise<{ id: string; url: string } | null> {
  const inFlight = await prisma.profileUrl.findFirst({
    where: { jobId, status: { in: ['dispatched', 'scraping'] } },
    select: { id: true },
  });
  if (inFlight) return null;

  const candidate = await prisma.profileUrl.findFirst({
    where: { jobId, status: 'queued' },
    orderBy: { createdAt: 'asc' },
    select: { id: true, url: true },
  });
  if (!candidate) return null;

  const { count } = await prisma.profileUrl.updateMany({
    where: { id: candidate.id, status: 'queued' },
    data: {
      status: 'scraping',
      dispatchedAt: new Date(),
      attempts: { increment: 1 },
    },
  });

  return count === 1 ? candidate : null;
}

/** True when qualification is lagging far enough behind to stop scraping. */
async function bufferFull(jobId: string): Promise<boolean> {
  const [scraped, decided] = await Promise.all([
    prisma.profileUrl.count({ where: { jobId, status: 'scraped' } }),
    prisma.profileDecision.count({
      where: { profile: { profileUrl: { jobId } } },
    }),
  ]);

  return scraped - decided >= QUALIFY_BUFFER_LIMIT;
}

async function scrapeOne(
  userId: string,
  jobId: string,
  urlRow: { id: string; url: string },
): Promise<void> {
  const identity = memberIdentityFromUrl(urlRow.url);

  if (!identity) {
    await ingestScrapeFailure(
      jobId,
      urlRow.id,
      `Invalid LinkedIn profile URL: ${urlRow.url}`,
      true,
    );
    return;
  }

  // debug, not info: one line per profile is 400 lines per run in a log an
  // operator shares with every other user. The run's own event log carries
  // progress now, at a rate a person can read.
  logger.debug(`[ScrapeWorker] Fetching ${identity} for job ${jobId}`);

  try {
    const response = await withVoyager(userId, (client) =>
      client.fetchFullProfile(identity),
    );

    await ingestScrapedProfile(
      jobId,
      urlRow.id,
      toRawData(parseFullProfile(response)),
    );

    await recordScrapeProgress(jobId);
  } catch (err) {
    // A dead session is not this profile's fault. Pause the job, leave the URL
    // queued, and tell the user — the fix is pushing a fresh jar, and every
    // remaining URL would fail identically until then.
    if (err instanceof LinkedInSessionError) {
      await prisma.profileUrl.update({
        where: { id: urlRow.id },
        data: { status: 'queued', dispatchedAt: null },
      });
      await pauseForDeadSession(jobId, err.message);
      return;
    }

    const message = err instanceof Error ? err.message : String(err);
    await ingestScrapeFailure(
      jobId,
      urlRow.id,
      message,
      isPermanentScrapeError(message),
    );
  }
}

async function pauseForDeadSession(
  jobId: string,
  reason: string,
): Promise<void> {
  // `paused_session`, not `paused_error`: only the former is auto-resumed when
  // the extension pushes a fresh jar. The Telegram notice and the failure code
  // come from jobControl, so every pause reads the same way wherever it is seen.
  await pauseJobWithFailure(jobId, {
    stage: 'scrape',
    status: JOB_STATUS_PAUSED_SESSION,
    code: 'SESSION_EXPIRED',
    detail: reason,
  });
}

/** Rolling progress, at a rate that keeps the run log readable. */
const PROGRESS_EVERY = 25;

async function recordScrapeProgress(jobId: string): Promise<void> {
  const [scraped, collected] = await Promise.all([
    prisma.profileUrl.count({ where: { jobId, status: 'scraped' } }),
    prisma.profileUrl.count({ where: { jobId } }),
  ]);

  if (scraped === 0 || scraped % PROGRESS_EVERY !== 0) return;

  await recordJobEvent(jobId, {
    stage: 'scrape',
    code: 'SCRAPE_PROGRESS',
    message: `${scraped} of ${collected} profiles read from LinkedIn.`,
  });
}

/**
 * Run one scrape pass for a single job, now.
 *
 * Exists so `dispatchNext` can remove the wait for the next poll after a
 * profile finishes qualifying. Shares the `running` guard with the timer, so a
 * nudge arriving mid-tick is dropped rather than doubling up.
 */
export async function scrapeJobOnce(jobId: string): Promise<void> {
  if (running) return;
  running = true;

  try {
    const job = await prisma.searchJob.findFirst({
      where: { id: jobId, status: 'scraping' },
      select: { id: true, userId: true },
    });
    if (!job) return;
    if (await bufferFull(job.id)) return;

    const urlRow = await claimNextUrl(job.id);
    if (!urlRow) return;

    await scrapeOne(job.userId, job.id, urlRow);
  } catch (err) {
    logger.error(err, `[ScrapeWorker] Single pass failed for job ${jobId}`);
  } finally {
    running = false;
  }
}

/**
 * Jobs whose collection this process is already driving.
 *
 * Collection is fire-and-forget and can run for minutes, so without this the
 * next tick would start a second collector for the same job.
 */
const collecting = new Set<string>();

/**
 * Resume collection for jobs stuck in `collecting_urls`.
 *
 * The extension's REGISTER used to do this. It no longer does — two collectors
 * per job was the result — so a server restart mid-collection would otherwise
 * leave the job parked forever with nobody to finish it.
 */
async function resumeStalledCollection(): Promise<void> {
  const stalled = await prisma.searchJob.findMany({
    where: { status: 'collecting_urls' },
    select: { id: true, currentBatchNumber: true, searchParams: true },
  });

  for (const job of stalled) {
    if (collecting.has(job.id)) continue;

    const params = (job.searchParams ?? {}) as { batchSize?: number };
    collecting.add(job.id);

    const { collectNextBatch } = await import('../orchestrator/jobRunner.js');

    void collectNextBatch(
      job.id,
      job.currentBatchNumber,
      params.batchSize || 100,
    )
      .catch((err) =>
        logger.error(
          err,
          `[ScrapeWorker] Resumed collection failed for ${job.id}`,
        ),
      )
      .finally(() => collecting.delete(job.id));
  }
}

async function tick(): Promise<void> {
  // A scrape plus its pacing delay easily outlasts the poll interval.
  if (running) return;
  running = true;

  try {
    await resumeStalledCollection();

    const jobs = await prisma.searchJob.findMany({
      where: { status: 'scraping' },
      select: { id: true, userId: true },
    });

    for (const job of jobs) {
      if (await bufferFull(job.id)) {
        logger.debug(
          `[ScrapeWorker] Buffer full for job ${job.id}; waiting on qualification`,
        );
        continue;
      }

      const urlRow = await claimNextUrl(job.id);
      if (!urlRow) continue;

      await scrapeOne(job.userId, job.id, urlRow);

      // Between profiles, not before the first: a job that just started should
      // not sit idle for 3 s before its first call.
      await apiDelay();
    }
  } catch (err) {
    logger.error(err, '[ScrapeWorker] Tick failed');
  } finally {
    running = false;
  }
}

export function startScrapeWorker(): void {
  if (timer) return;

  logger.info('[ScrapeWorker] Started — LinkedIn calls run server-side');
  timer = setInterval(() => void tick(), POLL_INTERVAL_MS);
  timer.unref();
}

export function stopScrapeWorker(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}
