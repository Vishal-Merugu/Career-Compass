import type { Socket } from 'socket.io';
import { EmailFoundPayload } from '../events.js';
import { prisma } from '../../lib/prisma.js';
import { logger } from '../../lib/logger.js';
import { QualificationWorker } from '../../workers/qualificationWorker.js';
import { PrismaStorageAdapter } from '../../services/storage.adapter.js';
import { telegramBotService } from '../../telegram/bot.js';

export async function onEmailFound(socket: Socket, payload: EmailFoundPayload) {
  const { jobId, urlId, email, source } = payload;

  logger.info(
    `[SocketHandler] EMAIL_FOUND received for Job: ${jobId}, URL ID: ${urlId} -> ${email}`,
  );

  // 1. Clear safety timeout
  const worker = QualificationWorker.getInstance();
  const timeoutId = worker.pendingTimeouts.get(urlId);
  if (timeoutId) {
    clearTimeout(timeoutId);
    worker.pendingTimeouts.delete(urlId);
    logger.debug(
      `[SocketHandler] Cleared email safety timeout for URL ID: ${urlId}`,
    );
  }

  try {
    // 2. Fetch the scraped profile associated with the urlId
    const scrapedProfile = await prisma.scrapedProfile.findUnique({
      where: { profileUrlId: urlId },
    });

    if (!scrapedProfile) {
      logger.error(
        `[SocketHandler] Scraped profile not found for URL ID ${urlId}. Cannot save email.`,
      );
      return;
    }

    // 3. Update or create the ProfileDecision
    const existingDecision = await prisma.profileDecision.findFirst({
      where: {
        profileId: scrapedProfile.id,
        isQualified: true,
      },
    });

    if (existingDecision) {
      await prisma.profileDecision.update({
        where: { id: existingDecision.id },
        data: {
          email,
          emailSource: source || 'mailmeteor',
        },
      });

      if (email) {
        const job = await prisma.searchJob.findUnique({
          where: { id: jobId },
          include: { user: true },
        });
        if (job) {
          if (job.user?.telegramId) {
            telegramBotService
              .sendMessage(
                job.user.telegramId,
                `✉️ *Email Found:* ${scrapedProfile.name} (via ${source || 'mailmeteor'})`,
                { parse_mode: 'Markdown' },
              )
              .catch((err) =>
                logger.error(
                  err,
                  'Failed to send telegram email found notification',
                ),
              );
          }
        }
      }

      // Finalize the decision (updates stats and triggers orchestrator)
      await worker.finalizeQualifiedDecision(jobId, scrapedProfile.id, email);
    } else {
      await prisma.profileDecision.create({
        data: {
          profileId: scrapedProfile.id,
          email,
          emailSource: source || 'mailmeteor',
          isQualified: true,
          qualificationReason: 'Direct extension email lookup',
        },
      });

      // 4. Update status to scraped
      await prisma.profileUrl.update({
        where: { id: urlId },
        data: { status: 'scraped' },
      });

      // 5. Finalize the decision (update SearchJob count and trigger orchestrator/check stop condition)
      await worker.finalizeQualifiedDecision(jobId, scrapedProfile.id, email);

      if (email) {
        const job = await prisma.searchJob.findUnique({
          where: { id: jobId },
          include: { user: true },
        });
        if (job?.user?.telegramId) {
          telegramBotService
            .sendMessage(
              job.user.telegramId,
              `✉️ *Email Found:* ${scrapedProfile.name} (via ${source || 'mailmeteor'})`,
              { parse_mode: 'Markdown' },
            )
            .catch((err) =>
              logger.error(
                err,
                'Failed to send telegram email found notification',
              ),
            );
        }
      }
    }
  } catch (err: any) {
    logger.error(
      { err, jobId, urlId },
      `[SocketHandler] Error handling EMAIL_FOUND socket payload`,
    );
    throw err;
  }
}
