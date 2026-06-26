import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { sendStopLimitReached } from '../ws-gateway/commands/sendStopLimitReached.js';
import { sendFetchUrlBatch } from '../ws-gateway/commands/sendFetchUrlBatch.js';
import { dispatchNext } from './dispatchNext.js';
import { telegramBotService } from '../telegram/bot.js';

export async function checkJobStopCondition(jobId: string): Promise<boolean> {
  logger.info(`[Orchestrator] Checking stop condition for Job ${jobId}`);

  // 1. Fetch current job state
  const job = await prisma.searchJob.findUnique({
    where: { id: jobId },
  });

  if (!job) {
    logger.error(
      `[Orchestrator] Job ${jobId} not found in checkJobStopCondition`,
    );
    return true;
  }

  // If already completed or paused, do nothing
  if (job.status === 'completed' || job.status === 'paused_error') {
    return true;
  }

  // 2. Check if qualified limit has been reached
  if (job.qualifiedCount >= job.limitRequested) {
    logger.info(
      `[Orchestrator] Job ${jobId} limit reached: ${job.qualifiedCount}/${job.limitRequested}. Completing job.`,
    );

    // Skip remaining queued urls
    await prisma.profileUrl.updateMany({
      where: {
        jobId,
        status: 'queued',
      },
      data: {
        status: 'skipped',
      },
    });

    // Update job status to completed
    const updatedJob = await prisma.searchJob.update({
      where: { id: jobId },
      data: { status: 'completed' },
      include: { user: true },
    });

    if (updatedJob.user?.telegramId) {
      const company =
        updatedJob.searchParams &&
        typeof updatedJob.searchParams === 'object' &&
        'companyUrl' in (updatedJob.searchParams as any)
          ? ` for ${(updatedJob.searchParams as any).companyUrl.split('/').filter(Boolean).pop()?.toUpperCase()}`
          : '';
      telegramBotService
        .sendMessage(
          updatedJob.user!.telegramId!,
          `✅ *Workflow Completed${company}*\nQualified: ${updatedJob.qualifiedCount}/${updatedJob.limitRequested}`,
          { parse_mode: 'Markdown' },
        )
        .catch((err) =>
          logger.error(err, 'Failed to send telegram completion notification'),
        );
    }

    // Notify extension to stop
    await sendStopLimitReached(jobId);
    return true;
  }

  const unresolvedUrlsCount = await prisma.profileUrl.count({
    where: {
      jobId,
      OR: [
        { status: { in: ['queued', 'dispatched', 'scraping'] } },
        { status: 'scraped', profile: null },
        {
          status: 'scraped',
          profile: {
            decisions: { none: {} },
          },
        },
      ],
    },
  });

  if (unresolvedUrlsCount === 0) {
    // Current batch is exhausted. Request next batch if search parameters allow it.
    const nextBatchNumber = job.currentBatchNumber + 1;

    // Default batch size: 100
    const searchParams = (job.searchParams as any) || {};
    const batchSize = searchParams.batchSize || 100;

    logger.info(
      `[Orchestrator] Job ${jobId} batch ${job.currentBatchNumber} exhausted. Requesting batch ${nextBatchNumber} (size: ${batchSize}).`,
    );

    // Update job status back to collecting_urls
    await prisma.searchJob.update({
      where: { id: jobId },
      data: {
        status: 'collecting_urls',
        currentBatchNumber: nextBatchNumber,
      },
    });

    // Request extension to fetch next batch
    await sendFetchUrlBatch(jobId, nextBatchNumber, batchSize);
    return true;
  }

  // 4. If there are still active URLs in the queue, let the dispatcher check if it should dispatch the next one
  await dispatchNext(jobId);
  return false;
}
