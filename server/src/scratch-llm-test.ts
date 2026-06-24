import { PrismaClient } from '@prisma/client';
import { evaluateProfile } from './shared/llmClient.js';
import { IParsedProfile } from './shared/parsers.js';

const prisma = new PrismaClient();

async function main() {
  const latestJob = await prisma.searchJob.findFirst({
    orderBy: { createdAt: 'desc' },
  });

  const configFromDb = await prisma.userConfig.findFirst({
    where: { userId: latestJob!.userId },
  });

  const scrapedProfile = await prisma.scrapedProfile.findFirst({
    where: { profileUrl: { jobId: latestJob!.id } },
    include: { profileUrl: true },
  });

  if (!scrapedProfile || !configFromDb) {
    console.log('Missing profile or config');
    return;
  }

  const raw = scrapedProfile.rawData as any;
  const nameParts = (scrapedProfile.name || '').trim().split(' ');
  const firstName = nameParts[0] || '';
  const lastName = nameParts.slice(1).join(' ') || '';

  const parsedProfile: IParsedProfile = {
    firstName,
    lastName,
    headline: scrapedProfile.headline || '',
    about: raw.summary || '',
    experiences: (raw.experience || []).map((exp: any) => ({
      title: exp.title || '',
      companyName: exp.company || exp.companyName || '',
      description: exp.description || '',
    })),
    education: [],
    skills: raw.skills || [],
    location: scrapedProfile.location || '',
    publicIdentifier: '',
  };

  const targetCompany = parsedProfile.experiences[0]?.companyName || '';
  const criteriaPrompt =
    'Evaluate if the profile represents an engineering manager, tech lead, software engineering director, software developer, recruiter, talent acquisition specialist, or co-founder. Reject entry level graduates.';

  console.log(`Evaluating ${scrapedProfile.name}...`);
  console.log(`Using LLM URL from DB: ${configFromDb.llmUrl}`);

  const result = await evaluateProfile(
    parsedProfile,
    criteriaPrompt,
    configFromDb,
    targetCompany,
  );
  console.log('Evaluation Result:', result);
}

main()
  .catch((e) => console.error(e))
  .finally(() => prisma.$disconnect());
