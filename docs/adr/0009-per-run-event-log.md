# 9. A per-run event log, budgeted at tens of rows

Date: 2026-08-10

## Status

Accepted.

## Context

A run scraped 368 profiles, qualified none, and displayed
`scraping · 347 of 369 scraped · 0 / 50` throughout. Every one of those 368
profiles had failed evaluation against a model that was never reached, and
nothing on any screen said so.

The information existed. It was in `docker logs cc-server` — along with a
`Telegram polling error: 409 Conflict` every seven seconds, forever, because a
local dev server was polling the same bot token. The real failure was found by
querying Postgres directly.

So there were two problems: the person who started the run had nowhere to look,
and the place an operator _would_ look was unreadable.

## Decision

**A `JobEvent` table, written only through `services/jobEvents.service.ts`,
budgeted at 20–40 rows for a 400-profile run.**

The budget is enforced structurally rather than by convention:

```prisma
@@unique([jobId, stage, code])
```

A repeat cannot insert. `recordJobEvent` upserts, so a second occurrence bumps
`count` and refreshes the message. An error that recurs 300 times is one line
reading "×300", and a progress line rewrites itself in place.

What is logged: run created (naming the model it will use), each batch started
and finished, scrape progress every 25 profiles, a rolling qualified count, the
first occurrence of each distinct error code, the run pausing with its cause and
fix, and the run completing.

**What is deliberately not logged: individual profiles.** Rejections are the
bulk of the volume and the least informative thing an operator can read.
Qualified profiles are listed on the run page as _people_, which is more useful
than a log line about them — and the unique constraint would collapse them
anyway.

Two supporting decisions:

- **The message is written for a human, and the fix travels with it.** Copy
  comes from `errors/jobErrors.ts`, keyed by `JobErrorCode`, so the same failure
  reads identically wherever it appears. The provider's own words go in
  `detail`, collapsed behind a disclosure in the UI. `LLM Error: fetch failed`
  is what 368 profiles were rejected with: technically accurate, and useless.
- **`SearchJob.failureCode` and `failureDetail` are denormalised onto the job**,
  so the Runs list can say why a run stopped without joining the log. A paused
  run rendering identically to a working one is how twenty minutes went by
  unnoticed.

## Consequences

The run page answers "what happened" without anyone reading a server log.

The rule that keeps it working is narrow and easy to break: **every write goes
through `recordJobEvent`.** One `prisma.jobEvent.create` at a call site, or one
per-profile event, and the log becomes the thing it was built to replace. If it
ever needs a filter box, the write rate has gone wrong — fix the writes, not the
UI.

Separately, the Telegram poller now gives up after five consecutive 409s with a
single warning naming the cause, and `ENABLE_TELEGRAM=false` turns it off
locally. A log nobody can read is worse than no log, because it looks like
diligence.
