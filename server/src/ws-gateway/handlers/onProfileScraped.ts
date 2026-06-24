import type { Socket } from 'socket.io';
import { ProfileScrapedPayload } from '../events.js';
import { prisma } from '../../lib/prisma.js';
import { logger } from '../../lib/logger.js';
import { QualificationWorker } from '../../workers/qualificationWorker.js';

export async function onProfileScraped(
  socket: Socket,
  payload: ProfileScrapedPayload,
) {
  const jobId = socket.data.jobId;
  const { urlId, rawData } = payload;

  logger.info(
    `[SocketHandler] PROFILE_SCRAPED received for Job: ${jobId}, URL ID: ${urlId}`,
  );

  try {
    // 1. Update ProfileUrl status to 'scraped'
    await prisma.profileUrl.update({
      where: { id: urlId },
      data: {
        status: 'scraped',
        scrapedAt: new Date(),
      },
    });

    // 2. Extract basic details safely
    const currentCompany = rawData.experience?.[0]?.company || null;

    // 3. Save to ScrapedProfile
    const scrapedProfile = await prisma.scrapedProfile.upsert({
      where: { profileUrlId: urlId },
      update: {
        name: rawData.name,
        headline: rawData.headline || null,
        company: currentCompany,
        location: rawData.location || null,
        rawData: rawData as any,
        scrapedAt: new Date(),
      },
      create: {
        profileUrlId: urlId,
        name: rawData.name,
        headline: rawData.headline || null,
        company: currentCompany,
        location: rawData.location || null,
        rawData: rawData as any,
      },
    });

    // 4. Enqueue to QualificationWorker for async LLM evaluation + email finding
    QualificationWorker.getInstance().enqueue(jobId, urlId, scrapedProfile.id);

    // 5. Immediately dispatch the next profile scrape (buffer-limited)
    const { dispatchNext } = await import('../../orchestrator/dispatchNext.js');
    await dispatchNext(jobId);
  } catch (err: any) {
    logger.error(
      { err, jobId, urlId },
      `[SocketHandler] Error processing profile scraped data`,
    );
    throw err;
  }
}
