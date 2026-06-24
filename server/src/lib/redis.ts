import { createClient } from 'redis';
import { env } from '../config/env.js';
import { logger } from './logger.js';

export const redisClient = createClient({
  url: env.REDIS_URL,
});

let isRedisConnected = false;

redisClient.on('error', (err) => {
  logger.error({ err }, 'Redis Client Error');
});

redisClient.on('connect', () => {
  logger.info('Redis Client Connected');
  isRedisConnected = true;
});

redisClient.on('end', () => {
  logger.warn('Redis connection closed');
  isRedisConnected = false;
});

/**
 * Initialize Redis connection on server startup.
 * Fails gracefully to allow app execution without Redis.
 */
export async function initRedis(): Promise<void> {
  try {
    await redisClient.connect();
    isRedisConnected = true;
    logger.info('Successfully established connection to Redis');
  } catch (err) {
    logger.warn(
      { err },
      'Failed to connect to Redis. Running in Postgres fallback mode.',
    );
    isRedisConnected = false;
  }
}

/**
 * Check if Redis is currently connected and active.
 */
export function getRedisStatus(): boolean {
  return isRedisConnected;
}

/**
 * Retrieve cached LinkedIn session cookies for a given user.
 */
export async function getCachedSession(
  userId: string,
): Promise<{ csrfToken: string; liAtCookie: string } | null> {
  if (!isRedisConnected) return null;
  try {
    const data = await redisClient.get(`linkedin:session:${userId}`);
    if (!data) return null;
    return JSON.parse(data);
  } catch (err) {
    logger.error(
      { err, userId },
      'Failed to get cached LinkedIn session from Redis',
    );
    return null;
  }
}

/**
 * Cache LinkedIn session cookies for a user with a TTL (e.g., 24 hours).
 */
export async function setCachedSession(
  userId: string,
  session: { csrfToken: string; liAtCookie: string },
): Promise<void> {
  if (!isRedisConnected) return;
  try {
    // Cache for 24 hours (86400 seconds)
    await redisClient.setEx(
      `linkedin:session:${userId}`,
      86400,
      JSON.stringify({
        csrfToken: session.csrfToken,
        liAtCookie: session.liAtCookie,
      }),
    );
  } catch (err) {
    logger.error({ err, userId }, 'Failed to cache LinkedIn session in Redis');
  }
}

/**
 * Delete a cached LinkedIn session.
 */
export async function deleteCachedSession(userId: string): Promise<void> {
  if (!isRedisConnected) return;
  try {
    await redisClient.del(`linkedin:session:${userId}`);
  } catch (err) {
    logger.error(
      { err, userId },
      'Failed to delete cached LinkedIn session from Redis',
    );
  }
}
