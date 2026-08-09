// ─── Job runner ──────────────────────────────────────────────────
//
// Starts a run. Previously nothing here could: the job sat in `initializing`
// until the extension opened a socket and `syncAndResumeJob` asked it to collect
// URLs. With the LinkedIn calls on the server, the trigger is simply creating
// the job.
//
// Collection is awaited in the background rather than in the request: resolving
// a company and walking several search pages takes tens of seconds at the
// configured pacing, which is far too long to hold `POST /api/jobs` open.

import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { runCollection } from '../services/urlCollector.service.js';
import { telegramBotService } from '../telegram/bot.js';

interface SearchParams {
  companyUrl?: string;
  prompt?: string;
  batchSize?: number;
}

function companyLabel(searchParams: SearchParams): string {
  if (!searchParams.companyUrl) return '';
  const slug = searchParams.companyUrl.split('/').filter(Boolean).pop();
  return slug ? ` for ${slug.toUpperCase()}` : '';
}

/**
 * Begin collecting for a job, then hand off to the scrape worker.
 *
 * Fire-and-forget by design — the caller is an HTTP handler. Every failure path
 * inside `runCollection` already parks the job in `paused_error`, so a rejection
 * here only needs logging.
 */
export async function startJob(jobId: string): Promise<void> {
  const job = await prisma.searchJob.findUnique({
    where: { id: jobId },
    include: { user: { select: { telegramId: true } } },
  });

  if (!job) {
    logger.warn(`[JobRunner] Job ${jobId} vanished before it started`);
    return;
  }

  const searchParams = (job.searchParams ?? {}) as SearchParams;
  const batchSize = searchParams.batchSize || 100;

  if (job.user?.telegramId) {
    telegramBotService
      .sendMessage(
        job.user.telegramId,
        `🚀 *Workflow Started${companyLabel(searchParams)}*\nTarget: ${job.limitRequested} qualified profiles`,
        { parse_mode: 'Markdown' },
      )
      .catch((err) =>
        logger.error(err, '[JobRunner] Telegram start notice failed'),
      );
  }

  if (!searchParams.companyUrl) {
    logger.error(`[JobRunner] Job ${jobId} has no companyUrl; pausing`);
    await prisma.searchJob.update({
      where: { id: jobId },
      data: { status: 'paused_error' },
    });
    return;
  }

  await runCollection(
    job.userId,
    jobId,
    job.currentBatchNumber,
    batchSize,
    searchParams.companyUrl,
  );
}

/**
 * Collect the next batch when the current one runs dry before the target is met.
 *
 * Called from `checkJobStopCondition`, which is where the extension used to be
 * sent a `FETCH_URL_BATCH`.
 */
export async function collectNextBatch(
  jobId: string,
  batchNumber: number,
  batchSize: number,
): Promise<void> {
  const job = await prisma.searchJob.findUnique({
    where: { id: jobId },
    select: { userId: true, searchParams: true },
  });

  if (!job) return;

  const searchParams = (job.searchParams ?? {}) as SearchParams;
  if (!searchParams.companyUrl) return;

  await runCollection(
    job.userId,
    jobId,
    batchNumber,
    batchSize,
    searchParams.companyUrl,
  );
}
