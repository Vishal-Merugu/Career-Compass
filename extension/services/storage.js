// ─── Storage Module ───────────────────────────────────────────────
// Typed wrappers around chrome.storage.local for essential config,
// and backend API syncing for all data (stats, logs, companies).

// Only what the extension itself still uses.
//
// The AI settings, the search prompt and the geo id are gone: they are read
// and written in the dashboard, and the extension no longer talks to a model
// at all. `dailyLimit` and `emailFinderEnabled` stay because the mass
// connector reads them; both arrive from the server and are never written back
// from here.
const DEFAULT_CONFIG = {
  dailyLimit: 15,
  emailFinderEnabled: true,
  userContext: '',
  backendUrl: 'http://localhost:3000',
  apiKey: '', // Empty by default so user is prompted to login
};

// ─── Helpers ──────────────────────────────────────────────────────

async function storageGet(key) {
  if (typeof chrome === 'undefined' || !chrome.storage) return null;
  return new Promise((resolve) => {
    chrome.storage.local.get(key, (res) => resolve(res[key]));
  });
}

async function storageSet(key, value) {
  if (typeof chrome === 'undefined' || !chrome.storage) return;
  return new Promise((resolve) => {
    chrome.storage.local.set({ [key]: value }, resolve);
  });
}

// ─── App Config ──────────────────────────────────────────────────

async function getConfig() {
  const config = (await storageGet('config')) || {};
  return { ...DEFAULT_CONFIG, ...config };
}

/**
 * Save local wiring only.
 *
 * **This no longer pushes anything to the server.** It used to send the whole
 * local config to `/api/config` on every save while `syncConfigFromServer`
 * pulled and merged the server's copy on load — two writers on one row, last
 * write wins. Settings live in the dashboard now; the extension reads them.
 *
 * `apiKey` and `backendUrl` are how this extension reaches the server. They
 * are local wiring and are the only things it still owns.
 */
async function setConfig(config) {
  await storageSet('config', config);
}

async function syncConfigFromServer() {
  const localConfig = (await storageGet('config')) || {};
  const finalConfig = { ...DEFAULT_CONFIG, ...localConfig };

  if (!finalConfig.apiKey || !finalConfig.backendUrl) return finalConfig;

  try {
    const res = await fetch(`${finalConfig.backendUrl}/api/config`, {
      headers: { 'X-API-Key': finalConfig.apiKey },
    });
    if (res.ok) {
      const data = await res.json();
      if (data?.config) {
        const cleanRemoteConfig = Object.fromEntries(
          Object.entries(data.config).filter(([_, v]) => v != null),
        );
        const mergedConfig = { ...finalConfig, ...cleanRemoteConfig };
        mergedConfig.apiKey = finalConfig.apiKey;
        mergedConfig.backendUrl = finalConfig.backendUrl;

        await storageSet('config', mergedConfig);
        return mergedConfig;
      }
    }
  } catch (err) {
    console.error('[Storage] Failed to sync config from server:', err);
  }
  return finalConfig;
}

// ─── Backend API Sync Helper ─────────────────────────────────────

async function apiSync(path, method = 'GET', body = null) {
  const config = await getConfig();
  if (!config.apiKey || !config.backendUrl) return null;

  const options = {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': config.apiKey,
    },
  };
  if (body) options.body = JSON.stringify(body);

  try {
    const res = await fetch(`${config.backendUrl}${path}`, options);
    const data = await res.json();
    return data;
  } catch (err) {
    console.error(`[Storage Sync API Error] ${method} ${path}:`, err);
    return null;
  }
}

// ─── Connection notes ────────────────────────────────────────────

/**
 * Ask the server to write a connection note.
 *
 * The model runs server-side now. Sending the invitation is still done here —
 * a write to someone else's account is the most restriction-prone call in this
 * product, and at 15 a day there is no throughput to gain by moving it.
 */
async function generateConnectionNote(profile) {
  const res = await apiSync('/api/connections/message', 'POST', profile);

  if (!res) {
    return { ok: false, error: 'Could not reach the CareerCompass server' };
  }
  if (!res.ok) {
    return { ok: false, error: res.error || 'The AI model failed' };
  }
  return { ok: true, message: res.message };
}

// ─── Processed Companies (dedup) ─────────────────────────────────

async function getProcessedCompanies() {
  const data = await apiSync('/api/sync/companies');
  return data?.companies || [];
}

async function addProcessedCompany(companyId) {
  await apiSync('/api/sync/companies', 'POST', { companyId });
}

async function isCompanyProcessed(companyId) {
  const list = await getProcessedCompanies();
  return list.includes(companyId);
}

// ─── Contacted Profiles (dedup) ──────────────────────────────────

async function getContactedProfiles() {
  const data = await apiSync('/api/sync/contacted-profiles');
  return data?.profiles || [];
}

async function addContactedProfile(profileId) {
  // Implicitly added when sending an outreach log with action=connection_sent
}

async function isProfileContacted(profileId) {
  const list = await getContactedProfiles();
  return list.includes(profileId);
}

// ─── Outreach Log ────────────────────────────────────────────────

async function getOutreachLog() {
  const data = await apiSync('/api/sync/outreach-log');
  return data?.logs || [];
}

async function addLogEntry(entry) {
  await apiSync('/api/sync/outreach-log', 'POST', entry);
}

// ─── Activity Log (last 20 for dashboard) ────────────────────────

async function getActivityLog() {
  const data = await apiSync('/api/sync/activity-log');
  return data?.logs || [];
}

async function addActivityEntry(message) {
  await apiSync('/api/sync/activity-log', 'POST', { message });
}

// ─── Daily Stats ─────────────────────────────────────────────────

function getTodayKey() {
  return new Date().toISOString().split('T')[0]; // YYYY-MM-DD
}

async function getDailyStats() {
  const data = await apiSync('/api/sync/daily-stats');
  return (
    data?.stats || {
      date: getTodayKey(),
      connectionsSent: 0,
      jobsFound: 0,
      companiesProcessed: 0,
      targetsFound: 0,
    }
  );
}

async function updateDailyStats(updates) {
  // Not heavily used in this architecture directly, mapped to increment
  for (const [key, val] of Object.entries(updates)) {
    if (typeof val === 'number' && val > 0) {
      await incrementDailyStat(key, val);
    }
  }
}

async function incrementDailyStat(key, amount = 1) {
  await apiSync('/api/sync/daily-stats/increment', 'POST', { key, amount });
}

async function resetDailyStats() {
  await apiSync('/api/sync/daily-stats/reset', 'POST');
}

// ─── Reset ───────────────────────────────────────────────────────

async function clearAllData() {
  // Clear local config + state
  await chrome.storage.local.clear();
  // We do NOT clear the backend databases here for safety
}

// ─── Export ──────────────────────────────────────────────────────

// Make available globally for other scripts (no module system in MV3 service worker imports)
if (typeof globalThis !== 'undefined') {
  Object.assign(globalThis, {
    DEFAULT_CONFIG,
    getConfig,
    setConfig,
    syncConfigFromServer,
    apiSync,
    generateConnectionNote,
    getProcessedCompanies,
    addProcessedCompany,
    isCompanyProcessed,
    getContactedProfiles,
    addContactedProfile,
    isProfileContacted,
    getOutreachLog,
    addLogEntry,
    getActivityLog,
    addActivityEntry,
    getDailyStats,
    updateDailyStats,
    incrementDailyStat,
    resetDailyStats,
    clearAllData,
  });
}
