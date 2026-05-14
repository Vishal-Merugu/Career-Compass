// ─── Popup Controller ────────────────────────────────────────────
// Handles tab switching, config, controls, and live status polling.

let pollInterval = null;

document.addEventListener("DOMContentLoaded", async () => {
  // Check context first before loading UI
  const isContextValid = await checkLinkedInContext();
  if (!isContextValid) return; // Stop initialization if invalid

  setupTabs();
  setupControls();
  setupConfig();
  setupHistory();
  await refreshAll();

  // Default to Outreach tab
  const outreachTab = document.querySelector('.tab[data-tab="outreach"]');
  if (outreachTab) outreachTab.click();

  startPolling();
});

// ─── Tab Switching ───────────────────────────────────────────────

function setupTabs() {
  const tabs = document.querySelectorAll(".tab");
  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      // Deactivate all
      tabs.forEach((t) => t.classList.remove("active"));
      document
        .querySelectorAll(".panel")
        .forEach((p) => p.classList.remove("active"));
      // Activate clicked
      tab.classList.add("active");
      const panel = document.getElementById(`tab-${tab.dataset.tab}`);
      if (panel) panel.classList.add("active");

      // Refresh data for specific tabs
      if (tab.dataset.tab === "history") loadHistory();
      if (tab.dataset.tab === "activity") refreshAll();
    });
  });
}

// ─── Controls ────────────────────────────────────────────────────

function setupControls() {
  const btnStart = document.getElementById("btnStart");
  const btnPause = document.getElementById("btnPause");
  const btnStop = document.getElementById("btnStop");

  const withLoading = async (btn, action) => {
    btn.classList.add("is-loading");
    btn.disabled = true;
    try {
      await action();
    } finally {
      btn.classList.remove("is-loading");
      btn.disabled = false;
      await refreshAll(); // Ensure states sync after action
    }
  };

  btnStart.addEventListener("click", () =>
    withLoading(btnStart, async () => {
      await sendMessage({ action: "start" });
    }),
  );

  btnPause.addEventListener("click", () =>
    withLoading(btnPause, async () => {
      await sendMessage({ action: "pause" });
    }),
  );

  btnStop.addEventListener("click", () =>
    withLoading(btnStop, async () => {
      await sendMessage({ action: "stop" });
    }),
  );

  document.getElementById("btnReset").addEventListener("click", async () => {
    const btn = document.getElementById("btnReset");
    const textSpan = btn.querySelector(".btn-text");

    btn.classList.add("is-loading");
    btn.disabled = true;

    await sendMessage({ action: "resetDaily" });
    await refreshAll();

    btn.classList.remove("is-loading");
    textSpan.textContent = "✓ Done";

    setTimeout(() => {
      textSpan.textContent = "Reset Daily Counter";
      btn.disabled = false;
    }, 1500);
  });
}

// ─── Config ──────────────────────────────────────────────────────

function setupConfig() {
  document
    .getElementById("btnSaveConfig")
    .addEventListener("click", () => saveConfig("btnSaveConfig"));
  document
    .getElementById("btnSaveConfigOutreach")
    .addEventListener("click", () => saveConfig("btnSaveConfigOutreach"));
  document.getElementById("btnCheckLlm").addEventListener("click", checkLlm);
  document
    .getElementById("btnResetAll")
    .addEventListener("click", resetAllData);
  document
    .getElementById("cfgLlmProvider")
    .addEventListener("change", syncLlmFields);
}

function syncLlmFields() {
  const provider = document.getElementById("cfgLlmProvider").value;
  const groupUrl = document.getElementById("groupLlmUrl");
  const groupKey = document.getElementById("groupLlmApiKey");
  const modelLabel = document.getElementById("lblLlmModel");
  const fetchBtn = document.getElementById("btnCheckLlm");
  const modelSelect = document.getElementById("cfgLlmModel");

  // Visibility: Gemini/OpenRouter don't usually need a custom Base URL
  groupUrl.style.display =
    provider === "ollama" || provider === "custom" ? "block" : "none";
  // Ollama doesn't need an API Key
  groupKey.style.display = provider === "ollama" ? "none" : "block";

  // Label & Fetch Button logic
  fetchBtn.style.display = "flex";
  fetchBtn.style.width = "auto";
  fetchBtn.style.padding = "0 16px";
  const btnText = fetchBtn.querySelector(".btn-text");
  const btnIcon = fetchBtn.querySelector("svg");

  btnText.style.display = "inline";
  btnText.textContent = "Test AI Connection";

  if (provider === "gemini") {
    modelLabel.textContent = "> AI Model";
    btnIcon.style.display = "none";

    // Pre-populate common Gemini models if empty
    if (modelSelect.options.length <= 1) {
      const currentModel = modelSelect.value;
      const geminiModels = [
        "gemini-1.5-flash",
        "gemini-1.5-pro",
        "gemini-1.5-flash-8b",
      ];
      modelSelect.innerHTML = geminiModels
        .map(
          (m) =>
            `<option value="${m}" ${m === currentModel ? "selected" : ""}>${m}</option>`,
        )
        .join("");
      if (!modelSelect.value) modelSelect.value = "gemini-1.5-flash";
    }
  } else {
    modelLabel.textContent = "> AI Model (Fetch to Populate)";
    btnIcon.style.display = "block";
    btnText.textContent = "Test & Fetch Models";
  }
}

async function loadConfig() {
  const res = await sendMessage({ action: "getStatus" });
  if (!res?.ok) return;

  const config = res.config;

  // Migration: Clear old hardcoded IP if found
  let llmUrl = config.llmUrl || "";
  if (llmUrl.includes("192.168.31.217")) {
    llmUrl = "http://localhost:11434";
  }

  document.getElementById("cfgKeywords").value = config.keywords || "";
  document.getElementById("cfgLocations").value = config.locations || "";
  document.getElementById("cfgDailyLimit").value = config.dailyLimit || 15;
  document.getElementById("cfgLlmProvider").value =
    config.llmProvider || "ollama";
  document.getElementById("cfgLlmUrl").value = llmUrl;
  document.getElementById("cfgLlmApiKey").value = config.llmApiKey || "";
  document.getElementById("cfgUserContext").value = config.userContext || "";
  document.getElementById("cfgTargetGeoId").value =
    config.targetGeoId || "101282230";

  // Sync visibility
  syncLlmFields();

  // Pre-populate model if exists
  if (config.llmModel) {
    const modelSelect = document.getElementById("cfgLlmModel");
    modelSelect.innerHTML = `<option value="${config.llmModel}">${config.llmModel}</option>`;
  }
}

async function saveConfig(buttonId = "btnSaveConfig") {
  const config = {
    keywords: document.getElementById("cfgKeywords").value.trim(),
    locations: document.getElementById("cfgLocations").value.trim(),
    dailyLimit:
      parseInt(document.getElementById("cfgDailyLimit").value, 10) || 15,
    llmProvider: document.getElementById("cfgLlmProvider").value,
    llmUrl: document.getElementById("cfgLlmUrl").value.trim(),
    llmApiKey: document.getElementById("cfgLlmApiKey").value.trim(),
    llmModel: document.getElementById("cfgLlmModel").value.trim(),
    userContext: document.getElementById("cfgUserContext").value.trim(),
    targetGeoId: document.getElementById("cfgTargetGeoId").value.trim(),
  };

  const btn = document.getElementById(buttonId);
  const textSpan = btn.querySelector(".btn-text");
  const originalText = textSpan.textContent;

  btn.classList.add("is-loading");
  btn.disabled = true;
  textSpan.textContent = "Saving...";

  await sendMessage({ action: "saveConfig", config });

  btn.classList.remove("is-loading");
  textSpan.textContent = "✓ Saved!";

  setTimeout(() => {
    textSpan.textContent = originalText;
    btn.disabled = false;
  }, 1500);
}

async function resetAllData() {
  const confirmed = confirm(
    "Are you sure you want to PERMANENTLY reset all data? This will clear all connection history, company logs, and configurations.",
  );
  if (!confirmed) return;

  const btn = document.getElementById("btnResetAll");
  btn.classList.add("is-loading");
  btn.disabled = true;

  const res = await sendMessage({ action: "resetAllData" });
  if (res?.ok) {
    alert("Extension has been reset to factory settings.");
    window.location.reload();
  }
}

async function checkLlm() {
  const btn = document.getElementById("btnCheckLlm");
  const modelSelect = document.getElementById("cfgLlmModel");
  const statusText = document.getElementById("llmStatusText");

  const provider = document.getElementById("cfgLlmProvider").value;

  btn.classList.add("is-loading");
  btn.disabled = true;
  statusText.textContent =
    provider === "gemini" ? "Testing connection..." : "Fetching models...";
  statusText.style.color = "var(--tech-muted)";

  const config = {
    llmProvider: document.getElementById("cfgLlmProvider").value,
    llmUrl: document.getElementById("cfgLlmUrl").value.trim(),
    llmApiKey: document.getElementById("cfgLlmApiKey").value.trim(),
  };

  const res = await sendMessage({ action: "llmHealthCheck", config });

  if (res?.ok && res.models) {
    statusText.textContent = `Connected! Found ${res.models.length} models.`;
    statusText.style.color = "var(--tech-accent)";

    // Populate select
    const currentModel = modelSelect.value;
    modelSelect.innerHTML = res.models
      .map(
        (m) =>
          `<option value="${m}" ${m === currentModel ? "selected" : ""}>${m}</option>`,
      )
      .join("");

    if (!modelSelect.value && res.models.length > 0) {
      modelSelect.value = res.models[0];
    }
  } else {
    statusText.textContent = "LLM connection failed. Check your config/key.";
    statusText.style.color = "#ef4444";
  }

  btn.classList.remove("is-loading");
  btn.disabled = false;
}

// ─── Verification & Context ──────────────────────────────────────

async function checkLinkedInContext() {
  const overlay = document.getElementById("authOverlay");
  const title = document.getElementById("authTitle");
  const message = document.getElementById("authMessage");

  // Local testing bypass logic
  const isLocalDev =
    window.location.hostname === "localhost" || window.location.hostname === "";

  try {
    const res = await sendMessage({ action: "verifyContext" });

    // If we're testing locally outside extension, mock failure to test overlay
    if (isLocalDev && !chrome.runtime?.sendMessage) {
      overlay.classList.add("active");
      title.textContent = "Local Preview Mode";
      message.textContent =
        "This is a local webpage, not a Chrome Extension context. The UI works, but background logic requires LinkedIn.";
      // We will still allow the UI to load for styling purposes by returning true below,
      // but normally this would block.
      return true;
    }

    if (!res.isLinkedIn) {
      overlay.classList.add("active");
      title.textContent = "LinkedIn Required";
      message.textContent =
        "You can only use this extension inside a LinkedIn tab or page.";
      return false;
    }

    if (!res.isLoggedIn) {
      overlay.classList.add("active");
      title.textContent = "Authentication Required";
      message.textContent =
        "It looks like you aren't logged into LinkedIn. Please sign in to continue.";
      return false;
    }

    // Context is valid
    overlay.classList.remove("active");
    return true;
  } catch (err) {
    console.error("Context check failed:", err);
    return false;
  }
}

// ─── Dashboard Refresh ──────────────────────────────────────────

async function refreshAll() {
  const res = await sendMessage({ action: "getStatus" });
  if (!res?.ok) return;

  // Status badge
  updateStatusBadge(res.status);

  // Stats
  const stats = res.stats || {};
  document.getElementById("statConnections").textContent =
    stats.connectionsSent || 0;
  document.getElementById("statLimit").textContent =
    res.config?.dailyLimit || 15;
  document.getElementById("statJobs").textContent = stats.jobsFound || 0;
  document.getElementById("statCompanies").textContent =
    stats.companiesProcessed || 0;

  // Activity log
  renderActivityLog(res.activity || []);

  // Config (only if config tab fields are empty)
  if (!document.getElementById("cfgKeywords").value) {
    await loadConfig();
  }
}

function updateStatusBadge(status) {
  const dot = document.getElementById("statusDot");
  const text = document.getElementById("statusText");
  const currentStatus = status || "idle";

  dot.className = `status-dot ${currentStatus}`;

  let label = currentStatus.charAt(0).toUpperCase() + currentStatus.slice(1);
  if (currentStatus === "idle") label = "Ready";

  text.textContent = label;

  // Contextual Button Disabling
  const btnStart = document.getElementById("btnStart");
  const btnPause = document.getElementById("btnPause");
  const btnStop = document.getElementById("btnStop");

  // Only manage state if button isn't actively loading
  if (!btnStart.classList.contains("is-loading")) {
    btnStart.disabled = currentStatus === "running";
  }
  if (!btnPause.classList.contains("is-loading")) {
    btnPause.disabled = currentStatus !== "running";
  }
  if (!btnStop.classList.contains("is-loading")) {
    btnStop.disabled = currentStatus === "idle";
  }
}

function renderActivityLog(entries) {
  const container = document.getElementById("activityLog");
  const countBadge = document.getElementById("logCount");
  countBadge.textContent = entries.length;

  if (!entries.length) {
    container.innerHTML =
      '<div class="log-empty">No activity yet — start the pipeline!</div>';
    return;
  }

  container.innerHTML = entries
    .map((e) => {
      const time = new Date(e.time).toLocaleTimeString("en-US", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      });
      return `<div class="log-entry"><span class="log-time">${time}</span>${escapeHtml(e.message)}</div>`;
    })
    .join("");
}

// ─── History ─────────────────────────────────────────────────────

function setupHistory() {
  document.getElementById("btnExportCSV").addEventListener("click", exportCSV);
}

async function loadHistory() {
  const res = await sendMessage({ action: "getHistory" });
  const log = res?.log || [];
  const tbody = document.getElementById("historyBody");

  if (!log.length) {
    tbody.innerHTML =
      '<tr class="history-empty"><td colspan="4">No connections sent yet</td></tr>';
    return;
  }

  tbody.innerHTML = log
    .map((e) => {
      const date = new Date(e.timestamp).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
      });
      const statusClass = e.status === "sent" ? "status-sent" : "status-failed";
      return `<tr>
      <td>${date}</td>
      <td title="${escapeHtml(e.name || "")}">${escapeHtml(e.name || "—")}</td>
      <td title="${escapeHtml(e.company || "")}">${escapeHtml(e.company || "—")}</td>
      <td class="${statusClass}">${e.status || "—"}</td>
    </tr>`;
    })
    .join("");
}

async function exportCSV() {
  const res = await sendMessage({ action: "getHistory" });
  const log = res?.log || [];
  if (!log.length) return;

  const headers = ["Date", "Name", "ProfileID", "Company", "Message", "Status"];
  const rows = log.map((e) => [
    e.timestamp || "",
    e.name || "",
    e.profileId || "",
    e.company || "",
    `"${(e.message || "").replace(/"/g, '""')}"`,
    e.status || "",
  ]);

  const csv = [headers.join(","), ...rows.map((r) => r.join(","))].join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);

  const a = document.createElement("a");
  a.href = url;
  a.download = `linkedin-outreach-${new Date().toISOString().split("T")[0]}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// ─── Polling ─────────────────────────────────────────────────────

function startPolling() {
  // Poll every 3 seconds for live updates
  pollInterval = setInterval(refreshAll, 3000);
}

// ─── Utilities ───────────────────────────────────────────────────

function sendMessage(msg) {
  return new Promise((resolve) => {
    if (
      typeof chrome === "undefined" ||
      !chrome.runtime ||
      !chrome.runtime.sendMessage
    ) {
      console.warn("[Local Preview] Mocking sendMessage:", msg);
      setTimeout(
        () => resolve({ ok: true, config: {}, status: "idle", stats: {} }),
        300,
      );
      return;
    }
    chrome.runtime.sendMessage(msg, resolve);
  });
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}
