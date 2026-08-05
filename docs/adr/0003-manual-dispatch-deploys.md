# 0003 — Manual-dispatch deploys via a self-hosted runner

Date: 2026-08-05
Status: Accepted

## Context

The application runs on a university VM (`172.17.64.118`, user `ubuntu`) reachable
only from inside the university VPN. GitHub's hosted runners have no route to it —
no inbound path exists, and none is going to be opened.

Before this, deployment was a `deploy.sh` script run by hand over SSH, which meant
connecting to the VPN first and doing it from a laptop.

The repo is **public**. That constrains the solution: a self-hosted runner executes
workflow code on the VM itself, so any trigger that a third party can fire is a
remote-code-execution path onto the deployment host. `pull_request` from a fork is
exactly such a trigger.

## Decision

A **self-hosted GitHub Actions runner** (`llm-for-extension`) on the VM, driving
`.github/workflows/deploy.yml`, triggered by **`workflow_dispatch` only**.

The runner dials out to GitHub, so no inbound route to the VM is needed. Deploying
does not require the VPN — only SSH to the box does.

Specifics that must not be changed casually:

- **`workflow_dispatch` is the only trigger.** No `push`, no `pull_request`, no
  `schedule`. While the repo is public this is a security boundary, not a
  preference. PR checks live in `pr.yml`, which runs on **hosted** runners.
- **`COMPOSE_PROJECT_NAME: careercompass` is pinned.** Compose otherwise derives the
  project name from the working directory. The runner's workspace is
  `Career-Compass`, while the original manual clone was `CareerCompass` — without
  the pin, Compose created a _second_ set of volumes and served an empty database.
- **Gitignored runtime files live in `~/cc-config/` on the VM** (`.env`,
  `linkedin-cookies.json`) and are copied into the workspace on each deploy. The
  workflow fails loudly if `~/cc-config/.env` is missing.
- **`prisma db push` is skippable** via the `skip_db_push` input, because
  `--accept-data-loss` can drop columns and most deploys are code-only.
- `concurrency: vm-deploy` with `cancel-in-progress: false` — a half-finished deploy
  must not be interrupted by the next one.

## Consequences

- **`git push` does not deploy anything.** Deploying is an explicit act: Actions tab
  → "Deploy to VM" → Run workflow → choose the branch. This is intentional; it also
  means you can deploy a branch without merging it.
- Deploys are reproducible and logged, and no longer require a laptop on the VPN.
- The VM is a single point of failure and there is no staging environment. Accepted
  for a single-user project.
- `~/CareerCompass` and the root `deploy.sh` on the VM are now vestigial. Left in
  place rather than deleted, to avoid breaking anything that still refers to them.
- If the repo is ever made **private**, a `push`-to-`main` trigger becomes defensible.
  Revisit this ADR at that point — do not just add the trigger.

## Alternatives considered

- **Hosted runner + SSH into the VM.** Impossible: no inbound route through the VPN.
- **`push` trigger on the self-hosted runner.** Rejected while public — fork PRs
  would execute on the VM.
- **Keeping `deploy.sh` over SSH.** Works, but needs the VPN, a specific laptop, and
  leaves no audit trail.
- **Docker registry + pull on the VM.** More moving parts (a registry, credentials)
  for a single-host deployment that builds in a couple of minutes.
