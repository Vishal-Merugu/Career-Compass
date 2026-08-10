// ─── Email lookup background worker ──────────────────────────────
//
// Two jobs, both about the queue not getting stuck:
//
//   1. Reclaim leases the extension took and never reported on. A closed laptop
//      is indistinguishable from a crashed lookup, and both need the row back.
//   2. Finish rows that **asked** to fall through to the server. Not every
//      unclaimed row: the server can only reach the metered API and
//      pattern+SMTP, so sweeping everything means most profiles settle on a
//      `pattern_guess` before the extension — a real browser, where the
//      provider captcha actually solves — ever had a turn. And because a guess
//      is still an answer, the row then looks finished.
//
//      So `allowServerFallback` defaults to false and the caller opts in, for
//      when no browser is coming. Rows that did not opt in wait for a browser
//      indefinitely, which is the intended behaviour, not a stall.

import { logger } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';
import { findEmail } from '../services/emailFinder/index.js';
import {
  EMAIL_LOOKUP_EXTENSION_GRACE_MS as EXTENSION_GRACE_MS,
  claimLookups,
  completeLookup,
  sweepStaleLookups,
} from '../services/emailLookup.service.js';

const SWEEP_INTERVAL_MS = 60 * 1000;

/** Per tick, so a large batch does not monopolise the process. */
const FALLBACK_BATCH_SIZE = 5;

let timer: NodeJS.Timeout | null = null;
let running = false;

/**
 * Hand un-claimed rows to the server-side finder.
 *
 * `claimLookups(..., 'server')` takes the same lease the extension would, so
 * the two executors cannot both work the same row.
 *
 * A `pattern_guess` still marks the row `done`. It is a real answer and the
 * user should see it — and because `isVerifiedSource('pattern_guess')` is
 * false, pressing "Find emails" on that profile again re-queues it, which is
 * how a guess gets upgraded later without the row looping here forever.
 */
async function runFallbackLookups(): Promise<void> {
  const cutoff = new Date(Date.now() - EXTENSION_GRACE_MS);

  const waiting = await prisma.emailLookup.groupBy({
    by: ['userId'],
    where: {
      status: 'queued',
      requestedAt: { lt: cutoff },
      // Opt-in only. The server's layers bottom out at a pattern guess, so
      // sweeping every unclaimed row would race a working extension and settle
      // profiles on the weakest possible answer.
      allowServerFallback: true,
    },
    _count: { userId: true },
  });

  for (const group of waiting) {
    const items = await claimLookups(
      group.userId,
      FALLBACK_BATCH_SIZE,
      'server',
      cutoff,
    );

    for (const item of items) {
      logger.info(
        `[EmailLookupWorker] No extension claimed ${item.firstName} ${item.lastName} — running server-side finder`,
      );

      try {
        const result = await findEmail({
          linkedinUrl: item.linkedinUrl,
          firstName: item.firstName,
          lastName: item.lastName,
          companyName: item.companyName,
          companyWebsite: item.companyWebsite ?? undefined,
        });

        await completeLookup(group.userId, item.lookupId, result);
      } catch (err) {
        logger.error(
          err,
          `[EmailLookupWorker] Lookup ${item.lookupId} threw; re-queueing`,
        );
        await completeLookup(group.userId, item.lookupId, {
          ok: false,
          error: err instanceof Error ? err.message : 'Lookup failed',
        });
      }
    }
  }
}

async function tick(): Promise<void> {
  // Overlapping ticks would double-claim: a fallback batch can outlast the
  // interval easily, since each SMTP probe carries its own timeout.
  if (running) return;
  running = true;

  try {
    await sweepStaleLookups();
    await runFallbackLookups();
  } catch (err) {
    logger.error(err, '[EmailLookupWorker] Tick failed');
  } finally {
    running = false;
  }
}

export function startEmailLookupWorker(): void {
  if (timer) return;

  logger.info('[EmailLookupWorker] Started');
  // Sweep once at boot, not a minute in. A restart is one of the ways leases
  // are abandoned in the first place, and the dashboard renders those rows as
  // work in progress until something reclaims them.
  void tick();
  timer = setInterval(() => void tick(), SWEEP_INTERVAL_MS);
  // Do not hold the process open on shutdown for a sweep.
  timer.unref();
}

export function stopEmailLookupWorker(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}
