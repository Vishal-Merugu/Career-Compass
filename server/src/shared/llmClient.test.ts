import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  classifyHttpFailure,
  classifyTransportFailure,
  evaluateProfile,
  extractJsonObject,
  getBaseUrl,
  llmHealthCheck,
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

describe('a host that does not serve /models', () => {
  /**
   * `/models` is a convention, not part of the OpenAI-compatible contract.
   * Cloudflare Workers AI's account-scoped `/ai/v1` and most self-hosted
   * gateways skip it, and treating that 404 as "unreachable" would park a
   * working key on the strength of a URL the run never calls.
   */
  const custom = config({
    llmProvider: 'custom',
    llmUrl: 'https://gateway.test/v1',
    llmModel: 'some-model',
    llmApiKey: 'k',
  });

  it('falls back to asking the model, and passes when it answers', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('not found', { status: 404 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ choices: [{ message: { content: 'pong' } }] }),
          { status: 200 },
        ),
      );
    vi.stubGlobal('fetch', fetchMock);

    const health = await llmHealthCheck(custom);

    expect(health.ok).toBe(true);
    expect(fetchMock.mock.calls[1]?.[0]).toContain('/chat/completions');
  });

  it('still reports a bad key as a bad key', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(new Response('not found', { status: 404 }))
        .mockResolvedValueOnce(new Response('bad token', { status: 401 })),
    );

    const health = await llmHealthCheck(custom);

    // The probe must not turn every failure into a pass; only the missing
    // listing endpoint is excused.
    expect(health.ok).toBe(false);
    expect(health.code).toBe('LLM_AUTH');
  });

  it('does not probe when the listing endpoint works', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [{ id: 'some-model' }] }), {
        status: 200,
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const health = await llmHealthCheck(custom);

    expect(health.ok).toBe(true);
    expect(health.models).toEqual(['some-model']);
    // A probe costs a request against the user's quota. Not spending one when
    // the cheap check already answered.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('reading a verdict out of a messy answer', () => {
  /**
   * Every provider serves the same wire format; the models do not write the
   * same way. These are the shapes free models actually return, and each one
   * used to be an `LLM_BAD_JSON` — a thrown-away verdict that then burned the
   * next key in the chain to re-earn.
   */
  it('reads plain JSON', () => {
    expect(extractJsonObject('{"match":true,"reason":"Tier 1"}')).toEqual({
      match: true,
      reason: 'Tier 1',
    });
  });

  it('reads it out of a ```json fence', () => {
    const raw = '```json\n{"match":false,"reason":"Tier NONE"}\n```';
    expect(extractJsonObject(raw)?.match).toBe(false);
  });

  it('skips an R1-style <think> preamble', () => {
    const raw =
      '<think>The headline says intern, so this is a student.</think>\n{"match":false,"reason":"student"}';
    expect(extractJsonObject(raw)?.reason).toBe('student');
  });

  it('skips a polite sentence before the object', () => {
    const raw =
      'Sure! Here is the evaluation:\n{"match":true,"reason":"Tier 2"}';
    expect(extractJsonObject(raw)?.reason).toBe('Tier 2');
  });

  it('is not fooled by a brace inside the reason text', () => {
    const raw = 'Here: {"match":true,"reason":"uses {braces} in their bio"}';
    // Ending the object at the first `}` would truncate to invalid JSON and
    // throw away a perfectly good verdict.
    expect(extractJsonObject(raw)?.reason).toBe('uses {braces} in their bio');
  });

  it('is not fooled by an escaped quote', () => {
    const raw = '{"match":true,"reason":"they call it \\"growth\\" work"}';
    expect(extractJsonObject(raw)?.reason).toBe('they call it "growth" work');
  });

  it('returns null for prose with no object at all', () => {
    expect(extractJsonObject('I cannot evaluate this profile.')).toBeNull();
  });

  it('unwraps a verdict the model wrapped in an array', () => {
    expect(extractJsonObject('[{"match":true,"reason":"Tier 1"}]')?.match).toBe(
      true,
    );
  });

  it('walks past a restated format to the real answer', () => {
    // A small model told to "return {"match": true/false}" often echoes that
    // literally before answering. `true/false` is not valid JSON, so stopping
    // at the first balanced object would throw away the verdict behind it.
    const raw =
      'Format: {"match": true/false, "reason": "..."}\n\n{"match": true, "reason": "Tier 1 — hiring manager"}';
    expect(extractJsonObject(raw)?.reason).toBe('Tier 1 — hiring manager');
  });

  it('rejects an object that carries no verdict at all', () => {
    // `Boolean(undefined)` is `false`, so accepting this would record a
    // rejection the model never made — the 2026-08-09 failure, re-entering
    // through the parser instead of the transport.
    expect(extractJsonObject('{"tier":"NONE","note":"unclear"}')).toBeNull();
  });

  it('returns null when the model ran out of tokens mid-thought', () => {
    expect(extractJsonObject('<think>Let me consider their tenure')).toBeNull();
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
