import { z } from 'zod';
import dotenv from 'dotenv';
import path from 'path';

// Load env variables
dotenv.config();

const envSchema = z.object({
  DATABASE_URL: z.string().url('DATABASE_URL must be a valid URL'),
  JWT_SECRET: z
    .string()
    .min(32, 'JWT_SECRET must be at least 32 characters long'),
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  PORT: z.coerce.number().default(3000),
  NODE_ENV: z
    .enum(['development', 'production', 'test'])
    .default('development'),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  // Comma-separated list of extra allowed CORS origins (e.g. a companion
  // web dashboard). Do not use this to allow arbitrary chrome-extension://
  // origins — that's handled explicitly via EXTENSION_ID instead.
  CORS_ORIGIN: z.string().optional(),
  // The distributed extension's Chrome-assigned ID (pin it by adding a
  // "key" to extension/manifest.json so it's stable across installs).
  // Only this extension's origin is allowed to call the API/WS gateway;
  // leaving it unset means no chrome-extension:// origin is trusted.
  EXTENSION_ID: z.string().optional(),
  // 32-byte (64 hex char) key used to encrypt LinkedIn session cookies
  // (li_at / csrf token) before caching them in Redis. Generate with:
  // openssl rand -hex 32
  SESSION_ENCRYPTION_KEY: z
    .string()
    .regex(
      /^[0-9a-fA-F]{64}$/,
      'SESSION_ENCRYPTION_KEY must be a 64-character hex string (32 bytes) — generate with `openssl rand -hex 32`',
    ),
});

let parsedEnv;
try {
  parsedEnv = envSchema.parse(process.env);
} catch (error: any) {
  console.error('❌ Invalid environment configuration:');
  if (error instanceof z.ZodError) {
    error.errors.forEach((err) => {
      console.error(`  - ${err.path.join('.')}: ${err.message}`);
    });
  } else {
    console.error(error);
  }
  process.exit(1);
}

export const env = parsedEnv;
