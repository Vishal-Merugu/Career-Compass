// ─── Email Finder Service (widget driver) ─────────────────────────
//
// Drives Mailmeteor's free LinkedIn Email Finder in a background tab.
//
// This is the *only* thing email discovery still does in the extension, and it
// is here for exactly one reason: Cloudflare Turnstile issues a token to a real
// user browser and refuses one to a server. That was measured, not assumed —
// headless Chromium, headful bundled Chromium and headful real Chrome on a
// residential IP all fail identically with `Error: 600010`, so it is the
// automation control channel being detected. See
// docs/adr/0005-server-side-email-finder.md.
//
// Everything else lives on the server:
//
//   * Pattern generation and SMTP verification — the server's version resolves
//     the domain through an MX lookup and probes it with RCPT TO. A pattern
//     guessed here would be strictly worse, so this file does not generate any.
//   * Deciding *who* to look up, and storing the answer. This file is handed
//     work and reports back; it owns no queue and no state.
//
// A miss here is not a failure. Reporting `{ ok: false }` re-queues the row, and
// if no browser claims it the server finishes it with patterns + SMTP. The
// extension upgrades results; it does not gate them.
//
// `delay()` comes from rateLimiter.js — every service shares one global scope
// under importScripts, so re-declaring it here would shadow the original.

const MAILMETEOR_URL = 'https://mailmeteor.com/tools/linkedin-email-finder';
const EMAIL_FINDER_TIMEOUT_MS = 30000;

/**
 * Find a work email for a LinkedIn profile via Mailmeteor's widget.
 *
 * Opens a background tab, injects a script that fills and submits the form,
 * scrapes the result, and always closes the tab.
 *
 * @param {string} linkedinUrl full profile URL
 * @returns {Promise<{ok: boolean, email?: string, source?: string, validation?: string, error?: string}>}
 */
async function findEmailViaMailmeteor(linkedinUrl) {
  let tabId = null;

  try {
    const tab = await chrome.tabs.create({
      url: MAILMETEOR_URL,
      active: false,
    });
    tabId = tab.id;

    await waitForTabLoad(tabId, 15000);

    // Vue and Turnstile both need a moment after `complete` before the form is
    // interactive; submitting earlier silently does nothing.
    await delay(2000, 3000);

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
      };
    }

    return {
      ok: false,
      source: 'mailmeteor',
      // Carried through: the server treats a throttle as "not an attempt".
      retryable: Boolean(result?.retryable),
      error: result?.error || 'No email found',
    };
  } catch (err) {
    console.error('[EmailFinder] Mailmeteor automation failed:', err);
    return { ok: false, source: 'mailmeteor', error: err.message };
  } finally {
    if (tabId) {
      try {
        await chrome.tabs.remove(tabId);
      } catch {
        // Already closed — the user may have closed it by hand.
      }
    }
  }
}

/**
 * Injected into the Mailmeteor tab. Runs in the page's context, not the
 * worker's, so it can only use what is on that page.
 */
function mailmeteorContentScript(linkedinUrl, timeoutMs) {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      resolve({ ok: false, error: 'Timeout waiting for email result' });
    }, timeoutMs);

    try {
      const input = document.getElementById('linkedin-url');
      if (!input) {
        clearTimeout(timeout);
        resolve({ ok: false, error: 'Input field not found on page' });
        return;
      }

      // Vue only sees the value if the input event fires.
      input.value = linkedinUrl;
      input.dispatchEvent(new Event('input', { bubbles: true }));

      const form = document.getElementById('linkedin-email-finder-form');
      if (!form) {
        clearTimeout(timeout);
        resolve({ ok: false, error: 'Form not found on page' });
        return;
      }

      setTimeout(() => {
        form.dispatchEvent(
          new Event('submit', { bubbles: true, cancelable: true }),
        );
      }, 500);

      const pollInterval = setInterval(() => {
        const resultSection = document.getElementById(
          'linkedin-email-finder-results',
        );
        if (!resultSection) return;

        // Spinner still up means the request is in flight.
        if (resultSection.querySelector('.spinner-border')) return;

        const emailSpan = resultSection.querySelector(
          '.linkedin-email-finder__text.text-secondary',
        );
        if (emailSpan && emailSpan.textContent.includes('@')) {
          clearInterval(pollInterval);
          clearTimeout(timeout);

          const chipEl = resultSection.querySelector('.chip');
          resolve({
            ok: true,
            email: emailSpan.textContent.trim(),
            validation: chipEl
              ? chipEl.textContent.trim().toLowerCase()
              : 'unknown',
          });
          return;
        }

        const noResults = resultSection.querySelector('span.text-secondary');
        if (noResults) {
          const text = noResults.textContent.toLowerCase();

          // "Oops, it didn't work (rate_limit) — We are at capacity. Please try
          // again in a few minutes." The widget says this when too many lookups
          // have gone through it lately, and it is not an answer about this
          // person: nothing was looked up. Reported apart from a real miss so
          // the server can re-queue the row without spending an attempt —
          // otherwise one busy afternoon retires three profiles as having no
          // address, having never once searched for them.
          const throttled =
            text.includes('rate_limit') ||
            text.includes('rate limit') ||
            text.includes('at capacity') ||
            text.includes('too many');

          if (throttled) {
            clearInterval(pollInterval);
            clearTimeout(timeout);
            resolve({
              ok: false,
              retryable: true,
              error: 'Mailmeteor is at capacity — nothing was looked up',
            });
            return;
          }

          if (
            text.includes("couldn't find") ||
            text.includes('no results') ||
            text.includes("didn't work") ||
            text.includes('error')
          ) {
            clearInterval(pollInterval);
            clearTimeout(timeout);
            resolve({ ok: false, error: 'No email found for this profile' });
          }
        }
      }, 1000);
    } catch (err) {
      clearTimeout(timeout);
      resolve({ ok: false, error: err.message });
    }
  });
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

// A top-level `function` declaration is reachable from a sibling script under
// importScripts, but be explicit — a top-level `const` would NOT be a property
// of globalThis, which has already cost a session once.
if (typeof globalThis !== 'undefined') {
  Object.assign(globalThis, {
    findEmailViaMailmeteor,
    mailmeteorContentScript,
    waitForTabLoad,
  });
}
