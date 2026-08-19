import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  findEmailViaLinkFinder,
  linkFinderEnabled,
  resetLinkFinderLatch,
} from './linkfinder.js';

const URL = 'https://www.linkedin.com/in/tim-klein-31437721b/';
const OFFICIAL = 'https://api.linkfinderai.com';

interface Reply {
  status: number;
  body: unknown;
}

/**
 * Route fetch by endpoint so a test can script the official API and the free
 * worker independently. Returns the mock for header/body assertions.
 */
function mockFetch(routes: { official?: Reply; free?: Reply }) {
  const fn = vi.fn((url: string, _init?: RequestInit) => {
    const reply = url === OFFICIAL ? routes.official : routes.free;
    if (!reply) throw new Error(`unexpected fetch to ${url}`);
    return Promise.resolve({
      ok: reply.status >= 200 && reply.status < 300,
      status: reply.status,
      json: async () => reply.body,
      text: async () => JSON.stringify(reply.body),
    });
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

beforeEach(() => {
  resetLinkFinderLatch();
  vi.stubEnv('LINKFINDER_API_KEY', 'official-key');
  vi.stubEnv('LINKFINDER_FREE_SECRET', 'lf_sk_free');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('linkFinderEnabled', () => {
  it('is true when either key is set, false when neither is', () => {
    expect(linkFinderEnabled()).toBe(true);
    vi.stubEnv('LINKFINDER_API_KEY', '');
    expect(linkFinderEnabled()).toBe(true); // free secret still set
    vi.stubEnv('LINKFINDER_FREE_SECRET', '');
    expect(linkFinderEnabled()).toBe(false);
  });
});

describe('findEmailViaLinkFinder', () => {
  it('returns the official result and never calls the free worker on a hit', async () => {
    const fetchMock = mockFetch({
      official: {
        status: 200,
        body: { status: 'success', result: 'tim@power-service.com' },
      },
    });

    const result = await findEmailViaLinkFinder(URL);

    expect(result).toMatchObject({
      ok: true,
      email: 'tim@power-service.com',
      via: 'official',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('sends a Bearer token and the linkedin_profile_to_email body to the official API', async () => {
    const fetchMock = mockFetch({
      official: { status: 200, body: { status: 'success', result: 'a@b.com' } },
    });

    await findEmailViaLinkFinder(URL);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(OFFICIAL);
    const headers = init!.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer official-key');
    expect(JSON.parse(init!.body as string)).toEqual({
      type: 'linkedin_profile_to_email',
      input_data: URL,
    });
  });

  it('falls back to the free worker when the official API 500s', async () => {
    const fetchMock = mockFetch({
      official: { status: 500, body: { message: 'Workflow execution failed' } },
      free: { status: 200, body: { email: 'tim@power-service.com' } },
    });

    const result = await findEmailViaLinkFinder(URL);

    expect(result).toMatchObject({
      ok: true,
      email: 'tim@power-service.com',
      via: 'free',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not spend a free-worker call when the official API says not_found', async () => {
    const fetchMock = mockFetch({
      official: { status: 200, body: { status: 'success', result: '' } },
    });

    const result = await findEmailViaLinkFinder(URL);

    expect(result).toMatchObject({
      ok: false,
      reason: 'not_found',
      via: 'official',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('surfaces the free worker rate-limit when both fail to find', async () => {
    mockFetch({
      official: { status: 500, body: { message: 'Workflow execution failed' } },
      free: {
        status: 429,
        body: { message: 'Rate limit exceeded: maximum 20 requests per hour' },
      },
    });

    const result = await findEmailViaLinkFinder(URL);

    expect(result).toMatchObject({
      ok: false,
      reason: 'rate_limited',
      via: 'free',
    });
  });

  it('latches the official layer off after a 401 and stops calling it', async () => {
    const fetchMock = mockFetch({
      official: { status: 401, body: { message: 'unauthorized' } },
      free: { status: 200, body: { email: 'x@y.com' } },
    });

    // First call: official 401 -> falls back to free and finds it.
    const first = await findEmailViaLinkFinder(URL);
    expect(first).toMatchObject({ ok: true, via: 'free' });

    // Second call must not hit the official endpoint again — it is latched.
    await findEmailViaLinkFinder(URL);
    const officialCalls = fetchMock.mock.calls.filter(([u]) => u === OFFICIAL);
    expect(officialCalls).toHaveLength(1);
  });

  it('is disabled with no keys at all', async () => {
    vi.stubEnv('LINKFINDER_API_KEY', '');
    vi.stubEnv('LINKFINDER_FREE_SECRET', '');
    const fetchMock = mockFetch({});

    const result = await findEmailViaLinkFinder(URL);

    expect(result.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
