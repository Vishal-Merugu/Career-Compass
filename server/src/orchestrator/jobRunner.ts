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
import { recordJobEvent } from '../services/jobEvents.service.js';
import { pauseJobWithFailure } from '../services/jobControl.service.js';
import {
  normalizeProvider,
  providerLabel,
  resolveModel,
} from '../shared/llmClient.js';
import { PrismaStorageAdapter } from '../services/storage.adapter.js';
import { companySlugFromUrl } from '../lib/companyName.js';

interface SearchParams {
  companyUrl?: string;
  prompt?: string;
  batchSize?: number;
}

function companyLabel(searchParams: SearchParams): string {
  // `split('/').pop()` said "PEOPLE" for the URL the dashboard tells people to
  // paste (`/company/<slug>/people/`).
  const slug = companySlugFromUrl(searchParams.companyUrl);
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
    await pauseJobWithFailure(jobId, {
      stage: 'collect',
      code: 'COMPANY_NOT_FOUND',
      detail: 'The run was created without a company URL.',
    });
    return;
  }

  // Record what this run is actually about to use. A run that failed three days
  // ago cannot be explained by settings the user has since changed, and "which
  // model was this?" was unanswerable after the fact.
  const config = await new PrismaStorageAdapter(job.userId)
    .getConfig()
    .catch(() => null);

  const provider = config ? normalizeProvider(config) : 'server';
  const model = config ? resolveModel(config) : '';

  await prisma.searchJob.update({
    where: { id: jobId },
    data: {
      configSnapshot: {
        llmProvider: provider,
        llmModel: model,
        companyUrl: searchParams.companyUrl,
        limitRequested: job.limitRequested,
        batchSize,
      },
      failureCode: null,
      failureDetail: null,
    },
  });

  await recordJobEvent(jobId, {
    stage: 'run',
    code: 'RUN_STARTED',
    message: `Looking for ${job.limitRequested} profiles, judged by ${providerLabel(provider)}${model ? ` (${model})` : ''}.`,
  });

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
