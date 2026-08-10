// ─── Recover profiles the model never actually judged ────────────
//
// One-off, for databases written before evaluation failures were distinguished
// from rejections. Those runs recorded an unreachable model as
// `isQualified: false` with a reason of `LLM Error: fetch failed`, which is
// indistinguishable from a real rejection to every query in the system — so the
// profiles are stranded: scraped, paid for in LinkedIn calls, and never judged.
//
// On the VM this is 368 rows from one Siemens run on 2026-08-09.
//
// This reclassifies them to `status: 'error'`. It does **not** re-evaluate
// anything itself: `POST /api/jobs/:id/resume` already deletes error decisions
// and re-runs the qualification sweep, and doing it in one place means the
// recovery path is the same one every future run uses.
//
// **No LinkedIn calls are involved.** The raw profile data is still in
// `ScrapedProfile`; only the verdict is missing.
//
//   docker exec cc-server node dist/scratch-recover-unevaluated.js            # dry run
//   docker exec cc-server node dist/scratch-recover-unevaluated.js --apply

import { prisma } from './lib/prisma.js';
import { logger } from './lib/logger.js';

/** How the old code wrote an evaluation failure into a rejection. */
const LEGACY_FAILURE_PREFIXES = ['LLM Error:', 'Evaluation error:'];

export interface RecoveryReport {
  applied: boolean;
  reclassified: number;
  byJob: Array<{
    jobId: string;
    jobStatus: string;
    profiles: number;
  }>;
}

export async function recoverUnevaluated(
  apply: boolean,
): Promise<RecoveryReport> {
  const candidates = await prisma.profileDecision.findMany({
    where: {
      status: 'rejected',
      isQualified: false,
      OR: LEGACY_FAILURE_PREFIXES.map((prefix) => ({
        qualificationReason: { startsWith: prefix },
      })),
    },
    select: {
      id: true,
      profile: { select: { profileUrl: { select: { jobId: true } } } },
    },
  });

  const perJob = new Map<string, number>();
  for (const decision of candidates) {
    const jobId = decision.profile?.profileUrl?.jobId;
    if (!jobId) continue;
    perJob.set(jobId, (perJob.get(jobId) ?? 0) + 1);
  }

  const jobs = await prisma.searchJob.findMany({
    where: { id: { in: [...perJob.keys()] } },
    select: { id: true, status: true },
  });

  const byJob = jobs.map((job) => ({
    jobId: job.id,
    jobStatus: job.status,
    profiles: perJob.get(job.id) ?? 0,
  }));

  if (!apply) {
    return { applied: false, reclassified: candidates.length, byJob };
  }

  const { count } = await prisma.profileDecision.updateMany({
    where: { id: { in: candidates.map((d) => d.id) } },
    data: { status: 'error' },
  });

  // Park each affected run so Resume is the obvious next action. A run left in
  // `completed` cannot be resumed, and these runs never completed in any
  // meaningful sense — they produced nothing.
  for (const job of jobs) {
    await prisma.searchJob.update({
      where: { id: job.id },
      data: {
        status: 'paused_error',
        failureCode: 'LLM_UNREACHABLE',
        failureDetail:
          'The AI model was unreachable for every profile in this run. Resume to judge them — no LinkedIn calls are needed.',
      },
    });
  }

  logger.info(
    `[Recovery] Reclassified ${count} decision(s) across ${jobs.length} run(s)`,
  );

  return { applied: true, reclassified: count, byJob };
}

// Guarded so importing this in a test does not run it.
if (import.meta.url === `file://${process.argv[1]}`) {
  const apply = process.argv.includes('--apply');

  recoverUnevaluated(apply)
    .then(async (report) => {
      console.log(JSON.stringify(report, null, 2));
      if (!report.applied) {
        console.log(
          '\nDry run. Re-run with --apply, then press Resume on each run in the dashboard.',
        );
      }
      await prisma.$disconnect();
    })
    .catch(async (err) => {
      logger.error(err, '[Recovery] Failed');
      await prisma.$disconnect();
      process.exit(1);
    });
}
