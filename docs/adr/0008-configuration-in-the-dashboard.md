# 8. Configuration lives in the dashboard, not the extension

Date: 2026-08-10

## Status

Accepted. Supersedes the configuration half of ADR 0001.

## Context

A new account registered, pasted a company URL, started a run, and watched it
scrape 368 profiles and qualify none. The root cause was a default the user
never saw and could not have known to change: `llmUrl` defaulted to
`http://localhost:11434`, which inside the server's container is the container
itself.

Underneath that were three structural problems, each of which would have
produced a similar failure on its own.

**Two writers on one row.** `extension/services/storage.js` pushed its entire
local config to `POST /api/config` on every save, while `syncConfigFromServer`
pulled the server's copy and merged it on load. Whichever ran last won. There
was no way to reason about which value was in effect.

**The settings were in the wrong process.** The AI model, its address and its
key are consumed exclusively by the server — it is the server that evaluates
profiles. They were edited in a 400px popup belonging to a process that no
longer makes any model call at all.

**The health check tested the wrong machine.** The extension's "Test AI" button
ran `llmHealthCheck` in its own service worker, which reaches the _user's
laptop_. It could report a healthy model while the server could not resolve the
address. That is precisely the state the VM was in.

A fourth problem was latent: the extension generated connection notes through a
hand-copied `llmClient.js`, so a single `llmUrl` had to be simultaneously
correct for a browser (`localhost:11434`) and for a container
(`host.docker.internal:11434`). It cannot be.

## Decision

**All configuration moves to the web dashboard. The extension writes none of
it.**

- `GET/PUT /api/settings/ai`, `GET/PUT /api/settings/finder` and
  `GET /api/setup/status` are **cookie-only** (`requireAuth`), on the same
  grounds as `/api/settings/outreach`: `llmApiKey` is a billable credential and
  the extension's long-lived key works from anywhere.
- `/api/config` remains readable with the extension's API key — it still needs
  `dailyLimit` and `emailFinderEnabled` — but **silently ignores every AI field
  on write**. That is what makes the dashboard the single writer.
- `setConfig` in the extension no longer pushes. `apiKey` and `backendUrl` are
  local wiring and the only things the extension still owns.
- **`POST /api/settings/ai/check` runs on the server**, and its response says
  so. It reports both reachability and whether the configured model is actually
  installed.
- **Connection-note generation moved to the server** (`POST /api/connections/message`).
  Sending the invitation stays in the extension — ADR 0007's exception is
  unchanged — but with the writing moved there is exactly one LLM caller in the
  system, one address to configure, and `extension/services/llmClient.js` is
  deleted rather than maintained in parallel.
- **A new provider, `server`**, meaning "this instance's built-in model",
  resolved from `DEFAULT_LLM_URL` / `DEFAULT_LLM_MODEL`. It is the default for
  new accounts, because the operator knows an address that works and a model
  that is installed, and a new user does not.

The extension popup is left with two tabs: **Connect** and **Status**.

## Consequences

A user configures in one place, and the "Test" button tests the process that
does the work. A new account needs no AI configuration at all.

The extension must be reloaded after this change. A stale copy still pushing its
local config would have its AI fields ignored — so it cannot corrupt anything —
but it would keep showing settings that do nothing.

Three columns were dropped as part of this: `keywords` and `locations`, which
only a Telegram status line still read, and `targetGeoId`, which was worse than
unused — the extension collected and saved it while `parseSearchUrl` hardcoded
`101282230` and never consulted the column, so setting it had no effect and gave
no warning.

`llmApiKey` is now encrypted at rest with `lib/secretBox.ts`, like
`smtpPassword`. Consequence inherited from that decision: rotating `JWT_SECRET`
makes stored keys undecryptable and they must be re-entered. Every read path
must go through `PrismaStorageAdapter.getConfig()`, which decrypts — reading
`prisma.userConfig` directly and sending the ciphertext as a bearer token
reports a bad key to a user whose key is fine.
