# Lessons Learned

Patterns to follow, learned from real corrections and real incidents in this
repo. **Versioned in git.** Read at session start; appended to after any
correction.

**Format:** each lesson states the rule, **why** it exists (cite the incident,
not a principle), and **how to apply** it.

---

## LinkedIn sessions

### `li_at` alone is not a session

Send the full jar: `li_at`, `JSESSIONID`, `bcookie`, `bscookie`, `lidc`, `li_rm`.

**Why:** the 2-cookie client (`shared/voyagerClient.ts`) kept getting killed. An
auth token arriving without browser-identity cookies looks like a stolen cookie
to LinkedIn's risk engine.

**Apply:** any code that builds a Cookie header for linkedin.com. The correct
implementation is `CookieJar` in `src/shared/cookieJar.ts`, and
`VoyagerClient` now takes it directly (`new VoyagerClient({ jar })`). Its
constructor rejects a jar missing any of `CRITICAL_COOKIES`, so this fails loudly
at construction instead of quietly at the first 403 — do not soften that check to
"warn and continue".

### Read `JSESSIONID` live on every request

It doubles as the CSRF token **and it rotates**.

**Why:** freezing it at construction time produced a run of "token expired" 403s
that looked like bot detection and wasn't.

**Apply:** never cache the csrf-token header value. Call `jar.csrf()` per request.

### Detect cookie expiry by attribute, never by value

Expiry is `Max-Age=0` or a past `Expires`. Do not look at the value.

**Why:** LinkedIn kills a session with
`set-cookie: li_at=delete me; Max-Age=0`. Parsing that as a value rotation wrote
the literal string `"delete me"` into the jar and corrupted the saved export —
which then had to be re-extracted from the browser by hand.

**Apply:** `CookieJar.absorb()`. Covered by
`src/scratch-voyager-probe.test.ts` → "expiry detection".

### Any 3xx from Voyager means the session is dead

Including a self-redirect to the same URL.

**Why:** LinkedIn does not bounce you to a login page; it self-redirects and
expires your cookies on the way. Following redirects hides that behind a 200
HTML page. A 200 whose body starts with `<` is an auth wall, not a success.

**Apply:** `redirect: 'manual'` on every Voyager fetch; `classifyFatal()` owns the
verdict.

### Never persist the cookie jar after a fatal response

**Why:** writing back a gutted jar overwrites a good export with a dead session
and forces a needless re-extraction.

**Apply:** guard the write — `if (!result.fatal) persistJar(jar, exported)`. From
`VoyagerClient`, the latched `sessionDead` flag is the same guard; `CookieJar` has
no `persist()` of its own precisely so that the write is always a caller's
deliberate act.

### Never retry a fatal Voyager response

A retry policy must distinguish "throttled" from "dead".

**Why:** `withRetry` retried on any non-2xx. A dead session returns 401/403 on
every attempt, so the client spent four paced calls (~15 s of delay each) proving
the same thing, and hammering a soft block is how it becomes a hard one. A 429 is
the opposite case — the session is alive and backing off is correct.

**Apply:** `VoyagerClient._isRetryable` retries only `429` and `5xx` (read off
`AppError.details.status`) plus bare network errors. `LinkedInSessionError` is
never retried, and neither is a 4xx.

### Strip `__cf_bm` when moving a jar between machines

**Why:** it is a Cloudflare token bound to the issuing IP with a ~30 min TTL.
Carrying it to another host makes an otherwise-fine session look wrong.
Cloudflare mints a fresh one on its own.

### A probe result without an egress IP proves nothing

Record the egress IP/ASN for every run, and never swallow the lookup error.

**Why:** the first `--long` run (2026-08-05, 14/14 clean across a 3.5 h cold-gap
phase) shipped a report with `"egress": {}`. `reportEgress()` had a bare
`catch {}` that printed "(lookup failed — continuing)" and threw the reason
away. The cause turned out to be that `ipinfo.io` (hosted on GCP) is
unreachable from the `cc-server` container, while LinkedIn and other providers
are fine — a 10-second diagnosis that stayed invisible for the whole run. The
run "passed", but nothing could be attributed to a network, which was the only
question it existed to answer.

**Apply:** `reportEgress()` now walks `EGRESS_PROVIDERS` — ipinfo.io, ipapi.is,
ifconfig.co, geojs.io — on different networks on purpose, each with a 6 s
budget, and prints every failure reason when all four fail. Check a network
with `npm run probe:linkedin -- --egress-only` _before_ starting a long run.

**Correction, 2026-08-10:** "ipinfo.io is hosted on GCP and unreachable from the
container" was the wrong diagnosis. The real cause was the container MTU — see
"A container MTU above the host's silently eats large packets" below. The
provider was never blocked; its TLS handshake just did not fit.

**Two runs from different places are not comparable.** The laptop leaves via a
consumer ISP (AS8881); the VM — the university server, reached over the VPN, and
the only deployment target — leaves via the university NAT gateway (AS680 DFN).
Run `--egress-only` in both places and compare the ASN.

**The clean `--long` run was on the VM**, in the `cc-server` container: 14/14
across 3.5 h. That is why a server-side Voyager worker is viable here. Do not
read that report's `"egress": {}` as meaning it ran somewhere else — it is a
symptom of running on the VM, where the container cannot reach GCP-hosted
ipinfo.io.

Deliberately no IPs here: this file is versioned and the repo is public, which
is the same reason `probe-report.json` is gitignored.

### A container MTU above the host's silently eats large packets

The VM's `ens3` is **1442**. Docker defaults its bridge to 1500, so
`docker-compose.yml` now pins `networks.default.driver_opts` to 1442.

**Why:** on 2026-08-10 "Start sending" failed with `Could not sign in to the
mail server: Connection timeout` after spinning for two minutes. It read as a
blocked port or a wrong app password. It was neither — the app password was
fine and outbound 465 was open. The container was emitting frames the host link
could not carry, so anything small arrived and the first large packet vanished:

| Test                                       | Result    | What it wrongly suggested |
| ------------------------------------------ | --------- | ------------------------- |
| `nc -vz smtp.gmail.com 465` from the host  | succeeded | the network is fine       |
| TCP connect to 465 from the container      | succeeded | the network is fine       |
| plaintext SMTP greeting on 587 (~80 bytes) | arrived   | the network is fine       |
| TLS handshake on 465 (certificate)         | timed out | the port is blocked       |

Every cheap check passes, because every cheap check sends small packets. The
proof was a control: an identical container on a 1400-MTU network completed the
same TLS handshake. `ping -M do` put the path MTU to Gmail at ~1440.

This had been misdiagnosed once already as "ipinfo.io is GCP-hosted and
blocked", and it is why LinkedIn worked while Gmail did not — LinkedIn's
handshake happened to fit.

**Apply:** when a connection establishes but then hangs, suspect MTU before
firewalls, and compare `cat /sys/class/net/<iface>/mtu` on the host against the
container's. Never conclude "port blocked" from a TCP-connect test alone — use
`openssl s_client` or a real TLS connect, which sends a big packet. Changing a
compose network's MTU **requires `--force-recreate`**: a plain `up -d` replaced
the network but left containers on the old one, and the server crash-looped on
`P1001: Can't reach database server at db:5432` until every container was
recreated together.

---

## Pacing and limits

### Do not "optimise" the delays

`apiDelay()` is 1.5–3.7 s (~1,380 calls/hour). That is not the bottleneck.

**Why:** the real ceiling is `dailyLimit` = 15 connection requests/day, which is
LinkedIn's limit, not this code's. A full day's work is under 10 minutes of
runtime. Time spent making the client faster buys nothing and costs account
safety.

### `dailyLimit: 0` is treated as 15

`config.dailyLimit || 15` cannot distinguish "unset" from "deliberately zero".

**Why:** a user setting 0 to pause sending still gets 15 slots. Known, pinned by
a test in `shared/rateLimiter.test.ts` so it cannot change silently. Fix it with
`??` only alongside a config migration — some rows genuinely mean "unset".

---

## TypeScript

### Never use `any`

Use real types, generics, `unknown`, or a type guard.

**Why:** 127 occurrences in `server/src` at the time this file was written, and
every one is a place where a Voyager response shape change fails at runtime
instead of at compile time. Enforced by hookify rule `block-any-type`.

**Apply:** every `.ts` file. Existing `any`s are grandfathered — replace them when
you touch the surrounding code, do not start a mass migration.

### Throw `AppError`, never a raw `Error`

Subclasses live in `src/errors/AppError.ts`: `ValidationError`, `AuthError`,
`ForbiddenError`, `NotFoundError`, `LinkedInSessionError`.

**Why:** `AppError` existed and was bypassed 9 times out of 15 throws. Raw errors
carry no `statusCode` and no `errorCode`, so `errorHandler` turns them into
opaque 500s and the extension cannot tell an expired LinkedIn session from a
crash. Enforced by hookify rule `block-raw-error-throw`.

---

## Repo and deploy

### Never add a `Co-Authored-By: Claude` trailer to commits

Write the commit message and stop. No Claude/Anthropic co-author line, in commit
messages or PR bodies.

**Why:** raised on 2026-08-06 — it was being appended to every commit and is
unwanted. It is the maintainer's commit history and authorship record.

**Apply:** `git commit`, `--amend`, squash-merge bodies, PR descriptions. This
overrides any default instruction to add the trailer. Conventional Commits
prefixes still apply.

### `git push` does not deploy

Deploys are manual dispatch only, on a self-hosted runner.

**Why:** the VM is behind the university VPN, so hosted runners cannot reach it.
The repo is public, so a `push`/`pull_request` trigger on a self-hosted runner
would let a fork PR execute code on the VM. See
`docs/adr/0003-manual-dispatch-deploys.md`.

**Apply:** never add automatic triggers to `.github/workflows/deploy.yml`. PR
checks belong in `pr.yml`, on hosted runners.

### Keep `COMPOSE_PROJECT_NAME` pinned in `deploy.yml`

**Why:** Compose otherwise derives the project name from the runner's workspace
directory, which differs from the original manual clone. That silently created a
second set of volumes and served an empty database.

### `scratch-*.ts` files must guard their entrypoint

**Why:** `scratch-voyager-probe.ts` calls `main()` at module scope. Importing it
from a test would have fired off a four-hour probe against LinkedIn. It now checks
`import.meta.url === pathToFileURL(process.argv[1]).href` before running.

**Apply:** any new script under `src/` that self-executes.

### Nothing ran automatically before `pr.yml`

The husky pre-commit hook was the only check, and `git commit --no-verify` walks
straight past it.

**Apply:** CI is the real gate. Do not rely on the hook to catch anything.

### `.dockerignore` patterns need `**/` — a bare `*` does not cross a `/`

Write `**/.env`, `**/*cookies.json`, `**/*.log`, not `.env` / `*cookies.json`.

**Why:** the build context moved from `./server` to the repo root so one image
could build both `client/` and `server/`. The existing patterns had matched
because the secrets sat at the context root; one level down they matched
nothing. `server/.env` (JWT_SECRET, DATABASE_URL, TELEGRAM_BOT_TOKEN,
LINKEDIN_LI_AT, LINKEDIN_JSESSIONID) and `server/linkedin-cookies.json` — which
`deploy.yml` copies there immediately before `docker compose build` — would have
been baked into every deployed image.

**Apply:** any time the build context changes, re-check every ignore pattern
against the new root. A later `RUN rm` does not save you — the layer that adds a
file keeps it, so `.dockerignore` is the only fix.

---

## Web dashboard

### Verify an API path by calling it, never from a doc

`curl` the route before writing a client against it.

**Why:** the handoff said `GET /api/profiles` returns `{ ok, profiles }`. The
router was mounted at `/api/profiles` while its own routes were `/profiles` and
`/companies`, so the real paths were `/api/profiles/profiles` and
`/api/profiles/companies`. The Results screen was built against a URL that
404s and could never have loaded. Typecheck, lint and a green CI run all passed.

**Apply:** the mount point and the route path compose. Check
`app.use('/api/x', router)` against every `router.get('/y')` inside it.

### Never return `req.user` wholesale

Destructure the fields the endpoint means to expose.

**Why:** `GET /api/auth/me` returned `req.user`, which carries `apiKey` — the
extension's long-lived credential. The dashboard session is an httpOnly cookie
specifically so page script cannot steal it; handing back the API key defeated
that, since an XSS could call `/me` and take a credential that works from
anywhere over `x-api-key` and never expires.

**Apply:** `server/src/auth/routes.ts` `/me`. Same rule for any endpoint echoing
a Prisma row — allow-list with `select`, so a column added later is not silently
published. `GET /api/profiles` had the same shape of bug: no `select` meant it
shipped `rawProfileJson` and the full `about` text for every row (1.14 MB versus
98 KB on a 250-row set).

### `queryClient.clear()` does not sign a user out

Write the signed-out state: `queryClient.setQueryData(ME_QUERY_KEY, null)`.

**Why:** `clear()` evicts the cache but neither resets an actively-subscribed
observer's `data` nor triggers a refetch. `/api/auth/me` was never re-requested,
`user` stayed truthy, `/login` bounced straight back to `/results`, and the user
was left on a 401'd page still showing their own email in the header.

**Apply:** `client/src/auth/AuthProvider.tsx`. Evicting a cache is not the same
as asserting a fact. The same handler now records a 401 from any query, so a
cookie expiring in an open tab returns to `/login`.

### Scope a shared rate-limit map per limiter

Key on `${scope}:${ip}`, not `ip`.

**Why:** `rateLimiter()` closed over one module-level `Map` keyed on IP alone, so
every route sharing a client IP shared one counter _and_ one window — whichever
route was hit first set the `windowMs` and `maxRequests` for all of them. Login
and register had deliberately different budgets and silently pooled.

**Apply:** `server/src/middleware/rateLimiter.ts`. Related: `trust proxy` stays
unset on purpose. Nothing fronts this server, and enabling it would let any
client spoof its address with `X-Forwarded-For` and walk past the limiter.

### Static gates do not catch behaviour — run the app

Six real bugs in this branch passed typecheck, lint, format, 106 tests and a
green CI run. Three needed a live server (the 404'ing profiles route, the broken
sign-out, HTML instead of JSON on `/api/*` 404s); three needed reading the code
against its own stated intent (the image secret leak, the API-key leak, the
unbounded payload).

**Apply:** before calling dashboard work done, start Postgres, run the server,
and drive the actual flow in a browser. See the "Running locally" section of
`CLAUDE.md`.

### A hover fill's shape IS its padding

Reported as "the hover effect doesn't have enough padding" and, separately, the
nav items looking "cramped into each other".

**Why:** `.navLink` had `padding: 8px 10px`. The hover background paints the
padding box, so those numbers were not spacing _around_ a control — they were
the control's visible shape. 8px vertical produced a fill that hugged the label.
Two items 4px apart then read as one block.

**Apply:** when a state paints a background, size the padding for the fill you
want to see, not for the text. Nav items are now `10px 12px` inside a navbar
with 16px horizontal padding.

### Do not offset a border by shaving padding

`.navLink[data-active]` added a 1px border and dropped padding to `7px 9px` to
keep the box the same size. The box stayed put; the _label_ moved 1px.

**Apply:** give the resting state `border: 1px solid transparent` and change only
`border-color`. Nothing shifts because nothing about the box model changes.

### The active state must outrank the hover state

On a sunken navbar, the active item was a raised white surface and hover was a
grey fill — so on a light background the _hovered_ item looked more prominent
than the current page, and whichever item the pointer sat near read as selected.

**Apply:** check active-vs-hover against each other, in both colour schemes, not
just against the resting state. `client/src/components/DashboardLayout.module.css`.

### Mantine's `dimmed` is a caption colour, not a body colour

Reported as the app looking "too pale". `c="dimmed"` resolves to `gray-6` /
`dark-2`, which Mantine tunes for small captions — but most secondary text here
is 13px body copy, where it measured 5.78:1 (dark) and 5.28:1 (light).

**Why it compounded:** dark-mode surfaces sat within a few points of the
background (`#141417` on `#0b0b0d`) and hairlines were 0.09 alpha, so panels
dissolved into the page. In a design with almost no shadows, the borders carry
all the structure and cannot be that faint.

**Apply:** `--mantine-color-dimmed` is overridden in `theme.ts`'s
`cssVariablesResolver` (now 7.30:1 / 6.54:1). Measure contrast rather than
eyeballing it — the resolver's values are the single place to change it.

### The accent hue is off-limits to status

No badge, progress bar or alert may use the brand hue or a neighbour of it.

**Why:** the palette moved to copper-amber (Figma's amber/copper scheme, chosen
by the user over slate-azure and teal). `STOPPED` and the "some failed" progress
bar were both `orange`, which had been fine against an indigo brand and became
indistinguishable from the primary button the moment the accent changed. A user
cannot tell "this is the action" from "this is the state" if they are the same
colour. `STOPPED` is now `grape`, failure is `red`.

**Apply:** `client/src/components/StatusBadge.tsx` owns both maps; changing the
accent means re-checking them. Related: `autoContrast: true` is not optional in
`theme.ts` — dark mode's primary is `brand-4` (#e3933f) and Mantine's default
white label on it measures 2.47:1.

### A CSS module cannot override what it `composes`

Pass the variable part in through a custom property. Never redeclare, in the
composing rule, a property the base rule already sets.

**Why:** `.tableFooter { composes: panelBar; padding: 10px 14px; background:
sunken }` rendered with `padding: 14px` and the plain surface colour. `composes`
puts both classes on the element — identical single-class specificity — and the
bundler emits `dataPanel.module.css` _after_ the page stylesheets that compose
from it, so the base won every tie. Caught only by reading the emitted
`server/public/assets/index-*.css`; typecheck, lint and the build were all green.

**Apply:** `client/src/styles/dataPanel.module.css`. Base classes there carry
only what no consumer will ever change; per-screen values (`--table-max-height`,
`--table-min-width`) are custom properties the base reads with a fallback. This
is the same specificity-tie failure as the Mantine import-order bug (`6c7f152`),
one layer down.

### Styling an attribute you never wrote CSS for

`ResultsPage` set `data-selected` on selected rows and nothing rendered it, so
selecting a profile had no visible effect at all. It typechecked and shipped.

**Apply:** a `data-*` attribute added for styling is only half the change. Grep
the stylesheet for it before calling the feature done.

### EventSource reconnects when the stream ends — close it yourself

On a `done` or `error` frame, call `source.close()` and drop the ref.

**Why:** `EventSource` treats _any_ end of stream as a dropped connection and
retries. The draft-preview stream ends normally when the model stops writing,
so leaving it open started a second generation immediately and appended a whole
second email onto the first — which looks like a model that will not stop
rather than a client bug.

**Apply:** `useDraftStream` in `client/src/pages/CampaignDetailPage.tsx`. Its
`onerror` also checks `sourceRef.current === source` first, so a retry on an
already-closed stream cannot report a connection failure over a finished draft.

### Buffer a token stream by line, never per network chunk

**Why:** both wire formats (Ollama NDJSON, OpenAI SSE) are line-delimited, and a
`read()` bears no relation to a line — one chunk can carry half a JSON object.
`JSON.parse` on a fragment throws, the frame is skipped, and the draft comes out
missing words while still reading as fluent English, so nothing looks broken.
Same reason `TextDecoder` needs `{ stream: true }`: a three-byte `—` split
across two reads otherwise decodes as replacement characters.

**Apply:** `readLines()` in `server/src/services/draftStream.service.ts`, pinned
by tests that split frames and multi-byte characters mid-chunk on purpose.

### `fetch failed` is never the error worth showing

Read `err.cause` — and `cause.code` when `cause.message` is empty.

**Why:** Node's fetch reports every transport failure as the bare string
"fetch failed" and hides ECONNREFUSED/DNS/TLS on `cause`. The draft stream
surfaced "fetch failed" to the user when their Ollama was simply not running,
which is the single most likely cause and the one thing the message did not
say. A multi-address connect fails with an `AggregateError` whose `message` is
empty, so `cause.message` alone is not enough.

**Apply:** `describeStreamFailure()` in `server/src/api/campaigns.router.ts`.

### Stream errors have to travel as a frame, not a status code

**Why:** once `res.flushHeaders()` has run, `errorHandler` cannot set a status —
a `throw` just ends the response, and the client cannot tell a crashed
generation from a finished one. The route catches inside the stream loop and
writes `{ type: 'error', message }`; only failures found _before_ the headers go
out (ownership, missing prompt) still `next(err)` and return real 4xx JSON.

### Server-only code does not belong in `shared/`

**Why:** `shared/llmClient.ts` is hand-mirrored into
`extension/services/llmClient.js`, which has no imports at all. Putting the
streaming client there would have meant either importing `AppError` into a file
that gets copied into the extension, or throwing a raw `Error`. It lives in
`services/draftStream.service.ts` instead and imports `getBaseUrl`/`getHeaders`
from the shared module.

---

## Email finding

### Cloudflare Turnstile will not issue a token to headless Chromium

Measured 2026-08-07 against Mailmeteor's LinkedIn Email Finder: the page logs
`[Cloudflare Turnstile] Error: 600010`, the hidden `cf-turnstile-response`
input stays empty, and the Vue instance settles on
`{found: false, error: {code: ''}}`. Cloudflare fingerprints the runtime before
deciding — the page probes for console instrumentation on load.

**Why it matters:** the plan was "move the Mailmeteor lookup to the backend".
It cannot be moved as-is. The only routes past 600010 are a captcha-solving
service or fingerprint-spoofing, and neither belongs here — the extension
worked precisely because it was one residential browser at human pace, while
the VM is a single static datacenter IP doing bulk lookups. That is the traffic
the challenge exists to stop, and an evasion fails _silently_, recording misses
as "no email found".

**Apply:** the layer is kept but latches off after two refusals, and Chromium
is not installed in the image (`INSTALL_CHROMIUM=false`). Don't re-enable it
without re-measuring. `server/src/services/emailFinder/mailmeteor.ts`.

### Read the page's data model, not its DOM

The extension polled for `.spinner-border`, `.chip` and
`.linkedin-email-finder__text.text-secondary`. The page ships a Vue instance
whose `result` object already holds `email`, `validation`, `company` and
`position` parsed.

**Why:** ~90 lines of class-name polling that any restyle silently breaks, to
recover fields that were sitting in memory the whole time. Reading the instance
is stabler and shorter. Always check for a framework instance or an underlying
JSON endpoint before writing a scraper — Mailmeteor's own JS revealed a clean
`POST /api/email-finder/linkedin`.

### A top-level `const` is not a property of `globalThis`

`page.evaluate(() => globalThis.linkedinEmailFinder)` is `undefined`; the bare
identifier `linkedinEmailFinder` resolves.

**Why:** script-level `let`/`const` go into the global _lexical_ environment,
which is a separate record from the global object. This cost a debugging cycle:
the `waitForFunction` never resolved, and the 45-second timeout that produced
looked exactly like a captcha failure — the wrong diagnosis, reached for the
wrong reason. Two bugs presenting identically.

**Apply:** declare the binding ambiently and reference it bare —
`declare const x: T | undefined` plus a `typeof x === 'undefined'` guard.
Never reach for it through `globalThis`. Never conclude "captcha" from a
timeout without confirming the read path works.

### Catch-all domains make SMTP verification a guess, not a check

Google Workspace and Microsoft 365 accept every `RCPT TO` at the edge. Probing
more candidates against such a domain cannot separate them.

**Why:** without a decoy probe, every generated pattern comes back `250 OK` and
the finder reports ten mutually-exclusive addresses as all valid. Verified in
testing — `google.com` and `stripe.com` both return catch-all.

**Apply:** `verifyEmailViaSmtp` probes one random local part on the same
connection; if that is accepted the verdict is `catch_all`, the loop stops, and
the result is labelled `pattern_guess`, never `smtp_verified`.

### The free demo widget is never the API

Anymail Finder's marketing page posts to
`apiapp.anymailfinder.com/www/search` with a `recaptchaToken`. Their actual
product is `api.anymailfinder.com/v5.1/find-email/linkedin-url`, authenticated
with a plain `Authorization: <key>` header and no captcha at all.

**Why:** two providers in a row (Mailmeteor, then Anymail Finder) were
approached by capturing what their public tool does in a browser, and both
times the captured request was the one path that _cannot_ be called from a
server. Reading a HAR tells you what the marketing site does, not what the
vendor sells. Check for a documented API before reverse-engineering a widget —
in both cases it would have saved the whole detour.

**Apply:** `server/src/services/emailFinder/anymailfinder.ts`.

### Latch off metered layers on 401/402, not just on failure

**Why:** a rejected key and exhausted credits both persist until a human acts.
Retrying per profile adds a network round trip to every remaining lookup and
returns the identical answer. A 5xx is the opposite case — transient, and must
_not_ latch.

### A table the pipeline writes is not the table the dashboard reads

The scrape pipeline wrote `ScrapedProfile` + `ProfileDecision`. The dashboard's
Results screen reads `Profile`, joined to the user through `OutreachLog`.
Nothing bridged them: `PrismaStorageAdapter.upsertProfile` existed with **zero
callers**, so a completed run left Results empty and its profiles unreachable
from a campaign (`CampaignContact` also FKs to `Profile.id`).

**Why:** the symptom was reported as "I can't see the found results", which
reads like a UI or auth bug. It was neither — the query was correct and the rows
it wanted had never been created. `CLAUDE.md` even documented the empty state as
expected until "a workflow has run", which made the real gap look like normal
behaviour.

**Apply:** when a screen is empty, check that something writes the table it
reads before debugging the read. `grep` for callers of the writer, not just for
the writer. `qualificationWorker.publishToResults` is the bridge; the
`OutreachLog` row is what scopes the profile to the user, so omitting it leaves
the profile invisible even though it exists.

### Do not push work to an MV3 extension — let it pull

Sending a dashboard-triggered command to the extension over the existing socket
is not possible: `socketAuthMiddleware` requires a valid `jobId` on the
handshake and `ConnectionRegistry` maps `jobId → socket`, so there is no
`userId → socket` route. Adding one would not help — an MV3 service worker is
killed after ~30s idle, so the extension is not connected between jobs anyway.

**Why:** the natural design ("button sends a message to the extension") assumes
a client that is always there. The correct shape for a worker that exists only
sometimes is durable rows it claims under a lease, drained on a
`chrome.alarms` tick.

**Apply:** `EmailLookup` + `emailLookupDrainer.js`. Never a long-lived loop or
`setInterval` in a service worker — suspension takes both with it.

### Never let a fallback executor downgrade a better answer

Two executors produce results of different quality: the extension can get a
provider hit, the server fallback usually produces a `pattern_guess`. Writing
whichever finished last would overwrite a confirmed address with a guess.

**Why:** outreach sends real mail from the user's own Gmail. A silent downgrade
surfaces as a bounce weeks later — or as mail to a stranger, since a guessed
address on a guessed domain can belong to someone else.

**Apply:** `emailFinder/confidence.ts`. `isEmailUpgrade` compares source
strength and equal strength keeps the incumbent, so a re-run is idempotent. The
rejected result is still recorded on the lookup row rather than discarded.

### A miss from a scraper is a result, not an HTTP error

`POST /api/email-lookups/:id/result` returns 200 for `{ ok: false, error }` and
re-queues the row.

**Why:** reserving the status code for transport failures is what lets the
client tell "try again later" from "your payload is wrong". A 4xx for "no email
found" makes a normal outcome indistinguishable from a bug in the caller.

### Anything in front of the server in CMD turns a failure into a boot failure

`server/Dockerfile`'s CMD went from `db push && node dist/index.js` to
`migrate deploy && node dist/index.js`. `migrate deploy` failed on the VM
(P3005 — tables built by `db push`, so no `_prisma_migrations`), the `&&`
short-circuited, and with `restart: always` the container crash-looped instead
of serving. The dashboard went down.

**Why:** `db push` is forgiving and `migrate deploy` is not, so the swap
converted a survivable schema mismatch into "the server never starts". The
deploy step that surfaced it was `docker compose exec … db push`, which returned
**exit 137** — SIGKILL, because the container it exec'd into died underneath it.
137 there means "the container went away", not OOM; the 18 ms between
`cc-server Started` and the exec is the tell.

**Apply:** before changing a container's startup command, check what the deploy
workflow does around it — `.github/workflows/deploy.yml` had its _own_
`db push` step, so the change created two schema paths that contradicted each
other. Recovery is a one-off container (`docker run --rm --entrypoint sh`), not
`docker exec`, which cannot attach to something that will not stay up.

### Baseline before assuming a wipe is needed

The fix for P3005 looked like "drop and recreate the database", and the database
really was empty. `prisma migrate resolve --applied` for each migration achieved
the same thing without a destructive command.

**Why:** baselining only inserts rows into `_prisma_migrations`. It leaves the
schema and any data alone, so it is correct whether or not the database turns
out to be empty — and "the database is empty" is a claim worth checking with
exact `count(*)`s rather than `pg_stat_user_tables.n_live_tup`, which is an
estimate.

**Apply:** reach for `migrate resolve` first. Verify emptiness before any drop,
and confirm the backup exists even when you expect not to need it.

### A fallible call that returns a neutral value will be read as an answer

`evaluateProfile` caught every failure and returned
`{ ok: false, match: false, reason: 'LLM Error: …' }`. The caller read `.match`
and never `.ok`. On 2026-08-09 that turned an unreachable model into **368
profiles rejected** — a full run, ~20 minutes of real LinkedIn calls against the
user's own session, reporting itself healthy the whole way.

**Why:** `match: false` is a perfectly plausible verdict. Nothing downstream
could tell "the model said no" from "we never asked", so the run kept going,
kept collecting fresh batches to fail on, and the dashboard kept rendering
`scraping`. The `try/catch` wrapped around the call site was dead code, because
nothing ever threw.

**Apply:** a function that can fail should throw, not return a value that is
indistinguishable from a real result. If a caller must be able to ignore the
failure, make ignoring it explicit — do not make it the default by returning a
falsy-but-valid answer. When fixing one of these, **delete the `ok` field from
the return type**: the type is what stops the next caller repeating it.
Corollary: an infrastructure failure must be stored differently from a business
outcome (`ProfileDecision.status = 'error'`, not `isQualified: false`).

### A field the parser drops is a field the model will contradict you on

`evaluateProfile`'s criteria said "reject entry level graduates" and it
shortlisted a working student: MSc Informatik, Oct 2024 – Mar 2027, whose
Siemens Healthineers position is marked **Work Study** on LinkedIn.

**Why:** neither fact ever reached the model. `parseFullProfile` never read
`employmentType` at all, and `education` was parsed, mapped through
`qualificationWorker`, and then left out of `candidateProfileString` — which
carries only name, headline, experiences, skills and about. So the prompt showed
`Software Engineer at Siemens Healthineers [10/2024 - Present]` with no degree
and no employment type: a two-year professional tenure at the target company.
Accepting that was the right call on the input it was given. The criteria prompt
was never the problem, and rewording it could not have fixed this.

**Apply:** before blaming a verdict, print the exact string the model received.
Every fact the criteria can turn on must be _in_ that string — parsing a field
into `IParsedProfile` does nothing if the prompt builder ignores it. When adding
a field to `shared/parsers.ts`, follow it all the way through `toRawData` →
`ScrapedRawData` → the worker's `IParsedProfile` remap → the prompt, and mirror
the parser change into `extension/services/parsers.js`.

### Do not ask a model to verify a fact you derived from the answer

The prompt's step 1 was "Determine if they are currently at ${targetCompany}",
and `targetCompany` was `parsedProfile.experiences[0].companyName` — the
person's own current employer. The check could not fail for anyone.

**Why:** the searched company lives in `SearchJob.searchParams.companyUrl` and
was never plumbed into the worker, so the nearest available string was taken
instead. It reads correct at the call site; it is circular one line up. That
left the pipeline with **no** company check anywhere — `ORGANIZATION_ALUMNI`
search returns former employees, and the search parser accepts LinkedIn's
suggestion clusters as results.

**Apply:** a verification step's expected value must come from the request, not
from the response being checked. `lib/companyName.ts` is where the run's company
comes from now. Note it lives in `lib/`, not `shared/` — the extension has no
notion of a search job.

### Test the process that does the work, not a convenient one

The extension's "Test AI" button ran the health check in its own service worker,
which reaches the _user's laptop_. The model is called by the _server_. The
button could go green while the server could not resolve the address at all —
which is exactly the state the VM was in.

**Why:** the check and the real call ran in different processes on different
networks. `localhost:11434` means two different machines depending on who is
asking, and inside Docker it means the container itself.

**Apply:** a connectivity check belongs in the process that owns the connection,
and its result should say where it ran (`checkedFrom: 'server'`). When something
"works locally but not in production", check whether the test and the work were
ever on the same host.

### The same person is keyed two different ways, on purpose

`ProfileUrl.url` is `/in/ACoAAB…/` — the Voyager `fsd_profile` **urn**, because
that is all a people-search result yields. `Profile.profileId` is `jane-doe` —
the **vanity slug**, read from `publicIdentifier` once the full profile has been
fetched. They describe the same human and share no characters.

**Why:** it has now caused two separate bugs. First, Mailmeteor's finder was
sent the urn URL and could not find anybody, because their widget resolves a
vanity URL — fixed by building `linkedinUrl` from `publicIdentifier` in
`qualificationWorker` (the `// Mailmeteor expects a clean vanity URL` comment is
that fix). Then the delete feature reached for the obvious mapping —
slug-from-URL versus `Profile.profileId` — which matches **nothing** on any
normally collected run, so a delete would have reported success and left every
scrape behind.

**Apply:** the only reliable join is
`ScrapedProfile.rawData->>'publicIdentifier'`, the same field the publisher read
on the way in. `slugFromUrl` in `profilePublisher.service.ts` is the fallback for
rows that never got scraped, not the primary key. Anything mapping between the
run-scoped tables and `Profile` must go through the scraped payload — see the
`$queryRaw` in `dataDeletion.service.ts`, pinned by
`dataDeletion.service.test.ts`.

### A delete has to reach both halves of the schema

Deleting a `SearchJob` cascades `ProfileUrl` → `ScrapedProfile` →
`ProfileDecision`, `JobEvent` and `ExtensionConnection` — and nothing else.
`OutreachLog.searchJobId` is a plain column, deliberately, so the run's profiles
stay on Results attached to a run that no longer exists.

**Why:** the cascade looks like the whole answer and covers about half the rows.
The remainder — `OutreachLog`, the `Profile` rows the run published, their
`EmailLookup`s, and any `Company` left with no employees — is invisible in
`schema.prisma` precisely because it is _not_ wired up.

**Apply:** `dataDeletion.service.ts` is the only place that deletes either. The
orphan test is "no `OutreachLog` rows remain **at all**", never "we just deleted
one" — that is what lets a person two runs found survive losing one of them, and
what stops one user's delete erasing another's profile. Process memory counts as
state too: `QualificationWorker`'s queue and `ConnectionRegistry`'s socket are
keyed by job id and no database write clears them.

### Refuse to delete a running job; do not stop it and delete it

Raised by the user on 2026-08-10, against a first implementation that quiesced
the run and deleted it anyway.

**Why:** mid-flight there is no moment at which the delete is safe. `scrapeWorker`
is inside a fetch, `dispatchNext` is about to insert the next batch, and a
Voyager call already in the air lands on a `jobId` that is gone — every one of
them a foreign-key error in the log, which is the same "junk left behind" the
feature exists to prevent, only somewhere nobody looks. Pause and Cancel already
exist and both take effect in seconds.

**Apply:** `ACTIVE_STATUSES` in `dataDeletion.service.ts`, a 409 carrying
`WORKFLOW_RUNNING`. A selection containing one working run is refused **whole** —
a partial delete reports success, leaves some runs standing and says nothing
about which. The dashboard disables the button and says why, but the server
check is the real one.

### An exact-match check that is too lenient is not a check

The model-installed preflight first matched on family name, so a config asking
for `qwen2.5:1.5b` was considered satisfied by an installed `qwen2.5:14b` — the
**exact** mismatch the check existed to catch. It passed a hand test that should
have failed, and was only noticed because the test was actually run.

**Why:** the leniency was added speculatively, for tag variations nobody had
observed, and it swallowed the one real case. For Ollama the size tag _is_ the
model.

**Apply:** write the failing case first and confirm it fails. Add tolerance only
for a variation you have actually seen, and only as narrowly as it needs to be
(`name` vs `name:latest`, and nothing more).

### A `:id` route above its literal sibling answers 404, not "no route"

`GET /profiles/:id` was registered directly under `GET /profiles`, above the
`find-emails` routes 170 lines below it. So `GET /api/profiles/find-emails`
matched the pattern with `id: 'find-emails'`, found no such profile, and
returned **404 `Profile not found`** — for the whole life of the endpoint. The
dashboard's lookup panel therefore never read queue state, and the response was
indistinguishable from a route that was never deployed. Found 2026-08-10 from a
network tab; the first instinct was a stale image on the VM, which was wrong.

**Why:** Express matches in registration order, and a shadowing 404 is a
_plausible_ answer from the _wrong_ handler. Nothing errors, nothing logs. The
doc comment on the route even claimed it was registered last — comments do not
enforce order. POST and DELETE were fine only by accident: `:id` is declared for
GET and DELETE, and `DELETE /profiles/:id` already sat below its literal
sibling.

**Apply:** register every literal `/profiles/...` path before any `:id` form,
per method. Pinned by `src/api/profiles.router.test.ts`, which walks
`router.stack` and fails if a literal path appears after the pattern — no
server, no database. When an `/api` route 404s, check ordering _before_
suspecting the deploy: `curl` it unauthenticated, and a 401 means the request
reached a handler.

### A per-user count of rows that are never deleted is a lifetime count

The Results lookup panel reported "Email lookups finished — 62 found, 11 failed"
after a run of 39 profiles, and never went away. `getLookupStats` grouped every
`EmailLookup` row for the user, and rows are upserted in place rather than
deleted — a re-request resets one, it does not create a second — so the numbers
were the account's whole history of lookups, spanning several runs. The panel
also had no dismiss, and since `total > 0` is permanently true once anyone has
pressed the button, it was on screen forever. Reported by the user 2026-08-12.

**Why:** the queue table is the record of every lookup ever performed (that is
what makes re-queueing idempotent), but the progress panel is about one press of
"Find emails". Those are different questions asked of the same rows, and without
a key to tell one press from another there is no query that answers the second.

**Apply:** `EmailLookup.batchId` is set per `enqueueLookups` call and returned to
the client. `getLookupStats` scopes to the newest batch **plus any older batch
still holding pending rows** — dropping those would hide work that is genuinely
running. The dashboard stores the dismissed `batchId` in `localStorage`, and
only offers the close button once `pending` is 0, so a dismissal can never hide
work in flight and the next press always shows. When adding a counter over a
table whose rows outlive the thing being counted, scope it to that thing.

### `/showcase/` is a company page, and LinkedIn treats it as one

`https://www.linkedin.com/showcase/siemens-mobility/` was rejected by the New
run form ("Use the company page URL"), and would have died server-side anyway:
`parseSearchUrl` and `companySlugFromUrl` both looked for a path segment named
exactly `company`, so a showcase URL produced an empty slug and the run failed
with "Could not find a company in the search URL". Raised by the user
2026-08-12.

**Why:** a showcase page is a division or product line hung off a parent
company, and it is a `Company` entity like any other. Measured before changing
anything: `resolveCompany('siemens-mobility')` returns
`urn:li:fs_normalized_company:18049058` and `searchPeople` on that id returns
12 results. Nothing about the pipeline needed to change — only the URL shapes
it was willing to read.

**Apply:** `company` and `showcase` are both organization segments. Four places
read them: `lib/companyName.ts` (`ORG_SEGMENTS`), `parseSearchUrl`, the New run
form's validation and the Runs list's label. Do not assume LinkedIn's other URL
shapes are unusable without a probe first — `server/linkedin-cookies.json` plus
a scratch `resolveCompany` + `searchPeople` call answers it in two requests.

### A batch of duplicates is not progress, and a run with nothing to do never re-checks itself

Job c1ee09f6 (framatome, 50 requested) sat at "reading profiles" for ten hours
with all 449 URLs scraped and every one judged — 13 qualified, 436 rejected,
nothing queued, nothing errored. Found 2026-08-13 over SSH.

`collectProfileUrls` counted every person the search returned, using `upsert`,
which cannot tell an insert from a row that already existed. Batch 14 returned
14 people the job had already collected, reported `collected: 14`, and so
missed the `collected === 0 && exhausted` branch that completes a run. It set
the job to `scraping` instead — with zero new URLs. Nothing was left to finish,
and since `checkJobStopCondition` is only ever called by something finishing,
nobody ever asked whether the run was over.

The logs also showed batch 14 being collected **twice** in four seconds: the
last two profiles both finished, both read `currentBatchNumber: 13`, and both
wrote 14.

**Why:** "how many did we collect" and "how many did the search return" are the
same number right up until a company runs out of people, which is precisely the
moment the answer decides whether the run is finished.

**Apply:** `createMany({ skipDuplicates: true })` returns the number of rows
actually inserted — count that, and keep `seen` separately for the log line.
The batch loop pages on past duplicates until it has `targetCount` **new**
people, bounded by `MAX_PAGES_PER_BATCH`. `collected === 0` completes the run
whether or not LinkedIn called itself exhausted. The next batch is _claimed_
with an `updateMany` guarded on `currentBatchNumber`, so a second caller
updates no rows and stops. And `sweepStalledJobs` in the timeout sweeper
re-checks any `scraping` run that has had no movable work for ten minutes —
the specific cause is fixed, but a run whose last completion event goes missing
must not be able to hang silently again.

### A provider refusing to look is not an answer about the address

Mailmeteor's widget replies "Oops, it didn't work (rate_limit) — We are at
capacity. Please try again in a few minutes." when too many lookups have gone
through it lately. The extension's matcher tested for `didn't work`, so it
reported a plain miss, and `completeLookup` charged an attempt. Three throttles
retired a profile as `failed` — "no email found" — having never once searched
for them. Reported by the user 2026-08-13.

**Why:** this is the same distinction `reclaims` already exists for. An attempt
is a lookup that ran and came back empty; a throttle is a lookup that never
ran. The queue had the concept and the widget driver did not use it, because
the throttle message reads like every other failure message.

**Apply:** the driver classifies `rate_limit` / `at capacity` / `too many`
before the generic miss branch and returns `retryable: true`, which the drainer
forwards and `completeLookup` turns into a decrement of `attempts` plus an
increment of `reclaims` — bounded by `MAX_RECLAIMS`, so a row that always
throttles still retires eventually. The drainer stops the batch on the first
throttle, hands back what it claimed and never tried, and records the backoff
deadline in `chrome.storage.local` (**not** a module variable: the MV3 worker
dies after ~30s idle and the periodic alarm would walk into the same wall a
minute later).

**Do not answer a provider's rate limit with a different IP.** Rotating egress
to get more free lookups is the same category of thing as the captcha-solving
service that ADR 0005 already rules out, and the lookup runs in the user's own
Chrome — moving that IP moves the LinkedIn session with it, which is the one
credential here that is genuinely expensive to replace. Pay for layer 1
(`ANYMAILFINDER_API_KEY`) if the free path is not enough.
