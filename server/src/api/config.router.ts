import { Router } from 'express';
import { z } from 'zod';
import { requireAuthOrApiKey } from '../auth/middleware.js';
import { prisma } from '../lib/prisma.js';
import { ValidationError } from '../errors/AppError.js';

const router = Router();

const updateConfigSchema = z.object({
  keywords: z.string().optional(),
  locations: z.string().optional(),
  dailyLimit: z.number().int().min(1).optional(),
  llmProvider: z.string().optional(),
  llmApiKey: z.string().nullable().optional(),
  llmUrl: z.string().optional(),
  llmModel: z.string().optional(),
  userContext: z.string().nullable().optional(),
  targetGeoId: z.string().optional(),
  emailFinderEnabled: z.boolean().optional(),
});

/**
 * Fields this endpoint may return.
 *
 * An explicit select, for the same reason `GET /api/auth/me` does not echo
 * `req.user`: returning the whole row publishes whatever column is added next.
 * `smtpPassword` is the live example — it is an encrypted Google app password,
 * and this route is reachable with the extension's long-lived `x-api-key`, so
 * echoing the row would hand a scraping credential the ability to read a
 * sending credential. `llmApiKey` is excluded on the same grounds.
 *
 * Outreach settings are read and written through `/api/settings/outreach`,
 * which is cookie-only.
 */
const CONFIG_FIELDS = {
  id: true,
  userId: true,
  keywords: true,
  locations: true,
  dailyLimit: true,
  llmProvider: true,
  llmUrl: true,
  llmModel: true,
  userContext: true,
  targetGeoId: true,
  emailFinderEnabled: true,
} as const;

/**
 * Retrieve UserConfig values
 */
router.get('/', requireAuthOrApiKey, async (req, res, next) => {
  try {
    const userId = req.user!.id;
    let config = await prisma.userConfig.findUnique({
      where: { userId },
      select: CONFIG_FIELDS,
    });
    // Created on first read so a fresh account has defaults to edit. There used
    // to be an `else` branch here that wrote `isServerRun: true` back on every
    // GET where it was false — a write on a read path, setting a flag nothing
    // ever read. The flag is gone; so is the write.
    if (!config) {
      config = await prisma.userConfig.create({
        data: { userId },
        select: CONFIG_FIELDS,
      });
    }
    res.status(200).json({ ok: true, config });
  } catch (err) {
    next(err);
  }
});

/**
 * Save updates to UserConfig values
 */
router.post('/', requireAuthOrApiKey, async (req, res, next) => {
  try {
    const userId = req.user!.id;
    const updateData = updateConfigSchema.parse(req.body);

    const config = await prisma.userConfig.upsert({
      where: { userId },
      update: updateData,
      create: { userId, ...updateData },
      select: CONFIG_FIELDS,
    });

    res.status(200).json({ ok: true, config });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return next(
        new ValidationError('Invalid configuration parameters', err.errors),
      );
    }
    next(err);
  }
});

export const configRouter = router;
