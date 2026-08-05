---
description: 'Open a pull request for the current branch. Usage: /create-pr'
---

## Create a PR

### 1. Preconditions

- Run `/post-implement-check` first. Do not open a PR over failing gates.
- Never commit directly to `main` — branch first if you are on it.
- Confirm no secrets are staged: `git status --short` must not show
  `linkedin-cookies.json`, `probe-report.json`, or any `.env`.

### 2. Branch and commit

Conventional Commits, matching the existing history:

```
feat: add server-side connection scheduling
fix: read JSESSIONID live instead of caching it
refactor: extract cookie jar from the probe
chore: bump prisma
docs: add ADR for manual-dispatch deploys
test: cover CookieJar expiry detection
```

### 3. PR body

Fill in `.github/pull_request_template.md`. Be concrete about:

- What changed and why
- Whether it touches **cookie handling, rate limits, or deploy config** — these
  need a reviewer's eyes even on a small diff
- How it was verified (which gates, which tests)

### 4. Open it

```bash
gh pr create --base main --title "<conventional title>" --body "<body>"
```

### 5. After opening

Report the URL. Note that `pr.yml` runs on hosted runners and gates the merge;
**merging does not deploy.** Deploying is a separate manual dispatch of
"Deploy to VM" from the Actions tab.
