# CareerCompass

**AI-powered job discovery and professional outreach engine for LinkedIn.**

CareerCompass finds people worth talking to, qualifies them with an LLM, finds
their work email, and runs personalised cold outreach from your own mailbox —
end to end, from a web dashboard.

## The three parts

| Part         | What it is                                        | Role          |
| ------------ | ------------------------------------------------- | ------------- |
| `server/`    | TypeScript / Express / Prisma / Postgres / Redis  | the **brain** |
| `client/`    | Vite / React / TypeScript / Mantine web dashboard | the **face**  |
| `extension/` | Manifest V3 Chrome extension, plain JS, no build  | the **hands** |

The server makes the LinkedIn read calls itself (company resolution, people
search, profile fetch), so a run does not need a browser open. The extension's
job is to keep the server's LinkedIn cookie jar fresh and to drive the two
things that genuinely need a real browser: connection requests and the
browser-based email lookups. The dashboard is a plain REST client of the server
and is served **same-origin** out of `server/public/`.

All configuration lives in the dashboard — the extension configures nothing.

## Key features

- **Runs (people finder).** Resolve a company, search people, fetch full
  profiles, and score each one against your criteria with an LLM. Paced and
  buffered; a run reports why it stopped.
- **Model fallback chain.** Each user keeps an _ordered list_ of LLM
  credentials; the first model that answers wins. Every free tier is a daily
  quota, so five stacked free tiers is the budget. A 429 cools a key down and
  moves it to the back of the chain — it is never silently disabled.
- **Never fails quietly.** An LLM failure throws a typed `JobErrorCode`; it is
  never recorded as "not a good fit". Fatal codes pause the run on the first
  occurrence, and every user-facing string carries a message _and_ a fix.
- **Email finding, on demand.** Select people on Results → "Find emails". Work
  goes into a Postgres-backed lookup queue: LinkFinder, then Anymail Finder,
  then patterns + SMTP verification on the server; the extension's browser
  drivers (Mailmeteor, Anymail Finder's free tool) upgrade results when a
  browser is available. Writes to a stored address are upgrade-only, so a
  verified address is never overwritten by a guess.
- **Outreach campaigns.** Seed a campaign from Results, draft personalised mail
  with the LLM, and send from your own SMTP account through a BullMQ queue with
  pacing that survives a restart. Live progress over SSE.
- **Resilience by default.** Circuit breaker, exponential backoff, human-like
  pacing (1.5–3.7 s), and a hard 15 connection-requests/day ceiling — LinkedIn's
  limit, not ours.
- **Telegram bot** for job control and lifecycle notifications.

## Setup

### Prerequisites

Postgres, Redis (**required** — the server exits at boot without it), Node 20+,
and an LLM endpoint (a local Ollama is the default).

### Server + dashboard

```bash
cp .env.example server/.env      # then fill DATABASE_URL, JWT_SECRET, …
cd server && npm install && npm run db:generate && npm run db:migrate
cd ../client && npm install
cd .. && npm run build:client    # client/ → server/public/
cd server && npm run dev         # http://localhost:3000
```

The log line `🖥️  Serving web dashboard from …/server/public` means same-origin
serving is live. `API only` plus a blank page means `build:client` was never run
(`server/public/` is gitignored).

The **first** account on an empty database registers freely. After that,
registration is closed unless the server is started with `REGISTRATION_TOKEN`
set, which the sign-up form takes as an invite code.

### Extension

1. `chrome://extensions/` → enable **Developer mode**.
2. **Load unpacked** → select the `extension/` directory (no build step needed).
3. Open the popup, point it at your server, and connect.

Keep it installed: the server cannot obtain a LinkedIn session on its own, so
the extension pushing the cookie jar every 30 minutes is an operational
requirement. If cookies expire, runs pause. `npm run cookies:import` is the
manual alternative.

`npm run build:ext` produces a distributable `extension.zip` with the backend
URL baked in from `.env.production`.

## Commands

```bash
# repo root
npm test                 # vitest (delegates to server/)
npm run typecheck        # tsc --noEmit, server + client
npm run lint             # eslint
npm run lint:fix         # eslint --fix
npm run format           # prettier --write
npm run format:check     # prettier --check  (what CI runs)
npm run dev:client       # vite dev server, proxies /api → localhost:3000
npm run build:client     # client → server/public/
npm run build:ext        # → extension.zip

# server/
npm run dev              # tsx watch
npm run build            # tsc → dist/
npm run db:migrate       # prisma migrate dev
npm run db:generate      # prisma generate  (after any schema.prisma edit)
npm run db:studio
npm run probe:linkedin -- --quick        # ~4 min,  6 read-only Voyager calls
npm run probe:linkedin -- --sustained    # ~35 min, 10 calls  (default)
npm run probe:linkedin -- --long         # ~4 h,   14 calls
npm run probe:linkedin -- --egress-only  # egress IP/ASN only, no calls
npm run cookies:import   # build linkedin-cookies.json from a copied cURL
```

**Three npm projects, three lockfiles**: root (tooling), `server/`, `client/`.
`npm ci` in one does not install the others.

`.github/workflows/pr.yml` runs typecheck, tests, lint and format on every pull
request.

## Deployment

**`git push` does not deploy. Nothing deploys automatically, ever.**

Deploy = Actions tab → **Deploy to VM** → Run workflow → pick a branch. It runs
on a self-hosted runner on the VM, which is reachable only over the university
VPN. Docker Compose builds one image from the repo root (backend + dashboard)
alongside Postgres and Redis.

Every variable the server reads must be named in `docker-compose.yml`'s
`environment:` block — setting it in the VM's `.env` alone does nothing, because
Compose only substitutes variables it knows about.

See [`docs/adr/0003-manual-dispatch-deploys.md`](docs/adr/0003-manual-dispatch-deploys.md).

## Documentation

| Where                                  | What                                                         |
| -------------------------------------- | ------------------------------------------------------------ |
| [`CLAUDE.md`](CLAUDE.md)               | Architecture, commands, LinkedIn/Voyager rules, prohibitions |
| [`docs/adr/`](docs/adr/)               | Why the big decisions were made                              |
| [`docs/SOPs/`](docs/SOPs/)             | Definition of done                                           |
| [`tasks/lessons.md`](tasks/lessons.md) | Corrections and traps, accumulated over time                 |

## License

MIT
