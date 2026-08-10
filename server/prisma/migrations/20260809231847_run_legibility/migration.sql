-- AlterTable
ALTER TABLE "OutreachLog" ADD COLUMN     "searchJobId" TEXT;

-- AlterTable
ALTER TABLE "ProfileDecision" ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'rejected';

-- AlterTable
ALTER TABLE "SearchJob" ADD COLUMN     "configSnapshot" JSONB,
ADD COLUMN     "failureCode" TEXT,
ADD COLUMN     "failureDetail" TEXT;

-- AlterTable
ALTER TABLE "UserConfig" ALTER COLUMN "llmProvider" SET DEFAULT 'server',
ALTER COLUMN "llmUrl" SET DEFAULT '',
ALTER COLUMN "llmModel" SET DEFAULT '';

-- CreateTable
CREATE TABLE "JobEvent" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "level" TEXT NOT NULL DEFAULT 'info',
    "stage" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "detail" TEXT,
    "count" INTEGER NOT NULL DEFAULT 1,
    "profileRef" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "JobEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "JobEvent_jobId_at_idx" ON "JobEvent"("jobId", "at");

-- CreateIndex
CREATE UNIQUE INDEX "JobEvent_jobId_stage_code_key" ON "JobEvent"("jobId", "stage", "code");

-- CreateIndex
CREATE INDEX "OutreachLog_userId_searchJobId_idx" ON "OutreachLog"("userId", "searchJobId");

-- AddForeignKey
ALTER TABLE "JobEvent" ADD CONSTRAINT "JobEvent_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "SearchJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─── Data migration ──────────────────────────────────────────────
--
-- Changing a column default does nothing for rows that already exist, and the
-- rows that already exist are precisely the broken ones. Every account created
-- before this migration holds `ollama` + `http://localhost:11434` — an address
-- that, inside the container, is the container. Left alone they would keep
-- failing after deploy and the fix would look like it had not worked.
--
-- Only rows that still hold the old default are touched. Anyone who set a real
-- Ollama address by hand keeps it.
UPDATE "UserConfig"
SET "llmProvider" = 'server',
    "llmUrl"      = '',
    "llmModel"    = ''
WHERE "llmProvider" = 'ollama'
  AND ("llmUrl" IN ('http://localhost:11434', 'http://localhost:11434/', '')
       OR "llmUrl" IS NULL);

-- Backfill the new decision status from the boolean it supersedes. The column
-- default covers rejections; qualified rows need saying explicitly. Existing
-- rows recorded during an LLM outage stay `rejected` here — the recovery script
-- reclassifies those by reason, because only it knows which run to re-run.
UPDATE "ProfileDecision" SET "status" = 'qualified' WHERE "isQualified" = true;
