-- AlterTable
ALTER TABLE "UserConfig" ADD COLUMN     "linkFinderApiKey" TEXT,
ADD COLUMN     "linkFinderPausedAt" TIMESTAMP(3),
ADD COLUMN     "linkFinderPauseCode" TEXT,
ADD COLUMN     "linkFinderPauseDetail" TEXT;

-- AlterTable
ALTER TABLE "EmailLookup" ADD COLUMN     "pendingHandoff" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "EmailLookup_userId_pendingHandoff_idx" ON "EmailLookup"("userId", "pendingHandoff");
