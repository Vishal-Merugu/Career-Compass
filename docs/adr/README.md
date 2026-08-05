# Architecture Decision Records

Short documents recording a decision that was **expensive to reach** and would
otherwise be re-litigated or silently reversed.

| #                                                      | Decision                                         | Status   |
| ------------------------------------------------------ | ------------------------------------------------ | -------- |
| [0001](0001-extension-executes-server-orchestrates.md) | The extension executes, the server orchestrates  | Accepted |
| [0002](0002-full-cookie-jar.md)                        | A live cookie jar, not two static cookies        | Accepted |
| [0003](0003-manual-dispatch-deploys.md)                | Manual-dispatch deploys via a self-hosted runner | Accepted |

## When to write one

Write an ADR when a choice was **non-obvious and cost something to learn** — a
failed approach, a subtle platform behaviour, a security constraint. Not for
routine choices a reader can infer from the code.

The test: would a future session, seeing only the code, be tempted to "fix" it
back to the rejected alternative? If yes, it needs an ADR.

## Format

```markdown
# NNNN — Title in the imperative

Date: YYYY-MM-DD
Status: Proposed | Accepted | Superseded by NNNN

## Context

What forced the decision. Include the failure that prompted it, concretely.

## Decision

What was chosen, in enough detail to implement.

## Consequences

What this costs, including the ongoing costs. Be honest.

## Alternatives considered

Each with the reason it was rejected. This is the section that stops the decision
being reversed by accident.
```

Number sequentially. Never edit an accepted ADR's decision — supersede it with a
new one and mark the old one `Superseded by NNNN`.
