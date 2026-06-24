import { IUserConfig, IDailyStats } from './types.js';

/**
 * Random delay between min and max milliseconds (human-like pacing).
 */
export function delay(minMs: number, maxMs: number): Promise<void> {
  const ms = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Delay between successive LinkedIn API calls (1.5–3.7 s).
 * Applied at the application layer, before calling voyagerGet/voyagerPost.
 */
export function apiDelay(): Promise<void> {
  return delay(1500, 3700);
}

/**
 * Delay between connection-send requests.
 * Delay: 5–10 s. Production delay (in reality 2-5 min, but we default to human-like safety pacing).
 */
export function connectionDelay(): Promise<void> {
  return delay(5000, 10000);
}

/**
 * Check if we can still send connections today.
 */
export function canSendConnection(
  config: IUserConfig,
  stats: IDailyStats,
): boolean {
  return stats.connectionsSent < (config.dailyLimit || 15);
}

/**
 * Get remaining connection slots for today.
 */
export function getRemainingSlots(
  config: IUserConfig,
  stats: IDailyStats,
): number {
  return Math.max(0, (config.dailyLimit || 15) - stats.connectionsSent);
}
