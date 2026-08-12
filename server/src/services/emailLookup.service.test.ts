import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The queue's decisions, with Postgres faked.
 *
 * What matters here is not that a row is stored — it is that a lease is handed
 * out once, that a miss comes back for another try but not forever, and that a
 * verified address is never overwritten by a guess. All three are invisible in
 * normal use and only surface as a bounced email weeks later.
 */

// ─── Test-only row shapes ────────────────────────────────────────────
//
// Narrower than the Prisma models on purpose: only the columns the service
// actually reads or writes. A wider shape would let a test pass while the real
// query selects something else.

interface TestProfile {
  id: string;
  firstName: string;
  lastName: string;
  linkedinUrl: string;
  email: string | null;
  emailSource: string | null;
  emailValidation: string | null;
  /** userIds that reach this profile through an OutreachLog. */
  owners: string[];
  company: { name: string; website: string | null } | null;
}

interface TestLookup {
  id: string;
  userId: string;
  profileId: string;
  /** Which press of "Find emails" this row belongs to. Null for legacy rows. */
  batchId: string | null;
  status: string;
  attempts: number;
  reclaims: number;
  claimedBy: string | null;
  allowServerFallback: boolean;
  email: string | null;
  emailSource: string | null;
  emailValidation: string | null;
  lastError: string | null;
  requestedAt: Date;
  dispatchedAt: Date | null;
  completedAt: Date | null;
}

interface Store {
  profiles: TestProfile[];
  lookups: TestLookup[];
  nextId: number;
}

const store = vi.hoisted<Store>(() => ({
  profiles: [],
  lookups: [],
  nextId: 1,
}));

vi.mock('../lib/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

/**
 * Prisma's atomic-number shorthand, applied to a plain object.
 *
 * Generic over the column: it used to add every `{ increment }` to `attempts`,
 * which was true when `attempts` was the only counter and silently wrong the
 * moment `reclaims` arrived — the sweep's decrement would have been stored as
 * the literal object `{ decrement: 1 }` and every assertion about it would
 * still have passed.
 */
function applyData(row: TestLookup, data: Record<string, unknown>) {
  const target = row as unknown as Record<string, unknown>;

  for (const [key, value] of Object.entries(data)) {
    if (value && typeof value === 'object' && !(value instanceof Date)) {
      const op = value as { increment?: number; decrement?: number };
      if (typeof op.increment === 'number') {
        target[key] = ((target[key] as number) ?? 0) + op.increment;
        continue;
      }
      if (typeof op.decrement === 'number') {
        target[key] = ((target[key] as number) ?? 0) - op.decrement;
        continue;
      }
    }
    target[key] = value;
  }
}

vi.mock('../lib/prisma.js', () => {
  interface LookupWhere {
    id?: string | { in?: string[] };
    userId?: string;
    profileId?: string;
    /** `null` is a real filter here — legacy rows carry no batch. */
    batchId?: string | { in: string[] } | null;
    OR?: LookupWhere[];
    status?: string | { in: string[] };
    attempts?: { lt?: number; gte?: number };
    allowServerFallback?: boolean;
    requestedAt?: { lt?: Date };
    dispatchedAt?: { lt?: Date };
  }

  const matchLookup = (row: TestLookup, where: LookupWhere): boolean => {
    if (typeof where.id === 'string' && row.id !== where.id) return false;
    if (where.id && typeof where.id === 'object') {
      if (!(where.id.in ?? []).includes(row.id)) return false;
    }
    if (where.userId !== undefined && row.userId !== where.userId) return false;
    if (where.profileId !== undefined && row.profileId !== where.profileId) {
      return false;
    }
    if (typeof where.status === 'string' && row.status !== where.status) {
      return false;
    }
    if (where.status && typeof where.status === 'object') {
      if (!where.status.in.includes(row.status)) return false;
    }
    // `batchId` is only absent from a `where` when the query is deliberately
    // unscoped; `null` means "the legacy batch" and must not be read as "any".
    if ('batchId' in where) {
      const want = where.batchId;
      if (want === null && row.batchId !== null) return false;
      if (typeof want === 'string' && row.batchId !== want) return false;
      if (want && typeof want === 'object') {
        if (row.batchId === null || !want.in.includes(row.batchId))
          return false;
      }
    }
    if (where.OR && !where.OR.some((clause) => matchLookup(row, clause))) {
      return false;
    }
    if (
      where.allowServerFallback !== undefined &&
      row.allowServerFallback !== where.allowServerFallback
    ) {
      return false;
    }
    if (
      where.attempts?.lt !== undefined &&
      !(row.attempts < where.attempts.lt)
    ) {
      return false;
    }
    if (
      where.attempts?.gte !== undefined &&
      !(row.attempts >= where.attempts.gte)
    ) {
      return false;
    }
    if (where.requestedAt?.lt !== undefined) {
      if (!(row.requestedAt < where.requestedAt.lt)) return false;
    }
    if (where.dispatchedAt?.lt !== undefined) {
      if (!row.dispatchedAt) return false;
      if (!(row.dispatchedAt < where.dispatchedAt.lt)) return false;
    }
    return true;
  };

  const withProfile = (row: TestLookup | undefined) => {
    if (!row) return null;
    const profile = store.profiles.find((p) => p.id === row.profileId);
    return {
      ...row,
      profile: profile
        ? {
            firstName: profile.firstName,
            lastName: profile.lastName,
            linkedinUrl: profile.linkedinUrl,
            email: profile.email,
            emailSource: profile.emailSource,
            company: profile.company,
          }
        : null,
    };
  };

  return {
    prisma: {
      profile: {
        findMany: ({
          where,
        }: {
          where: {
            id?: { in?: string[] };
            outreachLogs?: { some?: { userId?: string } };
          };
        }) => {
          const ids = where.id?.in ?? null;
          const userId = where.outreachLogs?.some?.userId;
          return Promise.resolve(
            store.profiles.filter(
              (p) =>
                (ids === null || ids.includes(p.id)) &&
                (userId === undefined || p.owners.includes(userId)),
            ),
          );
        },
        update: ({
          where,
          data,
        }: {
          where: { id: string };
          data: Partial<TestProfile>;
        }) => {
          const row = store.profiles.find((p) => p.id === where.id);
          if (row) Object.assign(row, data);
          return Promise.resolve(row);
        },
      },
      emailLookup: {
        upsert: ({
          where,
          create,
          update,
        }: {
          where: { userId_profileId: { userId: string; profileId: string } };
          create: Partial<TestLookup>;
          update: Partial<TestLookup>;
        }) => {
          const { userId, profileId } = where.userId_profileId;
          const existing = store.lookups.find(
            (l) => l.userId === userId && l.profileId === profileId,
          );
          if (existing) {
            Object.assign(existing, update);
            return Promise.resolve(existing);
          }
          const row: TestLookup = {
            id: `lookup-${store.nextId++}`,
            userId,
            profileId,
            batchId: null,
            status: 'queued',
            attempts: 0,
            claimedBy: null,
            allowServerFallback: false,
            email: null,
            emailSource: null,
            emailValidation: null,
            lastError: null,
            reclaims: 0,
            requestedAt: new Date(),
            dispatchedAt: null,
            completedAt: null,
            ...create,
          };
          store.lookups.push(row);
          return Promise.resolve(row);
        },
        findMany: ({
          where,
          take,
          distinct,
        }: {
          where: LookupWhere;
          take?: number;
          distinct?: ('batchId' | 'id')[];
        }) => {
          let rows = store.lookups.filter((l) => matchLookup(l, where));
          if (distinct?.includes('batchId')) {
            const seen = new Set<string | null>();
            rows = rows.filter((l) => {
              if (seen.has(l.batchId)) return false;
              seen.add(l.batchId);
              return true;
            });
          }
          return Promise.resolve(take ? rows.slice(0, take) : rows);
        },
        count: ({ where }: { where: LookupWhere }) =>
          Promise.resolve(
            store.lookups.filter((l) => matchLookup(l, where)).length,
          ),
        // Both reads select a nested `profile`, so the fake has to join too —
        // returning a bare row here made `completeLookup` throw on
        // `current.email` rather than fail a real assertion.
        findFirst: ({
          where,
          orderBy,
        }: {
          where: LookupWhere;
          orderBy?: { requestedAt?: 'asc' | 'desc' };
        }) => {
          const rows = store.lookups.filter((l) => matchLookup(l, where));
          // `getLookupStats` asks for the newest row to find the current batch,
          // so insertion order is not good enough here.
          if (orderBy?.requestedAt) {
            rows.sort((a, b) =>
              orderBy.requestedAt === 'desc'
                ? b.requestedAt.getTime() - a.requestedAt.getTime()
                : a.requestedAt.getTime() - b.requestedAt.getTime(),
            );
          }
          return Promise.resolve(withProfile(rows[0]));
        },
        findUnique: ({ where }: { where: LookupWhere }) =>
          Promise.resolve(
            withProfile(store.lookups.find((l) => matchLookup(l, where))),
          ),
        update: ({
          where,
          data,
        }: {
          where: { id: string };
          data: Record<string, unknown>;
        }) => {
          const row = store.lookups.find((l) => l.id === where.id);
          if (row) applyData(row, data);
          return Promise.resolve(row);
        },
        updateMany: ({
          where,
          data,
        }: {
          where: LookupWhere;
          data: Record<string, unknown>;
        }) => {
          const rows = store.lookups.filter((l) => matchLookup(l, where));
          for (const row of rows) applyData(row, data);
          return Promise.resolve({ count: rows.length });
        },
        deleteMany: ({ where }: { where: LookupWhere }) => {
          const keep = store.lookups.filter((l) => !matchLookup(l, where));
          const removed = store.lookups.length - keep.length;
          store.lookups = keep;
          return Promise.resolve({ count: removed });
        },
        groupBy: ({ where }: { where?: LookupWhere }) => {
          const rows = where
            ? store.lookups.filter((l) => matchLookup(l, where))
            : store.lookups;
          const byStatus = new Map<string, number>();
          const byUser = new Map<string, number>();
          for (const row of rows) {
            byStatus.set(row.status, (byStatus.get(row.status) ?? 0) + 1);
            byUser.set(row.userId, (byUser.get(row.userId) ?? 0) + 1);
          }
          // The service calls groupBy by `status` for stats and by `userId` for
          // the fallback sweep; return both shapes so either read works.
          return Promise.resolve([
            ...[...byStatus].map(([status, count]) => ({
              status,
              _count: { status: count },
            })),
            ...[...byUser].map(([userId, count]) => ({
              userId,
              _count: { userId: count },
            })),
          ]);
        },
      },
    },
  };
});

const {
  cancelQueuedLookups,
  claimLookups,
  completeLookup,
  enqueueLookups,
  getLookupStats,
  sweepStaleLookups,
  EMAIL_LOOKUP_MAX_ATTEMPTS,
  EMAIL_LOOKUP_MAX_RECLAIMS,
} = await import('./emailLookup.service.js');

const USER = 'user-1';

function seedProfile(over: Partial<TestProfile> = {}): TestProfile {
  const profile: TestProfile = {
    id: `profile-${store.nextId++}`,
    firstName: 'Ada',
    lastName: 'Lovelace',
    linkedinUrl: 'https://www.linkedin.com/in/ada/',
    email: null,
    emailSource: null,
    emailValidation: null,
    owners: [USER],
    company: { name: 'Acme', website: 'https://acme.com' },
    ...over,
  };
  store.profiles.push(profile);
  return profile;
}

beforeEach(() => {
  store.profiles = [];
  store.lookups = [];
  store.nextId = 1;
});

describe('enqueueLookups', () => {
  it('queues a profile that has no address', async () => {
    const profile = seedProfile();

    const result = await enqueueLookups(USER, [profile.id]);

    expect(result.queued).toBe(1);
    expect(store.lookups).toHaveLength(1);
    expect(store.lookups[0].status).toBe('queued');
  });

  it('skips a profile whose address is already verified', async () => {
    const profile = seedProfile({
      email: 'ada@acme.com',
      emailSource: 'smtp_verified',
    });

    const result = await enqueueLookups(USER, [profile.id]);

    // Each provider lookup costs a credit, and a second pass on a confirmed
    // address cannot produce anything better.
    expect(result.queued).toBe(0);
    expect(result.skippedVerified).toBe(1);
    expect(store.lookups).toHaveLength(0);
  });

  it('re-queues a guess without being asked twice', async () => {
    const profile = seedProfile({
      email: 'a.lovelace@acme.com',
      emailSource: 'pattern_guess',
    });

    const result = await enqueueLookups(USER, [profile.id]);

    // Upgrading a guess is the whole reason the queue exists.
    expect(result.queued).toBe(1);
  });

  it('re-queues a verified address only when forced', async () => {
    const profile = seedProfile({
      email: 'ada@acme.com',
      emailSource: 'anymailfinder',
    });

    const result = await enqueueLookups(USER, [profile.id], true);

    expect(result.queued).toBe(1);
  });

  it('ignores ids that are not this user’s profiles', async () => {
    const mine = seedProfile();
    const theirs = seedProfile({ owners: ['someone-else'] });

    const result = await enqueueLookups(USER, [mine.id, theirs.id]);

    expect(result.queued).toBe(1);
    expect(result.skippedUnknown).toBe(1);
    expect(store.lookups.map((l) => l.profileId)).toEqual([mine.id]);
  });

  it('is idempotent — double-clicking does not double the work', async () => {
    const profile = seedProfile();

    await enqueueLookups(USER, [profile.id]);
    await enqueueLookups(USER, [profile.id]);

    expect(store.lookups).toHaveLength(1);
  });

  it('resets the attempt budget on a fresh request', async () => {
    const profile = seedProfile();
    await enqueueLookups(USER, [profile.id]);
    store.lookups[0].attempts = EMAIL_LOOKUP_MAX_ATTEMPTS;
    store.lookups[0].status = 'failed';

    await enqueueLookups(USER, [profile.id]);

    // Otherwise asking again for a profile that failed three times would queue
    // a row no executor is allowed to claim.
    expect(store.lookups[0].attempts).toBe(0);
    expect(store.lookups[0].status).toBe('queued');
  });

  it('rejects an empty selection', async () => {
    await expect(enqueueLookups(USER, [])).rejects.toThrow(/No profiles/i);
  });
});

describe('claimLookups', () => {
  it('hands out the work with everything an executor needs', async () => {
    const profile = seedProfile();
    await enqueueLookups(USER, [profile.id]);

    const items = await claimLookups(USER, 5, 'extension');

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      profileId: profile.id,
      firstName: 'Ada',
      lastName: 'Lovelace',
      companyName: 'Acme',
      companyWebsite: 'https://acme.com',
    });
  });

  it('leases a row once, so two executors cannot both work it', async () => {
    const profile = seedProfile();
    await enqueueLookups(USER, [profile.id]);

    const first = await claimLookups(USER, 5, 'extension');
    const second = await claimLookups(USER, 5, 'server');

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0);
  });

  it('lets the server claim only rows that opted into the fallback', async () => {
    const optedOut = seedProfile();
    const optedIn = seedProfile();

    await enqueueLookups(USER, [optedOut.id]);
    await enqueueLookups(USER, [optedIn.id], false, true);

    const serverItems = await claimLookups(USER, 5, 'server');

    // The server's layers bottom out at a guess, so sweeping every unclaimed row
    // would settle profiles on the weakest answer before a browser had a turn.
    expect(serverItems.map((i) => i.profileId)).toEqual([optedIn.id]);

    // The extension is still free to take either.
    const extItems = await claimLookups(USER, 5, 'extension');
    expect(extItems.map((i) => i.profileId)).toEqual([optedOut.id]);
  });

  it('honours a requestedBefore cutoff, so fresh rows are not swept early', async () => {
    const old = seedProfile();
    const fresh = seedProfile();

    await enqueueLookups(USER, [old.id], false, true);
    await enqueueLookups(USER, [fresh.id], false, true);

    // Age the first row past the grace period.
    store.lookups[0].requestedAt = new Date(Date.now() - 60 * 60 * 1000);

    const cutoff = new Date(Date.now() - 3 * 60 * 1000);
    const items = await claimLookups(USER, 5, 'server', cutoff);

    expect(items.map((i) => i.profileId)).toEqual([old.id]);
  });

  it('will not claim a row that has spent its attempts', async () => {
    const profile = seedProfile();
    await enqueueLookups(USER, [profile.id]);
    store.lookups[0].attempts = EMAIL_LOOKUP_MAX_ATTEMPTS;

    expect(await claimLookups(USER, 5, 'extension')).toHaveLength(0);
  });

  it('counts the attempt at claim time, not at report time', async () => {
    const profile = seedProfile();
    await enqueueLookups(USER, [profile.id]);

    await claimLookups(USER, 5, 'extension');

    // An executor that claims and then vanishes has still used an attempt —
    // otherwise a crash loop retries forever.
    expect(store.lookups[0].attempts).toBe(1);
  });
});

describe('completeLookup', () => {
  it('writes a found address onto the profile', async () => {
    const profile = seedProfile();
    await enqueueLookups(USER, [profile.id]);
    const [item] = await claimLookups(USER, 1, 'extension');

    await completeLookup(USER, item.lookupId, {
      ok: true,
      email: 'ada@acme.com',
      source: 'mailmeteor',
      validation: 'valid',
    });

    expect(profile.email).toBe('ada@acme.com');
    expect(profile.emailSource).toBe('mailmeteor');
    expect(store.lookups[0].status).toBe('done');
  });

  it('refuses to downgrade a verified address to a guess', async () => {
    const profile = seedProfile({
      email: 'ada@acme.com',
      emailSource: 'smtp_verified',
      emailValidation: 'valid',
    });
    await enqueueLookups(USER, [profile.id], true);
    const [item] = await claimLookups(USER, 1, 'extension');

    await completeLookup(USER, item.lookupId, {
      ok: true,
      email: 'a.lovelace@acme.com',
      source: 'pattern_guess',
      validation: 'guess',
    });

    // The guess is recorded on the lookup row but must not reach the profile —
    // outreach would mail it from the user's own Gmail.
    expect(profile.email).toBe('ada@acme.com');
    expect(profile.emailSource).toBe('smtp_verified');
    expect(store.lookups[0].email).toBe('a.lovelace@acme.com');
    expect(store.lookups[0].status).toBe('done');
  });

  it('re-queues a miss so another executor can try', async () => {
    const profile = seedProfile();
    await enqueueLookups(USER, [profile.id]);
    const [item] = await claimLookups(USER, 1, 'extension');

    await completeLookup(USER, item.lookupId, {
      ok: false,
      error: 'Turnstile refused a token',
    });

    // The extension missing it is exactly when the server should get a turn.
    expect(store.lookups[0].status).toBe('queued');
    expect(store.lookups[0].claimedBy).toBeNull();
    expect(store.lookups[0].lastError).toMatch(/Turnstile/);
  });

  it('gives up after the attempt budget', async () => {
    const profile = seedProfile();
    await enqueueLookups(USER, [profile.id]);

    for (let i = 0; i < EMAIL_LOOKUP_MAX_ATTEMPTS; i += 1) {
      const [item] = await claimLookups(USER, 1, 'extension');
      await completeLookup(USER, item.lookupId, { ok: false, error: 'miss' });
    }

    expect(store.lookups[0].status).toBe('failed');
    expect(await claimLookups(USER, 1, 'extension')).toHaveLength(0);
  });

  it('rejects a lookup belonging to another user', async () => {
    const profile = seedProfile();
    await enqueueLookups(USER, [profile.id]);
    const [item] = await claimLookups(USER, 1, 'extension');

    await expect(
      completeLookup('someone-else', item.lookupId, {
        ok: true,
        email: 'attacker@evil.com',
        source: 'mailmeteor',
      }),
    ).rejects.toThrow(/not found/i);

    expect(profile.email).toBeNull();
  });
});

describe('sweepStaleLookups', () => {
  it('reclaims a lease nobody reported on', async () => {
    const profile = seedProfile();
    await enqueueLookups(USER, [profile.id]);
    await claimLookups(USER, 1, 'extension');
    // A closed laptop looks exactly like this.
    store.lookups[0].dispatchedAt = new Date(Date.now() - 60 * 60 * 1000);

    const reclaimed = await sweepStaleLookups();

    expect(reclaimed).toBe(1);
    expect(store.lookups[0].status).toBe('queued');
  });

  it('leaves a fresh lease alone', async () => {
    const profile = seedProfile();
    await enqueueLookups(USER, [profile.id]);
    await claimLookups(USER, 1, 'extension');

    expect(await sweepStaleLookups()).toBe(0);
    expect(store.lookups[0].status).toBe('dispatched');
  });

  // The whole point of a durable queue: closing the laptop is not an answer
  // about the address, so it must not spend one of the three tries. It used to,
  // and three interruptions retired a row as `failed` having never once run a
  // lookup on it.
  it('gives the attempt back, because a lost lease was never an attempt', async () => {
    const profile = seedProfile();
    await enqueueLookups(USER, [profile.id]);
    await claimLookups(USER, 1, 'extension');
    expect(store.lookups[0].attempts).toBe(1);

    store.lookups[0].dispatchedAt = new Date(Date.now() - 60 * 60 * 1000);
    await sweepStaleLookups();

    expect(store.lookups[0].attempts).toBe(0);
    expect(store.lookups[0].reclaims).toBe(1);
    expect(store.lookups[0].status).toBe('queued');
  });

  it('survives more interruptions than it has attempts', async () => {
    const profile = seedProfile();
    await enqueueLookups(USER, [profile.id]);

    // One more closed laptop than the attempt budget would have tolerated.
    for (let i = 0; i < EMAIL_LOOKUP_MAX_ATTEMPTS + 1; i += 1) {
      await claimLookups(USER, 1, 'extension');
      store.lookups[0].dispatchedAt = new Date(Date.now() - 60 * 60 * 1000);
      await sweepStaleLookups();
    }

    expect(store.lookups[0].status).toBe('queued');
    expect((await getLookupStats(USER)).pending).toBe(1);
  });

  it('stops re-queueing a row that keeps killing its executor', async () => {
    const profile = seedProfile();
    await enqueueLookups(USER, [profile.id]);

    for (let i = 0; i < EMAIL_LOOKUP_MAX_RECLAIMS; i += 1) {
      await claimLookups(USER, 1, 'extension');
      store.lookups[0].dispatchedAt = new Date(Date.now() - 60 * 60 * 1000);
      await sweepStaleLookups();
    }

    expect(store.lookups[0].status).toBe('failed');
    expect((await getLookupStats(USER)).pending).toBe(0);
  });

  // `claimLookups` skips rows at the ceiling, so a queued one there can never be
  // worked and never completes — it would sit in `pending` forever and the
  // dashboard would render a lookup that nothing is running.
  it('retires a queued row no executor is allowed to claim', async () => {
    const profile = seedProfile();
    await enqueueLookups(USER, [profile.id]);
    store.lookups[0].attempts = EMAIL_LOOKUP_MAX_ATTEMPTS;

    const swept = await sweepStaleLookups();

    expect(swept).toBe(1);
    expect(store.lookups[0].status).toBe('failed');
    expect((await getLookupStats(USER)).pending).toBe(0);
  });
});

describe('getLookupStats', () => {
  it('reports pending as queued plus leased', async () => {
    const a = seedProfile();
    const b = seedProfile();
    await enqueueLookups(USER, [a.id, b.id]);
    await claimLookups(USER, 1, 'extension');

    const stats = await getLookupStats(USER);

    expect(stats.queued).toBe(1);
    expect(stats.dispatched).toBe(1);
    expect(stats.pending).toBe(2);
    expect(stats.total).toBe(2);
  });

  // The number the dashboard uses to stop spinning. A row waiting on a browser
  // that never turned up is still pending, but nothing is working it.
  it('counts a row past the extension grace with no fallback as stalled', async () => {
    const profile = seedProfile();
    await enqueueLookups(USER, [profile.id]);
    store.lookups[0].requestedAt = new Date(Date.now() - 60 * 60 * 1000);

    const stats = await getLookupStats(USER);

    expect(stats.pending).toBe(1);
    expect(stats.stalled).toBe(1);
  });

  it('does not call a fresh row stalled', async () => {
    const profile = seedProfile();
    await enqueueLookups(USER, [profile.id]);

    expect((await getLookupStats(USER)).stalled).toBe(0);
  });

  // The server picks these up on the next tick, so they are waiting on code,
  // not on the user opening Chrome.
  it('does not call a row stalled when the server may finish it', async () => {
    const profile = seedProfile();
    await enqueueLookups(USER, [profile.id], false, true);
    store.lookups[0].requestedAt = new Date(Date.now() - 60 * 60 * 1000);

    expect((await getLookupStats(USER)).stalled).toBe(0);
  });

  // The panel said "62 found, 11 failed" after a 39-profile run, because rows
  // are upserted and never deleted, so a per-user count is a lifetime count.
  it('counts the latest batch, not every lookup the account has run', async () => {
    const first = seedProfile();
    await enqueueLookups(USER, [first.id]);
    await claimLookups(USER, 1, 'extension');
    await completeLookup(USER, store.lookups[0].id, {
      ok: true,
      email: 'a@corp.com',
      source: 'mailmeteor',
    });
    // Postgres timestamps resolve to microseconds, so two presses are never
    // actually simultaneous. Two `new Date()` calls in one test are.
    store.lookups[0].requestedAt = new Date(Date.now() - 60 * 60 * 1000);

    const second = seedProfile();
    await enqueueLookups(USER, [second.id]);

    const stats = await getLookupStats(USER);

    expect(stats.total).toBe(1);
    expect(stats.done).toBe(0);
    expect(stats.pending).toBe(1);
  });

  // Dropping an older batch that still has rows in flight would hide lookups
  // that are genuinely running.
  it('keeps an older batch in scope while it still has work', async () => {
    const first = seedProfile();
    await enqueueLookups(USER, [first.id]);

    const second = seedProfile();
    await enqueueLookups(USER, [second.id]);

    const stats = await getLookupStats(USER);

    expect(stats.total).toBe(2);
    expect(stats.pending).toBe(2);
  });

  // What the dashboard keys its "dismiss" on: a new batch must not be hidden by
  // a panel the user closed on the previous one.
  it('reports the current batch id, and a new one per press', async () => {
    const profile = seedProfile();
    const first = await enqueueLookups(USER, [profile.id]);
    expect((await getLookupStats(USER)).batchId).toBe(first.batchId);

    store.lookups[0].requestedAt = new Date(Date.now() - 60 * 60 * 1000);

    const other = seedProfile();
    const second = await enqueueLookups(USER, [other.id]);

    expect(second.batchId).not.toBe(first.batchId);
    expect((await getLookupStats(USER)).batchId).toBe(second.batchId);
  });
});

describe('cancelQueuedLookups', () => {
  it('drops waiting rows but not work already in flight', async () => {
    const a = seedProfile();
    const b = seedProfile();
    await enqueueLookups(USER, [a.id, b.id]);
    await claimLookups(USER, 1, 'extension');

    const cancelled = await cancelQueuedLookups(USER);

    expect(cancelled).toBe(1);
    expect(store.lookups).toHaveLength(1);
    expect(store.lookups[0].status).toBe('dispatched');
  });
});
