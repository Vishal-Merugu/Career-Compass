import { Queue, Worker, type Job } from 'bullmq';
import { getQueueConnection } from './connection.js';
import { logger } from '../lib/logger.js';

export const CAMPAIGN_QUEUE = 'campaign-send';

export interface ICampaignJob {
  campaignId: string;
  contactId: string;
  userId: string;
}

let queue: Queue<ICampaignJob> | null = null;
let worker: Worker<ICampaignJob> | null = null;

export function getCampaignQueue(): Queue<ICampaignJob> {
  if (queue) return queue;

  queue = new Queue<ICampaignJob>(CAMPAIGN_QUEUE, {
    connection: getQueueConnection(),
    defaultJobOptions: {
      // Two retries with backoff covers a transient SMTP hiccup. Beyond that
      // the failure is almost always the credentials or the address, and
      // retrying just sends the same rejection again more slowly.
      attempts: 3,
      backoff: { type: 'exponential', delay: 30_000 },
      // Keep finished jobs briefly so a campaign that just ran can be
      // inspected, but do not let the list grow without bound.
      removeOnComplete: { age: 3600, count: 500 },
      removeOnFail: { age: 86_400 },
    },
  });

  return queue;
}

/**
 * Start the worker. Called once at boot.
 *
 * `concurrency: 1` is deliberate and load-bearing. Campaign pacing exists to
 * keep Gmail from flagging the account, and a concurrent worker would send N
 * emails simultaneously regardless of the configured delay, defeating it.
 */
export function startCampaignWorker(
  processor: (job: Job<ICampaignJob>) => Promise<void>,
): Worker<ICampaignJob> {
  if (worker) return worker;

  worker = new Worker<ICampaignJob>(CAMPAIGN_QUEUE, processor, {
    connection: getQueueConnection(),
    concurrency: 1,
  });

  worker.on('failed', (job, err) => {
    logger.error(
      { err, campaignId: job?.data.campaignId, contactId: job?.data.contactId },
      '[campaignQueue] Job failed',
    );
  });

  worker.on('error', (err) => {
    logger.error({ err }, '[campaignQueue] Worker error');
  });

  logger.info('[campaignQueue] Worker started');
  return worker;
}

/**
 * Remove every not-yet-run job for a campaign.
 *
 * Stopping has to clear the queue, not just flip the campaign's status. The
 * jobs carry their own delay and would otherwise keep waking up long after the
 * user pressed Stop — each one then finding a STOPPED campaign and no-oping,
 * which works but leaves the queue full of ghosts for the length of the run.
 */
export async function removeCampaignJobs(campaignId: string): Promise<number> {
  const q = getCampaignQueue();
  const jobs = await q.getJobs(['waiting', 'delayed', 'prioritized']);
  const mine = jobs.filter((job) => job.data.campaignId === campaignId);

  await Promise.all(
    mine.map((job) =>
      job.remove().catch((err: unknown) => {
        // A job that started running between getJobs and remove cannot be
        // removed. The processor's own status check catches it.
        logger.debug({ err, jobId: job.id }, '[campaignQueue] Job not removed');
      }),
    ),
  );

  return mine.length;
}

export async function closeCampaignQueue(): Promise<void> {
  await worker?.close();
  await queue?.close();
  worker = null;
  queue = null;
}
