import { logger } from '../lib/logger.js';

export interface IRetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  backoffFactor?: number;
  label?: string;
  onRetry?: ((attempt: number, error: Error, delayMs: number) => void) | null;
  shouldRetry?: (error: Error) => boolean;
}

/**
 * Wraps an async function with retry + exponential backoff.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: IRetryOptions = {},
): Promise<T> {
  const {
    maxRetries = 3,
    baseDelayMs = 5000,
    backoffFactor = 1.5,
    label = 'unknown',
    onRetry = null,
    shouldRetry = () => true,
  } = opts;

  let lastError: Error | any;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      lastError = err;

      // If the caller says this error isn't retryable, bail immediately
      if (!shouldRetry(err)) throw err;

      // If we've exhausted retries, bail
      if (attempt >= maxRetries) break;

      const delayMs = Math.round(
        baseDelayMs * Math.pow(backoffFactor, attempt),
      );
      logger.warn(
        `[Resilience] ${label} failed (attempt ${attempt + 1}/${maxRetries + 1}): ${err.message}. Retrying in ${(delayMs / 1000).toFixed(1)}s…`,
      );

      if (onRetry) onRetry(attempt + 1, err, delayMs);

      await new Promise((r) => setTimeout(r, delayMs));
    }
  }

  // All retries exhausted
  throw lastError;
}

export interface ICircuitBreakerOptions {
  maxFailures?: number;
  cooldownMs?: number;
  label?: string;
}

/**
 * Tracks consecutive failures across an entire workflow run.
 * When `maxFailures` consecutive errors happen the breaker "trips"
 * and signals the workflow to stop gracefully.
 */
export class CircuitBreaker {
  public maxFailures: number;
  public cooldownMs: number;
  public label: string;
  private _consecutiveFailures: number;
  private _tripped: boolean;
  private _errors: string[];

  constructor(opts: ICircuitBreakerOptions = {}) {
    this.maxFailures = opts.maxFailures ?? 5;
    this.cooldownMs = opts.cooldownMs ?? 10000;
    this.label = opts.label ?? 'workflow';
    this._consecutiveFailures = 0;
    this._tripped = false;
    this._errors = [];
  }

  /** Call after a successful operation to reset the failure counter. */
  recordSuccess(): void {
    this._consecutiveFailures = 0;
  }

  /**
   * Call after a failed operation.
   * Logs the error, sleeps for `cooldownMs`, and returns whether the breaker tripped.
   */
  async recordFailure(error: Error | any): Promise<{ tripped: boolean }> {
    this._consecutiveFailures++;
    this._errors.push(error?.message || String(error));

    logger.warn(
      `[CircuitBreaker:${this.label}] Failure ${this._consecutiveFailures}/${this.maxFailures}: ${error?.message || error}`,
    );

    if (this._consecutiveFailures >= this.maxFailures) {
      this._tripped = true;
      logger.error(
        `[CircuitBreaker:${this.label}] TRIPPED — ${this.maxFailures} consecutive failures. Stopping workflow.`,
      );
      return { tripped: true };
    }

    // Cool down before the next attempt
    logger.info(
      `[CircuitBreaker:${this.label}] Cooling down for ${(this.cooldownMs / 1000).toFixed(1)}s…`,
    );
    await new Promise((r) => setTimeout(r, this.cooldownMs));

    return { tripped: false };
  }

  /** Whether the breaker has tripped. */
  get isTripped(): boolean {
    return this._tripped;
  }

  /** All recorded error messages (useful for the "stopped halfway" report). */
  get errors(): string[] {
    return [...this._errors];
  }

  /** Reset the breaker completely (e.g. for a new workflow run). */
  reset(): void {
    this._consecutiveFailures = 0;
    this._tripped = false;
    this._errors = [];
  }
}
