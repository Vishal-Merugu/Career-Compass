---
name: block-hardcoded-linkedin-cookies
enabled: true
event: file
action: block
conditions:
  - field: file_path
    operator: regex_match
    pattern: \.(ts|tsx|js|mjs|json|ya?ml)$
  - field: file_path
    operator: not_contains
    pattern: cookies.json
  - field: new_text
    operator: regex_match
    pattern: 'AQEDA[A-Za-z0-9_-]{20,}|ajax:\d{10,}'
---

**A real `li_at` or `JSESSIONID` value must never appear in source.**

`li_at` tokens start with `AQEDA…`; `JSESSIONID` looks like `"ajax:1234567890"`.
Both are live credentials for the LinkedIn account, and this repo is public.

Load them from `linkedin-cookies.json` (gitignored) via the `CookieJar`, or from
the environment. For tests and fixtures use obvious fakes — `AQEDA-token`,
`"ajax:1"` — not a value copied out of a browser.
