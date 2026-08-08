// ─── LinkedIn session (server side) ──────────────────────────────
//
// Owns the cookie jar the server makes Voyager calls with, and the rules about
// when to write it back. `withVoyager` is the only sanctioned way to touch
// LinkedIn from server code — it loads the jar, hands you a client, persists
// rotation on success, and refuses to persist anything after a fatal response.
//
// The hard-won rules it enforces, all from docs/adr/0002-full-cookie-jar.md:
//
//   * `li_at` alone is not a session. The full jar travels together.
//   * `JSESSIONID` *is* the CSRF token and it rotates, so the jar has to be
//     written back after a successful call or the next call 403s.
//   * Never persist after a fatal response. LinkedIn kills a session by
//     expiring cookies, so the post-fatal jar is a dead jar — saving it
//     overwrites a good export and forces a needless re-extraction.
//   * `__cf_bm` is Cloudflare's, bound to the issuing IP. Strip it on import;
//     Cloudflare mints a fresh one.
//
// The server cannot log in. A jar only ever arrives from a real browser, via
// `POST /api/session/cookies` (the extension) or `npm run cookies:import`
// (by hand, writing `linkedin-cookies.json`).

import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { LinkedInSessionError, ValidationError } from '../errors/AppError.js';
import {
  CookieJar,
  CRITICAL_COOKIES,
  type CookieExport,
} from '../shared/cookieJar.js';
import { VoyagerClient } from '../shared/voyagerClient.js';

/**
 * Job status meaning "stopped because the LinkedIn session died".
 *
 * Distinct from `paused_error` on purpose: only this one is auto-resumed when a
 * fresh jar arrives. A manual pause must stay paused.
 */
export const JOB_STATUS_PAUSED_SESSION = 'paused_session';

/**
 * Cookies that must never be stored.
 *
 * `__cf_bm` is issued by Cloudflare against the requesting IP and lives ~30
 * minutes. Replaying one from a different machine is worse than sending none.
 */
const NON_PORTABLE_COOKIES = ['__cf_bm'];

/** Fallback jar for a single-tenant VM that still uses the file. */
const COOKIE_FILE = resolve(process.cwd(), 'linkedin-cookies.json');

export interface SessionState {
  present: boolean;
  isValid: boolean;
  invalidReason: string | null;
  importedAt: Date | null;
  lastChecked: Date | null;
  missingCritical: string[];
}

function isRecordOfStrings(v: unknown): v is Record<string, string> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  return Object.values(v).every((x) => typeof x === 'string');
}

/**
 * Drop cookies that must not be replayed, and reject a jar that cannot work.
 *
 * Validating at the door rather than at call time means a bad import fails
 * where the user can see it, instead of producing 403s in a worker an hour
 * later.
 */
function sanitizeExport(input: CookieExport): CookieExport {
  const cookies: Record<string, string> = {};
  for (const [name, value] of Object.entries(input.cookies)) {
    if (NON_PORTABLE_COOKIES.includes(name)) continue;
    if (!value) continue;
    cookies[name] = value;
  }

  const missing = CRITICAL_COOKIES.filter((name) => !cookies[name]);
  if (missing.length > 0) {
    throw new ValidationError(
      `Cookie jar is missing ${missing.join(', ')}. An auth token without the ` +
        'browser-identity cookies reads as a stolen session.',
    );
  }

  if (!input.userAgent) {
    throw new ValidationError(
      'userAgent is required — a jar replayed under a different user-agent is a mismatched fingerprint',
    );
  }

  return {
    cookies,
    userAgent: input.userAgent,
    timezoneOffset: input.timezoneOffset ?? 5.5,
    exportedAt: new Date().toISOString(),
  };
}

/**
 * Store a jar pushed from a browser. Marks the session valid again — a fresh
 * import is exactly the fix for an expired one.
 */
export async function importSession(
  userId: string,
  input: CookieExport,
): Promise<SessionState> {
  const clean = sanitizeExport(input);

  await prisma.linkedInSession.upsert({
    where: { userId },
    create: {
      userId,
      cookies: clean.cookies,
      userAgent: clean.userAgent,
      timezoneOffset: clean.timezoneOffset ?? 5.5,
      isValid: true,
    },
    update: {
      cookies: clean.cookies,
      userAgent: clean.userAgent,
      timezoneOffset: clean.timezoneOffset ?? 5.5,
      isValid: true,
      invalidReason: null,
      importedAt: new Date(),
      lastChecked: new Date(),
    },
  });

  logger.info(
    `[LinkedInSession] Imported jar for user ${userId} (${Object.keys(clean.cookies).length} cookies)`,
  );

  await resumeJobsPausedForSession(userId);

  return getSessionState(userId);
}

/**
 * Restart runs that stopped because the session died.
 *
 * This is the other half of the design the user asked for: the server waits
 * indefinitely for a browser rather than failing, and a fresh jar is the signal
 * to carry on. Without this the pause is permanent in practice — the jar arrives,
 * nothing notices, and the run sits in `paused_error` until someone clicks
 * resume by hand.
 *
 * Only jobs whose URLs are unfinished are resumed. A job that was paused after
 * its last profile has nothing left to do, and moving it back to `scraping`
 * would leave it there forever.
 */
async function resumeJobsPausedForSession(userId: string): Promise<void> {
  const paused = await prisma.searchJob.findMany({
    where: {
      userId,
      // `paused_session`, not `paused_error`. A user who pressed Pause on Runs
      // (or /pause in Telegram) also lands in `paused_error`, and resuming those
      // meant the 30-minute session-sync alarm silently restarted a run they had
      // deliberately stopped.
      status: JOB_STATUS_PAUSED_SESSION,
      profileUrls: {
        some: { status: { in: ['queued', 'dispatched', 'scraping'] } },
      },
    },
    select: { id: true },
  });

  if (paused.length === 0) return;

  for (const job of paused) {
    // Anything left mid-flight when the session died was never completed.
    await prisma.profileUrl.updateMany({
      where: { jobId: job.id, status: { in: ['dispatched', 'scraping'] } },
      data: { status: 'queued', dispatchedAt: null },
    });

    await prisma.searchJob.update({
      where: { id: job.id },
      data: { status: 'scraping' },
    });

    logger.info(
      `[LinkedInSession] Resumed job ${job.id} — a fresh jar arrived`,
    );
  }
}

/**
 * Load the jar for a user, or null if there is nothing usable.
 *
 * Falls back to `linkedin-cookies.json` when the database has no row. That file
 * is how the VM was seeded before this table existed, so the fallback means an
 * existing deployment keeps working without a manual re-import — but it is
 * per-server, not per-user, so it is only consulted when the DB is empty.
 */
export async function loadJar(userId: string): Promise<CookieJar | null> {
  const row = await prisma.linkedInSession.findUnique({ where: { userId } });

  if (row && row.isValid && isRecordOfStrings(row.cookies)) {
    return new CookieJar({
      cookies: row.cookies,
      userAgent: row.userAgent,
      timezoneOffset: row.timezoneOffset,
    });
  }

  if (row && !row.isValid) {
    logger.warn(
      `[LinkedInSession] Session for user ${userId} is marked invalid: ${row.invalidReason ?? 'unknown'}`,
    );
    return null;
  }

  if (!existsSync(COOKIE_FILE)) return null;

  try {
    const parsed: unknown = JSON.parse(readFileSync(COOKIE_FILE, 'utf8'));
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      !('cookies' in parsed) ||
      !isRecordOfStrings((parsed as { cookies: unknown }).cookies)
    ) {
      return null;
    }
    const file = parsed as CookieExport;
    logger.info(
      `[LinkedInSession] No stored jar for user ${userId}; using linkedin-cookies.json`,
    );
    const clean = sanitizeExport(file);
    return new CookieJar(clean);
  } catch (err) {
    logger.error(err, '[LinkedInSession] linkedin-cookies.json is unreadable');
    return null;
  }
}

/** Write rotation back. Only ever called after a call that did not fail fatally. */
async function persistJar(userId: string, jar: CookieJar): Promise<void> {
  const exported = jar.toExport({
    cookies: {},
    userAgent: jar.userAgent,
    timezoneOffset: jar.timezoneOffset,
  });

  await prisma.linkedInSession.upsert({
    where: { userId },
    create: {
      userId,
      cookies: exported.cookies,
      userAgent: exported.userAgent,
      timezoneOffset: exported.timezoneOffset ?? 5.5,
      isValid: true,
    },
    update: {
      cookies: exported.cookies,
      userAgent: exported.userAgent,
      lastChecked: new Date(),
    },
  });
}

/**
 * Mark the session unusable and say why.
 *
 * Deliberately does not clear `cookies`: the dead jar is useful evidence when
 * diagnosing why a run stopped, and nothing reads it while `isValid` is false.
 */
export async function markSessionDead(
  userId: string,
  reason: string,
): Promise<void> {
  logger.error(`[LinkedInSession] Session dead for user ${userId}: ${reason}`);

  await prisma.linkedInSession.updateMany({
    where: { userId },
    data: { isValid: false, invalidReason: reason, lastChecked: new Date() },
  });
}

export async function getSessionState(userId: string): Promise<SessionState> {
  const row = await prisma.linkedInSession.findUnique({ where: { userId } });

  if (!row) {
    return {
      present: false,
      isValid: false,
      invalidReason: null,
      importedAt: null,
      lastChecked: null,
      missingCritical: CRITICAL_COOKIES,
    };
  }

  const cookies = isRecordOfStrings(row.cookies) ? row.cookies : {};

  return {
    present: true,
    isValid: row.isValid,
    invalidReason: row.invalidReason,
    importedAt: row.importedAt,
    lastChecked: row.lastChecked,
    missingCritical: CRITICAL_COOKIES.filter((name) => !cookies[name]),
  };
}

/**
 * Run a Voyager call for a user with the jar loaded, rotated and persisted.
 *
 * **Use this rather than constructing `VoyagerClient` directly.** It is the one
 * place that knows not to save a jar after a fatal response, and the one place
 * that marks a session dead — spreading that across call sites is how a good
 * export gets overwritten with a dead one.
 *
 * Throws `LinkedInSessionError` when there is no usable jar, so a caller can
 * treat "no session" and "session died" the same way: stop, do not retry.
 */
export async function withVoyager<T>(
  userId: string,
  fn: (client: VoyagerClient) => Promise<T>,
): Promise<T> {
  const jar = await loadJar(userId);

  if (!jar) {
    throw new LinkedInSessionError(
      'No usable LinkedIn session for this user. Push one from the extension.',
    );
  }

  // Constructing throws if the jar is missing JSESSIONID or a critical cookie.
  const client = new VoyagerClient({ jar });

  try {
    const result = await fn(client);

    // Success: JSESSIONID and lidc may have rotated mid-call, and the next call
    // needs the new values.
    if (!client.sessionDead) {
      await persistJar(userId, jar);
    }

    return result;
  } catch (err) {
    if (client.sessionDead || err instanceof LinkedInSessionError) {
      const reason =
        err instanceof Error ? err.message : 'Fatal LinkedIn response';
      await markSessionDead(userId, reason);
      // Note what is NOT happening here: the jar is not written back.
      throw err instanceof LinkedInSessionError
        ? err
        : new LinkedInSessionError(reason);
    }

    // A non-fatal failure (timeout, 500, parse error) leaves the session alone,
    // but rotation that already happened is still worth keeping.
    await persistJar(userId, jar);
    throw err;
  }
}
