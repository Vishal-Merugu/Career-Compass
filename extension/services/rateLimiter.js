// ─── Rate Limiter & Safety ────────────────────────────────────────
// Enforces human-like delays and daily connection limits.
// Error tracking has moved to services/resilience.js (CircuitBreaker).

/**
 * Random delay between min and max milliseconds (human-like pacing).
 */
function delay(minMs, maxMs) {
  const ms = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Delay between successive LinkedIn API calls (1.5–3.7 s).
 * Applied at the application layer, before calling voyagerGet/voyagerPost.
 */
function apiDelay() {
  return delay(1500, 3700);
}

/**
 * Delay between connection-send requests (2–5 min, human-like pacing).
 * This is the single most important throttle in the extension — sending
 * connection requests any faster is what gets LinkedIn accounts restricted.
 */
function connectionDelay() {
  return delay(120 * 1000, 300 * 1000);
}

/**
 * Check if we can still send connections today.
 */
async function canSendConnection() {
  const config = await getConfig();
  const stats = await getDailyStats();
  return stats.connectionsSent < (config.dailyLimit || 15);
}

/**
 * Get remaining connection slots for today.
 */
async function getRemainingSlots() {
  const config = await getConfig();
  const stats = await getDailyStats();
  return Math.max(0, (config.dailyLimit || 15) - stats.connectionsSent);
}

/**
 * Validate LinkedIn session is still active.
 * Called once at pipeline start and every 30 min via alarm — NOT in hot loops.
 */
async function validateSession() {
  const loggedIn = await isLinkedInLoggedIn();
  if (!loggedIn) {
    console.warn('[RateLimiter] LinkedIn session invalid — pausing pipeline');
    await setPipelineStatus('paused');
    await addActivityEntry('⚠️ LinkedIn session expired — pipeline paused');
    return false;
  }
  return true;
}

// ─── Exports ─────────────────────────────────────────────────────

if (typeof globalThis !== 'undefined') {
  Object.assign(globalThis, {
    delay,
    apiDelay,
    connectionDelay,
    canSendConnection,
    getRemainingSlots,
    validateSession,
  });
}
