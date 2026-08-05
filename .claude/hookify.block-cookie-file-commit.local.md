---
name: block-cookie-file-commit
enabled: true
event: bash
action: block
conditions:
  - field: command
    operator: regex_match
    pattern: 'git\s+(add|commit|stash\s+push)\b'
  - field: command
    operator: regex_match
    pattern: 'cookies\.json|probe-report\.json|\.env\b'
---

**Never stage `linkedin-cookies.json`, `probe-report.json`, or a `.env` file.**

- `linkedin-cookies.json` is a **live LinkedIn session** — committing it to a
  public repo hands over the account.
- `probe-report.json` records the egress IP and ASN of the machine that ran the
  probe.
- `.env` holds `JWT_SECRET`, `DATABASE_URL` and the Telegram bot token.

All three are gitignored already; naming one explicitly on a `git add` is how
that gets defeated. On the VM these live in `~/cc-config/` and are copied in at
deploy time — that is the only place they belong.

If you are certain (e.g. adding a pattern to `.gitignore`), run the command
yourself outside the agent.
