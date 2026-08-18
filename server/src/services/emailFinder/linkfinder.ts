// ─── LinkFinder Layer ────────────────────────────────────────────
// A second key-authenticated API, alongside Anymail Finder: LinkedIn URL in,
// a real business address out. No browser, no captcha — which is the whole
// point of a server-side layer, since the free provider widgets need a real
// browser to solve their Turnstile/reCAPTCHA (that path lives in the
// extension).
//
//   POST https://linkfinder-free-tools.hamoureliasse.workers.dev/
//   x-api-secret: <key>
//   { "type": "business_email_finder", "linkedin_url": "https://…/in/…" }
//   → 200 { "email": "person@company.com" }   (no email field on a miss)
//
// The endpoint is **slow** — a single lookup measured ~40s, and a cold call
// timed out at 30s — so the timeout here is generous and the batch worker that
// calls it runs bounded concurrency rather than one-at-a-time.
//
// Set LINKFINDER_API_KEY to enable. Unset, the layer is skipped and the finder
// falls through to Anymail Finder / patterns exactly as before. The key is a
// secret: it lives only in `.env` (gitignored) and is never logged.

import { logger } from '../../lib/logger.js';

const ENDPOINT = 'https://linkfinder-free-tools.hamoureliasse.workers.dev/';

// The site's own client sends these; the Worker gates on the API secret, but
// matching the browser's origin/referer keeps us indistinguishable from a
// legitimate call and costs nothing.
const ORIGIN = 'https://linkfinderai.com';

// The endpoint routinely takes ~40s. Anything past a minute is more likely a
// hung call than a slow one, and this sits in a worker draining a batch.
const REQUEST_TIMEOUT_MS = 75_000;

export interface LinkFinderResult {
  ok: boolean;
  email?: string;
  reason?: 'not_found' | 'bad_key' | 'disabled' | 'error';
  detail?: string;
}

/** Shape of a 200 response. `email` is absent on a miss. */
interface ApiResponse {
  email?: string | null;
}

/**
 * Latched off when the key is rejected. A bad or revoked secret produces the
 * same answer on every subsequent call, so retrying once per profile only adds
 * a 40s timeout to each remaining lookup for nothing.
 */
let latchedOff = false;
let latchReason: string | null = null;

/** Test seam — lets a suite reset the latch between cases. */
export function resetLinkFinderLatch(): void {
  latchedOff = false;
  latchReason = null;
}

/**
 * Whether the layer is configured. Exported so the queue can reserve fresh rows
 * for LinkFinder and the worker can skip the pass — both must agree on the same
 * answer, so it lives with the key it reads.
 */
export function linkFinderEnabled(): boolean {
  return Boolean((process.env.LINKFINDER_API_KEY || '').trim());
}

function apiKey(): string | null {
  const key = (process.env.LINKFINDER_API_KEY || '').trim();
  return key || null;
}

export async function findEmailViaLinkFinder(
  linkedinUrl: string,
): Promise<LinkFinderResult> {
  const key = apiKey();
  if (!key) return { ok: false, reason: 'disabled', detail: 'no API key set' };
  if (latchedOff) {
    return { ok: false, reason: 'disabled', detail: latchReason ?? 'latched' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: '*/*',
        Origin: ORIGIN,
        Referer: `${ORIGIN}/`,
        'x-api-secret': key,
      },
      body: JSON.stringify({
        type: 'business_email_finder',
        linkedin_url: linkedinUrl,
      }),
      signal: controller.signal,
    });

    // 401/403 → the secret is wrong or revoked. Latch, so the rest of the
    // batch does not each pay a round-trip to rediscover it.
    if (response.status === 401 || response.status === 403) {
      latchedOff = true;
      latchReason = `rejected the API secret (HTTP ${response.status})`;
      logger.error(
        `[EmailFinder] LinkFinder ${latchReason}. Layer disabled; check LINKFINDER_API_KEY.`,
      );
      return { ok: false, reason: 'bad_key' };
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      return {
        ok: false,
        reason: 'error',
        detail: `HTTP ${response.status} ${body.slice(0, 200)}`,
      };
    }

    const data = (await response.json().catch(() => ({}))) as ApiResponse;
    const email = (data.email || '').trim();

    if (email) {
      return { ok: true, email };
    }

    return { ok: false, reason: 'not_found' };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    if (/abort/i.test(message)) {
      return { ok: false, reason: 'error', detail: 'request timed out' };
    }

    logger.error({ err }, '[EmailFinder] LinkFinder request failed');
    return { ok: false, reason: 'error', detail: message };
  } finally {
    clearTimeout(timer);
  }
}
