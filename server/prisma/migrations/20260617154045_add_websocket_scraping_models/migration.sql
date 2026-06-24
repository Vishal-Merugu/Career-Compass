-- CreateTable
CREATE TABLE "SearchJob" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'initializing',
    "limitRequested" INTEGER NOT NULL,
    "qualifiedCount" INTEGER NOT NULL DEFAULT 0,
    "currentBatchNumber" INTEGER NOT NULL DEFAULT 1,
    "searchParams" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SearchJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProfileUrl" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "batchNumber" INTEGER NOT NULL,
    "url" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "dispatchedAt" TIMESTAMP(3),
    "scrapedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProfileUrl_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScrapedProfile" (
    "id" TEXT NOT NULL,
    "profileUrlId" TEXT NOT NULL,
    "rawData" JSONB NOT NULL,
    "name" TEXT NOT NULL,
    "headline" TEXT,
    "company" TEXT,
    "location" TEXT,
    "scrapedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ScrapedProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProfileDecision" (
    "id" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "email" TEXT,
    "emailSource" TEXT,
    "isQualified" BOOLEAN NOT NULL DEFAULT false,
    "qualificationReason" TEXT,
    "decidedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProfileDecision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExtensionConnection" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "socketId" TEXT NOT NULL,
    "connectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastHeartbeatAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "disconnectedAt" TIMESTAMP(3),

    CONSTRAINT "ExtensionConnection_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ProfileUrl_jobId_url_key" ON "ProfileUrl"("jobId", "url");

-- CreateIndex
CREATE UNIQUE INDEX "ScrapedProfile_profileUrlId_key" ON "ScrapedProfile"("profileUrlId");

-- AddForeignKey
ALTER TABLE "SearchJob" ADD CONSTRAINT "SearchJob_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProfileUrl" ADD CONSTRAINT "ProfileUrl_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "SearchJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScrapedProfile" ADD CONSTRAINT "ScrapedProfile_profileUrlId_fkey" FOREIGN KEY ("profileUrlId") REFERENCES "ProfileUrl"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProfileDecision" ADD CONSTRAINT "ProfileDecision_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "ScrapedProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExtensionConnection" ADD CONSTRAINT "ExtensionConnection_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "SearchJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;
