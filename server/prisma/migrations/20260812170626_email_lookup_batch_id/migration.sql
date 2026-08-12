-- AlterTable
ALTER TABLE "EmailLookup" ADD COLUMN     "batchId" TEXT;

-- CreateIndex
CREATE INDEX "EmailLookup_userId_batchId_idx" ON "EmailLookup"("userId", "batchId");
