// ─── Workflow Registry ───────────────────────────────────────────
// Central registry for all workflows. Enforces single-active-workflow
// and provides a unified API for the background message router.

const WorkflowRegistry = {
  _workflows: {},
  _activeWorkflowId: null,

  /**
   * Register a workflow instance. Called at startup.
   */
  register(workflow) {
    this._workflows[workflow.id] = workflow;
    console.log(`[Registry] Registered workflow: ${workflow.id}`);
  },

  /**
   * Get a registered workflow by ID.
   */
  get(workflowId) {
    return this._workflows[workflowId] || null;
  },

  /**
   * List all registered workflows with their status.
   */
  listAll() {
    return Object.values(this._workflows).map((wf) => wf.getStatus());
  },

  /**
   * Start a workflow. Only one workflow can run at a time.
   */
  async start(workflowId, params) {
    // Check if something else is running
    if (this._activeWorkflowId) {
      const active = this._workflows[this._activeWorkflowId];
      if (active && active.status === 'running') {
        return {
          ok: false,
          error: `"${active.name}" is currently running. Stop it first.`,
        };
      }
      // Previous workflow finished — clear active
      this._activeWorkflowId = null;
    }

    const wf = this._workflows[workflowId];
    if (!wf) {
      return { ok: false, error: `Unknown workflow: ${workflowId}` };
    }

    this._activeWorkflowId = workflowId;
    const result = await wf.start(params);

    // If start failed, clear active
    if (!result.ok) {
      this._activeWorkflowId = null;
    }

    return result;
  },

  /**
   * Pause the active (or specified) workflow.
   */
  async pause(workflowId) {
    const id = workflowId || this._activeWorkflowId;
    const wf = this._workflows[id];
    if (!wf) return { ok: false, error: 'No workflow to pause' };
    await wf.pause();
    return { ok: true };
  },

  /**
   * Resume a paused workflow.
   */
  async resume(workflowId) {
    const wf = this._workflows[workflowId];
    if (!wf) return { ok: false, error: `Unknown workflow: ${workflowId}` };
    if (this._activeWorkflowId && this._activeWorkflowId !== workflowId) {
      const active = this._workflows[this._activeWorkflowId];
      if (active && active.status === 'running') {
        return {
          ok: false,
          error: `"${active.name}" is running. Stop it first.`,
        };
      }
    }
    this._activeWorkflowId = workflowId;
    await wf.resume();
    return { ok: true };
  },

  /**
   * Cancel/stop a workflow.
   */
  async cancel(workflowId) {
    const id = workflowId || this._activeWorkflowId;
    const wf = this._workflows[id];
    if (!wf) return { ok: false, error: 'No workflow to cancel' };
    await wf.cancel();
    if (this._activeWorkflowId === id) {
      this._activeWorkflowId = null;
    }
    return { ok: true };
  },

  /**
   * Get status of a specific workflow.
   */
  getStatus(workflowId) {
    const wf = this._workflows[workflowId];
    if (!wf) return { ok: false, error: `Unknown workflow: ${workflowId}` };
    return { ok: true, ...wf.getStatus() };
  },

  /**
   * Get results of a specific workflow.
   */
  getResults(workflowId) {
    const wf = this._workflows[workflowId];
    if (!wf) return { ok: false, error: `Unknown workflow: ${workflowId}` };
    return {
      ok: true,
      results: wf.results,
      status: wf.status,
      progress: wf.progress,
    };
  },

  /**
   * Get run history for a workflow.
   */
  async getHistory(workflowId) {
    const wf = this._workflows[workflowId];
    if (!wf) return { ok: false, error: `Unknown workflow: ${workflowId}` };
    const history = await wf.getHistory();
    return { ok: true, history };
  },

  /**
   * Get the currently active workflow ID (or null).
   */
  getActiveId() {
    return this._activeWorkflowId;
  },
};

// ─── Exports ─────────────────────────────────────────────────────

if (typeof globalThis !== 'undefined') {
  Object.assign(globalThis, { WorkflowRegistry });
}
