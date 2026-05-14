# CareerCompass

**AI-powered job discovery and professional outreach engine.**

CareerCompass is a Chrome extension designed to streamline your job search and LinkedIn automation tasks. By leveraging AI capabilities, it helps you discover relevant job opportunities, automate professional outreach, and optimize your application pipeline.

## Features

- **LinkedIn Integration:** Seamlessly interacts with LinkedIn using your existing session.
- **AI-Powered Analysis:** Integrates with Local AI (Ollama) or cloud providers (Gemini/OpenRouter) to process job descriptions, match profiles, and draft personalized outreach messages.
- **Pipeline Management:** Tracks your connections, job applications, and conversations directly within the extension.
- **Voyager API Support:** Uses LinkedIn's internal Voyager API for data extraction and messaging.
- **Rate Limiting:** Built-in rate limiter to ensure your automation tasks stay within safe limits and protect your account.

## Setup & Installation

Since this is an unpacked Chrome extension:

1. Open Google Chrome and navigate to `chrome://extensions/`.
2. Enable **Developer mode** in the top right corner.
3. Click on **Load unpacked** in the top left.
4. Select the `CareerCompass` directory.
5. The extension should now be installed and visible in your browser toolbar!

## Development

- **`manifest.json`**: Extension configuration and permissions.
- **`background.js`**: Background service worker handling alarms, tasks, and core logic.
- **`popup.html/js/css`**: The user interface of the extension.
- **`llmClient.js`**: Handles communication with Ollama/Gemini/OpenRouter.
- **`voyagerClient.js`**: Interacts with the LinkedIn Voyager API.
- **`pipeline.js`**: Manages data flow and processing pipelines.
- **`storage.js`**: Utilities for reading and writing data to Chrome storage.
- **`rateLimiter.js`**: Ensures API calls adhere to safe velocity limits.

## License

MIT
