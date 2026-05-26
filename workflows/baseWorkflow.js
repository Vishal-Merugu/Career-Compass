// ─── Base Workflow ────────────────────────────────────────────────
// Abstract base class for all CareerCompass workflows.
// Provides state management, progress tracking, persistence,
// circuit-breaker integration, and lifecycle hooks.
//
// Statuses: idle | running | paused | completed | stoppedHalfway | error

const WORKFLOW_MAX_HISTORY = 3; // Max completed runs to persist per workflow

class BaseWorkflow {
  constructor(id, name) {
    this.id = id;
    this.name = name;
    this.status = 'idle';
    this.progress = { current: 0, total: 0, step: '' };
    this.results = [];
    this.errors = [];
    this.startedAt = null;
    this.completedAt = null;
    this._params = {};
    this._breaker = null; // CircuitBreaker instance, created per run
  }

  // ─── Lifecycle (override execute in subclasses) ──────────────

  async execute(params) {
    throw new Error(`${this.name}: execute() not implemented`);
  }

  async start(params) {
    if (this.status === 'running') {
      return { ok: false, error: `${this.name} is already running` };
    }

    this.status = 'running';
    this.progress = { current: 0, total: 0, step: 'Starting...' };
    this.results = [];
    this.errors = [];
    this.startedAt = new Date().toISOString();
    this.completedAt = null;
    this._params = params || {};

    // Fresh circuit breaker for every run
    this._breaker = new CircuitBreaker({
      maxFailures: 5,
      cooldownMs: 10000,
      label: this.id,
    });

    await this.saveState();

    // Fire-and-forget — execute runs async
    this.execute(params)
      .then(() => this._onComplete())
      .catch((err) => this._onError(err));

    return { ok: true };
  }

  async pause() {
    if (this.status !== 'running') return;
    this.status = 'paused';
    await this.saveState();
    await addActivityEntry(`⏸ ${this.name} paused`);
  }

  async resume() {
    if (this.status !== 'paused') return;
    this.status = 'running';
    await this.saveState();
    await addActivityEntry(`▶ ${this.name} resumed`);

    // Restart the loop asynchronously
    this.execute(this._params)
      .then(() => this._onComplete())
      .catch((err) => this._onError(err));
  }

  async cancel() {
    this.status = 'idle';
    this.progress = { current: 0, total: 0, step: '' };
    await this.saveState();
    await addActivityEntry(`⏹ ${this.name} cancelled`);
  }

  // ─── Completion Handlers ────────────────────────────────────

  async _onComplete() {
    if (this.status === 'running') {
      this.status = 'completed';
      this.completedAt = new Date().toISOString();
      await this.saveState();
      await this._archiveRun();
      await addActivityEntry(
        `✅ ${this.name} complete — ${this.results.length} results`,
      );
      this._notify(
        'CareerCompass Workflow Complete',
        `${this.name} finished. Found ${this.results.length} results.`,
      );
    }
  }

  async _onError(err) {
    console.error(`[${this.name}] Fatal error:`, err);
    this.errors.push(err.message);
    this.completedAt = new Date().toISOString();

    // If the circuit breaker tripped, treat as "stopped halfway"
    if (this._breaker?.isTripped) {
      await this._onStoppedHalfway();
    } else {
      this.status = 'error';
      await this.saveState();
      await addActivityEntry(`❌ ${this.name} error: ${err.message}`);
    }
  }

  /**
   * Called when the circuit breaker trips (5 consecutive failures).
   * Saves whatever has been collected so far and archives the partial run.
   */
  async _onStoppedHalfway() {
    this.status = 'stoppedHalfway';
    this.completedAt = new Date().toISOString();
    await this.saveState();
    await this._archiveRun();

    const msg = `⚠️ ${this.name} stopped halfway — ${this.results.length} results saved. ${this.errors.length} errors encountered.`;
    await addActivityEntry(msg);

    this._notify(
      'CareerCompass — Workflow Stopped',
      `${this.name} hit too many errors and stopped. ${this.results.length} partial results saved.`,
    );
  }

  // ─── Circuit Breaker Helpers ────────────────────────────────
  // Subclasses call these inside their try/catch loops.

  /**
   * Record a successful API call. Resets the circuit breaker counter.
   */
  onApiSuccess() {
    this._breaker?.recordSuccess();
  }

  /**
   * Record a failed API call. Sleeps for cooldown and checks the breaker.
   * If the breaker trips, throws a sentinel error that _onError will handle.
   *
   * @param {Error} err – The caught error.
   * @param {string} context – Human-readable context for logging.
   */
  async onApiFailure(err, context = '') {
    const prefix = context ? `${context}: ` : '';
    this.errors.push(`${prefix}${err.message}`);
    console.warn(`[${this.name}] ${prefix}${err.message}`);

    if (!this._breaker) return;

    const { tripped } = await this._breaker.recordFailure(err);
    if (tripped) {
      throw new Error(
        `Circuit breaker tripped after ${this._breaker.maxFailures} consecutive failures`,
      );
    }
  }

  // ─── State Persistence ───────────────────────────────────────

  async saveState() {
    await storageSet(`workflow_${this.id}`, {
      status: this.status,
      progress: this.progress,
      results: this.results,
      errors: this.errors,
      startedAt: this.startedAt,
      completedAt: this.completedAt,
      params: this._params,
      checkpoint: this.getCheckpoint(),
    });
  }

  async loadState() {
    const state = await storageGet(`workflow_${this.id}`);
    if (state) {
      this.status = state.status;
      this.progress = state.progress;
      this.results = state.results || [];
      this.errors = state.errors || [];
      this.startedAt = state.startedAt;
      this.completedAt = state.completedAt;
      this._params = state.params || {};
    }
    return state;
  }

  /** Override in subclasses to save workflow-specific resume point. */
  getCheckpoint() {
    return {};
  }

  // ─── Run History (max 3 per workflow) ────────────────────────

  async _archiveRun() {
    const historyKey = `workflow_history_${this.id}`;
    const history = (await storageGet(historyKey)) || [];
    history.unshift({
      params: this._params,
      results: this.results,
      summary: {
        total: this.progress.total,
        matched: this.results.length,
        errors: this.errors.length,
        status: this.status,
      },
      startedAt: this.startedAt,
      completedAt: this.completedAt,
    });
    if (history.length > WORKFLOW_MAX_HISTORY) {
      history.length = WORKFLOW_MAX_HISTORY;
    }
    await storageSet(historyKey, history);
  }

  async getHistory() {
    return (await storageGet(`workflow_history_${this.id}`)) || [];
  }

  // ─── Helpers ─────────────────────────────────────────────────

  /**
   * Check whether the workflow should keep running.
   * Called inside loops — lightweight, no network calls.
   */
  async shouldContinue() {
    return this.status === 'running';
  }

  async updateProgress(current, total, step) {
    this.progress = { current, total, step };
    await this.saveState();
  }

  addResult(item) {
    this.results.push(item);
  }

  getStatus() {
    return {
      id: this.id,
      name: this.name,
      status: this.status,
      progress: this.progress,
      resultCount: this.results.length,
      errorCount: this.errors.length,
      startedAt: this.startedAt,
      completedAt: this.completedAt,
    };
  }

  /** Send a Chrome notification (best-effort, never throws). */
  _notify(title, message) {
    try {
      if (typeof chrome !== 'undefined' && chrome.notifications) {
        chrome.notifications.create({
          type: 'basic',
          iconUrl: '/assets/icons/icon128.png',
          title,
          message,
          priority: 2,
        });
      }
    } catch {
      // Notifications are nice-to-have, never block on them
    }
  }
}

// ─── Exports ─────────────────────────────────────────────────────

if (typeof globalThis !== 'undefined') {
  Object.assign(globalThis, {
    BaseWorkflow,
    WORKFLOW_MAX_HISTORY,
  });
}
