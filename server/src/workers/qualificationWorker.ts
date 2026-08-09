import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { evaluateProfile } from '../shared/llmClient.js';
import { IParsedProfile } from '../shared/parsers.js';
import { PrismaStorageAdapter } from '../services/storage.adapter.js';
import { checkJobStopCondition } from '../orchestrator/stopCondition.js';
import { telegramBotService } from '../telegram/bot.js';
import { publishQualifiedProfile } from '../services/profilePublisher.service.js';

export class QualificationWorker {
  private static instance: QualificationWorker | null = null;
  private queue: Array<{
    jobId: string;
    urlId: string;
    scrapedProfileId: string;
  }> = [];
  private isProcessing = false;

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
    logger.info(
      `[QualificationWorker] Enqueuing profile ${scrapedProfileId} for Job: ${jobId}`,
    );
    this.queue.push({ jobId, urlId, scrapedProfileId });
    this.triggerProcessing();
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
    logger.info(
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
      })),
      skills: raw.skills || [],
      location: profile.location || '',
      publicIdentifier:
        raw.publicIdentifier ||
        profile.profileUrl.url.split('/in/')[1]?.split('/')[0] ||
        '',
    };

    const targetCompany = parsedProfile.experiences[0]?.companyName || '';

    // Mailmeteor expects a clean vanity URL, not an internal Voyager ID
    const slug =
      parsedProfile.publicIdentifier ||
      profile.profileUrl.url.split('/in/')[1]?.split('/')[0] ||
      '';
    const linkedinUrl = slug
      ? `https://www.linkedin.com/in/${slug}/`
      : profile.profileUrl.url;

    // 3. Run LLM Profile Evaluation
    let isQualified = false;
    let qualificationReason = 'LLM evaluation failed';

    try {
      const searchParams = job.searchParams as any;
      const criteriaPrompt =
        searchParams.prompt ||
        'Evaluate if the profile represents an engineering manager, tech lead, software engineering director, software developer, recruiter, talent acquisition specialist, or co-founder. Reject entry level graduates.';

      logger.info(
        `[QualificationWorker] Evaluating profile ${profile.name} with LLM...`,
      );

      const evaluation = await evaluateProfile(
        parsedProfile,
        criteriaPrompt,
        config,
        targetCompany,
      );

      isQualified = evaluation.match;
      qualificationReason = evaluation.reason;

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
    } catch (err: any) {
      logger.error(err, `[QualificationWorker] LLM profile evaluation failed`);
      qualificationReason = `Evaluation error: ${err.message}`;
      if (chatId && telegramMsgId) {
        await telegramBotService.editMessageText(
          `⚠️ *Error Evaluating:* ${profile.name}\n*Error:* ${err.message}`,
          {
            chat_id: chatId,
            message_id: telegramMsgId,
            parse_mode: 'Markdown',
          },
        );
      }
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
        companyName: targetCompany,
        rawProfileJson: profile.rawData,
        email: null,
        emailSource: null,
        emailValidation: null,
        qualificationReason,
      });

      await this.finalizeQualifiedDecision(jobId, profile.id, null);
    } else {
      // Not qualified
      await prisma.profileDecision.create({
        data: {
          profileId: profile.id,
          email: null,
          emailSource: null,
          isQualified: false,
          qualificationReason,
        },
      });

      // Check stop condition or dispatch next
      await checkJobStopCondition(jobId);
    }
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
