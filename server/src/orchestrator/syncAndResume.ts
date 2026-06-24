import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { sendFetchUrlBatch } from '../ws-gateway/commands/sendFetchUrlBatch.js';
import { sendStopLimitReached } from '../ws-gateway/commands/sendStopLimitReached.js';
import { sendSessionCheck } from '../ws-gateway/commands/sendSessionCheck.js';
import { dispatchNext } from './dispatchNext.js';

export async function syncAndResumeJob(jobId: string): Promise<void> {
  logger.info(
    `[Orchestrator] Emitting SESSION_CHECK before resuming Job ${jobId}`,
  );
  await sendSessionCheck(jobId);
}

export async function syncAndResumeJobImpl(jobId: string): Promise<void> {
  logger.info(`[Orchestrator] Running state sync and resume for Job ${jobId}`);

  // 1. Fetch job state
  const job = await prisma.searchJob.findUnique({
    where: { id: jobId },
  });

  if (!job) {
    logger.warn(`[Orchestrator] Job ${jobId} not found during sync & resume`);
    return;
  }

  const searchParams = (job.searchParams as any) || {};
  const batchSize = searchParams.batchSize || 100;

  // 2. Direct state flow
  switch (job.status) {
    case 'initializing':
      // Move to collecting urls on start
      await prisma.searchJob.update({
        where: { id: jobId },
        data: { status: 'collecting_urls' },
      });
      logger.info(
        `[Orchestrator] Job ${jobId} initialized. Starting URL collection.`,
      );
      await sendFetchUrlBatch(jobId, job.currentBatchNumber, batchSize);
      break;

    case 'collecting_urls':
      logger.info(
        `[Orchestrator] Job ${jobId} was in URL collection. Requesting batch collection.`,
      );
      await sendFetchUrlBatch(jobId, job.currentBatchNumber, batchSize);
      break;

    case 'scraping':
      logger.info(
        `[Orchestrator] Job ${jobId} was in scraping state. Resetting active scraper items to queued.`,
      );

      // Reset any active scraping items back to queued so they can be re-run
      await prisma.profileUrl.updateMany({
        where: {
          jobId,
          status: { in: ['dispatched', 'scraping'] },
        },
        data: {
          status: 'queued',
          dispatchedAt: null,
        },
      });

      // Dispatch the next item
      await dispatchNext(jobId);
      break;

    case 'completed':
      logger.info(
        `[Orchestrator] Job ${jobId} is already completed. Sending stop command.`,
      );
      await sendStopLimitReached(jobId);
      break;

    case 'paused_error':
      logger.info(
        `[Orchestrator] Job ${jobId} is currently paused/error. Syncing status but not resuming execution.`,
      );
      break;

    default:
      logger.warn(
        `[Orchestrator] Job ${jobId} has unhandled status "${job.status}"`,
      );
  }
}
