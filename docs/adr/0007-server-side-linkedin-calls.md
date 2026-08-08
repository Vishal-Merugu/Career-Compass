# 7. The server makes the LinkedIn calls

Date: 2026-08-08

## Status

Accepted. **Supersedes ADR 0001** for the read path (company resolution, people
search, profile fetch). ADR 0001 still holds for connection requests, which are
deliberately not moved — see **Consequences**.

## Context

ADR 0001 put every LinkedIn call in the extension so the traffic came from a
real logged-in browser: real cookies, real TLS fingerprint, real user-agent. The
server never had to impersonate anything. That was the right call at the time
and it worked.

The cost was that a run needed a browser open. The extension held the session,
so it had to make the calls, so the laptop had to stay awake for a job to
progress. The same complaint had already forced email finding server-side (ADR 0005) and then produced a queue to get the browser back only where it genuinely
helps (ADR 0006). Scraping was the last thing tethered to the laptop, and it was
the one that mattered most.

**What changed is evidence, not appetite.** `scratch-voyager-probe.ts --long`
ran **14/14 clean across a 3.5 hour cold-gap phase from the deployment host** on
2026-08-05. That host is the university server reached over the VPN; it egresses
via the university NAT gateway (AS680 DFN), which is not a datacenter ASN. So the
premise ADR 0001 was protecting against — a datacenter IP with no browsing
history making bulk Voyager calls — does not describe this deployment.

The server side was also already built and tested. `shared/voyagerClient.ts`
accepts `{ jar }`, `shared/cookieJar.ts` handles rotation and expiry detection,
and both are covered by tests. Nothing was missing except a place to keep a jar.

## Decision

### The server calls Voyager; the extension supplies the credential

```
before:  server  ──WS command──▶  extension ──▶ LinkedIn
after:   extension ──jar──▶ server ──▶ LinkedIn
```

Moved: `resolveCompany`, `searchPeople`, `fetchFullProfile`.
Not moved: `checkRelationship`, `sendConnectionRequest`, `withdrawInvitation`.

### `LinkedInSession` had to be rebuilt before anything could move

The blocker was never the API calls. The table held `csrfToken` and
`liAtCookie` and nothing else — which cannot construct a `CookieJar`, because
`li_at` without `JSESSIONID`, `bcookie`, `bscookie`, `lidc` and `li_rm` reads as
a stolen cookie (ADR 0002). It also had **no writers at all**; only the Telegram
bot read it. It now stores the whole `CookieExport` plus the `userAgent` the jar
was harvested under.

### `withVoyager` is the only sanctioned way to call LinkedIn from the server

`linkedinSession.service.ts` loads the jar, constructs the client, and owns the
write-back rules, because spreading them across call sites is how they get
broken:

- **Persist after success.** `JSESSIONID` is the CSRF token and it rotates
  mid-session; not writing it back means the next call 403s.
- **Never persist after a fatal response.** LinkedIn kills a session by expiring
  cookies, so the post-fatal jar is a dead jar. Saving it overwrites a good
  export and forces a needless re-extraction.
- **Mark the session dead, once, centrally**, so a run pauses instead of
  grinding through every remaining URL against a corpse.

### The extension's new primary job is pushing the jar

`extension/services/sessionSync.js` reads every `linkedin.com` cookie and POSTs
it to `/api/session/cookies` — on startup, on config save, and every 30 minutes.
The server cannot obtain a jar on its own: LinkedIn has no API-key auth, and a
server logging in would be a headless browser on a datacenter-adjacent IP, which
is exactly what the risk engine exists to catch.

`__cf_bm` is stripped on both sides. It is Cloudflare's, bound to the issuing IP,
~30 minute TTL — replaying it from the server is worse than sending nothing.

### A dead session pauses the job; it does not fail the URLs

Marking URLs `failed_permanent` because the credential expired would silently
skip people who are perfectly reachable. The job goes to `paused_error` and the
user is told over Telegram that opening the extension fixes it.

### Pacing and buffering are unchanged

One profile in flight per job, stop at 20 scraped profiles awaiting
qualification, `apiDelay()` (1.5–3.7 s) between calls. These were never about
_where_ the call came from. **Do not "optimise" them** — the ceiling is 15
connection requests/day, so a full day is under 10 minutes of runtime.

## Consequences

- **A run no longer needs a browser open.** Jobs start from `POST /api/jobs`
  rather than from the extension connecting.
- **Connection requests stay in the extension.** This was flagged twice and the
  user asked for everything to move; it is recorded here as the one exception
  because the reasoning is worth keeping: a connection request is a _write_ to
  another person's LinkedIn account, the most restriction-prone call in the
  system, and at 15/day there is **zero throughput to gain** by moving it. The
  mass-connector workflow that owns it also carries its own UI, daily-limit
  accounting and CSV export, so moving it is a workflow port rather than a call
  port. `checkRelationship` stays with it because it only feeds it.
- **Deleted, not left dangling:** the `FETCH_URL_BATCH` and `SCRAPE_PROFILE`
  commands and their payload types, `sendFetchUrlBatch.ts`,
  `sendScrapeProfile.ts`, the unused `dispatcher.ts` interface, the extension's
  `handleFetchUrlBatch` / `handleScrapeProfile` / `getSearchParamsFromUrl`, and
  its `isPaused` flag (whose only readers were those loops).
- **`dispatchNext` survives with a new body.** It kept its buffer and
  serial-execution checks but now nudges the scrape worker instead of emitting a
  command. Seven call sites still want "run this job's next profile now", and the
  worker's 5-second poll would otherwise add latency after every qualification.
- **`onProfileScraped` / `onProfileScrapeFailed` remain**, sharing
  `scrapeIngest.service.ts` with the worker. The extension no longer sends those
  events, so the handlers are currently unreached — kept because the ingest
  service is the shared write path and the handlers are three lines each.
- **The WebSocket gateway is now mostly vestigial** for scraping: heartbeat,
  session check and pause/resume remain, but the extension acts on none of the
  scrape commands. A future session could remove it entirely, but the mass
  connector still registers over it.
- **A stale jar is now a silent failure mode.** If the extension is never opened
  again, cookies eventually expire and every run pauses. That is strictly better
  than the old behaviour (nothing ran at all without a browser), but it means
  "open the extension occasionally" is now a real operational requirement.
- **This measurement is host-specific.** AS680 DFN is a university network.
  Moving the deployment to AWS/GCP/Hetzner invalidates the probe result and needs
  its own `--long` run before trusting it.
