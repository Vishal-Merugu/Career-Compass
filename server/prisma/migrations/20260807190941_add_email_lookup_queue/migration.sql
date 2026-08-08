-- CreateTable
CREATE TABLE "EmailLookup" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "claimedBy" TEXT,
    "email" TEXT,
    "emailSource" TEXT,
    "emailValidation" TEXT,
    "lastError" TEXT,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dispatchedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "EmailLookup_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EmailLookup_userId_status_idx" ON "EmailLookup"("userId", "status");

-- CreateIndex
CREATE INDEX "EmailLookup_status_requestedAt_idx" ON "EmailLookup"("status", "requestedAt");

-- CreateIndex
CREATE UNIQUE INDEX "EmailLookup_userId_profileId_key" ON "EmailLookup"("userId", "profileId");

-- AddForeignKey
ALTER TABLE "EmailLookup" ADD CONSTRAINT "EmailLookup_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailLookup" ADD CONSTRAINT "EmailLookup_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "Profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
