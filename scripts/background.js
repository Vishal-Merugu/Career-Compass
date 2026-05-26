// ─── Background Service Worker ───────────────────────────────────
// Orchestrates workflows and handles extension lifecycle events.

// Import all modules (order matters — dependencies first)
importScripts(
  '../services/storage.js',
  '../services/parsers.js',
  '../services/resilience.js',
  '../services/rateLimiter.js',
  '../services/voyagerClient.js',
  '../services/llmClient.js',
  '../services/csvExporter.js',
  '../services/emailFinder.js',
  '../workflows/baseWorkflow.js',
  '../workflows/registry.js',
  '../workflows/peopleFinder.js',
  '../workflows/massConnector.js',
);

// ─── Message Handling ────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sendResponse);
  return true; // keep channel open for async response
});

async function handleMessage(message, sendResponse) {
  try {
    const { action } = message;

    // ─── Workflow Engine Commands ───────────────────────────────
    if (action.startsWith('workflow:')) {
      return handleWorkflowMessage(message, sendResponse);
    }

    // ─── Shared Configuration & Utility Commands ─────────────────
    switch (action) {
      case 'findEmail': {
        const { linkedinUrl, profileData } = message;
        const result = await findEmail(linkedinUrl, profileData);
        sendResponse(result);
        break;
      }

      case 'resetDaily': {
        await resetDailyStats();
        await addActivityEntry('🔄 Daily counters reset');
        sendResponse({ ok: true });
        break;
      }

      case 'getStatus': {
        const [stats, activity, config] = await Promise.all([
          getDailyStats(),
          getActivityLog(),
          getConfig(),
        ]);
        sendResponse({
          ok: true,
          status: 'idle',
          stats,
          activity,
          config,
        });
        break;
      }

      case 'saveConfig': {
        await setConfig(message.config);
        sendResponse({ ok: true });
        break;
      }

      case 'getHistory': {
        const log = await getOutreachLog();
        sendResponse({ ok: true, log });
        break;
      }

      case 'llmHealthCheck': {
        const config = message.config || (await getConfig());
        const health = await llmHealthCheck(config);
        sendResponse(health);
        break;
      }

      case 'verifyContext': {
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
            if (url.hostname.includes('linkedin.com')) {
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
          console.error('[Background] verifyContext failed:', err);
          sendResponse({
            ok: false,
            isLinkedIn: false,
            isLoggedIn: false,
            error: err.message,
          });
        }
        break;
      }

      case 'sessionCheck': {
        const loggedIn = await isLinkedInLoggedIn();
        sendResponse({ ok: true, loggedIn });
        break;
      }

      case 'resetAllData': {
        // 1. Stop pipeline
        await setPipelineStatus('idle');
        // 2. Clear all storage
        await clearAllData();
        // 3. Re-initialize defaults
        await setConfig({ ...DEFAULT_CONFIG });
        await resetDailyStats();
        await addActivityEntry('🗑️ All data has been reset to defaults.');
        sendResponse({ ok: true });
        break;
      }

      default:
        sendResponse({ ok: false, error: `Unknown action: ${action}` });
    }
  } catch (err) {
    console.error('[Background] Message handler error:', err);
    sendResponse({ ok: false, error: err.message });
  }
}

// ─── Workflow Message Handler ────────────────────────────────────

async function handleWorkflowMessage(message, sendResponse) {
  const { action, workflow, params } = message;

  switch (action) {
    case 'workflow:start':
      sendResponse(await WorkflowRegistry.start(workflow, params));
      break;
    case 'workflow:pause':
      sendResponse(await WorkflowRegistry.pause(workflow));
      break;
    case 'workflow:resume':
      sendResponse(await WorkflowRegistry.resume(workflow));
      break;
    case 'workflow:cancel':
      sendResponse(await WorkflowRegistry.cancel(workflow));
      break;
    case 'workflow:status':
      sendResponse(WorkflowRegistry.getStatus(workflow));
      break;
    case 'workflow:results':
      sendResponse(WorkflowRegistry.getResults(workflow));
      break;
    case 'workflow:history':
      sendResponse(await WorkflowRegistry.getHistory(workflow));
      break;
    case 'workflow:list':
      sendResponse({ ok: true, workflows: WorkflowRegistry.listAll() });
      break;
    default:
      sendResponse({ ok: false, error: `Unknown workflow action: ${action}` });
  }
}

// ─── Alarms ──────────────────────────────────────────────────────

chrome.alarms.create('midnightReset', {
  // Fire at next midnight, then every 24h
  when: getNextMidnight(),
  periodInMinutes: 24 * 60,
});

// Keep-alive alarm to prevent/recover from service worker suspension
chrome.alarms.create('workflowKeepAlive', {
  periodInMinutes: 1,
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'midnightReset') {
    console.log('[Background] Midnight reset — clearing daily stats');
    await resetDailyStats();
    await addActivityEntry('🌅 New day — daily counters reset');
  } else if (alarm.name === 'workflowKeepAlive') {
    console.log('[Background] Keep-alive alarm fired');
  }
});

function getNextMidnight() {
  const now = new Date();
  const midnight = new Date(now);
  midnight.setHours(24, 0, 0, 0);
  return midnight.getTime();
}

// ─── Self-Healing / Auto-Resume suspended workflows ───────────────

async function initWorkflows() {
  console.log('[Background] Initializing workflows state...');
  try {
    for (const wf of Object.values(WorkflowRegistry._workflows)) {
      const state = await wf.loadState();
      if (state && state.status === 'running') {
        console.log(
          `[Background] Recovered running workflow: ${wf.name}. Resuming execution loop...`,
        );
        WorkflowRegistry._activeWorkflowId = wf.id;

        // Restart the loop asynchronously
        wf.execute(wf._params)
          .then(() => wf._onComplete())
          .catch((err) => wf._onError(err));

        await addActivityEntry(
          `🔄 Recovered active workflow: ${wf.name} (resuming execution)`,
        );
      }
    }
  } catch (err) {
    console.error('[Background] Error initializing workflows state:', err);
  }
}

// Initialize on startup/wake-up
initWorkflows();

// ─── Extension Install / Startup ─────────────────────────────────

chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === 'install') {
    console.log('[Background] Extension installed — initializing defaults');
    await setConfig({ ...DEFAULT_CONFIG });
    await resetDailyStats();
    await addActivityEntry('🎉 CareerCompass extension installed!');
  }
});

chrome.runtime.onStartup.addListener(async () => {
  console.log('[Background] Browser startup — restoring workflow state');
  await initWorkflows();
});

console.log(
  '[Background] CareerCompass service worker loaded (v2 — workflow engine)',
);
