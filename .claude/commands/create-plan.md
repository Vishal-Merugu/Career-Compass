---
description: 'Research the codebase and write an implementation plan before writing code. Usage: /create-plan <what to build>'
---

## Create an implementation plan

Do **not** write implementation code in this command. Produce a plan.

### 1. Read before planning

- `CLAUDE.md` — architecture, commands, LinkedIn rules, prohibitions
- `tasks/lessons.md` — corrections already recorded; do not re-earn them
- `docs/adr/` — decisions already made; do not silently reverse one
- The actual files the change touches

### 2. Work out which side owns the change

The server orchestrates, the extension executes. Ask explicitly:

- Does this need a **real browser session** (any LinkedIn call)? → extension.
- Is it scheduling, state, persistence, LLM, or notification? → server.
- Does it need both? Then it needs a **WebSocket message**, which means three
  edits: `server/src/ws-gateway/events.ts`, a `commands/` or `handlers/` file, and
  `extension/scripts/background.js`.

Also check whether the change touches `server/src/shared/*`, which is duplicated
by hand in `extension/services/*`. Both copies move together.

### 3. Write the plan

```markdown
## Goal

One sentence.

## Files to change

| File | Change |

## Steps

Numbered, each independently verifiable.

## Tests

Which `*.test.ts`, covering what. Pure functions get real tests; anything needing
a live LinkedIn session belongs in the probe instead.

## Risks

Especially: does this touch cookie handling, rate limits, or deploy config?

## Out of scope

Explicit.
```

### 4. Stop

Present the plan and wait for approval. Do not start implementing.
