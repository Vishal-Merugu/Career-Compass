import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const latestJob = await prisma.searchJob.findFirst({
    orderBy: { createdAt: 'desc' },
  });

  const config = await prisma.userConfig.findFirst({
    where: { userId: latestJob!.userId },
  });

  console.log('User Config:');
  console.log(config);
}

main()
  .catch((e) => console.error(e))
  .finally(() => prisma.$disconnect());
