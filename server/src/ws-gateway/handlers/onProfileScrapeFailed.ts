import type { Socket } from 'socket.io';
import { ProfileScrapeFailedPayload } from '../events.js';
import { ingestScrapeFailure } from '../../services/scrapeIngest.service.js';

/**
 * A scrape the extension could not complete. See `onProfileScraped` for why
 * this path still exists.
 */
export async function onProfileScrapeFailed(
  socket: Socket,
  payload: ProfileScrapeFailedPayload,
) {
  const { urlId, error, isPermanent } = payload;

  await ingestScrapeFailure(socket.data.jobId, urlId, error, isPermanent);
}
