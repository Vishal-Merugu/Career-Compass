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

**Two runs from different places are not comparable.** The laptop leaves via a
consumer ISP (AS8881); the VM leaves via the university NAT gateway (AS680 DFN),
which is _not_ a datacenter ASN. So the clean `--long` result says nothing about
whether a cloud-hosted worker would survive — that is a different IP reputation
and still untested. Run `--egress-only` in both places and compare the ASN.

Deliberately no IPs here: this file is versioned and the repo is public, which
is the same reason `probe-report.json` is gitignored.

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
