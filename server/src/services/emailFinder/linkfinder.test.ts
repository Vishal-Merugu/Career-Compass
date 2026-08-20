import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  findEmailViaLinkFinder,
  isPausingReason,
  resetLinkFinderPacing,
} from './linkfinder.js';

const URL = 'https://www.linkedin.com/in/tim-klein-31437721b/';
const ENDPOINT = 'https://api.linkfinderai.com';
const KEY = 'lf_sk_test';

interface Reply {
  status: number;
  body: unknown;
}

/**
 * Script one reply per call, in order. A single-element array is the common
 * case; more than one exercises the 429 retry path.
 */
function mockFetch(replies: Reply[]) {
  let call = 0;
  const fn = vi.fn((url: string, _init?: RequestInit) => {
    if (url !== ENDPOINT) throw new Error(`unexpected fetch to ${url}`);
    const reply = replies[Math.min(call++, replies.length - 1)];
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
  // The pacer is keyed by credential and persists across calls, so without
  // this every case after the first waits out a real 1.1s spacing delay.
  resetLinkFinderPacing();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('isPausingReason', () => {
  it('separates "stop the pass" from "this profile has no email"', () => {
    expect(isPausingReason('no_credits')).toBe(true);
    expect(isPausingReason('rate_limited')).toBe(true);
    expect(isPausingReason('bad_key')).toBe(true);

    // A miss and a transient 500 must never pause: one is an answer about the
    // person, the other is the provider having a bad minute.
    expect(isPausingReason('not_found')).toBe(false);
    expect(isPausingReason('error')).toBe(false);
    expect(isPausingReason('disabled')).toBe(false);
    expect(isPausingReason(undefined)).toBe(false);
  });
});

describe('findEmailViaLinkFinder', () => {
  it("sends the documented request shape with the caller's key", async () => {
    const fetchMock = mockFetch([
      { status: 200, body: { status: 'success', result: 'tim@power.com' } },
    ]);

    const result = await findEmailViaLinkFinder(URL, KEY);

    expect(result).toEqual({ ok: true, email: 'tim@power.com' });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe(
      `Bearer ${KEY}`,
    );
    expect(JSON.parse(init.body as string)).toEqual({
      type: 'linkedin_profile_to_email',
      input_data: URL,
    });
  });

  it('strips a "Bearer " prefix the user pasted in with their key', async () => {
    const fetchMock = mockFetch([
      { status: 200, body: { status: 'success', result: 'a@b.com' } },
    ]);

    await findEmailViaLinkFinder(URL, `Bearer ${KEY}`);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBe(
      `Bearer ${KEY}`,
    );
  });

  it('makes no request at all without a key', async () => {
    const fetchMock = mockFetch([{ status: 200, body: {} }]);

    const result = await findEmailViaLinkFinder(URL, null);

    expect(result.reason).toBe('disabled');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports an empty result as a miss, not an error', async () => {
    // A billed credit that found nothing. The row is held for the extension,
    // so calling this an error would retire it instead.
    mockFetch([{ status: 200, body: { status: 'success', result: '' } }]);

    const result = await findEmailViaLinkFinder(URL, KEY);

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('not_found');
  });

  it('maps 401 to bad_key and 402 to no_credits', async () => {
    mockFetch([{ status: 401, body: { message: 'unauthorized' } }]);
    expect((await findEmailViaLinkFinder(URL, KEY)).reason).toBe('bad_key');

    resetLinkFinderPacing();
    mockFetch([{ status: 402, body: { message: 'insufficient credits' } }]);
    expect((await findEmailViaLinkFinder(URL, KEY)).reason).toBe('no_credits');
  });

  it("does not latch a 402 across calls — the pause is the caller's job", async () => {
    // The old module latched itself off process-wide on 402, which disabled the
    // layer for every other user on the instance. Credits are per account now,
    // so this module must stay stateless about them.
    mockFetch([
      { status: 402, body: {} },
      { status: 200, body: { status: 'success', result: 'x@y.com' } },
    ]);

    expect((await findEmailViaLinkFinder(URL, KEY)).reason).toBe('no_credits');
    expect(await findEmailViaLinkFinder(URL, KEY)).toEqual({
      ok: true,
      email: 'x@y.com',
    });
  });

  it('retries a 429 and succeeds if the retry lands', async () => {
    const fetchMock = mockFetch([
      { status: 429, body: {} },
      { status: 200, body: { status: 'success', result: 'ok@co.com' } },
    ]);

    const result = await findEmailViaLinkFinder(URL, KEY);

    expect(result).toEqual({ ok: true, email: 'ok@co.com' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  }, 10_000);

  it('reports rate_limited once the retries are spent', async () => {
    const fetchMock = mockFetch([{ status: 429, body: {} }]);

    const result = await findEmailViaLinkFinder(URL, KEY);

    expect(result.reason).toBe('rate_limited');
    // Initial call plus MAX_RETRIES.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  }, 20_000);

  it('treats a 5xx as a per-row error, not a reason to pause', async () => {
    mockFetch([
      { status: 500, body: { message: 'Workflow execution failed' } },
    ]);

    const result = await findEmailViaLinkFinder(URL, KEY);

    expect(result.reason).toBe('error');
    expect(isPausingReason(result.reason)).toBe(false);
  });

  it('treats an async job hand-off as a miss rather than polling inline', async () => {
    mockFetch([
      {
        status: 200,
        body: { job_id: 'abc', status: 'processing', poll_url: '/x' },
      },
    ]);

    const result = await findEmailViaLinkFinder(URL, KEY);

    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/async job/i);
  });
});
