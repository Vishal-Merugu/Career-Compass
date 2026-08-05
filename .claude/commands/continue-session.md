---
description: 'Hand off to a fresh session before context runs out. Usage: /continue-session'
---

## Context-exhaustion handoff

Write `tasks/handoff.md` (gitignored, overwrite freely) so a fresh session can
resume without re-deriving anything.

### Capture

```markdown
# Handoff — <ISO date>

## Task

What was being built, in one paragraph. Include the original request verbatim if
it was specific.

## State

- Branch, and whether it is pushed
- `git status --short` output
- Which quality gates currently pass (lint / format / typecheck / test / build)

## Done

Bullet list of completed steps, each with the files touched.

## Next

The immediate next action, concretely. Not "continue the refactor" but "add the
`bcookie` field to `IVoyagerSession` in `server/src/shared/voyagerClient.ts:7`".

## Decisions made

Anything chosen along the way that is not obvious from the code, and why. If it
is architectural, it belongs in `docs/adr/` instead — say so.

## Traps hit

Anything that cost time. If it is a repeatable correction, also append it to
`tasks/lessons.md` now — that file is versioned and survives the handoff.

## Do not

Dead ends already ruled out, so the next session does not retry them.
```

### Then

Tell the user the handoff is written and what the first command of the next
session should be. Do not start new work.
