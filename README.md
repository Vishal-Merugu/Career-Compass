# CareerCompass

**AI-powered job discovery and professional outreach engine for LinkedIn.**

CareerCompass is a robust, modular Chrome extension designed to streamline your job search and automate professional outreach. By leveraging Local LLMs (Ollama) or cloud providers, it intelligently qualifies prospects, drafts personalized messages, and manages an end-to-end outreach pipeline directly within your browser.

## Key Features

- **Intelligent Workflows:**
  - **People Finder:** Discover and automatically qualify prospects (e.g., Alumni, hiring managers) using AI.
  - **Mass Connector:** Automatically send personalized connection requests to lists of qualified profiles.
  - **Outreach Pipeline:** Multi-step pipeline to manage cold outreach, messaging, and follow-ups.
- **Robust Resilience & Rate Limiting:**
  - Built-in `CircuitBreaker` and exponential backoff (`withRetry`) to handle LinkedIn's Voyager API transient errors gracefully.
  - Pre-emptive filtering of out-of-network or private profiles to avoid suspicious network activity.
  - Human-like pacing (randomized 1.5s–3.7s delays) to mimic real browsing behavior and protect your account.
- **AI Integration:**
  - Seamlessly integrates with Local AI (Ollama) to ensure privacy, or Cloud LLMs (Gemini, OpenRouter) for high-performance profile evaluation and message generation.
- **Automated Data Extraction:**
  - Extracts full profile details, job history, and skills using the LinkedIn Voyager API.

## Setup & Installation

Since this is an unpacked Chrome extension:

1. Open Google Chrome (or any Chromium-based browser) and navigate to `chrome://extensions/`.
2. Enable **Developer mode** in the top right corner.
3. Click on **Load unpacked** in the top left.
4. Select the `CareerCompass` directory.
5. The extension will appear in your toolbar. Click it to open the Dashboard!

## Architecture

The codebase is organized into modular services and workflows:

- **`manifest.json`**: Extension configuration (Manifest V3).
- **`scripts/background.js`**: Background service worker handling alarms, session validation, and core lifecycle events.
- **`popup/`**: Clean, modern HTML/JS/CSS user interface.
- **`services/`**: Core utilities and API clients:
  - `voyagerClient.js`: Network layer for interacting with LinkedIn's internal API.
  - `llmClient.js`: Unified interface for local and cloud AI models.
  - `resilience.js`: Circuit breaker and retry logic for fault tolerance.
  - `rateLimiter.js`: Enforces human-like pacing and daily safety limits.
  - `parsers.js`: Robust utilities to parse complex GraphQL/Voyager JSON responses.
  - `storage.js`: Local persistence layer.
- **`workflows/`**:
  - Contains modular workflow runners (`baseWorkflow.js`, `peopleFinder.js`, `massConnector.js`) that safely execute long-running tasks.

## Development

```bash
npm run typecheck     # tsc --noEmit across server/ (including tests)
npm run test          # vitest
npm run lint          # eslint
npm run lint:fix      # eslint --fix
npm run format        # prettier --write
npm run format:check  # prettier --check (what CI runs)
```

`.github/workflows/pr.yml` runs all of the above on every pull request. Merging
does **not** deploy — deploys are a manual dispatch of "Deploy to VM" from the
Actions tab.

## Documentation

| Where                                  | What                                                         |
| -------------------------------------- | ------------------------------------------------------------ |
| [`CLAUDE.md`](CLAUDE.md)               | Architecture, commands, LinkedIn/Voyager rules, prohibitions |
| [`docs/adr/`](docs/adr/)               | Why the big decisions were made                              |
| [`docs/SOPs/`](docs/SOPs/)             | Definition of done                                           |
| [`tasks/lessons.md`](tasks/lessons.md) | Corrections and traps, accumulated over time                 |

## License

MIT
