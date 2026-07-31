import { Router } from 'express';
import { requireAuthOrApiKey } from '../auth/middleware.js';
import { prisma } from '../lib/prisma.js';

const router = Router();

/**
 * Retrieve list of parsed candidate profiles scoped to the current user's outreach history
 */
router.get('/profiles', requireAuthOrApiKey, async (req, res, next) => {
  try {
    const userId = req.user!.id;
    const profiles = await prisma.profile.findMany({
      where: {
        outreachLogs: {
          some: { userId },
        },
      },
      orderBy: { createdAt: 'desc' },
      include: { company: true },
    });
    res.status(200).json({ ok: true, profiles });
  } catch (err) {
    next(err);
  }
});

/**
 * Retrieve list of companies resolved (scoped to user's scraped jobs)
 */
router.get('/companies', requireAuthOrApiKey, async (req, res, next) => {
  try {
    const userId = req.user!.id;
    const companies = await prisma.company.findMany({
      where: {
        profiles: {
          some: {
            outreachLogs: {
              some: { userId },
            },
          },
        },
      },
      orderBy: { name: 'asc' },
    });
    res.status(200).json({ ok: true, companies });
  } catch (err) {
    next(err);
  }
});

export const profilesRouter = router;
