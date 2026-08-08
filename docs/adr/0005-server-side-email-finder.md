# 5. Email finding runs on the server

Date: 2026-08-07

## Status

Accepted, with **layer 2 removed on 2026-08-08**. The Mailmeteor layer described
below never returned an address, exactly as this ADR predicted, and the code was
deleted along with `playwright` and the `INSTALL_CHROMIUM` build arg. That lookup
now runs in the Chrome extension, where the captcha solves — see
`0006-email-lookup-queue.md`. The analysis of _why_ it cannot work server-side is
kept verbatim, because it is the reason not to try again.

## Context

Email discovery ran in the extension. `extension/services/emailFinder.js`
opened a background tab to Mailmeteor's LinkedIn Email Finder, injected a
content script that filled the form, polled the DOM for `.spinner-border` and
`.chip`, and posted the result back over `EMAIL_FOUND`.

That made a finished job depend on a browser being open. If no socket was
connected when a profile qualified, the decision was written with
`emailSource: 'disconnected'` and no address; `onCheckPendingEmails` existed
purely to replay those lookups the next time the extension appeared. In
practice the machine had to stay awake for the pipeline to produce contacts.

This is the opposite of the split in ADR 0001. The extension exists to hold a
real LinkedIn session — real cookies, real TLS fingerprint. **Email discovery
never touches LinkedIn.** It has no reason to run there.

## Decision

Email finding moves to `server/src/services/emailFinder/`, called in-process
by `qualificationWorker`. Three layers, tried in order — and the bottom one
needs no credentials, so the pipeline works with nothing configured.

### Layer 1 — Anymail Finder (the one that works)

A key-authenticated API. No browser, no captcha, no headless detection:

```
POST https://api.anymailfinder.com/v5.1/find-email/linkedin-url
Authorization: <api key>          (raw key, no "Bearer " prefix)
{ "linkedin_url": "https://www.linkedin.com/in/…" }
```

Note that their _marketing site's_ widget (`apiapp.anymailfinder.com/www/search`)
is gated by invisible reCAPTCHA v3 and is not this endpoint. Same trap as
Mailmeteor: the free demo cannot be driven from a server, the documented API
can.

Metered — one credit per valid email found, nothing for `not_found`/`risky`/
`blacklisted`, repeat searches free within 30 days, 100 credits on signup.
A 401 or 402 latches the layer off for the process, since both persist until
a human intervenes and retrying per profile would only add latency.

`risky` results are kept and labelled, not discarded: weaker than `valid`, but
still a real lookup and better evidence than a generated pattern.

Unset `ANYMAILFINDER_API_KEY` and the layer is skipped entirely.

### Layer 2 — Mailmeteor (REMOVED 2026-08-08; kept here as the reason not to retry)

Rather than scraping the DOM, the layer drives the page's own Vue instance in
headless Chromium. The underlying API is:

```
POST https://tools.mailmeteor.com/api/email-finder/linkedin?cf-turnstile-response=<token>
body: {"linkedin_url": "..."}
```

**Measured 2026-08-07:** Cloudflare will not issue a Turnstile token to
headless Chromium. The page logs `[Cloudflare Turnstile] Error: 600010`, the
hidden `cf-turnstile-response` input stays empty, and the Vue instance settles
on `{found: false, error: {code: ''}}`. Cloudflare fingerprints the runtime
before deciding — the page probes for console instrumentation on load.

It also fails with **headful, real Google Chrome on a residential IP**. So the
signal being detected is neither the display mode nor the address — it is the
automation control channel itself. Xvfb, a different launch flag, or moving to
a better-reputation IP therefore cannot help, and none of them are worth
trying.

The only routes past 600010 are a third-party captcha-solving service or
fingerprint-spoofing. Neither is in this codebase, and neither would be a good
bet regardless: the extension worked because it was one residential browser
doing human-paced lookups, whereas the VM is a single static datacenter IP.
That profile is exactly what the challenge is there to stop, so an evasion
would break and would break silently, recording misses.

The layer is kept because it costs nothing once latched off, and it works
unchanged if run headful or if the tool drops Turnstile. It disables itself
after two consecutive refusals. Chromium is **not** installed in the image by
default (`INSTALL_CHROMIUM=false`) — 400 MB for a layer with a measured
zero-percent hit rate is not worth it. A missing browser is a supported
configuration, not an error.

### Layer 3 — patterns + SMTP (the no-credentials floor)

1. Resolve the company's mail domain. A scraped `Company.website` wins; failing
   that, candidates are generated from the company name and each must survive
   an MX lookup. The extension's `guessCompanyDomain` did none of this — it
   stripped suffixes, appended `.com`, and every pattern built on the result
   inherited the error.
2. Generate the common address formats, ordered by prevalence.
3. Ask the company's own mail server which exist, via `RCPT TO` — the same
   probe every commercial verifier uses. Free, no API key, no captcha.

Verification is honest about its limits. Most companies are on Google
Workspace or Microsoft 365, and both accept every recipient at the edge; that
is reported as `catch_all`, and the result is labelled a guess rather than a
verified address. A catch-all domain short-circuits the remaining probes,
since no further RCPT can separate the candidates.

`emailSource` records which layer produced the address (`anymailfinder`,
`mailmeteor`, `smtp_verified`, `pattern_guess`), so outreach can tell a
verified address from a weighted guess.

## Consequences

- A job produces contacts whether or not a browser is connected. Nothing waits
  on a laptop staying open, which was the point.
- Deleted: `extension/services/emailFinder.js`, the `FIND_EMAIL` command, the
  `EMAIL_FOUND` / `EMAIL_FIND_FAILED` / `CHECK_PENDING_EMAILS` events and their
  handlers, the extension's email queue, and the worker's 60-second safety
  timeout. The `disconnected`, `pending_extension`, `pending_retry` and
  `timeout` values of `emailSource` no longer occur; rows already carrying them
  are historical.
- The extension's mass-connector workflow now calls
  `POST /api/profiles/find-email` instead of doing the lookup itself.
- **Outbound port 25 decides whether layer 3 verifies anything.** Most hosting
  providers block it. If it is blocked, every result degrades to
  `pattern_guess` — still useful, but not verified. The finder latches this
  after the first blocked probe rather than paying a connect timeout per
  address. Check with:
  `npx tsx src/scratch-emailfinder-probe.ts --smtp-only`
- Qualification is slower per profile, since the lookup is now inline rather
  than dispatched. At the pipeline's ceiling of 15 profiles/day this is
  irrelevant.
