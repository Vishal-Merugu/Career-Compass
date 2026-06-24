import type { Socket } from 'socket.io';
import { ProfileScrapeFailedPayload } from '../events.js';
import { prisma } from '../../lib/prisma.js';
import { logger } from '../../lib/logger.js';
import { checkJobStopCondition } from '../../orchestrator/stopCondition.js';

export async function onProfileScrapeFailed(
  socket: Socket,
  payload: ProfileScrapeFailedPayload,
) {
  const jobId = socket.data.jobId;
  const { urlId, error, isPermanent } = payload;

  logger.warn(
    `[SocketHandler] PROFILE_SCRAPE_FAILED received for Job: ${jobId}, URL ID: ${urlId}. Error: ${error}`,
  );

  try {
    const status = isPermanent ? 'failed_permanent' : 'failed_retryable';

    // Update ProfileUrl table in database
    await prisma.profileUrl.update({
      where: { id: urlId },
      data: {
        status,
        lastError: error,
      },
    });

    // Check stop condition to trigger the next step in the loop (or request next batch)
    await checkJobStopCondition(jobId);
  } catch (err: any) {
    logger.error(
      { err, jobId, urlId },
      `[SocketHandler] Error processing profile scrape failure`,
    );
    throw err;
  }
}
