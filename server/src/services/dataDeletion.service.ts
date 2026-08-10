// ─── Deleting a run, or one person out of a run ──────────────────
//
// "Delete" here means *gone*, not hidden and not orphaned. That is a stronger
// promise than it sounds, because the pipeline deliberately writes a person
// into two unrelated halves of the schema:
//
//   SearchJob → ProfileUrl → ScrapedProfile → ProfileDecision   (per run)
//   Profile ← OutreachLog → User                                (per person)
//
// Only the first half cascades. `OutreachLog.searchJobId` is a plain column
// precisely so a run's deletion cannot erase the record that we found — or
// mailed — someone, which means deleting a `SearchJob` on its own leaves every
// profile it published sitting on Results, attached to a run that no longer
// exists. That is the junk this module exists to clear.
//
// What is deliberately NOT deleted:
//
//   * A `Profile` another run or another user still links to. The orphan test
//     is "no `OutreachLog` rows remain at all", so a person found twice
//     survives losing one of the two runs.
//   * A `CampaignContact` that was already sent. It carries the subject and
//     body of real mail that left the user's own Gmail; that is a record, not
//     a reference. Pending contacts *are* deleted — a queued email to someone
//     you have just deleted is exactly the kind of leftover that surprises
//     people later.
//
// In-memory state is cleaned too. `QualificationWorker` holds a queue keyed by
// job id and `ConnectionRegistry` holds a socket; leaving either behind means
// a deleted run keeps logging errors about rows that no longer exist.

import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { AppError, ErrorCode, NotFoundError } from '../errors/AppError.js';
import { ConnectionRegistry } from '../ws-gateway/connectionRegistry.js';
import { getIo } from '../ws-gateway/index.js';
import { ServerCommands } from '../ws-gateway/events.js';
import { QualificationWorker } from '../workers/qualificationWorker.js';
import { slugFromUrl } from './profilePublisher.service.js';

/**
 * What actually went, in the words the confirmation dialog uses.
 *
 * Returned rather than logged because a destructive action should be able to
 * tell the user what it did — "deleted" with no numbers is the same screen a
 * no-op would produce.
 */
export interface DeletionSummary {
  runs: number;
  collectedUrls: number;
  scrapedProfiles: number;
  decisions: number;
  events: number;
  outreachLogs: number;
  profiles: number;
  emailLookups: number;
  companies: number;
  /** Queued sends cancelled because their recipient is gone. */
  campaignContactsRemoved: number;
  /** Already-sent contacts kept as a record of mail that really went. */
  campaignContactsKept: number;
}

function emptySummary(): DeletionSummary {
  return {
    runs: 0,
    collectedUrls: 0,
    scrapedProfiles: 0,
    decisions: 0,
    events: 0,
    outreachLogs: 0,
    profiles: 0,
    emailLookups: 0,
    companies: 0,
    campaignContactsRemoved: 0,
    campaignContactsKept: 0,
  };
}

/**
 * Statuses in which something is actively writing rows for the run.
 *
 * A run in any of these is **refused**, not stopped-and-deleted. Deleting one
 * mid-flight is a race nothing can win: `scrapeWorker` is mid-fetch,
 * `dispatchNext` is about to insert the next batch, and a Voyager call already
 * in the air lands on a `jobId` that no longer exists. Every one of those ends
 * as a foreign-key error in the log — the exact "junk left behind" this feature
 * exists to prevent, only now it is in the wrong place to see.
 *
 * Pause and Cancel already exist, both take effect in seconds, and both leave a
 * run that deletes cleanly. Asking for one of them first is one extra click
 * against a class of failure that is otherwise invisible.
 */
const ACTIVE_STATUSES = new Set([
  'initializing',
  'collecting_urls',
  'scraping',
]);

/**
 * Release what the run still holds in process memory.
 *
 * Even a paused run can have items sitting in `QualificationWorker`'s queue and
 * a socket in `ConnectionRegistry`. Neither lives in the database, so nothing
 * about deleting rows clears them: a leftover queue item spends a round trip
 * discovering its `ScrapedProfile` is gone and then logs "not found in DB",
 * which reads like corruption and is really just a delete it was never told
 * about.
 */
function quiesceRuns(jobIds: string[]): void {
  QualificationWorker.getInstance().forgetJobs(jobIds);

  const registry = ConnectionRegistry.getInstance();
  for (const jobId of jobIds) {
    const socketId = registry.getSocketId(jobId);
    if (!socketId) continue;
    // Tell the extension to stand down before the job disappears underneath it.
    getIo().to(socketId).emit(ServerCommands.STOP_LIMIT_REACHED);
    registry.deregister(socketId);
  }
}

/**
 * Delete the `Profile` rows in `candidateIds` that nothing links to any more,
 * plus everything that hangs off them.
 *
 * Called *after* the `OutreachLog` rows have gone, because those are what the
 * orphan test reads. Splitting it that way is what makes "this person was also
 * found by another run" survive: their other log row is still there, so they
 * are not an orphan and the delete skips them.
 */
async function purgeOrphanedProfiles(
  candidateIds: string[],
): Promise<
  Pick<
    DeletionSummary,
    | 'profiles'
    | 'emailLookups'
    | 'companies'
    | 'campaignContactsRemoved'
    | 'campaignContactsKept'
  >
> {
  const result = {
    profiles: 0,
    emailLookups: 0,
    companies: 0,
    campaignContactsRemoved: 0,
    campaignContactsKept: 0,
  };

  if (candidateIds.length === 0) return result;

  const stillLinked = await prisma.outreachLog.findMany({
    where: { profileId: { in: candidateIds } },
    select: { profileId: true },
    distinct: ['profileId'],
  });
  const linked = new Set(stillLinked.map((row) => row.profileId));
  const orphans = candidateIds.filter((id) => !linked.has(id));

  if (orphans.length === 0) return result;

  // Queued mail to someone who no longer exists. Deleted rather than left with
  // a null `profileId`, and the campaign's denormalised total is corrected in
  // the same breath — a campaign claiming 40 contacts while holding 38 is the
  // sort of drift nobody ever goes looking for.
  const pending = await prisma.campaignContact.findMany({
    where: { profileId: { in: orphans }, status: 'PENDING' },
    select: { id: true, campaignId: true },
  });

  if (pending.length > 0) {
    const perCampaign = new Map<string, number>();
    for (const contact of pending) {
      perCampaign.set(
        contact.campaignId,
        (perCampaign.get(contact.campaignId) ?? 0) + 1,
      );
    }

    await prisma.campaignContact.deleteMany({
      where: { id: { in: pending.map((c) => c.id) } },
    });

    for (const [campaignId, removed] of perCampaign) {
      await prisma.campaign.update({
        where: { id: campaignId },
        data: { totalContacts: { decrement: removed } },
      });
    }
    result.campaignContactsRemoved = pending.length;
  }

  // Whatever survives is a send record. `CampaignContact.profileId` is SetNull,
  // so these keep their name, address and sent body with the link dropped.
  result.campaignContactsKept = await prisma.campaignContact.count({
    where: { profileId: { in: orphans } },
  });

  result.emailLookups = await prisma.emailLookup.count({
    where: { profileId: { in: orphans } },
  });

  const companyIds = (
    await prisma.profile.findMany({
      where: { id: { in: orphans }, companyId: { not: null } },
      select: { companyId: true },
      distinct: ['companyId'],
    })
  )
    .map((row) => row.companyId)
    .filter((id): id is string => id !== null);

  // Cascades EmailLookup; nulls CampaignContact.profileId on the survivors.
  result.profiles = (
    await prisma.profile.deleteMany({ where: { id: { in: orphans } } })
  ).count;

  // A company exists only to be a profile's employer. One with no profiles
  // left is a row nothing can ever reach again.
  if (companyIds.length > 0) {
    result.companies = (
      await prisma.company.deleteMany({
        where: { id: { in: companyIds }, profiles: { none: {} } },
      })
    ).count;
  }

  return result;
}

/**
 * Delete these runs and everything they produced.
 *
 * Ownership is checked by filtering rather than by asserting: ids belonging to
 * someone else simply do not match, so the worst a forged id can do is nothing.
 */
export async function deleteRuns(
  userId: string,
  jobIds: string[],
): Promise<DeletionSummary> {
  const jobs = await prisma.searchJob.findMany({
    where: { id: { in: jobIds }, userId },
    select: { id: true, status: true },
  });

  if (jobs.length === 0) {
    throw new NotFoundError('No matching runs to delete');
  }

  // Refuse the whole request rather than deleting the deletable ones. A partial
  // delete of a selection is the worst outcome available: the user gets a
  // success, some runs survive, and nothing says which.
  const running = jobs.filter((job) => ACTIVE_STATUSES.has(job.status));
  if (running.length > 0) {
    throw new AppError(
      running.length === 1
        ? 'This run is still working. Pause or cancel it first, then delete it.'
        : `${running.length} of these runs are still working. Pause or cancel them first, then delete them.`,
      409,
      ErrorCode.WORKFLOW_RUNNING,
      { runningJobIds: running.map((job) => job.id) },
    );
  }

  const ids = jobs.map((job) => job.id);
  quiesceRuns(ids);

  // Read who this run published before the logs that say so are deleted.
  const published = await prisma.outreachLog.findMany({
    where: { userId, searchJobId: { in: ids }, profileId: { not: null } },
    select: { profileId: true },
    distinct: ['profileId'],
  });
  const candidateProfileIds = published
    .map((row) => row.profileId)
    .filter((id): id is string => id !== null);

  const summary = emptySummary();

  const [collectedUrls, scrapedProfiles, decisions, events] = await Promise.all(
    [
      prisma.profileUrl.count({ where: { jobId: { in: ids } } }),
      prisma.scrapedProfile.count({
        where: { profileUrl: { jobId: { in: ids } } },
      }),
      prisma.profileDecision.count({
        where: { profile: { profileUrl: { jobId: { in: ids } } } },
      }),
      prisma.jobEvent.count({ where: { jobId: { in: ids } } }),
    ],
  );

  summary.collectedUrls = collectedUrls;
  summary.scrapedProfiles = scrapedProfiles;
  summary.decisions = decisions;
  summary.events = events;

  summary.outreachLogs = (
    await prisma.outreachLog.deleteMany({
      where: { userId, searchJobId: { in: ids } },
    })
  ).count;

  // Cascades ProfileUrl → ScrapedProfile → ProfileDecision, plus JobEvent and
  // ExtensionConnection.
  summary.runs = (
    await prisma.searchJob.deleteMany({ where: { id: { in: ids } } })
  ).count;

  Object.assign(summary, await purgeOrphanedProfiles(candidateProfileIds));

  logger.info({ userId, jobIds: ids, summary }, '[DataDeletion] Runs deleted');
  return summary;
}

/**
 * Delete these people — from one run, or from the account entirely.
 *
 * With `jobId`, only that run's trace of them goes: the collected URL, the
 * scrape, the decision and the log row that put them on Results *for that run*.
 * Someone a second run also found keeps their place there. Without `jobId`,
 * every run of this user's is swept, which is what "remove this person from my
 * results" has to mean if the profile is not to reappear on the next backfill.
 *
 * Both cases end in the same orphan purge, so a person with no runs left does
 * not survive as a `Profile` row nothing can reach.
 */
export async function deleteProfiles(
  userId: string,
  profileIds: string[],
  jobId?: string,
): Promise<DeletionSummary> {
  // The user's own rows only — a `Profile` is shared between accounts, and the
  // `OutreachLog` join is what makes one of them theirs.
  const profiles = await prisma.profile.findMany({
    where: {
      id: { in: profileIds },
      outreachLogs: {
        some: { userId, ...(jobId ? { searchJobId: jobId } : {}) },
      },
    },
    select: { id: true, profileId: true, linkedinUrl: true },
  });

  if (profiles.length === 0) {
    throw new NotFoundError('No matching profiles to delete');
  }

  const summary = emptySummary();
  const ids = profiles.map((p) => p.id);

  // Which runs are in scope, and therefore which counters have to be recomputed.
  const jobs = await prisma.searchJob.findMany({
    where: { userId, ...(jobId ? { id: jobId } : {}) },
    select: { id: true, status: true },
  });
  const jobIds = jobs.map((job) => job.id);
  const activeJobIds = new Set(
    jobs.filter((job) => ACTIVE_STATUSES.has(job.status)).map((job) => job.id),
  );

  // Removing someone a run is *working on* is the same race as deleting the run
  // itself: the qualification worker may be mid-evaluation, and the stop
  // condition counts the rows about to vanish. Named-run deletes are refused
  // outright; an account-wide delete refuses only if a working run actually
  // holds one of these people, which is the difference between a rule and an
  // obstruction.
  if (jobId && activeJobIds.has(jobId)) {
    throw new AppError(
      'This run is still working. Pause or cancel it first, then remove profiles from it.',
      409,
      ErrorCode.WORKFLOW_RUNNING,
      { runningJobIds: [jobId] },
    );
  }

  if (jobIds.length > 0) {
    // Mapping a person back to the run that found them is the whole difficulty
    // here, because the two tables are keyed on **different ids for the same
    // human**:
    //
    //   ProfileUrl.url   `/in/ACoAAB…/`   — the Voyager `fsd_profile` urn, which
    //                                       is all a people-search result gives
    //   Profile.profileId  `jane-doe`     — the vanity slug, taken from
    //                                       `publicIdentifier` on the full
    //                                       profile once it has been fetched
    //
    // So slug-to-slug matching finds nothing on any normally collected run.
    // The join that actually holds is `ScrapedProfile.rawData.publicIdentifier`
    // — the very field the publisher read on the way in. Projected in SQL
    // rather than loaded: `rawData` is the whole Voyager payload, and a
    // 400-profile run does not need to travel over the wire to answer "which
    // row is this person".
    const keys = new Set<string>();
    for (const p of profiles) {
      keys.add(p.profileId);
      keys.add(p.linkedinUrl);
    }

    const scraped = await prisma.$queryRaw<
      Array<{ profileUrlId: string; slug: string | null }>
    >`
      SELECT sp."profileUrlId" AS "profileUrlId",
             sp."rawData"->>'publicIdentifier' AS slug
      FROM "ScrapedProfile" sp
      JOIN "ProfileUrl" pu ON pu."id" = sp."profileUrlId"
      WHERE pu."jobId" IN (${Prisma.join(jobIds)})
    `;
    const slugByUrlId = new Map(
      scraped.map((row) => [row.profileUrlId, row.slug]),
    );

    const urls = await prisma.profileUrl.findMany({
      where: { jobId: { in: jobIds } },
      select: { id: true, url: true, jobId: true },
    });

    // Three keys, one per way a `Profile` row can have been written: the
    // publisher's `publicIdentifier`, its fallback of parsing the collected
    // URL, and the mass connector, which stores the URL verbatim.
    const matched = urls.filter((row) => {
      const scrapedSlug = slugByUrlId.get(row.id);
      return (
        (scrapedSlug !== null &&
          scrapedSlug !== undefined &&
          keys.has(scrapedSlug)) ||
        keys.has(slugFromUrl(row.url)) ||
        keys.has(row.url)
      );
    });

    const heldByRunning = [
      ...new Set(
        matched
          .filter((row) => activeJobIds.has(row.jobId))
          .map((r) => r.jobId),
      ),
    ];
    if (heldByRunning.length > 0) {
      throw new AppError(
        heldByRunning.length === 1
          ? 'A run still working on one of these profiles has to be paused or cancelled first.'
          : `${heldByRunning.length} runs still working on these profiles have to be paused or cancelled first.`,
        409,
        ErrorCode.WORKFLOW_RUNNING,
        { runningJobIds: heldByRunning },
      );
    }

    const doomed = matched.map((row) => row.id);

    if (doomed.length > 0) {
      summary.scrapedProfiles = await prisma.scrapedProfile.count({
        where: { profileUrlId: { in: doomed } },
      });
      summary.decisions = await prisma.profileDecision.count({
        where: { profile: { profileUrlId: { in: doomed } } },
      });
      // Cascades ScrapedProfile → ProfileDecision.
      summary.collectedUrls = (
        await prisma.profileUrl.deleteMany({ where: { id: { in: doomed } } })
      ).count;
    }
  }

  summary.outreachLogs = (
    await prisma.outreachLog.deleteMany({
      where: {
        userId,
        profileId: { in: ids },
        ...(jobId ? { searchJobId: jobId } : {}),
      },
    })
  ).count;

  // `qualifiedCount` is denormalised and drives both the progress bar and the
  // stop condition, so it is recomputed rather than decremented — a count that
  // drifts above the target would stop a run that has not finished.
  for (const id of jobIds) {
    const qualified = await prisma.profileDecision.count({
      where: { profile: { profileUrl: { jobId: id } }, status: 'qualified' },
    });
    await prisma.searchJob.updateMany({
      where: { id, qualifiedCount: { not: qualified } },
      data: { qualifiedCount: qualified },
    });
  }

  Object.assign(summary, await purgeOrphanedProfiles(ids));

  logger.info(
    { userId, jobId: jobId ?? null, count: ids.length, summary },
    '[DataDeletion] Profiles deleted',
  );
  return summary;
}
