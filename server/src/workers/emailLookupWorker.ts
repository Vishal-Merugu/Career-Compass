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
import { findEmailViaLinkFinder } from '../services/emailFinder/linkfinder.js';
import {
  EMAIL_LOOKUP_EXTENSION_GRACE_MS as EXTENSION_GRACE_MS,
  claimLookups,
  completeLookup,
  sweepStaleLookups,
} from '../services/emailLookup.service.js';

const SWEEP_INTERVAL_MS = 60 * 1000;

/** Per tick, so a large batch does not monopolise the process. */
const FALLBACK_BATCH_SIZE = 5;

/**
 * The immediate LinkFinder pass. Larger than the fallback batch because these
 * calls run concurrently, not one after another — the endpoint takes ~40s each,
 * so a serial drain of a 40-profile batch would run for half an hour.
 */
const LINKFINDER_BATCH_SIZE = 12;

/**
 * How many LinkFinder calls are in flight at once. The endpoint is slow but
 * cheap to wait on (it is a remote request, not local work), so concurrency is
 * what makes "run all in the backend" finish in a reasonable time. Kept modest
 * so one user's batch cannot saturate the process against everyone else's.
 */
const LINKFINDER_CONCURRENCY = 6;

function linkFinderEnabled(): boolean {
  return Boolean((process.env.LINKFINDER_API_KEY || '').trim());
}

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

/**
 * The immediate first pass: run every freshly-queued row through LinkFinder.
 *
 * This is what makes "press Find emails and the backend does the rest" true.
 * Unlike `runFallbackLookups` it waits for no grace period and needs no
 * `allowServerFallback` opt-in — LinkFinder returns a real address, not a
 * guess, so there is nothing to protect the row from by making it wait for a
 * browser first.
 *
 * A miss is a **one-way handoff to the extension**. `claimLookups(...,
 * 'linkfinder')` takes only `attempts: 0` rows, and reporting a miss increments
 * `attempts`, so a row LinkFinder could not resolve drops out of this pass for
 * good and is left `queued` for a real browser to solve — automatically, with
 * no button. LinkFinder never spends a second 40s call on the same person.
 */
async function runLinkFinderPass(): Promise<void> {
  // No key means every call returns instantly as `disabled` — which would count
  // as a miss and shove untouched rows to the browser before the extension even
  // had its normal turn. Skip the pass entirely instead.
  if (!linkFinderEnabled()) return;

  const waiting = await prisma.emailLookup.groupBy({
    by: ['userId'],
    where: { status: 'queued', attempts: 0 },
    _count: { userId: true },
  });

  for (const group of waiting) {
    const items = await claimLookups(
      group.userId,
      LINKFINDER_BATCH_SIZE,
      'linkfinder',
    );
    if (items.length === 0) continue;

    // Bounded concurrency: workers pull from a shared cursor so no single slow
    // call (they are all ~40s) blocks the others behind it.
    let cursor = 0;
    const worker = async (): Promise<void> => {
      while (cursor < items.length) {
        const item = items[cursor++];
        try {
          const result = await findEmailViaLinkFinder(item.linkedinUrl);

          if (result.ok && result.email) {
            logger.info(
              `[EmailLookupWorker] LinkFinder resolved ${item.firstName} ${item.lastName}`,
            );
            await completeLookup(group.userId, item.lookupId, {
              ok: true,
              email: result.email,
              source: 'linkfinder',
              validation: 'provider',
            });
          } else {
            logger.info(
              `[EmailLookupWorker] LinkFinder missed ${item.firstName} ${item.lastName} (${result.reason}) — leaving for the browser`,
            );
            await completeLookup(group.userId, item.lookupId, {
              ok: false,
              error: `LinkFinder: ${result.reason ?? 'no email'}`,
            });
          }
        } catch (err) {
          logger.error(
            err,
            `[EmailLookupWorker] LinkFinder lookup ${item.lookupId} threw; leaving for the browser`,
          );
          await completeLookup(group.userId, item.lookupId, {
            ok: false,
            error: err instanceof Error ? err.message : 'LinkFinder failed',
          });
        }
      }
    };

    await Promise.all(
      Array.from(
        { length: Math.min(LINKFINDER_CONCURRENCY, items.length) },
        worker,
      ),
    );
  }
}

async function tick(): Promise<void> {
  // Overlapping ticks would double-claim: a fallback batch can outlast the
  // interval easily, since each SMTP probe carries its own timeout.
  if (running) return;
  running = true;

  try {
    await sweepStaleLookups();
    await runLinkFinderPass();
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
