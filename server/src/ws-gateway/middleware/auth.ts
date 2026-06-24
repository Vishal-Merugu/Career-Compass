import type { Socket } from 'socket.io';
import { prisma } from '../../lib/prisma.js';
import { logger } from '../../lib/logger.js';

export async function socketAuthMiddleware(
  socket: Socket,
  next: (err?: Error) => void,
) {
  try {
    const jobId = socket.handshake.query.jobId as string;
    const userId = socket.handshake.query.userId as string;
    const apiKey = socket.handshake.query.apiKey as string;

    if (!jobId || !userId || !apiKey) {
      logger.warn(
        `[SocketAuth] Rejecting connection: missing query params. socketId: ${socket.id}`,
      );
      return next(
        new Error('Authentication failed: Missing jobId, userId, or apiKey'),
      );
    }

    // Verify apiKey matches user and exists
    const user = await prisma.user.findUnique({
      where: { apiKey },
    });

    if (!user || user.id !== userId) {
      logger.warn(
        `[SocketAuth] Rejecting connection: Invalid API key for User ${userId}.`,
      );
      return next(new Error('Authentication failed: Invalid API Key'));
    }

    // Verify job belongs to user and exists
    const job = await prisma.searchJob.findFirst({
      where: {
        id: jobId,
        userId: userId,
      },
    });

    if (!job) {
      logger.warn(
        `[SocketAuth] Rejecting connection: Job ${jobId} for User ${userId} not found in database.`,
      );
      return next(new Error('Authentication failed: Invalid Job or User ID'));
    }

    // Save job and user references on socket data
    socket.data = socket.data || {};
    socket.data.jobId = jobId;
    socket.data.userId = userId;

    logger.info(
      `[SocketAuth] Approved connection for Job ${jobId}, User ${userId}. socketId: ${socket.id}`,
    );
    next();
  } catch (err: any) {
    logger.error(err, '[SocketAuth] Unexpected error during connection auth');
    next(new Error('Internal server error during authentication'));
  }
}
