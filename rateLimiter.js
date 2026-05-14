// ─── Rate Limiter & Safety ────────────────────────────────────────
// Enforces human-like delays, daily limits, and auto-pause on errors.

let consecutiveApiErrors = 0;

/**
 * Random delay between min and max milliseconds (human-like pacing)
 */
function delay(minMs, maxMs) {
  const ms = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Delay between API calls (1-3 seconds)
 */
function apiDelay() {
  return delay(1000, 3000);
}

/**
 * Delay between connection requests (2-5 minutes)
 */
function connectionDelay() {
  return delay(2 * 60 * 1000, 5 * 60 * 1000);
}

/**
 * Check if we can still send connections today
 */
async function canSendConnection() {
  const config = await getConfig();
  const stats = await getDailyStats();
  return stats.connectionsSent < (config.dailyLimit || 15);
}

/**
 * Get remaining connection slots for today
 */
async function getRemainingSlots() {
  const config = await getConfig();
  const stats = await getDailyStats();
  return Math.max(0, (config.dailyLimit || 15) - stats.connectionsSent);
}

/**
 * Track API errors — auto-pause after 5 consecutive failures
 */
function trackApiError(error) {
  consecutiveApiErrors++;
  console.warn(
    `[RateLimiter] API error #${consecutiveApiErrors}:`,
    error?.message || error,
  );
  if (consecutiveApiErrors >= 5) {
    console.error(
      "[RateLimiter] 5 consecutive API errors — auto-pausing pipeline",
    );
    return true; // signal to pause
  }
  return false;
}

/**
 * Reset error counter on successful API call
 */
function resetApiErrors() {
  consecutiveApiErrors = 0;
}

/**
 * Validate LinkedIn session is still active.
 * Called periodically (every 30 min via alarm).
 */
async function validateSession() {
  const loggedIn = await isLinkedInLoggedIn();
  if (!loggedIn) {
    console.warn("[RateLimiter] LinkedIn session invalid — pausing pipeline");
    await setPipelineStatus("paused");
    await addActivityEntry("⚠️ LinkedIn session expired — pipeline paused");
    return false;
  }
  return true;
}

// ─── Exports ─────────────────────────────────────────────────────

if (typeof globalThis !== "undefined") {
  Object.assign(globalThis, {
    delay,
    apiDelay,
    connectionDelay,
    canSendConnection,
    getRemainingSlots,
    trackApiError,
    resetApiErrors,
    validateSession,
  });
}
