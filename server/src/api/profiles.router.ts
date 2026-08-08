import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, requireAuthOrApiKey } from '../auth/middleware.js';
import { prisma } from '../lib/prisma.js';
import { ValidationError } from '../errors/AppError.js';
import { findEmail } from '../services/emailFinder/index.js';
import {
  cancelQueuedLookups,
  emailLookupEvents,
  enqueueLookups,
  getLookupStats,
  type LookupProgress,
} from '../services/emailLookup.service.js';

const router = Router();

const paginationSchema = z.object({
  skip: z.coerce.number().int().min(0).default(0),
  take: z.coerce.number().int().min(1).max(200).default(100),
});

function parsePagination(query: unknown) {
  const result = paginationSchema.safeParse(query);
  if (!result.success) {
    throw new ValidationError('Invalid pagination parameters', {
      issues: result.error.errors,
    });
  }
  return result.data;
}

/**
 * Fields the client is allowed to see.
 *
 * An explicit select, not `include`. Prisma's default returns every scalar
 * column, which here meant shipping `rawProfileJson` — the raw Voyager payload
 * — and the full `about` text for every row. That is a large response and far
 * more personal data than any screen renders. Allow-listing also means a column
 * added to the schema later is not silently published.
 */
const PROFILE_FIELDS = {
  id: true,
  profileId: true,
  firstName: true,
  lastName: true,
  headline: true,
  location: true,
  linkedinUrl: true,
  email: true,
  emailSource: true,
  emailValidation: true,
  createdAt: true,
  company: {
    select: {
      id: true,
      companyId: true,
      name: true,
      slug: true,
      industry: true,
      website: true,
      employeeCount: true,
    },
  },
} as const;

/**
 * Parsed candidate profiles scoped to the current user's outreach history.
 *
 * Paginated: this returned every matching row unbounded, which is fine at 15
 * connections a day and not fine a year in.
 *
 * `stats` is computed over the WHOLE result set, not the returned page. The
 * dashboard's headline tiles read from it, so they stay correct no matter how
 * many pages have been loaded — counting the current page would quietly
 * understate every number.
 */
router.get('/profiles', requireAuthOrApiKey, async (req, res, next) => {
  try {
    const userId = req.user!.id;
    const { skip, take } = parsePagination(req.query);
    const where = { outreachLogs: { some: { userId } } };

    const [profiles, total, withEmail, companies] = await Promise.all([
      prisma.profile.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take,
        select: PROFILE_FIELDS,
      }),
      prisma.profile.count({ where }),
      prisma.profile.count({ where: { ...where, email: { not: null } } }),
      prisma.profile.findMany({
        where: { ...where, companyId: { not: null } },
        distinct: ['companyId'],
        select: { companyId: true },
      }),
    ]);

    res.status(200).json({
      ok: true,
      profiles,
      skip,
      take,
      total,
      stats: { total, withEmail, companies: companies.length },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Companies resolved from the user's scraped jobs.
 */
router.get('/companies', requireAuthOrApiKey, async (req, res, next) => {
  try {
    const userId = req.user!.id;
    const { skip, take } = parsePagination(req.query);
    const where = {
      profiles: { some: { outreachLogs: { some: { userId } } } },
    };

    const [companies, total] = await Promise.all([
      prisma.company.findMany({
        where,
        orderBy: { name: 'asc' },
        skip,
        take,
        select: {
          id: true,
          companyId: true,
          name: true,
          slug: true,
          industry: true,
          website: true,
          employeeCount: true,
        },
      }),
      prisma.company.count({ where }),
    ]);

    res.status(200).json({ ok: true, companies, skip, take, total });
  } catch (err) {
    next(err);
  }
});

/**
 * Look up a work email.
 *
 * Exists so the extension's local workflows (mass connector CSV export) can
 * still attach emails after the finder moved server-side. The lookup itself
 * needs no LinkedIn session, so there is nothing to gain from running it in
 * the browser — and running it here means it also works when no browser is
 * connected.
 */
const findEmailSchema = z.object({
  linkedinUrl: z.string().min(1),
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  companyName: z.string().min(1),
  companyWebsite: z.string().optional(),
});

// NOTE the path: `/profiles/find-email`, matching its only caller
// (`extension/workflows/massConnector.js`) and the bulk routes below. It was
// mounted at `/find-email` while the extension posted to
// `/api/profiles/find-email`, so every call 404'd — and `apiSync` swallows
// non-2xx, so the mass connector silently exported contacts with no email.
router.post(
  '/profiles/find-email',
  requireAuthOrApiKey,
  async (req, res, next) => {
    try {
      const parsed = findEmailSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError('Invalid email lookup payload', {
          issues: parsed.error.errors,
        });
      }

      const result = await findEmail(parsed.data);
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  },
);

// ─── Bulk lookups, driven from the dashboard ─────────────────────
//
// `POST /find-email` above is synchronous and answers one profile — fine for
// the extension's own workflow, useless for "find emails for these 40 rows",
// which takes minutes and must survive the tab closing. These routes queue the
// work instead and report on it; see `emailLookup.service.ts` for why the queue
// is a table rather than an in-memory or Redis job.
//
// `requireAuth`, not `requireAuthOrApiKey`: the extension has no reason to
// enqueue work for itself, and its long-lived key works from anywhere.

const findEmailsSchema = z.object({
  profileIds: z.array(z.string().min(1)).min(1).max(500),
  /** Re-look-up profiles that already hold a verified address. */
  force: z.boolean().optional().default(false),
  /**
   * Let the server finish these with patterns + SMTP if no browser claims them.
   *
   * Defaults to **false**: the extension is where the provider lookup actually
   * works, and a server-side pass bottoms out at a guess. Opt in when no browser
   * is coming and a guess beats nothing.
   */
  serverFallback: z.boolean().optional().default(false),
});

router.post('/profiles/find-emails', requireAuth, async (req, res, next) => {
  try {
    const parsed = findEmailsSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError('Invalid bulk email lookup payload', {
        issues: parsed.error.errors,
      });
    }

    const result = await enqueueLookups(
      req.user!.id,
      parsed.data.profileIds,
      parsed.data.force,
      parsed.data.serverFallback,
    );
    const stats = await getLookupStats(req.user!.id);

    res.status(202).json({ ok: true, ...result, stats });
  } catch (err) {
    next(err);
  }
});

/**
 * Current queue state.
 *
 * The dashboard's source of truth — the SSE stream below is a live
 * accelerator, not the record. Polling this after a reload or a server restart
 * shows correct progress with no stream at all.
 */
router.get('/profiles/find-emails', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user!.id;
    const [stats, recent] = await Promise.all([
      getLookupStats(userId),
      prisma.emailLookup.findMany({
        where: { userId },
        orderBy: { requestedAt: 'desc' },
        take: 100,
        select: {
          id: true,
          profileId: true,
          status: true,
          attempts: true,
          claimedBy: true,
          email: true,
          emailSource: true,
          emailValidation: true,
          lastError: true,
          requestedAt: true,
          completedAt: true,
        },
      }),
    ]);

    res.status(200).json({ ok: true, stats, lookups: recent });
  } catch (err) {
    next(err);
  }
});

/** Drop everything still waiting. Work already leased out is left alone. */
router.delete('/profiles/find-emails', requireAuth, async (req, res, next) => {
  try {
    const cancelled = await cancelQueuedLookups(req.user!.id);
    res.status(200).json({ ok: true, cancelled });
  } catch (err) {
    next(err);
  }
});

/**
 * Live progress. Same shape as the campaign progress stream — one-way, to a
 * browser already authenticated by cookie, which is what SSE is for.
 */
router.get(
  '/profiles/find-emails/events',
  requireAuth,
  async (req, res, next) => {
    try {
      const userId = req.user!.id;

      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      // Without this, nginx and friends buffer the stream and nothing arrives
      // until the response ends — which for SSE is never.
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders();

      // Open with the current state so a client that connects mid-run renders
      // the right numbers immediately instead of waiting for the next lookup.
      res.write(
        `data: ${JSON.stringify({
          userId,
          type: 'STATS',
          stats: await getLookupStats(userId),
        })}\n\n`,
      );

      const channel = `emailLookup:${userId}`;
      const onProgress = (event: LookupProgress) => {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      };
      emailLookupEvents.on(channel, onProgress);

      // Lookups can be minutes apart when the extension is draining slowly, and
      // a silent connection gets dropped by proxies. EventSource ignores
      // comment frames.
      const heartbeat = setInterval(() => res.write(': keepalive\n\n'), 25_000);

      req.on('close', () => {
        clearInterval(heartbeat);
        emailLookupEvents.off(channel, onProgress);
      });
    } catch (err) {
      next(err);
    }
  },
);

export const profilesRouter = router;
