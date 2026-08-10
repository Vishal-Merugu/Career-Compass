// ─── Profile publisher ───────────────────────────────────────────
//
// Copies a qualified profile out of the job-scoped pipeline tables into the
// user-facing one.
//
// `ScrapedProfile` and `ProfileDecision` are keyed by **job**, and nothing
// outside the job itself reads them. Everything the user sees hangs off
// `Profile`: `GET /api/profiles` scopes rows by `outreachLogs.some.userId`, and
// `CampaignContact` has a foreign key to `Profile.id`.
//
// Nothing bridged the two — `upsertProfile` existed with zero callers — so a
// finished run left the Results screen empty and its profiles unreachable from
// a campaign. This is the bridge, shared by the qualification worker (at
// decision time) and the backfill script (for runs that finished before it
// existed), so the two cannot drift.

import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { PrismaStorageAdapter } from './storage.adapter.js';

export interface PublishableProfile {
  /** LinkedIn vanity slug. The stable key; see below. */
  slug: string;
  linkedinUrl: string;
  firstName: string;
  lastName: string;
  headline: string | null;
  about: string | null;
  location: string | null;
  companyName: string;
  rawProfileJson: unknown;
  email: string | null;
  emailSource: string | null;
  emailValidation: string | null;
  qualificationReason: string;
  /** The run that found them. Null for the backfill, which cannot know. */
  searchJobId?: string | null;
}

/**
 * Publish one qualified profile, returning whether it landed.
 *
 * The `OutreachLog` row is not bookkeeping — it is what scopes the profile to
 * the user. Skip it and the profile exists but is invisible to every screen.
 *
 * Failure is logged, not thrown: the caller has already recorded its decision
 * and a publish failure must not fail a run or abort a backfill mid-way.
 */
export async function publishQualifiedProfile(
  userId: string,
  data: PublishableProfile,
): Promise<boolean> {
  // `Profile.profileId` is unique and is what `addOutreachLog` looks the row up
  // by, so it must be stable and present. The vanity slug is the natural key —
  // it is also what the mass-connector path uses, so a profile seen by both
  // routes is one row rather than two.
  const profileId = data.slug || data.linkedinUrl;

  if (!profileId) {
    logger.warn(
      `[ProfilePublisher] No stable key for ${data.firstName} ${data.lastName} — not published`,
    );
    return false;
  }

  try {
    const storageAdapter = new PrismaStorageAdapter(userId);

    await storageAdapter.upsertProfile({
      profileId,
      firstName: data.firstName,
      lastName: data.lastName,
      headline: data.headline,
      about: data.about,
      location: data.location,
      linkedinUrl: data.linkedinUrl,
      email: data.email,
      emailSource: data.emailSource,
      emailValidation: data.emailValidation,
      companyName: data.companyName || null,
      rawProfileJson: data.rawProfileJson,
    });

    // Idempotent: a backfill re-run, or a profile re-qualified by a later job,
    // must not stack duplicate log rows. `GET /api/profiles` only needs one to
    // exist.
    const row = await prisma.profile.findUnique({
      where: { profileId },
      select: { id: true },
    });

    if (row) {
      const existing = await prisma.outreachLog.findFirst({
        where: { userId, profileId: row.id, action: 'qualified' },
        select: { id: true },
      });

      if (!existing) {
        await storageAdapter.addOutreachLog(
          'qualified',
          'success',
          { source: 'searchJob', emailSource: data.emailSource },
          profileId,
          data.qualificationReason,
          data.searchJobId ?? undefined,
        );
      }
    }

    return true;
  } catch (err) {
    logger.error(
      err,
      `[ProfilePublisher] Failed publishing ${data.firstName} ${data.lastName}`,
    );
    return false;
  }
}

/**
 * The vanity slug in a LinkedIn profile URL — `.../in/<slug>/…` → `<slug>`.
 *
 * Exported because deletion has to run it *backwards*: `Profile` is keyed by
 * slug and `ProfileUrl` holds the raw collected URL, so mapping a person back
 * to the pipeline rows that produced them means deriving the slug from the URL
 * with exactly this rule. Two implementations of it would mean a delete that
 * silently leaves the scrape behind.
 */
export function slugFromUrl(profileUrl: string): string {
  return profileUrl.split('/in/')[1]?.split(/[/?#]/)[0] ?? '';
}

/**
 * Derive the vanity slug from a scraped profile.
 *
 * Prefers the `publicIdentifier` in the raw Voyager payload and falls back to
 * parsing the URL, because an internal member id in the URL would produce a key
 * the mass-connector path never generates — the same person as two rows.
 */
export function slugFromScraped(rawData: unknown, profileUrl: string): string {
  const raw = rawData as { publicIdentifier?: unknown } | null;
  const fromRaw =
    raw && typeof raw.publicIdentifier === 'string' ? raw.publicIdentifier : '';
  if (fromRaw) return fromRaw;
  return slugFromUrl(profileUrl);
}
