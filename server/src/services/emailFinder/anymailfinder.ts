// ─── Anymail Finder Layer ────────────────────────────────────────
// A real, key-authenticated API: no browser, no captcha, no headless
// detection. This is the layer that was always missing — Mailmeteor's free
// widget could not be driven from a server, and neither can Anymail Finder's
// own marketing-site widget (`apiapp.anymailfinder.com/www/search`, gated by
// invisible reCAPTCHA v3). Their documented API has no such gate.
//
//   POST https://api.anymailfinder.com/v5.1/find-email/linkedin-url
//   Authorization: <api key>          (raw key — no "Bearer " prefix)
//   { "linkedin_url": "https://www.linkedin.com/in/…" }
//
// Billing is per *result*: one credit when a valid email is found, nothing
// for not_found/risky/blacklisted, and repeat searches inside 30 days are
// free. New accounts get 100 credits. At this pipeline's ceiling of 15
// profiles/day that is a meaningful runway before the $29/mo plan matters.
//
// Set ANYMAILFINDER_API_KEY to enable. Unset, the layer is skipped and the
// finder falls through to patterns + SMTP exactly as before.

import { logger } from '../../lib/logger.js';

const ENDPOINT = 'https://api.anymailfinder.com/v5.1/find-email/linkedin-url';

// Their docs suggest allowing up to 180s for a real-time search, but this
// call sits inline in the qualification worker. A profile that takes three
// minutes to resolve is worth less than the pipeline it is holding up.
const REQUEST_TIMEOUT_MS = 60_000;

export interface AnymailFinderResult {
  ok: boolean;
  email?: string;
  fullName?: string;
  company?: string;
  jobTitle?: string;
  /** `valid` or `risky` when ok. */
  validation?: string;
  reason?:
    | 'not_found'
    | 'blacklisted'
    | 'no_credits'
    | 'bad_key'
    | 'disabled'
    | 'error';
  detail?: string;
}

/** Shape of a 200 response. */
interface ApiResponse {
  credits_charged?: number;
  email?: string;
  email_status?: 'valid' | 'risky' | 'not_found' | 'blacklisted';
  person_full_name?: string;
  person_company_name?: string;
  person_job_title?: string;
}

/**
 * Latched when the key is rejected or credits run out. Both conditions
 * persist until a human intervenes, so retrying once per profile would just
 * add latency to every remaining lookup and produce the same answer.
 */
let latchedOff = false;
let latchReason: string | null = null;

/** Test seam — lets a suite reset the latch between cases. */
export function resetAnymailFinderLatch(): void {
  latchedOff = false;
  latchReason = null;
}

function apiKey(): string | null {
  const key = (process.env.ANYMAILFINDER_API_KEY || '').trim();
  return key || null;
}

export async function findEmailViaAnymailFinder(
  linkedinUrl: string,
): Promise<AnymailFinderResult> {
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
        // Raw key, per their docs: "set your API key as its value".
        // Tolerate a key pasted with the prefix already attached.
        Authorization: key.replace(/^Bearer\s+/i, ''),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ linkedin_url: linkedinUrl }),
      signal: controller.signal,
    });

    if (response.status === 401) {
      latchedOff = true;
      latchReason = 'invalid API key';
      logger.error(
        '[EmailFinder] Anymail Finder rejected the API key (401). Layer disabled; check ANYMAILFINDER_API_KEY.',
      );
      return { ok: false, reason: 'bad_key' };
    }

    if (response.status === 402) {
      latchedOff = true;
      latchReason = 'out of credits';
      logger.warn(
        '[EmailFinder] Anymail Finder credits exhausted (402). Layer disabled; falling back to patterns + SMTP.',
      );
      return { ok: false, reason: 'no_credits' };
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      return {
        ok: false,
        reason: 'error',
        detail: `HTTP ${response.status} ${body.slice(0, 200)}`,
      };
    }

    const data = (await response.json()) as ApiResponse;

    if (data.credits_charged) {
      logger.info(
        `[EmailFinder] Anymail Finder charged ${data.credits_charged} credit(s)`,
      );
    }

    // `risky` means they found a plausible address but could not confirm it.
    // Still far better evidence than a generated pattern, so it is kept —
    // labelled honestly so outreach can weigh it.
    if (
      (data.email_status === 'valid' || data.email_status === 'risky') &&
      data.email
    ) {
      return {
        ok: true,
        email: data.email,
        fullName: data.person_full_name || '',
        company: data.person_company_name || '',
        jobTitle: data.person_job_title || '',
        validation: data.email_status,
      };
    }

    return {
      ok: false,
      reason: data.email_status === 'blacklisted' ? 'blacklisted' : 'not_found',
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    if (/abort/i.test(message)) {
      return { ok: false, reason: 'error', detail: 'request timed out' };
    }

    logger.error({ err }, '[EmailFinder] Anymail Finder request failed');
    return { ok: false, reason: 'error', detail: message };
  } finally {
    clearTimeout(timer);
  }
}
