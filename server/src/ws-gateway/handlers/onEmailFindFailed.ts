import type { Socket } from 'socket.io';
import { EmailFindFailedPayload } from '../events.js';
import { prisma } from '../../lib/prisma.js';
import { logger } from '../../lib/logger.js';
import { QualificationWorker } from '../../workers/qualificationWorker.js';

export async function onEmailFindFailed(
  socket: Socket,
  payload: EmailFindFailedPayload,
) {
  const { jobId, urlId, error } = payload;

  logger.warn(
    `[SocketHandler] EMAIL_FIND_FAILED received for Job: ${jobId}, URL ID: ${urlId} -> Reason: ${error}`,
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
        `[SocketHandler] Scraped profile not found for URL ID ${urlId}. Cannot update decision.`,
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
          email: null,
          emailSource: `failed: ${error.slice(0, 100)}`,
        },
      });
      // Finalize decision (updates stats and triggers orchestrator)
      await worker.finalizeQualifiedDecision(jobId, scrapedProfile.id, null);
    } else {
      await prisma.profileDecision.create({
        data: {
          profileId: scrapedProfile.id,
          email: null,
          emailSource: 'failed',
          isQualified: true,
          qualificationReason: 'Direct extension email lookup failed',
        },
      });

      // 4. Update status to scraped
      await prisma.profileUrl.update({
        where: { id: urlId },
        data: { status: 'scraped' },
      });

      // 5. Finalize decision as qualified but email not found
      await worker.finalizeQualifiedDecision(jobId, scrapedProfile.id, null);
    }
  } catch (err: any) {
    logger.error(
      { err, jobId, urlId },
      `[SocketHandler] Error handling EMAIL_FIND_FAILED socket payload`,
    );
    throw err;
  }
}
