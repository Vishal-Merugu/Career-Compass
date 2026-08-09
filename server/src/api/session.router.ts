// ─── LinkedIn session API ────────────────────────────────────────
//
// How a cookie jar gets from a real browser to the server. The server cannot
// log in to LinkedIn — there is no password flow, and a headless browser is
// exactly what LinkedIn's risk engine is looking for — so a jar is always
// harvested in the extension and pushed here.
//
// This is now the extension's most important job. It used to make the Voyager
// calls itself; it now supplies the credential that lets the server make them.

import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, requireAuthOrApiKey } from '../auth/middleware.js';
import { prisma } from '../lib/prisma.js';
import { ValidationError } from '../errors/AppError.js';
import {
  getSessionState,
  importSession,
} from '../services/linkedinSession.service.js';

const router = Router();

const importSchema = z.object({
  /**
   * Cookie name → value. Deliberately a free-form map rather than named
   * fields: LinkedIn adds and renames cookies, and a jar that silently drops
   * an unrecognised one stops looking like the browser it came from.
   * `linkedinSession.service.ts` validates that the critical ones are present.
   */
  cookies: z.record(z.string()),
  userAgent: z.string().min(1),
  timezoneOffset: z.number().optional(),
});

/**
 * Push a freshly harvested jar.
 *
 * `requireAuthOrApiKey` because the extension does this with its long-lived
 * key — it is the only client that can, and supplying a session is the whole
 * reason it still exists.
 */
router.post('/cookies', requireAuthOrApiKey, async (req, res, next) => {
  try {
    const parsed = importSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError('Invalid cookie jar payload', {
        issues: parsed.error.errors,
      });
    }

    const state = await importSession(req.user!.id, parsed.data);

    res.status(200).json({ ok: true, session: state });
  } catch (err) {
    next(err);
  }
});

/**
 * Session health, for the dashboard and the extension popup.
 *
 * Never returns cookie values — only which critical ones are missing. The
 * response is readable with the extension's API key, and a jar is a live
 * LinkedIn session.
 */
router.get('/', requireAuthOrApiKey, async (req, res, next) => {
  try {
    res.status(200).json({
      ok: true,
      session: await getSessionState(req.user!.id),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Forget the stored jar.
 *
 * Cookie-only: revoking a credential is not something the scraping key should
 * be able to do.
 */
router.delete('/', requireAuth, async (req, res, next) => {
  try {
    await prisma.linkedInSession.deleteMany({
      where: { userId: req.user!.id },
    });
    res.status(200).json({ ok: true });
  } catch (err) {
    next(err);
  }
});

export const sessionRouter = router;
