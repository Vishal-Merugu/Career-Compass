// ─── CareerCompass v2 Popup Controller ───────────────────────────

let pollInterval = null;
let activeWorkflowId = null;

document.addEventListener('DOMContentLoaded', async () => {
  const isContextValid = await checkLinkedInContext();
  if (!isContextValid) return;

  setupAuth();
  setupTabs();
  setupConfig();
  setupResults();
  setupWorkflows();

  const statusRes = await sendMessage({ action: 'getStatus' });
  const config = statusRes?.config || {};

  if (!config.apiKey || config.apiKey === 'dev-api-key-careercompass') {
    document.getElementById('loginOverlay').style.display = 'flex';
  } else {
    document.getElementById('loginOverlay').style.display = 'none';
    await loadConfig();
    await refreshState();
    startPolling();
  }
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
  const statusRes = await sendMessage({ action: 'getStatus' });
  const currentConfig = statusRes?.config || {};

  const newConfig = {
    ...currentConfig,
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
  await sendMessage({ action: 'saveConfig', config: newConfig });

  // Sync to backend
  if (currentConfig.apiKey) {
    try {
      const backendUrl = currentConfig.backendUrl || 'http://localhost:3000';
      await fetch(`${backendUrl}/api/config`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': currentConfig.apiKey,
        },
        body: JSON.stringify(newConfig),
      });
    } catch (e) {
      console.error('Failed to sync config to backend:', e);
    }
  }

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
  const statusRes = await sendMessage({ action: 'getStatus' });
  const config = statusRes?.config;

  if (workflowId === 'peopleFinder') {
    const backendUrl = config?.backendUrl || 'http://localhost:3000';
    const apiKey = config?.apiKey;

    if (!apiKey) {
      throw new Error(
        'You must be logged in to start a search. Please log in first.',
      );
    }

    try {
      const body = {
        limitRequested: params.maxResults || 20,
        searchParams: {
          companyUrl: params.companyUrl,
          prompt: params.searchPrompt || '',
          batchSize: 100,
        },
      };

      const res = await fetch(`${backendUrl}/api/jobs`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': apiKey,
        },
        body: JSON.stringify(body),
      });

      const data = await res.json();
      if (!res.ok || !data.ok) {
        throw new Error(
          data.error || data.message || 'Server error starting job',
        );
      }

      const userId = data.job.userId;
      const jobId = data.jobId;

      await chrome.storage.local.set({
        activeServerJob: {
          jobId,
          userId,
          limitRequested: params.maxResults || 20,
        },
      });

      await sendMessage({ action: 'job:start', jobId, userId });
    } catch (err) {
      alert(`Failed to start job on server: ${err.message}`);
    }
  } else {
    const res = await sendMessage({
      action: 'workflow:start',
      workflow: workflowId,
      params,
    });
    if (!res.ok) alert(res.error || 'Failed to start workflow');
  }
  refreshState();
}

// ─── Polling & State Sync ────────────────────────────────────────

function startPolling() {
  pollInterval = setInterval(refreshState, 2000);
}

async function refreshState() {
  const statusRes = await sendMessage({ action: 'getStatus' });
  const config = statusRes?.config;
  const backendUrl = config?.backendUrl || 'http://localhost:3000';
  const apiKey = config?.apiKey || 'dev-api-key-careercompass';

  const activeServerJob = await chrome.storage.local.get('activeServerJob');
  const serverJob = activeServerJob?.activeServerJob;

  if (serverJob) {
    try {
      const res = await fetch(
        `${backendUrl}/api/jobs/${serverJob.jobId}/status`,
        {
          headers: {
            'X-API-Key': apiKey,
          },
        },
      );
      const data = await res.json();
      if (res.ok && data.ok) {
        const jobStatus = data.job?.status || data.status;
        const scrapedCount = data.stats?.scrapedCount ?? data.scrapedCount ?? 0;
        const collectedCount =
          data.stats?.collectedCount ?? data.collectedCount ?? 0;
        const qualifiedCount =
          data.job?.qualifiedCount ?? data.qualifiedCount ?? 0;

        const statusMap = {
          initializing: 'running',
          collecting_urls: 'running',
          scraping: 'running',
          paused_error: 'paused',
          completed: 'completed',
          failed: 'error',
        };

        const mappedStatus = statusMap[jobStatus] || 'idle';
        const displayStep =
          jobStatus === 'collecting_urls'
            ? 'Collecting URLs...'
            : `Scraped ${scrapedCount} profiles (${qualifiedCount}/${serverJob.limitRequested || 20} qualified)`;

        const mockWf = {
          id: 'peopleFinder',
          name: 'People Finder (Server)',
          status: mappedStatus,
          progress: {
            total: serverJob.limitRequested || 20,
            current: qualifiedCount,
            step: displayStep,
          },
        };

        updateStatusBadge(mappedStatus, mockWf.name);
        updateGlobalControls(mappedStatus, mockWf.name);
        updateWorkflowUI(mockWf);

        if (
          mappedStatus === 'completed' ||
          mappedStatus === 'error' ||
          jobStatus === 'completed'
        ) {
          await chrome.storage.local.remove('activeServerJob');
          await sendMessage({ action: 'job:stop' });
        }
        return;
      }
    } catch (err) {
      console.error('Failed to sync server job status:', err);
    }
  }

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

  btnPause.onclick = async () => {
    const activeServerJob = await chrome.storage.local.get('activeServerJob');
    const serverJob = activeServerJob?.activeServerJob;
    const statusRes = await sendMessage({ action: 'getStatus' });
    const config = statusRes?.config;
    const backendUrl = config?.backendUrl || 'http://localhost:3000';
    const apiKey = config?.apiKey || 'dev-api-key-careercompass';

    if (serverJob) {
      const endpoint = status === 'running' ? 'pause' : 'resume';
      try {
        await fetch(`${backendUrl}/api/jobs/${serverJob.jobId}/${endpoint}`, {
          method: 'POST',
          headers: {
            'X-API-Key': apiKey,
          },
        });
      } catch (err) {
        alert(`Failed to ${endpoint} job on server: ${err.message}`);
      }
    } else {
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
    }
    refreshState();
  };

  btnStop.onclick = async () => {
    const activeServerJob = await chrome.storage.local.get('activeServerJob');
    const serverJob = activeServerJob?.activeServerJob;
    const statusRes = await sendMessage({ action: 'getStatus' });
    const config = statusRes?.config;
    const backendUrl = config?.backendUrl || 'http://localhost:3000';
    const apiKey = config?.apiKey || 'dev-api-key-careercompass';

    if (serverJob) {
      try {
        await fetch(`${backendUrl}/api/jobs/${serverJob.jobId}/cancel`, {
          method: 'POST',
          headers: {
            'X-API-Key': apiKey,
          },
        });
        await chrome.storage.local.remove('activeServerJob');
        await sendMessage({ action: 'job:stop' });
      } catch (err) {
        alert(`Failed to stop job on server: ${err.message}`);
      }
    } else {
      if (activeWorkflowId) {
        await sendMessage({
          action: 'workflow:cancel',
          workflow: activeWorkflowId,
        });
      }
    }
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
  if (
    !currentSelectedRun ||
    !currentSelectedRun.results ||
    currentSelectedRun.results.length === 0
  )
    return;

  const profileIds = currentSelectedRun.results
    .map((r) => r.profileId || r.linkedinUrl || r.url) // Added r.url fallback
    .filter(Boolean);
  if (profileIds.length === 0)
    return alert('No valid Profile URLs found in this run');

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

  const statusRes = await sendMessage({ action: 'getStatus' });
  const config = statusRes?.config;
  const backendUrl = config?.backendUrl || 'http://localhost:3000';
  const apiKey = config?.apiKey;

  let options = '<option value="">Select a run...</option>';

  // Fetch server jobs
  if (apiKey) {
    try {
      const res = await fetch(`${backendUrl}/api/jobs`, {
        headers: { 'X-API-Key': apiKey },
      });
      const data = await res.json();
      if (res.ok && data.jobs) {
        data.jobs.forEach((job, i) => {
          const date = new Date(job.createdAt).toLocaleString();
          let company = '';
          if (job.searchParams?.companyUrl) {
            try {
              const parts = job.searchParams.companyUrl
                .split('/')
                .filter(Boolean);
              const idx = parts.indexOf('company');
              if (idx !== -1 && parts[idx + 1])
                company = parts[idx + 1].toUpperCase();
              else company = parts[parts.length - 1].toUpperCase();
            } catch {}
          }
          const companyTag = company ? ` [${company}]` : '';
          options += `<option value='{"wf":"serverJob","id":"${job.id}"}'>Server Search${companyTag} - ${date} (${job.qualifiedCount} qualified)</option>`;
        });
      }
    } catch (err) {
      console.error('Failed to fetch server jobs:', err);
    }
  }

  // Fetch massConnector history from backend
  if (apiKey) {
    try {
      const res = await fetch(
        `${backendUrl}/api/sync/workflow-history?type=massConnector`,
        {
          headers: { 'X-API-Key': apiKey },
        },
      );
      const data = await res.json();
      if (res.ok && data.history) {
        data.history.forEach((h, i) => {
          const date = new Date(h.startedAt).toLocaleString();
          const count = h.results.length;
          // Store backend ID in the option value so we can fetch it via the same history array locally by caching it,
          // or we just fetch the history array again when selecting.
          // To keep it simple, we'll store the index, and fetch history again when rendering, just like local history.
          options += `<option value='{"wf":"massConnector","idx":${i}}'>Mass Connector - ${date} (${count} processed)</option>`;
        });
      }
    } catch (err) {
      console.error('Failed to fetch massConnector history:', err);
    }
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

  const { wf, idx, id } = JSON.parse(val);

  if (wf === 'serverJob') {
    const statusRes = await sendMessage({ action: 'getStatus' });
    const config = statusRes?.config;
    const backendUrl = config?.backendUrl || 'http://localhost:3000';
    const apiKey = config?.apiKey;

    try {
      const res = await fetch(`${backendUrl}/api/jobs/${id}/status`, {
        headers: { 'X-API-Key': apiKey },
      });
      const data = await res.json();
      if (!res.ok) throw new Error('Failed to load job details');

      const run = {
        results: data.decisions || [],
        startedAt: data.job.createdAt,
      };
      currentSelectedRun = run;

      stats.style.display = 'flex';
      document.getElementById('resCount').textContent =
        `${run.results.length} results`;
      document.getElementById('resDate').textContent = new Date(
        run.startedAt,
      ).toLocaleString();

      btnExport.disabled = run.results.length === 0;
      btnPipe.disabled = run.results.length === 0;

      if (run.results.length === 0) {
        tbody.innerHTML =
          '<tr><td colspan="2" style="text-align: center; color: var(--tech-muted); padding: 20px;">No results in this run</td></tr>';
        return;
      }

      thead.innerHTML = '<th>Person</th><th>Match Status</th>';
      tbody.innerHTML = run.results
        .map(
          (r) => `
        <tr>
          <td>
            <strong>${escapeHtml(r.name)}</strong><br>
            <span style="color: var(--tech-muted); font-size: 9px;">${escapeHtml(r.headline)}</span>
            ${r.email ? `<br><span style="color: var(--tech-accent); font-size: 9px; font-family: monospace;">📧 ${escapeHtml(r.email)}</span>` : ''}
          </td>
          <td style="font-size: 10px; color: ${r.isQualified ? 'var(--tech-cyan)' : 'var(--tech-muted)'};">
            ${r.isQualified ? 'Qualified' : 'Not Qualified'}
          </td>
        </tr>
      `,
        )
        .join('');
    } catch (err) {
      tbody.innerHTML = `<tr><td colspan="2" style="color: red;">Error: ${err.message}</td></tr>`;
    }
  } else {
    // Backend Mass Connector History
    const statusRes = await sendMessage({ action: 'getStatus' });
    const config = statusRes?.config;
    const backendUrl = config?.backendUrl || 'http://localhost:3000';
    const apiKey = config?.apiKey;

    try {
      const res = await fetch(
        `${backendUrl}/api/sync/workflow-history?type=${wf}`,
        {
          headers: { 'X-API-Key': apiKey },
        },
      );
      const data = await res.json();
      if (!res.ok) throw new Error('Failed to load mass connector history');

      const run = data.history[idx];
      currentSelectedRun = run;

      stats.style.display = 'flex';
      document.getElementById('resCount').textContent =
        `${run.results.length} results`;
      document.getElementById('resDate').textContent = new Date(
        run.startedAt,
      ).toLocaleString();

      btnExport.disabled = run.results.length === 0;
      btnPipe.disabled = true;

      if (run.results.length === 0) {
        tbody.innerHTML =
          '<tr><td colspan="2" style="text-align: center; color: var(--tech-muted); padding: 20px;">No results in this run</td></tr>';
        return;
      }

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
    } catch (err) {
      tbody.innerHTML = `<tr><td colspan="2" style="color: red;">Error: ${err.message}</td></tr>`;
    }
  }
}

function exportResultsCsv() {
  if (!currentSelectedRun || currentSelectedRun.results.length === 0) return;

  const results = currentSelectedRun.results;

  // Transform results for better CSV columns
  const transformedResults = results.map((r) => {
    const row = {};
    row['Name'] = r.name || r.Name || '';
    row['Title'] = r.headline || r.title || r.Title || '';
    row['Bio/About'] =
      r.about || r.bio || r['bio/about'] || r['Bio/About'] || '';

    if (r.hasOwnProperty('isQualified') || r.hasOwnProperty('Qualified')) {
      row['Match Status'] =
        r.isQualified || r.Qualified ? 'Qualified' : 'Not Qualified';
    }
    if (r.hasOwnProperty('status')) {
      row['Status'] = r.status;
    }
    if (r.company) row['Company'] = r.company;

    row['Email'] = r.email || r.Email || '';

    // Add any other properties dynamically
    for (const key of Object.keys(r)) {
      if (
        ![
          'name',
          'headline',
          'title',
          'about',
          'bio',
          'isQualified',
          'status',
          'company',
          'email',
          'Name',
          'Title',
          'Bio/About',
          'Match Status',
          'Status',
          'Company',
          'Email',
        ].includes(key)
      ) {
        row[key] = r[key];
      }
    }
    return row;
  });

  const headers = Object.keys(transformedResults[0]);

  const rows = transformedResults.map((r) =>
    headers.map((h) => `"${String(r[h] || '').replace(/"/g, '""')}"`).join(','),
  );

  const csv = [headers.join(','), ...rows].join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);

  const sel = document.getElementById('resRunSelect');
  const selectedText = sel.options[sel.selectedIndex].text;
  const safeName = selectedText
    .replace(/[\/\\:*?"<>|]/g, '-')
    .replace(/\s+/g, '_');

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

// ─── Auth Flow ───────────────────────────────────────────────────

function setupAuth() {
  document
    .getElementById('btnLogin')
    .addEventListener('click', () => handleAuth('login'));
  document
    .getElementById('btnRegister')
    .addEventListener('click', () => handleAuth('register'));
}

async function handleAuth(action) {
  const email = document.getElementById('authEmail').value.trim();
  const password = document.getElementById('authPassword').value;
  const errorMsg = document.getElementById('authErrorMsg');
  const btn =
    action === 'login'
      ? document.getElementById('btnLogin')
      : document.getElementById('btnRegister');

  errorMsg.textContent = '';
  if (!email || !password) {
    errorMsg.textContent = 'Email and password are required.';
    return;
  }

  btn.classList.add('is-loading');
  try {
    const statusRes = await sendMessage({ action: 'getStatus' });
    const config = statusRes?.config || {};
    const backendUrl = config.backendUrl || 'http://localhost:3000';

    const res = await fetch(`${backendUrl}/api/auth/${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const data = await res.json();

    if (!res.ok || !data.ok) {
      throw new Error(data.error || data.message || `Failed to ${action}`);
    }

    // Save apiKey to config via background
    config.apiKey = data.apiKey;
    await sendMessage({ action: 'saveConfig', config });

    document.getElementById('loginOverlay').style.display = 'none';

    // Initialize the app now that we have an API key
    await loadConfig();
    await refreshState();
    startPolling();
  } catch (err) {
    errorMsg.textContent = err.message;
  } finally {
    btn.classList.remove('is-loading');
  }
}
