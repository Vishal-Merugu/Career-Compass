import { Router } from 'express';
import { requireAuthOrApiKey } from '../auth/middleware.js';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';

const router = Router();

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
      const { key, amount = 1 } = req.body;

      const validKeys = [
        'connectionsSent',
        'jobsFound',
        'companiesProcessed',
        'targetsFound',
        'emailsFound',
      ];
      if (!validKeys.includes(key)) {
        return res.status(400).json({ ok: false, error: 'Invalid stat key' });
      }

      const stats = await prisma.dailyStats.upsert({
        where: { userId_date: { userId, date } },
        create: { userId, date, [key]: amount },
        update: { [key]: { increment: amount } },
      });

      res.status(200).json({ ok: true, stats });
    } catch (err) {
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
    const logs = await prisma.activityLog.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 20, // Return last 20 for dashboard
    });

    res.status(200).json({ ok: true, logs });
  } catch (err) {
    next(err);
  }
});

router.post('/activity-log', requireAuthOrApiKey, async (req, res, next) => {
  try {
    const userId = req.user!.id;
    const { message, level = 'info' } = req.body;

    const log = await prisma.activityLog.create({
      data: { userId, message, level },
    });

    res.status(201).json({ ok: true, log });
  } catch (err) {
    next(err);
  }
});

// ─── Outreach Log ─────────────────────────────────────────────────

router.get('/outreach-log', requireAuthOrApiKey, async (req, res, next) => {
  try {
    const userId = req.user!.id;
    const logs = await prisma.outreachLog.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 500,
    });

    res.status(200).json({ ok: true, logs });
  } catch (err) {
    next(err);
  }
});

router.post('/outreach-log', requireAuthOrApiKey, async (req, res, next) => {
  try {
    const userId = req.user!.id;
    const { profileId, action, status, message, details } = req.body;

    const log = await prisma.outreachLog.create({
      data: {
        userId,
        profileId,
        action: action || 'unknown',
        status: status || 'unknown',
        message,
        details,
      },
    });

    res.status(201).json({ ok: true, log });
  } catch (err) {
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
    const { companyId, name = 'Unknown' } = req.body;

    const company = await prisma.company.upsert({
      where: { companyId },
      create: { companyId, name },
      update: { processedAt: new Date() },
    });

    res.status(201).json({ ok: true, company });
  } catch (err) {
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
      const logs = await prisma.outreachLog.findMany({
        where: { userId, action: 'connection_sent' },
        select: { profileId: true },
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

    if (!type || typeof type !== 'string') {
      return res
        .status(400)
        .json({ ok: false, error: 'type query parameter is required' });
    }

    const runs = await prisma.workflowRun.findMany({
      where: { userId, workflowType: type },
      orderBy: { createdAt: 'desc' },
    });

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

    res.status(200).json({ ok: true, history });
  } catch (err) {
    next(err);
  }
});

router.post('/workflow-run', requireAuthOrApiKey, async (req, res, next) => {
  try {
    const userId = req.user!.id;
    const { workflowType, status, params, results, errors, startedAt } =
      req.body;

    const run = await prisma.workflowRun.create({
      data: {
        userId,
        workflowType,
        status: status || 'completed',
        params: params || {},
        results: results || [],
        errors: errors || [],
        startedAt: startedAt ? new Date(startedAt) : new Date(),
        completedAt: new Date(),
      },
    });

    res.status(201).json({ ok: true, run });
  } catch (err) {
    next(err);
  }
});

export const syncRouter = router;
