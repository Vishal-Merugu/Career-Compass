// ─── Resilience: Retry & Circuit Breaker ─────────────────────────
// Centralised fault-tolerance utilities used across the whole app.
// Every external call (LinkedIn Voyager, LLM) should go through these.

// ─── withRetry ───────────────────────────────────────────────────
// Generic retry wrapper with exponential backoff.
//
//   await withRetry(() => voyagerGet('/some/endpoint'), {
//     maxRetries   : 3,
//     baseDelayMs  : 5000,
//     backoffFactor: 1.5,
//     label        : 'voyagerGet',
//   });

/**
 * Wraps an async function with retry + exponential backoff.
 *
 * @param {Function}  fn                  – The async function to execute.
 * @param {Object}    opts                – Options.
 * @param {number}    opts.maxRetries     – How many times to retry (default 3).
 * @param {number}    opts.baseDelayMs    – Initial delay between retries in ms (default 5000).
 * @param {number}    opts.backoffFactor  – Multiplier applied after each retry (default 1.5).
 * @param {string}    opts.label          – Human-readable name for logging.
 * @param {Function}  opts.onRetry        – Optional callback(attempt, error, delayMs).
 * @param {Function}  opts.shouldRetry    – Optional predicate(error) → bool. Default: always true.
 * @returns {Promise<*>}                  – Resolved value from fn.
 */
async function withRetry(fn, opts = {}) {
  const {
    maxRetries = 3,
    baseDelayMs = 5000,
    backoffFactor = 1.5,
    label = 'unknown',
    onRetry = null,
    shouldRetry = () => true,
  } = opts;

  let lastError;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;

      // If the caller says this error isn't retryable, bail immediately
      if (!shouldRetry(err)) throw err;

      // If we've exhausted retries, bail
      if (attempt >= maxRetries) break;

      const delayMs = Math.round(
        baseDelayMs * Math.pow(backoffFactor, attempt),
      );
      console.warn(
        `[Resilience] ${label} failed (attempt ${attempt + 1}/${maxRetries + 1}): ${err.message}. Retrying in ${(delayMs / 1000).toFixed(1)}s…`,
      );

      if (onRetry) onRetry(attempt + 1, err, delayMs);

      await new Promise((r) => setTimeout(r, delayMs));
    }
  }

  // All retries exhausted
  throw lastError;
}

// ─── CircuitBreaker ──────────────────────────────────────────────
// Tracks consecutive failures across an entire workflow run.
// When `maxFailures` consecutive errors happen the breaker "trips"
// and signals the workflow to stop gracefully.
//
//   const breaker = new CircuitBreaker({ maxFailures: 5 });
//   breaker.recordSuccess();      // resets counter
//   breaker.recordFailure(err);   // increments; returns { tripped: true } when threshold hit
//   breaker.isTripped;            // boolean getter

class CircuitBreaker {
  /**
   * @param {Object}  opts
   * @param {number}  opts.maxFailures  – Consecutive failures before tripping (default 5).
   * @param {number}  opts.cooldownMs   – Sleep duration after each failure (default 10 000).
   * @param {string}  opts.label        – Name for logging.
   */
  constructor(opts = {}) {
    this.maxFailures = opts.maxFailures ?? 5;
    this.cooldownMs = opts.cooldownMs ?? 10000;
    this.label = opts.label ?? 'workflow';
    this._consecutiveFailures = 0;
    this._tripped = false;
    this._errors = [];
  }

  /** Call after a successful operation to reset the failure counter. */
  recordSuccess() {
    this._consecutiveFailures = 0;
  }

  /**
   * Call after a failed operation.
   * Logs the error, sleeps for `cooldownMs`, and returns whether the breaker tripped.
   *
   * @param {Error} error
   * @returns {Promise<{ tripped: boolean }>}
   */
  async recordFailure(error) {
    this._consecutiveFailures++;
    this._errors.push(error?.message || String(error));

    console.warn(
      `[CircuitBreaker:${this.label}] Failure ${this._consecutiveFailures}/${this.maxFailures}: ${error?.message || error}`,
    );

    if (this._consecutiveFailures >= this.maxFailures) {
      this._tripped = true;
      console.error(
        `[CircuitBreaker:${this.label}] TRIPPED — ${this.maxFailures} consecutive failures. Stopping workflow.`,
      );
      return { tripped: true };
    }

    // Cool down before the next attempt
    console.log(
      `[CircuitBreaker:${this.label}] Cooling down for ${(this.cooldownMs / 1000).toFixed(1)}s…`,
    );
    await new Promise((r) => setTimeout(r, this.cooldownMs));

    return { tripped: false };
  }

  /** Whether the breaker has tripped. */
  get isTripped() {
    return this._tripped;
  }

  /** All recorded error messages (useful for the "stopped halfway" report). */
  get errors() {
    return [...this._errors];
  }

  /** Reset the breaker completely (e.g. for a new workflow run). */
  reset() {
    this._consecutiveFailures = 0;
    this._tripped = false;
    this._errors = [];
  }
}

// ─── Exports ─────────────────────────────────────────────────────

if (typeof globalThis !== 'undefined') {
  Object.assign(globalThis, {
    withRetry,
    CircuitBreaker,
  });
}
