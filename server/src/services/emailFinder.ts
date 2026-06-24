import type { Page } from 'puppeteer';
import { BrowserManager } from '../lib/browserManager.js';
import { logger } from '../lib/logger.js';
import { delay } from '../shared/rateLimiter.js';
import { IEmailFinderResult } from '../shared/types.js';

const MAILMETEOR_URL = 'https://mailmeteor.com/tools/linkedin-email-finder';
const EMAIL_CHECKER_URL = 'https://mailmeteor.com/email-checker';
const EMAIL_FINDER_TIMEOUT_MS = 35_000; // 35 seconds max wait

// ─── Mailmeteor LinkedIn Email Finder ───────────────────────────

/**
 * Find email for a LinkedIn profile using Mailmeteor automation via Puppeteer.
 * Navigates to Mailmeteor's LinkedIn Email Finder, fills the URL, submits,
 * and waits for the result DOM to populate.
 */
async function findEmailViaMailmeteor(
  linkedinUrl: string,
): Promise<IEmailFinderResult> {
  let page: Page | null = null;

  try {
    page = await BrowserManager.getInstance().newPage();

    // 1. Navigate to Mailmeteor
    logger.info(`[EmailFinder] Navigating to Mailmeteor for: ${linkedinUrl}`);
    await page.goto(MAILMETEOR_URL, {
      waitUntil: 'networkidle2',
      timeout: 20_000,
    });

    // 2. Wait for Vue.js + Turnstile to initialize
    await delay(2000, 3500);

    // 3. Find the input field and fill it
    const inputSelector = '#linkedin-url';
    await page.waitForSelector(inputSelector, { timeout: 10_000 });
    await page.click(inputSelector, { clickCount: 3 }); // select all existing text
    await page.type(inputSelector, linkedinUrl, { delay: 50 }); // human-like typing

    // 4. Submit the form organically by clicking the button
    const submitButtonSelector =
      '#linkedin-email-finder-form button[type="submit"]';
    await page.waitForSelector(submitButtonSelector, { timeout: 5_000 });

    // Small delay to let Vue process the input
    await delay(300, 600);

    await page.click(submitButtonSelector);

    // 5. Wait for results — poll the DOM
    const result = await page.evaluate((timeoutMs: number) => {
      return new Promise<{
        ok: boolean;
        email?: string;
        validation?: string;
        fullName?: string;
        company?: string;
        error?: string;
      }>((resolve) => {
        const timeout = setTimeout(() => {
          resolve({ ok: false, error: 'Timeout waiting for email result' });
        }, timeoutMs);

        const pollInterval = setInterval(() => {
          const resultSection = document.getElementById(
            'linkedin-email-finder-results',
          );
          if (!resultSection) return;

          // Check if still loading
          const spinner = resultSection.querySelector('.spinner-border');
          if (spinner) return;

          // Check for success — email text
          const emailSpan = resultSection.querySelector(
            '.linkedin-email-finder__text.text-secondary',
          );
          if (emailSpan && emailSpan.textContent?.includes('@')) {
            clearInterval(pollInterval);
            clearTimeout(timeout);

            const nameEl = resultSection.querySelector(
              '.font-weight-bold .text-capitalize',
            );
            const chipEl = resultSection.querySelector('.chip');
            const positionEl = resultSection.querySelector('.position-text');

            resolve({
              ok: true,
              email: emailSpan.textContent.trim(),
              fullName: nameEl ? nameEl.textContent?.trim() || '' : '',
              validation: chipEl
                ? chipEl.textContent?.trim().toLowerCase() || 'unknown'
                : 'unknown',
              company: positionEl ? positionEl.textContent?.trim() || '' : '',
            });
            return;
          }

          // Check for "no results" or error states
          const noResults = resultSection.querySelector('span.text-secondary');
          if (noResults) {
            const text = (noResults.textContent || '').toLowerCase();
            if (
              text.includes("couldn't find") ||
              text.includes('no results') ||
              text.includes("didn't work") ||
              text.includes('error')
            ) {
              clearInterval(pollInterval);
              clearTimeout(timeout);
              resolve({ ok: false, error: 'No email found for this profile' });
              return;
            }
          }
        }, 1000);
      });
    }, EMAIL_FINDER_TIMEOUT_MS);

    if (result.ok && result.email) {
      return {
        ok: true,
        email: result.email,
        source: 'mailmeteor',
        validation: result.validation || 'unknown',
      };
    }

    return {
      ok: false,
      source: 'mailmeteor',
      error: result.error || 'No email found',
    };
  } catch (err: any) {
    logger.error(err, '[EmailFinder] Mailmeteor automation failed');
    return {
      ok: false,
      source: 'mailmeteor',
      error: err.message,
    };
  } finally {
    if (page) {
      try {
        await page.close();
      } catch {
        // Page might already be closed
      }
    }
  }
}

// ─── Email Checker Verification ─────────────────────────────────

/**
 * Verify an email using Mailmeteor's Email Checker via Puppeteer.
 */
async function verifyEmailViaMailmeteor(
  email: string,
): Promise<{ ok: boolean; status: string; error?: string }> {
  let page: Page | null = null;

  try {
    page = await BrowserManager.getInstance().newPage();

    await page.goto(`${EMAIL_CHECKER_URL}?email=${encodeURIComponent(email)}`, {
      waitUntil: 'networkidle2',
      timeout: 20_000,
    });

    await delay(2000, 3500);

    const result = await page.evaluate((timeoutMs: number) => {
      return new Promise<{ ok: boolean; status: string; error?: string }>(
        (resolve) => {
          const timeout = setTimeout(() => {
            resolve({ ok: false, status: 'timeout' });
          }, timeoutMs);

          const pollInterval = setInterval(() => {
            const resultContainer = document.querySelector('.result-container');
            if (!resultContainer) return;

            const text = (
              resultContainer as HTMLElement
            ).innerText.toLowerCase();

            if (text.includes('checking') || text.includes('verifying')) return;

            clearInterval(pollInterval);
            clearTimeout(timeout);

            if (text.includes('is valid') || text.includes('safe to send')) {
              resolve({ ok: true, status: 'valid' });
            } else if (
              text.includes('invalid') ||
              text.includes('bounce') ||
              text.includes("isn't valid")
            ) {
              resolve({ ok: false, status: 'invalid' });
            } else if (
              text.includes('catch-all') ||
              text.includes('risky') ||
              text.includes('accept all')
            ) {
              resolve({ ok: true, status: 'catch-all' });
            } else {
              resolve({ ok: false, status: 'unknown' });
            }
          }, 1000);
        },
      );
    }, EMAIL_FINDER_TIMEOUT_MS);

    return result;
  } catch (err: any) {
    logger.error(err, '[EmailFinder] Checker automation failed');
    return { ok: false, status: 'error', error: err.message };
  } finally {
    if (page) {
      try {
        await page.close();
      } catch {}
    }
  }
}

// ─── Pattern Generator (Fallback) ───────────────────────────────

interface EmailPattern {
  email: string;
  format: string;
  weight: number;
}

/**
 * Generate likely email patterns for a person at a company domain.
 */
function generateEmailPatterns(
  firstName: string,
  lastName: string,
  domain: string,
): EmailPattern[] {
  const f = firstName
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z]/g, '');
  const l = lastName
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z]/g, '');

  if (!f || !l || !domain) return [];

  const fi = f[0];
  const li = l[0];

  return [
    { email: `${f}.${l}@${domain}`, format: 'first.last', weight: 50 },
    { email: `${f}${l}@${domain}`, format: 'firstlast', weight: 15 },
    { email: `${fi}${l}@${domain}`, format: 'flast', weight: 12 },
    { email: `${fi}.${l}@${domain}`, format: 'f.last', weight: 8 },
    { email: `${f}${li}@${domain}`, format: 'firstl', weight: 5 },
    { email: `${f}_${l}@${domain}`, format: 'first_last', weight: 3 },
    { email: `${f}-${l}@${domain}`, format: 'first-last', weight: 3 },
    { email: `${l}.${f}@${domain}`, format: 'last.first', weight: 2 },
    { email: `${l}${f}@${domain}`, format: 'lastfirst', weight: 1 },
    { email: `${f}@${domain}`, format: 'first', weight: 1 },
  ];
}

/**
 * Guess company email domain from company name.
 */
function guessCompanyDomain(companyName: string): string {
  if (!companyName) return '';
  return companyName
    .toLowerCase()
    .replace(
      /\s*(gmbh|inc\.?|corp\.?|ltd\.?|llc|ag|se|co\.?|group|holding|international)\s*/gi,
      '',
    )
    .replace(/[^a-z0-9]/g, '')
    .concat('.com');
}

/**
 * Find email using pattern generation (fallback method).
 */
function findEmailViaPatterns(
  firstName: string,
  lastName: string,
  companyName: string,
  domain?: string,
): IEmailFinderResult & { patterns?: EmailPattern[] } {
  const emailDomain = domain || guessCompanyDomain(companyName);
  if (!emailDomain) {
    return {
      ok: false,
      source: 'pattern',
      error: 'Cannot determine company domain',
    };
  }

  const patterns = generateEmailPatterns(firstName, lastName, emailDomain);
  if (patterns.length === 0) {
    return { ok: false, source: 'pattern', error: 'Cannot generate patterns' };
  }

  return {
    ok: true,
    email: patterns[0].email,
    source: 'pattern',
    validation: 'guess',
    patterns: patterns.slice(0, 5),
  };
}

// ─── Main Entry Point ───────────────────────────────────────────

/**
 * Find email for a LinkedIn profile.
 * Tries Mailmeteor first (verified email via Puppeteer), falls back to pattern generator.
 *
 * @param linkedinUrl — full LinkedIn profile URL
 * @param profileData — profile data for pattern fallback
 */
export async function findEmail(
  linkedinUrl: string,
  profileData?: { firstName: string; lastName: string; companyName: string },
): Promise<IEmailFinderResult> {
  // Normalize the LinkedIn URL
  let fullUrl = linkedinUrl;
  if (!linkedinUrl.startsWith('http')) {
    fullUrl = `https://www.linkedin.com/in/${linkedinUrl}`;
  }

  // Try Mailmeteor first
  try {
    const mmResult = await findEmailViaMailmeteor(fullUrl);
    if (mmResult.ok && mmResult.email) {
      logger.info(
        `[EmailFinder] ✅ Found via Mailmeteor: ${mmResult.email} (${mmResult.validation})`,
      );
      return mmResult;
    }
    logger.info(
      '[EmailFinder] Mailmeteor returned no result, trying pattern fallback',
    );
  } catch (err: any) {
    logger.warn(`[EmailFinder] Mailmeteor failed: ${err.message}`);
  }

  // Fallback to pattern generator
  if (
    profileData?.firstName &&
    profileData?.lastName &&
    profileData?.companyName
  ) {
    const patternResult = findEmailViaPatterns(
      profileData.firstName,
      profileData.lastName,
      profileData.companyName,
    );

    if (
      patternResult.ok &&
      patternResult.patterns &&
      patternResult.patterns.length > 0
    ) {
      logger.info(
        '[EmailFinder] 🟡 Pattern guesses generated, starting verification...',
      );

      // Try to verify the top 3 patterns
      const topPatterns = patternResult.patterns.slice(0, 3);
      for (const pattern of topPatterns) {
        logger.info(`[EmailFinder] Verifying guess: ${pattern.email}`);
        const verification = await verifyEmailViaMailmeteor(pattern.email);

        if (
          verification.ok &&
          (verification.status === 'valid' ||
            verification.status === 'catch-all')
        ) {
          logger.info(
            `[EmailFinder] ✅ Pattern successfully verified: ${pattern.email}`,
          );
          return {
            ok: true,
            email: pattern.email,
            source: 'pattern_verified',
            validation: verification.status,
          };
        }
      }

      // If we couldn't verify any, return the most likely one as an unverified guess
      logger.info(
        `[EmailFinder] ⚠️ Could not verify patterns. Returning top guess: ${topPatterns[0].email}`,
      );
      return {
        ok: true,
        email: topPatterns[0].email,
        source: 'pattern_guess',
        validation: 'guess',
      };
    }
  }

  return { ok: false, error: 'Could not find email via any method' };
}
