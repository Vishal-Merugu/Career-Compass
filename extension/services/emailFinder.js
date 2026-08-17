// ─── Email Finder Service (widget drivers) ────────────────────────
//
// Drives free LinkedIn email-finder tools in a background tab, in order, until
// one answers: Mailmeteor first, then Anymail Finder's own free tool.
//
// A waterfall rather than a single provider, because a single one is a single
// point of failure in two different ways — it rate limits ("We are at capacity"
// after a busy afternoon), and it simply does not know everyone. Both are free
// and both take one tab, so a miss from the first is a reason to ask the second
// rather than a verdict about the person. `findEmailForProfile` is the entry
// point; the per-provider functions are exported for debugging.
//
// This is the *only* thing email discovery still does in the extension, and it
// is here for exactly one reason: a captcha (Turnstile at Mailmeteor, invisible
// reCAPTCHA at Anymail Finder) issues a token to a real user browser and
// refuses one to a server. That was measured, not assumed — headless Chromium,
// headful bundled Chromium and headful real Chrome on a residential IP all fail
// identically with `Error: 600010`, so it is the automation control channel
// being detected. See docs/adr/0005-server-side-email-finder.md.
//
// Each driver works the page it is given: fill the field, press the button,
// read the result. No provider's internal endpoint is called directly and no
// captcha token is minted here or carried between tabs — a relayed token is
// single-use, expires in minutes, and needs a live browser per lookup anyway,
// so it buys nothing and breaks on their next deploy.
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
const ANYMAILFINDER_URL =
  'https://anymailfinder.com/email-finder/from-linkedin';
const EMAIL_FINDER_TIMEOUT_MS = 30000;

/**
 * Anymail Finder's free tool is slower than Mailmeteor's — it verifies the
 * mailbox live, and a measured request took 33 s to answer. A 30 s budget would
 * time out on results that were about to arrive.
 */
const ANYMAILFINDER_TIMEOUT_MS = 60000;

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

/**
 * Find a work email via Anymail Finder's free LinkedIn tool.
 *
 * Same shape as the Mailmeteor driver, and here for the same reason: the page
 * carries an invisible reCAPTCHA, which a real browser passes and a server does
 * not. The page mints and spends its own token in its own tab — nothing is
 * relayed, and no request is made outside the one the page makes for itself.
 * Driving their internal `/www/search` endpoint with a token minted elsewhere
 * would be the relay ADR 0005 rules out, and would break the moment they rotate
 * the site key.
 *
 * @param {string} linkedinUrl full profile URL
 * @returns {Promise<{ok: boolean, email?: string, source?: string, validation?: string, error?: string}>}
 */
async function findEmailViaAnymailfinder(linkedinUrl) {
  let tabId = null;

  try {
    const tab = await chrome.tabs.create({
      url: ANYMAILFINDER_URL,
      active: false,
    });
    tabId = tab.id;

    await waitForTabLoad(tabId, 20000);

    // The form is React-rendered and the reCAPTCHA script has to load before a
    // submit does anything, same as Turnstile on the Mailmeteor page.
    await delay(2000, 3000);

    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: anymailfinderContentScript,
      args: [linkedinUrl, ANYMAILFINDER_TIMEOUT_MS],
    });

    const result = results?.[0]?.result;

    if (result?.ok && result?.email) {
      return {
        ok: true,
        email: result.email,
        source: 'anymailfinder_web',
        validation: result.validation || 'unknown',
      };
    }

    return {
      ok: false,
      source: 'anymailfinder_web',
      error: result?.error || 'No email found',
    };
  } catch (err) {
    console.error('[EmailFinder] Anymail Finder automation failed:', err);
    return { ok: false, source: 'anymailfinder_web', error: err.message };
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
 * Injected into the Anymail Finder tab.
 *
 * Written against what the page *shows* rather than against class names: the
 * input is found by its placeholder / label wording and the button by its
 * visible text, because a marketing site's generated class names change without
 * notice and a silent selector break here looks exactly like "this person has
 * no email".
 */
function anymailfinderContentScript(linkedinUrl, timeoutMs) {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      resolve({ ok: false, error: 'Timeout waiting for email result' });
    }, timeoutMs);

    const done = (value) => {
      clearTimeout(timeout);
      resolve(value);
    };

    try {
      const inputs = [...document.querySelectorAll('input')].filter(
        (el) => el.type !== 'hidden' && el.offsetParent !== null,
      );

      const input =
        inputs.find((el) =>
          /linkedin/i.test(
            `${el.placeholder} ${el.name} ${el.id} ${el.getAttribute('aria-label') || ''}`,
          ),
        ) ?? inputs[0];

      if (!input) {
        done({ ok: false, error: 'LinkedIn URL field not found on page' });
        return;
      }

      // React tracks the value on the DOM node and ignores a plain assignment,
      // so the form would submit empty. Going through the prototype's setter is
      // what makes React see the change.
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value',
      )?.set;
      if (setter) setter.call(input, linkedinUrl);
      else input.value = linkedinUrl;

      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));

      const button = [...document.querySelectorAll('button')].find((el) =>
        /find email/i.test(el.textContent || ''),
      );

      if (!button) {
        done({ ok: false, error: 'Find email button not found on page' });
        return;
      }

      // Text present before submitting. The result arrives as new text on the
      // page, and the page is a marketing page full of example addresses — so
      // what matters is what appears *after* the click, not what is on it.
      const before = document.body.innerText;

      setTimeout(() => button.click(), 500);

      const pollInterval = setInterval(() => {
        const now = document.body.innerText;
        const added =
          now.length > before.length ? now.slice(before.length) : '';
        const haystack = added || now;

        const lower = now.toLowerCase();
        if (
          lower.includes('rate limit') ||
          lower.includes('rate_limit') ||
          lower.includes('too many requests') ||
          lower.includes('at capacity')
        ) {
          clearInterval(pollInterval);
          done({ ok: false, error: 'Anymail Finder is rate limiting' });
          return;
        }

        // The tool's own words for a miss, per its FAQ and result panel.
        if (
          lower.includes('no email found') ||
          lower.includes("couldn't find") ||
          lower.includes('could not find') ||
          lower.includes('not found')
        ) {
          clearInterval(pollInterval);
          done({ ok: false, error: 'No email found for this profile' });
          return;
        }

        const match = haystack.match(
          /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/,
        );
        if (match) {
          clearInterval(pollInterval);
          // "Verified" / "Risky" — risky means a catch-all domain accepted the
          // probe, which is not a confirmation. Passed through as-is; ranking
          // it is the server's job.
          const validation = /\brisky\b/i.test(haystack)
            ? 'risky'
            : /\bverified\b/i.test(haystack)
              ? 'valid'
              : 'unknown';
          done({ ok: true, email: match[0], validation });
        }
      }, 1000);
    } catch (err) {
      done({ ok: false, error: err.message });
    }
  });
}

/**
 * Every provider in turn, until one produces an address.
 *
 * A waterfall rather than a choice: the providers disagree about who they can
 * find, and each is free, so a miss from the first is a reason to ask the
 * second — not a verdict. Mailmeteor leads because it answers in seconds where
 * Anymail Finder verifies the mailbox live and took 33 s when measured, so the
 * common case stays cheap.
 *
 * The reported `source` is whichever provider actually answered, which is what
 * makes `emailSource` still mean something once there is more than one.
 *
 * @param {string} linkedinUrl full profile URL
 */
async function findEmailForProfile(linkedinUrl) {
  const providers = [
    { name: 'mailmeteor', run: findEmailViaMailmeteor },
    { name: 'anymailfinder_web', run: findEmailViaAnymailfinder },
  ];

  const errors = [];

  for (const provider of providers) {
    let result;

    try {
      result = await provider.run(linkedinUrl);
    } catch (err) {
      // One provider throwing must not strand the row: the next one may well
      // answer, and a thrown error here is usually the tab, not the lookup.
      result = { ok: false, error: err.message || 'Provider threw' };
    }

    if (result?.ok && result.email) {
      return { ...result, source: result.source || provider.name };
    }

    errors.push(`${provider.name}: ${result?.error || 'no email'}`);
    console.log(
      `[EmailFinder] ${provider.name} had nothing for ${linkedinUrl}: ${result?.error || 'no email'}`,
    );
  }

  return { ok: false, source: 'not_found', error: errors.join(' | ') };
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
    findEmailForProfile,
    findEmailViaMailmeteor,
    findEmailViaAnymailfinder,
    mailmeteorContentScript,
    anymailfinderContentScript,
    waitForTabLoad,
  });
}
