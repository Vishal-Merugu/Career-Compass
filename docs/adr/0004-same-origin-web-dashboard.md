# 0004 — A web dashboard, served same-origin from the VM

Date: 2026-08-06
Status: Accepted

## Context

The Chrome extension carries the entire user interface. Measured at the time of
writing:

```
UI      (popup.js 1075, popup.html 458, popup.css 575)   2,108 lines  (37%)
exec    (background, voyagerClient, parsers, workflows)   2,365 lines
movable (llmClient, emailFinder, csvExporter)               940 lines
                                                         ─────────────
                                                          5,662 lines
```

`extension/popup/tabs/{massConnector,peopleFinder,results,settings}.js` and
`extension/popup/components/{activityFeed,progressBar}.js` all exist and are all
**zero bytes**. A modular popup was planned, abandoned, and the whole thing ended
up in a single 1,075-line `popup.js`. Those six filenames are, in effect, the
screen list for a dashboard that was never built.

This contradicts [ADR 0001](0001-extension-executes-server-orchestrates.md).
That decision says _server orchestrates, extension executes_ — but the UI, which
orchestrates nothing, lives in the executor.

Three concrete costs:

1. **Popup state dies on close.** Chrome tears the popup down every time it loses
   focus. Any in-progress view state goes with it.
2. **MV3 kills the service worker after ~30 s idle.** `onHeartbeat`,
   `syncAndResume` and `timeoutSweeper` exist partly to survive this. Every extra
   responsibility in the extension is more to reconstruct.
3. **The Telegram bot is a substitute for a dashboard.** Job control and lifecycle
   notifications went to Telegram because there was no other persistent surface.

The server is already the right home. It exposes ~24 REST endpoints (jobs,
profiles, companies, config, daily-stats, activity-log, outreach-log,
workflow-history) behind `requireAuthOrApiKey`. A dashboard is largely a client
for endpoints that already exist and are already in use.

The constraint that shapes everything: `PUBLIC_API_URL` is
`http://172.17.64.118` — a **private IP over plain HTTP**, reachable only from the
university network. The extension gets away with this because it runs on the
user's machine, on that network, with blanket `http://*/*` host permission. A
browser page cannot: a publicly hosted page cannot route to `172.17.64.118`, and
an `https://` page calling `http://` is blocked as mixed content.

## Decision

Build a **single-page web dashboard, served same-origin by the existing Express
server**, reachable only from the university network.

- **Stack:** Vite + React + TypeScript, Mantine for UI, React Router for routing,
  TanStack Query for server state.
- **Location:** source at `client/`, build output at `server/public/`
  (gitignored), served by `express.static` with an SPA fallback registered
  _after_ the API routers.
- **Auth:** the browser session uses a **httpOnly cookie**. `requireAuth` gains a
  cookie branch in addition to `Authorization: Bearer`. The extension is
  untouched and keeps using `x-api-key`.
- **Docker:** a multi-stage build compiles the web app and copies only `public/`
  into the runtime image. The build context moves from `./server` to the repo
  root (`context: .` + `dockerfile: server/Dockerfile`) so both `client/` and
  `server/` are reachable from one build. `deploy.yml` is unaffected — it runs
  `docker compose`, which reads the context from the compose file.
- **Scope split:** the extension keeps only what needs a live browser session —
  the `cookies` permission, `voyagerClient`, `parsers`, the workflow runners,
  `rateLimiter`/`resilience` and `background.js`. Its popup shrinks to a status
  and connection panel. `llmClient`, `emailFinder` and `csvExporter` move to the
  server, where equivalents already exist in `server/src/shared/`.

## Consequences

- **The dashboard is VPN-only.** Accepted: the system cannot do any work without
  the user's browser open and logged into LinkedIn on that same machine anyway.
  Remote access would provide a view that cannot act.
- **A live-LinkedIn-cookie system stays off the public internet.** With the source
  public, every endpoint is known; not being reachable is doing real security work.
- **No CORS and no mixed content, ever.** Same origin means the client calls
  `/api/...` as a relative path. That entire class of problem does not arise.
- **Two UIs to maintain** until the extension popup is reduced. This is temporary
  but real, and the reduction should follow promptly rather than being deferred.
- **The Dockerfile grows a build stage.** Image build takes longer. Multi-stage
  keeps the runtime image from carrying the frontend toolchain.
- **The duplication cost named in ADR 0001 shrinks.** Moving `llmClient`,
  `emailFinder` and `csvExporter` to the server removes three of the hand-mirrored
  pairs between `server/src/shared/*` and `extension/services/*`.
- Extension drops from ~5,662 to roughly ~2,400 lines, and `host_permissions` can
  plausibly narrow from `http://*/*` + `https://*/*` to `https://www.linkedin.com/*`,
  which materially eases any future Chrome Web Store review.

## Alternatives considered

- **Source at `server/web/` instead of a root `client/`.** This is what the ADR
  originally specified, on the grounds that the Docker build context was
  `./server` and a root-level app would force changes to `docker-compose.yml`
  and the Dockerfile. Reversed during implementation: that was a convenience
  argument, not a design one, and it bought it by making `server/` mean "the
  deployable" in one breath and "the backend" in the next. The actual cost of
  the move was a build context change, path prefixes in the Dockerfile, and a
  root `.dockerignore` — which the root context needed anyway, or `node_modules/`
  and `extension/` would be uploaded on every build. Top-level `client/`,
  `server/`, `extension/` now say what each thing is.
- **Public hosting via Cloudflare Tunnel.** Rejected _for now_, not on principle.
  It works — dials out, so no inbound route is needed, exactly the trick the
  self-hosted runner already uses — but it needs a domain, and it puts a system
  that controls a real LinkedIn account on the public internet in exchange for a
  read-only view. **Revisit if:** the university VPN goes away, or acting on the
  system from a phone becomes genuinely useful. The change is additive — a tunnel
  in front of the same server, with same-origin still intact.
- **Next.js.** Rejected: an Express server already exists. Next brings its own,
  leaving pages in one and the API in another, which fights the same-origin
  decision that removes the CORS and mixed-content problems.
- **Keeping the UI in the extension and just refactoring `popup.js`.** Rejected: it
  fixes the file size but none of the three costs above. The popup would still be
  destroyed on close.
- **shadcn/ui + Tailwind instead of Mantine.** Rejected for this app: the screens
  are forms-and-feedback heavy (`IUserConfig` alone is 11 fields), and Mantine
  ships forms, notifications and modals finished. shadcn would mean assembling
  those. Reasonable to revisit if a bespoke visual identity is ever wanted.
- **JWT in `localStorage` instead of a httpOnly cookie.** Rejected: same-origin
  makes the cookie nearly free (`SameSite=Lax` covers CSRF), and it removes token
  theft via XSS as a category. The app renders LinkedIn-sourced strings and can
  control a real account; ~20 lines of server change is a good trade. Migrating
  later would be more expensive than doing it now.
- **No auth at all, relying on the VPN.** Rejected: the server already has auth and
  the schema is multi-tenant (`userId` scoping on every query). Removing it would
  be a regression, not a simplification.
