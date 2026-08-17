// ─── Email Lookup Drainer ─────────────────────────────────────────
//
// Pulls queued email lookups from the backend, runs the Mailmeteor widget on
// each, and posts the answer back.
//
// Pull, not push. The dashboard cannot send this extension a command: an MV3
// service worker is killed after ~30s idle, and the WebSocket handshake needs a
// live SearchJob (server/src/ws-gateway/middleware/auth.ts), so there is no
// socket open between jobs to receive one. The server keeps the work in a table
// and this drains it whenever the browser happens to be alive.
//
// Driven by `chrome.alarms`, deliberately not by a long-lived loop or
// setInterval — the worker gets suspended and both die with it. An alarm wakes
// it back up.
//
// Nothing here is required for correctness. If this never runs, the server
// finishes the same rows with patterns + SMTP after a grace period. This exists
// only because a real browser can solve the widget captcha that a server
// cannot.

/** Tabs at a time. Each lookup is a background tab, so this is a real cost. */
const DRAIN_CONCURRENCY = 2;

/**
 * Rows to claim per wake-up.
 *
 * Small on purpose: a claim is a lease, and anything claimed when the worker is
 * suspended sits idle until the server's sweeper reclaims it. Claiming little
 * and often loses less work than claiming a lot once.
 */
const CLAIM_BATCH = DRAIN_CONCURRENCY;

/**
 * Guards against a second drain starting while one is in flight — an alarm can
 * fire again mid-drain, and two drains would fight over tabs.
 *
 * Module state, so it resets when the worker is suspended. That is correct: a
 * suspended worker has no drain running, and the lease it held will be
 * reclaimed server-side.
 */
let draining = false;

/**
 * Look up one claimed item and report the outcome.
 *
 * A miss is reported, not swallowed. The server re-queues the row and, after
 * the grace period, finishes it itself — so a silent failure here would strand
 * the lease until the sweeper timed it out, delaying the answer by minutes.
 */
async function runOneLookup(item) {
  let result;

  try {
    result = await findEmailForProfile(item.linkedinUrl);
  } catch (err) {
    result = { ok: false, error: err.message || 'Widget lookup threw' };
  }

  await apiSync(`/api/email-lookups/${item.lookupId}/result`, 'POST', {
    ok: Boolean(result.ok && result.email),
    email: result.email || null,
    // Whichever provider in the waterfall answered — not a fixed string, or
    // every address would be recorded as Mailmeteor's.
    source: result.source || 'mailmeteor',
    validation: result.validation || null,
    error: result.error || null,
  });

  if (result.ok && result.email) {
    console.log(
      `[EmailLookupDrainer] Found ${result.email} for ${item.firstName} ${item.lastName}`,
    );
  } else {
    console.log(
      `[EmailLookupDrainer] Miss for ${item.firstName} ${item.lastName}: ${result.error}`,
    );
  }
}

/**
 * Claim and process one batch.
 *
 * One batch per wake-up rather than looping until the queue is empty: the
 * worker can be suspended at any point, and the next alarm picks up where this
 * left off. A loop would just be a longer window in which to lose leases.
 */
async function drainEmailLookups() {
  if (draining) return { ok: true, skipped: 'already draining' };

  const config = await getConfig();
  if (!config.apiKey || !config.backendUrl) {
    return { ok: false, error: 'Extension is not linked to a backend' };
  }

  draining = true;

  try {
    const claim = await apiSync('/api/email-lookups/claim', 'POST', {
      take: CLAIM_BATCH,
    });

    const items = claim?.items || [];
    if (items.length === 0) return { ok: true, processed: 0 };

    console.log(`[EmailLookupDrainer] Claimed ${items.length} lookup(s)`);

    // Sequential within the batch; CLAIM_BATCH is already the concurrency cap,
    // so running these in parallel would just open the same number of tabs at
    // once and make the LinkedIn-adjacent traffic burstier for no gain.
    for (const item of items) {
      await runOneLookup(item);
    }

    await addActivityEntry(`✉️ Processed ${items.length} email lookup(s)`);

    // A full batch means there is probably more behind it. The periodic alarm
    // is capped at one minute, which paces a 30-row backlog at a quarter of an
    // hour of the dashboard saying it is still working — so ask for one extra
    // wake-up, sooner. One-shot on purpose: an empty claim simply does not
    // schedule another, so the queue idles back to the one-minute alarm on its
    // own rather than needing anything cancelled.
    if (items.length === CLAIM_BATCH) {
      chrome.alarms.create('emailLookupDrainSoon', { delayInMinutes: 0.5 });
    }

    return { ok: true, processed: items.length };
  } catch (err) {
    console.error('[EmailLookupDrainer] Drain failed:', err);
    return { ok: false, error: err.message };
  } finally {
    draining = false;
  }
}

if (typeof globalThis !== 'undefined') {
  Object.assign(globalThis, { drainEmailLookups });
}
