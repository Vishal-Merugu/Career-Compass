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
  findEmailViaLinkFinder,
  isPausingReason,
} from '../services/emailFinder/linkfinder.js';
import {
  getLinkFinderKey,
  linkFinderReady,
  pauseLinkFinder,
} from '../services/linkFinderAccount.service.js';
import {
  EMAIL_LOOKUP_EXTENSION_GRACE_MS as EXTENSION_GRACE_MS,
  claimLookups,
  completeLookup,
  releaseClaimedLookups,
  sweepStaleLookups,
} from '../services/emailLookup.service.js';

const SWEEP_INTERVAL_MS = 60 * 1000;

/** Per tick, so a large batch does not monopolise the process. */
const FALLBACK_BATCH_SIZE = 5;

/** How many rows a single LinkFinder claim leases at once. */
const LINKFINDER_BATCH_SIZE = 12;

/**
 * How many LinkFinder calls are in flight at once. The API asks for ~1
 * request/second per key, which the layer enforces with a per-key pacer — so
 * extra concurrency here just queues on that pacer. A small pool exists so a
 * slow call can overlap the next one's pacing wait, and so a pause is noticed
 * after a few calls rather than a few dozen.
 */
const LINKFINDER_CONCURRENCY = 3;

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
 * Users kicked mid-tick or draining right now. Keeps a button press and the
 * periodic tick from both draining the same user at once — the lease already
 * makes that safe, but skipping the duplicate work is cheaper than racing it.
 */
const draining = new Set<string>();

/** A reason to stop the whole pass, carried out of the concurrent workers. */
interface PauseStop {
  code: 'no_credits' | 'rate_limited' | 'bad_key';
  detail?: string;
}

/**
 * Run every one of a user's fresh rows through LinkFinder, now.
 *
 * Loops until no untouched (`attempts: 0`) row is left: a hit marks the row
 * `done`, a miss parks it as `pendingHandoff` for the user to release to the
 * browser, and either way it drops out of the `linkfinder` claim — so the loop
 * terminates without a separate cursor and drains a batch larger than one claim.
 *
 * **A pausing reason stops the whole pass, immediately.** Out of credits, a
 * rejected key and a standing rate limit all answer identically on the next
 * call, so finishing the batch would spend the user's remaining credits — or,
 * on 402, spend nothing but mark every remaining profile a miss — to learn
 * something already known. In-flight rows are handed back untouched and the
 * account is paused until the user presses Resume.
 */
async function drainLinkFinderForUser(userId: string): Promise<void> {
  if (draining.has(userId)) return;
  draining.add(userId);

  try {
    const apiKey = await getLinkFinderKey(userId);
    if (!apiKey) return;

    for (;;) {
      const items = await claimLookups(
        userId,
        LINKFINDER_BATCH_SIZE,
        'linkfinder',
      );
      if (items.length === 0) break;

      // Bounded concurrency: workers pull from a shared cursor so no single slow
      // call blocks the others behind it.
      let cursor = 0;
      // Pushed to by whichever worker first sees a pausing reason. Every worker
      // checks it before taking another row, so a 402 stops the batch within
      // one call rather than after all twelve have each spent a credit.
      //
      // An array rather than a nullable `let` on purpose: a `let` initialised
      // to `null` and assigned only inside these closures is narrowed to `null`
      // by control-flow analysis at the check below, so the pause branch would
      // be typed unreachable and quietly never compile as intended.
      const stops: PauseStop[] = [];

      const worker = async (): Promise<void> => {
        while (cursor < items.length && stops.length === 0) {
          const item = items[cursor++];
          try {
            const result = await findEmailViaLinkFinder(
              item.linkedinUrl,
              apiKey,
            );

            if (result.ok && result.email) {
              logger.info(
                `[EmailLookupWorker] LinkFinder resolved ${item.firstName} ${item.lastName}`,
              );
              await completeLookup(userId, item.lookupId, {
                ok: true,
                email: result.email,
                source: 'linkfinder',
                validation: 'provider',
              });
              continue;
            }

            if (isPausingReason(result.reason)) {
              stops.push({ code: result.reason, detail: result.detail });
              // This row was never answered for — hand the lease straight back
              // rather than recording a miss against it.
              await releaseClaimedLookups(userId, [item.lookupId]);
              continue;
            }

            logger.info(
              `[EmailLookupWorker] LinkFinder missed ${item.firstName} ${item.lastName} (${result.reason}) — holding for a manual handoff`,
            );
            await completeLookup(userId, item.lookupId, {
              ok: false,
              error: `LinkFinder: ${result.reason ?? 'no email'}`,
              holdForHandoff: true,
            });
          } catch (err) {
            logger.error(
              err,
              `[EmailLookupWorker] LinkFinder lookup ${item.lookupId} threw; holding for a manual handoff`,
            );
            await completeLookup(userId, item.lookupId, {
              ok: false,
              error: err instanceof Error ? err.message : 'LinkFinder failed',
              holdForHandoff: true,
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

      if (stops.length > 0) {
        const stop = stops[0];
        // Rows the other workers never reached. They are still `dispatched`
        // under this pass's lease; without this they would sit unclaimable
        // until the five-minute sweep, and a user who topped up and pressed
        // Resume immediately would see nothing happen.
        await releaseClaimedLookups(
          userId,
          items.slice(cursor).map((item) => item.lookupId),
        );
        await pauseLinkFinder(userId, stop.code, stop.detail);
        break;
      }
    }
  } finally {
    draining.delete(userId);
  }
}

/**
 * Start a user's LinkFinder pass immediately, off the tick.
 *
 * Called from the enqueue route so pressing "Find emails" begins the server
 * pass at once, instead of waiting up to a full `SWEEP_INTERVAL_MS` for the
 * next tick — the window in which the browser, nudged the instant the button is
 * pressed, would otherwise have claimed the whole batch first. Fire-and-forget:
 * the request returns 202 and the drain runs in the background.
 */
export function kickLinkFinderPass(userId: string): void {
  void (async () => {
    // No key, or paused: `drainLinkFinderForUser` would claim nothing anyway,
    // but checking here keeps the common no-key case from touching the queue.
    if (!(await linkFinderReady(userId))) return;
    await drainLinkFinderForUser(userId);
  })().catch((err) =>
    logger.error(err, '[EmailLookupWorker] Kicked LinkFinder pass failed'),
  );
}

async function runLinkFinderPass(): Promise<void> {
  const waiting = await prisma.emailLookup.groupBy({
    by: ['userId'],
    where: { status: 'queued', attempts: 0, pendingHandoff: false },
    _count: { userId: true },
  });

  for (const group of waiting) {
    // Per user, because the key and the pause are per user. A user with no key
    // is skipped so their rows reach the extension on its normal turn instead
    // of being marked missed by a layer that never ran; a paused user is
    // skipped until they resume.
    if (!(await linkFinderReady(group.userId))) continue;
    await drainLinkFinderForUser(group.userId);
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
