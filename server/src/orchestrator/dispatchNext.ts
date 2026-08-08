import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';

export async function dispatchNext(jobId: string): Promise<void> {
  logger.info(
    `[Orchestrator] Attempting to dispatch next URL for Job ${jobId}`,
  );

  // 1. Fetch current job status
  const job = await prisma.searchJob.findUnique({
    where: { id: jobId },
  });

  if (!job || job.status !== 'scraping') {
    logger.debug(
      `[Orchestrator] Job ${jobId} is not in 'scraping' state (status: ${job?.status}). Dispatch ignored.`,
    );
    return;
  }

  // 2. Check the Scrape Ahead Buffer
  // active_scraped_count = count of profile urls with status = 'scraped'
  const scrapedCount = await prisma.profileUrl.count({
    where: {
      jobId,
      status: 'scraped',
    },
  });

  // decided_count = count of decisions made for this job
  const decidedCount = await prisma.profileDecision.count({
    where: {
      profile: {
        profileUrl: {
          jobId,
        },
      },
    },
  });

  const bufferLimit = 20;
  const inFlightCount = scrapedCount - decidedCount;

  if (inFlightCount >= bufferLimit) {
    logger.warn(
      `[Orchestrator] Scrape Ahead Buffer reached for Job ${jobId} (In-flight qualification: ${inFlightCount}/${bufferLimit}). Pausing scrapers.`,
    );
    return;
  }

  // 3. Atomically check if there is already a URL currently in progress ('dispatched' or 'scraping')
  // Since we require STRICTLY SERIAL execution (1 tab in flight at a time),
  // we do not dispatch a new URL if there is already one running.
  const activeScraping = await prisma.profileUrl.findFirst({
    where: {
      jobId,
      status: { in: ['dispatched', 'scraping'] },
    },
  });

  if (activeScraping) {
    logger.debug(
      `[Orchestrator] Job ${jobId} already has a profile scraping in progress (ID: ${activeScraping.id}, Status: ${activeScraping.status}). Skipping dispatch.`,
    );
    return;
  }

  // 4. Nudge the server-side scrape worker.
  //
  // This used to claim a queued URL and emit SCRAPE_PROFILE to the extension.
  // The scraping runs on the server now (workers/scrapeWorker.ts), which claims
  // its own row under a `status: 'queued'` guard — claiming here as well would
  // race it. The worker also polls on a timer, so this only removes the wait for
  // the next tick; a failure to run now is latency, not lost work.
  const { scrapeJobOnce } = await import('../workers/scrapeWorker.js');

  void scrapeJobOnce(jobId).catch((err) => {
    logger.error(
      err,
      `[Orchestrator] Immediate scrape pass failed for ${jobId}`,
    );
  });
}
