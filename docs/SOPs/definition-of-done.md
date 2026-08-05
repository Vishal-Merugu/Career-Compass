# Definition of Done

A change is done when **all** of the following are true. Not "mostly" — a partial
pass is not done.

## 1. It works, and you saw it work

- The gates pass locally: `npm run typecheck`, `npm run lint`,
  `npm run format:check`, `npm test`, `npm --prefix server run build`.
- You ran the actual code path, or you can say precisely why you could not.
  "It compiles" is not evidence.
- Anything touching LinkedIn was verified against the probe
  (`npm run probe:linkedin -- --quick`), not against a mock, before being trusted.

## 2. It is tested

- New or changed behaviour in a **pure function** has a test alongside the source
  as `*.test.ts`. This covers `server/src/shared/*`, the probe's `CookieJar` and
  `classifyFatal`, parsers, and URL builders.
- The test would **fail** if the change were reverted. A test that passes either
  way is not a test.
- Behaviour you are deliberately leaving broken is pinned by a test that says so
  in a comment, so it cannot change silently.
- Anything requiring a live LinkedIn session belongs in the probe, not in the
  suite. The suite must never touch the network, the database, or the clock.

## 3. It is safe to publish

The repo is public and automates a real account.

- No `linkedin-cookies.json`, `probe-report.json`, or `.env` in the diff.
- No literal `li_at` (`AQEDA…`) or `JSESSIONID` (`ajax:…`) value anywhere,
  including tests and fixtures.
- `deploy.yml` still has **only** a `workflow_dispatch` trigger.
- No new `any`, no new raw `throw new Error(` in `server/src/`.

## 4. Both copies moved

`server/src/shared/*` is mirrored by hand in `extension/services/*`. If you changed
one, either change the other or state explicitly why the divergence is correct.

A new WebSocket message means three edits: `ws-gateway/events.ts`, a `commands/` or
`handlers/` file, and `extension/scripts/background.js`.

## 5. The knowledge survives the session

- A non-obvious decision → `docs/adr/`.
- A correction you received → `tasks/lessons.md`, with the incident that caused it.
- A rule a future session must follow → `CLAUDE.md`.

If you learned something the hard way and wrote it nowhere, the work is not done —
the next session will pay for it again.

## 6. It is reviewable

- Conventional Commits prefix on the commit and the PR title.
- `.github/pull_request_template.md` filled in, including the blast-radius boxes.
- PR CI green.

## Not part of done

**Deploying.** Merging does not deploy, and deploying is a separate, deliberate act:
Actions tab → "Deploy to VM" → Run workflow. Decide to deploy; don't drift into it.
