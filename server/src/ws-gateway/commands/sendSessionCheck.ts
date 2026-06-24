import { ConnectionRegistry } from '../connectionRegistry.js';
import { ServerCommands } from '../events.js';
import { getIo } from '../index.js';
import { logger } from '../../lib/logger.js';

export async function sendSessionCheck(jobId: string): Promise<void> {
  const socketId = ConnectionRegistry.getInstance().getSocketId(jobId);
  if (!socketId) {
    logger.warn(
      `[Command] Cannot send SESSION_CHECK: Job ${jobId} has no active socket connection`,
    );
    return;
  }

  logger.info(
    `[Command] Sending SESSION_CHECK for Job ${jobId} to socket ${socketId}`,
  );
  const io = getIo();
  io.to(socketId).emit(ServerCommands.SESSION_CHECK);
}
