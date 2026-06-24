import type { Socket } from 'socket.io';
import { ServerCommands } from '../events.js';
import { logger } from '../../lib/logger.js';

export function wrapSocketHandler(
  socket: Socket,
  handler: (...args: any[]) => Promise<void> | void,
) {
  return async (...args: any[]) => {
    try {
      await handler(...args);
    } catch (err: any) {
      const socketId = socket.id;
      const jobId = socket.data?.jobId || 'unknown';

      logger.error(
        err,
        `[SocketErrorBoundary] Error in handler for socket: ${socketId}, Job: ${jobId}`,
      );

      // Emit error event to extension
      socket.emit(ServerCommands.ERROR, {
        message:
          err.message || 'An unexpected error occurred during execution.',
        code: err.code || 'INTERNAL_ERROR',
      });
    }
  };
}
