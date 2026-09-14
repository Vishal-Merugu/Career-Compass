import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../auth/middleware.js';
import { prisma } from '../lib/prisma.js';
import {
  parseCriteriaFromPrompt,
  runEasyApplyDiscovery,
  getRun,
  getAllRuns,
  generateJobsCsv,
} from '../services/jobFinder.service.js';
import {
  getSavedJobsFromDb,
  deleteSavedJobFromDb,
} from '../services/jobStorage.service.js';

const router = Router();

const parseSchema = z.object({
  prompt: z.string().min(1, 'Prompt is required'),
  countOverride: z.number().int().positive().optional(),
  easyApplyOnly: z.boolean().optional(),
});

const startSchema = z.object({
  prompt: z.string().min(1, 'Prompt is required'),
  countOverride: z.number().int().positive().optional(),
  easyApplyOnly: z.boolean().optional(),
});

const scheduleSchema = z.object({
  enabled: z.boolean(),
  prompt: z.string().min(1).max(10_000),
  targetCount: z.number().int().min(1).max(200).default(20),
  timezone: z.string().min(1).max(100),
});

function assertTimezone(timezone: string) {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: timezone });
  } catch {
    throw new Error('Please choose a valid timezone.');
  }
}

router.get('/schedule', requireAuth, async (req, res, next) => {
  try {
    const schedule = await prisma.easyApplySchedule.findUnique({
      where: { userId: req.user!.id },
    });
    res.json({ success: true, schedule });
  } catch (err) {
    next(err);
  }
});

router.put('/schedule', requireAuth, async (req, res, next) => {
  try {
    const input = scheduleSchema.parse(req.body);
    assertTimezone(input.timezone);
    const schedule = await prisma.easyApplySchedule.upsert({
      where: { userId: req.user!.id },
      create: { userId: req.user!.id, ...input },
      update: input,
    });
    res.json({ success: true, schedule });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/easy-apply/parse
 * Previews parsed criteria from a freeform prompt.
 */
router.post('/parse', requireAuth, async (req, res, next) => {
  try {
    const { prompt, countOverride, easyApplyOnly } = parseSchema.parse(
      req.body,
    );
    const userId = req.user!.id;
    const criteria = await parseCriteriaFromPrompt(
      prompt,
      userId,
      countOverride,
      easyApplyOnly,
    );
    res.json({ success: true, criteria });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/easy-apply/start
 * Starts discovery and AI qualification for jobs (with optional Easy Apply filter).
 */
router.post('/start', requireAuth, async (req, res, next) => {
  try {
    const { prompt, countOverride, easyApplyOnly } = startSchema.parse(
      req.body,
    );
    const userId = req.user!.id;
    const run = await runEasyApplyDiscovery(
      prompt,
      userId,
      countOverride,
      easyApplyOnly,
    );
    res.json({
      success: true,
      runId: run.id,
      status: run.status,
      targetCount: run.targetCount,
      criteria: run.criteria,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/easy-apply/runs
 * List all recent discovery runs.
 */
router.get('/runs', requireAuth, (req, res) => {
  const runs = getAllRuns()
    .filter((r) => r.userId === req.user!.id)
    .map((r) => ({
      id: r.id,
      prompt: r.prompt,
      status: r.status,
      targetCount: r.targetCount,
      scannedCount: r.scannedCount,
      qualifiedCount: r.qualifiedCount,
      rejectedCount: r.rejectedCount,
      createdAt: r.createdAt,
      completedAt: r.completedAt,
      criteria: r.criteria,
    }));
  res.json({ success: true, runs });
});

/**
 * GET /api/easy-apply/runs/:id
 * Get full state of a single discovery run, including jobs evaluated so far.
 */
router.get('/runs/:id', requireAuth, (req, res) => {
  const run = getRun(req.params.id);
  if (!run || run.userId !== req.user!.id) {
    res.status(404).json({ error: 'Run not found' });
    return;
  }
  res.json({ success: true, run });
});

/**
 * GET /api/easy-apply/runs/:id/csv
 * Download qualified jobs as a CSV file.
 */
router.get('/runs/:id/csv', requireAuth, (req, res) => {
  const run = getRun(req.params.id);
  if (!run || run.userId !== req.user!.id) {
    res.status(404).json({ error: 'Run not found' });
    return;
  }

  const passedJobs = run.jobs.filter((j) => j.passed);
  const csvData =
    run.csvContent ||
    generateJobsCsv(passedJobs.length > 0 ? passedJobs : run.jobs);

  const filename = `easy_apply_jobs_${run.id}.csv`;
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(csvData);
});

/**
 * GET /api/easy-apply/saved-jobs
 * Retrieve all filtered jobs saved in the database.
 */
router.get('/saved-jobs', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user!.id;
    const jobs = await getSavedJobsFromDb(userId);
    res.json({ success: true, jobs });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/easy-apply/saved-jobs/csv
 * Download all database-saved qualified jobs as a CSV file on-demand.
 */
router.get('/saved-jobs/csv', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user!.id;
    const savedJobs = await getSavedJobsFromDb(userId);

    const jobsToExport = savedJobs.map((j) => ({
      jobId: j.jobId,
      title: j.title,
      company: j.company,
      location: j.location,
      url: j.url,
      postedDate: j.postedDate || '',
      passed: j.passed,
      fitScore: j.fitScore,
      languageAssessment: j.languageAssessment,
      reason: j.reason,
      jdSnippet: j.jdSnippet || '',
    }));

    const csvData = generateJobsCsv(jobsToExport);
    const filename = `saved_easy_apply_jobs_${Date.now()}.csv`;
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csvData);
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /api/easy-apply/saved-jobs/:jobId
 * Remove a saved job from the database.
 */
router.delete('/saved-jobs/:jobId', requireAuth, async (req, res, next) => {
  try {
    const existing = await getSavedJobsFromDb(req.user!.id);
    if (!existing.some((job) => job.jobId === req.params.jobId)) {
      res.status(404).json({ error: 'Saved job not found' });
      return;
    }
    await deleteSavedJobFromDb(req.params.jobId);
    res.json({ success: true, deleted: req.params.jobId });
  } catch (err) {
    next(err);
  }
});

export const jobFinderRouter = router;
export const easyApplyFinderRouter = router;
