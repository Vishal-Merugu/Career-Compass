// ─── What went wrong with a run, in the words the user needs ─────
//
// One table, one place. `JobEvent.code`, `SearchJob.failureCode` and the 422
// from `POST /api/jobs` all hold a `JobErrorCode`, and the dashboard renders
// the copy from here.
//
// The rule this exists to enforce: **a raw error string is never the primary
// message.** `LLM Error: fetch failed` is what 368 profiles were rejected with
// on 2026-08-09 — technically accurate, and it told the user nothing about what
// had happened or what to do. The raw text still travels, as `detail`, behind a
// disclosure.

/** Stable machine keys. Persisted, so do not rename one without a migration. */
export type JobErrorCode =
  | 'LLM_UNREACHABLE'
  | 'LLM_MODEL_NOT_FOUND'
  | 'LLM_AUTH'
  | 'LLM_RATE_LIMIT'
  | 'LLM_QUOTA'
  | 'LLM_BAD_JSON'
  | 'LLM_ALL_FAILED'
  | 'SESSION_MISSING'
  | 'SESSION_EXPIRED'
  | 'LINKEDIN_RATE_LIMIT'
  | 'COMPANY_NOT_FOUND'
  | 'NO_RESULTS'
  | 'SMTP_BLOCKED'
  | 'UNKNOWN';

export interface JobErrorCopy {
  /** One plain sentence. No error codes, no stack traces, no jargon. */
  message: string;
  /** What the user should actually do about it. */
  fix: string;
}

/**
 * Context woven into the copy, when a bare sentence would be less useful.
 *
 * Naming the model in "the model X is not installed" is the difference between
 * a message the user can act on and one they have to go look up.
 */
export interface JobErrorContext {
  model?: string | null;
  provider?: string | null;
  retryAfterSeconds?: number | null;
}

const COPY: Record<JobErrorCode, (ctx: JobErrorContext) => JobErrorCopy> = {
  LLM_UNREACHABLE: () => ({
    message: 'The AI model could not be reached.',
    fix: 'Check the address in Settings → AI model, then resume the run.',
  }),
  LLM_MODEL_NOT_FOUND: (ctx) => ({
    message: ctx.model
      ? `The AI model "${ctx.model}" is not installed.`
      : 'The configured AI model is not installed.',
    fix: 'Pick one of the available models in Settings → AI model.',
  }),
  LLM_AUTH: (ctx) => ({
    message: ctx.provider
      ? `${ctx.provider} rejected the API key.`
      : 'The AI provider rejected the API key.',
    fix: 'Re-enter the key in Settings → AI model.',
  }),
  LLM_RATE_LIMIT: (ctx) => ({
    message: ctx.provider
      ? `${ctx.provider} is rate-limiting these requests.`
      : "The AI provider's rate limit was hit.",
    fix: ctx.retryAfterSeconds
      ? `The run resumes on its own in about ${Math.ceil(ctx.retryAfterSeconds / 60)} minute(s).`
      : 'Wait for the limit to clear, or switch provider in Settings → AI model.',
  }),
  LLM_QUOTA: (ctx) => ({
    message: ctx.provider
      ? `The ${ctx.provider} quota or credit is exhausted.`
      : "The AI provider's quota or credit is exhausted.",
    fix: 'Add credit, or switch provider in Settings → AI model.',
  }),
  // Only ever raised when the chain held **more than one** model. A single
  // configured model still fails with its own specific code, so nothing about
  // the old one-provider messages changed.
  LLM_ALL_FAILED: () => ({
    message: 'Every AI model in your list failed.',
    fix: 'Open Settings → AI models: each one shows why it failed. Add another key, or wait for a rate limit to clear.',
  }),
  LLM_BAD_JSON: () => ({
    message: 'The AI model returned something unreadable.',
    fix: 'A smaller model often causes this — try a larger one in Settings → AI model.',
  }),
  SESSION_MISSING: () => ({
    message: 'No LinkedIn session has been supplied yet.',
    fix: 'Open the Chrome extension while logged in to LinkedIn. It pushes the session automatically.',
  }),
  SESSION_EXPIRED: () => ({
    message: 'The LinkedIn session expired.',
    fix: 'Open the Chrome extension while logged in to LinkedIn — the run resumes by itself.',
  }),
  LINKEDIN_RATE_LIMIT: () => ({
    message: 'LinkedIn is rate-limiting this session.',
    fix: 'The run is paused. Try again in an hour.',
  }),
  COMPANY_NOT_FOUND: () => ({
    message: 'LinkedIn returned no company for that URL.',
    fix: 'Check the company URL and start a new run.',
  }),
  NO_RESULTS: () => ({
    message: 'LinkedIn returned no more people for this search.',
    fix: 'Widen the search, or lower the target number of profiles.',
  }),
  SMTP_BLOCKED: () => ({
    message: 'Email verification is unavailable on this server.',
    fix: 'Addresses will be marked "guess" rather than verified. Outbound port 25 is blocked here.',
  }),
  UNKNOWN: () => ({
    message: 'The run stopped because of an unexpected error.',
    fix: 'Open the technical detail below, or check the server log.',
  }),
};

/**
 * Codes that will not fix themselves before the end of the run.
 *
 * An unreachable host, a bad key, a missing model or an exhausted quota fails
 * identically for every remaining profile, so the run pauses on the **first**
 * one rather than burning through candidates to prove it. `LLM_BAD_JSON` is
 * deliberately absent: that one is about a particular profile's prompt and the
 * next profile may well succeed, so it is counted by the consecutive-failure
 * breaker instead.
 */
const RUN_FATAL: ReadonlySet<JobErrorCode> = new Set<JobErrorCode>([
  // Fatal precisely *because* it is the whole chain. One model rate-limiting
  // is now a fallback, not a pause — the run only stops when nothing is left.
  'LLM_ALL_FAILED',
  'LLM_UNREACHABLE',
  'LLM_MODEL_NOT_FOUND',
  'LLM_AUTH',
  'LLM_RATE_LIMIT',
  'LLM_QUOTA',
  'SESSION_MISSING',
  'SESSION_EXPIRED',
  'LINKEDIN_RATE_LIMIT',
  'COMPANY_NOT_FOUND',
]);

export function isRunFatal(code: JobErrorCode): boolean {
  return RUN_FATAL.has(code);
}

export function describeJobError(
  code: JobErrorCode,
  ctx: JobErrorContext = {},
): JobErrorCopy {
  return (COPY[code] ?? COPY.UNKNOWN)(ctx);
}
