import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const latestJob = await prisma.searchJob.findFirst({
    orderBy: { createdAt: 'desc' },
  });

  if (!latestJob) {
    console.log('No jobs found');
    return;
  }

  const decisionsWithEmail = await prisma.profileDecision.findMany({
    where: {
      profile: { profileUrl: { jobId: latestJob.id } },
      email: { not: null },
    },
    include: { profile: { select: { name: true } } },
  });

  console.log(`Job ID: ${latestJob.id}`);
  console.log(`Total Profiles with Email: ${decisionsWithEmail.length}`);

  decisionsWithEmail.forEach((d) => {
    console.log(`- ${d.profile.name}: ${d.email} (source: ${d.emailSource})`);
  });

  const allDecisions = await prisma.profileDecision.findMany({
    where: { profile: { profileUrl: { jobId: latestJob.id } } },
    include: { profile: { select: { name: true } } },
  });

  console.log(`\nAll Decisions for this Job (${allDecisions.length}):`);
  allDecisions.forEach((d) => {
    console.log(
      `- ${d.profile.name}: qualified=${d.isQualified}, email=${d.email || 'None'}, source=${d.emailSource || 'None'}`,
    );
  });
}

main()
  .catch((e) => console.error(e))
  .finally(() => prisma.$disconnect());
