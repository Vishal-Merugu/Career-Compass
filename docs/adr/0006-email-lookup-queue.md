# 6. Email lookups are a queue the dashboard fills and the extension drains

Date: 2026-08-07

## Status

Accepted. Extends ADR 0005, which moved email finding to the server; this adds
a way to ask for a lookup by hand and gets the browser back in the loop as an
_optional_ upgrade path.

## Context

Three problems, discovered together.

**1. The finder's output never reached the dashboard.** The scrape pipeline
writes `ScrapedProfile` and `ProfileDecision`, both keyed by job. Everything
user-facing hangs off `Profile`: `GET /api/profiles` scopes rows by
`outreachLogs.some.userId`, and `CampaignContact` has a foreign key to
`Profile.id`. Nothing bridged the two — `PrismaStorageAdapter.upsertProfile`
existed with **zero callers**. So a completed run left the Results screen empty
and its profiles unreachable from a campaign, and the only way to see what a run
had found was the Telegram bot or the server log.

**2. A run in progress was invisible.** `GET /api/jobs` and
`GET /api/jobs/:id/status` had existed since the pipeline was built and no
client consumed them. There was no screen.

**3. Layer 1 is metered and layer 3 usually cannot verify.** With no
`ANYMAILFINDER_API_KEY`, and with port 25 blocked on most hosts, the common
outcome is `pattern_guess`. Mailmeteor's free widget would fix that, but
Cloudflare refuses a Turnstile token to any automated browser — measured in ADR
0005 against headless Chromium, headful bundled Chromium, and headful real
Chrome on a residential IP. A real user browser gets a token; a server never
will.

So the capability the extension has is genuinely unique, and deleting it in ADR
0005 gave up a free upgrade path. But putting _all_ email finding back there
would re-couple the pipeline to a laptop staying open, which is what ADR 0005
was for.

## Decision

### Publish qualified profiles into `Profile`

`profilePublisher.service.ts`'s `publishQualifiedProfile` upserts a `Profile`
(keyed by the LinkedIn vanity slug, the same key the mass-connector path uses, so
one person is one row) and writes the `OutreachLog` that scopes it to the user.
Failure is logged, not thrown — the decision is already recorded and the pipeline
should keep moving. Shared with the backfill script so the two cannot drift.

### Lookups are rows in `EmailLookup`, not a job in a queue

A lookup requested from the dashboard is a `queued` row. Executors claim rows
under a lease; the address lands on `Profile`, and a copy stays on the lookup row
as the audit trail.

**Why a table and not BullMQ**, which this codebase already runs for campaigns:
BullMQ is for work _the server_ performs. The preferred executor here is a
Chrome extension that may not exist for hours — an MV3 service worker is killed
after ~30s idle, and the WebSocket handshake requires a live `SearchJob`
(`ws-gateway/middleware/auth.ts`), so there is no socket to push a command down
when the button is pressed. A BullMQ job would stall against a worker that isn't
there and retry blindly. Pending work that outlives every process belongs in
Postgres.

The shape is copied from `ProfileUrl`, which already solved this in the scrape
pipeline: a status the client claims, `attempts`, `lastError`, and a lease
timestamp a sweeper reclaims. One row per `(userId, profileId)`, so
double-clicking cannot enqueue the same person twice and the table reads as
"current state of finding this person's email".

### Pull, on an alarm

`extension/services/emailLookupDrainer.js` claims a small batch on a
one-minute `chrome.alarms` tick, runs the Mailmeteor widget, and posts each
result back. Deliberately not a long-lived loop or a `setInterval` — the worker
is suspended and takes both with it. Claim little and often: anything held when
the worker dies waits for the sweeper.

### The extension does the lookups; the server fallback is opt-in

This started as "the extension upgrades results, it never gates them": any row
unclaimed for three minutes fell through to the server-side finder, so pressing
the button always produced an answer.

**That was wrong, and it was corrected before this shipped.** The server only
reaches the metered API and pattern+SMTP, so the fallback settled rows on a
`pattern_guess` — and since the extension drains two at a time, a 40-row batch
meant the server stole ~38 of them within three minutes, before the browser that
could have resolved them properly ever got a turn. A guess is still an answer, so
those rows then looked finished.

So `EmailLookup.allowServerFallback` defaults to **false** and
`POST /api/profiles/find-emails` takes `serverFallback` per request. Rows that did
not opt in wait for a browser indefinitely — intended, not a stall — and Results
offers an explicit "guess the N waiting instead" for when no browser is coming.
`emailLookupWorker` still reclaims abandoned leases every minute regardless.

### Writes to `Profile` are upgrade-only

`emailFinder/confidence.ts` ranks sources: `anymailfinder`/`smtp_verified` (3),
`mailmeteor` (2), `pattern_guess` (1), nothing (0). A result replaces the stored
address only if it is strictly stronger. Without this, the fallback sweep would
overwrite an address a provider confirmed with a guess it generated seconds
later — and outreach mails from the user's own Gmail, so the bounce, or a
stranger's inbox, would be the first anyone heard of it.

Equal strength keeps the existing address, so re-running is idempotent rather
than a coin flip between two guesses. A rejected result is still recorded on the
lookup row with `lastError: 'Kept existing address — not an upgrade'`.

### `pattern_guess` stays re-queueable

A guess is marked `done` — it is a real answer and the user should see it. But
`isVerifiedSource('pattern_guess')` is false, so selecting that profile and
pressing the button again re-queues it. That is how a guess gets upgraded later
without the row cycling through the fallback forever.

## Consequences

- Results shows what a run found; campaigns can consume it. Both were broken
  before, not degraded.
- New `Runs` screen, polled (3s while a job is active, 10s for the list). Not
  SSE: job progress is driven by the extension over WebSocket, so there is no
  server-side emitter to subscribe to the way campaigns have one.
- `scripting` is back in `extension/manifest.json`, and
  `extension/services/emailFinder.js` is restored — **widget driver only.** It
  does not generate patterns: the server's version MX-validates the domain and
  probes it over SMTP, so a guess made in the extension would be strictly worse.
- Lookup progress is readable from `GET /api/profiles/find-emails` at any time.
  The SSE stream is an accelerator, not the record — progress advances while the
  tab is closed, so the UI cannot treat a frame as the only way state changes.
- `POST /api/profiles/find-emails` is `requireAuth`; the extension's claim and
  report routes are `requireAuthOrApiKey`. The long-lived key can fetch work and
  report an address, and nothing else.
- Selection on Results no longer requires an email, since finding one is now an
  action you take on a row that has none. "Add to campaign" applies to the
  mailable subset and shows its own count.
