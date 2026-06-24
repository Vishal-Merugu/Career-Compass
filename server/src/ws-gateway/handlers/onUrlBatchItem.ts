import type { Socket } from 'socket.io';
import { UrlBatchItemPayload } from '../events.js';
import { prisma } from '../../lib/prisma.js';
import { logger } from '../../lib/logger.js';

export async function onUrlBatchItem(
  socket: Socket,
  payload: UrlBatchItemPayload,
) {
  const jobId = socket.data.jobId;
  const { url, batchNumber } = payload;

  logger.debug(
    `[SocketHandler] URL_BATCH_ITEM received for Job: ${jobId}, Batch: ${batchNumber}, URL: ${url}`,
  );

  try {
    // Idempotent upsert to avoid duplicate profile URLs per job
    await prisma.profileUrl.upsert({
      where: {
        jobId_url: {
          jobId,
          url,
        },
      },
      create: {
        jobId,
        batchNumber,
        url,
        status: 'queued',
        attempts: 0,
      },
      update: {
        // No-op if it already exists, preserving the existing status/attempts
      },
    });
  } catch (err: any) {
    logger.error(
      { err, jobId, url },
      `[SocketHandler] Error upserting profile URL to database`,
    );
    throw err;
  }
}
