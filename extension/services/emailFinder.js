// ─── Email Finder Service ─────────────────────────────────────────
// Orchestrates email discovery using Mailmeteor automation (primary)
// and a built-in pattern generator (fallback).
//
// Architecture:
//   1. Open a background tab to Mailmeteor's LinkedIn Email Finder
//   2. Inject a content script that fills the form + submits
//   3. Turnstile auto-solves in the real browser
//   4. Content script scrapes the result and sends it back
//   5. Fallback: generate email patterns + validate domain MX

// ─── Mailmeteor Tab Automation ──────────────────────────────────

const MAILMETEOR_URL = 'https://mailmeteor.com/tools/linkedin-email-finder';
const EMAIL_CHECKER_URL = 'https://mailmeteor.com/email-checker';
const EMAIL_FINDER_TIMEOUT_MS = 30000; // 30 seconds max wait

/**
 * Find email for a LinkedIn profile using Mailmeteor automation.
 * Opens a hidden tab, injects content script, waits for result.
 *
 * @param {string} linkedinUrl — full LinkedIn profile URL (e.g. https://www.linkedin.com/in/sundarpichai)
 * @returns {Promise<{ok: boolean, email?: string, source?: string, validation?: string, fullName?: string, company?: string, jobTitle?: string, error?: string}>}
 */
async function findEmailViaMailmeteor(linkedinUrl) {
  let tabId = null;

  try {
    // 1. Create a background tab (not active)
    const tab = await chrome.tabs.create({
      url: MAILMETEOR_URL,
      active: false,
    });
    tabId = tab.id;

    // 2. Wait for the tab to finish loading
    await waitForTabLoad(tabId, 15000);

    // 3. Small additional delay for Vue.js + Turnstile to initialize
    await delay(2000, 3000);

    // 4. Inject content script that fills the form and waits for result
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: mailmeteorContentScript,
      args: [linkedinUrl, EMAIL_FINDER_TIMEOUT_MS],
    });

    const result = results?.[0]?.result;

    if (result?.ok && result?.email) {
      return {
        ok: true,
        email: result.email,
        source: 'mailmeteor',
        validation: result.validation || 'unknown',
        fullName: result.fullName || '',
        company: result.company || '',
        jobTitle: result.jobTitle || '',
      };
    }

    return {
      ok: false,
      source: 'mailmeteor',
      error: result?.error || 'No email found',
    };
  } catch (err) {
    console.error('[EmailFinder] Mailmeteor automation failed:', err);
    return {
      ok: false,
      source: 'mailmeteor',
      error: err.message,
    };
  } finally {
    // Always clean up the tab
    if (tabId) {
      try {
        await chrome.tabs.remove(tabId);
      } catch {
        // Tab might already be closed
      }
    }
  }
}

/**
 * Content script function injected into the Mailmeteor tab.
 * This runs in the context of the Mailmeteor page.
 */
function mailmeteorContentScript(linkedinUrl, timeoutMs) {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      resolve({ ok: false, error: 'Timeout waiting for email result' });
    }, timeoutMs);

    try {
      // 1. Find the input and fill it
      const input = document.getElementById('linkedin-url');
      if (!input) {
        clearTimeout(timeout);
        resolve({ ok: false, error: 'Input field not found on page' });
        return;
      }

      // Set value and trigger input event for Vue.js reactivity
      input.value = linkedinUrl;
      input.dispatchEvent(new Event('input', { bubbles: true }));

      // 2. Submit the form
      const form = document.getElementById('linkedin-email-finder-form');
      if (!form) {
        clearTimeout(timeout);
        resolve({ ok: false, error: 'Form not found on page' });
        return;
      }

      // Small delay before submitting to let Vue process the input
      setTimeout(() => {
        form.dispatchEvent(
          new Event('submit', { bubbles: true, cancelable: true }),
        );
      }, 500);

      // 3. Poll for results in the DOM
      const pollInterval = setInterval(() => {
        const resultSection = document.getElementById(
          'linkedin-email-finder-results',
        );
        if (!resultSection) return;

        // Check if still loading (spinner present)
        const spinner = resultSection.querySelector('.spinner-border');
        if (spinner) return; // Still loading

        // Check for success — email text
        const emailSpan = resultSection.querySelector(
          '.linkedin-email-finder__text.text-secondary',
        );
        if (emailSpan && emailSpan.textContent.includes('@')) {
          clearInterval(pollInterval);
          clearTimeout(timeout);

          // Extract additional data
          const nameEl = resultSection.querySelector(
            '.font-weight-bold .text-capitalize',
          );
          const chipEl = resultSection.querySelector('.chip');
          const positionEl = resultSection.querySelector('.position-text');

          resolve({
            ok: true,
            email: emailSpan.textContent.trim(),
            fullName: nameEl ? nameEl.textContent.trim() : '',
            validation: chipEl
              ? chipEl.textContent.trim().toLowerCase()
              : 'unknown',
            company: positionEl ? positionEl.textContent.trim() : '',
            jobTitle: '',
          });
          return;
        }

        // Check for "no results" or error states
        const noResults = resultSection.querySelector('span.text-secondary');
        if (noResults) {
          const text = noResults.textContent.toLowerCase();
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
      }, 1000); // Check every second
    } catch (err) {
      clearTimeout(timeout);
      resolve({ ok: false, error: err.message });
    }
  });
}

// ─── Email Checker Verification ─────────────────────────────────

/**
 * Verify an email using Mailmeteor's Email Checker.
 * Opens a hidden tab, injects content script, waits for result.
 */
async function verifyEmailViaMailmeteor(email) {
  let tabId = null;

  try {
    const tab = await chrome.tabs.create({
      url: `${EMAIL_CHECKER_URL}?email=${encodeURIComponent(email)}`,
      active: false,
    });
    tabId = tab.id;

    await waitForTabLoad(tabId, 15000);
    await delay(2000, 3000); // Wait for Vue.js + Turnstile

    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: emailCheckerContentScript,
      args: [email, EMAIL_FINDER_TIMEOUT_MS],
    });

    const result = results?.[0]?.result;
    return result || { ok: false, status: 'unknown' };
  } catch (err) {
    console.error('[EmailFinder] Checker automation failed:', err);
    return { ok: false, status: 'error', error: err.message };
  } finally {
    if (tabId) {
      try {
        await chrome.tabs.remove(tabId);
      } catch {}
    }
  }
}

/**
 * Content script function injected into the Mailmeteor Email Checker tab.
 */
function emailCheckerContentScript(targetEmail, timeoutMs) {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      resolve({ ok: false, status: 'timeout' });
    }, timeoutMs);

    try {
      const pollInterval = setInterval(() => {
        const resultContainer = document.querySelector('.result-container');
        if (!resultContainer) return;

        const text = resultContainer.innerText.toLowerCase();

        // Still loading/checking
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
    } catch (err) {
      clearTimeout(timeout);
      resolve({ ok: false, status: 'error', error: err.message });
    }
  });
}

// ─── Pattern Generator (Fallback) ───────────────────────────────

/**
 * Generate likely email patterns for a person at a company domain.
 * Returns patterns sorted by likelihood (first.last is most common at ~50% of companies).
 *
 * @param {string} firstName
 * @param {string} lastName
 * @param {string} domain — company email domain (e.g. siemens.com)
 * @returns {Array<{email: string, format: string, weight: number}>}
 */
function generateEmailPatterns(firstName, lastName, domain) {
  // Normalize: remove diacritics, lowercase
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
 * Extract a likely company email domain from the company name.
 * Tries common TLDs. In production, the Voyager company API provides the website.
 *
 * @param {string} companyName
 * @returns {string} — best guess domain
 */
function guessCompanyDomain(companyName) {
  if (!companyName) return '';
  // Clean up: remove common suffixes, spaces, special chars
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
 * Returns the top 3 most likely patterns.
 *
 * @param {string} firstName
 * @param {string} lastName
 * @param {string} companyName — used to guess domain if domain not provided
 * @param {string} [domain] — optional explicit domain
 * @returns {{ok: boolean, email: string, source: string, validation: string, patterns: Array}}
 */
function findEmailViaPatterns(firstName, lastName, companyName, domain) {
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

  // Return the most likely pattern as the primary guess
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
 * Tries Mailmeteor first (verified email), falls back to pattern generator.
 *
 * @param {string} linkedinUrl — full LinkedIn profile URL or just the profile ID
 * @param {object} [profileData] — optional profile data for pattern fallback
 * @param {string} [profileData.firstName]
 * @param {string} [profileData.lastName]
 * @param {string} [profileData.companyName]
 * @returns {Promise<{ok: boolean, email?: string, source?: string, validation?: string, error?: string}>}
 */
async function findEmail(linkedinUrl, profileData) {
  // Normalize the LinkedIn URL
  let fullUrl = linkedinUrl || '';
  if (fullUrl && !fullUrl.startsWith('http')) {
    fullUrl = `https://www.linkedin.com/in/${linkedinUrl}`;
  }

  // Try Mailmeteor first
  try {
    const mmResult = await findEmailViaMailmeteor(fullUrl);
    if (mmResult.ok && mmResult.email) {
      console.log(
        `[EmailFinder] ✅ Found via Mailmeteor: ${mmResult.email} (${mmResult.validation})`,
      );
      return mmResult;
    }
    console.log(
      `[EmailFinder] Mailmeteor returned no result, trying pattern fallback`,
    );
  } catch (err) {
    console.warn(`[EmailFinder] Mailmeteor failed: ${err.message}`);
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
    if (patternResult.ok && patternResult.patterns?.length > 0) {
      console.log(
        `[EmailFinder] 🟡 Pattern guesses generated, starting verification...`,
      );

      // Try to verify the top 3 patterns
      const topPatterns = patternResult.patterns.slice(0, 3);
      for (const pattern of topPatterns) {
        console.log(`[EmailFinder] Verifying guess: ${pattern.email}`);
        const verification = await verifyEmailViaMailmeteor(pattern.email);

        if (
          verification.ok &&
          (verification.status === 'valid' ||
            verification.status === 'catch-all')
        ) {
          console.log(
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
      console.log(
        `[EmailFinder] ⚠️ Could not verify patterns. Returning top guess as unverified: ${topPatterns[0].email}`,
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

// ─── Tab Helpers ────────────────────────────────────────────────

function delay(minMs, maxMs) {
  const ms = maxMs
    ? Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs
    : minMs;
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForTabLoad(tabId, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error('Tab load timeout'));
    }, timeoutMs);

    function listener(updatedTabId, changeInfo) {
      if (updatedTabId === tabId && changeInfo.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        clearTimeout(timeout);
        resolve();
      }
    }

    chrome.tabs.onUpdated.addListener(listener);
  });
}

// ─── Exports ────────────────────────────────────────────────────

if (typeof globalThis !== 'undefined') {
  Object.assign(globalThis, {
    findEmail,
    findEmailViaMailmeteor,
    findEmailViaPatterns,
    generateEmailPatterns,
    guessCompanyDomain,
    mailmeteorContentScript,
    verifyEmailViaMailmeteor,
    emailCheckerContentScript,
    delay,
  });
}
