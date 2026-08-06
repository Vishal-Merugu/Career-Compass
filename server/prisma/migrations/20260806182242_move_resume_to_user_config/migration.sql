/*
  Warnings:

  - You are about to drop the column `resumeFileName` on the `Campaign` table. All the data in the column will be lost.
  - You are about to drop the column `resumeFilePath` on the `Campaign` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "Campaign" DROP COLUMN "resumeFileName",
DROP COLUMN "resumeFilePath";

-- AlterTable
ALTER TABLE "UserConfig" ADD COLUMN     "resumeFileName" TEXT,
ADD COLUMN     "resumeFilePath" TEXT;
