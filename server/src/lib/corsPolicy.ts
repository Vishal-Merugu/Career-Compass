import { env } from '../config/env.js';

const extraOrigins = env.CORS_ORIGIN
  ? env.CORS_ORIGIN.split(',')
      .map((o) => o.trim())
      .filter(Boolean)
  : [];

const extensionOrigin = env.EXTENSION_ID
  ? `chrome-extension://${env.EXTENSION_ID}`
  : null;

/**
 * Shared CORS origin check for both the REST API (Express/cors) and the
 * Socket.IO gateway. Only origins explicitly configured via CORS_ORIGIN or
 * this app's own pinned EXTENSION_ID are allowed — no wildcard fallback and
 * no blanket acceptance of arbitrary chrome-extension:// origins.
 */
export function corsOriginCheck(
  origin: string | undefined,
  callback: (err: Error | null, allow?: boolean) => void,
) {
  if (
    !origin ||
    extraOrigins.includes(origin) ||
    (extensionOrigin && origin === extensionOrigin)
  ) {
    callback(null, true);
    return;
  }
  callback(new Error('Not allowed by CORS'));
}
