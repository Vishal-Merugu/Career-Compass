// ─── LinkFinder Layer ────────────────────────────────────────────
// LinkedIn URL in, a real business address out. No browser, no captcha —
// which is the whole point of a server-side layer, since the free provider
// widgets need a real browser to solve their Turnstile/reCAPTCHA (that path
// lives in the extension).
//
// Two sources, tried in order, because the official one is the right home but
// its email endpoint is intermittently broken:
//
//   1. Official API — POST https://api.linkfinderai.com, Bearer auth.
//        { "type": "linkedin_profile_to_email", "input_data": "<profile url>" }
//        → 200 { "status": "success", "result": "person@company.com" }  (result
//          may be "" when nothing is found — still a billed credit).
//      Proper rate limits (~1 req/s per key; 429 → exponential backoff) and a
//      credit balance, not a 20/hour wall. Set LINKFINDER_API_KEY to enable.
//
//   2. Free worker — POST https://linkfinder-free-tools.hamoureliasse.workers.dev/
//        x-api-secret: <secret>
//        { "type": "business_email_finder", "linkedin_url": "<profile url>" }
//        → 200 { "email": "person@company.com" }
//      Capped at **20 requests/hour** (429 { "message": "…maximum 20 requests
//      per hour" }). Used only as a fallback for when the official endpoint is
//      down, and never worth hammering. Set LINKFINDER_FREE_SECRET to enable.
//
// Both keys are secrets: they live only in `.env` (gitignored) and are never
// logged.

import { logger } from '../../lib/logger.js';

const OFFICIAL_ENDPOINT = 'https://api.linkfinderai.com';
const FREE_ENDPOINT =
  'https://linkfinder-free-tools.hamoureliasse.workers.dev/';

// The free worker's own site sends these; matching them keeps a fallback call
// indistinguishable from a legitimate one and costs nothing.
const FREE_ORIGIN = 'https://linkfinderai.com';

// Official lookups usually answer in a few seconds; the free worker can take
// ~40s. One ceiling covers both — past it a call is hung, not slow.
const REQUEST_TIMEOUT_MS = 75_000;

// The official docs ask for ~1 request/second per key on single lookups, and
// name back-to-back calls as the top cause of 429s. Space them process-wide so
// a concurrent batch cannot burst.
const OFFICIAL_MIN_SPACING_MS = 1_100;

// On a 429, back off and retry a bounded number of times: 1s, then 2s. Kept
// short because this runs inline in a batch drain, not a background job.
const OFFICIAL_MAX_RETRIES = 2;

export interface LinkFinderResult {
  ok: boolean;
  email?: string;
  /** Which source answered — for logs only; the emailSource stays `linkfinder`. */
  via?: 'official' | 'free';
  reason?:
    | 'not_found'
    | 'rate_limited'
    | 'bad_key'
    | 'no_credits'
    | 'disabled'
    | 'error';
  detail?: string;
}

function officialKey(): string | null {
  const key = (process.env.LINKFINDER_API_KEY || '').trim();
  return key || null;
}

function freeSecret(): string | null {
  const key = (process.env.LINKFINDER_FREE_SECRET || '').trim();
  return key || null;
}

/**
 * Whether the layer is configured at all. Exported so the queue can reserve
 * fresh rows for LinkFinder and the worker can skip the pass — both must agree
 * on the same answer, so it lives with the keys it reads.
 */
export function linkFinderEnabled(): boolean {
  return Boolean(officialKey() || freeSecret());
}

// ─── Latches ─────────────────────────────────────────────────────
// A rejected key or an empty credit balance produces the same answer on every
// subsequent call, so retrying per profile only adds latency. Latch until the
// process restarts. The free worker's hourly cap is *not* latched here — it
// resets on its own, and the worker paces around it.
let officialLatched: string | null = null;

/** Test seam — reset process latches between cases. */
export function resetLinkFinderLatch(): void {
  officialLatched = null;
  lastOfficialCallAt = 0;
}

// ─── Official API ────────────────────────────────────────────────
let lastOfficialCallAt = 0;

async function paceOfficial(): Promise<void> {
  const wait = lastOfficialCallAt + OFFICIAL_MIN_SPACING_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastOfficialCallAt = Date.now();
}

async function viaOfficial(profileUrl: string): Promise<LinkFinderResult> {
  const key = officialKey();
  if (!key) return { ok: false, reason: 'disabled', detail: 'no official key' };
  if (officialLatched) {
    return { ok: false, reason: 'disabled', detail: officialLatched };
  }

  for (let attempt = 0; ; attempt++) {
    await paceOfficial();

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(OFFICIAL_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${key.replace(/^Bearer\s+/i, '')}`,
        },
        body: JSON.stringify({
          type: 'linkedin_profile_to_email',
          input_data: profileUrl,
        }),
        signal: controller.signal,
      });

      if (response.status === 401) {
        officialLatched = 'official key rejected (401)';
        logger.error(
          '[EmailFinder] LinkFinder official API rejected the key (401). Disabled; check LINKFINDER_API_KEY.',
        );
        return { ok: false, via: 'official', reason: 'bad_key' };
      }
      if (response.status === 402) {
        officialLatched = 'official credits exhausted (402)';
        logger.warn(
          '[EmailFinder] LinkFinder official API out of credits (402). Disabled; falling back to the free worker.',
        );
        return { ok: false, via: 'official', reason: 'no_credits' };
      }
      if (response.status === 429) {
        if (attempt < OFFICIAL_MAX_RETRIES) {
          const backoff = 1_000 * 2 ** attempt;
          logger.info(
            `[EmailFinder] LinkFinder official 429 — backing off ${backoff}ms`,
          );
          await new Promise((r) => setTimeout(r, backoff));
          continue;
        }
        return { ok: false, via: 'official', reason: 'rate_limited' };
      }

      if (!response.ok) {
        // 500 "Workflow execution failed" lands here. Transient on their side —
        // report an error and let the caller fall back, do not latch.
        const detail = (await response.text().catch(() => '')).slice(0, 200);
        return {
          ok: false,
          via: 'official',
          reason: 'error',
          detail: `HTTP ${response.status} ${detail}`,
        };
      }

      const data = (await response.json().catch(() => ({}))) as {
        status?: string;
        result?: string | null;
        job_id?: string;
      };

      // An async fallback (202/job_id) is too slow to poll inline in a batch
      // drain. Treat it as a miss so the caller can try the free worker.
      if (data.job_id) {
        return {
          ok: false,
          via: 'official',
          reason: 'error',
          detail: 'async job — not polled inline',
        };
      }

      const email = (data.result || '').trim();
      if (email) return { ok: true, email, via: 'official' };
      return { ok: false, via: 'official', reason: 'not_found' };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/abort/i.test(message)) {
        return {
          ok: false,
          via: 'official',
          reason: 'error',
          detail: 'timed out',
        };
      }
      logger.error({ err }, '[EmailFinder] LinkFinder official request failed');
      return { ok: false, via: 'official', reason: 'error', detail: message };
    } finally {
      clearTimeout(timer);
    }
  }
}

// ─── Free worker (fallback) ──────────────────────────────────────
async function viaFreeWorker(profileUrl: string): Promise<LinkFinderResult> {
  const secret = freeSecret();
  if (!secret)
    return { ok: false, reason: 'disabled', detail: 'no free secret' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(FREE_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: '*/*',
        Origin: FREE_ORIGIN,
        Referer: `${FREE_ORIGIN}/`,
        'x-api-secret': secret,
      },
      body: JSON.stringify({
        type: 'business_email_finder',
        linkedin_url: profileUrl,
      }),
      signal: controller.signal,
    });

    // The free tool answers a rate-limit with 429 and a body that says
    // "maximum 20 requests per hour". Surface it distinctly so the worker can
    // hold the row for the next window instead of burning an attempt on it.
    if (response.status === 429) {
      return { ok: false, via: 'free', reason: 'rate_limited' };
    }
    if (response.status === 401 || response.status === 403) {
      return { ok: false, via: 'free', reason: 'bad_key' };
    }
    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).slice(0, 200);
      return {
        ok: false,
        via: 'free',
        reason: 'error',
        detail: `HTTP ${response.status} ${detail}`,
      };
    }

    const data = (await response.json().catch(() => ({}))) as {
      email?: string | null;
    };
    const email = (data.email || '').trim();
    if (email) return { ok: true, email, via: 'free' };
    return { ok: false, via: 'free', reason: 'not_found' };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/abort/i.test(message)) {
      return { ok: false, via: 'free', reason: 'error', detail: 'timed out' };
    }
    logger.error(
      { err },
      '[EmailFinder] LinkFinder free-worker request failed',
    );
    return { ok: false, via: 'free', reason: 'error', detail: message };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Find a business email for a LinkedIn profile URL.
 *
 * Official API first; on anything short of a hit that is not a hard stop
 * (bad key / no credits / genuine not_found), fall back to the free worker.
 * A `rate_limited` result is propagated so the caller can hold the row rather
 * than spend an attempt on it.
 */
export async function findEmailViaLinkFinder(
  profileUrl: string,
): Promise<LinkFinderResult> {
  const official = await viaOfficial(profileUrl);
  if (official.ok) return official;

  // Nothing to gain from the free worker on these: the profile genuinely has no
  // address, or the official layer is off. Everything else (500, timeout,
  // rate_limited, async) is worth a fallback attempt.
  const officialSettled =
    official.reason === 'not_found' || official.reason === 'disabled';

  if (!freeSecret() || (officialSettled && official.reason === 'not_found')) {
    return official;
  }

  const free = await viaFreeWorker(profileUrl);
  if (free.ok) return free;

  // Neither found it. Prefer the more informative reason: a rate-limit or a
  // real not_found tells the caller what to do; a bare "disabled" does not.
  if (free.reason === 'rate_limited') return free;
  if (official.reason && official.reason !== 'disabled') return official;
  return free;
}
