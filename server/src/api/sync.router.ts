import { Router } from 'express';
import { z } from 'zod';
import { requireAuthOrApiKey } from '../auth/middleware.js';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { ValidationError } from '../errors/AppError.js';

const router = Router();

// ─── Pagination Helpers ───────────────────────────────────────────
const MAX_PAGE_SIZE = 200;
const DEFAULT_PAGE_SIZE = 20;

function parsePagination(query: any): { skip: number; take: number } {
  const skip = Math.max(0, parseInt(query.skip, 10) || 0);
  const take = Math.min(
    MAX_PAGE_SIZE,
    Math.max(1, parseInt(query.take, 10) || DEFAULT_PAGE_SIZE),
  );
  return { skip, take };
}

// ─── Zod Schemas ──────────────────────────────────────────────────

const incrementStatsSchema = z.object({
  key: z.enum([
    'connectionsSent',
    'jobsFound',
    'companiesProcessed',
    'targetsFound',
    'emailsFound',
  ]),
  amount: z.number().int().positive().default(1),
});

const activityLogSchema = z.object({
  message: z.string().min(1, 'Message is required').max(2000),
  level: z.enum(['info', 'warn', 'error']).default('info'),
});

const outreachLogSchema = z.object({
  profileId: z.string().optional(),
  action: z.string().min(1, 'Action is required'),
  status: z.string().min(1, 'Status is required'),
  message: z.string().max(5000).optional(),
  details: z.record(z.any()).optional(),
});

const companyUpsertSchema = z.object({
  companyId: z.string().min(1, 'companyId is required'),
  name: z.string().default('Unknown'),
});

const workflowRunSchema = z.object({
  workflowType: z.string().min(1, 'workflowType is required'),
  status: z.string().default('completed'),
  params: z.record(z.any()).default({}),
  results: z.array(z.any()).default([]),
  errors: z.array(z.any()).default([]),
  startedAt: z.string().datetime().optional(),
});

// Helpers
function getTodayKey() {
  return new Date().toISOString().split('T')[0]; // YYYY-MM-DD
}

// ─── Daily Stats ──────────────────────────────────────────────────

router.get('/daily-stats', requireAuthOrApiKey, async (req, res, next) => {
  try {
    const userId = req.user!.id;
    const date = getTodayKey();

    let stats = await prisma.dailyStats.findUnique({
      where: { userId_date: { userId, date } },
    });

    if (!stats) {
      stats = await prisma.dailyStats.create({
        data: { userId, date },
      });
    }

    res.status(200).json({ ok: true, stats });
  } catch (err) {
    next(err);
  }
});

router.post(
  '/daily-stats/increment',
  requireAuthOrApiKey,
  async (req, res, next) => {
    try {
      const userId = req.user!.id;
      const date = getTodayKey();
      const { key, amount } = incrementStatsSchema.parse(req.body);

      const stats = await prisma.dailyStats.upsert({
        where: { userId_date: { userId, date } },
        create: { userId, date, [key]: amount },
        update: { [key]: { increment: amount } },
      });

      res.status(200).json({ ok: true, stats });
    } catch (err) {
      if (err instanceof z.ZodError) {
        return next(
          new ValidationError('Invalid increment parameters', err.errors),
        );
      }
      next(err);
    }
  },
);

router.post(
  '/daily-stats/reset',
  requireAuthOrApiKey,
  async (req, res, next) => {
    try {
      const userId = req.user!.id;
      const date = getTodayKey();

      const stats = await prisma.dailyStats.upsert({
        where: { userId_date: { userId, date } },
        create: { userId, date },
        update: {
          connectionsSent: 0,
          jobsFound: 0,
          companiesProcessed: 0,
          targetsFound: 0,
          emailsFound: 0,
        },
      });

      res.status(200).json({ ok: true, stats });
    } catch (err) {
      next(err);
    }
  },
);

// ─── Activity Log ─────────────────────────────────────────────────

router.get('/activity-log', requireAuthOrApiKey, async (req, res, next) => {
  try {
    const userId = req.user!.id;
    const { skip, take } = parsePagination(req.query);

    const [logs, total] = await Promise.all([
      prisma.activityLog.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        skip,
        take,
      }),
      prisma.activityLog.count({ where: { userId } }),
    ]);

    res.status(200).json({ ok: true, logs, pagination: { skip, take, total } });
  } catch (err) {
    next(err);
  }
});

router.post('/activity-log', requireAuthOrApiKey, async (req, res, next) => {
  try {
    const userId = req.user!.id;
    const { message, level } = activityLogSchema.parse(req.body);

    const log = await prisma.activityLog.create({
      data: { userId, message, level },
    });

    res.status(201).json({ ok: true, log });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return next(
        new ValidationError('Invalid activity log input', err.errors),
      );
    }
    next(err);
  }
});

// ─── Outreach Log ─────────────────────────────────────────────────

router.get('/outreach-log', requireAuthOrApiKey, async (req, res, next) => {
  try {
    const userId = req.user!.id;
    const { skip, take } = parsePagination(req.query);

    const [logs, total] = await Promise.all([
      prisma.outreachLog.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        skip,
        take,
      }),
      prisma.outreachLog.count({ where: { userId } }),
    ]);

    res.status(200).json({ ok: true, logs, pagination: { skip, take, total } });
  } catch (err) {
    next(err);
  }
});

router.post('/outreach-log', requireAuthOrApiKey, async (req, res, next) => {
  try {
    const userId = req.user!.id;
    const { profileId, action, status, message, details } =
      outreachLogSchema.parse(req.body);

    const log = await prisma.outreachLog.create({
      data: {
        userId,
        profileId,
        action,
        status,
        message,
        details: details || {},
      },
    });

    res.status(201).json({ ok: true, log });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return next(
        new ValidationError('Invalid outreach log input', err.errors),
      );
    }
    next(err);
  }
});

// ─── Processed Companies ─────────────────────────────────────────

router.get('/companies', requireAuthOrApiKey, async (req, res, next) => {
  try {
    const userId = req.user!.id;
    const companies = await prisma.company.findMany({
      select: { companyId: true },
    });
    // This is global to the system currently, not user scoped in DB schema
    res
      .status(200)
      .json({ ok: true, companies: companies.map((c) => c.companyId) });
  } catch (err) {
    next(err);
  }
});

router.post('/companies', requireAuthOrApiKey, async (req, res, next) => {
  try {
    const { companyId, name } = companyUpsertSchema.parse(req.body);

    const company = await prisma.company.upsert({
      where: { companyId },
      create: { companyId, name },
      update: { processedAt: new Date() },
    });

    res.status(201).json({ ok: true, company });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return next(new ValidationError('Invalid company data', err.errors));
    }
    next(err);
  }
});

// ─── Contacted Profiles ──────────────────────────────────────────

router.get(
  '/contacted-profiles',
  requireAuthOrApiKey,
  async (req, res, next) => {
    try {
      const userId = req.user!.id;
      const { skip, take } = parsePagination(req.query);

      const logs = await prisma.outreachLog.findMany({
        where: { userId, action: 'connection_sent' },
        select: { profileId: true },
        skip,
        take,
      });
      const profileIds = [
        ...new Set(logs.map((l) => l.profileId).filter(Boolean)),
      ];
      res.status(200).json({ ok: true, profiles: profileIds });
    } catch (err) {
      next(err);
    }
  },
);

// ─── Workflow Runs (Mass Connector) ──────────────────────────────

router.get('/workflow-history', requireAuthOrApiKey, async (req, res, next) => {
  try {
    const userId = req.user!.id;
    const { type } = req.query;
    const { skip, take } = parsePagination(req.query);

    if (!type || typeof type !== 'string') {
      return res
        .status(400)
        .json({ ok: false, error: 'type query parameter is required' });
    }

    const [runs, total] = await Promise.all([
      prisma.workflowRun.findMany({
        where: { userId, workflowType: type },
        orderBy: { createdAt: 'desc' },
        skip,
        take,
      }),
      prisma.workflowRun.count({ where: { userId, workflowType: type } }),
    ]);

    // Format output to match old local storage history format for easy UI parsing
    const history = runs.map((run) => ({
      id: run.id,
      startedAt: run.startedAt
        ? run.startedAt.getTime()
        : run.createdAt.getTime(),
      completedAt: run.completedAt ? run.completedAt.getTime() : null,
      params: run.params,
      results: run.results || [],
      status: run.status,
    }));

    res
      .status(200)
      .json({ ok: true, history, pagination: { skip, take, total } });
  } catch (err) {
    next(err);
  }
});

router.post('/workflow-run', requireAuthOrApiKey, async (req, res, next) => {
  try {
    const userId = req.user!.id;
    const { workflowType, status, params, results, errors, startedAt } =
      workflowRunSchema.parse(req.body);

    const run = await prisma.workflowRun.create({
      data: {
        userId,
        workflowType,
        status,
        params,
        results,
        errors,
        startedAt: startedAt ? new Date(startedAt) : new Date(),
        completedAt: new Date(),
      },
    });

    res.status(201).json({ ok: true, run });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return next(new ValidationError('Invalid workflow run data', err.errors));
    }
    next(err);
  }
});

export const syncRouter = router;
