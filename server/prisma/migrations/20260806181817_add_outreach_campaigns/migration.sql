-- AlterTable
ALTER TABLE "UserConfig" ADD COLUMN     "emailSignature" TEXT,
ADD COLUMN     "smtpFromName" TEXT,
ADD COLUMN     "smtpPassword" TEXT,
ADD COLUMN     "smtpUser" TEXT;

-- CreateTable
CREATE TABLE "Campaign" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "emailSubject" TEXT NOT NULL,
    "fromName" TEXT,
    "commonPrompt" TEXT,
    "minDelayMs" INTEGER NOT NULL DEFAULT 5000,
    "maxDelayMs" INTEGER NOT NULL DEFAULT 10000,
    "resumeFileName" TEXT,
    "resumeFilePath" TEXT,
    "totalContacts" INTEGER NOT NULL DEFAULT 0,
    "sentCount" INTEGER NOT NULL DEFAULT 0,
    "failedCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "Campaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CampaignContact" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "profileId" TEXT,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "companyName" TEXT,
    "description" TEXT,
    "customSubject" TEXT,
    "customBody" TEXT,
    "sentSubject" TEXT,
    "sentBody" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "errorMessage" TEXT,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CampaignContact_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Campaign_userId_createdAt_idx" ON "Campaign"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "CampaignContact_campaignId_status_idx" ON "CampaignContact"("campaignId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "CampaignContact_campaignId_profileId_key" ON "CampaignContact"("campaignId", "profileId");

-- AddForeignKey
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignContact" ADD CONSTRAINT "CampaignContact_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignContact" ADD CONSTRAINT "CampaignContact_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "Profile"("id") ON DELETE SET NULL ON UPDATE CASCADE;
