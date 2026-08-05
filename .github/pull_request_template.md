# Summary

<!-- What changed and why. One paragraph. Screenshots for UI changes. -->

## Blast radius

<!-- Tick anything this touches. These need a careful read even on a small diff. -->

- [ ] LinkedIn cookies / Voyager requests / session handling
- [ ] Rate limits or pacing (`apiDelay`, `connectionDelay`, `dailyLimit`)
- [ ] WebSocket protocol (`ws-gateway/events.ts` + extension counterpart)
- [ ] Prisma schema / migrations
- [ ] Deploy config (`deploy.yml`, `docker-compose.yml`, `Dockerfile`)
- [ ] None of the above

## Checklist

- [ ] PR title uses a Conventional Commits prefix (`feat:`, `fix:`, `refactor:`,
      `chore:`, `docs:`, `test:`, `perf:`)
- [ ] `npm run typecheck`, `npm run lint`, `npm run format:check` and `npm test`
      all pass locally
- [ ] New or changed pure-function behaviour has a `*.test.ts` alongside the source
- [ ] No secrets in the diff — no `linkedin-cookies.json`, no `probe-report.json`,
      no `.env`, no literal `li_at` (`AQEDA…`) or `JSESSIONID` (`ajax:…`) value
- [ ] No new `any`, no new raw `throw new Error(` in `server/src/`
- [ ] `deploy.yml` still has **only** a `workflow_dispatch` trigger, and still pins
      `COMPOSE_PROJECT_NAME`
- [ ] If `server/src/shared/*` changed, the mirrored `extension/services/*` copy was
      updated too
- [ ] If a non-obvious decision was made, it is recorded in `docs/adr/` — and if a
      correction was received, it is in `tasks/lessons.md`

## Deploying

Merging does **not** deploy. Deploy is a manual dispatch of "Deploy to VM" from the
Actions tab.
