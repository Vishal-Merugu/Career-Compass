import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { companyNameFromUrl } from '../lib/companyName.js';
import { evaluateProfile } from '../shared/llmClient.js';
import { withLlmFallback } from '../services/llmRouter.service.js';
import { IParsedProfile } from '../shared/parsers.js';
import { PrismaStorageAdapter } from '../services/storage.adapter.js';
import { checkJobStopCondition } from '../orchestrator/stopCondition.js';
import { telegramBotService } from '../telegram/bot.js';
import { publishQualifiedProfile } from '../services/profilePublisher.service.js';
import { LlmError } from '../errors/AppError.js';
import { isRunFatal } from '../errors/jobErrors.js';
import { pauseJobWithFailure } from '../services/jobControl.service.js';
import { recordJobEvent } from '../services/jobEvents.service.js';

/**
 * How many profiles in a row may fail evaluation before the run is parked.
 *
 * Only non-fatal failures get to count this high — an unreachable host or a bad
 * key pauses on the first one, because it will fail identically for every
 * remaining profile. This budget is for `LLM_BAD_JSON`, where the next profile
 * genuinely might succeed.
 *
 * Five, not fifty: on 2026-08-09 a run evaluated 368 profiles against a model
 * it had never once reached, and reported itself healthy throughout.
 */
const CONSECUTIVE_ERROR_LIMIT = 5;

export class QualificationWorker {
  private static instance: QualificationWorker | null = null;
  private queue: Array<{
    jobId: string;
    urlId: string;
    scrapedProfileId: string;
  }> = [];
  private isProcessing = false;

  /** Consecutive evaluation failures per job. Reset by any success. */
  private consecutiveErrors = new Map<string, number>();

  private constructor() {}

  public static getInstance(): QualificationWorker {
    if (!QualificationWorker.instance) {
      QualificationWorker.instance = new QualificationWorker();
    }
    return QualificationWorker.instance;
  }

  /**
   * Enqueue a profile for qualification.
   */
  public enqueue(jobId: string, urlId: string, scrapedProfileId: string) {
    logger.debug(
      `[QualificationWorker] Enqueuing profile ${scrapedProfileId} for Job: ${jobId}`,
    );
    this.queue.push({ jobId, urlId, scrapedProfileId });
    this.triggerProcessing();
  }

  /**
   * Drop queued work for jobs that are about to be deleted.
   *
   * The queue is process memory, so nothing in the database can clear it. An
   * item left behind spends a round trip discovering its `ScrapedProfile` is
   * gone and then logs "not found in DB" — an error that reads like corruption
   * and is really just a delete the worker was never told about.
   */
  public forgetJobs(jobIds: string[]): void {
    const doomed = new Set(jobIds);
    const before = this.queue.length;
    this.queue = this.queue.filter((item) => !doomed.has(item.jobId));
    for (const jobId of doomed) this.consecutiveErrors.delete(jobId);

    const dropped = before - this.queue.length;
    if (dropped > 0) {
      logger.info(
        `[QualificationWorker] Dropped ${dropped} queued profile(s) for ${doomed.size} deleted job(s)`,
      );
    }
  }

  /**
   * Sweep for orphaned scraped profiles that haven't been qualified and re-enqueue them.
   */
  public async sweepOrphanedProfiles(): Promise<void> {
    try {
      logger.info(
        '[QualificationWorker] Sweeping for orphaned scraped profiles...',
      );
      const orphaned = await prisma.scrapedProfile.findMany({
        where: {
          decisions: {
            none: {},
          },
        },
        include: {
          profileUrl: true,
        },
      });

      if (orphaned.length === 0) {
        logger.info(
          '[QualificationWorker] No orphaned scraped profiles found.',
        );
        return;
      }

      logger.info(
        `[QualificationWorker] Found ${orphaned.length} orphaned scraped profiles. Re-enqueuing...`,
      );
      for (const p of orphaned) {
        this.enqueue(p.profileUrl.jobId, p.profileUrlId, p.id);
      }
    } catch (err) {
      logger.error(
        err,
        '[QualificationWorker] Error sweeping orphaned profiles',
      );
    }
  }

  /**
   * Triggers processing of the queue if not already running.
   */
  private triggerProcessing() {
    if (this.isProcessing) return;
    this.isProcessing = true;
    this.processNext().catch((err) => {
      logger.error(err, '[QualificationWorker] Error in queue loop');
      this.isProcessing = false;
    });
  }

  /**
   * Process next item in the queue.
   */
  private async processNext() {
    const item = this.queue.shift();
    if (!item) {
      this.isProcessing = false;
      return;
    }

    const { jobId, urlId, scrapedProfileId } = item;
    try {
      await this.qualifyProfile(jobId, urlId, scrapedProfileId);
    } catch (err: any) {
      logger.error(
        err,
        `[QualificationWorker] Failed qualifying profile ${scrapedProfileId} for job ${jobId}`,
      );
    }

    // Process next item
    setTimeout(() => this.processNext(), 0);
  }

  /**
   * Qualify profile details via LLM and search for emails.
   */
  private async qualifyProfile(
    jobId: string,
    urlId: string,
    scrapedProfileId: string,
  ) {
    logger.debug(
      `[QualificationWorker] Processing profile ${scrapedProfileId} for Job ${jobId}`,
    );

    // 1. Fetch profile and job data
    const profile = await prisma.scrapedProfile.findUnique({
      where: { id: scrapedProfileId },
      include: { profileUrl: true },
    });

    if (!profile) {
      logger.error(
        `[QualificationWorker] ScrapedProfile ${scrapedProfileId} not found in DB`,
      );
      return;
    }

    const job = await prisma.searchJob.findUnique({
      where: { id: jobId },
      include: { user: true },
    });

    if (!job) {
      logger.error(`[QualificationWorker] SearchJob ${jobId} not found in DB`);
      return;
    }

    const chatId = job.user?.telegramId;
    let telegramMsgId: number | undefined;

    if (chatId) {
      const msg = await telegramBotService.sendMessage(
        chatId,
        `🔍 *Evaluating Profile...*\n*Name:* ${profile.name}\n*Headline:* ${profile.headline || 'None'}`,
        { parse_mode: 'Markdown' },
      );
      if (msg) {
        telegramMsgId = msg.message_id;
      }
    }

    // 2. Fetch User config & prepare adapter
    const storageAdapter = new PrismaStorageAdapter(job.userId);
    const config = await storageAdapter.getConfig();

    const raw = profile.rawData as any;
    const nameParts = (profile.name || '').trim().split(' ');
    const firstName = nameParts[0] || '';
    const lastName = nameParts.slice(1).join(' ') || '';

    // Convert raw data to IParsedProfile format
    const parsedProfile: IParsedProfile = {
      firstName,
      lastName,
      headline: profile.headline || '',
      about: raw.summary || '',
      experiences: (raw.experience || []).map((exp: any) => ({
        title: exp.title || '',
        companyName: exp.company || exp.companyName || '',
        description: exp.description || '',
        employmentType: exp.employmentType || '',
        timePeriod: {
          startDate: {
            year: exp.startDate?.year || '',
            month: exp.startDate?.month || '',
          },
          endDate: {
            year: exp.endDate?.year || '',
            month: exp.endDate?.month || '',
          },
        },
      })),
      education: (raw.education || []).map((edu: any) => ({
        school: edu.school || '',
        degree: edu.degree || '',
        fieldOfStudy: edu.fieldOfStudy || '',
        timePeriod: {
          startDate: { year: edu.timePeriod?.startDate?.year || '' },
          endDate: { year: edu.timePeriod?.endDate?.year || '' },
        },
      })),
      skills: raw.skills || [],
      location: profile.location || '',
      publicIdentifier:
        raw.publicIdentifier ||
        profile.profileUrl.url.split('/in/')[1]?.split('/')[0] ||
        '',
    };

    // The company the *run* searched for, not the one this person happens to
    // work at. Reading it off the profile made the prompt's "is this person at
    // the target company?" step circular — it asked the model to confirm a fact
    // it had just been handed — so nobody could ever fail it.
    const searchedCompany = companyNameFromUrl(
      (job.searchParams as { companyUrl?: string } | null)?.companyUrl,
    );

    // Falls back to the old behaviour for a job with no parseable company URL,
    // so an odd search URL degrades to a weaker check rather than an empty one.
    const targetCompany =
      searchedCompany || parsedProfile.experiences[0]?.companyName || '';

    // What Results and the campaign show. Still the person's own current
    // employer — the searched company is the filter, not their job.
    const currentCompany = parsedProfile.experiences[0]?.companyName || '';

    // Mailmeteor expects a clean vanity URL, not an internal Voyager ID
    const slug =
      parsedProfile.publicIdentifier ||
      profile.profileUrl.url.split('/in/')[1]?.split('/')[0] ||
      '';
    const linkedinUrl = slug
      ? `https://www.linkedin.com/in/${slug}/`
      : profile.profileUrl.url;

    // 3. Run LLM Profile Evaluation
    const searchParams = job.searchParams as { prompt?: string };
    const criteriaPrompt =
      searchParams.prompt ||
      'Evaluate if the profile represents an engineering manager, tech lead, software engineering director, software developer, recruiter, talent acquisition specialist, or co-founder. Reject entry level graduates.';

    logger.debug(
      `[QualificationWorker] Evaluating profile ${profile.name} with LLM...`,
    );

    let isQualified = false;
    let qualificationReason = '';

    try {
      // Through the router, so one exhausted free tier moves to the next key
      // instead of pausing the run. The whole evaluation is inside the
      // callback — including the JSON parse — so a model that answers with
      // prose falls through to one that can follow the format.
      const evaluation = await withLlmFallback(
        job.userId,
        (target) =>
          evaluateProfile(parsedProfile, criteriaPrompt, target, targetCompany),
        { config },
      );

      isQualified = evaluation.match;
      qualificationReason = evaluation.reason;

      // A verdict arrived, so whatever was failing has recovered.
      this.consecutiveErrors.delete(jobId);

      logger.info(
        `[QualificationWorker] LLM Evaluation for ${profile.name}: Match=${isQualified}, Reason=${qualificationReason}`,
      );

      if (chatId && telegramMsgId) {
        const icon = isQualified ? '✅' : '❌';
        const resultText = isQualified ? 'Qualified' : 'Rejected';
        // Keep the reason clean, shorten if it's too long
        const cleanReason =
          qualificationReason.length > 200
            ? qualificationReason.substring(0, 200) + '...'
            : qualificationReason;
        await telegramBotService.editMessageText(
          `${icon} *${resultText}:* ${profile.name}\n*Reason:* ${cleanReason}`,
          {
            chat_id: chatId,
            message_id: telegramMsgId,
            parse_mode: 'Markdown',
          },
        );
      }
    } catch (err) {
      // The model never gave a verdict. This is emphatically **not** a
      // rejection, and recording it as one is what let a run with an
      // unreachable model look like a run full of unsuitable people.
      if (err instanceof LlmError) {
        await this.recordEvaluationFailure(jobId, profile.id, {
          name: profile.name,
          error: err,
          chatId,
          telegramMsgId,
        });
        return;
      }
      throw err;
    }

    // 4. Record the decision. **No email lookup happens here.**
    //
    // It used to: a qualified profile went straight into `findEmail()`. The
    // problem is that the server can only reach two layers — the metered API and
    // pattern+SMTP — so without a key every profile resolved to a
    // `pattern_guess` before a real browser ever saw it. And because a guess
    // *is* an answer, the row looked done and never got upgraded.
    //
    // Lookups are now started deliberately from Results ("Find emails"), which
    // queues them for the extension's widget driver — a real browser, where the
    // captcha actually solves. See docs/adr/0006-email-lookup-queue.md.
    if (isQualified) {
      await prisma.profileDecision.create({
        data: {
          profileId: profile.id,
          email: null,
          // Not `not_found` and not `disabled`: nothing has been attempted yet.
          emailSource: null,
          isQualified: true,
          status: 'qualified',
          qualificationReason,
        },
      });

      await publishQualifiedProfile(job.userId, {
        slug,
        linkedinUrl,
        firstName,
        lastName,
        headline: profile.headline,
        about: parsedProfile.about,
        location: profile.location,
        companyName: currentCompany,
        rawProfileJson: profile.rawData,
        email: null,
        emailSource: null,
        emailValidation: null,
        qualificationReason,
        searchJobId: jobId,
      });

      await this.finalizeQualifiedDecision(jobId, profile.id, null);
    } else {
      // Not qualified — an actual verdict from the model, not a failure.
      await prisma.profileDecision.create({
        data: {
          profileId: profile.id,
          email: null,
          emailSource: null,
          isQualified: false,
          status: 'rejected',
          qualificationReason,
        },
      });

      // Check stop condition or dispatch next
      await checkJobStopCondition(jobId);
    }

    await this.recordProgress(jobId);
  }

  /**
   * Handle an evaluation that never produced a verdict.
   *
   * Writes a decision with `status: 'error'` — which does **not** resolve the
   * URL for the stop condition and is deleted and retried on resume — and then
   * decides whether the run can continue.
   *
   * The two cases are genuinely different. An unreachable host, a rejected key,
   * a missing model or an exhausted quota will fail identically for every
   * remaining profile, so there is nothing to learn from trying 300 more; the
   * run pauses immediately. Unreadable output is about this particular prompt,
   * so it is counted, and only a run of them stops the job.
   */
  private async recordEvaluationFailure(
    jobId: string,
    scrapedProfileId: string,
    context: {
      name: string;
      error: LlmError;
      chatId?: string | null;
      telegramMsgId?: number;
    },
  ): Promise<void> {
    const { error, name, chatId, telegramMsgId } = context;

    logger.error(
      `[QualificationWorker] Evaluation failed for ${name}: ${error.code} — ${error.message}`,
    );

    await prisma.profileDecision.create({
      data: {
        profileId: scrapedProfileId,
        email: null,
        emailSource: null,
        isQualified: false,
        status: 'error',
        qualificationReason: error.message,
      },
    });

    if (chatId && telegramMsgId) {
      await telegramBotService.editMessageText(
        `⚠️ *Could not evaluate:* ${name}\n${error.message}`,
        { chat_id: chatId, message_id: telegramMsgId, parse_mode: 'Markdown' },
      );
    }

    const errorCtx = {
      model: error.model ?? null,
      provider: error.provider ?? null,
      retryAfterSeconds: error.retryAfterSeconds ?? null,
    };

    if (isRunFatal(error.code)) {
      this.consecutiveErrors.delete(jobId);
      await pauseJobWithFailure(jobId, {
        stage: 'qualify',
        code: error.code,
        detail: error.detail ?? null,
        ctx: errorCtx,
      });
      return;
    }

    const seen = (this.consecutiveErrors.get(jobId) ?? 0) + 1;
    this.consecutiveErrors.set(jobId, seen);

    if (seen >= CONSECUTIVE_ERROR_LIMIT) {
      this.consecutiveErrors.delete(jobId);
      await pauseJobWithFailure(jobId, {
        stage: 'qualify',
        code: error.code,
        detail:
          `${seen} profiles in a row could not be evaluated. ${error.detail ?? ''}`.trim(),
        ctx: errorCtx,
      });
      return;
    }

    await recordJobEvent(jobId, {
      stage: 'qualify',
      code: error.code,
      level: 'warn',
      message: `${error.message} Skipped this profile and carried on.`,
      detail: error.detail ?? null,
      profileRef: name,
    });

    await checkJobStopCondition(jobId);
  }

  /**
   * One rolling "N of M qualified" line for the run.
   *
   * Rolls up onto a single row by design — see jobEvents.service.ts. Individual
   * decisions are not events: qualified people are listed on the run page as
   * people, and rejections are the noise this log exists to avoid.
   */
  private async recordProgress(jobId: string): Promise<void> {
    const job = await prisma.searchJob.findUnique({
      where: { id: jobId },
      select: { qualifiedCount: true, limitRequested: true },
    });
    if (!job) return;

    await recordJobEvent(jobId, {
      stage: 'qualify',
      code: 'QUALIFY_PROGRESS',
      message: `${job.qualifiedCount} of ${job.limitRequested} profiles qualified.`,
    });
  }

  /**
   * Finalizes the qualification decision, updates stats, logs activity, and checks stop conditions.
   */
  public async finalizeQualifiedDecision(
    jobId: string,
    profileId: string,
    email: string | null,
  ) {
    try {
      const job = await prisma.searchJob.findUnique({
        where: { id: jobId },
      });
      if (!job) {
        logger.error(
          `[QualificationWorker] Job ${jobId} not found in finalizeQualifiedDecision`,
        );
        return;
      }

      const storageAdapter = new PrismaStorageAdapter(job.userId);

      // 1. Update stats
      await prisma.searchJob.update({
        where: { id: jobId },
        data: {
          qualifiedCount: { increment: 1 },
        },
      });

      // Update daily stats for target and email discovery
      await storageAdapter.updateDailyStats({
        targetsFound: 1,
        emailsFound: email ? 1 : 0,
      });

      // Log success activity
      const profile = await prisma.scrapedProfile.findUnique({
        where: { id: profileId },
      });
      if (profile) {
        await storageAdapter.addActivityLog(
          `Qualified profile: ${profile.name} - ${profile.headline || ''} (${profile.company || ''})`,
        );
      }

      // 2. Check stop condition or dispatch next
      await checkJobStopCondition(jobId);
    } catch (err) {
      logger.error(
        err,
        `[QualificationWorker] Error in finalizeQualifiedDecision for job ${jobId}`,
      );
    }
  }
}
