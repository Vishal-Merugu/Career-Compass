import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkAiModel } from './jobPreflight.service.js';
import type { IUserConfig } from '../shared/types.js';

/**
 * The check that would have turned twenty wasted minutes into one sentence.
 *
 * Both halves of the 2026-08-09 failure are covered here: an address that
 * cannot be reached, and a model that is not installed on a host that *can* be
 * reached. The second is easy to get wrong in a way that silently passes — see
 * the exact-match test.
 */

function config(overrides: Partial<IUserConfig> = {}): IUserConfig {
  return {
    keywords: '',
    locations: '',
    dailyLimit: 15,
    llmProvider: 'ollama',
    llmApiKey: null,
    llmUrl: 'http://llm.test',
    llmModel: 'qwen2.5:14b',
    userContext: null,
    targetGeoId: '',
    emailFinderEnabled: true,
    ...overrides,
  } as IUserConfig;
}

function tagsResponse(...models: string[]): Response {
  return new Response(
    JSON.stringify({ models: models.map((name) => ({ name })) }),
    { status: 200 },
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('checkAiModel', () => {
  it('passes when the configured model is installed', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(tagsResponse('qwen2.5:14b', 'mistral-small:24b')),
    );

    await expect(checkAiModel(config())).resolves.toMatchObject({ ok: true });
  });

  it('rejects a different size of the same family', async () => {
    // The exact case. The VM has 14b installed; the old default asked for
    // 1.5b. A family-name match was tried first and passed this, which would
    // have shipped the original bug behind a green check.
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(tagsResponse('qwen2.5:14b', 'mistral-small:24b')),
    );

    const result = await checkAiModel(config({ llmModel: 'qwen2.5:1.5b' }));

    expect(result.ok).toBe(false);
    expect(result.code).toBe('LLM_MODEL_NOT_FOUND');
    // Naming what *is* available is the difference between a complaint and an
    // instruction.
    expect(result.detail).toContain('qwen2.5:14b');
  });

  it('treats a bare name and its :latest tag as the same model', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(tagsResponse('llama3:latest')),
    );

    await expect(
      checkAiModel(config({ llmModel: 'llama3' })),
    ).resolves.toMatchObject({ ok: true });
  });

  it('reports an unreachable host with the address it tried', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(
        Object.assign(new TypeError('fetch failed'), {
          cause: { code: 'ENOTFOUND' },
        }),
      ),
    );

    const result = await checkAiModel(
      config({ llmUrl: 'http://localhost:11434' }),
    );

    expect(result.code).toBe('LLM_UNREACHABLE');
    expect(result.detail).toContain('localhost:11434');
  });

  it('fails when no model has been chosen at all', async () => {
    const result = await checkAiModel(config({ llmModel: '' }));

    expect(result.code).toBe('LLM_MODEL_NOT_FOUND');
  });

  it('does not second-guess a hosted provider’s model list', async () => {
    // OpenRouter and Gemini list hundreds of ids in shapes that vary
    // (`models/gemini-…`), so enforcing membership there raises more false
    // alarms than it catches real problems.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ data: [{ id: 'something/else' }] }), {
          status: 200,
        }),
      ),
    );

    await expect(
      checkAiModel(
        config({ llmProvider: 'openrouter', llmModel: 'anthropic/claude' }),
      ),
    ).resolves.toMatchObject({ ok: true });
  });
});
