// ─── Storage Module ───────────────────────────────────────────────
// Typed wrappers around chrome.storage.local for essential config,
// and backend API syncing for all data (stats, logs, companies).

const DEFAULT_CONFIG = {
  keywords: 'Werkstudent, Internship, Praktikum',
  locations: 'Erlangen, Nuremberg, Munich',
  dailyLimit: 15,
  llmProvider: 'ollama', // 'ollama' | 'gemini' | 'openrouter' | 'custom'
  llmApiKey: '',
  llmUrl: 'http://localhost:11434',
  llmModel: 'qwen2.5:1.5b',
  userContext: '',
  targetGeoId: '101282230',
  emailFinderEnabled: true,
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
  const finalConfig = { ...DEFAULT_CONFIG, ...config };

  // Always force backend URL from code-level default configuration
  finalConfig.backendUrl = DEFAULT_CONFIG.backendUrl;

  // Migration: Clear old hardcoded IP
  if (finalConfig.llmUrl && finalConfig.llmUrl.includes('192.168.31.217')) {
    finalConfig.llmUrl = 'http://localhost:11434';
  }

  return finalConfig;
}

async function setConfig(config) {
  await storageSet('config', config);
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
    apiSync,
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
