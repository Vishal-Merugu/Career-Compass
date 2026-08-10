import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The event log's only real invariant: a repeat must roll up, never insert.
 *
 * The log is worth reading only because it is short. A per-occurrence row for
 * an error that recurs three hundred times turns the run page into the thing
 * it was built to replace — the server log, which on the VM is currently a
 * solid wall of Telegram 409s with the real failure buried inside it.
 */

const upsert = vi.hoisted(() => vi.fn().mockResolvedValue({}));
const create = vi.hoisted(() => vi.fn().mockResolvedValue({}));

vi.mock('../lib/prisma.js', () => ({
  prisma: { jobEvent: { upsert, create } },
}));

const { recordJobEvent, recordJobError } =
  await import('./jobEvents.service.js');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('recordJobEvent', () => {
  it('upserts on (jobId, stage, code) rather than inserting', async () => {
    await recordJobEvent('job-1', {
      stage: 'scrape',
      code: 'SCRAPE_PROGRESS',
      message: '25 of 369 profiles read from LinkedIn.',
    });

    expect(create).not.toHaveBeenCalled();
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          jobId_stage_code: {
            jobId: 'job-1',
            stage: 'scrape',
            code: 'SCRAPE_PROGRESS',
          },
        },
      }),
    );
  });

  it('increments the count and rewrites the message on a repeat', async () => {
    await recordJobEvent('job-1', {
      stage: 'scrape',
      code: 'SCRAPE_PROGRESS',
      message: '50 of 369 profiles read from LinkedIn.',
    });

    const { update } = upsert.mock.calls[0][0];

    expect(update.count).toEqual({ increment: 1 });
    // The newest wording wins, so a progress line always reads as current.
    expect(update.message).toBe('50 of 369 profiles read from LinkedIn.');
  });

  it('truncates a runaway detail rather than storing it whole', async () => {
    await recordJobEvent('job-1', {
      stage: 'qualify',
      code: 'LLM_BAD_JSON',
      message: 'unreadable',
      detail: 'x'.repeat(9000),
    });

    expect(upsert.mock.calls[0][0].create.detail.length).toBe(2000);
  });

  it('never throws — a run must not fail because its diary could not be written', async () => {
    upsert.mockRejectedValueOnce(new Error('database is on fire'));

    await expect(
      recordJobEvent('job-1', {
        stage: 'run',
        code: 'RUN_STARTED',
        message: 'Looking for 50 profiles.',
      }),
    ).resolves.toBeUndefined();
  });
});

describe('recordJobError', () => {
  it('writes the shared copy plus its fix, and keeps the raw text as detail', async () => {
    await recordJobError('job-1', 'qualify', 'LLM_UNREACHABLE', {
      detail: 'ECONNREFUSED 127.0.0.1:11434',
    });

    const { create: created } = upsert.mock.calls[0][0];

    expect(created.level).toBe('error');
    expect(created.message).toContain('could not be reached');
    // An error the user cannot act on is barely better than no error at all.
    expect(created.message).toContain('Settings');
    // The raw words travel, but never as the headline.
    expect(created.message).not.toContain('ECONNREFUSED');
    expect(created.detail).toContain('ECONNREFUSED');
  });
});
