import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { ConnectionRegistry } from '../ws-gateway/connectionRegistry.js';
import { dispatchNext } from './dispatchNext.js';
import { checkJobStopCondition } from './stopCondition.js';

/**
 * How long a `scraping` job may sit without moving before we re-check it.
 *
 * Every advance of a run writes to the job or its URLs, so nothing legitimate
 * is quiet this long: the slowest thing here is one profile fetch plus one LLM
 * call, which is seconds. Generous anyway, because the cost of being early is a
 * duplicate stop-condition check and the cost of being late is a run that looks
 * alive and is not.
 */
const STALL_AFTER_MS = 10 * 60 * 1000;

/**
 * Re-check runs that say they are scraping but have nothing left to scrape.
 *
 * `checkJobStopCondition` is only ever called by something finishing — a
 * profile scraped, a profile judged. So a run that ends up with no movable work
 * and no verdict pending has nobody left to ask whether it is done, and stays
 * "reading profiles" forever. That is exactly what job c1ee09f6 did on
 * 2026-08-13: 449 of 449 read, every one judged, ten hours of nothing.
 *
 * The cause is fixed in `urlCollector`, but the shape of the failure is not
 * specific to it — anything that drops the last completion event lands here —
 * so the run's own state, not the event that should have fired, is what gets
 * checked.
 */
export async function sweepStalledJobs(): Promise<void> {
  const cutoff = new Date(Date.now() - STALL_AFTER_MS);

  try {
    const stalled = await prisma.searchJob.findMany({
      where: {
        status: 'scraping',
        updatedAt: { lt: cutoff },
        // Nothing queued, in flight, or waiting on a verdict. Anything here and
        // the run is simply working, however slowly.
        profileUrls: {
          none: {
            OR: [
              { status: { in: ['queued', 'dispatched', 'scraping'] } },
              { status: 'scraped', profile: null },
              { status: 'scraped', profile: { decisions: { none: {} } } },
            ],
          },
        },
      },
      select: { id: true },
    });

    for (const job of stalled) {
      logger.warn(
        `[TimeoutSweeper] Job ${job.id} is scraping with nothing left to scrape; re-checking its stop condition`,
      );
      await checkJobStopCondition(job.id);
    }
  } catch (err) {
    logger.error(err, '[TimeoutSweeper] Error sweeping stalled jobs');
  }
}

export async function sweepStuckProfileUrls(): Promise<void> {
  const timeoutLimit = new Date(Date.now() - 2 * 60 * 1000); // 2 minutes ago

  logger.debug(
    '[TimeoutSweeper] Running sweep scan for stuck profile tasks...',
  );

  try {
    const stuckUrls = await prisma.profileUrl.findMany({
      where: {
        status: { in: ['dispatched', 'scraping'] },
        dispatchedAt: { lt: timeoutLimit },
      },
    });

    if (stuckUrls.length === 0) {
      return;
    }

    logger.warn(
      `[TimeoutSweeper] Found ${stuckUrls.length} stuck profile tasks. Resetting to queued.`,
    );

    const jobIdsToResume = new Set<string>();

    for (const stuckUrl of stuckUrls) {
      jobIdsToResume.add(stuckUrl.jobId);

      await prisma.profileUrl.update({
        where: { id: stuckUrl.id },
        data: {
          status: 'queued',
          dispatchedAt: null,
          lastError: 'Scrape timed out (older than 2 minutes)',
        },
      });
    }

    // Check if jobs have active connections and resume if possible
    const registry = ConnectionRegistry.getInstance();
    for (const jobId of jobIdsToResume) {
      const activeSocketId = registry.getSocketId(jobId);
      if (activeSocketId) {
        logger.info(
          `[TimeoutSweeper] Job ${jobId} has an active connection. Triggering dispatch.`,
        );
        dispatchNext(jobId).catch((err) => {
          logger.error(
            err,
            `[TimeoutSweeper] Error resuming dispatch for Job ${jobId}`,
          );
        });
      }
    }
  } catch (err) {
    logger.error(err, '[TimeoutSweeper] Error sweeping stuck profile URLs');
  }
}

let sweeperInterval: NodeJS.Timeout | null = null;

export function startTimeoutSweeper(intervalMs = 30000): void {
  if (sweeperInterval) return;

  logger.info(
    `[TimeoutSweeper] Starting timeout sweeper interval (every ${intervalMs / 1000}s)`,
  );
  sweeperInterval = setInterval(() => {
    sweepStuckProfileUrls().catch((err) => {
      logger.error(
        err,
        '[TimeoutSweeper] Unhandled exception in interval execution',
      );
    });
    sweepStalledJobs().catch((err) => {
      logger.error(
        err,
        '[TimeoutSweeper] Unhandled exception sweeping stalled jobs',
      );
    });
  }, intervalMs);
}

export function stopTimeoutSweeper(): void {
  if (sweeperInterval) {
    clearInterval(sweeperInterval);
    sweeperInterval = null;
    logger.info('[TimeoutSweeper] Timeout sweeper stopped.');
  }
}
