# CareerCompass

**AI-powered job discovery and professional outreach engine for LinkedIn.**

CareerCompass finds people worth talking to at any company, qualifies them with
an LLM against your criteria, discovers their work email, and sends personalised
cold outreach from your own mailbox — end to end, from a single web dashboard.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                        Web Dashboard (client/)                   │
│          Vite · React 19 · TypeScript · Mantine 9 · TanStack    │
│   Screens: Runs · Run Detail · Results · Campaigns · Settings   │
└────────────────────────────┬─────────────────────────────────────┘
                             │  same-origin /api (no CORS)
┌────────────────────────────▼─────────────────────────────────────┐
│                    Backend Server (server/)                       │
│        Express · TypeScript · Prisma · Postgres · Redis          │
│                                                                  │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────────────────┐  │
│  │ Orchestrator │  │  LLM Router  │  │   Email Finder         │  │
│  │ Job Runner   │  │  Fallback    │  │   LinkFinder → Anymail │  │
│  │ Voyager Calls│  │  Chain       │  │   → Pattern + SMTP     │  │
│  └─────────────┘  └──────────────┘  └────────────────────────┘  │
│  ┌──────────────┐  ┌──────────────┐  ┌────────────────────────┐ │
│  │ Campaign     │  │  Telegram    │  │   Socket.IO Gateway    │ │
│  │ BullMQ Queue │  │  Bot         │  │   Session sync         │ │
│  └──────────────┘  └──────────────┘  └────────────────────────┘ │
└────────────────────────────▲─────────────────────────────────────┘
                             │  WebSocket + REST
┌────────────────────────────┴─────────────────────────────────────┐
│                Chrome Extension (extension/)                      │
│         Manifest V3 · Plain JS · No build step                   │
│   Session sync · Connection requests · Browser email lookups     │
└──────────────────────────────────────────────────────────────────┘
```

| Part         | Stack                                            | Role                                                                                                      |
| ------------ | ------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| `server/`    | TypeScript / Express / Prisma / Postgres / Redis | the **brain** — orchestrates runs, calls LinkedIn's Voyager API, qualifies profiles, sends email          |
| `client/`    | Vite / React 19 / TypeScript / Mantine 9         | the **face** — web dashboard, built to `server/public/` and served same-origin                            |
| `extension/` | Manifest V3 Chrome extension, plain JS           | the **hands** — supplies the LinkedIn session, drives connection requests and browser-based email lookups |

**The server makes the LinkedIn read calls itself** (company resolution, people
search, profile fetch), so a run does not need a browser open. The extension's
job is to keep the server's cookie jar fresh and to drive the two things that
genuinely need a real browser: connection requests and browser-based email
lookups (Mailmeteor, Anymail Finder's free widget).

All configuration lives in the dashboard — the extension configures nothing.

---

## Features

### 🔍 Runs (People Finder)

Resolve a company by URL or name, search for people matching your criteria, fetch
full profiles, and score each one against your search prompt with an LLM. Runs
are paced with human-like delays (1.5–3.7 s) and report clearly why they stopped
— session expired, model unreachable, quota hit, or goal reached.

### 🤖 LLM Fallback Chain

Each user maintains an **ordered list** of LLM credentials (Gemini, OpenRouter,
Groq, Cloudflare, Ollama, or any OpenAI-compatible endpoint). The router walks
the list top to bottom and the first model that answers wins. Every free tier is
a daily quota — five stacked free tiers is the budget. A 429 cools a key down
and moves it to the back of the chain; it is never silently disabled. Only auth
failures and missing models are hard-disabled until the user fixes them.

### ⚡ Never Fails Quietly

An LLM failure **throws** a typed error with a user-facing message and a fix —
it is never recorded as "not a good fit". Fatal error codes pause the run on the
first occurrence. The preflight check catches unresolvable problems (no session,
unreachable model, model not installed) **before** the run starts and returns a
422 with actionable copy.

### 📧 Email Finding

Select people on Results → "Find emails". A multi-layer pipeline, on demand:

1. **LinkFinder** — LinkedIn URL in, verified business address out. Per-user API
   key (Settings → Finder), never instance-wide.
2. **Anymail Finder** — key-authenticated API (`ANYMAILFINDER_API_KEY`). One
   credit per valid email found, 100 free on signup.
3. **Patterns + SMTP verification** — no credentials needed.
4. **Browser extensions** (Mailmeteor, Anymail Finder's free widget) — run by
   the Chrome extension when a browser is available, upgrading server-side
   results.

Writes to a stored address are **upgrade-only**: a verified address is never
overwritten by a guess.

### 📨 Outreach Campaigns

Seed a campaign from Results, draft personalised mail with the LLM, attach your
résumé, and send from your own SMTP account (Gmail, Outlook, etc.). Campaigns
run through a BullMQ queue with configurable pacing that survives a server
restart. Live progress streams over SSE.

### 🛡️ Resilience

Circuit breaker, exponential backoff, human-like pacing, and a hard
**15 connection-requests/day** ceiling — LinkedIn's limit, not ours.

### 🤖 Telegram Bot

Job control (start, pause, cancel) and lifecycle notifications — session
expiry, run completion, errors.

---

## Quick Start

### Prerequisites

| Dependency       | Required | Notes                                             |
| ---------------- | -------- | ------------------------------------------------- |
| **Node.js 20+**  | ✅       | See `.nvmrc`                                      |
| **PostgreSQL**   | ✅       | 15+ recommended                                   |
| **Redis**        | ✅       | Server exits at boot without it                   |
| **LLM endpoint** | ✅       | Local Ollama is the default (`mistral-small:24b`) |

### Server + Dashboard

```bash
# 1. Configure environment
cp .env.example server/.env
# Edit server/.env — fill DATABASE_URL, JWT_SECRET, DEFAULT_LLM_URL, etc.

# 2. Install and set up the database
cd server && npm install && npm run db:generate && npm run db:migrate

# 3. Build the dashboard
cd ../client && npm install
cd .. && npm run build:client     # client/ → server/public/

# 4. Start the server
cd server && npm run dev          # http://localhost:3000
```

> **Same-origin serving**: The log line `🖥️  Serving web dashboard from
…/server/public` means the dashboard is live. `API only` plus a blank page
> means `build:client` was never run (`server/public/` is gitignored).

> **Registration**: The first account on an empty database registers freely.
> After that, registration is closed unless the server is started with
> `REGISTRATION_TOKEN` set — the sign-up form takes it as an invite code.

### Chrome Extension

1. Navigate to `chrome://extensions/` and enable **Developer mode**.
2. Click **Load unpacked** and select the `extension/` directory (no build step).
3. Open the popup, point it at your server URL, and connect.

> **Keep the extension running.** The server cannot obtain a LinkedIn session on
> its own — the extension pushes the cookie jar every 30 minutes. If cookies
> expire, runs pause. `npm run cookies:import` is the manual alternative.

---

## Commands

### Repo root

```bash
npm test                 # vitest (delegates to server/)
npm run typecheck        # tsc --noEmit, server + client
npm run lint             # eslint
npm run lint:fix         # eslint --fix
npm run format           # prettier --write
npm run format:check     # prettier --check  (CI runs this)
npm run dev:client       # vite dev server, proxies /api → localhost:3000
npm run build:client     # client/ → server/public/
npm run build:ext        # → extension.zip (backend URL from .env.production)
```

### Server (`server/`)

```bash
npm run dev              # tsx watch
npm run build            # tsc → dist/
npm run db:migrate       # prisma migrate dev
npm run db:generate      # prisma generate  (after any schema.prisma edit)
npm run db:studio        # prisma studio (database browser)
npm run probe:linkedin -- --quick        # ~4 min,  6 read-only Voyager calls
npm run probe:linkedin -- --sustained    # ~35 min, 10 calls (default)
npm run probe:linkedin -- --long         # ~4 h,   14 calls
npm run probe:linkedin -- --egress-only  # egress IP/ASN only, no calls
npm run cookies:import   # build linkedin-cookies.json from a copied cURL
```

> **Three npm projects, three lockfiles**: root (tooling), `server/`, `client/`.
> `npm ci` in one does not install the others.

---

## Environment Variables

Copy `.env.example` to `server/.env` and configure:

| Variable                | Required | Description                                                                                       |
| ----------------------- | -------- | ------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`          | ✅       | Postgres connection string                                                                        |
| `JWT_SECRET`            | ✅       | ≥ 32 chars, used for auth cookies and encryption                                                  |
| `REDIS_URL`             | ✅       | Defaults to `redis://localhost:6379`                                                              |
| `DEFAULT_LLM_URL`       | ✅       | LLM endpoint. Use `http://localhost:11434` locally, `http://host.docker.internal:11434` in Docker |
| `DEFAULT_LLM_MODEL`     | ✅       | Model name (must be pulled). Default: `mistral-small:24b`                                         |
| `TELEGRAM_BOT_TOKEN`    | ○        | From @BotFather. Set `ENABLE_TELEGRAM=false` locally                                              |
| `REGISTRATION_TOKEN`    | ○        | Invite code for new sign-ups after the first account                                              |
| `ANYMAILFINDER_API_KEY` | ○        | Email finder layer 2                                                                              |
| `HTTPS`                 | ○        | Set `true` only with real TLS termination                                                         |

> **LinkFinder** has no env var — its API key is per-user, set in the dashboard
> under Settings → Finder.

---

## Deployment

**`git push` does not deploy. Nothing deploys automatically, ever.**

Deploy = GitHub Actions tab → **Deploy to VM** → Run workflow → pick a branch.

The workflow runs on a **self-hosted runner** on the VM, which is reachable only
over the university VPN. Docker Compose builds one image from the repo root
(backend + dashboard) alongside Postgres and Redis containers.

Every variable the server reads must be named in `docker-compose.yml`'s
`environment:` block — setting it in the VM's `.env` alone does nothing.

See [`docs/adr/0003-manual-dispatch-deploys.md`](docs/adr/0003-manual-dispatch-deploys.md).

---

## CI

`.github/workflows/pr.yml` runs on every pull request:

- **Typecheck** — `tsc --noEmit` for server and client
- **Tests** — Vitest (305+ tests)
- **Lint** — ESLint
- **Format** — Prettier (`--check`)

---

## Project Structure

```
CareerCompass/
├── client/                    # React dashboard (Vite + Mantine)
│   └── src/
│       ├── api/               # fetch wrapper, response types
│       ├── auth/              # AuthProvider (GET /api/auth/me)
│       ├── pages/             # Runs, Results, Campaigns, Settings, Setup
│       │   └── settings/      # AI, LinkedIn, Finder, Outreach, Telegram tabs
│       ├── components/        # DashboardLayout, NewRunModal, ProfileDrawer
│       └── hooks/             # useExtensionBridge, useSetupStatus
├── server/                    # Express backend
│   ├── prisma/                # schema.prisma + migrations
│   └── src/
│       ├── api/               # REST routers (jobs, profiles, campaigns, config)
│       ├── auth/              # JWT + cookie auth, registration
│       ├── errors/            # AppError subclasses, JobErrorCode
│       ├── orchestrator/      # Job runner, stop conditions, timeout sweeper
│       ├── queue/             # BullMQ campaign queue + worker
│       ├── services/          # Business logic
│       │   └── emailFinder/   # LinkFinder, Anymail, patterns + SMTP
│       ├── shared/            # Code mirrored to extension (parsers, Voyager client)
│       ├── telegram/          # Bot, link codes
│       ├── workers/           # Qualification, scrape, email lookup workers
│       └── ws-gateway/        # Socket.IO events, commands, handlers
├── extension/                 # Chrome extension (Manifest V3)
│   ├── content-scripts/       # Dashboard bridge
│   ├── popup/                 # Connect + Status tabs
│   ├── scripts/               # background.js (service worker)
│   ├── services/              # Session sync, email finder, mass connector
│   └── workflows/             # Automation workflows
├── docs/
│   ├── adr/                   # Architecture Decision Records (9 ADRs)
│   └── SOPs/                  # Definition of done
├── deploy/                    # Deployment scripts
├── docker-compose.yml         # Postgres + Redis + server
├── .github/workflows/         # pr.yml (CI) + deploy.yml (manual dispatch)
└── tasks/                     # Lessons, handoff docs
```

---

## Documentation

| Document                               | Contents                                                               |
| -------------------------------------- | ---------------------------------------------------------------------- |
| [`CLAUDE.md`](CLAUDE.md)               | Architecture deep-dive, commands, LinkedIn/Voyager rules, prohibitions |
| [`docs/adr/`](docs/adr/)               | Architecture Decision Records — why the big decisions were made        |
| [`docs/SOPs/`](docs/SOPs/)             | Definition of done                                                     |
| [`tasks/lessons.md`](tasks/lessons.md) | Corrections and traps, accumulated over time                           |
| [`.env.example`](.env.example)         | All environment variables with documentation                           |

---

## Tech Stack

| Layer              | Technologies                                                                                      |
| ------------------ | ------------------------------------------------------------------------------------------------- |
| **Backend**        | Node.js 20, TypeScript, Express 4, Prisma 5, PostgreSQL 15, Redis 7, BullMQ, Socket.IO, Zod, Pino |
| **Frontend**       | React 19, TypeScript, Vite 8, Mantine 9, TanStack React Query, React Router 7                     |
| **Extension**      | Manifest V3, vanilla JavaScript, Chrome Alarms API                                                |
| **Infrastructure** | Docker, Docker Compose, GitHub Actions (self-hosted runner)                                       |
| **Testing**        | Vitest                                                                                            |
| **Tooling**        | ESLint, Prettier, Husky, lint-staged, Dependabot                                                  |

---

## License

MIT
