import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, requireAuthOrApiKey } from '../auth/middleware.js';
import { prisma } from '../lib/prisma.js';
import { ValidationError } from '../errors/AppError.js';
import { logger } from '../lib/logger.js';
import { getIo } from '../ws-gateway/index.js';
import { ConnectionRegistry } from '../ws-gateway/connectionRegistry.js';
import { ServerCommands } from '../ws-gateway/events.js';
import { dispatchNext } from '../orchestrator/dispatchNext.js';
import { checkJobStopCondition } from '../orchestrator/stopCondition.js';
import { startJob } from '../orchestrator/jobRunner.js';
import { preflightJob } from '../services/jobPreflight.service.js';
import { recordJobEvent } from '../services/jobEvents.service.js';
import { clearJobFailure } from '../services/jobControl.service.js';
import { describeJobError, type JobErrorCode } from '../errors/jobErrors.js';
import { deleteRuns } from '../services/dataDeletion.service.js';
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
/**
 * Is this account able to run a job at all?
 *
 * Split out so the dashboard can show the answer *before* the user fills in a
 * form and presses Start, rather than after.
 */
router.get('/jobs/preflight', requireAuthOrApiKey, async (req, res, next) => {
  try {
    res
      .status(200)
      .json({ ok: true, preflight: await preflightJob(req.user!.id) });
  } catch (err) {
    next(err);
  }
});

router.post('/jobs', requireAuthOrApiKey, async (req, res, next) => {
  try {
    const userId = req.user!.id;
    const body = createJobSchema.parse(req.body);

    // Refuse rather than fail slowly. Both of these are knowable in under a
    // second and both are fatal for every profile in the run: without a
    // LinkedIn session nothing can be fetched, and without a reachable model
    // nothing can be judged. The alternative — which is what used to happen —
    // is twenty minutes of real LinkedIn calls and zero results.
    const preflight = await preflightJob(userId);

    if (!preflight.ok) {
      logger.warn(
        { userId, code: preflight.code },
        '[JobsRouter] Refusing to start a run that cannot succeed',
      );
      return res.status(422).json({
        ok: false,
        code: preflight.code,
        message: preflight.message,
        fix: preflight.fix,
        preflight,
      });
    }

    // `dryRun` is how the New run form checks without creating anything.
    if (req.query.dryRun === 'true') {
      return res.status(200).json({ ok: true, preflight, dryRun: true });
    }

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

    // Start it here. Nothing else can: the run used to begin when the extension
    // opened a socket and was asked to collect URLs, and the server now makes
    // those calls itself. Not awaited — collection takes tens of seconds at the
    // configured pacing, and the client only needs the job id.
    void startJob(job.id).catch((err) =>
      logger.error(err, `[JobsRouter] Job ${job.id} failed to start`),
    );

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
        failureCode: true,
        failureDetail: true,
        configSnapshot: true,
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
        // Denormalised so the list can say *why* a run stopped without a join.
        // A paused run must never be indistinguishable from a running one.
        failureCode: job.failureCode,
        failureDetail: job.failureDetail,
        configSnapshot: job.configSnapshot,
        failure: job.failureCode
          ? describeJobError(job.failureCode as JobErrorCode, {})
          : null,
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

    // Profiles the model was asked about but never answered on. Reported apart
    // from rejections deliberately: "300 rejected" and "300 we could not
    // evaluate" mean opposite things, and only one of them is a result.
    const [rejectedCount, erroredCount] = await Promise.all([
      prisma.profileDecision.count({
        where: { profile: { profileUrl: { jobId } }, status: 'rejected' },
      }),
      prisma.profileDecision.count({
        where: { profile: { profileUrl: { jobId } }, status: 'error' },
      }),
    ]);

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
        searchParams: job.searchParams,
        failureCode: job.failureCode,
        failureDetail: job.failureDetail,
        configSnapshot: job.configSnapshot,
        failure: job.failureCode
          ? describeJobError(job.failureCode as JobErrorCode, {})
          : null,
      },
      stats: {
        collectedCount,
        scrapedCount,
        remainingCount,
        failedCount,
        rejectedCount,
        erroredCount,
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
 * The run's own log, in the words of whoever has to read it.
 *
 * Deliberately small — see services/jobEvents.service.ts for why a 400-profile
 * run produces tens of rows rather than thousands.
 */
router.get('/jobs/:id/events', requireAuthOrApiKey, async (req, res, next) => {
  try {
    const userId = req.user!.id;
    const jobId = req.params.id;

    const job = await prisma.searchJob.findFirst({
      where: { id: jobId, userId },
      select: { id: true },
    });

    if (!job) {
      return res.status(404).json({ ok: false, error: 'Job not found' });
    }

    const events = await prisma.jobEvent.findMany({
      where: { jobId },
      orderBy: { at: 'desc' },
      take: 200,
    });

    res.status(200).json({ ok: true, events });
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

    await recordJobEvent(jobId, {
      stage: 'run',
      code: 'RUN_CANCELLED',
      level: 'warn',
      message: 'Cancelled. Any profiles still queued were skipped.',
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

    await recordJobEvent(jobId, {
      stage: 'run',
      code: 'RUN_PAUSED',
      level: 'warn',
      message: 'Paused by you.',
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

    // Throw away decisions the model never actually made, so the profiles
    // behind them get evaluated again.
    //
    // **This costs no LinkedIn calls.** The profiles were already scraped and
    // their raw data is still in `ScrapedProfile`; only the verdict is missing.
    // Deleting the placeholder is what makes them orphans again, which is
    // precisely what `sweepOrphanedProfiles` picks up. Fixing an unreachable
    // model and pressing Resume therefore re-judges hundreds of people in
    // minutes instead of re-scraping them over hours.
    const requalified = await prisma.profileDecision.deleteMany({
      where: { status: 'error', profile: { profileUrl: { jobId } } },
    });

    if (requalified.count > 0) {
      logger.info(
        `[JobsRouter] Job ${jobId}: re-evaluating ${requalified.count} profile(s) that were never judged`,
      );
    }

    await clearJobFailure(jobId);

    const updatedJob = await prisma.searchJob.update({
      where: { id: jobId },
      data: { status: 'scraping' },
    });

    await recordJobEvent(jobId, {
      stage: 'run',
      code: 'RUN_RESUMED',
      message:
        requalified.count > 0
          ? `Resumed. Re-judging ${requalified.count} profile(s) already read from LinkedIn.`
          : 'Resumed.',
    });

    if (requalified.count > 0) {
      const { QualificationWorker } =
        await import('../workers/qualificationWorker.js');
      void QualificationWorker.getInstance()
        .sweepOrphanedProfiles()
        .catch((err) =>
          logger.error(err, `[JobsRouter] Re-qualification sweep failed`),
        );
    }

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
 * Delete runs, and everything they produced.
 *
 * `requireAuth`, not `requireAuthOrApiKey`: the extension's key is long-lived,
 * works from anywhere and is handed out so a browser can report scrape results.
 * Reporting a scrape must not confer the ability to erase one.
 *
 * The collection form takes ids in the body so the Runs list can delete a
 * selection in one call; `DELETE /jobs/:id` below is the same operation for the
 * single run a detail page knows about.
 */
const deleteJobsSchema = z.object({
  jobIds: z.array(z.string().min(1)).min(1).max(100),
});

router.delete('/jobs', requireAuth, async (req, res, next) => {
  try {
    const parsed = deleteJobsSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError('Invalid run deletion payload', {
        issues: parsed.error.errors,
      });
    }

    const deleted = await deleteRuns(req.user!.id, parsed.data.jobIds);
    res.status(200).json({ ok: true, deleted });
  } catch (err) {
    next(err);
  }
});

router.delete('/jobs/:id', requireAuth, async (req, res, next) => {
  try {
    const deleted = await deleteRuns(req.user!.id, [req.params.id]);
    res.status(200).json({ ok: true, deleted });
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
