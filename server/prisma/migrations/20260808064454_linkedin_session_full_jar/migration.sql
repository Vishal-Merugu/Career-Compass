-- LinkedInSession moves from (csrfToken, liAtCookie) to a full cookie jar.
--
-- Any existing row is discarded rather than migrated. The old shape held an
-- auth token and a CSRF token and nothing else, so it cannot produce a working
-- CookieJar — `li_at` without the browser-identity cookies reads as a stolen
-- session (docs/adr/0002-full-cookie-jar.md). There is also nothing to lose:
-- no code ever wrote this table. A jar is re-pushed from the extension via
-- POST /api/session/cookies.
DELETE FROM "LinkedInSession";

-- AlterTable
ALTER TABLE "LinkedInSession" DROP COLUMN "csrfToken",
DROP COLUMN "liAtCookie",
ADD COLUMN     "cookies" JSONB NOT NULL,
ADD COLUMN     "importedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "invalidReason" TEXT,
ADD COLUMN     "timezoneOffset" DOUBLE PRECISION NOT NULL DEFAULT 5.5,
ADD COLUMN     "userAgent" TEXT NOT NULL;
