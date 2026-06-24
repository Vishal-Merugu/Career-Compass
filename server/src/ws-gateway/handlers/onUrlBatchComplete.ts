import type { Socket } from 'socket.io';
import { UrlBatchCompletePayload } from '../events.js';
import { prisma } from '../../lib/prisma.js';
import { logger } from '../../lib/logger.js';
import { dispatchNext } from '../../orchestrator/dispatchNext.js';

export async function onUrlBatchComplete(
  socket: Socket,
  payload: UrlBatchCompletePayload,
) {
  const jobId = socket.data.jobId;
  const { batchNumber, count } = payload;

  logger.info(
    `[SocketHandler] URL_BATCH_COMPLETE received for Job: ${jobId}, Batch: ${batchNumber}, total collected: ${count}`,
  );

  // Update job status from collecting_urls to scraping
  await prisma.searchJob.update({
    where: { id: jobId },
    data: {
      status: 'scraping',
    },
  });

  // Trigger dispatching of the first profile URL in this job
  await dispatchNext(jobId);
}
