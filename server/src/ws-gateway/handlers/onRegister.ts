import type { Socket } from 'socket.io';
import { ConnectionRegistry } from '../connectionRegistry.js';
import { RegisterPayload } from '../events.js';
import { prisma } from '../../lib/prisma.js';
import { logger } from '../../lib/logger.js';
import { syncAndResumeJob } from '../../orchestrator/syncAndResume.js';
import { getIo } from '../index.js';

export async function onRegister(socket: Socket, payload: RegisterPayload) {
  const { jobId, userId } = socket.data;

  logger.info(
    `[SocketHandler] REGISTER received for Job: ${jobId}, User: ${userId}`,
  );

  const registry = ConnectionRegistry.getInstance();
  const kickedSocketId = registry.register(jobId, userId, socket.id);

  if (kickedSocketId) {
    // Kick the duplicate socket connection
    socket.to(kickedSocketId).emit('ERROR', {
      message: 'New tab or window registered for this job. Connection closed.',
      code: 'DUPLICATE_CONNECTION',
    });
    // Disconnect the kicked socket
    const io = getIo();
    const oldSocket = io.sockets.sockets.get(kickedSocketId);
    if (oldSocket) {
      logger.info(
        `[SocketHandler] Disconnecting kicked socket: ${kickedSocketId}`,
      );
      oldSocket.disconnect(true);
    }
  }

  // Persist the connection state to DB
  await prisma.extensionConnection.create({
    data: {
      jobId,
      socketId: socket.id,
      connectedAt: new Date(),
      lastHeartbeatAt: new Date(),
    },
  });

  // Delegate business logic directly to orchestrator sync & resume module
  await syncAndResumeJob(jobId);
}
