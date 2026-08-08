import type { Socket } from 'socket.io';
import { ProfileScrapedPayload } from '../events.js';
import { logger } from '../../lib/logger.js';
import {
  ingestScrapedProfile,
  type ScrapedRawData,
} from '../../services/scrapeIngest.service.js';

/**
 * A profile scraped by the extension.
 *
 * Kept as a fallback path. Scraping normally runs on the server now
 * (`workers/scrapeWorker.ts`), but the extension can still be driven the old
 * way, and both must produce identical rows — hence the shared ingest service
 * rather than a second copy of the write logic.
 */
export async function onProfileScraped(
  socket: Socket,
  payload: ProfileScrapedPayload,
) {
  const jobId = socket.data.jobId;
  const { urlId, rawData } = payload;

  logger.info(
    `[SocketHandler] PROFILE_SCRAPED received for Job: ${jobId}, URL ID: ${urlId}`,
  );

  await ingestScrapedProfile(jobId, urlId, rawData as ScrapedRawData);
}
