import type { Socket } from 'socket.io';
import { prisma } from '../../lib/prisma.js';
import { logger } from '../../lib/logger.js';
import { ServerCommands } from '../events.js';

export async function onCheckPendingEmails(socket: Socket) {
  const { userId } = socket.data;

  if (!userId) {
    logger.warn(
      `[SocketHandler] CHECK_PENDING_EMAILS received but no userId on socket data.`,
    );
    return;
  }

  logger.info(`[SocketHandler] CHECK_PENDING_EMAILS for User: ${userId}`);

  try {
    // Find decisions that are qualified but missing email due to disconnection
    const pendingDecisions = await prisma.profileDecision.findMany({
      where: {
        profile: {
          profileUrl: {
            job: {
              userId: userId,
            },
          },
        },
        isQualified: true,
        emailSource: 'disconnected',
      },
      include: {
        profile: {
          include: {
            profileUrl: true,
          },
        },
      },
      take: 50, // Limit to avoid overwhelming the client
    });

    if (pendingDecisions.length === 0) {
      logger.info(
        `[SocketHandler] No pending emails found for User: ${userId}`,
      );
      return;
    }

    logger.info(
      `[SocketHandler] Emitting ${pendingDecisions.length} pending email finding tasks to User: ${userId}`,
    );

    for (const decision of pendingDecisions) {
      // Mark as pending to avoid resending the same ones if client connects from multiple tabs
      await prisma.profileDecision.update({
        where: { id: decision.id },
        data: { emailSource: 'pending_retry' },
      });

      socket.emit(ServerCommands.FIND_EMAIL, {
        urlId: decision.profile.profileUrlId,
        url: decision.profile.profileUrl.url,
        firstName: decision.profile.name.split(' ')[0],
        lastName: decision.profile.name.split(' ').slice(1).join(' '),
        companyName: decision.profile.company || '',
        jobId: decision.profile.profileUrl.jobId,
      });
    }
  } catch (err: any) {
    logger.error(
      { err, userId },
      `[SocketHandler] Error handling CHECK_PENDING_EMAILS`,
    );
  }
}
