// ─── Email lookup executor API ───────────────────────────────────
//
// The pull side of the lookup queue. The Chrome extension asks for work on a
// `chrome.alarms` tick and posts each result back.
//
// Pull, not push: an MV3 service worker is killed after ~30s idle and the
// WebSocket handshake requires a live `SearchJob` (see
// `ws-gateway/middleware/auth.ts`), so there is no socket to send a command
// down when the dashboard button is pressed. The extension asks instead.
//
// `requireAuthOrApiKey` because this is the one thing the extension genuinely
// must be able to do with its long-lived key. It is deliberately narrow: claim
// work, report an address. Nothing here can send mail or read another user's
// rows — every query is scoped to `req.user.id`.

import { Router } from 'express';
import { z } from 'zod';
import { requireAuthOrApiKey } from '../auth/middleware.js';
import { ValidationError } from '../errors/AppError.js';
import {
  claimLookups,
  completeLookup,
} from '../services/emailLookup.service.js';

const router = Router();

const claimSchema = z.object({
  /**
   * Capped low on purpose. Each item costs the extension a background tab, and
   * a client that claims 50 and then closes leaves 50 rows sitting on a lease
   * until the sweeper reclaims them.
   */
  take: z.coerce.number().int().min(1).max(10).default(2),
});

router.post(
  '/email-lookups/claim',
  requireAuthOrApiKey,
  async (req, res, next) => {
    try {
      const parsed = claimSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        throw new ValidationError('Invalid claim payload', {
          issues: parsed.error.errors,
        });
      }

      const items = await claimLookups(
        req.user!.id,
        parsed.data.take,
        'extension',
      );

      res.status(200).json({ ok: true, items });
    } catch (err) {
      next(err);
    }
  },
);

const resultSchema = z.object({
  ok: z.boolean(),
  email: z.string().email().optional().nullable(),
  source: z.string().max(64).optional().nullable(),
  validation: z.string().max(64).optional().nullable(),
  error: z.string().max(500).optional().nullable(),
});

/**
 * Report one outcome.
 *
 * A miss is a normal result, not an HTTP error — `{ ok: false, error }` returns
 * 200 and re-queues the row for another attempt. Reserving the status code for
 * transport failures is what lets the extension distinguish "try again later"
 * from "this payload is wrong".
 */
router.post(
  '/email-lookups/:id/result',
  requireAuthOrApiKey,
  async (req, res, next) => {
    try {
      const parsed = resultSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError('Invalid lookup result payload', {
          issues: parsed.error.errors,
        });
      }

      await completeLookup(req.user!.id, req.params.id, parsed.data);

      res.status(200).json({ ok: true });
    } catch (err) {
      next(err);
    }
  },
);

export const emailLookupsRouter = router;
