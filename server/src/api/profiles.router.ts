import { Router } from 'express';
import { z } from 'zod';
import { requireAuthOrApiKey } from '../auth/middleware.js';
import { prisma } from '../lib/prisma.js';
import { ValidationError } from '../errors/AppError.js';

const router = Router();

const paginationSchema = z.object({
  skip: z.coerce.number().int().min(0).default(0),
  take: z.coerce.number().int().min(1).max(200).default(100),
});

function parsePagination(query: unknown) {
  const result = paginationSchema.safeParse(query);
  if (!result.success) {
    throw new ValidationError('Invalid pagination parameters', {
      issues: result.error.errors,
    });
  }
  return result.data;
}

/**
 * Fields the client is allowed to see.
 *
 * An explicit select, not `include`. Prisma's default returns every scalar
 * column, which here meant shipping `rawProfileJson` — the raw Voyager payload
 * — and the full `about` text for every row. That is a large response and far
 * more personal data than any screen renders. Allow-listing also means a column
 * added to the schema later is not silently published.
 */
const PROFILE_FIELDS = {
  id: true,
  profileId: true,
  firstName: true,
  lastName: true,
  headline: true,
  location: true,
  linkedinUrl: true,
  email: true,
  emailSource: true,
  emailValidation: true,
  createdAt: true,
  company: {
    select: {
      id: true,
      companyId: true,
      name: true,
      slug: true,
      industry: true,
      website: true,
      employeeCount: true,
    },
  },
} as const;

/**
 * Parsed candidate profiles scoped to the current user's outreach history.
 *
 * Paginated: this returned every matching row unbounded, which is fine at 15
 * connections a day and not fine a year in.
 *
 * `stats` is computed over the WHOLE result set, not the returned page. The
 * dashboard's headline tiles read from it, so they stay correct no matter how
 * many pages have been loaded — counting the current page would quietly
 * understate every number.
 */
router.get('/profiles', requireAuthOrApiKey, async (req, res, next) => {
  try {
    const userId = req.user!.id;
    const { skip, take } = parsePagination(req.query);
    const where = { outreachLogs: { some: { userId } } };

    const [profiles, total, withEmail, companies] = await Promise.all([
      prisma.profile.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take,
        select: PROFILE_FIELDS,
      }),
      prisma.profile.count({ where }),
      prisma.profile.count({ where: { ...where, email: { not: null } } }),
      prisma.profile.findMany({
        where: { ...where, companyId: { not: null } },
        distinct: ['companyId'],
        select: { companyId: true },
      }),
    ]);

    res.status(200).json({
      ok: true,
      profiles,
      skip,
      take,
      total,
      stats: { total, withEmail, companies: companies.length },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Companies resolved from the user's scraped jobs.
 */
router.get('/companies', requireAuthOrApiKey, async (req, res, next) => {
  try {
    const userId = req.user!.id;
    const { skip, take } = parsePagination(req.query);
    const where = {
      profiles: { some: { outreachLogs: { some: { userId } } } },
    };

    const [companies, total] = await Promise.all([
      prisma.company.findMany({
        where,
        orderBy: { name: 'asc' },
        skip,
        take,
        select: {
          id: true,
          companyId: true,
          name: true,
          slug: true,
          industry: true,
          website: true,
          employeeCount: true,
        },
      }),
      prisma.company.count({ where }),
    ]);

    res.status(200).json({ ok: true, companies, skip, take, total });
  } catch (err) {
    next(err);
  }
});

export const profilesRouter = router;
