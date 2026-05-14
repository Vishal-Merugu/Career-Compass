// ─── Storage Module ───────────────────────────────────────────────
// Typed wrappers around chrome.storage.local for all extension state.

const DEFAULT_CONFIG = {
  keywords: "Werkstudent, Internship, Praktikum",
  locations: "Erlangen, Nuremberg, Munich",
  dailyLimit: 15,
  llmProvider: "ollama", // 'ollama' | 'gemini' | 'openrouter' | 'custom'
  llmApiKey: "",
  llmUrl: "http://localhost:11434",
  llmModel: "qwen2.5:1.5b",
  userContext: "",
  targetGeoId: "101282230",
};

// ─── Helpers ──────────────────────────────────────────────────────

async function storageGet(key) {
  const result = await chrome.storage.local.get(key);
  return result[key];
}

async function storageSet(key, value) {
  await chrome.storage.local.set({ [key]: value });
}

// ─── Config ───────────────────────────────────────────────────────

async function getConfig() {
  const config = await storageGet("config");
  // Merge with defaults so new fields are always present
  const finalConfig = { ...DEFAULT_CONFIG, ...config };

  // Migration: Clear old hardcoded IP
  if (finalConfig.llmUrl && finalConfig.llmUrl.includes("192.168.31.217")) {
    finalConfig.llmUrl = "http://localhost:11434";
  }

  return finalConfig;
}

async function setConfig(config) {
  await storageSet("config", config);
}

// ─── Processed Companies (dedup) ─────────────────────────────────

async function getProcessedCompanies() {
  return (await storageGet("processedCompanies")) || [];
}

async function addProcessedCompany(companyId) {
  const list = await getProcessedCompanies();
  if (!list.includes(companyId)) {
    list.push(companyId);
    await storageSet("processedCompanies", list);
  }
}

async function isCompanyProcessed(companyId) {
  const list = await getProcessedCompanies();
  return list.includes(companyId);
}

// ─── Contacted Profiles (dedup) ──────────────────────────────────

async function getContactedProfiles() {
  return (await storageGet("contactedProfiles")) || [];
}

async function addContactedProfile(profileId) {
  const list = await getContactedProfiles();
  if (!list.includes(profileId)) {
    list.push(profileId);
    await storageSet("contactedProfiles", list);
  }
}

async function isProfileContacted(profileId) {
  const list = await getContactedProfiles();
  return list.includes(profileId);
}

// ─── Outreach Log ────────────────────────────────────────────────

async function getOutreachLog() {
  return (await storageGet("outreachLog")) || [];
}

async function addLogEntry(entry) {
  const log = await getOutreachLog();
  log.unshift({
    ...entry,
    timestamp: new Date().toISOString(),
  });
  // Keep last 500 entries
  if (log.length > 500) log.length = 500;
  await storageSet("outreachLog", log);
}

// ─── Activity Log (last 20 for dashboard) ────────────────────────

async function getActivityLog() {
  return (await storageGet("activityLog")) || [];
}

async function addActivityEntry(message) {
  const log = await getActivityLog();
  log.unshift({
    message,
    time: new Date().toISOString(),
  });
  if (log.length > 20) log.length = 20;
  await storageSet("activityLog", log);
}

// ─── Daily Stats ─────────────────────────────────────────────────

function getTodayKey() {
  return new Date().toISOString().split("T")[0]; // YYYY-MM-DD
}

async function getDailyStats() {
  const stats = await storageGet("dailyStats");
  if (!stats || stats.date !== getTodayKey()) {
    // Auto-reset on new day
    const fresh = {
      date: getTodayKey(),
      connectionsSent: 0,
      jobsFound: 0,
      companiesProcessed: 0,
      targetsFound: 0,
    };
    await storageSet("dailyStats", fresh);
    return fresh;
  }
  return stats;
}

async function updateDailyStats(updates) {
  const stats = await getDailyStats();
  Object.assign(stats, updates);
  await storageSet("dailyStats", stats);
  return stats;
}

async function incrementDailyStat(key, amount = 1) {
  const stats = await getDailyStats();
  stats[key] = (stats[key] || 0) + amount;
  await storageSet("dailyStats", stats);
  return stats;
}

async function resetDailyStats() {
  const fresh = {
    date: getTodayKey(),
    connectionsSent: 0,
    jobsFound: 0,
    companiesProcessed: 0,
    targetsFound: 0,
  };
  await storageSet("dailyStats", fresh);
  return fresh;
}

// ─── Pipeline State (for pause/resume) ───────────────────────────

async function getPipelineState() {
  return (
    (await storageGet("pipelineState")) || {
      status: "idle", // 'running' | 'paused' | 'idle'
      currentStep: 0,
      jobQueue: [],
      companyQueue: [],
      targetQueue: [],
      profileQueue: [],
      messageQueue: [],
    }
  );
}

async function setPipelineState(state) {
  await storageSet("pipelineState", state);
}

async function getPipelineStatus() {
  const state = await getPipelineState();
  return state.status;
}

async function setPipelineStatus(status) {
  const state = await getPipelineState();
  state.status = status;
  await storageSet("pipelineState", state);
}

// ─── Reset ───────────────────────────────────────────────────────

async function clearAllData() {
  await chrome.storage.local.clear();
  // The next call to getConfig() or others will re-initialize with defaults
}

// ─── Export ──────────────────────────────────────────────────────

// Make available globally for other scripts (no module system in MV3 service worker imports)
if (typeof globalThis !== "undefined") {
  Object.assign(globalThis, {
    DEFAULT_CONFIG,
    getConfig,
    setConfig,
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
    getPipelineState,
    setPipelineState,
    getPipelineStatus,
    setPipelineStatus,
    clearAllData,
  });
}
