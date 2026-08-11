import { EventEmitter } from 'node:events';
import type { Job } from 'bullmq';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import {
  AppError,
  ErrorCode,
  NotFoundError,
  ValidationError,
} from '../errors/AppError.js';
import { decryptSecret, isEncrypted } from '../lib/secretBox.js';
import { isQueueReady } from '../queue/connection.js';
import {
  campaignJobId,
  getCampaignQueue,
  removeCampaignJobs,
  type ICampaignJob,
} from '../queue/campaignQueue.js';
import { sendMail, verifyCredentials } from './mailer.service.js';
import {
  buildDraftPrompt,
  composeDraft,
  contactDescription,
  DRAFT_SYSTEM_PROMPT,
} from './draft.service.js';
import { sendChatCompletion } from '../shared/llmClient.js';
import type { IUserConfig } from '../shared/types.js';

export type CampaignStatus =
  'PENDING' | 'SENDING' | 'COMPLETE' | 'STOPPED' | 'FAILED';

export type ContactStatus =
  'PENDING' | 'GENERATING' | 'SENDING' | 'SUCCESS' | 'FAILED' | 'SKIPPED';

export interface ICampaignProgress {
  campaignId: string;
  type: 'CONTACT' | 'STATS' | 'STATUS';
  contactId?: string;
  contactStatus?: ContactStatus;
  campaignStatus?: CampaignStatus;
  sentCount?: number;
  failedCount?: number;
  totalContacts?: number;
  message?: string;
}

/**
 * Progress events for the dashboard's SSE stream.
 *
 * In-process, which is correct only while the worker runs in the same process
 * as the API — it does today (`concurrency: 1`, started from index.ts). If the
 * worker is ever split into its own container this must become a Redis pub/sub
 * channel, or the browser will sit on a silent stream.
 */
export const campaignEvents = new EventEmitter();

function emit(event: ICampaignProgress): void {
  campaignEvents.emit(`campaign:${event.campaignId}`, event);
}

function randomDelay(minMs: number, maxMs: number): number {
  const lo = Math.max(0, Math.min(minMs, maxMs));
  const hi = Math.max(lo, Math.max(minMs, maxMs));
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}

/**
 * Read back the stored SMTP credentials.
 *
 * `isEncrypted` guards the read because the column predates encryption in any
 * database where a value was written by hand; a plaintext value is used as-is
 * rather than throwing.
 */
async function loadCredentials(
  userId: string,
): Promise<{ user: string; password: string }> {
  const config = await prisma.userConfig.findUnique({ where: { userId } });

  if (!config?.smtpUser || !config.smtpPassword) {
    throw new ValidationError(
      'No sending address configured. Add your SMTP details in settings first.',
    );
  }

  return {
    user: config.smtpUser,
    password: isEncrypted(config.smtpPassword)
      ? decryptSecret(config.smtpPassword)
      : config.smtpPassword,
  };
}

async function loadCampaignOwned(campaignId: string, userId: string) {
  const campaign = await prisma.campaign.findFirst({
    where: { id: campaignId, userId },
  });
  if (!campaign) {
    // Scoped by userId in the same query rather than fetched then checked, so
    // a campaign belonging to someone else is indistinguishable from one that
    // does not exist.
    throw new NotFoundError('Campaign not found');
  }
  return campaign;
}

export interface ICreateCampaignInput {
  userId: string;
  name: string;
  emailSubject: string;
  commonPrompt?: string | null;
  fromName?: string | null;
  minDelayMs?: number;
  maxDelayMs?: number;
}

export async function createCampaign(input: ICreateCampaignInput) {
  if (
    input.minDelayMs !== undefined &&
    input.maxDelayMs !== undefined &&
    input.minDelayMs > input.maxDelayMs
  ) {
    throw new ValidationError('Minimum delay cannot exceed maximum delay');
  }

  return prisma.campaign.create({
    data: {
      userId: input.userId,
      name: input.name,
      emailSubject: input.emailSubject,
      commonPrompt: input.commonPrompt ?? null,
      fromName: input.fromName ?? null,
      minDelayMs: input.minDelayMs ?? 5000,
      maxDelayMs: input.maxDelayMs ?? 10000,
    },
  });
}

/**
 * Seed a campaign from profiles the pipeline already found.
 *
 * This replaces the CSV export/import round trip the standalone mailer needed.
 * Profiles without an email are reported rather than silently dropped — a
 * selection of 40 that yields 12 contacts is a surprise worth explaining.
 */
export async function addContactsFromProfiles(
  campaignId: string,
  userId: string,
  profileIds: string[],
): Promise<{
  added: number;
  skippedNoEmail: number;
  skippedDuplicate: number;
}> {
  await loadCampaignOwned(campaignId, userId);

  const profiles = await prisma.profile.findMany({
    where: { id: { in: profileIds } },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      email: true,
      headline: true,
      about: true,
      company: { select: { name: true } },
    },
  });

  const withEmail = profiles.filter((p) => p.email);
  const skippedNoEmail = profiles.length - withEmail.length;

  const result = await prisma.campaignContact.createMany({
    data: withEmail.map((p) => ({
      campaignId,
      profileId: p.id,
      name: `${p.firstName} ${p.lastName}`.trim(),
      email: p.email as string,
      companyName: p.company?.name ?? null,
      description: contactDescription(p.headline, p.about),
    })),
    // The unique index on (campaignId, profileId) is what makes re-adding a
    // selection idempotent instead of queueing a second email per person.
    skipDuplicates: true,
  });

  const totalContacts = await prisma.campaignContact.count({
    where: { campaignId },
  });
  await prisma.campaign.update({
    where: { id: campaignId },
    data: { totalContacts },
  });

  return {
    added: result.count,
    skippedNoEmail,
    skippedDuplicate: withEmail.length - result.count,
  };
}

/**
 * Enqueue every unsent contact.
 *
 * Delays are cumulative and computed here rather than slept through in a loop:
 * BullMQ holds each job until its own delay elapses, so pacing survives a
 * restart. The in-process loop this replaces lost its place entirely and left
 * the campaign stuck at SENDING with no way to resume.
 */
export async function startCampaign(
  campaignId: string,
  userId: string,
): Promise<{ queued: number }> {
  if (!isQueueReady()) {
    throw new AppError(
      'The job queue is unavailable, so campaigns cannot be started right now.',
      503,
      ErrorCode.INTERNAL_ERROR,
    );
  }

  const campaign = await loadCampaignOwned(campaignId, userId);

  if (campaign.status === 'SENDING') {
    throw new ValidationError('This campaign is already sending');
  }

  const credentials = await loadCredentials(userId);

  // Checked once up front. Without this a bad app password marks every
  // contact FAILED in turn, each with an opaque SMTP error.
  const check = await verifyCredentials(credentials);
  if (!check.ok) {
    throw new ValidationError(
      `Could not sign in to the mail server: ${check.error}`,
    );
  }

  const pending = await prisma.campaignContact.findMany({
    where: { campaignId, status: { notIn: ['SUCCESS'] } },
    select: { id: true },
    orderBy: { createdAt: 'asc' },
  });

  if (pending.length === 0) {
    throw new ValidationError('This campaign has no contacts left to send');
  }

  const queue = getCampaignQueue();
  let cumulative = 0;

  await queue.addBulk(
    pending.map((contact, index) => {
      // The first send goes out immediately; every later one is offset by the
      // running total of randomised gaps.
      if (index > 0) {
        cumulative += randomDelay(campaign.minDelayMs, campaign.maxDelayMs);
      }
      return {
        name: 'send-contact',
        data: {
          campaignId,
          contactId: contact.id,
          userId,
        } satisfies ICampaignJob,
        opts: {
          delay: cumulative,
          jobId: campaignJobId(campaignId, contact.id),
        },
      };
    }),
  );

  await prisma.campaign.update({
    where: { id: campaignId },
    data: { status: 'SENDING', startedAt: new Date(), finishedAt: null },
  });

  emit({ campaignId, type: 'STATUS', campaignStatus: 'SENDING' });
  logger.info(
    { campaignId, queued: pending.length },
    '[campaign] Started sending',
  );

  return { queued: pending.length };
}

export async function stopCampaign(
  campaignId: string,
  userId: string,
): Promise<{ removed: number }> {
  await loadCampaignOwned(campaignId, userId);

  await prisma.campaign.update({
    where: { id: campaignId },
    data: { status: 'STOPPED', finishedAt: new Date() },
  });

  const removed = await removeCampaignJobs(campaignId);

  emit({ campaignId, type: 'STATUS', campaignStatus: 'STOPPED' });
  logger.info({ campaignId, removed }, '[campaign] Stopped');

  return { removed };
}

/**
 * Process one contact. This is the BullMQ processor.
 */
export async function processCampaignContact(
  job: Job<ICampaignJob>,
): Promise<void> {
  const { campaignId, contactId, userId } = job.data;

  const campaign = await prisma.campaign.findUnique({
    where: { id: campaignId },
  });

  // Stop removes queued jobs, but a job already in flight cannot be removed.
  // This is the check that makes Stop actually stop.
  if (!campaign || campaign.status !== 'SENDING') {
    logger.info(
      { campaignId, contactId, status: campaign?.status },
      '[campaign] Skipping contact; campaign is not sending',
    );
    return;
  }

  const contact = await prisma.campaignContact.findUnique({
    where: { id: contactId },
  });
  if (!contact || contact.status === 'SUCCESS') {
    return;
  }

  const config = await prisma.userConfig.findUnique({ where: { userId } });
  if (!config) {
    throw new NotFoundError('User configuration not found');
  }

  try {
    let body = contact.customBody;
    let subject = contact.customSubject ?? campaign.emailSubject;

    // A hand-edited draft is sent verbatim — no model call, no re-composition.
    if (!body) {
      await prisma.campaignContact.update({
        where: { id: contactId },
        data: { status: 'GENERATING' },
      });
      emit({
        campaignId,
        type: 'CONTACT',
        contactId,
        contactStatus: 'GENERATING',
      });

      if (!campaign.commonPrompt) {
        throw new ValidationError(
          'Contact has no written draft and the campaign has no prompt to generate one',
        );
      }

      const generated = await sendChatCompletion(
        config as unknown as IUserConfig,
        DRAFT_SYSTEM_PROMPT,
        buildDraftPrompt({
          commonPrompt: campaign.commonPrompt,
          name: contact.name,
          email: contact.email,
          companyName: contact.companyName,
          description: contact.description,
        }),
        800,
        0.7,
      );

      const composed = composeDraft({
        body: generated,
        fallbackSubject: campaign.emailSubject,
        signature: config.emailSignature,
      });
      subject = composed.subject;
      body = composed.body;
    }

    await prisma.campaignContact.update({
      where: { id: contactId },
      data: { status: 'SENDING' },
    });
    emit({ campaignId, type: 'CONTACT', contactId, contactStatus: 'SENDING' });

    await sendMail(await loadCredentials(userId), {
      to: contact.email,
      subject,
      body,
      fromName: campaign.fromName ?? config.smtpFromName,
      attachmentPath: config.resumeFilePath,
      attachmentName: config.resumeFileName,
    });

    await prisma.campaignContact.update({
      where: { id: contactId },
      data: {
        status: 'SUCCESS',
        sentSubject: subject,
        sentBody: body,
        sentAt: new Date(),
        errorMessage: null,
      },
    });

    // Recorded against the profile so the Results screen reflects that this
    // person has been contacted, and so a future campaign can exclude them.
    if (contact.profileId) {
      await prisma.outreachLog.create({
        data: {
          userId,
          profileId: contact.profileId,
          action: 'EMAIL_SENT',
          status: 'SUCCESS',
          message: subject,
          details: { campaignId, contactId },
        },
      });
    }

    emit({ campaignId, type: 'CONTACT', contactId, contactStatus: 'SUCCESS' });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown send failure';

    await prisma.campaignContact.update({
      where: { id: contactId },
      data: { status: 'FAILED', errorMessage: message },
    });
    emit({
      campaignId,
      type: 'CONTACT',
      contactId,
      contactStatus: 'FAILED',
      message,
    });

    // Rethrown so BullMQ records the failure and applies its retry policy;
    // the contact row is already marked so the UI does not wait on it.
    throw err;
  } finally {
    await refreshCounters(campaignId);
  }
}

/**
 * Recount from the contacts table rather than incrementing.
 *
 * The mailer carried running totals in local variables across the loop, so a
 * retry or a restart double-counted. Counting the rows is cheap at these sizes
 * and cannot drift.
 */
async function refreshCounters(campaignId: string): Promise<void> {
  const [sentCount, failedCount, remaining, totalContacts] = await Promise.all([
    prisma.campaignContact.count({ where: { campaignId, status: 'SUCCESS' } }),
    prisma.campaignContact.count({ where: { campaignId, status: 'FAILED' } }),
    prisma.campaignContact.count({
      where: {
        campaignId,
        status: { in: ['PENDING', 'GENERATING', 'SENDING'] },
      },
    }),
    prisma.campaignContact.count({ where: { campaignId } }),
  ]);

  const finished = remaining === 0;

  await prisma.campaign.update({
    where: { id: campaignId },
    data: {
      sentCount,
      failedCount,
      totalContacts,
      ...(finished ? { status: 'COMPLETE', finishedAt: new Date() } : {}),
    },
  });

  emit({
    campaignId,
    type: 'STATS',
    sentCount,
    failedCount,
    totalContacts,
  });

  if (finished) {
    emit({ campaignId, type: 'STATUS', campaignStatus: 'COMPLETE' });
  }
}

/**
 * Re-enqueue campaigns left mid-flight by a restart.
 *
 * Called at boot. A campaign is only ever SENDING because someone started it
 * and it did not finish, so its remaining contacts are still owed a send.
 * BullMQ's jobs survive a restart, so this exists for the narrower case where
 * Redis was flushed or the jobs were lost while Postgres kept the status.
 */
export async function resumeInterruptedCampaigns(): Promise<number> {
  const stuck = await prisma.campaign.findMany({
    where: { status: 'SENDING' },
    select: { id: true, userId: true },
  });

  let resumed = 0;
  for (const campaign of stuck) {
    const queued = await getCampaignQueue().getJobs(['waiting', 'delayed']);
    const hasJobs = queued.some((job) => job.data.campaignId === campaign.id);
    if (hasJobs) continue;

    try {
      await prisma.campaign.update({
        where: { id: campaign.id },
        data: { status: 'PENDING' },
      });
      await startCampaign(campaign.id, campaign.userId);
      resumed += 1;
    } catch (err) {
      logger.error(
        { err, campaignId: campaign.id },
        '[campaign] Could not resume interrupted campaign',
      );
      await prisma.campaign.update({
        where: { id: campaign.id },
        data: { status: 'STOPPED' },
      });
    }
  }

  if (resumed > 0) {
    logger.info({ resumed }, '[campaign] Resumed interrupted campaigns');
  }
  return resumed;
}
