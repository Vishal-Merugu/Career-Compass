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
  '../services/llmClient.js',
  '../services/csvExporter.js',
  '../services/emailFinder.js',
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
        await setConfig(message.config, message.pushToServer !== false);
        sendResponse({ ok: true });
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
let isPaused = false;

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
    isPaused = false;

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
      socket.emit('CHECK_PENDING_EMAILS');

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

    socket.on('PAUSE', () => {
      console.log('[Background] Received PAUSE command from server');
      isPaused = true;
    });

    socket.on('RESUME', () => {
      console.log('[Background] Received RESUME command from server');
      isPaused = false;
    });

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

    socket.on('FETCH_URL_BATCH', async (payload) => {
      console.log('[Background] Command received: FETCH_URL_BATCH', payload);
      const { batchNumber, targetCount, searchUrl } = payload;

      try {
        await handleFetchUrlBatch(jobId, batchNumber, targetCount, searchUrl);
      } catch (err) {
        console.error('[Background] FETCH_URL_BATCH handler failed:', err);
        socket.emit('ERROR', { jobId, error: err.message || String(err) });
      }
    });

    socket.on('SCRAPE_PROFILE', async (payload) => {
      console.log('[Background] Command received: SCRAPE_PROFILE', payload);
      const { urlId, url } = payload;

      try {
        await handleScrapeProfile(jobId, urlId, url);
      } catch (err) {
        console.error('[Background] SCRAPE_PROFILE handler failed:', err);
        socket.emit('PROFILE_SCRAPE_FAILED', {
          jobId,
          urlId,
          error: err.message || String(err),
          isPermanent: false,
        });
      }
    });

    socket.on('FIND_EMAIL', (payload) => {
      console.log('[Background] Command received: FIND_EMAIL', payload);
      enqueueEmailLookup(jobId, payload);
    });
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

async function getSearchParamsFromUrl(searchUrl) {
  let companyId = '';
  let geoId = '101282230'; // default geoId
  try {
    const urlObj = new URL(searchUrl);
    const currentCompanyParam = urlObj.searchParams.get('currentCompany');
    if (currentCompanyParam) {
      try {
        const parsed = JSON.parse(currentCompanyParam);
        companyId = Array.isArray(parsed) ? parsed[0] : parsed;
      } catch (e) {
        const match = currentCompanyParam.match(/"([^"]+)"/);
        companyId = match ? match[1] : currentCompanyParam;
      }
    }
    const geoUrnParam = urlObj.searchParams.get('geoUrn');
    if (geoUrnParam) {
      try {
        const parsed = JSON.parse(geoUrnParam);
        geoId = Array.isArray(parsed) ? parsed[0] : parsed;
      } catch (e) {
        const match = geoUrnParam.match(/"([^"]+)"/);
        geoId = match ? match[1] : geoUrnParam;
      }
    }

    if (!companyId) {
      const parts = urlObj.pathname.split('/').filter(Boolean);
      const companyIdx = parts.indexOf('company');
      let companySlug = '';
      if (companyIdx !== -1 && parts[companyIdx + 1]) {
        companySlug = parts[companyIdx + 1];
      } else {
        companySlug = urlObj.searchParams.get('keywords') || '';
      }

      if (companySlug) {
        console.log('[Background] Resolving company slug:', companySlug);
        const companyRes = await resolveCompany(companySlug);
        const elements =
          companyRes.data?.['*elements'] || companyRes?.['*elements'] || [];
        const firstElement = elements[0];
        companyId =
          typeof firstElement === 'string'
            ? firstElement.split(':').pop() || ''
            : firstElement?.targetUrn?.split(':').pop() || '';
      }
    }
  } catch (err) {
    console.error('[Background] Error parsing searchUrl:', err);
  }
  return { companyId, geoId };
}

async function handleFetchUrlBatch(jobId, batchNumber, targetCount, searchUrl) {
  const { companyId, geoId } = await getSearchParamsFromUrl(searchUrl);

  if (!companyId) {
    throw new Error(
      `Could not resolve company ID for search URL: ${searchUrl}`,
    );
  }

  let count = 0;
  let start = (batchNumber - 1) * targetCount;
  let hasMore = true;

  while (count < targetCount && hasMore && !isPaused) {
    console.log(
      `[Background] Fetching search page (start: ${start}) for company ${companyId}`,
    );

    const loggedIn = await isLinkedInLoggedIn();
    if (!loggedIn) {
      console.warn(
        '[Background] LinkedIn session invalid during URL collection',
      );
      if (socket) socket.emit('SESSION_INVALID', { jobId });
      break;
    }

    const searchRes = await searchPeople(companyId, geoId, start, 12);
    const people = parsePeopleSearchResults(searchRes);
    const meta = parsePaginationMetadata(searchRes);

    if (!people || people.length === 0) {
      hasMore = false;
      break;
    }

    for (const person of people) {
      if (count >= targetCount || isPaused) break;

      const profileUrl = `https://www.linkedin.com/in/${person.profileId}/`;
      if (socket) {
        socket.emit('URL_BATCH_ITEM', {
          jobId,
          batchNumber,
          url: profileUrl,
          previewData: {
            name: person.name,
            headline: person.headline,
            location: person.location,
          },
        });
      }
      count++;
    }

    if (meta && meta.count) {
      start += meta.count;
    } else {
      start += 12;
    }
  }

  if (socket) {
    socket.emit('URL_BATCH_COMPLETE', {
      jobId,
      batchNumber,
      count,
    });
  }
}

async function handleScrapeProfile(jobId, urlId, url) {
  const loggedIn = await isLinkedInLoggedIn();
  if (!loggedIn) {
    console.warn('[Background] LinkedIn session invalid during profile scrape');
    if (socket) socket.emit('SESSION_INVALID', { jobId });
    throw new Error('Not logged into LinkedIn');
  }

  const urlParts = url.split('/in/');
  if (urlParts.length <= 1) {
    throw new Error(`Invalid LinkedIn profile URL: ${url}`);
  }

  const memberIdentity = urlParts[1].split('/')[0].split('?')[0];
  console.log(
    `[Background] Fetching profile from Voyager for memberIdentity: ${memberIdentity}`,
  );

  try {
    const response = await fetchFullProfile(memberIdentity);
    const parsedProfile = parseFullProfile(response);

    const name = `${parsedProfile.firstName} ${parsedProfile.lastName}`.trim();

    // NOTE: Email finding is now handled server-side by QualificationWorker.
    // Extension only sends the scraped profile data — no email delay.

    const rawData = {
      name,
      headline: parsedProfile.headline,
      location: parsedProfile.location || '',
      summary: parsedProfile.about,
      about: parsedProfile.about,
      publicIdentifier: parsedProfile.publicIdentifier || '',
      experience: parsedProfile.experiences.map((exp) => ({
        title: exp.title,
        company: exp.companyName,
        companyName: exp.companyName,
        startDate: exp.timePeriod?.startDate || {},
        endDate: exp.timePeriod?.endDate || {},
        timePeriod: exp.timePeriod || {},
      })),
      experiences: parsedProfile.experiences,
      education: parsedProfile.education,
      skills: parsedProfile.skills,
    };

    if (socket) {
      socket.emit('PROFILE_SCRAPED', {
        jobId,
        urlId,
        rawData,
      });
    }
  } catch (err) {
    const errorMsg = err.message || String(err);
    const isPermanent =
      errorMsg.includes('→ 403') || errorMsg.includes('→ 404');

    console.error(
      `[Background] Scrape failed for profile ${memberIdentity}:`,
      err,
    );
    if (socket) {
      socket.emit('PROFILE_SCRAPE_FAILED', {
        jobId,
        urlId,
        error: errorMsg,
        isPermanent,
      });
    }
  }
}

// ─── Sequential Email Discovery Queue ─────────────────────────────

const emailLookupQueue = [];
let isProcessingEmail = false;

function enqueueEmailLookup(jobId, payload) {
  emailLookupQueue.push({ jobId, payload });
  triggerEmailQueueProcessing();
}

function triggerEmailQueueProcessing() {
  if (isProcessingEmail) return;
  isProcessingEmail = true;
  processNextEmailLookup().catch((err) => {
    console.error('[Background] Error in email queue loop:', err);
    isProcessingEmail = false;
  });
}

async function processNextEmailLookup() {
  const item = emailLookupQueue.shift();
  if (!item) {
    isProcessingEmail = false;
    return;
  }

  const { jobId, payload } = item;
  const { urlId, url, firstName, lastName, companyName } = payload;

  console.log(
    `[Background] Processing email lookup from queue for URL ID: ${urlId}`,
  );

  try {
    const result = await findEmail(url, { firstName, lastName, companyName });
    if (result && result.ok && result.email) {
      console.log(
        `[Background] Email found for URL ID: ${urlId} -> ${result.email}`,
      );
      if (socket && socket.connected) {
        socket.emit('EMAIL_FOUND', {
          jobId,
          urlId,
          email: result.email,
          source: result.source || 'mailmeteor',
          validation: result.validation || 'unknown',
        });
      }
    } else {
      const errorMsg = result ? result.error : 'No email found';
      console.warn(
        `[Background] Email lookup failed for URL ID: ${urlId} -> ${errorMsg}`,
      );
      if (socket && socket.connected) {
        socket.emit('EMAIL_FIND_FAILED', {
          jobId,
          urlId,
          error: errorMsg || 'No email found',
        });
      }
    }
  } catch (err) {
    console.error(`[Background] Error finding email for URL ID ${urlId}:`, err);
    if (socket && socket.connected) {
      socket.emit('EMAIL_FIND_FAILED', {
        jobId,
        urlId,
        error: err.message || String(err),
      });
    }
  }

  // Process next item in queue
  setTimeout(() => processNextEmailLookup(), 0);
}
