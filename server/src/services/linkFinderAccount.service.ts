// ─── LinkFinder account state ────────────────────────────────────
//
// Who has a LinkFinder key, and whether their pass is currently paused.
//
// Both live on `UserConfig` and both are **per user**, which is the whole point
// of this module. The layer used to read a process-wide `LINKFINDER_API_KEY`
// and latch itself off in a module-level variable when that key ran out of
// credits — so one account's exhausted balance silently disabled the layer for
// every other account on the instance, until someone restarted the process.
// A credit balance belongs to the person who paid for it; so does the pause.
//
// The key is stored encrypted (`lib/secretBox.ts`) and is never returned to a
// client, never logged, and never echoed back into a form. Settings sends a
// boolean, `linkFinderApiKeySet`.

import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { decryptSecret, encryptSecret, isEncrypted } from '../lib/secretBox.js';

/**
 * Why a user's pass is paused.
 *
 * All three share one property that makes pausing the right response rather
 * than a retry: the next call returns the same answer. Spending the rest of a
 * 200-row batch discovering that is not resilience, it is a bill.
 */
export const LINKFINDER_PAUSE_REASONS = {
  no_credits: {
    title: 'LinkFinder is out of credits',
    message:
      'Your LinkFinder balance is empty, so the remaining lookups were held rather than run. Top up at linkfinderai.com, then resume — nothing was lost and no row was marked as a miss.',
  },
  rate_limited: {
    title: 'LinkFinder hit its rate limit',
    message:
      'LinkFinder is refusing further requests for now. The remaining lookups were held. Give it a few minutes, then resume.',
  },
  bad_key: {
    title: 'LinkFinder rejected your API key',
    message:
      'LinkFinder returned 401 for this key. Check it in Settings → Finder — copy it again from your LinkFinder dashboard — then resume.',
  },
} as const;

export type LinkFinderPauseCode = keyof typeof LINKFINDER_PAUSE_REASONS;

export function isPauseCode(
  value: string | null,
): value is LinkFinderPauseCode {
  return value !== null && value in LINKFINDER_PAUSE_REASONS;
}

/** What the dashboard renders. Never carries the key itself. */
export interface LinkFinderState {
  /** The user has a key saved, so the layer runs for them at all. */
  configured: boolean;
  paused: boolean;
  pauseCode: LinkFinderPauseCode | null;
  /** Ready-to-render copy for `pauseCode`, or null when running. */
  title: string | null;
  message: string | null;
  /** The provider's own words. Shown collapsed, as `detail` — never the headline. */
  detail: string | null;
  pausedAt: string | null;
}

/**
 * The user's decrypted LinkFinder key, or null if they have not set one.
 *
 * Null is a normal state, not an error: without a key the layer is skipped and
 * the queue behaves exactly as it did before LinkFinder existed — the extension
 * waterfall gets every row. There is deliberately **no environment-variable
 * fallback**. An instance-wide key would spend the operator's credits on every
 * user's lookups, and would make "why did my balance drop" unanswerable.
 */
export async function getLinkFinderKey(userId: string): Promise<string | null> {
  const config = await prisma.userConfig.findUnique({
    where: { userId },
    select: { linkFinderApiKey: true },
  });

  return readKey(config?.linkFinderApiKey ?? null, userId);
}

/**
 * Decrypt a stored key, tolerating a plaintext value.
 *
 * Plaintext is possible for a row written before the column was encrypted, or
 * by a direct database edit. Treating it as usable rather than throwing keeps
 * one bad row from taking a user's whole lookup pass down; a failed *decrypt*
 * is different and does mean the key is unusable, since rotating `JWT_SECRET`
 * makes every stored secret undecryptable (see `lib/secretBox.ts`).
 */
function readKey(stored: string | null, userId: string): string | null {
  const value = (stored || '').trim();
  if (!value) return null;
  if (!isEncrypted(value)) return value;

  try {
    return decryptSecret(value).trim() || null;
  } catch (err) {
    logger.error(
      { err },
      `[LinkFinder] Could not decrypt the stored API key for user ${userId}. It must be re-entered in Settings.`,
    );
    return null;
  }
}

/** Encrypt a key for storage. Exported so the settings route cannot forget to. */
export function sealLinkFinderKey(plaintext: string): string {
  return encryptSecret(plaintext.trim().replace(/^Bearer\s+/i, ''));
}

/**
 * What the queue's claim gate needs to know, in one query.
 *
 * The two flags are deliberately separate, and conflating them was a real bug:
 * "no key" and "paused" both stop the LinkFinder pass, but they mean opposite
 * things for the *extension*.
 *
 *   * No key — the layer will never run for this account, so fresh rows should
 *     go to the browser immediately, exactly as before LinkFinder existed.
 *   * Paused — the layer is going to run, once the user tops up and presses
 *     Resume. Its rows stay reserved. Letting the browser inherit them would
 *     quietly do the automatic lookup the pause exists to prevent, and the
 *     Resume button would then find nothing left to work.
 */
export interface LinkFinderGate {
  configured: boolean;
  paused: boolean;
}

export async function getLinkFinderGate(
  userId: string,
): Promise<LinkFinderGate> {
  const config = await prisma.userConfig.findUnique({
    where: { userId },
    select: { linkFinderApiKey: true, linkFinderPausedAt: true },
  });

  if (!config) return { configured: false, paused: false };

  return {
    configured: readKey(config.linkFinderApiKey, userId) !== null,
    paused: Boolean(config.linkFinderPausedAt),
  };
}

/** Is the pass allowed to make a call right now? Both conditions. */
export async function linkFinderReady(userId: string): Promise<boolean> {
  const gate = await getLinkFinderGate(userId);
  return gate.configured && !gate.paused;
}

/**
 * Stop this user's pass until they say otherwise.
 *
 * Idempotent, and deliberately does **not** overwrite an existing pause: the
 * first reason is the true one. A batch draining with three workers in flight
 * will typically see the same 402 three times, and the last one to land should
 * not get to relabel it.
 */
export async function pauseLinkFinder(
  userId: string,
  code: LinkFinderPauseCode,
  detail?: string,
): Promise<void> {
  const { count } = await prisma.userConfig.updateMany({
    where: { userId, linkFinderPausedAt: null },
    data: {
      linkFinderPausedAt: new Date(),
      linkFinderPauseCode: code,
      linkFinderPauseDetail: detail?.slice(0, 500) ?? null,
    },
  });

  if (count > 0) {
    logger.warn(
      `[LinkFinder] Paused the pass for user ${userId}: ${code}${detail ? ` — ${detail}` : ''}. Held rows wait for a manual resume.`,
    );
  }
}

/**
 * Clear the pause. Called only from the route the Resume button hits — never
 * on a timer, and never by the worker.
 *
 * Nothing on this server can observe a topped-up balance or an expired rate
 * limit window, so an automatic resume would just be a slower way of hitting
 * the same wall, with the user's credits paying for the discovery.
 */
export async function resumeLinkFinder(userId: string): Promise<void> {
  await prisma.userConfig.updateMany({
    where: { userId },
    data: {
      linkFinderPausedAt: null,
      linkFinderPauseCode: null,
      linkFinderPauseDetail: null,
    },
  });

  logger.info(`[LinkFinder] User ${userId} resumed the pass`);
}

/** The pause banner's contents, plus whether there is a key at all. */
export async function getLinkFinderState(
  userId: string,
): Promise<LinkFinderState> {
  const config = await prisma.userConfig.findUnique({
    where: { userId },
    select: {
      linkFinderApiKey: true,
      linkFinderPausedAt: true,
      linkFinderPauseCode: true,
      linkFinderPauseDetail: true,
    },
  });

  const configured = Boolean((config?.linkFinderApiKey || '').trim());
  const paused = Boolean(config?.linkFinderPausedAt);
  const code = isPauseCode(config?.linkFinderPauseCode ?? null)
    ? (config!.linkFinderPauseCode as LinkFinderPauseCode)
    : null;
  const copy = code ? LINKFINDER_PAUSE_REASONS[code] : null;

  return {
    configured,
    paused,
    pauseCode: code,
    title: copy?.title ?? null,
    message: copy?.message ?? null,
    detail: config?.linkFinderPauseDetail ?? null,
    pausedAt: config?.linkFinderPausedAt?.toISOString() ?? null,
  };
}
