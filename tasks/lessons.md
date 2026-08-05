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
