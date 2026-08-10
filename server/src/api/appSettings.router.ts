// ─── Settings that used to live in the extension ─────────────────
//
// The AI model and the finder defaults. Both are consumed exclusively by the
// server, and both were previously edited in the extension's Config tab, which
// pushed them to `/api/config` on save and pulled and merged them on load —
// two writers on one row, last write wins.
//
// Gated on `requireAuth` (cookie), not `requireAuthOrApiKey`, for the same
// reason `/api/settings/outreach` is: `llmApiKey` is a billable credential, and
// the extension's long-lived key must not be able to read or set one.
//
// `/api/config` stays reachable with the extension's key, but read-only for
// these fields — see the note there.

import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../auth/middleware.js';
import { prisma } from '../lib/prisma.js';
import { ValidationError } from '../errors/AppError.js';
import { encryptSecret } from '../lib/secretBox.js';
import { env } from '../config/env.js';
import { DEFAULT_SEARCH_PROMPT } from '../config/defaultPrompt.js';
import { llmHealthCheck } from '../shared/llmClient.js';
import {
  checkAiModel,
  preflightJob,
} from '../services/jobPreflight.service.js';
import { PrismaStorageAdapter } from '../services/storage.adapter.js';
import { issueLinkCode } from '../telegram/linkCodes.js';
import type { IUserConfig } from '../shared/types.js';

const router = Router();

const PROVIDERS = ['server', 'ollama', 'gemini', 'openrouter'] as const;

const aiSchema = z.object({
  llmProvider: z.enum(PROVIDERS).optional(),
  llmUrl: z.string().optional(),
  llmModel: z.string().optional(),
  // Absent means "leave unchanged"; explicit null clears it. The current value
  // is never sent to the client, so it cannot be echoed back by accident.
  llmApiKey: z.string().min(1).max(500).nullable().optional(),
});

const finderSchema = z.object({
  searchPrompt: z.string().max(20_000).nullable().optional(),
  dailyLimit: z.number().int().min(1).max(100).optional(),
  emailFinderEnabled: z.boolean().optional(),
  userContext: z.string().max(5000).nullable().optional(),
});

/** Created on first read so a fresh account has something to edit. */
async function loadConfig(userId: string) {
  const existing = await prisma.userConfig.findUnique({ where: { userId } });
  return existing ?? prisma.userConfig.create({ data: { userId } });
}

interface AiSettingsView {
  llmProvider: string;
  llmUrl: string;
  llmModel: string;
  /** Never the key itself. */
  llmApiKeySet: boolean;
  /** What `server` resolves to, so the UI can show it read-only. */
  builtIn: { url: string; model: string };
}

function aiView(config: {
  llmProvider: string;
  llmUrl: string;
  llmModel: string;
  llmApiKey: string | null;
}): AiSettingsView {
  return {
    llmProvider: config.llmProvider,
    llmUrl: config.llmUrl,
    llmModel: config.llmModel,
    llmApiKeySet: Boolean(config.llmApiKey),
    builtIn: { url: env.DEFAULT_LLM_URL, model: env.DEFAULT_LLM_MODEL },
  };
}

router.get('/settings/ai', requireAuth, async (req, res, next) => {
  try {
    const config = await loadConfig(req.user!.id);
    res.status(200).json({ ok: true, settings: aiView(config) });
  } catch (err) {
    next(err);
  }
});

router.put('/settings/ai', requireAuth, async (req, res, next) => {
  try {
    const body = aiSchema.parse(req.body);
    const userId = req.user!.id;

    const data: Record<string, string | null> = {};
    if (body.llmProvider !== undefined) data.llmProvider = body.llmProvider;
    if (body.llmUrl !== undefined) data.llmUrl = body.llmUrl.trim();
    if (body.llmModel !== undefined) data.llmModel = body.llmModel.trim();
    if (body.llmApiKey !== undefined) {
      data.llmApiKey = body.llmApiKey ? encryptSecret(body.llmApiKey) : null;
    }

    const config = await prisma.userConfig.upsert({
      where: { userId },
      update: data,
      create: { userId, ...data },
    });

    res.status(200).json({ ok: true, settings: aiView(config) });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return next(new ValidationError('Invalid AI settings', err.errors));
    }
    next(err);
  }
});

/**
 * Ask the model host what it has — **from this process**.
 *
 * The extension's "Test AI" button ran the same check in its own service
 * worker, which reaches the user's laptop rather than the host that makes the
 * real calls. It could therefore report a healthy model while the server could
 * not resolve the address at all, which is exactly the state the VM was in
 * while a run rejected 368 profiles for "LLM Error: fetch failed".
 *
 * A body is optional: with one, a candidate configuration is tested *before*
 * being saved; without, whatever is stored is tested.
 */
router.post('/settings/ai/check', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user!.id;
    await loadConfig(userId);
    const candidate = aiSchema.parse(req.body ?? {});

    // Through the adapter so `llmApiKey` arrives decrypted — testing with the
    // stored ciphertext as a bearer token would report a bad key to a user
    // whose key is perfectly good.
    const stored = await new PrismaStorageAdapter(userId).getConfig();

    // A candidate that names no key reuses the stored one, so "test" works
    // without making the user retype a secret they already saved.
    const config: IUserConfig = {
      ...stored,
      llmProvider: candidate.llmProvider ?? stored.llmProvider,
      llmUrl: candidate.llmUrl ?? stored.llmUrl,
      llmModel: candidate.llmModel ?? stored.llmModel,
      llmApiKey: candidate.llmApiKey ?? stored.llmApiKey,
    };

    const [health, verdict] = await Promise.all([
      llmHealthCheck(config),
      checkAiModel(config),
    ]);

    res.status(200).json({
      ok: true,
      checkedFrom: 'server',
      reachable: health.ok,
      url: health.url,
      models: health.models ?? [],
      // The full verdict, including "reachable but that model is not installed"
      // — the failure a bare connectivity check misses.
      check: verdict,
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return next(new ValidationError('Invalid AI settings', err.errors));
    }
    next(err);
  }
});

router.get('/settings/finder', requireAuth, async (req, res, next) => {
  try {
    const config = await loadConfig(req.user!.id);
    res.status(200).json({
      ok: true,
      settings: {
        searchPrompt: config.searchPrompt ?? DEFAULT_SEARCH_PROMPT,
        usingDefaultPrompt: config.searchPrompt === null,
        dailyLimit: config.dailyLimit,
        emailFinderEnabled: config.emailFinderEnabled,
        userContext: config.userContext,
      },
    });
  } catch (err) {
    next(err);
  }
});

router.put('/settings/finder', requireAuth, async (req, res, next) => {
  try {
    const body = finderSchema.parse(req.body);
    const userId = req.user!.id;

    const config = await prisma.userConfig.upsert({
      where: { userId },
      update: body,
      create: { userId, ...body },
    });

    res.status(200).json({
      ok: true,
      settings: {
        searchPrompt: config.searchPrompt ?? DEFAULT_SEARCH_PROMPT,
        usingDefaultPrompt: config.searchPrompt === null,
        dailyLimit: config.dailyLimit,
        emailFinderEnabled: config.emailFinderEnabled,
        userContext: config.userContext,
      },
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return next(new ValidationError('Invalid finder settings', err.errors));
    }
    next(err);
  }
});

// ─── Telegram ────────────────────────────────────────────────────
//
// Linking used to mean sending the account's API key to the bot, with the
// welcome message pointing at "your browser extension configuration settings
// page" — which no longer exists. It also put a long-lived credential into a
// chat log on someone else's servers, permanently.
//
// A code from here instead: one use, ten minutes, useless afterwards.

router.get('/settings/telegram', requireAuth, async (req, res, next) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user!.id },
      select: { telegramId: true },
    });

    res.status(200).json({
      ok: true,
      telegram: {
        linked: Boolean(user?.telegramId),
        botConfigured: Boolean(env.TELEGRAM_BOT_TOKEN),
      },
    });
  } catch (err) {
    next(err);
  }
});

router.post('/settings/telegram/code', requireAuth, async (req, res, next) => {
  try {
    res.status(200).json({ ok: true, ...issueLinkCode(req.user!.id) });
  } catch (err) {
    next(err);
  }
});

/** Stop notifications going to a chat — a phone that is lost or handed on. */
router.delete('/settings/telegram', requireAuth, async (req, res, next) => {
  try {
    await prisma.user.update({
      where: { id: req.user!.id },
      data: { telegramId: null },
    });
    res.status(200).json({ ok: true, telegram: { linked: false } });
  } catch (err) {
    next(err);
  }
});

/**
 * The three things an account needs before it can do anything useful.
 *
 * Drives the post-registration checklist and the readiness banner. A new user
 * previously landed on an empty Results screen with no indication that a model
 * and a LinkedIn session were required, pasted a company URL, and got a run
 * that could not possibly work.
 */
router.get('/setup/status', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user!.id;
    const [preflight, config] = await Promise.all([
      preflightJob(userId),
      loadConfig(userId),
    ]);

    const outreachReady = Boolean(config.smtpUser && config.smtpPassword);

    res.status(200).json({
      ok: true,
      setup: {
        // Required to start a run at all.
        aiModel: preflight.checks.aiModel,
        linkedinSession: preflight.checks.linkedinSession,
        // Only needed to send a campaign, so it never blocks a run.
        outreachEmail: {
          ok: outreachReady,
          optional: true,
          detail: outreachReady
            ? `Sending as ${config.smtpUser}`
            : 'Not set up. Needed only to send campaign emails.',
        },
        readyToRun: preflight.ok,
      },
    });
  } catch (err) {
    next(err);
  }
});

export const appSettingsRouter = router;
