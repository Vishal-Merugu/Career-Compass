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
implementation is `CookieJar` in `src/scratch-voyager-probe.ts`.

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

**Apply:** guard the write — `if (!result.fatal) jar.persist(...)`.

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
