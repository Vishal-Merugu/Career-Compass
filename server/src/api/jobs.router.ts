import { Router } from 'express';
import { z } from 'zod';
import { requireAuthOrApiKey } from '../auth/middleware.js';
import { prisma } from '../lib/prisma.js';
import { ValidationError } from '../errors/AppError.js';
import { logger } from '../lib/logger.js';
import { getIo } from '../ws-gateway/index.js';
import { ConnectionRegistry } from '../ws-gateway/connectionRegistry.js';
import { ServerCommands } from '../ws-gateway/events.js';
import { dispatchNext } from '../orchestrator/dispatchNext.js';
import { checkJobStopCondition } from '../orchestrator/stopCondition.js';
const router = Router();

const createJobSchema = z.object({
  limitRequested: z.number().int().positive().default(20),
  searchParams: z.object({
    companyUrl: z.string().url('companyUrl must be a valid URL'),
    prompt: z.string().min(1, 'Prompt is required'),
    batchSize: z.number().int().positive().optional().default(100),
  }),
});

/**
 * Start a new Search Job
 */
router.post('/jobs', requireAuthOrApiKey, async (req, res, next) => {
  try {
    const userId = req.user!.id;
    const body = createJobSchema.parse(req.body);

    logger.info({ userId, body }, `[JobsRouter] Creating new scraping job`);

    // Create the job database entry in initializing status
    const job = await prisma.searchJob.create({
      data: {
        userId,
        limitRequested: body.limitRequested,
        searchParams: body.searchParams as any,
        status: 'initializing',
      },
    });

    res.status(201).json({
      ok: true,
      jobId: job.id,
      job,
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return next(
        new ValidationError('Invalid job configuration parameters', err.errors),
      );
    }
    next(err);
  }
});

/**
 * Get Job Status dashboard
 */
router.get('/jobs', requireAuthOrApiKey, async (req, res, next) => {
  try {
    const userId = req.user!.id;

    const jobs = await prisma.searchJob.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        status: true,
        limitRequested: true,
        qualifiedCount: true,
        currentBatchNumber: true,
        createdAt: true,
        searchParams: true,
        _count: {
          select: { profileUrls: true },
        },
      },
    });

    res.status(200).json({
      ok: true,
      jobs: jobs.map((job) => ({
        id: job.id,
        status: job.status,
        limitRequested: job.limitRequested,
        qualifiedCount: job.qualifiedCount,
        currentBatchNumber: job.currentBatchNumber,
        createdAt: job.createdAt,
        searchParams: job.searchParams,
        totalUrls: job._count.profileUrls,
      })),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Get Job Status dashboard
 */
router.get('/jobs/:id/status', requireAuthOrApiKey, async (req, res, next) => {
  try {
    const userId = req.user!.id;
    const jobId = req.params.id;

    const job = await prisma.searchJob.findFirst({
      where: {
        id: jobId,
        userId,
      },
    });

    if (!job) {
      return res.status(404).json({ ok: false, error: 'Job not found' });
    }

    // Aggregate profile url counts for the dashboard
    const collectedCount = await prisma.profileUrl.count({ where: { jobId } });
    const scrapedCount = await prisma.profileUrl.count({
      where: { jobId, status: 'scraped' },
    });
    const remainingCount = await prisma.profileUrl.count({
      where: { jobId, status: 'queued' },
    });
    const failedCount = await prisma.profileUrl.count({
      where: {
        jobId,
        status: { in: ['failed_permanent', 'failed_retryable'] },
      },
    });

    // Fetch decisions summary (only qualified ones for the UI)
    const decisions = await prisma.profileDecision.findMany({
      where: {
        profile: {
          profileUrl: {
            jobId,
          },
        },
        isQualified: true,
      },
      include: {
        profile: true,
      },
    });

    const qualifiedCount = job.qualifiedCount || decisions.length;

    res.status(200).json({
      ok: true,
      job: {
        id: job.id,
        status: job.status,
        limitRequested: job.limitRequested,
        qualifiedCount,
        currentBatchNumber: job.currentBatchNumber,
        createdAt: job.createdAt,
      },
      stats: {
        collectedCount,
        scrapedCount,
        remainingCount,
        failedCount,
        inFlightCount:
          collectedCount - scrapedCount - remainingCount - failedCount,
      },
      decisions: decisions.map((d) => {
        const raw = d.profile.rawData as any;
        return {
          name: d.profile.name,
          headline: d.profile.headline,
          title: d.profile.headline,
          about: raw?.about || '',
          isQualified: d.isQualified,
          email: d.email,
        };
      }),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Cancel a running Search Job
 */
router.post('/jobs/:id/cancel', requireAuthOrApiKey, async (req, res, next) => {
  try {
    const userId = req.user!.id;
    const jobId = req.params.id;

    const job = await prisma.searchJob.findFirst({
      where: { id: jobId, userId },
    });

    if (!job) {
      return res.status(404).json({ ok: false, error: 'Job not found' });
    }

    // Skip remaining queued URLs
    await prisma.profileUrl.updateMany({
      where: { jobId, status: 'queued' },
      data: { status: 'skipped' },
    });

    // Update status to completed
    const updatedJob = await prisma.searchJob.update({
      where: { id: jobId },
      data: { status: 'completed' },
    });

    // Disconnect extension socket by emitting stop limit reached
    const socketId = ConnectionRegistry.getInstance().getSocketId(jobId);
    if (socketId) {
      const io = getIo();
      io.to(socketId).emit(ServerCommands.STOP_LIMIT_REACHED);
    }

    res.status(200).json({ ok: true, job: updatedJob });
  } catch (err) {
    next(err);
  }
});

/**
 * Pause a running Search Job
 */
router.post('/jobs/:id/pause', requireAuthOrApiKey, async (req, res, next) => {
  try {
    const userId = req.user!.id;
    const jobId = req.params.id;

    const job = await prisma.searchJob.findFirst({
      where: { id: jobId, userId },
    });

    if (!job) {
      return res.status(404).json({ ok: false, error: 'Job not found' });
    }

    const updatedJob = await prisma.searchJob.update({
      where: { id: jobId },
      data: { status: 'paused_error' },
    });

    // Notify extension socket to pause
    const socketId = ConnectionRegistry.getInstance().getSocketId(jobId);
    if (socketId) {
      const io = getIo();
      io.to(socketId).emit(ServerCommands.PAUSE);
    }

    res.status(200).json({ ok: true, job: updatedJob });
  } catch (err) {
    next(err);
  }
});

/**
 * Resume a paused Search Job
 */
router.post('/jobs/:id/resume', requireAuthOrApiKey, async (req, res, next) => {
  try {
    const userId = req.user!.id;
    const jobId = req.params.id;

    const job = await prisma.searchJob.findFirst({
      where: { id: jobId, userId },
    });

    if (!job) {
      return res.status(404).json({ ok: false, error: 'Job not found' });
    }

    // Reset any active scraping items back to queued so they can be re-run
    await prisma.profileUrl.updateMany({
      where: {
        jobId,
        status: { in: ['dispatched', 'scraping'] },
      },
      data: {
        status: 'queued',
        dispatchedAt: null,
      },
    });

    const updatedJob = await prisma.searchJob.update({
      where: { id: jobId },
      data: { status: 'scraping' },
    });

    // Notify extension socket to resume
    const socketId = ConnectionRegistry.getInstance().getSocketId(jobId);
    if (socketId) {
      const io = getIo();
      io.to(socketId).emit(ServerCommands.RESUME);
    }

    // Trigger next dispatch
    await dispatchNext(jobId);

    res.status(200).json({ ok: true, job: updatedJob });
  } catch (err) {
    next(err);
  }
});

/**
 * Update the requested limit for a running Search Job
 */
router.patch('/jobs/:id/limit', requireAuthOrApiKey, async (req, res, next) => {
  try {
    const userId = req.user!.id;
    const jobId = req.params.id;
    const { limitRequested } = req.body;

    if (typeof limitRequested !== 'number' || limitRequested <= 0) {
      return res
        .status(400)
        .json({ ok: false, error: 'limitRequested must be a positive number' });
    }

    const job = await prisma.searchJob.findFirst({
      where: { id: jobId, userId },
    });

    if (!job) {
      return res.status(404).json({ ok: false, error: 'Job not found' });
    }

    const updatedJob = await prisma.searchJob.update({
      where: { id: jobId },
      data: { limitRequested },
    });

    logger.info(
      `[JobsRouter] Updated limit for Job ${jobId} to ${limitRequested}`,
    );

    // Re-evaluate stop condition with the new limit
    await checkJobStopCondition(jobId);

    res.status(200).json({ ok: true, job: updatedJob });
  } catch (err) {
    next(err);
  }
});

export const jobsRouter = router;
