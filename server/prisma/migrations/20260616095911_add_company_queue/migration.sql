-- CreateTable
CREATE TABLE "CompanyQueue" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "companyUrl" TEXT NOT NULL,
    "searchPrompt" TEXT,
    "maxResults" INTEGER NOT NULL DEFAULT 100,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CompanyQueue_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "CompanyQueue" ADD CONSTRAINT "CompanyQueue_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
