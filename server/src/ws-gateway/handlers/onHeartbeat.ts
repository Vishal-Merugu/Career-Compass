import type { Socket } from 'socket.io';
import { ConnectionRegistry } from '../connectionRegistry.js';
import { prisma } from '../../lib/prisma.js';
import { logger } from '../../lib/logger.js';

export async function onHeartbeat(socket: Socket) {
  const socketId = socket.id;
  const jobId = socket.data?.jobId || 'unknown';

  logger.debug(
    `[SocketHandler] HEARTBEAT received for Socket: ${socketId}, Job: ${jobId}`,
  );

  // Update in-memory registry
  const ok = ConnectionRegistry.getInstance().heartbeat(socketId);

  if (!ok) {
    logger.warn(
      `[SocketHandler] Heartbeat received for unregistered socket: ${socketId}`,
    );
  }

  // Update DB heartbeat timestamp
  try {
    await prisma.extensionConnection.updateMany({
      where: {
        socketId,
        disconnectedAt: null,
      },
      data: {
        lastHeartbeatAt: new Date(),
      },
    });
  } catch (err: any) {
    logger.error(
      { err, socketId, jobId },
      `[SocketHandler] Failed updating heartbeat in database`,
    );
  }
}
