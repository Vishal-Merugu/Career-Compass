# 0001 — The extension executes, the server orchestrates

Date: 2026-08-05
Status: Accepted

## Context

CareerCompass needs to call LinkedIn's internal Voyager API on a user's behalf:
search people, fetch profiles, send connection requests. Something has to hold the
authenticated session.

Two candidates:

1. **The server** holds exported cookies and calls Voyager directly. Simple
   deployment story, everything runs headless on the VM, nothing depends on a
   browser being open.
2. **The extension** calls Voyager from inside a logged-in linkedin.com context.
   The browser attaches its own cookies; the extension never handles them.

The project started closer to (1) — including a Puppeteer-based backend, purged in
`2ae1528 chore: Purge puppeteer from backend architecture`. Server-side execution
kept dying: sessions were killed after a while, and the failures looked like bot
detection.

The distinguishing question is what LinkedIn's risk engine actually sees. A
browser presents a coherent identity: Chrome's TLS fingerprint, a consistent
user-agent, a full cookie jar including browser-identity cookies, an IP the account
has used before, and organic navigation timing. A server reproducing this by hand
gets each piece slightly wrong, and the mismatch is the signal.

## Decision

**The server orchestrates. The extension executes.**

- The server owns job state, scheduling, persistence (Postgres/Prisma), the LLM
  qualification worker, rate-limit accounting, and Telegram notifications. It
  decides _what_ should happen and _when_.
- The extension owns every call that touches linkedin.com. It is the only component
  that holds a real session.
- They communicate over Socket.io. `server/src/ws-gateway/events.ts` is the single
  source of truth for message names and payloads: `commands/` is server → extension
  (`SESSION_CHECK`, `FETCH_URL_BATCH`, `SCRAPE_PROFILE`, `STOP_LIMIT_REACHED`,
  `FIND_EMAIL`), `handlers/` is extension → server (`REGISTER`, `URL_BATCH_ITEM`,
  `PROFILE_SCRAPED`, `SESSION_INVALID`, `HEARTBEAT`, …).

The server never needs to impersonate a browser, because it never talks to LinkedIn.

## Consequences

- **The browser must be open** for work to happen. The orchestrator is built around
  this: `connectionRegistry.ts` tracks live sockets, `timeoutSweeper.ts` reclaims
  jobs whose extension went away, and `syncAndResume.ts` restores state when it
  comes back. Losing the browser is a normal, handled condition — not an error.
- **Adding a capability costs three edits**, not one: `events.ts`, a `commands/` or
  `handlers/` file, and `extension/scripts/background.js`.
- **Logic is duplicated.** `server/src/shared/*` (parsers, rate limiter, resilience,
  Voyager client) is mirrored by hand in `extension/services/*`. The two copies must
  move together. This is the main ongoing cost of the decision.
- **The extension is unbundled JS** — no build step, no imports across service
  files. `build:ext` only zips it with the backend URL substituted in.
- The server-side Voyager client (`server/src/shared/voyagerClient.ts`) is
  effectively dormant. It is kept for a possible future server-side path but is not
  on the live route; see ADR 0002 for why it is not fit for that purpose today.

## Alternatives considered

- **Server-side execution with exported cookies.** Rejected as the default. The 2026-08-05
  probe (see ADR 0002) shows it is _viable_ — Node/undici's TLS fingerprint is not
  blocked — but it still requires exporting a live session out of the browser and
  re-exporting when it dies. The extension needs neither.
- **Headless browser on the VM (Puppeteer).** Tried and removed. It carries the full
  cost of running Chrome on a server — memory, `SYS_ADMIN`, `shm_size: 1gb`, all
  still visible in `docker-compose.yml` — for a session no more trustworthy than the
  user's own browser, which is already there and already logged in.
- **A user-installed desktop agent** instead of an extension. Rejected: it would have
  to reimplement browser session handling, which is exactly the part that is hard.
