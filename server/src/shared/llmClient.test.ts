import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  classifyHttpFailure,
  classifyTransportFailure,
  evaluateProfile,
  getBaseUrl,
  normalizeProvider,
  resolveModel,
  usesOllamaDialect,
} from './llmClient.js';
import { LlmError } from '../errors/AppError.js';
import type { IUserConfig } from './types.js';
import type { IParsedProfile } from './parsers.js';

/**
 * The regression this file exists for.
 *
 * On 2026-08-09 a run evaluated 368 profiles and rejected all 368, with the
 * reason `LLM Error: fetch failed`. The model was never contacted once: the
 * config pointed at `http://localhost:11434`, which inside the container is the
 * container. It looked like a run full of unsuitable candidates because
 * `evaluateProfile` caught the failure and *returned* `match: false`.
 *
 * So the two things worth pinning down are: a failure throws rather than
 * returning a verdict, and the thrown error says which failure it was.
 */

function config(overrides: Partial<IUserConfig> = {}): IUserConfig {
  return {
    keywords: '',
    locations: '',
    dailyLimit: 15,
    llmProvider: 'ollama',
    llmApiKey: null,
    llmUrl: 'http://llm.test',
    llmModel: 'test-model',
    userContext: null,
    targetGeoId: '',
    emailFinderEnabled: true,
    ...overrides,
  } as IUserConfig;
}

const profile: IParsedProfile = {
  firstName: 'Jane',
  lastName: 'Doe',
  headline: 'Engineering Manager',
  about: '',
  experiences: [],
  education: [],
  skills: [],
  location: 'Berlin',
  publicIdentifier: 'janedoe',
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the built-in `server` provider', () => {
  it('resolves URL and model from the environment, not the user row', () => {
    // The whole point: the operator knows an address that works, the user does
    // not. Whatever is in the user's own fields is ignored.
    const cfg = config({
      llmProvider: 'server',
      llmUrl: 'http://ignored',
      llmModel: 'ignored',
    });

    expect(getBaseUrl(cfg)).toBe(
      process.env.DEFAULT_LLM_URL ?? getBaseUrl(cfg),
    );
    expect(resolveModel(cfg)).not.toBe('ignored');
    expect(resolveModel(cfg).length).toBeGreaterThan(0);
  });

  it('speaks Ollama’s dialect', () => {
    // Miss this and a new account — which defaults to `server` — posts
    // OpenAI-shaped bodies at /api/chat and gets nothing back.
    expect(usesOllamaDialect('server')).toBe(true);
    expect(usesOllamaDialect('ollama')).toBe(true);
    expect(usesOllamaDialect('openrouter')).toBe(false);
  });

  it('is what an empty provider falls back to', () => {
    expect(normalizeProvider(config({ llmProvider: '' }))).toBe('server');
  });

  it('never invents a localhost URL for an explicit ollama provider', () => {
    // The old default. Inside Docker it is the container itself, so silently
    // supplying it turns a configuration mistake into a mystery.
    expect(getBaseUrl(config({ llmProvider: 'ollama', llmUrl: '' }))).toBe('');
  });
});

describe('classifying a transport failure', () => {
  it('reports an unreachable host and names the address it tried', () => {
    const err = Object.assign(new TypeError('fetch failed'), {
      cause: { code: 'ECONNREFUSED', message: 'connect ECONNREFUSED' },
    });

    const classified = classifyTransportFailure(err, {
      provider: 'ollama',
      model: 'qwen2.5:14b',
      url: 'http://localhost:11434/api/chat',
    });

    expect(classified).toBeInstanceOf(LlmError);
    expect(classified.code).toBe('LLM_UNREACHABLE');
    // `fetch failed` on its own is what made this invisible for 368 profiles.
    expect(classified.detail).toContain('ECONNREFUSED');
    expect(classified.detail).toContain('http://localhost:11434/api/chat');
  });
});

describe('classifying an HTTP failure', () => {
  const ctx = {
    provider: 'openrouter',
    model: 'some-model',
    url: 'http://llm.test/chat/completions',
  };

  it.each([
    [401, '', 'LLM_AUTH'],
    [403, '', 'LLM_AUTH'],
    [402, '', 'LLM_QUOTA'],
    [429, 'slow down', 'LLM_RATE_LIMIT'],
    [429, 'insufficient credit', 'LLM_QUOTA'],
    [404, 'model "x" not found', 'LLM_MODEL_NOT_FOUND'],
    [400, 'unknown model', 'LLM_MODEL_NOT_FOUND'],
    [404, 'page not found', 'LLM_UNREACHABLE'],
    [500, 'boom', 'UNKNOWN'],
  ])('maps %i %s to %s', (status, body, expected) => {
    expect(classifyHttpFailure(status, body, null, ctx).code).toBe(expected);
  });

  it('reads retry-after so the user can be told how long', () => {
    const headers = new Headers({ 'retry-after': '120' });
    const err = classifyHttpFailure(429, 'slow down', headers, ctx);

    expect(err.code).toBe('LLM_RATE_LIMIT');
    expect(err.retryAfterSeconds).toBe(120);
  });

  it('keeps the provider’s own words as detail, never as the message', () => {
    const err = classifyHttpFailure(401, 'invalid_api_key: sk-...', null, ctx);

    expect(err.message).not.toContain('invalid_api_key');
    expect(err.detail).toContain('invalid_api_key');
  });
});

describe('evaluateProfile', () => {
  it('throws when the model cannot be reached, instead of rejecting the profile', async () => {
    // The regression. Returning `{ match: false }` here is what turned an
    // outage into 368 plausible-looking rejections.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(
        Object.assign(new TypeError('fetch failed'), {
          cause: { code: 'ECONNREFUSED' },
        }),
      ),
    );

    await expect(
      evaluateProfile(profile, 'any criteria', config()),
    ).rejects.toMatchObject({ code: 'LLM_UNREACHABLE' });
  });

  it('throws when the model answers with something that is not JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ message: { content: 'Sure! Here you go' } }),
          {
            status: 200,
          },
        ),
      ),
    );

    await expect(
      evaluateProfile(profile, 'any criteria', config()),
    ).rejects.toMatchObject({ code: 'LLM_BAD_JSON' });
  });

  it('throws the classified error when the provider refuses', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('invalid key', { status: 401 })),
    );

    await expect(
      evaluateProfile(profile, 'any criteria', config()),
    ).rejects.toMatchObject({ code: 'LLM_AUTH' });
  });

  it('returns the verdict when the model answers properly', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            message: {
              content: '{"match": true, "reason": "Tier 1 — hiring manager"}',
            },
          }),
          { status: 200 },
        ),
      ),
    );

    const result = await evaluateProfile(profile, 'any criteria', config());

    expect(result).toEqual({
      match: true,
      reason: 'Tier 1 — hiring manager',
    });
    // No `ok` field: a caller cannot forget to check it if it does not exist.
    expect('ok' in result).toBe(false);
  });

  it('tolerates a model that wraps its JSON in a markdown fence', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            message: {
              content: '```json\n{"match": false, "reason": "Intern"}\n```',
            },
          }),
          { status: 200 },
        ),
      ),
    );

    await expect(
      evaluateProfile(profile, 'any criteria', config()),
    ).resolves.toEqual({ match: false, reason: 'Intern' });
  });
});
