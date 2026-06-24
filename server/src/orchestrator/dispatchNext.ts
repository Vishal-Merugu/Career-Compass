import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { sendScrapeProfile } from '../ws-gateway/commands/sendScrapeProfile.js';

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

  // 4. Atomically select, lock, and update the next queued profile URL to 'dispatched'
  const nextUrl = await prisma.$transaction(async (tx) => {
    // Use raw query to atomically find and lock the next queued URL
    const rows = await tx.$queryRaw<any[]>`
      SELECT id FROM "ProfileUrl"
      WHERE "jobId" = ${jobId} AND status = 'queued'
      ORDER BY "createdAt" ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    `;

    if (!rows || rows.length === 0) return null;
    const itemId = rows[0].id;

    // Transition status to dispatched and increment attempt count
    return await tx.profileUrl.update({
      where: { id: itemId },
      data: {
        status: 'dispatched',
        dispatchedAt: new Date(),
        attempts: { increment: 1 },
      },
    });
  });

  if (!nextUrl) {
    logger.info(
      `[Orchestrator] No more queued URLs left to dispatch for Job ${jobId}.`,
    );
    return;
  }

  // 5. Send command to extension
  try {
    logger.info(
      `[Orchestrator] Dispatching profile URL ${nextUrl.url} (ID: ${nextUrl.id})`,
    );
    await sendScrapeProfile(jobId, nextUrl.id, nextUrl.url);
  } catch (err: any) {
    logger.error(
      err,
      `[Orchestrator] Failed sending scrape command for URL ID ${nextUrl.id}. Rolling back status to queued.`,
    );
    await prisma.profileUrl.update({
      where: { id: nextUrl.id },
      data: {
        status: 'queued',
        dispatchedAt: null,
        attempts: { decrement: 1 },
      },
    });
  }
}
