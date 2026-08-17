import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LlmError } from '../errors/AppError.js';

/**
 * What the worker does when the model does not answer.
 *
 * The behaviour being pinned down here is the one whose absence cost a real
 * run: on 2026-08-09 the model was unreachable for every one of 368 profiles,
 * each failure was written down as `isQualified: false`, and the run kept
 * collecting fresh batches of people to fail on. Nothing paused, and the
 * dashboard showed a healthy-looking `scraping`.
 *
 * Everything under the worker is faked. The point is the decisions it makes —
 * what it writes, when it stops — not that Postgres stores a row.
 */

interface TestDecision {
  profileId: string;
  isQualified: boolean;
  status: string;
  qualificationReason: string | null;
}

const decisions: TestDecision[] = [];

const evaluateProfile = vi.hoisted(() => vi.fn());
const pauseJobWithFailure = vi.hoisted(() => vi.fn());
const recordJobEvent = vi.hoisted(() => vi.fn());
const checkJobStopCondition = vi.hoisted(() => vi.fn());
const publishQualifiedProfile = vi.hoisted(() => vi.fn());
const profileDecisionCreate = vi.hoisted(() => vi.fn());

vi.mock('../shared/llmClient.js', () => ({ evaluateProfile }));

// One model, called directly. The waterfall's own behaviour is covered in
// `llmRouter.service.test.ts`; what matters here is that whatever the model
// finally throws still reaches the worker as an `LlmError` and is handled as
// infrastructure rather than as a verdict.
vi.mock('../services/llmRouter.service.js', () => ({
  withLlmFallback: <T>(
    _userId: string,
    call: (target: unknown) => Promise<T>,
  ) => call({ credentialId: null, label: 'test model', provider: 'ollama' }),
}));
vi.mock('../services/jobControl.service.js', () => ({ pauseJobWithFailure }));
vi.mock('../services/jobEvents.service.js', () => ({ recordJobEvent }));
vi.mock('../orchestrator/stopCondition.js', () => ({ checkJobStopCondition }));
vi.mock('../services/profilePublisher.service.js', () => ({
  publishQualifiedProfile,
}));
vi.mock('../telegram/bot.js', () => ({
  telegramBotService: {
    sendMessage: vi.fn().mockResolvedValue(null),
    editMessageText: vi.fn().mockResolvedValue(null),
  },
}));
vi.mock('../services/storage.adapter.js', () => ({
  PrismaStorageAdapter: class {
    getConfig() {
      return Promise.resolve({ llmProvider: 'server', llmModel: 'test-model' });
    }
    addActivityLog() {
      return Promise.resolve();
    }
    updateDailyStats() {
      return Promise.resolve();
    }
  },
}));

vi.mock('../lib/prisma.js', () => ({
  prisma: {
    scrapedProfile: {
      findUnique: vi.fn().mockImplementation(({ where }) =>
        Promise.resolve({
          id: where.id,
          name: 'Jane Doe',
          headline: 'Engineering Manager',
          location: 'Berlin',
          company: 'Acme',
          rawData: { publicIdentifier: 'janedoe', experience: [] },
          profileUrl: {
            jobId: 'job-1',
            url: 'https://www.linkedin.com/in/janedoe/',
          },
        }),
      ),
      findMany: vi.fn().mockResolvedValue([]),
    },
    searchJob: {
      findUnique: vi.fn().mockImplementation(({ where }) =>
        Promise.resolve({
          id: where.id,
          userId: 'user-1',
          qualifiedCount: 0,
          limitRequested: 50,
          searchParams: { prompt: 'find managers' },
          user: { telegramId: null },
        }),
      ),
      update: vi.fn().mockResolvedValue({}),
    },
    profileDecision: { create: profileDecisionCreate },
  },
}));

const { QualificationWorker } = await import('./qualificationWorker.js');

/** Push one profile through and wait for the worker's queue to drain. */
async function qualifyOne(jobId: string, profileId: string): Promise<void> {
  QualificationWorker.getInstance().enqueue(jobId, 'url-1', profileId);
  await vi.waitFor(() => {
    expect(profileDecisionCreate).toHaveBeenCalled();
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  decisions.length = 0;
  profileDecisionCreate.mockImplementation(
    ({ data }: { data: TestDecision }) => {
      decisions.push(data);
      return Promise.resolve(data);
    },
  );
});

describe('when the model cannot be reached', () => {
  it('records the profile as errored, not rejected', async () => {
    evaluateProfile.mockRejectedValue(
      new LlmError('LLM_UNREACHABLE', 'The AI model could not be reached.'),
    );

    await qualifyOne('job-unreachable-1', 'profile-1');

    // The distinction the whole change turns on. `rejected` would mean the
    // model looked at this person and said no.
    expect(decisions[0].status).toBe('error');
    expect(decisions[0].isQualified).toBe(false);
  });

  it('never publishes the profile to Results', async () => {
    evaluateProfile.mockRejectedValue(
      new LlmError('LLM_UNREACHABLE', 'The AI model could not be reached.'),
    );

    await qualifyOne('job-unreachable-2', 'profile-1');

    expect(publishQualifiedProfile).not.toHaveBeenCalled();
  });

  it('pauses the run on the very first failure', async () => {
    // An unreachable host fails identically for every remaining profile, so
    // there is nothing to learn from trying another 367.
    evaluateProfile.mockRejectedValue(
      new LlmError('LLM_UNREACHABLE', 'The AI model could not be reached.', {
        detail: 'ECONNREFUSED',
      }),
    );

    await qualifyOne('job-unreachable-3', 'profile-1');

    expect(pauseJobWithFailure).toHaveBeenCalledTimes(1);
    expect(pauseJobWithFailure).toHaveBeenCalledWith(
      'job-unreachable-3',
      expect.objectContaining({ code: 'LLM_UNREACHABLE', stage: 'qualify' }),
    );
  });

  it.each([
    ['LLM_AUTH'],
    ['LLM_QUOTA'],
    ['LLM_RATE_LIMIT'],
    ['LLM_MODEL_NOT_FOUND'],
  ])('pauses immediately on %s too', async (code) => {
    evaluateProfile.mockRejectedValue(new LlmError(code as 'LLM_AUTH', 'nope'));

    await qualifyOne(`job-fatal-${code}`, 'profile-1');

    expect(pauseJobWithFailure).toHaveBeenCalledWith(
      `job-fatal-${code}`,
      expect.objectContaining({ code }),
    );
  });
});

describe('when the model answers with nonsense', () => {
  it('carries on, because the next profile may well work', async () => {
    evaluateProfile.mockRejectedValue(
      new LlmError(
        'LLM_BAD_JSON',
        'The AI model returned something unreadable.',
      ),
    );

    await qualifyOne('job-badjson-1', 'profile-1');

    expect(pauseJobWithFailure).not.toHaveBeenCalled();
    expect(decisions[0].status).toBe('error');
  });

  it('pauses once five profiles in a row have failed', async () => {
    evaluateProfile.mockRejectedValue(
      new LlmError(
        'LLM_BAD_JSON',
        'The AI model returned something unreadable.',
      ),
    );

    const jobId = 'job-badjson-streak';
    for (let i = 1; i <= 5; i++) {
      profileDecisionCreate.mockClear();
      await qualifyOne(jobId, `profile-${i}`);
    }

    // Five, not fifty. The cost of being wrong here is measured in real
    // LinkedIn calls against the user's own session.
    expect(pauseJobWithFailure).toHaveBeenCalledTimes(1);
    expect(pauseJobWithFailure).toHaveBeenCalledWith(
      jobId,
      expect.objectContaining({ code: 'LLM_BAD_JSON' }),
    );
  });

  it('forgets the streak as soon as one profile succeeds', async () => {
    const jobId = 'job-badjson-recovers';

    for (let i = 1; i <= 4; i++) {
      evaluateProfile.mockRejectedValueOnce(
        new LlmError('LLM_BAD_JSON', 'unreadable'),
      );
      profileDecisionCreate.mockClear();
      await qualifyOne(jobId, `profile-${i}`);
    }

    evaluateProfile.mockResolvedValueOnce({ match: false, reason: 'Intern' });
    profileDecisionCreate.mockClear();
    await qualifyOne(jobId, 'profile-good');

    // Four more failures must not trip the breaker, because the counter reset.
    for (let i = 5; i <= 8; i++) {
      evaluateProfile.mockRejectedValueOnce(
        new LlmError('LLM_BAD_JSON', 'unreadable'),
      );
      profileDecisionCreate.mockClear();
      await qualifyOne(jobId, `profile-${i}`);
    }

    expect(pauseJobWithFailure).not.toHaveBeenCalled();
  });
});

describe('when the model answers properly', () => {
  it('records a rejection as a rejection', async () => {
    evaluateProfile.mockResolvedValue({
      match: false,
      reason: 'Tier NONE — intern',
    });

    await qualifyOne('job-ok-1', 'profile-1');

    expect(decisions[0].status).toBe('rejected');
    expect(pauseJobWithFailure).not.toHaveBeenCalled();
  });

  it('records and publishes a qualified profile', async () => {
    evaluateProfile.mockResolvedValue({
      match: true,
      reason: 'Tier 1 — hiring manager',
    });

    await qualifyOne('job-ok-2', 'profile-1');

    expect(decisions[0].status).toBe('qualified');
    expect(decisions[0].isQualified).toBe(true);
    expect(publishQualifiedProfile).toHaveBeenCalledTimes(1);
  });
});
