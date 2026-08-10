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
  // Telegram allows one poller per token, so a local server and the VM sharing
  // one produce an endless stream of 409s. Set false locally rather than
  // commenting the token out of a file you then forget you edited.
  ENABLE_TELEGRAM: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
  PORT: z.coerce.number().default(3000),
  NODE_ENV: z
    .enum(['development', 'production', 'test'])
    .default('development'),
  REDIS_URL: z.string().default('redis://localhost:6379'),

  // ─── The built-in model ──────────────────────────────────────────
  //
  // What `llmProvider: 'server'` resolves to. It is the default for new
  // accounts because the instance operator knows an address that works and an
  // installed model, and the user does not: the previous default was
  // `http://localhost:11434`, which inside the container is the container, so
  // every fresh account pointed at nothing.
  //
  // `host.docker.internal` (with `extra_hosts: host-gateway` in
  // docker-compose.yml) is how the container reaches an Ollama running on the
  // Docker host. Verified on the VM 2026-08-09 — `localhost` fails, this
  // succeeds. Off Docker, override it to `http://localhost:11434`.
  DEFAULT_LLM_URL: z.string().default('http://host.docker.internal:11434'),
  // Must be a model the target host has actually pulled. `qwen2.5:1.5b` was
  // the old schema default and is not installed on the VM, so fixing only the
  // URL would have traded `fetch failed` for a 404.
  DEFAULT_LLM_MODEL: z.string().default('mistral-small:24b'),
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
