import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Deletion has three invariants worth pinning, and all three are things that
 * fail silently rather than loudly:
 *
 *  1. **A run's profiles go with it.** `OutreachLog.searchJobId` is a plain
 *     column, so deleting a `SearchJob` cascades none of it. Get this wrong and
 *     Results keeps showing people belonging to a run that no longer exists.
 *  2. **A profile two runs found survives losing one.** The orphan test is "no
 *     outreach logs remain", not "we just deleted a log".
 *  3. **The pipeline rows are matched by `publicIdentifier`, not by slug.**
 *     `ProfileUrl.url` holds the Voyager `fsd_profile` urn and
 *     `Profile.profileId` holds the vanity slug, so a slug-to-slug comparison
 *     matches nothing on a normally collected run — and the delete would look
 *     like it worked while leaving every scrape behind.
 */

const db = vi.hoisted(() => ({
  searchJob: { findMany: vi.fn(), deleteMany: vi.fn(), updateMany: vi.fn() },
  outreachLog: { findMany: vi.fn(), deleteMany: vi.fn() },
  profileUrl: { findMany: vi.fn(), count: vi.fn(), deleteMany: vi.fn() },
  scrapedProfile: { count: vi.fn() },
  profileDecision: { count: vi.fn() },
  jobEvent: { count: vi.fn() },
  profile: { findMany: vi.fn(), deleteMany: vi.fn() },
  emailLookup: { count: vi.fn() },
  company: { deleteMany: vi.fn() },
  campaignContact: { findMany: vi.fn(), deleteMany: vi.fn(), count: vi.fn() },
  campaign: { update: vi.fn() },
  $queryRaw: vi.fn(),
}));

const forgetJobs = vi.hoisted(() => vi.fn());
const getSocketId = vi.hoisted(() => vi.fn().mockReturnValue(null));

vi.mock('../lib/prisma.js', () => ({ prisma: db }));
vi.mock('@prisma/client', () => ({ Prisma: { join: vi.fn() } }));
vi.mock('../workers/qualificationWorker.js', () => ({
  QualificationWorker: { getInstance: () => ({ forgetJobs }) },
}));
vi.mock('../ws-gateway/connectionRegistry.js', () => ({
  ConnectionRegistry: {
    getInstance: () => ({ getSocketId, deregister: vi.fn() }),
  },
}));
vi.mock('../ws-gateway/index.js', () => ({ getIo: vi.fn() }));
vi.mock('../ws-gateway/events.js', () => ({
  ServerCommands: { STOP_LIMIT_REACHED: 'STOP_LIMIT_REACHED' },
}));

const { deleteRuns, deleteProfiles } =
  await import('./dataDeletion.service.js');

beforeEach(() => {
  vi.clearAllMocks();

  db.searchJob.findMany.mockResolvedValue([
    { id: 'job-1', status: 'completed' },
  ]);
  db.searchJob.deleteMany.mockResolvedValue({ count: 1 });
  db.searchJob.updateMany.mockResolvedValue({ count: 0 });
  db.outreachLog.deleteMany.mockResolvedValue({ count: 3 });
  db.profileUrl.findMany.mockResolvedValue([]);
  db.profileUrl.count.mockResolvedValue(369);
  db.profileUrl.deleteMany.mockResolvedValue({ count: 0 });
  db.scrapedProfile.count.mockResolvedValue(347);
  db.profileDecision.count.mockResolvedValue(347);
  db.jobEvent.count.mockResolvedValue(22);
  db.profile.findMany.mockResolvedValue([]);
  db.profile.deleteMany.mockResolvedValue({ count: 0 });
  db.emailLookup.count.mockResolvedValue(0);
  db.company.deleteMany.mockResolvedValue({ count: 0 });
  db.campaignContact.findMany.mockResolvedValue([]);
  db.campaignContact.deleteMany.mockResolvedValue({ count: 0 });
  db.campaignContact.count.mockResolvedValue(0);
  db.$queryRaw.mockResolvedValue([]);
});

describe('deleteRuns', () => {
  it('deletes the outreach logs the SearchJob cascade cannot reach', async () => {
    db.outreachLog.findMany.mockResolvedValue([]);

    await deleteRuns('user-1', ['job-1']);

    expect(db.outreachLog.deleteMany).toHaveBeenCalledWith({
      where: { userId: 'user-1', searchJobId: { in: ['job-1'] } },
    });
    expect(db.searchJob.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ['job-1'] } },
    });
  });

  it('deletes a profile the run published and nothing else links to', async () => {
    // Published by the run…
    db.outreachLog.findMany
      .mockResolvedValueOnce([{ profileId: 'p-1' }])
      // …and after the logs go, nothing links to it.
      .mockResolvedValueOnce([]);
    db.profile.findMany.mockResolvedValue([]);
    db.profile.deleteMany.mockResolvedValue({ count: 1 });

    const summary = await deleteRuns('user-1', ['job-1']);

    expect(db.profile.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ['p-1'] } },
    });
    expect(summary.profiles).toBe(1);
  });

  it('keeps a profile another run still links to', async () => {
    db.outreachLog.findMany
      .mockResolvedValueOnce([{ profileId: 'p-1' }])
      // A second run's log row survives, so this person is not an orphan.
      .mockResolvedValueOnce([{ profileId: 'p-1' }]);

    const summary = await deleteRuns('user-1', ['job-1']);

    expect(db.profile.deleteMany).not.toHaveBeenCalled();
    expect(summary.profiles).toBe(0);
  });

  it('drops the deleted run from the qualification queue', async () => {
    db.outreachLog.findMany.mockResolvedValue([]);

    await deleteRuns('user-1', ['job-1']);

    expect(forgetJobs).toHaveBeenCalledWith(['job-1']);
  });

  it('refuses ids that are not this user’s', async () => {
    db.searchJob.findMany.mockResolvedValue([]);

    await expect(deleteRuns('user-1', ['someone-elses-job'])).rejects.toThrow(
      /No matching runs/,
    );
    expect(db.searchJob.deleteMany).not.toHaveBeenCalled();
  });

  // Deleting mid-flight is a race nothing can win: a Voyager call already in
  // the air lands on a jobId that no longer exists, and every worker mid-write
  // ends as a foreign-key error.
  it.each(['initializing', 'collecting_urls', 'scraping'])(
    'refuses a run that is %s',
    async (status) => {
      db.searchJob.findMany.mockResolvedValue([{ id: 'job-1', status }]);

      await expect(deleteRuns('user-1', ['job-1'])).rejects.toThrow(
        /Pause or cancel/,
      );
      expect(db.searchJob.deleteMany).not.toHaveBeenCalled();
      expect(db.outreachLog.deleteMany).not.toHaveBeenCalled();
    },
  );

  it('refuses the whole selection if any one run is working', async () => {
    db.searchJob.findMany.mockResolvedValue([
      { id: 'job-1', status: 'completed' },
      { id: 'job-2', status: 'scraping' },
    ]);

    // A partial delete is the worst outcome available — a success message, some
    // runs still there, and nothing saying which.
    await expect(deleteRuns('user-1', ['job-1', 'job-2'])).rejects.toThrow(
      /still working/,
    );
    expect(db.searchJob.deleteMany).not.toHaveBeenCalled();
  });

  it.each(['paused_error', 'paused_session', 'completed'])(
    'allows a run that is %s',
    async (status) => {
      db.searchJob.findMany.mockResolvedValue([{ id: 'job-1', status }]);
      db.outreachLog.findMany.mockResolvedValue([]);

      await expect(deleteRuns('user-1', ['job-1'])).resolves.toBeDefined();
      expect(db.searchJob.deleteMany).toHaveBeenCalled();
    },
  );
});

describe('deleteProfiles', () => {
  beforeEach(() => {
    db.profile.findMany.mockResolvedValue([
      {
        id: 'p-1',
        profileId: 'jane-doe',
        linkedinUrl: 'https://www.linkedin.com/in/jane-doe/',
      },
    ]);
    db.outreachLog.findMany.mockResolvedValue([]);
  });

  it('matches the collected URL by publicIdentifier, not by its urn', async () => {
    // What a people-search result actually produces: the urn, not the slug.
    db.profileUrl.findMany.mockResolvedValue([
      { id: 'url-1', url: 'https://www.linkedin.com/in/ACoAAB123/' },
      { id: 'url-2', url: 'https://www.linkedin.com/in/someone-else/' },
    ]);
    db.$queryRaw.mockResolvedValue([
      { profileUrlId: 'url-1', slug: 'jane-doe' },
      { profileUrlId: 'url-2', slug: 'someone-else' },
    ]);
    db.profileUrl.deleteMany.mockResolvedValue({ count: 1 });

    await deleteProfiles('user-1', ['p-1'], 'job-1');

    // url-1 only. Slug-to-slug comparison would have matched neither.
    expect(db.profileUrl.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ['url-1'] } },
    });
  });

  it('scopes the log delete to one run when a jobId is given', async () => {
    await deleteProfiles('user-1', ['p-1'], 'job-1');

    expect(db.outreachLog.deleteMany).toHaveBeenCalledWith({
      where: {
        userId: 'user-1',
        profileId: { in: ['p-1'] },
        searchJobId: 'job-1',
      },
    });
  });

  it('sweeps every run of the user’s when no jobId is given', async () => {
    await deleteProfiles('user-1', ['p-1']);

    expect(db.outreachLog.deleteMany).toHaveBeenCalledWith({
      where: { userId: 'user-1', profileId: { in: ['p-1'] } },
    });
  });

  it('recomputes qualifiedCount rather than decrementing it', async () => {
    db.profileDecision.count.mockResolvedValue(7);

    await deleteProfiles('user-1', ['p-1'], 'job-1');

    expect(db.searchJob.updateMany).toHaveBeenCalledWith({
      where: { id: 'job-1', qualifiedCount: { not: 7 } },
      data: { qualifiedCount: 7 },
    });
  });

  it('cancels queued sends but keeps mail already sent', async () => {
    db.outreachLog.findMany.mockResolvedValue([]);
    db.campaignContact.findMany.mockResolvedValue([
      { id: 'c-1', campaignId: 'camp-1' },
      { id: 'c-2', campaignId: 'camp-1' },
    ]);
    db.campaignContact.deleteMany.mockResolvedValue({ count: 2 });
    // What is left after the pending rows go: real send records.
    db.campaignContact.count.mockResolvedValue(1);

    const summary = await deleteProfiles('user-1', ['p-1']);

    expect(db.campaignContact.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { profileId: { in: ['p-1'] }, status: 'PENDING' },
      }),
    );
    // The campaign's denormalised total has to follow, or it claims contacts
    // that are gone.
    expect(db.campaign.update).toHaveBeenCalledWith({
      where: { id: 'camp-1' },
      data: { totalContacts: { decrement: 2 } },
    });
    expect(summary.campaignContactsRemoved).toBe(2);
    expect(summary.campaignContactsKept).toBe(1);
  });

  it('refuses to remove a profile from a run that is still working', async () => {
    db.searchJob.findMany.mockResolvedValue([
      { id: 'job-1', status: 'scraping' },
    ]);

    await expect(deleteProfiles('user-1', ['p-1'], 'job-1')).rejects.toThrow(
      /Pause or cancel/,
    );
    expect(db.outreachLog.deleteMany).not.toHaveBeenCalled();
    expect(db.profileUrl.deleteMany).not.toHaveBeenCalled();
  });

  it('refuses an account-wide delete only when a working run holds the person', async () => {
    db.searchJob.findMany.mockResolvedValue([
      { id: 'job-1', status: 'completed' },
      { id: 'job-2', status: 'scraping' },
    ]);
    db.profileUrl.findMany.mockResolvedValue([
      { id: 'url-1', url: 'https://www.linkedin.com/in/x/', jobId: 'job-1' },
      { id: 'url-2', url: 'https://www.linkedin.com/in/y/', jobId: 'job-2' },
    ]);
    db.$queryRaw.mockResolvedValue([
      { profileUrlId: 'url-1', slug: 'jane-doe' },
      { profileUrlId: 'url-2', slug: 'jane-doe' },
    ]);

    await expect(deleteProfiles('user-1', ['p-1'])).rejects.toThrow(
      /paused or cancelled/,
    );
  });

  it('allows an account-wide delete when the working run does not hold them', async () => {
    db.searchJob.findMany.mockResolvedValue([
      { id: 'job-1', status: 'completed' },
      { id: 'job-2', status: 'scraping' },
    ]);
    db.profileUrl.findMany.mockResolvedValue([
      { id: 'url-1', url: 'https://www.linkedin.com/in/x/', jobId: 'job-1' },
      // A different person entirely — the working run is irrelevant here, and
      // blocking on it would make Results undeletable whenever anything runs.
      { id: 'url-2', url: 'https://www.linkedin.com/in/y/', jobId: 'job-2' },
    ]);
    db.$queryRaw.mockResolvedValue([
      { profileUrlId: 'url-1', slug: 'jane-doe' },
      { profileUrlId: 'url-2', slug: 'someone-else' },
    ]);
    db.profileUrl.deleteMany.mockResolvedValue({ count: 1 });

    await expect(deleteProfiles('user-1', ['p-1'])).resolves.toBeDefined();
    expect(db.profileUrl.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ['url-1'] } },
    });
  });

  it('refuses a profile that is not the user’s', async () => {
    db.profile.findMany.mockResolvedValue([]);

    await expect(deleteProfiles('user-1', ['p-9'])).rejects.toThrow(
      /No matching profiles/,
    );
    expect(db.outreachLog.deleteMany).not.toHaveBeenCalled();
  });
});
