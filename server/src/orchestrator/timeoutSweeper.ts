import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { ConnectionRegistry } from '../ws-gateway/connectionRegistry.js';
import { dispatchNext } from './dispatchNext.js';

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
  }, intervalMs);
}

export function stopTimeoutSweeper(): void {
  if (sweeperInterval) {
    clearInterval(sweeperInterval);
    sweeperInterval = null;
    logger.info('[TimeoutSweeper] Timeout sweeper stopped.');
  }
}
