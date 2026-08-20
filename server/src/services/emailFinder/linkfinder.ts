// ─── LinkFinder Layer ────────────────────────────────────────────
// LinkedIn URL in, a real business address out. No browser, no captcha —
// which is the whole point of a server-side layer, since the free provider
// widgets need a real browser to solve their Turnstile/reCAPTCHA (that path
// lives in the extension).
//
//   POST https://api.linkfinderai.com   Authorization: Bearer <key>
//     { "type": "linkedin_profile_to_email", "input_data": "<profile url>" }
//   → 200 { "status": "success", "result": "person@company.com" }
//     `result` may be "" or null when nothing is found — still a billed credit.
//
// **The key is the user's own, resolved per request** from `UserConfig`
// (`linkFinderAccount.service.ts`). This module holds no key, reads no
// environment variable, and keeps no per-account state: a credit balance
// belongs to whoever paid for it, and an instance-wide key would spend one
// user's credits on another's lookups. Callers pass the key in.
//
// There used to be a second source here — a free Cloudflare worker capped at
// 20 requests/hour, used when the official endpoint 500'd. It was removed with
// the move to per-user keys: it is an unmetered shared resource with no
// per-account balance, so it cannot honour "pause when *this user's* credits
// run out", and a 20/hour ceiling silently became the real limit whenever the
// official API wobbled. A miss is now a miss, and the extension waterfall is
// the fallback.

import { logger } from '../../lib/logger.js';

const ENDPOINT = 'https://api.linkfinderai.com';

// Lookups usually answer in ~3s. The docs note that any endpoint can go async
// past a ~27s window; past this ceiling a call is hung, not slow.
const REQUEST_TIMEOUT_MS = 45_000;

// The docs ask for ~1 request/second per key on single lookups and name
// back-to-back calls as the top cause of 429s. Paced per key rather than
// process-wide: two users' keys have two separate limits, and sharing one
// pacer between them would halve the throughput of both for no reason.
const MIN_SPACING_MS = 1_100;

// On a 429, back off and retry twice — 1s, then 2s — before reporting it. Kept
// short because this runs inline in a batch drain, not a background job, and
// because a persistent 429 pauses the pass rather than being retried forever.
const MAX_RETRIES = 2;

export interface LinkFinderResult {
  ok: boolean;
  email?: string;
  reason?:
    | 'not_found'
    | 'rate_limited'
    | 'bad_key'
    | 'no_credits'
    | 'disabled'
    | 'error';
  detail?: string;
}

/**
 * Reasons that mean "stop the whole pass", not "this profile has no email".
 *
 * Each returns the same answer on every subsequent call, so continuing spends
 * the rest of the batch — and, for `no_credits`, real money — proving it. The
 * worker maps these onto a pause; everything else is a per-row miss.
 */
export function isPausingReason(
  reason: LinkFinderResult['reason'],
): reason is 'no_credits' | 'rate_limited' | 'bad_key' {
  return (
    reason === 'no_credits' || reason === 'rate_limited' || reason === 'bad_key'
  );
}

// ─── Pacing, per key ─────────────────────────────────────────────
// Keyed by the credential, not the user: it is the key that carries the rate
// limit. A short digest rather than the key itself so a heap dump or a stray
// log of this map cannot leak a credential.
const lastCallAt = new Map<string, number>();

function paceBucket(key: string): string {
  return `${key.length}:${key.slice(0, 4)}:${key.slice(-4)}`;
}

async function pace(key: string): Promise<void> {
  const bucket = paceBucket(key);
  const wait = (lastCallAt.get(bucket) ?? 0) + MIN_SPACING_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCallAt.set(bucket, Date.now());
}

/** Test seam — clears the pacing map between cases. */
export function resetLinkFinderPacing(): void {
  lastCallAt.clear();
}

/**
 * Find a business email for a LinkedIn profile URL, using `apiKey`.
 *
 * Never throws for a provider outcome: a rejected key, an empty balance and a
 * genuine miss are all `{ ok: false, reason }`, because the caller has to tell
 * them apart to decide between pausing the pass and moving to the next row.
 */
export async function findEmailViaLinkFinder(
  profileUrl: string,
  apiKey: string | null,
): Promise<LinkFinderResult> {
  const key = (apiKey || '').trim().replace(/^Bearer\s+/i, '');
  if (!key) return { ok: false, reason: 'disabled', detail: 'no API key' };

  for (let attempt = 0; ; attempt++) {
    await pace(key);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${key}`,
        },
        body: JSON.stringify({
          type: 'linkedin_profile_to_email',
          input_data: profileUrl,
        }),
        signal: controller.signal,
      });

      if (response.status === 401) {
        return { ok: false, reason: 'bad_key', detail: 'HTTP 401' };
      }
      if (response.status === 402) {
        return { ok: false, reason: 'no_credits', detail: 'HTTP 402' };
      }
      if (response.status === 429) {
        if (attempt < MAX_RETRIES) {
          const backoff = 1_000 * 2 ** attempt;
          logger.info(
            `[EmailFinder] LinkFinder 429 — backing off ${backoff}ms`,
          );
          await new Promise((r) => setTimeout(r, backoff));
          continue;
        }
        return { ok: false, reason: 'rate_limited', detail: 'HTTP 429' };
      }

      if (!response.ok) {
        // 500 "Workflow execution failed" lands here. Transient on their side,
        // so it is a per-row miss — it must not pause the pass.
        const detail = (await response.text().catch(() => '')).slice(0, 200);
        return {
          ok: false,
          reason: 'error',
          detail: `HTTP ${response.status} ${detail}`,
        };
      }

      const data = (await response.json().catch(() => ({}))) as {
        status?: string;
        result?: string | null;
        message?: string;
        job_id?: string;
      };

      // Any endpoint can fall back to async past their ~27s window. Polling a
      // job inline would hold a drain slot for a minute per row, and the job
      // expires in ten. Treat it as a miss; the extension can still try.
      if (data.job_id) {
        return {
          ok: false,
          reason: 'error',
          detail: 'async job — not polled inline',
        };
      }

      const email = (data.result || '').trim();
      if (email) return { ok: true, email };
      return { ok: false, reason: 'not_found', detail: data.message };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/abort/i.test(message)) {
        return { ok: false, reason: 'error', detail: 'timed out' };
      }
      logger.error({ err }, '[EmailFinder] LinkFinder request failed');
      return { ok: false, reason: 'error', detail: message };
    } finally {
      clearTimeout(timer);
    }
  }
}
