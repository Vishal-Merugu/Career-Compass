import type { Socket } from 'socket.io';
import { logger } from '../../lib/logger.js';
import { syncAndResumeJobImpl } from '../../orchestrator/syncAndResume.js';

export async function onSessionValid(socket: Socket) {
  const jobId = socket.data.jobId;

  logger.info(`[SocketHandler] SESSION_VALID received for Job: ${jobId}`);

  try {
    // Proceed with the actual sync and resume logic
    await syncAndResumeJobImpl(jobId);
  } catch (err: any) {
    logger.error(
      { err, jobId },
      `[SocketHandler] Error handling session valid event`,
    );
  }
}
