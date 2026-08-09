import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  findEmailViaAnymailFinder,
  resetAnymailFinderLatch,
} from './anymailfinder.js';

const URL = 'https://www.linkedin.com/in/satyanadella';

function mockFetch(status: number, body: unknown) {
  const fn = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

beforeEach(() => {
  resetAnymailFinderLatch();
  vi.stubEnv('ANYMAILFINDER_API_KEY', 'test-key');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('findEmailViaAnymailFinder', () => {
  it('is skipped entirely when no key is configured', async () => {
    vi.stubEnv('ANYMAILFINDER_API_KEY', '');
    const fetchMock = mockFetch(200, {});

    const result = await findEmailViaAnymailFinder(URL);

    expect(result).toMatchObject({ ok: false, reason: 'disabled' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends the raw key with no Bearer prefix', async () => {
    const fetchMock = mockFetch(200, {
      email: 'satyan@microsoft.com',
      email_status: 'valid',
    });

    await findEmailViaAnymailFinder(URL);

    const headers = fetchMock.mock.calls[0][1].headers as Record<
      string,
      string
    >;
    expect(headers.Authorization).toBe('test-key');
  });

  it('strips a Bearer prefix if the key was pasted with one', async () => {
    vi.stubEnv('ANYMAILFINDER_API_KEY', 'Bearer test-key');
    const fetchMock = mockFetch(200, {
      email: 'a@b.com',
      email_status: 'valid',
    });

    await findEmailViaAnymailFinder(URL);

    const headers = fetchMock.mock.calls[0][1].headers as Record<
      string,
      string
    >;
    expect(headers.Authorization).toBe('test-key');
  });

  it('returns a valid result with the person fields', async () => {
    mockFetch(200, {
      credits_charged: 1,
      email: 'satyan@microsoft.com',
      email_status: 'valid',
      person_full_name: 'Satya Nadella',
      person_company_name: 'Microsoft',
      person_job_title: 'Chairman and CEO',
    });

    const result = await findEmailViaAnymailFinder(URL);

    expect(result).toMatchObject({
      ok: true,
      email: 'satyan@microsoft.com',
      validation: 'valid',
      fullName: 'Satya Nadella',
      company: 'Microsoft',
    });
  });

  it('keeps a risky result rather than discarding it', async () => {
    // Weaker evidence than `valid`, but still a real lookup — better than
    // the generated pattern the next layer would produce.
    mockFetch(200, { email: 'a@b.com', email_status: 'risky' });

    const result = await findEmailViaAnymailFinder(URL);

    expect(result).toMatchObject({ ok: true, validation: 'risky' });
  });

  it('reports not_found and blacklisted as misses', async () => {
    mockFetch(200, { email_status: 'not_found' });
    expect(await findEmailViaAnymailFinder(URL)).toMatchObject({
      ok: false,
      reason: 'not_found',
    });

    resetAnymailFinderLatch();
    mockFetch(200, { email_status: 'blacklisted' });
    expect(await findEmailViaAnymailFinder(URL)).toMatchObject({
      ok: false,
      reason: 'blacklisted',
    });
  });

  it('latches off after a 401 so a bad key is not retried per profile', async () => {
    const fetchMock = mockFetch(401, {});

    const first = await findEmailViaAnymailFinder(URL);
    const second = await findEmailViaAnymailFinder(URL);

    expect(first.reason).toBe('bad_key');
    expect(second.reason).toBe('disabled');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('latches off after a 402 so exhausted credits are not retried', async () => {
    const fetchMock = mockFetch(402, {});

    const first = await findEmailViaAnymailFinder(URL);
    const second = await findEmailViaAnymailFinder(URL);

    expect(first.reason).toBe('no_credits');
    expect(second.reason).toBe('disabled');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not latch on a transient server error', async () => {
    const fetchMock = mockFetch(503, {});

    await findEmailViaAnymailFinder(URL);
    const second = await findEmailViaAnymailFinder(URL);

    expect(second.reason).toBe('error');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
