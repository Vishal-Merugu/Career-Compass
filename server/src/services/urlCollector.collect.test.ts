import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The batch loop, with LinkedIn and Postgres faked.
 *
 * One question, and it is the one that hung a run for ten hours: what counts as
 * a collected profile. LinkedIn returns people this job already has once a
 * company runs low, and a batch made entirely of those is the end of the
 * search — not fourteen new people to go and scrape.
 */

interface FakeUrl {
  jobId: string;
  url: string;
  batchNumber: number;
}

const store = vi.hoisted(() => ({
  urls: [] as FakeUrl[],
  jobStatus: 'collecting_urls',
  /** Pages of `profileId`s the fake search returns, in order. */
  pages: [] as string[][],
  pagesServed: 0,
}));

vi.mock('../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// No pacing in tests: the real one sleeps seconds per page.
vi.mock('../shared/rateLimiter.js', () => ({
  apiDelay: () => Promise.resolve(),
}));

vi.mock('./linkedinSession.service.js', () => ({
  JOB_STATUS_PAUSED_SESSION: 'paused_session',
  withVoyager: (_userId: string, fn: (client: unknown) => unknown) =>
    Promise.resolve(
      fn({
        resolveCompany: () =>
          Promise.resolve({ '*elements': ['urn:li:fs_normalized_company:99'] }),
        searchPeople: () => {
          const page = store.pages[store.pagesServed] ?? [];
          store.pagesServed += 1;
          return Promise.resolve({ page });
        },
      }),
    ),
}));

vi.mock('../shared/parsers.js', () => ({
  // The fake search hands its page straight through.
  parsePeopleSearchResults: (res: { page: string[] }) =>
    res.page.map((profileId) => ({ profileId })),
  parsePaginationMetadata: () => ({ count: 12 }),
}));

vi.mock('../lib/prisma.js', () => ({
  prisma: {
    searchJob: {
      findUnique: () => Promise.resolve({ status: store.jobStatus }),
    },
    profileUrl: {
      // The real one relies on the `(jobId, url)` unique constraint; the fake
      // has to enforce it, since the returned count is the thing under test.
      createMany: ({
        data,
        skipDuplicates,
      }: {
        data: FakeUrl[];
        skipDuplicates?: boolean;
      }) => {
        let count = 0;
        for (const row of data) {
          const exists = store.urls.some(
            (u) => u.jobId === row.jobId && u.url === row.url,
          );
          if (exists && skipDuplicates) continue;
          store.urls.push(row);
          count += 1;
        }
        return Promise.resolve({ count });
      },
    },
  },
}));

const { collectProfileUrls } = await import('./urlCollector.service.js');

const USER = 'user-1';
const JOB = 'job-1';
const SEARCH_URL = 'https://www.linkedin.com/company/framatome/people/';

beforeEach(() => {
  store.urls = [];
  store.jobStatus = 'collecting_urls';
  store.pages = [];
  store.pagesServed = 0;
});

describe('collectProfileUrls', () => {
  it('counts new URLs, not results', async () => {
    store.urls = [
      { jobId: JOB, url: 'https://www.linkedin.com/in/a/', batchNumber: 1 },
      { jobId: JOB, url: 'https://www.linkedin.com/in/b/', batchNumber: 1 },
    ];
    // Two the job already has, one it does not, then the search runs out.
    store.pages = [['a', 'b', 'c'], []];

    const result = await collectProfileUrls(USER, JOB, 2, 50, SEARCH_URL);

    expect(result.collected).toBe(1);
    expect(result.seen).toBe(3);
    expect(result.exhausted).toBe(true);
  });

  // The stall: batch 14 returned 14 people, every one already collected, and
  // `collected: 14` sent the run to `scraping` with nothing to scrape.
  it('collects nothing from a batch of pure duplicates', async () => {
    store.urls = ['a', 'b', 'c'].map((id) => ({
      jobId: JOB,
      url: `https://www.linkedin.com/in/${id}/`,
      batchNumber: 1,
    }));
    store.pages = [['a', 'b', 'c'], []];

    const result = await collectProfileUrls(USER, JOB, 2, 50, SEARCH_URL);

    expect(result.collected).toBe(0);
    expect(result.seen).toBe(3);
  });

  it('keeps paging past a page of duplicates to reach new people', async () => {
    store.urls = [
      { jobId: JOB, url: 'https://www.linkedin.com/in/a/', batchNumber: 1 },
    ];
    store.pages = [['a'], ['new-1', 'new-2'], []];

    const result = await collectProfileUrls(USER, JOB, 2, 50, SEARCH_URL);

    expect(result.collected).toBe(2);
    expect(store.urls).toHaveLength(3);
  });

  it('stops at the page budget when the search only repeats itself', async () => {
    store.urls = [
      { jobId: JOB, url: 'https://www.linkedin.com/in/a/', batchNumber: 1 },
    ];
    // Never empty, never new: without a budget this pages forever.
    store.pages = Array.from({ length: 500 }, () => ['a']);

    const result = await collectProfileUrls(USER, JOB, 2, 50, SEARCH_URL);

    expect(result.collected).toBe(0);
    expect(result.exhausted).toBe(true);
    expect(store.pagesServed).toBeLessThanOrEqual(40);
  });

  it('stops when the run is paused mid-collection', async () => {
    store.pages = [['a'], ['b'], []];
    store.jobStatus = 'paused_error';

    const result = await collectProfileUrls(USER, JOB, 1, 50, SEARCH_URL);

    expect(result.interrupted).toBe(true);
    expect(result.collected).toBe(0);
    expect(store.urls).toHaveLength(0);
  });
});
