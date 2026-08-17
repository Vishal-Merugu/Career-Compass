import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { findEmailViaLinkFinder, resetLinkFinderLatch } from './linkfinder.js';

const URL = 'https://www.linkedin.com/in/vinzent-ruf-7a26932ba/';

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
  resetLinkFinderLatch();
  vi.stubEnv('LINKFINDER_API_KEY', 'lf_sk_test');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('findEmailViaLinkFinder', () => {
  it('is skipped entirely when no key is configured', async () => {
    vi.stubEnv('LINKFINDER_API_KEY', '');
    const fetchMock = mockFetch(200, {});

    const result = await findEmailViaLinkFinder(URL);

    expect(result).toMatchObject({ ok: false, reason: 'disabled' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends the secret as x-api-secret with the business_email_finder body', async () => {
    const fetchMock = mockFetch(200, { email: 'vinzent.ruf@hydrogenious.net' });

    await findEmailViaLinkFinder(URL);

    const [, init] = fetchMock.mock.calls[0];
    const headers = init.headers as Record<string, string>;
    expect(headers['x-api-secret']).toBe('lf_sk_test');
    expect(JSON.parse(init.body as string)).toEqual({
      type: 'business_email_finder',
      linkedin_url: URL,
    });
  });

  it('returns the email on a hit', async () => {
    mockFetch(200, { email: 'vinzent.ruf@hydrogenious.net' });

    const result = await findEmailViaLinkFinder(URL);

    expect(result).toEqual({ ok: true, email: 'vinzent.ruf@hydrogenious.net' });
  });

  it('reports not_found when the response carries no email', async () => {
    mockFetch(200, {});

    const result = await findEmailViaLinkFinder(URL);

    expect(result).toMatchObject({ ok: false, reason: 'not_found' });
  });

  it('reports not_found when email is null', async () => {
    mockFetch(200, { email: null });

    const result = await findEmailViaLinkFinder(URL);

    expect(result).toMatchObject({ ok: false, reason: 'not_found' });
  });

  it('latches off after the secret is rejected', async () => {
    const fetchMock = mockFetch(401, { error: 'unauthorized' });

    const first = await findEmailViaLinkFinder(URL);
    expect(first).toMatchObject({ ok: false, reason: 'bad_key' });

    // A second call must not hit the network again — the latch answers it.
    const second = await findEmailViaLinkFinder(URL);
    expect(second).toMatchObject({ ok: false, reason: 'disabled' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('surfaces an unexpected HTTP status as an error, without latching', async () => {
    const fetchMock = mockFetch(500, 'boom');

    const result = await findEmailViaLinkFinder(URL);
    expect(result).toMatchObject({ ok: false, reason: 'error' });

    // 500 is transient — the next call is allowed to try again.
    await findEmailViaLinkFinder(URL);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
