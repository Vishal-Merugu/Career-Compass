// ─── Session Sync ─────────────────────────────────────────────────
//
// Harvests the LinkedIn cookie jar from this browser and pushes it to the
// server, which is what lets the backend make Voyager calls on its own.
//
// **This is now the extension's primary job.** The scraping itself moved to the
// server (docs/adr/0007-server-side-linkedin-calls.md); what cannot move is
// getting a session in the first place. LinkedIn has no API-key auth, and a
// server that tried to log in would be doing it from a datacenter with a
// headless browser — the exact profile the risk engine exists to catch. A real
// user, already logged in, hands over the cookies instead.
//
// Two rules carried over from the server's cookie handling:
//
//   * The whole jar goes, not just `li_at`. An auth token without the
//     browser-identity cookies (`JSESSIONID`, `bcookie`, `bscookie`, `lidc`,
//     `li_rm`) reads as a stolen cookie.
//   * `__cf_bm` is excluded. It is Cloudflare's, bound to this machine's IP and
//     good for ~30 minutes, so replaying it from the server is worse than
//     sending nothing. The server strips it too; this just avoids shipping it.

/** Sent with the jar so the server's requests carry a matching fingerprint. */
const CRITICAL_COOKIES = ['li_at', 'JSESSIONID', 'bcookie', 'lidc'];

const SKIP_COOKIES = ['__cf_bm'];

/**
 * Read every linkedin.com cookie this browser holds.
 *
 * `getAll({ domain })` matches subdomains too, which is wanted: `lidc` and
 * `bcookie` are set on `.linkedin.com` while others are host-only.
 */
async function collectLinkedInCookies() {
  const all = await chrome.cookies.getAll({ domain: 'linkedin.com' });
  const cookies = {};

  for (const cookie of all) {
    if (SKIP_COOKIES.includes(cookie.name)) continue;
    if (!cookie.value) continue;
    // Later duplicates are the more specific host-only ones; let them win.
    cookies[cookie.name] = cookie.value;
  }

  return cookies;
}

/**
 * Push the current jar to the server.
 *
 * Returns `{ ok, reason }` rather than throwing: this runs on an alarm and from
 * startup, where an unhandled rejection would be invisible.
 */
async function syncSessionToServer() {
  const config = await getConfig();
  if (!config.apiKey || !config.backendUrl) {
    return { ok: false, reason: 'not linked to a backend' };
  }

  const cookies = await collectLinkedInCookies();
  const missing = CRITICAL_COOKIES.filter((name) => !cookies[name]);

  if (missing.length > 0) {
    // Almost always means the user is logged out of LinkedIn in this browser.
    // Do not push a partial jar — the server would reject it anyway, and a
    // rejected import overwrites nothing but does log an error per attempt.
    console.log(
      `[SessionSync] Not pushing — missing ${missing.join(', ')}. Log in to LinkedIn.`,
    );
    return { ok: false, reason: `missing ${missing.join(', ')}` };
  }

  const res = await apiSync('/api/session/cookies', 'POST', {
    cookies,
    userAgent: navigator.userAgent,
    // Hours east of UTC, matching what the server sends in `x-li-track`.
    timezoneOffset: -(new Date().getTimezoneOffset() / 60),
  });

  if (res?.ok) {
    console.log(
      `[SessionSync] Pushed ${Object.keys(cookies).length} cookies to the server`,
    );
    await addActivityEntry('🔐 LinkedIn session pushed to server');
    return { ok: true };
  }

  return { ok: false, reason: res?.error?.message || 'push failed' };
}

if (typeof globalThis !== 'undefined') {
  Object.assign(globalThis, { syncSessionToServer, collectLinkedInCookies });
}
