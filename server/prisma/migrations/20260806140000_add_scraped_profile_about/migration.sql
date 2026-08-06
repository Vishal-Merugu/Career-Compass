-- Records a column that already exists everywhere but was never migrated.
--
-- `ScrapedProfile.about` was added to schema.prisma and reached both the local
-- database and the VM through `prisma db push --accept-data-loss`, which is
-- what deploys run. `db push` does not write migration history, so the history
-- stopped describing the real schema and `prisma migrate diff` reported drift.
--
-- IF NOT EXISTS because every existing database already has the column. This
-- migration exists to close the gap in the history, not to change any schema.
ALTER TABLE "ScrapedProfile" ADD COLUMN IF NOT EXISTS "about" TEXT;
