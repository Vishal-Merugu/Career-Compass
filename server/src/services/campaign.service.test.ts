import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Job } from 'bullmq';
import type { ICampaignJob } from '../queue/campaignQueue.js';
import type { IOutgoingMail, ISmtpCredentials } from './mailer.service.js';
import type {
  CampaignStatus,
  ContactStatus,
  ICampaignProgress,
} from './campaign.service.js';

/**
 * The BullMQ processor and the boot-time resume path, which were previously
 * covered only by hand against a running server.
 *
 * Everything below the service is faked: Prisma, SMTP and the model. The point
 * is the decisions the processor makes — when it refuses to send, what it
 * writes back, and what it reports — not that Postgres stores a row.
 */

// ─── Test-only row shapes ────────────────────────────────────────────
//
// Deliberately narrower than the Prisma models: only the columns this service
// reads or writes. A wider shape would let a test pass while the real query
// selects something else.

interface TestCampaign {
  id: string;
  userId: string;
  name: string;
  status: CampaignStatus;
  emailSubject: string;
  commonPrompt: string | null;
  fromName: string | null;
  minDelayMs: number;
  maxDelayMs: number;
  sentCount: number;
  failedCount: number;
  totalContacts: number;
  startedAt: Date | null;
  finishedAt: Date | null;
}

interface TestContact {
  id: string;
  campaignId: string;
  profileId: string | null;
  name: string;
  email: string;
  companyName: string | null;
  description: string | null;
  customSubject: string | null;
  customBody: string | null;
  status: ContactStatus;
  errorMessage: string | null;
  sentSubject: string | null;
  sentBody: string | null;
  sentAt: Date | null;
  createdAt: Date;
}

interface TestConfig {
  userId: string;
  smtpUser: string | null;
  smtpPassword: string | null;
  smtpFromName: string | null;
  emailSignature: string | null;
  resumeFilePath: string | null;
  resumeFileName: string | null;
  llmProvider: string;
  llmModel: string;
}

interface TestOutreachLog {
  userId: string;
  profileId: string;
  action: string;
  status: string;
  message: string;
  details: unknown;
}

interface Store {
  campaigns: TestCampaign[];
  contacts: TestContact[];
  configs: TestConfig[];
  outreachLogs: TestOutreachLog[];
}

const store = vi.hoisted<Store>(() => ({
  campaigns: [],
  contacts: [],
  configs: [],
  outreachLogs: [],
}));

// ─── Fakes ───────────────────────────────────────────────────────────

interface IdWhere {
  id?: string;
  userId?: string;
  campaignId?: string;
  status?: ContactStatus | { in?: ContactStatus[]; notIn?: ContactStatus[] };
}

vi.mock('../lib/prisma.js', () => {
  const match = (row: TestContact | TestCampaign, where: IdWhere): boolean => {
    if (where.id !== undefined && row.id !== where.id) return false;
    if (
      where.userId !== undefined &&
      (!('userId' in row) || row.userId !== where.userId)
    ) {
      return false;
    }
    if (
      where.campaignId !== undefined &&
      'campaignId' in row &&
      row.campaignId !== where.campaignId
    ) {
      return false;
    }
    if (where.status !== undefined) {
      const s = (row as TestContact).status;
      if (typeof where.status === 'string') return s === where.status;
      if (where.status.in && !where.status.in.includes(s)) return false;
      if (where.status.notIn && where.status.notIn.includes(s)) return false;
    }
    return true;
  };

  return {
    prisma: {
      campaign: {
        findUnique: ({ where }: { where: IdWhere }) =>
          Promise.resolve(store.campaigns.find((c) => match(c, where)) ?? null),
        findFirst: ({ where }: { where: IdWhere }) =>
          Promise.resolve(store.campaigns.find((c) => match(c, where)) ?? null),
        findMany: ({ where }: { where: { status: CampaignStatus } }) =>
          Promise.resolve(
            store.campaigns.filter((c) => c.status === where.status),
          ),
        update: ({
          where,
          data,
        }: {
          where: IdWhere;
          data: Partial<TestCampaign>;
        }) => {
          const row = store.campaigns.find((c) => match(c, where));
          if (row) Object.assign(row, data);
          return Promise.resolve(row);
        },
      },
      campaignContact: {
        findUnique: ({ where }: { where: IdWhere }) =>
          Promise.resolve(store.contacts.find((c) => match(c, where)) ?? null),
        findMany: ({ where }: { where: IdWhere }) =>
          Promise.resolve(store.contacts.filter((c) => match(c, where))),
        count: ({ where }: { where: IdWhere }) =>
          Promise.resolve(store.contacts.filter((c) => match(c, where)).length),
        update: ({
          where,
          data,
        }: {
          where: IdWhere;
          data: Partial<TestContact>;
        }) => {
          const row = store.contacts.find((c) => match(c, where));
          if (row) Object.assign(row, data);
          return Promise.resolve(row);
        },
      },
      userConfig: {
        findUnique: ({ where }: { where: { userId: string } }) =>
          Promise.resolve(
            store.configs.find((c) => c.userId === where.userId) ?? null,
          ),
      },
      outreachLog: {
        create: ({ data }: { data: TestOutreachLog }) => {
          store.outreachLogs.push(data);
          return Promise.resolve(data);
        },
      },
    },
  };
});

const sendMail = vi.hoisted(() =>
  vi.fn<(creds: ISmtpCredentials, mail: IOutgoingMail) => Promise<void>>(),
);
const verifyCredentials = vi.hoisted(() =>
  vi.fn<() => Promise<{ ok: boolean; error?: string }>>(),
);
vi.mock('./mailer.service.js', () => ({ sendMail, verifyCredentials }));

const sendChatCompletion = vi.hoisted(() => vi.fn<() => Promise<string>>());
vi.mock('../shared/llmClient.js', () => ({ sendChatCompletion }));

/** What `startCampaign` hands to `Queue.addBulk`. */
interface QueuedJob {
  name: string;
  data: ICampaignJob;
  opts: { delay: number; jobId: string };
}

const addBulk = vi.hoisted(() =>
  vi.fn<(jobs: QueuedJob[]) => Promise<unknown[]>>(),
);
const getJobs = vi.hoisted(() =>
  vi.fn<() => Promise<{ data: ICampaignJob }[]>>(() => Promise.resolve([])),
);
vi.mock('../queue/campaignQueue.js', () => ({
  getCampaignQueue: () => ({ addBulk, getJobs }),
  removeCampaignJobs: () => Promise.resolve(0),
}));

vi.mock('../queue/connection.js', () => ({ isQueueReady: () => true }));

// The service logs an error for every campaign it cannot resume, which is
// correct in production and pure noise in a suite that asserts on it.
vi.mock('../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const {
  campaignEvents,
  processCampaignContact,
  resumeInterruptedCampaigns,
  startCampaign,
} = await import('./campaign.service.js');

// ─── Fixtures ────────────────────────────────────────────────────────

const USER = 'user-1';

function campaign(over: Partial<TestCampaign> = {}): TestCampaign {
  return {
    id: 'camp-1',
    userId: USER,
    name: 'Munich working-student roles',
    status: 'SENDING',
    emailSubject: 'Working student application',
    commonPrompt: 'Write a short intro.',
    fromName: null,
    minDelayMs: 5000,
    maxDelayMs: 10_000,
    sentCount: 0,
    failedCount: 0,
    totalContacts: 1,
    startedAt: new Date(),
    finishedAt: null,
    ...over,
  };
}

function contact(over: Partial<TestContact> = {}): TestContact {
  return {
    id: 'contact-1',
    campaignId: 'camp-1',
    profileId: 'profile-1',
    name: 'Anna Weber',
    email: 'anna@example.com',
    companyName: 'Avelios',
    description: 'Engineering lead',
    customSubject: null,
    customBody: null,
    status: 'PENDING',
    errorMessage: null,
    sentSubject: null,
    sentBody: null,
    sentAt: null,
    createdAt: new Date(),
    ...over,
  };
}

function config(over: Partial<TestConfig> = {}): TestConfig {
  return {
    userId: USER,
    smtpUser: 'me@example.com',
    // Plaintext on purpose: `isEncrypted` is the real implementation and a
    // value that predates encryption must pass through untouched.
    smtpPassword: 'app-password',
    smtpFromName: 'Me',
    emailSignature: 'Best,\nMe',
    resumeFilePath: '/tmp/cv.pdf',
    resumeFileName: 'cv.pdf',
    llmProvider: 'ollama',
    llmModel: 'qwen2.5:1.5b',
    ...over,
  };
}

function job(over: Partial<ICampaignJob> = {}): Job<ICampaignJob> {
  return {
    data: {
      campaignId: 'camp-1',
      contactId: 'contact-1',
      userId: USER,
      ...over,
    },
  } as Job<ICampaignJob>;
}

/** Collect everything emitted for a campaign while `fn` runs. */
async function captureEvents(
  campaignId: string,
  fn: () => Promise<void>,
): Promise<ICampaignProgress[]> {
  const seen: ICampaignProgress[] = [];
  const listener = (e: ICampaignProgress) => seen.push(e);
  campaignEvents.on(`campaign:${campaignId}`, listener);
  try {
    await fn();
  } finally {
    campaignEvents.off(`campaign:${campaignId}`, listener);
  }
  return seen;
}

beforeEach(() => {
  store.campaigns = [campaign()];
  store.contacts = [contact()];
  store.configs = [config()];
  store.outreachLogs = [];
  vi.clearAllMocks();
  sendMail.mockResolvedValue(undefined);
  verifyCredentials.mockResolvedValue({ ok: true });
  sendChatCompletion.mockResolvedValue('Subject: Hello\n\nHi Anna,');
  getJobs.mockResolvedValue([]);
  addBulk.mockResolvedValue([]);
});

// ─── processCampaignContact ──────────────────────────────────────────

describe('processCampaignContact', () => {
  it('sends nothing once the campaign has left SENDING', async () => {
    // The check that makes Stop actually stop: removing queued jobs cannot
    // recall one already in flight, so the processor has to re-read status.
    store.campaigns[0].status = 'STOPPED';

    await processCampaignContact(job());

    expect(sendMail).not.toHaveBeenCalled();
    expect(store.contacts[0].status).toBe('PENDING');
  });

  it('sends nothing when the campaign row is gone', async () => {
    store.campaigns = [];
    await processCampaignContact(job());
    expect(sendMail).not.toHaveBeenCalled();
  });

  it('does not send a contact twice', async () => {
    store.contacts[0].status = 'SUCCESS';
    await processCampaignContact(job());
    expect(sendMail).not.toHaveBeenCalled();
  });

  it('sends a hand-edited draft verbatim, with no model call', async () => {
    store.contacts[0].customBody = 'Hi Anna, we met at the meetup.';
    store.contacts[0].customSubject = 'Following up';

    await processCampaignContact(job());

    expect(sendChatCompletion).not.toHaveBeenCalled();
    expect(sendMail).toHaveBeenCalledTimes(1);
    const mail = sendMail.mock.calls[0][1];
    expect(mail.subject).toBe('Following up');
    // No signature appended — composeDraft is skipped entirely.
    expect(mail.body).toBe('Hi Anna, we met at the meetup.');
  });

  it('falls back to the campaign subject when a draft has none', async () => {
    store.contacts[0].customBody = 'Hi Anna.';
    await processCampaignContact(job());
    const mail = sendMail.mock.calls[0][1];
    expect(mail.subject).toBe('Working student application');
  });

  it('generates a draft, lifts its subject and appends the signature', async () => {
    await processCampaignContact(job());

    expect(sendChatCompletion).toHaveBeenCalledTimes(1);
    const mail = sendMail.mock.calls[0][1];
    expect(mail.subject).toBe('Hello');
    expect(mail.body).toBe('Hi Anna,\n\nBest,\nMe');
    expect(mail.fromName).toBe('Me');
    expect(mail.attachmentPath).toBe('/tmp/cv.pdf');
  });

  it("prefers the campaign's fromName over the account default", async () => {
    store.campaigns[0].fromName = 'Vishal via CareerCompass';
    await processCampaignContact(job());
    const mail = sendMail.mock.calls[0][1];
    expect(mail.fromName).toBe('Vishal via CareerCompass');
  });

  it('records the send against the profile', async () => {
    await processCampaignContact(job());

    expect(store.contacts[0].status).toBe('SUCCESS');
    expect(store.contacts[0].sentSubject).toBe('Hello');
    expect(store.contacts[0].sentAt).toBeInstanceOf(Date);
    expect(store.outreachLogs).toEqual([
      {
        userId: USER,
        profileId: 'profile-1',
        action: 'EMAIL_SENT',
        status: 'SUCCESS',
        message: 'Hello',
        details: { campaignId: 'camp-1', contactId: 'contact-1' },
      },
    ]);
  });

  it('skips the outreach log for a contact with no profile', async () => {
    // Contacts can exist without a Profile; the log is keyed on one.
    store.contacts[0].profileId = null;
    await processCampaignContact(job());
    expect(store.contacts[0].status).toBe('SUCCESS');
    expect(store.outreachLogs).toEqual([]);
  });

  it('fails the contact and rethrows when the send throws', async () => {
    sendMail.mockRejectedValue(new Error('535 Authentication failed'));

    await expect(processCampaignContact(job())).rejects.toThrow(
      '535 Authentication failed',
    );

    // Rethrown for BullMQ's retry policy, but the row is already marked so the
    // dashboard does not sit waiting on it.
    expect(store.contacts[0].status).toBe('FAILED');
    expect(store.contacts[0].errorMessage).toBe('535 Authentication failed');
  });

  it('fails a contact with neither a draft nor a prompt', async () => {
    store.campaigns[0].commonPrompt = null;

    await expect(processCampaignContact(job())).rejects.toThrow(
      /no written draft/,
    );

    expect(sendMail).not.toHaveBeenCalled();
    expect(store.contacts[0].status).toBe('FAILED');
  });

  it('fails the contact when no SMTP credentials are stored', async () => {
    store.configs[0].smtpPassword = null;

    await expect(processCampaignContact(job())).rejects.toThrow(
      /No sending address configured/,
    );
    expect(store.contacts[0].status).toBe('FAILED');
  });

  it('throws when the user has no config row at all', async () => {
    store.configs = [];
    await expect(processCampaignContact(job())).rejects.toThrow(
      'User configuration not found',
    );
  });

  it('emits GENERATING, SENDING and SUCCESS in order', async () => {
    const events = await captureEvents('camp-1', () =>
      processCampaignContact(job()),
    );

    expect(
      events.filter((e) => e.type === 'CONTACT').map((e) => e.contactStatus),
    ).toEqual(['GENERATING', 'SENDING', 'SUCCESS']);
  });

  it('emits the failure message on the CONTACT frame', async () => {
    sendMail.mockRejectedValue(new Error('mailbox unavailable'));

    const events = await captureEvents('camp-1', () =>
      processCampaignContact(job()).catch(() => undefined),
    );

    const failed = events.find((e) => e.contactStatus === 'FAILED');
    expect(failed?.message).toBe('mailbox unavailable');
  });
});

// ─── refreshCounters, through the processor's finally block ──────────

describe('counter refresh', () => {
  it('recounts from the rows rather than incrementing', async () => {
    // Pre-loaded with wrong totals: a retry or a restart double-counted in the
    // mailer this was ported from, which is why nothing is incremented.
    store.campaigns[0] = campaign({ sentCount: 7, failedCount: 3 });
    store.contacts = [
      contact(),
      contact({ id: 'contact-2', status: 'FAILED' }),
    ];
    store.campaigns[0].totalContacts = 2;

    await processCampaignContact(job());

    expect(store.campaigns[0].sentCount).toBe(1);
    expect(store.campaigns[0].failedCount).toBe(1);
    expect(store.campaigns[0].totalContacts).toBe(2);
  });

  it('completes the campaign once nothing is left in flight', async () => {
    const events = await captureEvents('camp-1', () =>
      processCampaignContact(job()),
    );

    expect(store.campaigns[0].status).toBe('COMPLETE');
    expect(store.campaigns[0].finishedAt).toBeInstanceOf(Date);
    expect(
      events.some(
        (e) => e.type === 'STATUS' && e.campaignStatus === 'COMPLETE',
      ),
    ).toBe(true);
  });

  it('leaves the campaign SENDING while contacts remain', async () => {
    store.contacts.push(contact({ id: 'contact-2', status: 'PENDING' }));

    await processCampaignContact(job());

    expect(store.campaigns[0].status).toBe('SENDING');
    expect(store.campaigns[0].finishedAt).toBeNull();
  });

  it('still refreshes counters after a failed send', async () => {
    // The refresh lives in a `finally`; a failure that skipped it would leave
    // the dashboard's progress bar frozen.
    sendMail.mockRejectedValue(new Error('nope'));

    await processCampaignContact(job()).catch(() => undefined);

    expect(store.campaigns[0].failedCount).toBe(1);
    expect(store.campaigns[0].status).toBe('COMPLETE');
  });
});

// ─── resumeInterruptedCampaigns ──────────────────────────────────────

describe('resumeInterruptedCampaigns', () => {
  it('leaves a campaign alone when its jobs survived the restart', async () => {
    // BullMQ jobs live in Redis and outlast the process, so re-enqueueing here
    // would send every remaining contact twice.
    getJobs.mockResolvedValue([
      {
        data: { campaignId: 'camp-1', contactId: 'contact-1', userId: USER },
      },
    ]);

    expect(await resumeInterruptedCampaigns()).toBe(0);
    expect(addBulk).not.toHaveBeenCalled();
    expect(store.campaigns[0].status).toBe('SENDING');
  });

  it('ignores jobs belonging to a different campaign', async () => {
    getJobs.mockResolvedValue([
      {
        data: { campaignId: 'camp-other', contactId: 'x', userId: USER },
      },
    ]);

    expect(await resumeInterruptedCampaigns()).toBe(1);
    expect(addBulk).toHaveBeenCalledTimes(1);
  });

  it('re-enqueues a campaign whose jobs were lost', async () => {
    expect(await resumeInterruptedCampaigns()).toBe(1);

    expect(addBulk).toHaveBeenCalledTimes(1);
    expect(store.campaigns[0].status).toBe('SENDING');
    // Only the unsent contact is re-queued.
    const jobs = addBulk.mock.calls[0][0];
    expect(jobs).toHaveLength(1);
    expect(jobs[0].opts.delay).toBe(0);
  });

  it('stops a campaign it cannot resume instead of leaving it SENDING', async () => {
    // A SENDING campaign with no jobs and no way to make any is stuck forever;
    // STOPPED is at least a state the user can act on.
    verifyCredentials.mockResolvedValue({ ok: false, error: 'bad password' });

    expect(await resumeInterruptedCampaigns()).toBe(0);
    expect(store.campaigns[0].status).toBe('STOPPED');
  });

  it('ignores campaigns that are not SENDING', async () => {
    store.campaigns[0].status = 'PENDING';
    expect(await resumeInterruptedCampaigns()).toBe(0);
    expect(addBulk).not.toHaveBeenCalled();
  });
});

// ─── startCampaign pacing ────────────────────────────────────────────

describe('startCampaign', () => {
  beforeEach(() => {
    store.campaigns[0].status = 'PENDING';
  });

  it('gives each job a cumulative delay so pacing survives a restart', async () => {
    store.contacts = [
      contact({ id: 'c1' }),
      contact({ id: 'c2' }),
      contact({ id: 'c3' }),
    ];

    await startCampaign('camp-1', USER);

    const jobs = addBulk.mock.calls[0][0];
    const delays = jobs.map((j) => j.opts.delay);
    expect(delays[0]).toBe(0);
    // Strictly increasing, and every gap inside the configured range.
    expect(delays[1] - delays[0]).toBeGreaterThanOrEqual(5000);
    expect(delays[1] - delays[0]).toBeLessThanOrEqual(10_000);
    expect(delays[2] - delays[1]).toBeGreaterThanOrEqual(5000);
    expect(delays[2] - delays[1]).toBeLessThanOrEqual(10_000);
  });

  it('gives each job a stable id, so a re-start cannot duplicate a send', async () => {
    await startCampaign('camp-1', USER);
    const jobs = addBulk.mock.calls[0][0];
    expect(jobs[0].opts.jobId).toBe('camp-1:contact-1');
  });

  it('skips contacts already sent', async () => {
    store.contacts = [
      contact({ id: 'c1', status: 'SUCCESS' }),
      contact({ id: 'c2', status: 'FAILED' }),
    ];

    const { queued } = await startCampaign('camp-1', USER);

    expect(queued).toBe(1);
  });

  it('refuses to start a campaign that is already sending', async () => {
    store.campaigns[0].status = 'SENDING';
    await expect(startCampaign('camp-1', USER)).rejects.toThrow(
      'already sending',
    );
  });

  it('checks the mail credentials once, before queueing anything', async () => {
    // Otherwise a bad app password marks every contact FAILED in turn, each
    // with an opaque SMTP error.
    verifyCredentials.mockResolvedValue({ ok: false, error: 'bad password' });

    await expect(startCampaign('camp-1', USER)).rejects.toThrow('bad password');
    expect(addBulk).not.toHaveBeenCalled();
  });

  it('does not leak another user’s campaign', async () => {
    await expect(startCampaign('camp-1', 'someone-else')).rejects.toThrow(
      'Campaign not found',
    );
  });
});
