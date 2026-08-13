import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { companySlugFromUrl } from '../lib/companyName.js';
import { sendStopLimitReached } from '../ws-gateway/commands/sendStopLimitReached.js';
import { collectNextBatch } from './jobRunner.js';
import { dispatchNext } from './dispatchNext.js';
import { telegramBotService } from '../telegram/bot.js';
import { recordJobEvent } from '../services/jobEvents.service.js';
import { pauseJobWithFailure } from '../services/jobControl.service.js';
import type { JobErrorCode } from '../errors/jobErrors.js';

/** No work of any kind should be scheduled for a job in one of these. */
const TERMINAL_OR_PAUSED = new Set([
  'completed',
  'paused_error',
  // Was missing, and its absence meant a run parked waiting for a fresh cookie
  // jar carried on dispatching profiles that could only fail the same way.
  'paused_session',
]);

export async function checkJobStopCondition(jobId: string): Promise<boolean> {
  logger.debug(`[Orchestrator] Checking stop condition for Job ${jobId}`);

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

  if (TERMINAL_OR_PAUSED.has(job.status)) {
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

    await recordJobEvent(jobId, {
      stage: 'run',
      code: 'RUN_COMPLETED',
      message: `Finished — ${updatedJob.qualifiedCount} of ${updatedJob.limitRequested} profiles qualified.`,
    });

    if (updatedJob.user?.telegramId) {
      const slug = companySlugFromUrl(
        (updatedJob.searchParams as { companyUrl?: string } | null)?.companyUrl,
      );
      const company = slug ? ` for ${slug.toUpperCase()}` : '';
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

  // Work that can still move on its own.
  const pendingUrlsCount = await prisma.profileUrl.count({
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

  // Scraped profiles whose only decision is an evaluation failure. These are
  // neither done nor movable: retrying them needs whatever broke to be fixed
  // first. They must not be counted as decided, or a run whose model died would
  // declare its batch exhausted and cheerfully collect another hundred people
  // to fail on — which is exactly what happened on 2026-08-09.
  const erroredCount = await prisma.profileUrl.count({
    where: {
      jobId,
      status: 'scraped',
      profile: {
        decisions: { some: { status: 'error' }, none: { status: 'qualified' } },
      },
    },
  });

  if (pendingUrlsCount === 0 && erroredCount > 0) {
    // Nothing left to try and some profiles never got a verdict. Park the run
    // rather than completing it — completing would claim a result the model
    // never produced — and let Resume retry them without re-scraping.
    logger.warn(
      `[Orchestrator] Job ${jobId} has ${erroredCount} unevaluated profile(s) and nothing pending; pausing`,
    );
    await pauseJobWithFailure(jobId, {
      stage: 'qualify',
      code: (job.failureCode as JobErrorCode | null) ?? 'LLM_BAD_JSON',
      detail: `${erroredCount} profile(s) were scraped but never evaluated. Resume to retry them — no LinkedIn calls are needed.`,
    });
    return true;
  }

  if (pendingUrlsCount === 0) {
    // Current batch is exhausted. Request next batch if search parameters allow it.
    const nextBatchNumber = job.currentBatchNumber + 1;

    // Default batch size: 100
    const searchParams = (job.searchParams as any) || {};
    const batchSize = searchParams.batchSize || 100;

    // Claim the next batch, rather than announcing it.
    //
    // This runs once per finished profile, and the last few finish within
    // milliseconds of each other — on 2026-08-13 two callers both read batch 13,
    // both wrote 14, and two collections for batch 14 ran side by side against
    // LinkedIn. The `currentBatchNumber` guard makes the write the arbiter: the
    // second caller updates no rows and goes home.
    const { count: claimed } = await prisma.searchJob.updateMany({
      where: {
        id: jobId,
        currentBatchNumber: job.currentBatchNumber,
        status: { notIn: [...TERMINAL_OR_PAUSED, 'collecting_urls'] },
      },
      data: {
        status: 'collecting_urls',
        currentBatchNumber: nextBatchNumber,
      },
    });

    if (claimed === 0) {
      logger.debug(
        `[Orchestrator] Job ${jobId} batch ${nextBatchNumber} already claimed elsewhere`,
      );
      return true;
    }

    logger.info(
      `[Orchestrator] Job ${jobId} batch ${job.currentBatchNumber} exhausted. Requesting batch ${nextBatchNumber} (size: ${batchSize}).`,
    );

    await recordJobEvent(jobId, {
      stage: 'collect',
      code: 'COLLECT_PROGRESS',
      message: `Batch ${job.currentBatchNumber} used up. Looking for more people (batch ${nextBatchNumber}).`,
    });

    // Collect it here rather than asking the extension. Not awaited: collection
    // walks several search pages at the configured pacing, and this runs inside
    // the qualification loop — blocking it would stall every decision behind a
    // minute of network calls. Failures park the job in `paused_error`.
    void collectNextBatch(jobId, nextBatchNumber, batchSize).catch((err) =>
      logger.error(
        err,
        `[Orchestrator] Next-batch collection failed for ${jobId}`,
      ),
    );
    return true;
  }

  // 4. If there are still active URLs in the queue, let the dispatcher check if it should dispatch the next one
  await dispatchNext(jobId);
  return false;
}
