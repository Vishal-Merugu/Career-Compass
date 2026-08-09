// ─── Backfill: publish already-qualified profiles into `Profile` ──
//
// One-off repair for runs that finished before `publishQualifiedProfile`
// existed. Those runs wrote `ScrapedProfile` + `ProfileDecision` and nothing
// else, so their profiles never reached the table the dashboard reads
// (`GET /api/profiles` scopes by `outreachLogs.some.userId`) and could not be
// added to a campaign (`CampaignContact` FKs to `Profile.id`).
//
// The fix in `qualificationWorker` only runs at decision time, so it does
// nothing for decisions already in the database. Hence this.
//
// Safe to re-run: `publishQualifiedProfile` upserts by LinkedIn vanity slug and
// will not stack duplicate `OutreachLog` rows. It is also the *same* function
// the worker calls, so a backfilled profile is identical to a freshly published
// one rather than a second interpretation of the same data.
//
// Reads and writes only — it never deletes and never overwrites an email that
// is already stored (see `upsertProfile`, which ignores nullish fields on
// update).
//
//   cd server && npx tsx src/scratch-backfill-profiles.ts --dry-run
//   cd server && npx tsx src/scratch-backfill-profiles.ts

import { prisma } from './lib/prisma.js';
import { logger } from './lib/logger.js';
import {
  publishQualifiedProfile,
  slugFromScraped,
} from './services/profilePublisher.service.js';

interface RawScraped {
  summary?: unknown;
  experience?: Array<{ company?: unknown; companyName?: unknown }>;
}

/** Same precedence the qualification worker uses, so keys match. */
function companyOf(company: string | null, rawData: unknown): string {
  if (company) return company;
  const raw = rawData as RawScraped | null;
  const first = raw?.experience?.[0];
  if (!first) return '';
  if (typeof first.company === 'string') return first.company;
  if (typeof first.companyName === 'string') return first.companyName;
  return '';
}

function aboutOf(about: string | null, rawData: unknown): string | null {
  if (about) return about;
  const raw = rawData as RawScraped | null;
  return typeof raw?.summary === 'string' ? raw.summary : null;
}

export async function backfillProfiles(dryRun: boolean): Promise<{
  considered: number;
  published: number;
  skipped: number;
}> {
  // Qualified decisions only. A rejected profile was deliberately not a
  // candidate, and publishing it would put it on Results as if it were one.
  const decisions = await prisma.profileDecision.findMany({
    where: { isQualified: true },
    orderBy: { decidedAt: 'asc' },
    include: {
      profile: {
        include: {
          profileUrl: { include: { job: { select: { userId: true } } } },
        },
      },
    },
  });

  logger.info(
    `[Backfill] ${decisions.length} qualified decision(s) to consider${dryRun ? ' (dry run)' : ''}`,
  );

  let published = 0;
  let skipped = 0;

  for (const decision of decisions) {
    const scraped = decision.profile;
    const userId = scraped.profileUrl.job.userId;

    const nameParts = (scraped.name || '').trim().split(' ');
    const firstName = nameParts[0] || '';
    const lastName = nameParts.slice(1).join(' ') || '';

    if (!firstName) {
      logger.warn(
        `[Backfill] Decision ${decision.id} has no usable name — skipping`,
      );
      skipped += 1;
      continue;
    }

    const slug = slugFromScraped(scraped.rawData, scraped.profileUrl.url);
    const linkedinUrl = slug
      ? `https://www.linkedin.com/in/${slug}/`
      : scraped.profileUrl.url;

    if (dryRun) {
      logger.info(
        `[Backfill] would publish ${firstName} ${lastName} (${slug || linkedinUrl}) email=${decision.email ?? 'none'} source=${decision.emailSource ?? 'none'}`,
      );
      published += 1;
      continue;
    }

    const ok = await publishQualifiedProfile(userId, {
      slug,
      linkedinUrl,
      firstName,
      lastName,
      headline: scraped.headline,
      about: aboutOf(scraped.about, scraped.rawData),
      location: scraped.location,
      companyName: companyOf(scraped.company, scraped.rawData),
      rawProfileJson: scraped.rawData,
      email: decision.email,
      emailSource: decision.emailSource,
      // Historical decisions never recorded a validation verdict; the column
      // only exists on `Profile`. Leave it unset rather than inventing one — a
      // fabricated "valid" is exactly the claim outreach must not trust.
      emailValidation: null,
      qualificationReason:
        decision.qualificationReason ?? 'Qualified (backfilled)',
    });

    if (ok) published += 1;
    else skipped += 1;
  }

  logger.info(
    `[Backfill] Done — ${published} published, ${skipped} skipped, ${decisions.length} considered`,
  );

  return { considered: decisions.length, published, skipped };
}

// Guarded so importing this in a test does not run it.
if (import.meta.url === `file://${process.argv[1]}`) {
  const dryRun = process.argv.includes('--dry-run');

  backfillProfiles(dryRun)
    .then(async (result) => {
      console.log(JSON.stringify(result, null, 2));
      await prisma.$disconnect();
    })
    .catch(async (err) => {
      logger.error(err, '[Backfill] Failed');
      await prisma.$disconnect();
      process.exit(1);
    });
}
