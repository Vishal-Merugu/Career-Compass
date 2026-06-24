import { ConnectionRegistry } from '../connectionRegistry.js';
import { ServerCommands, ScrapeProfilePayload } from '../events.js';
import { getIo } from '../index.js';
import { logger } from '../../lib/logger.js';

export async function sendScrapeProfile(
  jobId: string,
  urlId: string,
  url: string,
): Promise<void> {
  const socketId = ConnectionRegistry.getInstance().getSocketId(jobId);
  if (!socketId) {
    logger.warn(
      `[Command] Cannot send SCRAPE_PROFILE: Job ${jobId} has no active socket connection`,
    );
    return;
  }

  logger.info(
    `[Command] Sending SCRAPE_PROFILE for Job ${jobId} (URL: ${url}) to socket ${socketId}`,
  );
  const io = getIo();
  const payload: ScrapeProfilePayload = { urlId, url };
  io.to(socketId).emit(ServerCommands.SCRAPE_PROFILE, payload);
}
