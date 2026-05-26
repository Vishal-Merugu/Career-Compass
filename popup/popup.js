// ─── CareerCompass v2 Popup Controller ───────────────────────────

let pollInterval = null;
let activeWorkflowId = null;

document.addEventListener('DOMContentLoaded', async () => {
  const isContextValid = await checkLinkedInContext();
  if (!isContextValid) return;

  setupTabs();
  setupConfig();
  setupResults();
  setupWorkflows();

  await loadConfig();
  await refreshState();

  startPolling();
});

// ─── Tab Switching ───────────────────────────────────────────────

function setupTabs() {
  const tabs = document.querySelectorAll('.tab');
  tabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      tabs.forEach((t) => t.classList.remove('active'));
      document
        .querySelectorAll('.panel')
        .forEach((p) => p.classList.remove('active'));

      tab.classList.add('active');
      const panel = document.getElementById(`tab-${tab.dataset.tab}`);
      if (panel) panel.classList.add('active');

      if (tab.dataset.tab === 'results') loadResultsDropdown();
    });
  });
}

// ─── Config & Settings ───────────────────────────────────────────

function setupConfig() {
  document
    .getElementById('btnSaveConfig')
    .addEventListener('click', () => saveConfig());
  document.getElementById('btnCheckLlm').addEventListener('click', checkLlm);
  document
    .getElementById('cfgLlmProvider')
    .addEventListener('change', syncLlmFields);
}

function syncLlmFields() {
  const provider = document.getElementById('cfgLlmProvider').value;
  const groupUrl = document.getElementById('groupLlmUrl');
  const groupKey = document.getElementById('groupLlmApiKey');
  const modelLabel = document.getElementById('lblLlmModel');
  const fetchBtn = document.getElementById('btnCheckLlm');

  groupUrl.style.display = provider === 'ollama' ? 'block' : 'none';
  groupKey.style.display = provider === 'ollama' ? 'none' : 'block';

  if (provider === 'gemini') {
    modelLabel.textContent = '> AI Model';
    fetchBtn.querySelector('.btn-text').textContent = 'Test AI';
  } else {
    modelLabel.textContent = '> AI Model (Fetch to Populate)';
    fetchBtn.querySelector('.btn-text').textContent = 'Fetch Models';
  }
}

async function loadConfig() {
  const res = await sendMessage({ action: 'getStatus' });
  if (!res?.config) return;

  const config = res.config;

  // Settings Tab
  document.getElementById('cfgLlmProvider').value =
    config.llmProvider || 'ollama';
  document.getElementById('cfgLlmUrl').value =
    config.llmUrl || 'http://localhost:11434';
  document.getElementById('cfgLlmApiKey').value = config.llmApiKey || '';
  document.getElementById('cfgDailyLimit').value = config.dailyLimit || 15;
  document.getElementById('cfgTargetGeoId').value =
    config.targetGeoId || '101282230';
  document.getElementById('cfgEmailFinderEnabled').value =
    config.emailFinderEnabled !== false ? 'true' : 'false';

  if (config.llmModel) {
    document.getElementById('cfgLlmModel').innerHTML =
      `<option value="${config.llmModel}">${config.llmModel}</option>`;
  }

  syncLlmFields();
}

async function saveConfig() {
  const config = {
    llmProvider: document.getElementById('cfgLlmProvider').value,
    llmUrl: document.getElementById('cfgLlmUrl').value.trim(),
    llmApiKey: document.getElementById('cfgLlmApiKey').value.trim(),
    llmModel: document.getElementById('cfgLlmModel').value.trim(),
    dailyLimit:
      parseInt(document.getElementById('cfgDailyLimit').value, 10) || 15,
    targetGeoId: document.getElementById('cfgTargetGeoId').value.trim(),
    emailFinderEnabled:
      document.getElementById('cfgEmailFinderEnabled').value === 'true',
  };

  const btn = document.getElementById('btnSaveConfig');
  const textSpan = btn.querySelector('.btn-text');

  btn.classList.add('is-loading');
  await sendMessage({ action: 'saveConfig', config });
  btn.classList.remove('is-loading');

  textSpan.textContent = '✓ Saved!';
  setTimeout(() => (textSpan.textContent = 'Save Configuration'), 1500);
}

async function checkLlm() {
  const btn = document.getElementById('btnCheckLlm');
  const modelSelect = document.getElementById('cfgLlmModel');
  const statusText = document.getElementById('llmStatusText');

  btn.classList.add('is-loading');
  const config = {
    llmProvider: document.getElementById('cfgLlmProvider').value,
    llmUrl: document.getElementById('cfgLlmUrl').value.trim(),
    llmApiKey: document.getElementById('cfgLlmApiKey').value.trim(),
  };

  const res = await sendMessage({ action: 'llmHealthCheck', config });

  if (res?.ok && res.models) {
    statusText.textContent = 'Connected!';
    statusText.style.color = 'var(--tech-accent)';
    modelSelect.innerHTML = res.models
      .map((m) => `<option value="${m}">${m}</option>`)
      .join('');
  } else {
    statusText.textContent = 'Connection failed.';
    statusText.style.color = '#ef4444';
  }
  btn.classList.remove('is-loading');
}

// ─── Workflows ───────────────────────────────────────────────────

function setupWorkflows() {
  // People Finder
  document.getElementById('btnStartFinder').addEventListener('click', () => {
    const params = {
      companyUrl: document.getElementById('pfCompanyUrl').value.trim(),
      searchPrompt: document.getElementById('pfPrompt').value.trim(),
      maxResults:
        parseInt(document.getElementById('pfMaxResults').value) || 100,
    };
    if (!params.companyUrl) return alert('Company URL is required');
    startWorkflow('peopleFinder', params);
  });

  // Mass Connector
  document.getElementById('btnStartConnector').addEventListener('click', () => {
    const urlsText = document.getElementById('mcUrls').value;
    const urls = urlsText
      .split(/[\n,]+/)
      .map((u) => u.trim())
      .filter(Boolean);
    const prompt = document.getElementById('mcPrompt').value.trim();

    if (urls.length === 0)
      return alert('Please provide at least one LinkedIn URL');
    if (!prompt) return alert('Please provide a prompt for connection notes');

    startWorkflow('massConnector', { urls, prompt });
  });

  // CSV Upload for Mass Connector
  const csvInput = document.getElementById('mcCsvInput');
  const columnSelect = document.getElementById('mcColumnSelect');
  let parsedCsvData = null;

  document
    .getElementById('btnMcUploadCsv')
    .addEventListener('click', () => csvInput.click());

  csvInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      const text = event.target.result;
      parsedCsvData = parseCsvBasic(text);

      if (parsedCsvData.length > 0) {
        const headers = Object.keys(parsedCsvData[0]);
        columnSelect.style.display = 'block';
        columnSelect.innerHTML =
          '<option value="">Select URL Column...</option>' +
          headers
            .map(
              (h) =>
                `<option value="${escapeHtml(h)}">${escapeHtml(h)}</option>`,
            )
            .join('');
      }
    };
    reader.readAsText(file);
  });

  columnSelect.addEventListener('change', (e) => {
    const col = e.target.value;
    if (!col || !parsedCsvData) return;

    const urls = parsedCsvData.map((row) => row[col]).filter(Boolean);
    document.getElementById('mcUrls').value = urls.join('\n');
    document.getElementById('mcCount').textContent =
      `${urls.length} URLs loaded from CSV`;
  });

  // Update URL count manually
  document.getElementById('mcUrls').addEventListener('input', (e) => {
    const urls = e.target.value
      .split(/[\n,]+/)
      .map((u) => u.trim())
      .filter(Boolean);
    document.getElementById('mcCount').textContent =
      `${urls.length} URLs loaded`;
  });

  // Global Controls
  document
    .getElementById('btnGlobalPause')
    .addEventListener('click', async () => {
      if (activeWorkflowId)
        await sendMessage({
          action: 'workflow:pause',
          workflow: activeWorkflowId,
        });
      refreshState();
    });

  document
    .getElementById('btnGlobalStop')
    .addEventListener('click', async () => {
      if (activeWorkflowId)
        await sendMessage({
          action: 'workflow:cancel',
          workflow: activeWorkflowId,
        });
      refreshState();
    });
}

function parseCsvBasic(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return [];

  const headers = lines[0]
    .split(',')
    .map((h) => h.trim().replace(/^"|"$/g, ''));
  const data = [];

  for (let i = 1; i < lines.length; i++) {
    // Basic split, doesn't handle commas inside quotes perfectly but works for simple CSVs
    const values = lines[i]
      .split(',')
      .map((v) => v.trim().replace(/^"|"$/g, ''));
    const row = {};
    headers.forEach((h, idx) => {
      row[h] = values[idx] || '';
    });
    data.push(row);
  }
  return data;
}

async function startWorkflow(workflowId, params) {
  const res = await sendMessage({
    action: 'workflow:start',
    workflow: workflowId,
    params,
  });
  if (!res.ok) alert(res.error || 'Failed to start workflow');
  refreshState();
}

// ─── Polling & State Sync ────────────────────────────────────────

function startPolling() {
  pollInterval = setInterval(refreshState, 2000);
}

async function refreshState() {
  const res = await sendMessage({ action: 'workflow:list' });
  if (!res?.workflows) return;

  const runningWf = res.workflows.find(
    (w) => w.status === 'running' || w.status === 'paused',
  );

  if (runningWf) {
    activeWorkflowId = runningWf.id;
    updateStatusBadge(runningWf.status, runningWf.name);
    updateGlobalControls(runningWf.status, runningWf.name);
    updateWorkflowUI(runningWf);
  } else {
    activeWorkflowId = null;
    updateStatusBadge('idle', 'Ready');
    updateGlobalControls('idle', 'No active workflow');
    hideAllProgress();
  }
}

function updateStatusBadge(status, name) {
  const dot = document.getElementById('statusDot');
  const text = document.getElementById('statusText');
  dot.className = `status-dot ${status}`;

  const labels = {
    idle: 'Ready',
    running: 'RUNNING',
    paused: 'PAUSED',
    completed: 'COMPLETED',
    stoppedHalfway: 'STOPPED HALFWAY',
    error: 'ERROR',
  };
  const label = labels[status] || status.toUpperCase();
  text.textContent = status === 'idle' ? 'Ready' : `${label} (${name})`;
}

function updateGlobalControls(status, name) {
  const btnPause = document.getElementById('btnGlobalPause');
  const btnStop = document.getElementById('btnGlobalStop');
  const wfName = document.getElementById('activeWorkflowName');

  wfName.textContent =
    status === 'idle' ? 'No active workflow' : `Active: ${name}`;

  if (status === 'running') {
    btnPause.disabled = false;
    btnPause.querySelector('.btn-text').textContent = 'Pause';
    btnStop.disabled = false;
  } else if (status === 'paused') {
    btnPause.disabled = false;
    btnPause.querySelector('.btn-text').textContent = 'Resume';
    btnStop.disabled = false;
  } else {
    btnPause.disabled = true;
    btnPause.querySelector('.btn-text').textContent = 'Pause';
    btnStop.disabled = true;
  }

  // Override click for pause/resume toggle
  btnPause.onclick = async () => {
    if (status === 'running')
      await sendMessage({
        action: 'workflow:pause',
        workflow: activeWorkflowId,
      });
    if (status === 'paused')
      await sendMessage({
        action: 'workflow:resume',
        workflow: activeWorkflowId,
      });
    refreshState();
  };
}

function hideAllProgress() {
  document.getElementById('pfProgressContainer').style.display = 'none';
  document.getElementById('mcProgressContainer').style.display = 'none';

  document.getElementById('btnStartFinder').disabled = false;
}

function updateWorkflowUI(wf) {
  const isRunning = wf.status === 'running' || wf.status === 'paused';

  // Disable all start buttons if ANY workflow is running
  document.getElementById('btnStartFinder').disabled = isRunning;

  if (wf.id === 'peopleFinder') {
    const pContainer = document.getElementById('pfProgressContainer');
    const pFill = document.getElementById('pfProgressFill');
    const pText = document.getElementById('pfProgressText');

    pContainer.style.display = 'flex';
    const percent =
      wf.progress.total > 0
        ? (wf.progress.current / wf.progress.total) * 100
        : 0;
    pFill.style.width = `${percent}%`;
    pText.textContent = `${wf.progress.step} (${wf.progress.current} / ${wf.progress.total})`;
  }
}

// ─── Results Tab ─────────────────────────────────────────────────

async function setupResults() {
  document
    .getElementById('resRunSelect')
    .addEventListener('change', renderSelectedResults);
  document
    .getElementById('btnExportCsv')
    .addEventListener('click', exportResultsCsv);
  document
    .getElementById('btnPipeConnect')
    .addEventListener('click', pipeToConnect);
}

function pipeToConnect() {
  if (!currentSelectedRun || currentSelectedRun.results.length === 0) return;

  const profileIds = currentSelectedRun.results
    .map((r) => r.profileId || r.linkedinUrl)
    .filter(Boolean);
  if (profileIds.length === 0)
    return alert('No valid Profile IDs found in this run');

  // Populate the Mass Connector text area
  document.getElementById('mcUrls').value = profileIds.join('\n');
  document.getElementById('mcCount').textContent =
    `${profileIds.length} URLs piped from Finder`;

  // Switch to the Connect tab
  document.querySelector('.tab[data-tab="connect"]').click();
}

async function loadResultsDropdown() {
  const sel = document.getElementById('resRunSelect');
  sel.innerHTML = '<option value="">Loading...</option>';

  // Fetch history for all workflows
  const finderRes = await sendMessage({
    action: 'workflow:history',
    workflow: 'peopleFinder',
  });
  const connectorRes = await sendMessage({
    action: 'workflow:history',
    workflow: 'massConnector',
  });

  let options = '<option value="">Select a run...</option>';

  if (finderRes.history) {
    finderRes.history.forEach((h, i) => {
      const date = new Date(h.startedAt).toLocaleString();
      let company = '';
      if (h.params?.companyUrl) {
        try {
          const parts = h.params.companyUrl.split('/').filter(Boolean);
          const idx = parts.indexOf('company');
          if (idx !== -1 && parts[idx + 1]) {
            company = parts[idx + 1].toUpperCase();
          } else {
            company = parts[parts.length - 1].toUpperCase();
          }
        } catch {
          // fallback
        }
      }
      if (!company && h.results?.[0]?.company) {
        company = h.results[0].company.toUpperCase();
      }
      const companyTag = company ? ` [${company}]` : '';
      options += `<option value='{"wf":"peopleFinder","idx":${i}}'>People Finder${companyTag} - ${date} (${h.results.length} found)</option>`;
    });
  }

  if (connectorRes.history) {
    connectorRes.history.forEach((h, i) => {
      const date = new Date(h.startedAt).toLocaleString();
      const count = h.results.length;
      options += `<option value='{"wf":"massConnector","idx":${i}}'>Mass Connector - ${date} (${count} processed)</option>`;
    });
  }

  sel.innerHTML = options;
}

let currentSelectedRun = null;

async function renderSelectedResults() {
  const val = document.getElementById('resRunSelect').value;
  const tbody = document.getElementById('resultsBody');
  const thead = document.getElementById('resultsThead');
  const stats = document.getElementById('resStats');
  const btnExport = document.getElementById('btnExportCsv');
  const btnPipe = document.getElementById('btnPipeConnect');

  if (!val) {
    tbody.innerHTML =
      '<tr><td colspan="2" style="text-align: center; color: var(--tech-muted); padding: 20px;">Select a run to view results</td></tr>';
    stats.style.display = 'none';
    btnExport.disabled = true;
    btnPipe.disabled = true;
    currentSelectedRun = null;
    return;
  }

  const { wf, idx } = JSON.parse(val);
  const res = await sendMessage({ action: 'workflow:history', workflow: wf });
  const run = res.history[idx];
  currentSelectedRun = run;

  stats.style.display = 'flex';
  document.getElementById('resCount').textContent =
    `${run.results.length} results`;
  document.getElementById('resDate').textContent = new Date(
    run.startedAt,
  ).toLocaleString();

  btnExport.disabled = run.results.length === 0;
  btnPipe.disabled = wf !== 'peopleFinder' || run.results.length === 0;

  if (run.results.length === 0) {
    tbody.innerHTML =
      '<tr><td colspan="2" style="text-align: center; color: var(--tech-muted); padding: 20px;">No results in this run</td></tr>';
    return;
  }

  if (wf === 'peopleFinder') {
    thead.innerHTML = '<th>Person</th><th>Match Reason</th>';
    tbody.innerHTML = run.results
      .map(
        (r) => `
      <tr>
        <td>
          <strong>${escapeHtml(r.name)}</strong><br>
          <span style="color: var(--tech-muted); font-size: 9px;">${escapeHtml(r.currentRole)}</span>
          ${r.email ? `<br><span style="color: var(--tech-accent); font-size: 9px; font-family: monospace;">📧 ${escapeHtml(r.email)}</span>` : ''}
        </td>
        <td style="font-size: 10px; color: var(--tech-cyan);">${escapeHtml(r.matchReason)}</td>
      </tr>
    `,
      )
      .join('');
  } else {
    thead.innerHTML = '<th>Person</th><th>Status</th>';
    tbody.innerHTML = run.results
      .map(
        (r) => `
      <tr>
        <td>
          <strong>${escapeHtml(r.name)}</strong><br>
          <span style="color: var(--tech-muted); font-size: 9px;">${escapeHtml(r.company)}</span>
          ${r.email ? `<br><span style="color: var(--tech-accent); font-size: 9px; font-family: monospace;">📧 ${escapeHtml(r.email)}</span>` : ''}
        </td>
        <td style="font-size: 10px; color: var(--tech-accent);">${escapeHtml(r.status)}</td>
      </tr>
    `,
      )
      .join('');
  }
}

function exportResultsCsv() {
  if (!currentSelectedRun || currentSelectedRun.results.length === 0) return;

  const results = currentSelectedRun.results;
  const headers = Object.keys(results[0]);

  const rows = results.map((r) =>
    headers.map((h) => `"${String(r[h]).replace(/"/g, '""')}"`).join(','),
  );

  const csv = [headers.join(','), ...rows].join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);

  const sel = document.getElementById('resRunSelect');
  const selectedText = sel.options[sel.selectedIndex].text;
  const safeName = selectedText.replace(/[\/\\:*?"<>|]/g, '-').replace(/\s+/g, '_');

  const a = document.createElement('a');
  a.href = url;
  a.download = `${safeName}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// ─── Utilities ───────────────────────────────────────────────────

function sendMessage(msg) {
  return new Promise((resolve) => {
    if (
      typeof chrome === 'undefined' ||
      !chrome.runtime ||
      !chrome.runtime.sendMessage
    ) {
      setTimeout(() => resolve({ ok: true }), 100);
      return;
    }
    chrome.runtime.sendMessage(msg, resolve);
  });
}

function escapeHtml(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

async function checkLinkedInContext() {
  const overlay = document.getElementById('authOverlay');
  const isLocalDev =
    window.location.hostname === 'localhost' || window.location.hostname === '';

  try {
    const res = await sendMessage({ action: 'verifyContext' });
    if (isLocalDev && !chrome.runtime?.sendMessage) {
      overlay.classList.add('active');
      document.getElementById('authTitle').textContent = 'Local Preview Mode';
      return true;
    }
    if (!res.isLinkedIn || !res.isLoggedIn) {
      overlay.classList.add('active');
      return false;
    }
    overlay.classList.remove('active');
    return true;
  } catch (err) {
    return false;
  }
}
