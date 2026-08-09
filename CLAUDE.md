ALWAYS FOLLOW: **Be extremely concise. Sacrifice grammar for the sake of concision**

Read `tasks/lessons.md` at session start. Do not repeat mistakes documented there.

## What this is

LinkedIn job-discovery + outreach automation. Three parts:

- **`server/`** — TypeScript/Express/Prisma/Postgres/Redis backend. The **brain**.
- **`extension/`** — Manifest V3 Chrome extension, plain JS, no build step. The **hands**.
- **`client/`** — Vite/React/TypeScript/Mantine web dashboard. The **face**.

The server does the LinkedIn work; the extension supplies the LinkedIn session
and drives the two things that genuinely need a real browser (the email-finder
widget and connection requests). The dashboard is a plain REST client of the
server.

**Git root is `CareerCompass/`, not the parent `linkedin-automationV2/`.**

## Architecture: the server calls LinkedIn, the extension supplies the session

**This reversed on 2026-08-08.** The extension used to make every Voyager call;
the server now makes the read calls itself (`resolveCompany`, `searchPeople`,
`fetchFullProfile`) and the extension's job is to keep the server's cookie jar
fresh. A run no longer needs a browser open. See
`docs/adr/0007-server-side-linkedin-calls.md`, which supersedes ADR 0001 for the
read path.

What made it safe was a measurement, not a preference: `probe:linkedin --long`
ran **14/14 clean across 3.5 h from the VM**, which egresses via the university
NAT (AS680 DFN) rather than a datacenter ASN.

**Connection requests did NOT move.** `sendConnectionRequest`,
`withdrawInvitation` and `checkRelationship` stay in `massConnector.js`: a write
to someone else's account is the most restriction-prone call here, and at 15/day
there is no throughput to gain. Do not "finish the migration" by moving them
without deciding that deliberately.

```
server/src/services/linkedinSession.service.ts   the jar + withVoyager()
server/src/services/urlCollector.service.ts      resolveCompany + searchPeople
server/src/services/scrapeIngest.service.ts      what to do with a scraped profile
server/src/workers/scrapeWorker.ts               fetchFullProfile, paced + buffered
server/src/orchestrator/jobRunner.ts             startJob / collectNextBatch
extension/services/sessionSync.js                pushes the cookie jar
```

**Call LinkedIn only through `withVoyager(userId, fn)`.** It is the one place
that knows to persist the jar after success (JSESSIONID rotates and is the CSRF
token) and **not** to persist after a fatal response (that overwrites a good
export with a dead session). Constructing `VoyagerClient` directly at a call site
bypasses both.

**A dead session pauses the job, it does not fail the URLs.** Marking URLs
permanently failed because the credential expired would silently skip reachable
people.

**The server cannot obtain a session.** No API-key auth exists, and a server
logging in would be a headless browser on a datacenter-adjacent IP. A jar always
comes from a real browser: `POST /api/session/cookies` (the extension, every
30 min) or `npm run cookies:import` by hand. So "open the extension occasionally"
is a real operational requirement now — if cookies expire, every run pauses.

```
server/src/ws-gateway/        Socket.io gateway
  events.ts                   single source of truth for event names + payloads
  commands/                   server → extension  (SESSION_CHECK,
                              STOP_LIMIT_REACHED, PAUSE, RESUME)
  handlers/                   extension → server  (REGISTER, URL_BATCH_ITEM,
                              PROFILE_SCRAPED, SESSION_INVALID, HEARTBEAT, …)
  connectionRegistry.ts       userId → live socket
server/src/orchestrator/      job state machine: dispatchNext, stopCondition,
                              syncAndResume, timeoutSweeper
server/src/api/               REST routers (config, jobs, profiles, sync)
server/src/shared/            code mirrored between server and extension
                              (parsers, rateLimiter, voyagerClient, resilience)
server/src/workers/           qualificationWorker (LLM profile scoring)
server/src/services/emailFinder/  work-email discovery, server-side
server/src/telegram/          bot — job control + lifecycle notifications
```

Adding a WS message means touching **three** places: `events.ts` (name +
payload), a `commands/` or `handlers/` file, and the extension counterpart in
`extension/scripts/background.js`. Never invent an event string inline.

The gateway is now mostly vestigial: `FETCH_URL_BATCH` and `SCRAPE_PROFILE` are
gone, and the extension acts on no scrape command. Heartbeat, session check and
the mass connector's registration are what keep it alive.

`server/src/shared/*` is duplicated by hand in `extension/services/*`. Change one,
check the other.

## Email finding

**Lookups are never automatic.** `qualificationWorker` does _not_ find emails —
a qualified profile lands on Results with no address, and you start the lookup
from there ("Find emails"). It used to run inline, and because the server only
reaches the two layers below, every profile resolved to a `pattern_guess` before
a real browser saw it — and a guess is an answer, so the row never got upgraded.

Two layers, the second running only when the first produced nothing:

1. **Anymail Finder** — a real key-authenticated API. Set
   `ANYMAILFINDER_API_KEY` to enable; unset, the layer is skipped. Metered
   (one credit per valid email found, 100 free on signup), so it latches off
   on 401/402 rather than retrying per profile.
2. **Patterns + SMTP** — needs no credentials at all.

**There is no server-side Mailmeteor layer, and no browser in the image.** There
used to be: it drove their free widget in headless Chromium and returned nothing,
because Cloudflare refuses a Turnstile token to an automated browser — measured
against headless Chromium, headful bundled Chromium, _and headful real Chrome on
a residential IP_. It was deleted along with `playwright` and the
`INSTALL_CHROMIUM` build arg. That lookup now runs in the extension, where it
works, and reports back through the lookup queue — so `mailmeteor` is still a
live `emailSource`, it just arrives from a browser.

Do not "fix" this with a captcha-solving service, a stealth plugin, or by
relaying a token minted in the extension. The token is single-use and expires
in minutes, so a relay still requires a live browser per lookup. Use a provider
that sells API access instead; that is what layer 1 is for.

**Outbound port 25 decides whether anything gets verified.** Blocked on most
hosts; if blocked, every result is a `pattern_guess` rather than a verified
address. Check before trusting verdicts:

```bash
npx tsx src/scratch-emailfinder-probe.ts --smtp-only
```

`emailSource` records which layer produced the address — `anymailfinder`,
`mailmeteor`, `smtp_verified`, `pattern_guess`, `not_found` — so outreach can
tell a verified address from a weighted guess. **Google Workspace and
Microsoft 365 accept every recipient**, so a `catch_all` verdict is not a
confirmation.

See `docs/adr/0005-server-side-email-finder.md`.

### Lookups requested by hand

Select rows on Results → "Find emails". That does **not** look anything up in
the request: it writes `queued` rows to `EmailLookup` and returns. Executors
claim them under a lease.

```
server/src/services/emailLookup.service.ts   enqueue / claim / complete / sweep
server/src/services/emailFinder/confidence.ts  source ranking, upgrade rule
server/src/workers/emailLookupWorker.ts      lease sweeper + server fallback
server/src/api/emailLookups.router.ts        claim + report (extension, api key)
extension/services/emailLookupDrainer.js     the drainer, on a chrome.alarms tick
```

**The queue is a table, not BullMQ.** BullMQ is for work the server does; the
preferred executor is the extension, which may be gone for hours — an MV3
worker dies after ~30s idle and the socket handshake needs a live `SearchJob`,
so there is nothing to push a command down. Pending work that outlives every
process belongs in Postgres. Shaped after `ProfileUrl`, which solved this
already.

**The extension upgrades results; it never gates them.** A row no browser
claims within three minutes is handed to the server-side finder by
`emailLookupWorker`. Pressing the button always produces an answer.

**Writes to `Profile.email` are upgrade-only** (`isEmailUpgrade`). The fallback
would otherwise overwrite a provider-confirmed address with a guess generated
seconds later, and outreach mails from the user's own Gmail. Equal strength
keeps the existing address, so a re-run is idempotent. A `pattern_guess` is
deliberately still re-queueable — that is how it gets upgraded later.

**A miss is a 200, not an error.** `{ ok: false, error }` re-queues the row;
the status code is reserved for transport failures. Three attempts, then
`failed`.

See `docs/adr/0006-email-lookup-queue.md`.

## The finder pipeline reaches the dashboard through `Profile`

`ScrapedProfile` and `ProfileDecision` are keyed by **job**. Everything
user-facing hangs off **`Profile`**: `GET /api/profiles` scopes rows by
`outreachLogs.some.userId`, and `CampaignContact` FKs to `Profile.id`.

`qualificationWorker.publishToResults` is the bridge — it upserts the `Profile`
(keyed by LinkedIn vanity slug, same key the mass connector uses, so one person
is one row) and writes the `OutreachLog` that scopes it to the user. **Without
that `OutreachLog` the profile is invisible**, so it is not optional
bookkeeping. This was missing entirely: `upsertProfile` had zero callers, so a
finished run left Results empty and its profiles unreachable from a campaign.

## The dashboard

```
client/src/
  api/client.ts      fetch wrapper — credentials:'include', throws ApiError
  api/types.ts       hand-written response shapes; keep in sync with schema.prisma
  auth/              AuthProvider (GET /api/auth/me is the only session source)
  pages/             one file per screen
  components/        DashboardLayout (Mantine AppShell)
```

Screens: Runs, Results, Campaigns, Campaign detail, Settings.

**Runs is polled, not streamed** (3s while a job is active, 10s for the list).
Job progress is driven by the extension over WebSocket, so there is no
server-side emitter to subscribe to the way campaigns have one.

Vite builds `client/` → **`server/public/`** (gitignored), which
`express.static` serves **same-origin**. So the client calls `/api/...` as a
relative path: no CORS, no mixed content, no API base URL to configure.
`npm run dev:client` proxies `/api` → `localhost:3000` to keep dev same-origin too.

**Two credentials, deliberately separate:**

| Surface   | Credential                   | Set by                       |
| --------- | ---------------------------- | ---------------------------- |
| dashboard | httpOnly cookie `cc_session` | `server/src/auth/cookies.ts` |
| extension | `x-api-key` header           | unchanged, never touch it    |

`extractSessionToken()` in `server/src/auth/middleware.ts` accepts
`Authorization: Bearer` **or** the cookie, header wins. Login returns a `token`
in the body; the dashboard ignores it — the cookie is the session.

**Registration is closed once the instance has an owner.** The first account on
an empty database is always allowed (bootstrap); after that, `POST
/api/auth/register` requires `REGISTRATION_TOKEN` to be set server-side and
matched via an `x-registration-token` header or a `registrationToken` body
field. An existing deployment that never sets it therefore has registration
closed — that is deliberate, not a misconfiguration.

**`GET /api/auth/me` must never return `apiKey`.** It returns `id`, `email` and
`telegramId` only. The cookie is httpOnly so page script cannot steal the
session; echoing `req.user` wholesale would hand back the extension's
long-lived API key instead, which works from anywhere and never expires.

**`GET /api/profiles` is paginated (`skip`/`take`, max 200) and field-selected.**
Its `stats` block is computed over the whole result set, not the returned page,
because the dashboard's headline tiles read from it. Never swap the `select`
back to `include` — that ships `rawProfileJson` and `about` for every row (1.14 MB
vs 98 KB on a 250-row set) and auto-publishes any column added later.

Two traps, both already paid for:

- The SPA fallback in `server/src/index.ts` **must** keep excluding `/api` and
  `/health`. Without that, a typo'd API URL returns `index.html` with a 200 and
  surfaces as a JSON parse error nowhere near the cause.
- `upgrade-insecure-requests` is stripped from helmet's CSP unless `HTTPS=true`.
  The VM serves plain HTTP with nothing on 443, so leaving it on makes the
  browser upgrade the page's own `/assets/*.js` and render a blank page.

## Outreach campaigns

Ported from the standalone Bulk Mail Sender, which read contacts from a CSV
exported from here by hand. Contacts now come from `Profile` directly:
select rows on Results → "Add to campaign".

```
server/src/services/campaign.service.ts   create/seed/start/stop + the processor
server/src/services/draft.service.ts      subject extraction, signature, prompt
server/src/services/mailer.service.ts     pooled transports, credential check
server/src/queue/                         BullMQ queue + worker (ioredis)
server/src/api/campaigns.router.ts        REST + SSE progress
server/src/api/outreachSettings.router.ts SMTP creds, signature, résumé
```

**Redis is REQUIRED to boot.** It used to degrade to "Postgres fallback mode";
a queue has no such fallback, so a campaign would accept the click, report
success and send nothing. `initRedis` now throws and `index.ts` exits.

**One BullMQ job per contact, carrying a cumulative delay.** Pacing lives in
Redis, so it survives a restart — the ported loop used `setImmediate` plus
`await setTimeout` and lost its place entirely. `concurrency: 1`, because a
concurrent worker would send N at once regardless of the configured gap.

**The worker runs in the API process** (`startCampaignWorker` in `index.ts`).
Non-blocking, since every step is awaited I/O. If it is ever split out,
`campaignEvents` must become Redis pub/sub or SSE goes silent.

**Campaign routes use `requireAuth`, not `requireAuthOrApiKey`.** The
extension's key is long-lived and works from anywhere; reporting scrape
results must not confer the ability to send mail from the user's Gmail.

**`GET /api/config` is field-selected.** It is reachable with the extension's
API key and the row now holds `smtpPassword`. Never return the whole row.

`UserConfig.smtpPassword` is AES-256-GCM via `lib/secretBox.ts`, keyed by HKDF
from `JWT_SECRET` — so rotating `JWT_SECRET` makes stored passwords
undecryptable and they must be re-entered.

**Every variable the server reads must be listed in `docker-compose.yml`'s
`environment:` block.** Setting it in `~/cc-config/.env` alone does nothing —
Compose only substitutes variables that are named there.

See `docs/adr/0004-same-origin-web-dashboard.md`.

## Commands

```bash
# server (run from server/)
npm run dev              # tsx watch
npm run build            # tsc → dist/
npm run db:migrate       # prisma migrate dev
npm run db:generate      # prisma generate  (after any schema.prisma edit)
npm run db:studio
npm run probe:linkedin -- --quick      # ~4 min,  6 read-only Voyager calls
npm run probe:linkedin -- --sustained  # ~35 min, 10 calls  (default)
npm run probe:linkedin -- --long       # ~4 h,   14 calls
npm run probe:linkedin -- --egress-only # egress IP/ASN only, no cookies, no calls
npm run cookies:import   # build linkedin-cookies.json from a copied cURL

# client (run from client/)
npm run dev              # vite dev server, proxies /api → localhost:3000
npm run build            # tsc --noEmit && vite → server/public/

# repo root
npm test                 # vitest (delegates to server/)
npm run typecheck        # tsc --noEmit, server + client
npm run lint             # eslint (extension JS)
npm run dev:client       # client dev server
npm run build:client     # client → server/public/
npm run build:ext        # → extension.zip, backend URL baked in from .env.production
```

**Three npm projects, three lockfiles**: root (eslint/prettier/husky tooling),
`server/`, `client/`. `npm ci` in one does not install the others — `pr.yml`
installs all three.

Extension has no build step for dev — load `extension/` unpacked via
`chrome://extensions` → Developer mode → Load unpacked. `build:ext` is only for
producing a distributable zip.

## Running locally

There is no Docker on the dev machine; Postgres and Redis are native (brew).

```bash
pg_ctl -D /opt/homebrew/var/postgresql@14 -l /tmp/pg.log start   # Redis usually already up
pg_isready && redis-cli ping

npm run build:client            # client/ → server/public/
cd server && npm run dev        # http://localhost:3000
```

`server/.env` already points at `localhost:5432/careercompass`. The log line
`🖥️  Serving web dashboard from …/server/public` means same-origin serving is
live; without it you get `API only` and a blank page, which means `build:client`
was never run (`server/public/` is gitignored).

Stop with `pg_ctl -D /opt/homebrew/var/postgresql@14 stop -m fast`. Use `pg_ctl`
rather than `brew services` so nothing is registered with launchd.

Things that will waste your time otherwise:

- **Login is capped at 10 attempts / 15 min per IP.** The limiter is in-memory,
  so restarting the server clears it.
- **Registration is closed once any user exists.** On an empty database the
  first sign-up is free; otherwise start the server with `REGISTRATION_TOKEN=…`
  and enter it as the invite code.
- **`TELEGRAM_BOT_TOKEN` collides with the deployed VM instance.** Both poll the
  same token, Telegram allows one poller, and the log fills with 409 Conflict
  errors. Comment it out of `server/.env` while working locally — it is optional
  in `env.ts`.
- **Redis must be running** or the server exits at boot (see Outreach).
- **The Results screen needs data.** `GET /api/profiles` only returns profiles
  linked to your user through `OutreachLog`, so a fresh account sees the empty
  state until a workflow has run.

## Deployment

**`git push` does NOT deploy.** Nothing deploys automatically, ever.

Deploy = Actions tab → "Deploy to VM" → Run workflow → pick branch. It runs on a
**self-hosted runner** (`llm-for-extension`) on the VM at `172.17.64.118`, because
the VM is reachable only over the university VPN and hosted runners cannot get to
it. See `docs/adr/0003-manual-dispatch-deploys.md`.

Rules:

- **Never add `push` or `pull_request` triggers to `deploy.yml`.** The repo is
  public; that would let a fork PR execute code on the VM.
- `COMPOSE_PROJECT_NAME: careercompass` in `deploy.yml` must stay. Without it
  Compose derives the project from the runner's workspace directory name — which
  differs from the original clone — and silently creates a second set of volumes
  plus an empty database.
- Gitignored runtime files live in `~/cc-config/` on the VM (`.env`,
  `linkedin-cookies.json`) and are copied into the workspace on each deploy.
- The image's **build context is the repo root**, not `./server` — it bundles the
  backend and the dashboard built from `client/`. Set in `docker-compose.yml`
  (`context: .`, `dockerfile: server/Dockerfile`). The root `.dockerignore` is
  what keeps `node_modules/` and `extension/` out of that context; without it
  every build uploads them and any extension edit busts the image cache.
- `~/CareerCompass` and the root `deploy.sh` on the VM are vestigial.
- SSH to the VM needs the VPN (`ubuntu@172.17.64.118`, key
  `~/Documents/Temp/fresh-key.pem`). Deploying does not.

## LinkedIn / Voyager rules

Hard-won. Violating these is how sessions die.

- **`li_at` alone is not a session.** The full jar is required: `li_at`,
  `JSESSIONID`, `bcookie`, `bscookie`, `lidc`, `li_rm`. An auth token without the
  browser-identity cookies looks like a stolen cookie to LinkedIn's risk engine.
- **`JSESSIONID` _is_ the CSRF token, and it rotates.** Read it live from the jar
  on every request. Freezing it at construction time is what produced the "token
  expired" 403s.
- **LinkedIn kills a session by expiring cookies, not by redirecting to a login
  page.** It self-redirects to the _same URL_ and sends
  `set-cookie: li_at=delete me; Max-Age=0`. Detect expiry **by attribute**
  (`Max-Age=0` / past `Expires`) — never by sniffing the value. Parsing that as a
  value rotation writes the literal string `"delete me"` into the jar.
- **The Voyager API never legitimately redirects.** Any 3xx means the session is
  dead, including a self-redirect that looks harmless.
- **Never persist the cookie jar after a fatal response.** It overwrites a good
  export with a dead session and forces a needless re-extraction.
- **`__cf_bm` is Cloudflare's, bound to the issuing IP, ~30 min TTL.** Strip it
  when moving a jar between machines; Cloudflare mints a fresh one.
- A **200 with an HTML body** is an auth wall behind a 200. Not a success.

Reference implementation: `server/src/shared/cookieJar.ts` (`CookieJar`,
`classifyFatal`), covered by tests and re-exported by
`server/src/scratch-voyager-probe.ts`. `server/src/shared/voyagerClient.ts` uses it:
construct it with `{ jar }` server-side, or `{ csrfToken }` only from a
linkedin.com context where the browser attaches the cookies. It throws
`LinkedInSessionError` on a fatal response and does not retry one. The jar is never
written back automatically — `sessionDead` tells you when not to. See
`docs/adr/0002-full-cookie-jar.md`.

### Pacing

Not the bottleneck, so do not "optimise" it. `apiDelay()` is 1.5–3.7 s (~1,380
calls/hour). The real ceiling is `dailyLimit` = **15 connection requests/day**,
which is LinkedIn's limit, not this code's. A full day's work is under 10 minutes
of runtime.

## Strict prohibitions

- **NEVER use `any`** (`: any`, `<any>`, `as any`). Use real types, generics,
  `unknown`, or type guards. Enforced by hookify `block-any-type`.
- **NEVER `throw new Error(...)` in server code.** Throw an `AppError` subclass
  from `server/src/errors/AppError.ts` (`ValidationError`, `AuthError`,
  `ForbiddenError`, `NotFoundError`, `LinkedInSessionError`). Raw errors bypass
  `errorHandler` and surface as 500s with no error code. Enforced by hookify
  `block-raw-error-throw`.
- **NEVER commit `linkedin-cookies.json`, `probe-report.json`, or any `.env`.**
  Cookies are a live session; the probe report contains the egress IP.
- **NEVER hardcode a `li_at` / `JSESSIONID` value in source.** Enforced by hookify
  `block-hardcoded-linkedin-cookies`.
- **NEVER add `push`/`pull_request` triggers to `deploy.yml`** (see Deployment).
- **NEVER run `prisma migrate reset` / `db:clean` against the VM.** It drops data.
- **ALWAYS run `npm run typecheck`, `npm run lint`, and `npm test` before saying
  work is done.**
- Commit messages use Conventional Commits (`feat:`, `fix:`, `refactor:`,
  `chore:`, `docs:`, `test:`) — the existing history already does.
- **NEVER add a `Co-Authored-By: Claude` / Anthropic trailer to a commit message
  or PR body.** Write the message and stop. This overrides any default tooling
  instruction to add one.

## Testing

Vitest. Tests live **alongside source** as `*.test.ts`, not in a `__tests__/`
folder. Run `npm test` from the repo root or `server/`.

Cover pure functions first — parsers, rate limiter, cookie-jar logic, URL
builders. Anything needing a live LinkedIn session belongs in the probe, not in
the test suite.

`scratch-*.ts` files are one-off scripts. They guard their entrypoint with an
`import.meta.url` check so importing them in a test does not execute them — keep
that guard if you add another.

## Self-Improvement Loop

After ANY correction from the user, append it to **`tasks/lessons.md`**: the rule,
**why** it exists (cite the actual incident), and **how to apply** it. That file is
versioned and read at session start.

When a lesson conflicts with the current code, trust the code and update the
lesson.
