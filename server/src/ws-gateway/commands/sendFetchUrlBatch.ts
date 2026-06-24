import { ConnectionRegistry } from '../connectionRegistry.js';
import { ServerCommands, FetchUrlBatchPayload } from '../events.js';
import { getIo } from '../index.js';
import { prisma } from '../../lib/prisma.js';
import { logger } from '../../lib/logger.js';

export async function sendFetchUrlBatch(
  jobId: string,
  batchNumber: number,
  targetCount: number,
): Promise<void> {
  const socketId = ConnectionRegistry.getInstance().getSocketId(jobId);
  if (!socketId) {
    logger.warn(
      `[Command] Cannot send FETCH_URL_BATCH: Job ${jobId} has no active socket connection`,
    );
    return;
  }

  // Fetch the job details
  const job = await prisma.searchJob.findUnique({
    where: { id: jobId },
  });

  if (!job) {
    logger.error(`[Command] Job ${jobId} not found in database`);
    return;
  }

  const searchParams = (job.searchParams as any) || {};
  const companyUrl = searchParams.companyUrl;

  logger.info(
    `[Command] Sending FETCH_URL_BATCH for Job ${jobId} (Batch: ${batchNumber}, Target: ${targetCount}) with companyUrl: ${companyUrl} to socket ${socketId}`,
  );

  const io = getIo();
  const payload: FetchUrlBatchPayload = {
    batchNumber,
    targetCount,
    searchUrl: companyUrl,
  };
  io.to(socketId).emit(ServerCommands.FETCH_URL_BATCH, payload);
}
