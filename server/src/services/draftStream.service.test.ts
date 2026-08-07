import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  extractDelta,
  readLines,
  streamChatCompletion,
} from './draftStream.service.js';
import type { IUserConfig } from '../shared/types.js';

/** Feed a stream one arbitrary slice at a time, as the network would. */
function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

async function collect(gen: AsyncGenerator<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const value of gen) out.push(value);
  return out;
}

const config = (over: Partial<IUserConfig> = {}): IUserConfig =>
  ({
    llmProvider: 'ollama',
    llmUrl: 'http://llm.test',
    llmModel: 'test-model',
    ...over,
  }) as IUserConfig;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('readLines', () => {
  it('joins a line split across chunks', async () => {
    const lines = await collect(
      readLines(streamOf(['he', 'll', 'o\nworld\n'])),
    );
    expect(lines).toEqual(['hello', 'world']);
  });

  it('emits several lines arriving in one chunk', async () => {
    const lines = await collect(readLines(streamOf(['a\nb\nc\n'])));
    expect(lines).toEqual(['a', 'b', 'c']);
  });

  it('emits a trailing line with no newline after it', async () => {
    expect(await collect(readLines(streamOf(['a\nb'])))).toEqual(['a', 'b']);
  });

  it('strips CR so a CRLF stream does not carry it into the JSON', async () => {
    expect(await collect(readLines(streamOf(['a\r\nb\r\n'])))).toEqual([
      'a',
      'b',
    ]);
  });

  it('reassembles a multi-byte character split across chunks', async () => {
    // '—' is three bytes; splitting it is what a decoder without `stream: true`
    // turns into a replacement character mid-draft.
    const bytes = new TextEncoder().encode('a—b\n');
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, 2));
        controller.enqueue(bytes.slice(2));
        controller.close();
      },
    });
    expect(await collect(readLines(stream))).toEqual(['a—b']);
  });
});

describe('extractDelta', () => {
  it('reads Ollama message content', () => {
    expect(extractDelta({ message: { content: 'hi' } }, true)).toBe('hi');
  });

  it('reads an OpenAI delta', () => {
    expect(
      extractDelta({ choices: [{ delta: { content: 'hi' } }] }, false),
    ).toBe('hi');
  });

  it('returns empty for a frame carrying no content', () => {
    expect(extractDelta({ choices: [{ finish_reason: 'stop' }] }, false)).toBe(
      '',
    );
    expect(extractDelta({ done: true }, true)).toBe('');
    expect(extractDelta(null, true)).toBe('');
    expect(extractDelta('nonsense', false)).toBe('');
  });

  it('does not read an OpenAI frame as Ollama, or the reverse', () => {
    expect(
      extractDelta({ choices: [{ delta: { content: 'hi' } }] }, true),
    ).toBe('');
    expect(extractDelta({ message: { content: 'hi' } }, false)).toBe('');
  });
});

describe('streamChatCompletion', () => {
  function mockFetch(body: ReadableStream<Uint8Array> | null, ok = true) {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue({
      ok,
      status: ok ? 200 : 500,
      body,
      text: () => Promise.resolve('upstream exploded'),
    } as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  const signal = new AbortController().signal;

  it('yields Ollama NDJSON deltas and stops at done', async () => {
    mockFetch(
      streamOf([
        '{"message":{"content":"Hel"}}\n',
        '{"message":{"content":"lo"}}\n{"message":{"content":""},"done":true}\n',
        '{"message":{"content":"never"}}\n',
      ]),
    );

    const out = await collect(
      streamChatCompletion(config(), 'sys', 'user', 100, 0.7, signal),
    );
    expect(out.join('')).toBe('Hello');
  });

  it('yields OpenAI SSE deltas and stops at [DONE]', async () => {
    mockFetch(
      streamOf([
        ': keepalive\n\n',
        'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"lo"}}]}\n\ndata: [DONE]\n\n',
        'data: {"choices":[{"delta":{"content":"never"}}]}\n\n',
      ]),
    );

    const out = await collect(
      streamChatCompletion(
        config({ llmProvider: 'openrouter' }),
        'sys',
        'user',
        100,
        0.7,
        signal,
      ),
    );
    expect(out.join('')).toBe('Hello');
  });

  it('skips a malformed frame rather than dropping the draft', async () => {
    mockFetch(
      streamOf([
        '{"message":{"content":"a"}}\n',
        '{not json\n',
        '{"message":{"content":"b"}}\n',
      ]),
    );

    const out = await collect(
      streamChatCompletion(config(), 'sys', 'user', 100, 0.7, signal),
    );
    expect(out.join('')).toBe('ab');
  });

  it('requests a stream and passes the abort signal through', async () => {
    const fetchMock = mockFetch(streamOf(['{"done":true}\n']));
    await collect(
      streamChatCompletion(config(), 'sys', 'user', 256, 0.4, signal),
    );

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://llm.test/api/chat');
    expect(init.signal).toBe(signal);
    expect(JSON.parse(init.body as string)).toMatchObject({
      stream: true,
      options: { num_predict: 256, temperature: 0.4 },
    });
  });

  it('throws a 502 AppError on an upstream failure', async () => {
    mockFetch(null, false);
    await expect(
      collect(streamChatCompletion(config(), 'sys', 'user', 100, 0.7, signal)),
    ).rejects.toMatchObject({
      statusCode: 502,
      message: expect.stringContaining('upstream exploded'),
    });
  });

  it('throws when the response carries no body', async () => {
    mockFetch(null);
    await expect(
      collect(streamChatCompletion(config(), 'sys', 'user', 100, 0.7, signal)),
    ).rejects.toThrow(/no response body/);
  });
});
