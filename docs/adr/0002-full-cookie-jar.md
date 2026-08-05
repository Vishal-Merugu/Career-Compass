# 0002 — A live cookie jar, not two static cookies

Date: 2026-08-05
Status: Accepted

## Context

`server/src/shared/voyagerClient.ts` builds its Cookie header by hand:

```ts
headers['cookie'] = `li_at=${this.liAtCookie}; JSESSIONID="${this.csrfToken}"`;
```

and freezes `csrfToken` in the constructor. Every server-side session built this
way eventually failed, usually with 403s that read as bot detection.

Three separate defects were hiding behind that diagnosis.

**1. Two cookies are not a session.** LinkedIn's risk engine expects the cookies a
browser would have: `li_at` (auth), `JSESSIONID` (session + CSRF), `bcookie` and
`bscookie` (browser identity), `lidc` (datacentre routing), `li_rm` (remember-me).
An auth token arriving with none of the browser-identity cookies looks exactly like
a cookie someone stole and replayed elsewhere.

**2. `JSESSIONID` rotates, and it _is_ the CSRF token.** The `csrf-token` header must
equal the current `JSESSIONID` value. LinkedIn rotates it — along with `lidc` —
via `Set-Cookie` during normal use. A client that snapshots it at construction and
never reads `Set-Cookie` back sends a stale token from the first rotation onward.
Those were the "token expired" 403s.

**3. Session death is signalled by cookie expiry, not by a redirect to a login
page.** When LinkedIn kills a session it self-redirects to the _same_ URL and sends:

```
set-cookie: li_at=delete me; Expires=Thu, 01-Jan-1970 00:00:10 GMT; Max-Age=0
```

Two traps here. Following redirects turns this into a 200 with an HTML body, hiding
the kill. And parsing `delete me` as a new value writes the literal string
`"delete me"` into the jar — corrupting the saved export so that even a
subsequently-valid session file is unusable, forcing a manual re-extraction.

## Decision

Session handling is a **stateful cookie jar** that absorbs `Set-Cookie` on every
response. Implemented as `CookieJar` in `server/src/scratch-voyager-probe.ts`:

- The jar holds the **whole** exported cookie set and serialises all of it.
- `csrf()` derives the CSRF token from the jar's **current** `JSESSIONID`, read live
  per request, quotes stripped.
- `absorb()` detects expiry **by attribute** — `Max-Age <= 0`, or an `Expires` in the
  past — and _deletes_ the cookie. Values are never inspected to infer expiry.
  Empty and `""` values are ignored rather than stored.
- Requests use `redirect: 'manual'`. `classifyFatal()` treats any 3xx as fatal,
  because Voyager never legitimately redirects, and treats a 200 with a body
  starting `<` as an auth wall.
- Auth-cookie expiry (`li_at`, `liap`, `li_a`) is checked **before** the status code,
  since it arrives riding on a 302.
- The jar is **never persisted after a fatal response**, so a dead session cannot
  overwrite a good export.
- `__cf_bm` is Cloudflare's, bound to the issuing IP with a ~30 minute TTL. Strip it
  when moving a jar between machines; Cloudflare mints a fresh one.

These rules are pinned by `server/src/scratch-voyager-probe.test.ts`.

## Consequences

- Server-side Voyager is **viable**, which was not previously known. The 2026-08-05
  probe: Mac (residential, `AS8881 1&1 Versatel`) 6/6 clean 200s; VM
  (`nat-gw.rz.rrze.net`, `AS680 DFN`) a `--long` run of 14 calls over ~3.5 h, clean
  across burst and spaced phases, surviving a 44-minute cold gap at call 11.
  Node/undici's TLS fingerprint is **not** blocked by LinkedIn, so a headless browser
  is not required.
- **Still outstanding:** the day-2 test — rerun `--quick` on the VM against the
  _evolved_ cookie file without re-exporting. That decides whether a few-hours-daily
  bot can run without re-exporting cookies every morning.
- **`server/src/shared/voyagerClient.ts` still has the old two-cookie design.** It is
  not on the live path (see ADR 0001), so it has not been migrated. Its current
  behaviour is pinned by a test in `voyagerClient.test.ts` that says so explicitly.
  It must adopt `CookieJar` before any server-side execution path ships.
- The cookie jar lives in a `scratch-*` file, which is where it was written. It is
  now imported by tests, so the file guards its entrypoint with an `import.meta.url`
  check. Promote it to `shared/` when the server-side path is built.

## Alternatives considered

- **Keep two cookies and add a proxy.** Rejected — the probe shows the network was
  never the problem on these egress points, and it would not have fixed the stale
  CSRF token or the corrupted export.
- **Re-export cookies before every run.** Works, but makes unattended operation
  impossible, which is the point of the project.
- **Detect expiry by matching known kill values** (`delete me`, empty string).
  Rejected: it is a blocklist against a string LinkedIn can change at will, and it is
  precisely the bug that corrupted the jar. The attribute is the contract.
