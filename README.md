# CareerCompass

CareerCompass is a full-stack job discovery and outreach workspace. It helps you find LinkedIn profiles and roles, qualify prospects with an LLM, look up business email addresses, and manage personalized outreach campaigns.

The LinkedIn connection uses a Chrome extension to sync the account session and perform browser-only actions. The backend handles searches and profile reads, job runs, email lookup, AI qualification, and campaign queues.

## What it includes

- A React dashboard for job searches, people-finder runs, results, campaigns, and settings.
- A TypeScript/Express API backed by PostgreSQL, Prisma, and Redis.
- LLM qualification with configurable providers and fallback handling.
- Layered email lookup, with provider integrations, pattern checks, and optional browser-based lookups.
- Queue-backed email campaigns with personalized drafts, configurable pacing, and live progress.
- A Manifest V3 Chrome extension for session sync, connection requests, and browser-based lookup workflows.
- Optional Telegram controls and run notifications.

## Architecture

| Component | Implementation | Responsibility |
| --- | --- | --- |
| Dashboard | React 19, TypeScript, Vite, Mantine | Runs, results, campaigns, and configuration |
| API and workers | Node.js 20+, Express, TypeScript, Prisma | LinkedIn reads, qualification, email lookup, campaign orchestration |
| Data and jobs | PostgreSQL, Redis, BullMQ | Persistent records and background work |
| Browser extension | Chrome Manifest V3, JavaScript | Session sync and tasks that require a signed-in browser |

The dashboard is served by the API from the same origin in production. LinkedIn read requests are made by the server using the session supplied by the extension; browser-only actions remain in the extension.

## Run locally

### Requirements

- Node.js 20+
- PostgreSQL 15+
- Redis 7+
- An LLM endpoint, such as a local Ollama instance

### API and dashboard

From the repository root:

~~~bash
cp .env.example server/.env
# Edit server/.env with the database, JWT, Redis, and LLM settings.
cd server
npm install
npm run db:generate
npm run db:migrate
cd ../client
npm install
cd ..
npm run build:client
cd server
npm run dev
~~~

The API starts on port 3000 by default. Build the dashboard before starting the server if you want the same-origin UI. The full environment reference is in .env.example.

### Chrome extension

1. Open chrome://extensions and enable Developer mode.
2. Choose Load unpacked and select the extension directory.
3. Open its popup and connect it to your server.

The extension syncs the LinkedIn session to the server. If the session expires, runs pause until the session is refreshed.

## Common commands

~~~bash
npm test
npm run typecheck
npm run lint
npm run build:client
npm run build:ext
~~~

Run these from the repository root. Server-specific database and LinkedIn probe commands are available from server/package.json.

## Configuration and deployment

Most application settings are managed in the dashboard after setup. Server secrets and service connection details are supplied through server/.env. The deployment workflow is manual and uses a self-hosted runner; pushing a commit does not deploy the app automatically.

Never commit your environment file, LinkedIn session cookies, mail credentials, or API keys. Review each provider’s terms and permissions before connecting an account.

## Project layout

- client/ — React dashboard
- server/ — Express API, database models, queues, and workers
- extension/ — Chrome extension
- docs/adr/README.md — architecture decisions
- docs/SOPs/definition-of-done.md — contribution checklist
- CLAUDE.md — detailed development notes

## License

ISC
