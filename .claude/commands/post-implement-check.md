---
description: 'Run every quality gate before declaring work done. Usage: /post-implement-check'
---

## Post-implementation check

Run from the repo root (`CareerCompass/`). Do not say "done" until all of this is
clean.

### 1. Lint

```bash
npm run lint
```

Fix with `npm run lint:fix`. Report remaining errors as `file:line`.

### 2. Format

```bash
npm run format:check
```

Fix with `npm run format`.

### 3. Typecheck

```bash
npm run typecheck
```

This covers `src/**` **and** the `*.test.ts` files (via `server/tsconfig.test.json`).

### 4. Tests

```bash
npm test
```

If you changed a pure function in `server/src/shared/` or the probe's
`CookieJar` / `classifyFatal`, there must be a test for the new behaviour. Add one
if it is missing — that is not optional.

### 5. Build

```bash
npm --prefix server run build
```

Confirm nothing matching `*.test.*` landed in `server/dist/`.

### 6. Repo hygiene

```bash
git status --short
```

Check that none of these are staged or untracked-and-about-to-be-added:

- `server/linkedin-cookies.json` — a live LinkedIn session
- `server/probe-report.json` — contains the egress IP
- any `.env*`

### 7. Prohibitions

Grep the diff (`git diff`), not the whole repo:

- no new `: any` / `<any>` / `as any`
- no new `throw new Error(` in `server/src/`
- no `push:` or `pull_request:` trigger added to `.github/workflows/deploy.yml`
- no literal `li_at` (`AQEDA…`) or `JSESSIONID` (`ajax:…`) value in source

### 8. Report

State pass/fail per gate. If anything failed, fix and re-run from step 1 rather
than reporting a partial pass.
