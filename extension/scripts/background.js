// ─── Background Service Worker ───────────────────────────────────
// Orchestrates workflows and handles extension lifecycle events.

// Import all modules (order matters — dependencies first)
importScripts(
  '../services/socket.io.min.js',
  '../services/storage.js',
  '../services/parsers.js',
  '../services/resilience.js',
  '../services/rateLimiter.js',
  '../services/voyagerClient.js',
  '../services/sessionSync.js',
  // emailFinder must load before emailLookupDrainer — the drainer calls into it.
  '../services/emailFinder.js',
  '../services/emailLookupDrainer.js',
  '../workflows/baseWorkflow.js',
  '../workflows/registry.js',
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
      case 'job:start': {
        const { jobId, userId } = message;
        await chrome.storage.local.set({ lastActiveJob: { jobId, userId } });
        await connectSocket(jobId, userId);
        sendResponse({ ok: true });
        break;
      }

      case 'job:stop': {
        await chrome.storage.local.remove('lastActiveJob');
        disconnectSocket();
        sendResponse({ ok: true });
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
        // Linking to a backend for the first time happens here, and the server
        // has no jar until one is pushed.
        syncSessionToServer().catch(() => {});
        sendResponse({ ok: true });
        break;
      }

      // Push the LinkedIn jar now. The popup uses this so a user who just
      // logged in to LinkedIn does not wait up to 30 minutes for the alarm.
      case 'session:sync': {
        sendResponse(await syncSessionToServer());
        break;
      }

      case 'syncConfig': {
        const config = await syncConfigFromServer();
        sendResponse({ ok: true, config });
        break;
      }

      case 'getHistory': {
        const log = await getOutreachLog();
        sendResponse({ ok: true, log });
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

// Drains email lookups queued from the web dashboard. One minute is the floor
// Chrome allows for a periodic alarm, and it has to be an alarm rather than a
// setInterval because the worker is suspended after ~30s idle and takes any
// timer with it. See services/emailLookupDrainer.js.
chrome.alarms.create('emailLookupDrain', {
  periodInMinutes: 1,
});

// Keep the server's cookie jar fresh. LinkedIn rotates JSESSIONID and lidc
// during ordinary browsing, and the server cannot obtain a jar on its own, so
// re-pushing periodically is what keeps server-side scraping alive. 30 minutes
// is well inside any cookie's lifetime while costing one request.
chrome.alarms.create('sessionSync', {
  periodInMinutes: 30,
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'midnightReset') {
    console.log('[Background] Midnight reset — clearing daily stats');
    await resetDailyStats();
    await addActivityEntry('🌅 New day — daily counters reset');
  } else if (alarm.name === 'workflowKeepAlive') {
    console.log('[Background] Keep-alive alarm fired');
  } else if (alarm.name === 'emailLookupDrain') {
    // Failures are logged inside; a rejection here would leave the alarm
    // handler with an unhandled rejection and no other effect.
    await drainEmailLookups();
  } else if (alarm.name === 'sessionSync') {
    await syncSessionToServer();
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
    // Before anything else: the server needs a live jar to scrape with, and the
    // 30-minute alarm may be a long way off after a browser restart.
    syncSessionToServer().catch((err) =>
      console.error('[Background] Session sync on startup failed:', err),
    );

    const data = await chrome.storage.local.get('lastActiveJob');
    if (data.lastActiveJob) {
      const { jobId, userId } = data.lastActiveJob;
      console.log(
        `[Background] Found active job ${jobId} on startup. Reconnecting socket...`,
      );
      connectSocket(jobId, userId);
    }

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

// ─── WebSocket Client Manager ──────────────────────────────────────

let socket = null;
let heartbeatInterval = null;

async function connectSocket(jobId, userId) {
  try {
    if (socket) {
      console.log('[Background] Socket already exists, disconnecting first...');
      disconnectSocket();
    }

    const config = await getConfig();
    const { backendUrl, apiKey } = config;

    if (!backendUrl || !apiKey) {
      console.warn(
        '[Background] Missing backendUrl or apiKey. Cannot connect socket.',
      );
      return;
    }

    console.log(
      `[Background] Connecting socket to ${backendUrl} for Job ${jobId}...`,
    );

    socket = io(backendUrl, {
      query: { jobId, userId, apiKey },
      reconnection: true,
      reconnectionDelay: 2000,
      reconnectionAttempts: 20,
      transports: ['websocket'], // Required for MV3 Service Workers (no XMLHttpRequest)
    });

    socket.on('connect', () => {
      console.log('[Background] Socket connected successfully. Registering...');
      socket.emit('REGISTER', { jobId, userId });

      if (heartbeatInterval) clearInterval(heartbeatInterval);
      heartbeatInterval = setInterval(() => {
        if (socket && socket.connected) {
          socket.emit('HEARTBEAT');
        }
      }, 15000);
    });

    socket.on('connect_error', (err) => {
      console.error('[Background] Socket connection error:', err);
    });

    socket.on('disconnect', (reason) => {
      console.log('[Background] Socket disconnected. Reason:', reason);
      if (heartbeatInterval) {
        clearInterval(heartbeatInterval);
        heartbeatInterval = null;
      }
    });

    socket.on('ERROR', (payload) => {
      console.error('[Background] Received ERROR event from server:', payload);
    });

    // PAUSE / RESUME are no longer acted on here — there is no local scrape
    // loop left to pause. The server pauses its own worker by moving the job
    // out of the `scraping` state.

    socket.on('STOP_LIMIT_REACHED', () => {
      console.log(
        '[Background] Received STOP_LIMIT_REACHED command from server',
      );
      disconnectSocket();
    });

    socket.on('SESSION_CHECK', async () => {
      console.log('[Background] Received SESSION_CHECK command from server');
      try {
        const loggedIn = await isLinkedInLoggedIn();
        if (loggedIn) {
          socket.emit('SESSION_VALID', { jobId });
        } else {
          socket.emit('SESSION_INVALID', { jobId });
        }
      } catch (err) {
        socket.emit('SESSION_INVALID', { jobId, error: err.message });
      }
    });

    // No FETCH_URL_BATCH or SCRAPE_PROFILE listeners: URL collection and
    // profile scraping run on the server now, which holds the cookie jar this
    // extension pushes to it. See docs/adr/0007-server-side-linkedin-calls.md.
    // Listening here as well would mean two collectors racing over one job.
  } catch (err) {
    console.error('[Background] connectSocket failed:', err);
  }
}

function disconnectSocket() {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }
  if (socket) {
    socket.disconnect();
    socket = null;
  }
  console.log('[Background] Socket disconnected and cleaned up.');
}
