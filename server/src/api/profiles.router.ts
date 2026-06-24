import { Router } from 'express';
import { requireAuthOrApiKey } from '../auth/middleware.js';
import { prisma } from '../lib/prisma.js';

const router = Router();

/**
 * Retrieve list of parsed candidate profiles
 */
router.get('/profiles', requireAuthOrApiKey, async (req, res, next) => {
  try {
    const profiles = await prisma.profile.findMany({
      orderBy: { createdAt: 'desc' },
      include: { company: true },
    });
    res.status(200).json({ ok: true, profiles });
  } catch (err) {
    next(err);
  }
});

/**
 * Retrieve list of companies resolved
 */
router.get('/companies', requireAuthOrApiKey, async (req, res, next) => {
  try {
    const companies = await prisma.company.findMany({
      orderBy: { name: 'asc' },
    });
    res.status(200).json({ ok: true, companies });
  } catch (err) {
    next(err);
  }
});

export const profilesRouter = router;
