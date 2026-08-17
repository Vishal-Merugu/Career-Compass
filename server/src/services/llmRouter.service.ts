// ─── The waterfall: many models, tried in order ──────────────────
//
// An account used to be one model (`UserConfig.llmProvider` + one key), so the
// first 429 from a free tier stopped a 400-profile run dead. Every provider
// worth using here gives away a daily quota and nothing more; the way to run
// this for free is to hold five or six of them and move on the moment one says
// no.
//
// This module is the only thing that knows a chain exists. `llmClient` speaks
// to exactly one `LlmTarget` and cannot fall back on its own — which is
// deliberate, because the decision to try the next key depends on *why* the
// last one failed, and that is a policy question, not a transport one.
//
// The rule the old code broke and this one must not: **a failure is never a
// verdict.** `withLlmFallback` returns only a real answer or throws. It never
// invents one, and when the chain is exhausted it throws an `LlmError` whose
// code still drives `describeJobError`, so a run pauses exactly as before.

import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { decryptSecret, isEncrypted } from '../lib/secretBox.js';
import { LlmError } from '../errors/AppError.js';
import type { JobErrorCode } from '../errors/jobErrors.js';
import {
  SERVER_PROVIDER,
  providerLabel,
  resolveModel,
  targetFromConfig,
  type LlmTarget,
} from '../shared/llmClient.js';
import type { IUserConfig } from '../shared/types.js';

/**
 * How long a credential sits out after each kind of failure.
 *
 * The shape of the number matters more than the number: a rate limit is
 * seconds-to-minutes and a daily quota is hours, and using one value for both
 * either wastes a free tier or hammers a provider that already said no.
 *
 * A cooldown is never a disable. The whole point of a free tier is that it
 * comes back.
 */
const COOLDOWN_SECONDS: Partial<Record<JobErrorCode, number>> = {
  // The provider told us to wait. `Retry-After` overrides this when sent.
  LLM_RATE_LIMIT: 90,
  // Daily allowances reset on the provider's own clock, which we cannot read.
  // An hour is short enough to pick the key back up the same evening and long
  // enough not to spend a request per profile proving it is still exhausted.
  LLM_QUOTA: 60 * 60,
  // A host that is down is usually down for a while, but a blip is a blip.
  LLM_UNREACHABLE: 5 * 60,
  // The model answered, just not with JSON. Often prompt-specific and often
  // fine on the next profile, so the shortest cooldown of the set.
  LLM_BAD_JSON: 2 * 60,
};

/**
 * Failures that a timer cannot fix.
 *
 * A wrong key and a wrong model id fail identically forever. Retrying either on
 * a schedule spends latency on every single profile to reach the same 401, so
 * the credential is parked until the user edits it — and any edit clears it.
 */
const NEEDS_A_HUMAN: ReadonlySet<JobErrorCode> = new Set<JobErrorCode>([
  'LLM_AUTH',
  'LLM_MODEL_NOT_FOUND',
]);

export interface LlmAttempt {
  target: LlmTarget;
  error: LlmError;
}

export interface StoredCredential {
  id: string;
  label: string;
  provider: string;
  apiKey: string | null;
  baseUrl: string;
  model: string;
}

/** A stored row as something callable. The one place the key is decrypted. */
export function targetFromCredential(row: StoredCredential): LlmTarget {
  return {
    credentialId: row.id,
    label: row.label || providerLabel(row.provider),
    provider: row.provider,
    // Decrypted here so no call site has to know the column is encrypted, and
    // so a row written before encryption existed still works — the same
    // treatment `storage.adapter` gives `llmApiKey`.
    apiKey: row.apiKey
      ? isEncrypted(row.apiKey)
        ? decryptSecret(row.apiKey)
        : row.apiKey
      : null,
    url: row.baseUrl,
    model: row.model,
  };
}

/** A target that could not possibly be called: no address, or no model named. */
function isUsable(target: LlmTarget): boolean {
  if (target.provider === SERVER_PROVIDER) return true;
  return Boolean(resolveModel(target));
}

/**
 * The ordered list of models to try for this account, best first.
 *
 * Order is the user's: `priority` is what they dragged the rows into. Cooling
 * credentials drop to the back rather than out — see below.
 *
 * The legacy `UserConfig` model is appended last when it is not already
 * represented, which is what makes this change invisible to an account that
 * never adds a credential: their chain is exactly the one model they had.
 */
export async function resolveChain(
  userId: string,
  config?: IUserConfig,
): Promise<LlmTarget[]> {
  const rows = await prisma.llmCredential.findMany({
    where: { userId, enabled: true, disabledCode: null },
    orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }],
    select: {
      id: true,
      label: true,
      provider: true,
      apiKey: true,
      baseUrl: true,
      model: true,
      cooldownUntil: true,
    },
  });

  const now = Date.now();
  const ready: LlmTarget[] = [];
  const cooling: Array<{ target: LlmTarget; until: number }> = [];

  for (const row of rows) {
    const target = targetFromCredential(row);
    if (!isUsable(target)) continue;

    const until = row.cooldownUntil?.getTime() ?? 0;
    if (until > now) cooling.push({ target, until });
    else ready.push(target);
  }

  // Cooling keys go to the **back of the queue, not off it**. A cooldown is an
  // estimate we made up — the provider rarely tells us when a daily quota
  // resets — and treating a guess as authoritative would fail a run that had a
  // working key sitting right there. Soonest-expiring first, so the one most
  // likely to have recovered is tried first.
  cooling.sort((a, b) => a.until - b.until);

  const chain = [...ready, ...cooling.map((c) => c.target)];

  if (config) {
    const legacy = targetFromConfig(config);
    const duplicate = chain.some(
      (t) =>
        t.provider === legacy.provider &&
        resolveModel(t) === resolveModel(legacy) &&
        t.url === legacy.url,
    );
    if (!duplicate && isUsable(legacy)) chain.push(legacy);
  }

  return chain;
}

/** Bookkeeping after a credential answered. Never blocks the caller's result. */
async function recordSuccess(target: LlmTarget): Promise<void> {
  if (!target.credentialId) return;
  try {
    await prisma.llmCredential.update({
      where: { id: target.credentialId },
      data: {
        lastUsedAt: new Date(),
        successCount: { increment: 1 },
        // A working call is the only proof a cooldown was over-long. Clearing
        // it here is what lets a key that recovered early stop being penalised.
        cooldownUntil: null,
        lastErrorCode: null,
      },
    });
  } catch (err) {
    logger.warn(`[LlmRouter] Could not record success: ${String(err)}`);
  }
}

async function recordFailure(
  target: LlmTarget,
  error: LlmError,
): Promise<void> {
  if (!target.credentialId) return;

  const seconds =
    error.retryAfterSeconds ?? COOLDOWN_SECONDS[error.code] ?? 5 * 60;
  const parked = NEEDS_A_HUMAN.has(error.code);

  try {
    await prisma.llmCredential.update({
      where: { id: target.credentialId },
      data: {
        lastErrorAt: new Date(),
        lastErrorCode: error.code,
        failureCount: { increment: 1 },
        disabledCode: parked ? error.code : undefined,
        cooldownUntil: parked ? null : new Date(Date.now() + seconds * 1000),
      },
    });
  } catch (err) {
    logger.warn(`[LlmRouter] Could not record failure: ${String(err)}`);
  }
}

/**
 * The code to report when nothing worked.
 *
 * If every model was merely busy, say so — that is a wait, not a fix, and the
 * copy for it tells the user to wait. If any failed for a reason a human has to
 * act on, that is the more useful thing to surface even when it was not the
 * last failure.
 */
function aggregateCode(failures: LlmAttempt[]): JobErrorCode {
  const codes = failures.map((f) => f.error.code);
  const transient = codes.every(
    (c) => c === 'LLM_RATE_LIMIT' || c === 'LLM_QUOTA',
  );
  if (transient) {
    return codes.includes('LLM_QUOTA') ? 'LLM_QUOTA' : 'LLM_RATE_LIMIT';
  }
  return 'LLM_ALL_FAILED';
}

function exhausted(failures: LlmAttempt[]): LlmError {
  if (failures.length === 0) {
    return new LlmError('LLM_UNREACHABLE', 'No AI model is configured.', {
      detail:
        'This account has no usable AI credential: every one is disabled, or none names a model.',
    });
  }

  // One model in the chain is the pre-existing world. Rethrow its own error
  // untouched so its message, its code and its `Retry-After` survive exactly as
  // they did before the router existed.
  if (failures.length === 1) return failures[0]!.error;

  const summary = failures
    .map((f) => `${f.target.label}: ${f.error.message}`)
    .join(' · ');

  const soonest = failures
    .map((f) => f.error.retryAfterSeconds)
    .filter((s): s is number => typeof s === 'number' && s > 0)
    .sort((a, b) => a - b)[0];

  return new LlmError(
    aggregateCode(failures),
    `All ${failures.length} AI models failed.`,
    {
      detail: summary,
      retryAfterSeconds: soonest,
    },
  );
}

/**
 * Run `call` against each model in turn until one answers.
 *
 * `call` should include **everything that has to succeed**, not just the HTTP
 * request — parsing the answer especially. `evaluateProfile` throws
 * `LLM_BAD_JSON` when a model returns prose where JSON was asked for, and a
 * model that cannot follow the format is exactly the case where trying the next
 * one is right. Wrapping only the fetch would have left that failure fatal.
 *
 * Anything that is not an `LlmError` is rethrown immediately and un-retried: a
 * `TypeError` in our own callback is a bug, and running it five more times
 * against five more providers only makes the stack trace harder to find.
 */
export async function withLlmFallback<T>(
  userId: string,
  call: (target: LlmTarget) => Promise<T>,
  options: {
    config?: IUserConfig;
    onFallback?: (attempt: LlmAttempt) => void;
  } = {},
): Promise<T> {
  const chain = await resolveChain(userId, options.config);
  const failures: LlmAttempt[] = [];

  for (const target of chain) {
    try {
      const result = await call(target);
      await recordSuccess(target);

      if (failures.length > 0) {
        logger.info(
          `[LlmRouter] "${target.label}" answered after ${failures.length} failed model(s).`,
        );
      }
      return result;
    } catch (err) {
      if (!(err instanceof LlmError)) throw err;

      failures.push({ target, error: err });
      await recordFailure(target, err);

      logger.warn(
        `[LlmRouter] "${target.label}" failed (${err.code}): ${err.message}. ` +
          `${chain.length - failures.length} model(s) left.`,
      );
      options.onFallback?.({ target, error: err });
    }
  }

  throw exhausted(failures);
}

/**
 * What the Settings screen shows for each credential.
 *
 * Never includes the key. `apiKeySet` is the only thing the UI needs, and the
 * decrypted value has no business leaving the process — the same rule
 * `/api/settings/ai` already follows for `llmApiKey`.
 */
export interface LlmCredentialView {
  id: string;
  label: string;
  provider: string;
  baseUrl: string;
  model: string;
  priority: number;
  enabled: boolean;
  apiKeySet: boolean;
  /** `ready` | `cooling` | `disabled` | `off` — what the status pill renders. */
  status: 'ready' | 'cooling' | 'disabled' | 'off';
  cooldownUntil: string | null;
  disabledCode: string | null;
  lastErrorCode: string | null;
  lastUsedAt: string | null;
  successCount: number;
  failureCount: number;
}

export function credentialView(row: {
  id: string;
  label: string;
  provider: string;
  apiKey: string | null;
  baseUrl: string;
  model: string;
  priority: number;
  enabled: boolean;
  cooldownUntil: Date | null;
  disabledCode: string | null;
  lastErrorCode: string | null;
  lastUsedAt: Date | null;
  successCount: number;
  failureCount: number;
}): LlmCredentialView {
  const cooling = Boolean(
    row.cooldownUntil && row.cooldownUntil.getTime() > Date.now(),
  );

  return {
    id: row.id,
    label: row.label,
    provider: row.provider,
    baseUrl: row.baseUrl,
    model: row.model,
    priority: row.priority,
    enabled: row.enabled,
    apiKeySet: Boolean(row.apiKey),
    status: !row.enabled
      ? 'off'
      : row.disabledCode
        ? 'disabled'
        : cooling
          ? 'cooling'
          : 'ready',
    cooldownUntil: row.cooldownUntil?.toISOString() ?? null,
    disabledCode: row.disabledCode,
    lastErrorCode: row.lastErrorCode,
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    successCount: row.successCount,
    failureCount: row.failureCount,
  };
}
