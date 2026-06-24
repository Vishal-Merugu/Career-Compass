import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const latestJob = await prisma.searchJob.findFirst({
    orderBy: { createdAt: 'desc' },
  });

  const decisions = await prisma.profileDecision.findMany({
    where: { profile: { profileUrl: { jobId: latestJob!.id } } },
    include: {
      profile: {
        select: { name: true, profileUrl: { select: { url: true } } },
      },
    },
  });

  console.log('Decisions for the latest job:');
  decisions.forEach((d) => {
    console.log(
      `- ${d.profile.name}: qualified=${d.isQualified}, reason=${d.qualificationReason}, emailSource=${d.emailSource}`,
    );
  });
}

main()
  .catch((e) => console.error(e))
  .finally(() => prisma.$disconnect());
