// ─── The per-run event log ───────────────────────────────────────
//
// What the person who started the run reads to find out what happened. Not the
// server log: that one is for an operator, is shared by every user, and on the
// VM is currently a solid wall of Telegram 409s with the real failure buried
// somewhere inside it.
//
// The design constraint is **readability, not completeness**. A 400-profile run
// should produce 20–40 rows. Two rules get it there:
//
//   1. Repeats never insert. `@@unique([jobId, stage, code])` means a second
//      occurrence can only `upsert` — it bumps `count` and refreshes the
//      message. A failure that recurs 300 times is one line reading "×300",
//      and a progress line rewrites itself in place rather than accumulating.
//
//   2. Individual profiles are not events. Rejections are the bulk of the
//      volume and the least informative thing here; qualified profiles are
//      listed on the run page as people, which is more useful than a log line
//      about them. The log carries lifecycle and problems.
//
// Every write goes through `recordJobEvent`. Calling `prisma.jobEvent.create`
// at a call site bypasses the roll-up, and one such call site is all it takes
// for the log to become the thing nobody reads.

import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import {
  describeJobError,
  type JobErrorCode,
  type JobErrorContext,
} from '../errors/jobErrors.js';

export type JobStage =
  'run' | 'collect' | 'scrape' | 'qualify' | 'publish' | 'email';

export type JobEventLevel = 'info' | 'warn' | 'error';

/** Lifecycle keys. Errors use a `JobErrorCode` instead. */
export type JobLifecycleCode =
  | 'RUN_STARTED'
  | 'RUN_PAUSED'
  | 'RUN_RESUMED'
  | 'RUN_COMPLETED'
  | 'RUN_CANCELLED'
  | 'COLLECT_PROGRESS'
  | 'SCRAPE_PROGRESS'
  | 'QUALIFY_PROGRESS';

export type JobEventCode = JobLifecycleCode | JobErrorCode;

export interface JobEventInput {
  stage: JobStage;
  code: JobEventCode;
  /** One plain sentence, already written for a human. */
  message: string;
  level?: JobEventLevel;
  /** Raw provider output. Collapsed in the UI; never the headline. */
  detail?: string | null;
  profileRef?: string | null;
}

/** Long enough to diagnose, short enough not to bloat the row. */
const DETAIL_MAX = 2000;

/**
 * Record one event, rolling a repeat up into the existing row.
 *
 * Never throws. A run must not fail because its diary could not be written —
 * the log is there to explain failures, not to cause them.
 */
export async function recordJobEvent(
  jobId: string,
  input: JobEventInput,
): Promise<void> {
  const detail = input.detail ? input.detail.slice(0, DETAIL_MAX) : null;

  try {
    await prisma.jobEvent.upsert({
      where: {
        jobId_stage_code: { jobId, stage: input.stage, code: input.code },
      },
      create: {
        jobId,
        stage: input.stage,
        code: input.code,
        level: input.level ?? 'info',
        message: input.message,
        detail,
        profileRef: input.profileRef ?? null,
      },
      update: {
        // The newest wording wins: a progress line should read as current, and
        // the latest error detail is the one worth looking at.
        message: input.message,
        detail,
        level: input.level ?? 'info',
        profileRef: input.profileRef ?? null,
        count: { increment: 1 },
      },
    });
  } catch (err) {
    logger.error(
      err,
      `[JobEvents] Could not record ${input.code} for ${jobId}`,
    );
  }
}

/**
 * Record an error using the shared copy table, so the user-facing wording for a
 * given code is identical everywhere it appears.
 */
export async function recordJobError(
  jobId: string,
  stage: JobStage,
  code: JobErrorCode,
  options: { detail?: string | null; ctx?: JobErrorContext } = {},
): Promise<void> {
  const { message, fix } = describeJobError(code, options.ctx ?? {});

  await recordJobEvent(jobId, {
    stage,
    code,
    level: 'error',
    // The fix travels with the message: an error the user cannot act on is
    // only marginally better than no error at all.
    message: `${message} ${fix}`,
    detail: options.detail ?? null,
  });
}
