import { Redis } from 'ioredis';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';

/**
 * A second Redis client, for BullMQ only.
 *
 * `src/lib/redis.ts` uses node-redis and stays the client for caching. BullMQ
 * requires ioredis specifically — it depends on ioredis-only APIs for its
 * blocking reads and Lua scripting — so the two cannot be merged. Same server,
 * different libraries, deliberately.
 *
 * The important difference in behaviour: the cache client degrades gracefully
 * (`getCachedSession` returns null and callers fall back to Postgres). A queue
 * cannot do that. A campaign that fails to enqueue has not been "sent without
 * caching", it has silently not been sent at all, so this path must fail loudly
 * instead — see `assertQueueAvailable`.
 */

let connection: Redis | null = null;
let lastError: Error | null = null;

export function getQueueConnection(): Redis {
  if (connection) return connection;

  connection = new Redis(env.REDIS_URL, {
    // BullMQ requires this to be null. ioredis otherwise gives up on a command
    // after N retries and rejects it, which for a blocking queue read means the
    // worker stops consuming without saying so.
    maxRetriesPerRequest: null,
  });

  connection.on('error', (err: Error) => {
    lastError = err;
    logger.error({ err }, '[queue] Redis connection error');
  });

  connection.on('ready', () => {
    lastError = null;
    logger.info('[queue] Redis connection ready');
  });

  return connection;
}

/**
 * Whether the queue can currently accept work.
 *
 * `status` is ioredis's own view of the socket. 'ready' is the only state in
 * which a command will actually be delivered rather than buffered indefinitely.
 */
export function isQueueReady(): boolean {
  return connection?.status === 'ready';
}

export function getQueueError(): Error | null {
  return lastError;
}

export async function closeQueueConnection(): Promise<void> {
  if (!connection) return;
  await connection.quit();
  connection = null;
}
