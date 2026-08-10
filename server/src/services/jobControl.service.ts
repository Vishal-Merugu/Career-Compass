// ─── Stopping a run, and saying why ──────────────────────────────
//
// One place that pauses a job, so the four things that must happen together
// cannot drift apart: the status, the denormalised failure code the Runs list
// reads, the event the run page reads, and the Telegram notice.
//
// Before this, `scrapeWorker` pumped its own Telegram message and set a status,
// `urlCollector` set a status and nothing else, and `qualificationWorker` did
// not pause at all — which is why a run whose model was unreachable simply kept
// going, rejecting every profile it fetched.

import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import {
  describeJobError,
  type JobErrorCode,
  type JobErrorContext,
} from '../errors/jobErrors.js';
import { recordJobEvent, type JobStage } from './jobEvents.service.js';
import { telegramBotService } from '../telegram/bot.js';

/**
 * Only `paused_session` is auto-resumed when a fresh cookie jar arrives.
 * Everything else needs a human, including a manual pause — a run the user
 * deliberately stopped must not restart itself on the next 30-minute sync.
 */
export const JOB_STATUS_PAUSED_ERROR = 'paused_error';

export interface PauseOptions {
  stage: JobStage;
  code: JobErrorCode;
  detail?: string | null;
  ctx?: JobErrorContext;
  /** `paused_session` for a dead cookie jar; `paused_error` otherwise. */
  status?: string;
}

/**
 * Park a run and record, in one place, everything needed to explain it later.
 *
 * Safe to call on a job that is already paused — the write is idempotent and
 * the event rolls up rather than duplicating.
 */
export async function pauseJobWithFailure(
  jobId: string,
  options: PauseOptions,
): Promise<void> {
  const status = options.status ?? JOB_STATUS_PAUSED_ERROR;
  const { message, fix } = describeJobError(options.code, options.ctx ?? {});

  logger.error(
    `[JobControl] Pausing job ${jobId} (${status}): ${options.code} — ${message}`,
  );

  const job = await prisma.searchJob.update({
    where: { id: jobId },
    data: {
      status,
      failureCode: options.code,
      failureDetail: options.detail ?? null,
    },
    select: { user: { select: { telegramId: true } } },
  });

  await recordJobEvent(jobId, {
    stage: options.stage,
    code: options.code,
    level: 'error',
    message: `${message} ${fix}`,
    detail: options.detail ?? null,
  });

  if (job.user?.telegramId) {
    await telegramBotService
      .sendMessage(
        job.user.telegramId,
        `🔴 *Run paused*\n${message}\n\n${fix}`,
        {
          parse_mode: 'Markdown',
        },
      )
      .catch((err) =>
        logger.error(err, '[JobControl] Telegram pause notice failed'),
      );
  }
}

/**
 * Clear a recorded failure, on resume.
 *
 * Without this a run that was fixed and resumed keeps showing the error that
 * stopped it, and the Runs list keeps counting it under "needs attention".
 */
export async function clearJobFailure(jobId: string): Promise<void> {
  await prisma.searchJob.update({
    where: { id: jobId },
    data: { failureCode: null, failureDetail: null },
  });
}
