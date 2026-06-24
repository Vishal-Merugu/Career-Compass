import { ConnectionRegistry } from '../connectionRegistry.js';
import { ServerCommands } from '../events.js';
import { getIo } from '../index.js';
import { logger } from '../../lib/logger.js';

export async function sendStopLimitReached(jobId: string): Promise<void> {
  const socketId = ConnectionRegistry.getInstance().getSocketId(jobId);
  if (!socketId) {
    logger.warn(
      `[Command] Cannot send STOP_LIMIT_REACHED: Job ${jobId} has no active socket connection`,
    );
    return;
  }

  logger.info(
    `[Command] Sending STOP_LIMIT_REACHED for Job ${jobId} to socket ${socketId}`,
  );
  const io = getIo();
  io.to(socketId).emit(ServerCommands.STOP_LIMIT_REACHED);
}
