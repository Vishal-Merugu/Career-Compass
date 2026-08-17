// ─── Email Finder ────────────────────────────────────────────────
// The server's half of email discovery. Three layers, in order:
//
//   1. LinkFinder — a real API with a real key. LinkedIn URL in, a business
//      address out. No browser, no captcha. Tried first because it resolves
//      straight from the profile URL. Skipped when LINKFINDER_API_KEY is unset.
//   2. Anymail Finder — a real API with a real key. No browser, no captcha.
//      Metered: one credit per valid email found, 100 free on signup.
//      Skipped entirely when ANYMAILFINDER_API_KEY is unset.
//   3. Patterns + SMTP — generate the likely formats for the person at their
//      company domain and ask the company's own mail server which exist.
//      Free and unlimited, but Google/Microsoft-hosted domains accept
//      everything, so the usual outcome is a ranked guess.
//
// The second layer needs no credentials at all, which is the point: the
// pipeline keeps working with no key, no browser and no session, so nothing
// depends on a laptop staying open.
//
// **There is deliberately no Mailmeteor layer here.** It used to be layer 2,
// driving their free widget in headless Chromium, and it never returned a
// single address — Cloudflare refuses a Turnstile token to an automated
// browser, measured against headless Chromium, headful bundled Chromium and
// headful real Chrome on a residential IP alike. That capability now lives
// where it actually works: `extension/services/emailFinder.js`, in a real user
// browser, feeding results back through the lookup queue. A `mailmeteor`
// result still arrives here as an `emailSource` — it just arrives from the
// extension rather than being produced locally.
// See docs/adr/0005-server-side-email-finder.md and 0006-email-lookup-queue.md.

import { logger } from '../../lib/logger.js';
import { findEmailViaLinkFinder } from './linkfinder.js';
import { findEmailViaAnymailFinder } from './anymailfinder.js';
import { generateEmailPatterns } from './patterns.js';
import { resolveCompanyDomain } from './domain.js';
import { verifyEmailViaSmtp, type SmtpVerdict } from './smtpVerify.js';

export interface FindEmailInput {
  linkedinUrl: string;
  firstName: string;
  lastName: string;
  companyName: string;
  /** Company website if it was scraped — beats guessing the domain. */
  companyWebsite?: string;
}

export interface FindEmailResult {
  ok: boolean;
  email?: string;
  /** Which layer produced it: anymailfinder | smtp_verified | pattern_guess */
  source?: string;
  /** Confidence in the address, not in the lookup. */
  validation?: string;
  error?: string;
}

/** How many pattern candidates to spend SMTP probes on. */
const MAX_SMTP_PROBES = 4;

/**
 * Once the host cannot reach port 25, every further probe costs a full
 * connect timeout and tells us nothing new. Latch it for the process.
 */
let smtpEgressBlocked = false;

export async function findEmail(
  input: FindEmailInput,
): Promise<FindEmailResult> {
  const { linkedinUrl, firstName, lastName, companyName, companyWebsite } =
    input;

  const profileUrl = normalizeLinkedInUrl(linkedinUrl);

  // ─── Layer 1: LinkFinder ───────────────────────────────────────
  const lf = await findEmailViaLinkFinder(profileUrl);

  if (lf.ok && lf.email) {
    logger.info(
      `[EmailFinder] LinkFinder hit: ${lf.email} for ${firstName} ${lastName}`,
    );
    return {
      ok: true,
      email: lf.email,
      source: 'linkfinder',
      validation: 'provider',
    };
  }

  logger.info(
    `[EmailFinder] LinkFinder miss for ${firstName} ${lastName} (${lf.reason}) — trying Anymail Finder`,
  );

  // ─── Layer 2: Anymail Finder ───────────────────────────────────
  const amf = await findEmailViaAnymailFinder(profileUrl);

  if (amf.ok && amf.email) {
    logger.info(
      `[EmailFinder] Anymail Finder hit: ${amf.email} (${amf.validation}) for ${firstName} ${lastName}`,
    );
    return {
      ok: true,
      email: amf.email,
      source: 'anymailfinder',
      validation: amf.validation || 'unknown',
    };
  }

  logger.info(
    `[EmailFinder] Provider miss for ${firstName} ${lastName} (anymailfinder: ${amf.reason}) — trying patterns`,
  );

  // ─── Layer 3: patterns + SMTP ──────────────────────────────────
  const domain = await resolveCompanyDomain(companyName, companyWebsite);
  if (!domain) {
    return {
      ok: false,
      error: `No mail domain resolved for "${companyName}" (anymailfinder: ${amf.reason})`,
    };
  }

  const patterns = generateEmailPatterns(firstName, lastName, domain);
  if (patterns.length === 0) {
    return {
      ok: false,
      error: `Cannot build patterns from name "${firstName} ${lastName}"`,
    };
  }

  if (!smtpEgressBlocked) {
    let sawCatchAll = false;
    let probed = 0;
    let explicitlyRejected = 0;
    // Addresses the domain's own mail server said do not exist. Tracked, not
    // just counted: the final fallback must never hand back one of these.
    const rejected = new Set<string>();

    for (const candidate of patterns.slice(0, MAX_SMTP_PROBES)) {
      const { verdict, detail } = await verifyEmailViaSmtp(candidate.email);

      if (verdict === 'blocked') {
        smtpEgressBlocked = true;
        logger.warn(
          `[EmailFinder] Outbound SMTP appears blocked (${detail}). Skipping verification for the rest of this process; results downgrade to guesses.`,
        );
        break;
      }

      if (verdict === 'valid') {
        logger.info(`[EmailFinder] SMTP confirmed: ${candidate.email}`);
        return {
          ok: true,
          email: candidate.email,
          source: 'smtp_verified',
          validation: 'valid',
        };
      }

      if (verdict === 'catch_all') {
        // Every address at this domain will be accepted, so probing further
        // candidates cannot separate them. Stop and fall back to weighting.
        sawCatchAll = true;
        break;
      }

      probed += 1;
      if (verdict === 'invalid') {
        explicitlyRejected += 1;
        rejected.add(candidate.email);
      }
      recordVerdict(verdict);
    }

    if (sawCatchAll) {
      logger.info(
        `[EmailFinder] ${domain} accepts all recipients — returning top-weighted guess`,
      );
      return {
        ok: true,
        email: patterns[0].email,
        source: 'pattern_guess',
        validation: 'catch_all',
      };
    }

    // The server answered every probe with a hard rejection. Returning the
    // top pattern anyway would hand outreach an address that the domain's own
    // mail server just said does not exist — a guaranteed bounce, and on a
    // guessed domain quite possibly a stranger's. Report the miss instead.
    if (probed > 0 && explicitlyRejected === probed) {
      logger.info(
        `[EmailFinder] ${domain} rejected all ${probed} candidates for ${firstName} ${lastName}`,
      );
      return {
        ok: false,
        error: `${domain} rejected every candidate address`,
      };
    }

    // Some rejected, some inconclusive. Still worth a guess — but not one the
    // server already told us does not exist. `patterns[0]` is the most likely
    // format, which makes it the *most* likely to have been probed and
    // rejected, so returning it unconditionally would hand outreach a
    // known-bad address whenever a single other candidate came back unknown.
    if (rejected.size > 0) {
      const survivor = patterns.find((p) => !rejected.has(p.email));

      if (!survivor) {
        return {
          ok: false,
          error: `${domain} rejected every candidate address`,
        };
      }

      logger.info(
        `[EmailFinder] Guess for ${firstName} ${lastName} avoiding ${rejected.size} rejected candidate(s): ${survivor.email}`,
      );
      return {
        ok: true,
        email: survivor.email,
        source: 'pattern_guess',
        validation: 'guess',
      };
    }
  }

  // Nothing confirmed and nothing disproved: the most common format is still
  // the best available answer, but it is labelled as the guess it is.
  logger.info(
    `[EmailFinder] Unverified guess for ${firstName} ${lastName}: ${patterns[0].email}`,
  );
  return {
    ok: true,
    email: patterns[0].email,
    source: 'pattern_guess',
    validation: 'guess',
  };
}

function recordVerdict(verdict: SmtpVerdict): void {
  logger.debug(`[EmailFinder] SMTP verdict: ${verdict}`);
}

/** Accept either a full profile URL or a bare LinkedIn handle. */
export function normalizeLinkedInUrl(urlOrHandle: string): string {
  const value = (urlOrHandle || '').trim();
  if (!value) return '';
  if (/^https?:\/\//i.test(value)) return value;
  return `https://www.linkedin.com/in/${value.replace(/^\/+|\/+$/g, '')}`;
}
