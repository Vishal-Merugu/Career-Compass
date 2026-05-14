// ─── Background Service Worker ───────────────────────────────────
// Orchestrates the pipeline and handles extension lifecycle events.

// Import all modules (order matters — dependencies first)
importScripts(
  "../services/storage.js",
  "../services/voyagerClient.js",
  "../services/rateLimiter.js",
  "../services/llmClient.js",
  "../services/pipeline.js",
);

// ─── Message Handling ────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sendResponse);
  return true; // keep channel open for async response
});

async function handleMessage(message, sendResponse) {
  try {
    switch (message.action) {
      case "start": {
        const status = await getPipelineStatus();
        if (status === "running") {
          sendResponse({ ok: false, error: "Pipeline is already running" });
          return;
        }
        sendResponse({ ok: true });
        // Run pipeline asynchronously
        runPipeline();
        break;
      }

      case "pause": {
        await setPipelineStatus("paused");
        await addActivityEntry("⏸ Pipeline paused by user");
        sendResponse({ ok: true });
        break;
      }

      case "stop": {
        await setPipelineStatus("idle");
        await addActivityEntry("⏹ Pipeline stopped by user");
        // Clear queues
        await setPipelineState({
          status: "idle",
          currentStep: 0,
          jobQueue: [],
          companyQueue: [],
          targetQueue: [],
          profileQueue: [],
          messageQueue: [],
        });
        sendResponse({ ok: true });
        break;
      }

      case "resetDaily": {
        await resetDailyStats();
        await addActivityEntry("🔄 Daily counters reset");
        sendResponse({ ok: true });
        break;
      }

      case "getStatus": {
        const [pipelineState, stats, activity, config] = await Promise.all([
          getPipelineState(),
          getDailyStats(),
          getActivityLog(),
          getConfig(),
        ]);
        sendResponse({
          ok: true,
          status: pipelineState.status,
          stats,
          activity,
          config,
        });
        break;
      }

      case "saveConfig": {
        await setConfig(message.config);
        sendResponse({ ok: true });
        break;
      }

      case "getHistory": {
        const log = await getOutreachLog();
        sendResponse({ ok: true, log });
        break;
      }

      case "llmHealthCheck": {
        const config = message.config || (await getConfig());
        const health = await llmHealthCheck(config);
        sendResponse(health);
        break;
      }

      case "verifyContext": {
        // Find the active tab in the current window
        try {
          const tabs = await new Promise((resolve, reject) => {
            chrome.tabs.query({ active: true, currentWindow: true }, (t) => {
              if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
              else resolve(t);
            });
          });

          const activeTab = tabs[0];
          let isLinkedIn = false;

          if (activeTab && activeTab.url) {
            const url = new URL(activeTab.url);
            // Verify it's on any linkedin.com subdomain
            if (url.hostname.includes("linkedin.com")) {
              isLinkedIn = true;
            }
          }

          // If it's linkedin, check if they're logged in
          let isLoggedIn = false;
          if (isLinkedIn) {
            isLoggedIn = await isLinkedInLoggedIn();
          }

          sendResponse({
            ok: true,
            isLinkedIn,
            isLoggedIn,
            url: activeTab?.url,
          });
        } catch (err) {
          console.error("[Background] verifyContext failed:", err);
          sendResponse({
            ok: false,
            isLinkedIn: false,
            isLoggedIn: false,
            error: err.message,
          });
        }
        break;
      }

      case "sessionCheck": {
        const loggedIn = await isLinkedInLoggedIn();
        sendResponse({ ok: true, loggedIn });
        break;
      }

      case "resetAllData": {
        // 1. Stop pipeline
        await setPipelineStatus("idle");
        // 2. Clear all storage
        await clearAllData();
        // 3. Re-initialize defaults
        await setConfig({ ...DEFAULT_CONFIG });
        await resetDailyStats();
        await addActivityEntry("🗑️ All data has been reset to defaults.");
        sendResponse({ ok: true });
        break;
      }

      default:
        sendResponse({ ok: false, error: `Unknown action: ${message.action}` });
    }
  } catch (err) {
    console.error("[Background] Message handler error:", err);
    sendResponse({ ok: false, error: err.message });
  }
}

// ─── Alarms ──────────────────────────────────────────────────────

chrome.alarms.create("midnightReset", {
  // Fire at next midnight, then every 24h
  when: getNextMidnight(),
  periodInMinutes: 24 * 60,
});

chrome.alarms.create("sessionValidation", {
  periodInMinutes: 30,
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === "midnightReset") {
    console.log("[Background] Midnight reset — clearing daily stats");
    await resetDailyStats();
    await addActivityEntry("🌅 New day — daily counters reset");
  }

  if (alarm.name === "sessionValidation") {
    const status = await getPipelineStatus();
    if (status === "running") {
      await validateSession();
    }
  }
});

function getNextMidnight() {
  const now = new Date();
  const midnight = new Date(now);
  midnight.setHours(24, 0, 0, 0);
  return midnight.getTime();
}

// ─── Extension Install / Startup ─────────────────────────────────

chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === "install") {
    console.log("[Background] Extension installed — initializing defaults");
    await setConfig({ ...DEFAULT_CONFIG });
    await resetDailyStats();
    await addActivityEntry("🎉 CareerCompass extension installed!");
  }
});

chrome.runtime.onStartup.addListener(async () => {
  console.log("[Background] Browser started — checking pipeline state");
  const state = await getPipelineState();
  if (state.status === "running") {
    // Was running when browser closed — auto-resume
    await addActivityEntry("🔄 Browser restarted — resuming pipeline...");
    runPipeline();
  }
});

console.log("[Background] CareerCompass service worker loaded");
