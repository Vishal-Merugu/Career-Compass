import type { Socket } from 'socket.io';
import { prisma } from '../../lib/prisma.js';
import { logger } from '../../lib/logger.js';
import { PrismaStorageAdapter } from '../../services/storage.adapter.js';

export async function onSessionInvalid(socket: Socket) {
  const jobId = socket.data.jobId;
  const userId = socket.data.userId;

  logger.warn(`[SocketHandler] SESSION_INVALID received for Job: ${jobId}`);

  try {
    // Update job status to paused_error
    await prisma.searchJob.update({
      where: { id: jobId },
      data: { status: 'paused_error' },
    });

    // Log the error in ActivityLog
    const adapter = new PrismaStorageAdapter(userId);
    await adapter.addActivityLog(
      '🚨 LinkedIn session expired or invalid. Job paused. Please re-authenticate.',
    );

    // Notify client of error
    socket.emit('ERROR', {
      message: 'LinkedIn session is invalid. Please log in to LinkedIn.',
      code: 'SESSION_INVALID',
    });
  } catch (err: any) {
    logger.error(
      { err, jobId },
      `[SocketHandler] Error handling session invalid event`,
    );
  }
}
