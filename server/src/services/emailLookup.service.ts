// ─── Email lookup queue ──────────────────────────────────────────
//
// The dashboard asks for emails; something else finds them later.
//
// The Chrome extension is the preferred executor — it holds a real browser, so
// the free provider widgets solve their own captchas there, which no server can
// do (see docs/adr/0005-server-side-email-finder.md). But it is offline most of
// the time: an MV3 service worker is killed after ~30s idle, and the WebSocket
// handshake requires a live `SearchJob`, so there is no socket to push a
// request down. The request therefore has to wait in Postgres until a browser
// asks for work.
//
// Rows are claimed under a lease. `sweepStaleLookups` reclaims anything a
// client took and never reported on — a closed laptop looks exactly like a
// crashed lookup, and both need the row back.

import { EventEmitter } from 'events';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { NotFoundError, ValidationError } from '../errors/AppError.js';
import { isEmailUpgrade, isVerifiedSource } from './emailFinder/confidence.js';

/** Statuses a row moves through. `dispatched` means leased to a client. */
export type LookupStatus = 'queued' | 'dispatched' | 'done' | 'failed';

export interface LookupStats {
  queued: number;
  dispatched: number;
  done: number;
  failed: number;
  /** queued + dispatched — what the dashboard shows as "still working". */
  pending: number;
  /**
   * Pending rows that nothing is coming for: queued past the extension's grace
   * period with no server fallback. They are not broken — waiting for a browser
   * is the design — but the dashboard must not render them as a spinner, or a
   * user who closed Chrome sees "finding emails" forever with nothing running.
   */
  stalled: number;
  total: number;
}

export interface LookupProgress {
  userId: string;
  type: 'ITEM' | 'STATS';
  lookupId?: string;
  profileId?: string;
  status?: LookupStatus;
  email?: string | null;
  emailSource?: string | null;
  emailValidation?: string | null;
  error?: string | null;
  stats?: LookupStats;
}

/** One unit of work handed to an executor. */
export interface LookupWorkItem {
  lookupId: string;
  profileId: string;
  linkedinUrl: string;
  firstName: string;
  lastName: string;
  companyName: string;
  companyWebsite: string | null;
}

export interface EnqueueResult {
  queued: number;
  /** Already had an address stronger than a guess, so nothing to gain. */
  skippedVerified: number;
  /** Requested ids that are not this user's profiles. */
  skippedUnknown: number;
}

/**
 * Progress channel for `GET /api/profiles/find-emails/events`.
 *
 * In-process, like `campaignEvents`. The stream is an optimisation only — the
 * dashboard's source of truth is `getLookupStats`, so a reload or a server
 * restart shows correct progress with no stream at all.
 */
export const emailLookupEvents = new EventEmitter();

function emitProgress(event: LookupProgress): void {
  emailLookupEvents.emit(`emailLookup:${event.userId}`, event);
}

/**
 * A lease older than this is presumed abandoned.
 *
 * Generous on purpose: the extension drains on a `chrome.alarms` tick and each
 * widget lookup can take 30s, so a legitimately busy client must not have its
 * row stolen mid-flight.
 */
const LEASE_TIMEOUT_MS = 5 * 60 * 1000;

/** After this many failed attempts the row stops coming back. */
const MAX_ATTEMPTS = 3;

/**
 * How long the extension gets first refusal on a queued row.
 *
 * Lives here rather than in the worker because `getLookupStats` uses the same
 * boundary to call a row `stalled` — the number the dashboard renders and the
 * number the fallback acts on have to be the same number.
 */
const EXTENSION_GRACE_MS = 3 * 60 * 1000;

/**
 * Queue lookups for profiles the user selected.
 *
 * Idempotent per profile: the unique `(userId, profileId)` row is reset to
 * `queued` rather than duplicated, so double-clicking the button cannot make
 * the same person get looked up twice.
 *
 * `force` re-queues profiles that already hold a verified address; without it
 * those are skipped, because each provider lookup costs a credit and the
 * answer is already better than anything a second pass would produce.
 *
 * `allowServerFallback` is **off by default**: the extension gets the work, and
 * a row nobody claims waits rather than being finished as a `pattern_guess`.
 * Turn it on deliberately when no browser is coming.
 */
export async function enqueueLookups(
  userId: string,
  profileIds: string[],
  force = false,
  allowServerFallback = false,
): Promise<EnqueueResult> {
  if (profileIds.length === 0) {
    throw new ValidationError('No profiles selected');
  }

  // Scoped to the user's own profiles. `GET /api/profiles` filters by
  // `outreachLogs.some.userId`, and so must this — otherwise any id guessed by
  // a client would enqueue a lookup against a stranger's row.
  const profiles = await prisma.profile.findMany({
    where: { id: { in: profileIds }, outreachLogs: { some: { userId } } },
    select: { id: true, email: true, emailSource: true },
  });

  const skippedUnknown = profileIds.length - profiles.length;
  let queued = 0;
  let skippedVerified = 0;

  for (const profile of profiles) {
    if (!force && isVerifiedSource(profile.emailSource)) {
      skippedVerified += 1;
      continue;
    }

    await prisma.emailLookup.upsert({
      where: { userId_profileId: { userId, profileId: profile.id } },
      create: {
        userId,
        profileId: profile.id,
        status: 'queued',
        allowServerFallback,
      },
      update: {
        status: 'queued',
        // A re-request is a fresh start, not a fourth attempt at a row that
        // already exhausted MAX_ATTEMPTS.
        attempts: 0,
        claimedBy: null,
        lastError: null,
        dispatchedAt: null,
        completedAt: null,
        requestedAt: new Date(),
        allowServerFallback,
      },
    });
    queued += 1;
  }

  logger.info(
    `[EmailLookup] Queued ${queued} lookups for user ${userId} (skipped ${skippedVerified} verified, ${skippedUnknown} unknown)`,
  );

  emitProgress({ userId, type: 'STATS', stats: await getLookupStats(userId) });

  return { queued, skippedVerified, skippedUnknown };
}

/**
 * Lease up to `take` queued lookups to an executor.
 *
 * Claimed one row at a time under a `status: 'queued'` guard so two executors
 * — the extension and the fallback sweep — cannot both take the same row. A
 * bulk `updateMany` would report how many rows changed but not *which*, which
 * is not enough to hand back the right work items.
 */
export async function claimLookups(
  userId: string,
  take: number,
  claimedBy: 'extension' | 'server',
  /**
   * Only claim rows requested before this instant. Used by the server fallback
   * to honour the extension's grace period per row — the caller's own
   * "who has waiting work" query cannot do it, because one old row would
   * otherwise drag every freshly queued row for that user in with it.
   */
  requestedBefore?: Date,
): Promise<LookupWorkItem[]> {
  const candidates = await prisma.emailLookup.findMany({
    where: {
      userId,
      status: 'queued',
      attempts: { lt: MAX_ATTEMPTS },
      // The server may only take rows that opted in. Without this the fallback
      // races a working extension and fills rows with guesses it could have
      // resolved properly a few minutes later.
      ...(claimedBy === 'server' ? { allowServerFallback: true } : {}),
      ...(requestedBefore ? { requestedAt: { lt: requestedBefore } } : {}),
    },
    orderBy: { requestedAt: 'asc' },
    take,
    select: { id: true },
  });

  const claimed: LookupWorkItem[] = [];

  for (const candidate of candidates) {
    const { count } = await prisma.emailLookup.updateMany({
      where: { id: candidate.id, status: 'queued' },
      data: {
        status: 'dispatched',
        claimedBy,
        dispatchedAt: new Date(),
        attempts: { increment: 1 },
      },
    });

    // Lost the race to another executor. Not an error — skip it.
    if (count === 0) continue;

    const row = await prisma.emailLookup.findUnique({
      where: { id: candidate.id },
      select: {
        id: true,
        profileId: true,
        profile: {
          select: {
            firstName: true,
            lastName: true,
            linkedinUrl: true,
            company: { select: { name: true, website: true } },
          },
        },
      },
    });

    if (!row) continue;

    claimed.push({
      lookupId: row.id,
      profileId: row.profileId,
      linkedinUrl: row.profile.linkedinUrl,
      firstName: row.profile.firstName,
      lastName: row.profile.lastName,
      companyName: row.profile.company?.name ?? '',
      companyWebsite: row.profile.company?.website ?? null,
    });
  }

  if (claimed.length > 0) {
    logger.info(
      `[EmailLookup] ${claimedBy} claimed ${claimed.length} lookups for user ${userId}`,
    );
    emitProgress({
      userId,
      type: 'STATS',
      stats: await getLookupStats(userId),
    });
  }

  return claimed;
}

/**
 * Record the outcome of a lookup.
 *
 * The address is written to `Profile` — that is what the dashboard reads and
 * what `CampaignContact` points at — but only as an upgrade. The copy kept on
 * the lookup row is the audit trail of what this attempt produced, which is
 * how a rejected downgrade stays visible instead of vanishing.
 */
export async function completeLookup(
  userId: string,
  lookupId: string,
  result: {
    ok: boolean;
    email?: string | null;
    source?: string | null;
    validation?: string | null;
    error?: string | null;
  },
): Promise<void> {
  const lookup = await prisma.emailLookup.findFirst({
    where: { id: lookupId, userId },
    select: {
      id: true,
      profileId: true,
      attempts: true,
      profile: { select: { email: true, emailSource: true } },
    },
  });

  if (!lookup) throw new NotFoundError('Email lookup not found');

  const email = result.email ?? null;
  const source = result.source ?? null;

  if (result.ok && email) {
    const upgraded = isEmailUpgrade(lookup.profile, { email, source });

    if (upgraded) {
      await prisma.profile.update({
        where: { id: lookup.profileId },
        data: {
          email,
          emailSource: source,
          emailValidation: result.validation ?? null,
        },
      });
    } else {
      logger.info(
        `[EmailLookup] Kept existing ${lookup.profile.emailSource} address for profile ${lookup.profileId}; ${source} result was not an upgrade`,
      );
    }

    await prisma.emailLookup.update({
      where: { id: lookup.id },
      data: {
        status: 'done',
        email,
        emailSource: source,
        emailValidation: result.validation ?? null,
        lastError: upgraded ? null : 'Kept existing address — not an upgrade',
        completedAt: new Date(),
      },
    });
  } else {
    // Retryable until the attempt budget runs out. A miss is often a transient
    // captcha or a closed tab, not a person without an email.
    const exhausted = lookup.attempts >= MAX_ATTEMPTS;

    await prisma.emailLookup.update({
      where: { id: lookup.id },
      data: {
        status: exhausted ? 'failed' : 'queued',
        lastError: result.error ?? 'No email found',
        claimedBy: null,
        dispatchedAt: null,
        completedAt: exhausted ? new Date() : null,
      },
    });
  }

  const stats = await getLookupStats(userId);

  emitProgress({
    userId,
    type: 'ITEM',
    lookupId: lookup.id,
    profileId: lookup.profileId,
    status: result.ok && email ? 'done' : 'failed',
    email,
    emailSource: source,
    emailValidation: result.validation ?? null,
    error: result.error ?? null,
    stats,
  });
}

export async function getLookupStats(userId: string): Promise<LookupStats> {
  const [grouped, stalled] = await Promise.all([
    prisma.emailLookup.groupBy({
      by: ['status'],
      where: { userId },
      _count: { status: true },
    }),
    // Waited out the extension's turn and cannot fall through to the server, so
    // no executor will ever pick it up unless the user opens Chrome or asks for
    // a guess. Counted separately so the UI can say that instead of spinning.
    prisma.emailLookup.count({
      where: {
        userId,
        status: 'queued',
        allowServerFallback: false,
        requestedAt: { lt: new Date(Date.now() - EXTENSION_GRACE_MS) },
      },
    }),
  ]);

  const counts: Record<string, number> = {};
  for (const row of grouped) counts[row.status] = row._count.status;

  const queued = counts.queued ?? 0;
  const dispatched = counts.dispatched ?? 0;
  const done = counts.done ?? 0;
  const failed = counts.failed ?? 0;

  return {
    queued,
    dispatched,
    done,
    failed,
    pending: queued + dispatched,
    stalled,
    total: queued + dispatched + done + failed,
  };
}

/**
 * Return leases nobody reported on to the queue.
 *
 * Without this, closing the laptop mid-drain strands every claimed row in
 * `dispatched` forever and the dashboard shows work that will never finish.
 */
export async function sweepStaleLookups(): Promise<number> {
  const cutoff = new Date(Date.now() - LEASE_TIMEOUT_MS);

  // A `queued` row at the attempt ceiling is invisible to `claimLookups`, so it
  // can never be worked and never completes — it would sit in `pending` forever
  // and the dashboard would show a lookup in progress with nothing running.
  const unclaimable = await prisma.emailLookup.findMany({
    where: { status: 'queued', attempts: { gte: MAX_ATTEMPTS } },
    select: { id: true, userId: true },
  });

  if (unclaimable.length > 0) {
    await prisma.emailLookup.updateMany({
      where: { id: { in: unclaimable.map((row) => row.id) } },
      data: { status: 'failed', completedAt: new Date() },
    });
    logger.warn(
      `[EmailLookup] Retired ${unclaimable.length} unclaimable queued lookups`,
    );
  }

  const stale = await prisma.emailLookup.findMany({
    where: { status: 'dispatched', dispatchedAt: { lt: cutoff } },
    select: { id: true, userId: true, attempts: true },
  });

  for (const row of stale) {
    const exhausted = row.attempts >= MAX_ATTEMPTS;
    await prisma.emailLookup.update({
      where: { id: row.id },
      data: {
        status: exhausted ? 'failed' : 'queued',
        claimedBy: null,
        dispatchedAt: null,
        lastError: 'Executor never reported a result',
        completedAt: exhausted ? new Date() : null,
      },
    });
  }

  if (stale.length > 0) {
    logger.warn(`[EmailLookup] Reclaimed ${stale.length} abandoned leases`);
  }

  const touched = new Set([...unclaimable, ...stale].map((row) => row.userId));

  for (const userId of touched) {
    emitProgress({
      userId,
      type: 'STATS',
      stats: await getLookupStats(userId),
    });
  }

  return unclaimable.length + stale.length;
}

/** Cancel everything still waiting. Does not touch work already in flight. */
export async function cancelQueuedLookups(userId: string): Promise<number> {
  const { count } = await prisma.emailLookup.deleteMany({
    where: { userId, status: 'queued' },
  });

  emitProgress({ userId, type: 'STATS', stats: await getLookupStats(userId) });

  return count;
}

export const EMAIL_LOOKUP_MAX_ATTEMPTS = MAX_ATTEMPTS;
export const EMAIL_LOOKUP_EXTENSION_GRACE_MS = EXTENSION_GRACE_MS;
