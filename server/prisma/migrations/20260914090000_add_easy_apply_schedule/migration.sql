CREATE TABLE "EasyApplySchedule" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "prompt" TEXT NOT NULL,
    "targetCount" INTEGER NOT NULL DEFAULT 20,
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "lastRunOn" TEXT,
    "lastRunAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EasyApplySchedule_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "EasyApplySchedule_userId_key" ON "EasyApplySchedule"("userId");
CREATE INDEX "EasyApplySchedule_enabled_idx" ON "EasyApplySchedule"("enabled");
ALTER TABLE "EasyApplySchedule" ADD CONSTRAINT "EasyApplySchedule_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
