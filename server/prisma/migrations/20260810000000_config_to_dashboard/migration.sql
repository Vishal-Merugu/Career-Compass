-- Drops three settings the pipeline stopped reading, and adds the one it needs.
--
-- `keywords` and `locations` were for a job-search path this product no longer
-- has; the only code left reading them was a line in the Telegram /config
-- output. `targetGeoId` is worse than unused: the extension collected it and
-- saved it, and `parseSearchUrl` has always hardcoded 101282230 as its
-- fallback and never once consulted the column — so a user who set it got no
-- effect and no warning.
--
-- `searchPrompt` replaces a hardcoded <textarea> default in the extension
-- popup, which could not be edited without editing markup.
--
-- AlterTable
ALTER TABLE "UserConfig" DROP COLUMN "keywords",
DROP COLUMN "locations",
DROP COLUMN "targetGeoId",
ADD COLUMN     "searchPrompt" TEXT;

