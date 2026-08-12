// ─── CareerCompass Popup Controller ──────────────────────────────
//
// The extension is a supplier of browser-bound capabilities, not a control
// surface. It does three things that genuinely need a logged-in browser: it
// keeps the server's LinkedIn cookie jar fresh, it drives the email-finder
// widget, and it sends connection requests. Everything else — starting runs,
// choosing an AI model, reading results — is in the dashboard, where the work
// actually happens and where there is room to explain it.
//
// So this file is two tabs: Connect, and Status.

let pollInterval = null;
let activeWorkflowId = null;

document.addEventListener('DOMContentLoaded', async () => {
  const isContextValid = await checkLinkedInContext();
  if (!isContextValid) return;

  setupAuth();
  setupTabs();
  setupConnector();
  setupStatusTab();

  const statusRes = await sendMessage({ action: 'getStatus' });
  const config = statusRes?.config || {};

  if (!config.apiKey) {
    document.getElementById('loginOverlay').style.display = 'flex';
  } else {
    document.getElementById('loginOverlay').style.display = 'none';
    await sendMessage({ action: 'syncConfig' });
    await refreshState();
    await refreshStatusTab();
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

      if (tab.dataset.tab === 'status') refreshStatusTab();
    });
  });
}

// ─── Status tab ──────────────────────────────────────────────────

function setupStatusTab() {
  document
    .getElementById('btnSaveBackend')
    .addEventListener('click', saveBackendUrl);

  document
    .getElementById('btnOpenDashboard')
    .addEventListener('click', async () => {
      const config = (await sendMessage({ action: 'getStatus' }))?.config || {};
      const url = config.backendUrl || 'http://localhost:3000';
      chrome.tabs.create({ url });
    });
}

async function saveBackendUrl() {
  const statusRes = await sendMessage({ action: 'getStatus' });
  const config = statusRes?.config || {};
  const value = document.getElementById('cfgBackendUrl').value.trim();

  config.backendUrl = value.replace(/\/$/, '');
  await sendMessage({ action: 'saveConfig', config });
  await refreshStatusTab();
}

function minutesAgo(iso) {
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours} h ago` : `${Math.round(hours / 24)} d ago`;
}

async function refreshStatusTab() {
  const statusRes = await sendMessage({ action: 'getStatus' });
  const config = statusRes?.config || {};
  const backendUrl = config.backendUrl || 'http://localhost:3000';

  document.getElementById('cfgBackendUrl').value = backendUrl;
  document.getElementById('statusAccount').textContent = config.apiKey
    ? 'Signed in'
    : 'Not signed in';

  const sessionEl = document.getElementById('statusSession');

  if (!config.apiKey) {
    sessionEl.textContent = 'Sign in first.';
    return;
  }

  const headers = { 'X-API-Key': config.apiKey };

  try {
    const res = await fetch(`${backendUrl}/api/session`, { headers });
    const data = await res.json();
    const session = data?.session;

    if (!session?.present) {
      sessionEl.textContent =
        'Not sent yet. Open a LinkedIn tab, then reopen this.';
    } else if (!session.isValid) {
      sessionEl.textContent = `Expired${
        session.invalidReason ? ` — ${session.invalidReason}` : ''
      }`;
    } else {
      sessionEl.textContent = `Active · sent ${minutesAgo(session.importedAt)}`;
    }
  } catch {
    sessionEl.textContent = 'Could not reach the server.';
  }
}

// ─── Mass Connector ──────────────────────────────────────────────

function setupConnector() {
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
      parsedCsvData = parseCsvBasic(event.target.result);

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

  document.getElementById('mcUrls').addEventListener('input', (e) => {
    const urls = e.target.value
      .split(/[\n,]+/)
      .map((u) => u.trim())
      .filter(Boolean);
    document.getElementById('mcCount').textContent =
      `${urls.length} URLs loaded`;
  });

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
  pollInterval = setInterval(refreshState, 5000);
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

  const isActive = status === 'running' || status === 'paused';
  btnPause.style.display = isActive ? '' : 'none';
  btnStop.style.display = isActive ? '' : 'none';
  btnPause.disabled = !isActive;
  btnStop.disabled = !isActive;
  btnPause.querySelector('.btn-text').textContent =
    status === 'paused' ? 'Resume' : 'Pause';

  btnPause.onclick = async () => {
    if (!activeWorkflowId) return;
    await sendMessage({
      action: status === 'paused' ? 'workflow:resume' : 'workflow:pause',
      workflow: activeWorkflowId,
    });
    refreshState();
  };

  btnStop.onclick = async () => {
    if (!activeWorkflowId) return;
    await sendMessage({
      action: 'workflow:cancel',
      workflow: activeWorkflowId,
    });
    refreshState();
  };
}

function hideAllProgress() {
  document.getElementById('mcProgressContainer').style.display = 'none';
}

function updateWorkflowUI(wf) {
  const isRunning = wf.status === 'running' || wf.status === 'paused';
  document.getElementById('btnStartConnector').disabled = isRunning;

  if (wf.id === 'massConnector') {
    const container = document.getElementById('mcProgressContainer');
    const fill = document.getElementById('mcProgressFill');
    const text = document.getElementById('mcProgressText');

    container.style.display = 'flex';
    const percent =
      wf.progress.total > 0
        ? (wf.progress.current / wf.progress.total) * 100
        : 0;
    fill.style.width = `${percent}%`;
    text.textContent = `${wf.progress.step} (${wf.progress.current} / ${wf.progress.total})`;
  }
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
    // The gate exists for the connection workflow, which genuinely needs a
    // LinkedIn tab. On our own dashboard it was blocking the popup on the one
    // page where the user is most likely to be opening it deliberately — to
    // link the extension, or to see why the email queue is not draining.
    if (res.isDashboard) {
      overlay.classList.remove('active');
      return true;
    }
    if (!res.isLinkedIn || !res.isLoggedIn) {
      overlay.classList.add('active');
      return false;
    }
    overlay.classList.remove('active');
    return true;
  } catch {
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

    config.apiKey = data.apiKey;
    await sendMessage({ action: 'saveConfig', config });

    document.getElementById('loginOverlay').style.display = 'none';

    await sendMessage({ action: 'syncConfig' });
    await refreshState();
    await refreshStatusTab();
    startPolling();
  } catch (err) {
    errorMsg.textContent = err.message;
  } finally {
    btn.classList.remove('is-loading');
  }
}
