---
name: block-any-type
enabled: true
event: file
action: block
conditions:
  - field: file_path
    operator: regex_match
    pattern: \.tsx?$
  - field: file_path
    operator: not_contains
    pattern: .test.
  - field: new_text
    operator: regex_match
    pattern: ':\s*any\b|<any[>,\s]|\bas\s+any\b'
---

**`any` is forbidden.** Use real types, generics, `unknown`, or a type guard.

Voyager responses are the usual excuse. Model the fields you actually read as an
interface and narrow — an `any` here means a LinkedIn response-shape change
fails at runtime instead of at compile time.

Existing `any`s in `server/src` are grandfathered; replace them when you touch
the surrounding code. Do not add new ones. See CLAUDE.md → Strict prohibitions.
