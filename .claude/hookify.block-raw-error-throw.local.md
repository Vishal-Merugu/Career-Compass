---
name: block-raw-error-throw
enabled: true
event: file
action: block
conditions:
  - field: file_path
    operator: regex_match
    pattern: ^server/src/.*\.ts$
  - field: file_path
    operator: not_contains
    pattern: .test.
  - field: new_text
    operator: regex_match
    pattern: 'throw\s+new\s+Error\s*\('
---

**Raw `throw new Error()` is not allowed in server code.**

Throw an `AppError` subclass from `server/src/errors/AppError.ts`:

| Situation                  | Class                  |
| -------------------------- | ---------------------- |
| Bad input / failed Zod     | `ValidationError`      |
| Not authenticated          | `AuthError`            |
| Authenticated, not allowed | `ForbiddenError`       |
| Missing record             | `NotFoundError`        |
| LinkedIn cookies dead      | `LinkedInSessionError` |

A raw `Error` carries no `statusCode` and no `errorCode`, so `errorHandler`
turns it into an opaque 500 and the extension cannot tell an expired LinkedIn
session from a crash.
