import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../auth/middleware.js';
import { prisma } from '../lib/prisma.js';
import { NotFoundError, ValidationError } from '../errors/AppError.js';
import {
  addContactsFromProfiles,
  campaignEvents,
  createCampaign,
  startCampaign,
  stopCampaign,
  type ICampaignProgress,
} from '../services/campaign.service.js';

const router = Router();

/**
 * Every route here uses requireAuth, not requireAuthOrApiKey.
 *
 * The extension's API key is long-lived, never expires and works from
 * anywhere. It exists so the extension can report scraping results. Nothing
 * about that job requires the ability to send mail from the user's Gmail
 * account, and a leaked key should not confer it.
 */

const createSchema = z.object({
  name: z.string().min(1).max(200),
  emailSubject: z.string().min(1).max(300),
  commonPrompt: z.string().max(10_000).optional(),
  fromName: z.string().max(200).optional(),
  minDelayMs: z.coerce.number().int().min(0).max(3_600_000).optional(),
  maxDelayMs: z.coerce.number().int().min(0).max(3_600_000).optional(),
});

const addContactsSchema = z.object({
  // Bounded so one request cannot queue an unbounded campaign. Gmail's own
  // ceiling is ~500/day; anything past that is a mistake, not a plan.
  profileIds: z.array(z.string().uuid()).min(1).max(500),
});

const draftSchema = z.object({
  customSubject: z.string().max(300).nullable().optional(),
  customBody: z.string().max(50_000).nullable().optional(),
});

const paginationSchema = z.object({
  skip: z.coerce.number().int().min(0).default(0),
  take: z.coerce.number().int().min(1).max(200).default(50),
});

router.post('/campaigns', requireAuth, async (req, res, next) => {
  try {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError('Invalid campaign', {
        issues: parsed.error.errors,
      });
    }

    const campaign = await createCampaign({
      userId: req.user!.id,
      ...parsed.data,
    });
    res.status(201).json({ ok: true, campaign });
  } catch (err) {
    next(err);
  }
});

router.get('/campaigns', requireAuth, async (req, res, next) => {
  try {
    const parsed = paginationSchema.safeParse(req.query);
    if (!parsed.success) {
      throw new ValidationError('Invalid pagination parameters', {
        issues: parsed.error.errors,
      });
    }
    const { skip, take } = parsed.data;
    const where = { userId: req.user!.id };

    const [campaigns, total] = await Promise.all([
      prisma.campaign.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take,
      }),
      prisma.campaign.count({ where }),
    ]);

    res.status(200).json({ ok: true, campaigns, skip, take, total });
  } catch (err) {
    next(err);
  }
});

router.get('/campaigns/:id', requireAuth, async (req, res, next) => {
  try {
    const campaign = await prisma.campaign.findFirst({
      where: { id: req.params.id, userId: req.user!.id },
    });
    if (!campaign) throw new NotFoundError('Campaign not found');

    const contacts = await prisma.campaignContact.findMany({
      where: { campaignId: campaign.id },
      orderBy: { createdAt: 'asc' },
      // sentBody is excluded deliberately — a full copy of every email sent is
      // a large payload the list screen does not render. Fetch one contact's
      // detail when it is actually opened.
      select: {
        id: true,
        profileId: true,
        name: true,
        email: true,
        companyName: true,
        description: true,
        customSubject: true,
        customBody: true,
        status: true,
        errorMessage: true,
        sentAt: true,
      },
    });

    res.status(200).json({ ok: true, campaign, contacts });
  } catch (err) {
    next(err);
  }
});

router.post('/campaigns/:id/contacts', requireAuth, async (req, res, next) => {
  try {
    const parsed = addContactsSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError('Invalid profile selection', {
        issues: parsed.error.errors,
      });
    }

    const result = await addContactsFromProfiles(
      req.params.id,
      req.user!.id,
      parsed.data.profileIds,
    );
    res.status(200).json({ ok: true, ...result });
  } catch (err) {
    next(err);
  }
});

router.put(
  '/campaigns/contacts/:contactId',
  requireAuth,
  async (req, res, next) => {
    try {
      const parsed = draftSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError('Invalid draft', {
          issues: parsed.error.errors,
        });
      }

      // Ownership runs through the campaign — a contact id alone says nothing
      // about who may edit it.
      const contact = await prisma.campaignContact.findFirst({
        where: {
          id: req.params.contactId,
          campaign: { userId: req.user!.id },
        },
      });
      if (!contact) throw new NotFoundError('Contact not found');

      const updated = await prisma.campaignContact.update({
        where: { id: contact.id },
        data: {
          customSubject: parsed.data.customSubject ?? contact.customSubject,
          customBody: parsed.data.customBody ?? contact.customBody,
        },
      });

      res.status(200).json({ ok: true, contact: updated });
    } catch (err) {
      next(err);
    }
  },
);

router.post('/campaigns/:id/send', requireAuth, async (req, res, next) => {
  try {
    const result = await startCampaign(req.params.id, req.user!.id);
    res.status(202).json({ ok: true, ...result });
  } catch (err) {
    next(err);
  }
});

router.post('/campaigns/:id/stop', requireAuth, async (req, res, next) => {
  try {
    const result = await stopCampaign(req.params.id, req.user!.id);
    res.status(200).json({ ok: true, ...result });
  } catch (err) {
    next(err);
  }
});

/**
 * Live progress for one campaign.
 *
 * SSE rather than the existing Socket.io gateway: that gateway is the
 * extension's command channel, with its own registry keyed by userId and its
 * own event vocabulary. Campaign progress is a one-way stream to a browser
 * that is already authenticated by cookie, which is exactly what SSE is for.
 */
router.get('/campaigns/:id/events', requireAuth, async (req, res, next) => {
  try {
    const campaign = await prisma.campaign.findFirst({
      where: { id: req.params.id, userId: req.user!.id },
      select: { id: true },
    });
    if (!campaign) throw new NotFoundError('Campaign not found');

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    // Without this, nginx and friends buffer the stream and nothing arrives
    // until the response ends — which for SSE is never.
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const channel = `campaign:${campaign.id}`;
    const onProgress = (event: ICampaignProgress) => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    campaignEvents.on(channel, onProgress);

    // Proxies and load balancers drop a connection that goes quiet. A comment
    // frame is ignored by EventSource but keeps the socket alive between
    // contacts, which can be minutes apart at the configured pacing.
    const heartbeat = setInterval(() => res.write(': keepalive\n\n'), 25_000);

    req.on('close', () => {
      clearInterval(heartbeat);
      campaignEvents.off(channel, onProgress);
    });
  } catch (err) {
    next(err);
  }
});

export const campaignsRouter = router;
