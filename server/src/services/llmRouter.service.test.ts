import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LlmError } from '../errors/AppError.js';
import type { LlmTarget } from '../shared/llmClient.js';
import type { IUserConfig } from '../shared/types.js';

/**
 * The waterfall, and the one property it exists to guarantee: a run stops only
 * when **every** model has refused.
 *
 * Before this, an account was one model and one 429 from a free tier paused a
 * 400-profile run. The tests that matter here are therefore about which
 * failures move to the next key, which park a key, and — the one that must
 * never regress — that an exhausted chain still throws rather than returning
 * something a caller could read as an answer.
 */

const findMany = vi.hoisted(() => vi.fn());
const update = vi.hoisted(() => vi.fn());

vi.mock('../lib/prisma.js', () => ({
  prisma: { llmCredential: { findMany, update } },
}));
vi.mock('../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { resolveChain, withLlmFallback } =
  await import('./llmRouter.service.js');

interface Row {
  id: string;
  label: string;
  provider: string;
  apiKey: string | null;
  baseUrl: string;
  model: string;
  cooldownUntil: Date | null;
}

function row(overrides: Partial<Row> = {}): Row {
  return {
    id: 'cred-1',
    label: 'Gemini free',
    provider: 'gemini',
    apiKey: 'plain-key',
    baseUrl: '',
    model: 'gemini-2.0-flash',
    cooldownUntil: null,
    ...overrides,
  };
}

function config(overrides: Partial<IUserConfig> = {}): IUserConfig {
  return {
    dailyLimit: 15,
    llmProvider: 'ollama',
    llmApiKey: null,
    llmUrl: 'http://llm.test',
    llmModel: 'qwen2.5:14b',
    userContext: null,
    emailFinderEnabled: true,
    ...overrides,
  } as IUserConfig;
}

beforeEach(() => {
  findMany.mockReset();
  update.mockReset();
  update.mockResolvedValue({});
});

describe('resolveChain', () => {
  it('orders by the priority the user set', async () => {
    findMany.mockResolvedValue([
      row({ id: 'a', label: 'first' }),
      row({ id: 'b', label: 'second' }),
    ]);

    const chain = await resolveChain('user-1');

    expect(chain.map((t) => t.label)).toEqual(['first', 'second']);
  });

  it('appends the legacy UserConfig model as the last resort', async () => {
    findMany.mockResolvedValue([row({ id: 'a', label: 'Gemini' })]);

    const chain = await resolveChain('user-1', config());

    expect(chain).toHaveLength(2);
    expect(chain[1]!.credentialId).toBeNull();
    expect(chain[1]!.provider).toBe('ollama');
  });

  it('is exactly the legacy model when no credential exists', async () => {
    findMany.mockResolvedValue([]);

    const chain = await resolveChain('user-1', config());

    // An account that never opens the new screen must behave precisely as it
    // did before the chain existed.
    expect(chain).toHaveLength(1);
    expect(chain[0]!.credentialId).toBeNull();
  });

  it('drops a cooling credential behind a ready one, but never off the list', async () => {
    findMany.mockResolvedValue([
      row({
        id: 'a',
        label: 'cooling',
        cooldownUntil: new Date(Date.now() + 60_000),
      }),
      row({ id: 'b', label: 'ready' }),
    ]);

    const chain = await resolveChain('user-1');

    // Cooling last, because a cooldown is our own estimate of when a quota
    // resets. Keeping it in the chain is what stops a guessed timer from
    // failing a run that had a working key available.
    expect(chain.map((t) => t.label)).toEqual(['ready', 'cooling']);
  });

  it('skips a credential that names no model', async () => {
    findMany.mockResolvedValue([row({ id: 'a', model: '' })]);

    expect(await resolveChain('user-1')).toHaveLength(0);
  });
});

describe('withLlmFallback', () => {
  it('returns the first answer without touching the rest of the chain', async () => {
    findMany.mockResolvedValue([row({ id: 'a' }), row({ id: 'b' })]);
    const call = vi.fn().mockResolvedValue('answer');

    expect(await withLlmFallback('user-1', call)).toBe('answer');
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('moves to the next model when one is rate-limited', async () => {
    findMany.mockResolvedValue([
      row({ id: 'a', label: 'busy' }),
      row({ id: 'b', label: 'spare' }),
    ]);

    const call = vi
      .fn()
      .mockRejectedValueOnce(new LlmError('LLM_RATE_LIMIT', 'slow down'))
      .mockResolvedValueOnce('answer');

    expect(await withLlmFallback('user-1', call)).toBe('answer');
    expect(call).toHaveBeenCalledTimes(2);
  });

  it('cools a rate-limited key for the provider’s own Retry-After', async () => {
    findMany.mockResolvedValue([row({ id: 'a' }), row({ id: 'b' })]);

    const call = vi
      .fn()
      .mockRejectedValueOnce(
        new LlmError('LLM_RATE_LIMIT', 'slow down', { retryAfterSeconds: 300 }),
      )
      .mockResolvedValueOnce('answer');

    await withLlmFallback('user-1', call);

    const cooled = update.mock.calls.find((c) => c[0].where.id === 'a')?.[0]
      .data.cooldownUntil as Date;
    // Roughly five minutes out, not the 90s default.
    expect(cooled.getTime() - Date.now()).toBeGreaterThan(4 * 60 * 1000);
  });

  it('parks a key with a bad password instead of cooling it', async () => {
    findMany.mockResolvedValue([row({ id: 'a' }), row({ id: 'b' })]);

    const call = vi
      .fn()
      .mockRejectedValueOnce(new LlmError('LLM_AUTH', 'nope'))
      .mockResolvedValueOnce('answer');

    await withLlmFallback('user-1', call);

    const data = update.mock.calls.find((c) => c[0].where.id === 'a')?.[0].data;
    // A wrong key fails identically forever, so a timer cannot fix it.
    expect(data.disabledCode).toBe('LLM_AUTH');
    expect(data.cooldownUntil).toBeNull();
  });

  it('falls through when a model answers with prose instead of JSON', async () => {
    findMany.mockResolvedValue([row({ id: 'a' }), row({ id: 'b' })]);

    const call = vi
      .fn()
      .mockRejectedValueOnce(new LlmError('LLM_BAD_JSON', 'unreadable'))
      .mockResolvedValueOnce('answer');

    // Only true because the caller puts the *parse* inside the callback. A
    // model that cannot follow the format is exactly when the next one helps.
    expect(await withLlmFallback('user-1', call)).toBe('answer');
  });

  it('clears the cooldown of a key that answers', async () => {
    findMany.mockResolvedValue([
      row({ id: 'a', cooldownUntil: new Date(Date.now() + 60_000) }),
    ]);

    await withLlmFallback('user-1', vi.fn().mockResolvedValue('answer'));

    const data = update.mock.calls.find((c) => c[0].where.id === 'a')?.[0].data;
    expect(data.cooldownUntil).toBeNull();
  });

  it('throws LLM_ALL_FAILED once every model has refused', async () => {
    findMany.mockResolvedValue([
      row({ id: 'a', label: 'one' }),
      row({ id: 'b', label: 'two' }),
    ]);

    const call = vi
      .fn()
      .mockRejectedValueOnce(new LlmError('LLM_AUTH', 'bad key'))
      .mockRejectedValueOnce(new LlmError('LLM_UNREACHABLE', 'no route'));

    const err = await withLlmFallback('user-1', call).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(LlmError);
    expect((err as LlmError).code).toBe('LLM_ALL_FAILED');
    // Each model's own failure survives in the detail, so the user can see
    // which key to fix rather than just that "AI failed".
    expect((err as LlmError).detail).toContain('one');
    expect((err as LlmError).detail).toContain('two');
  });

  it('reports a wait, not a fix, when every model was merely busy', async () => {
    findMany.mockResolvedValue([row({ id: 'a' }), row({ id: 'b' })]);

    const call = vi
      .fn()
      .mockRejectedValueOnce(new LlmError('LLM_RATE_LIMIT', 'busy'))
      .mockRejectedValueOnce(new LlmError('LLM_QUOTA', 'spent'));

    const err = (await withLlmFallback('user-1', call).catch(
      (e: unknown) => e,
    )) as LlmError;

    // Nothing here needs editing — it needs time — so the copy must not tell
    // the user to go and fix a key.
    expect(err.code).toBe('LLM_QUOTA');
  });

  it('rethrows a single model’s error untouched', async () => {
    findMany.mockResolvedValue([]);
    const original = new LlmError('LLM_MODEL_NOT_FOUND', 'no such model');

    const err = await withLlmFallback(
      'user-1',
      vi.fn().mockRejectedValue(original),
      { config: config() },
    ).catch((e: unknown) => e);

    // One model in the chain is the pre-existing world: same code, same
    // message, same everything the dashboard already renders.
    expect(err).toBe(original);
  });

  it('does not retry a bug in the caller across five providers', async () => {
    findMany.mockResolvedValue([row({ id: 'a' }), row({ id: 'b' })]);
    const call = vi
      .fn()
      .mockRejectedValue(new TypeError('undefined is not a function'));

    await expect(withLlmFallback('user-1', call)).rejects.toThrow(TypeError);
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('throws rather than inventing an answer when there is nothing to call', async () => {
    findMany.mockResolvedValue([]);
    const call = vi.fn();

    // The 368-rejection failure in one line: a caller must never be handed a
    // value it could mistake for a verdict.
    await expect(withLlmFallback('user-1', call)).rejects.toBeInstanceOf(
      LlmError,
    );
    expect(call).not.toHaveBeenCalled();
  });

  it('passes the decrypted key to the caller, never the stored blob', async () => {
    findMany.mockResolvedValue([row({ id: 'a', apiKey: 'plain-key' })]);
    let seen: LlmTarget | null = null;

    await withLlmFallback('user-1', async (target) => {
      seen = target;
      return 'ok';
    });

    expect(seen!.apiKey).toBe('plain-key');
  });
});
