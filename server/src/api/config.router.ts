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
  isServerRun: z.boolean().optional(),
});

/**
 * Retrieve UserConfig values
 */
router.get('/', requireAuthOrApiKey, async (req, res, next) => {
  try {
    const userId = req.user!.id;
    let config = await prisma.userConfig.findUnique({ where: { userId } });
    if (!config) {
      config = await prisma.userConfig.create({
        data: { userId, isServerRun: true },
      });
    } else if (!config.isServerRun) {
      config = await prisma.userConfig.update({
        where: { userId },
        data: { isServerRun: true },
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
