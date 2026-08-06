import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { extname, join, resolve } from 'node:path';
import { mkdir, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { requireAuth } from '../auth/middleware.js';
import { prisma } from '../lib/prisma.js';
import { ValidationError } from '../errors/AppError.js';
import { logger } from '../lib/logger.js';
import { encryptSecret, decryptSecret, isEncrypted } from '../lib/secretBox.js';
import {
  invalidateTransporter,
  verifyCredentials,
} from '../services/mailer.service.js';

const router = Router();

/**
 * Outreach settings — SMTP credentials, signature, and the attached CV.
 *
 * Split from `/api/config` and gated on `requireAuth` rather than
 * `requireAuthOrApiKey`. That router is reachable with the extension's
 * long-lived `x-api-key`; nothing about reporting scrape results should carry
 * the ability to read or change the credentials that send mail.
 */

const UPLOAD_DIR = resolve(process.cwd(), 'uploads');

/**
 * Disk storage with a generated name.
 *
 * multer's `dest` shortcut keeps the browser-supplied filename, which is
 * attacker-controlled: `../../.env` is a valid value for it. A uuid plus the
 * validated extension removes the question entirely, and the display name is
 * kept separately in the database.
 */
const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      void mkdir(UPLOAD_DIR, { recursive: true })
        .then(() => cb(null, UPLOAD_DIR))
        .catch((err: Error) => cb(err, UPLOAD_DIR));
    },
    filename: (_req, file, cb) => {
      const ext = extname(file.originalname).toLowerCase();
      cb(null, `${randomUUID()}${ext === '.pdf' ? '.pdf' : ''}`);
    },
  }),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    // Attachments go out over the user's own Gmail account; Google rejects
    // most executable types outright and a wrong one wastes a whole campaign.
    if (file.mimetype !== 'application/pdf') {
      cb(new ValidationError('The résumé must be a PDF'));
      return;
    }
    cb(null, true);
  },
});

const settingsSchema = z.object({
  smtpUser: z.string().email().nullable().optional(),
  // Absent means "leave unchanged" — the client never receives the current
  // value, so it cannot echo it back on an unrelated edit.
  smtpPassword: z.string().min(1).max(500).nullable().optional(),
  smtpFromName: z.string().max(200).nullable().optional(),
  emailSignature: z.string().max(5000).nullable().optional(),
});

/**
 * What the browser is allowed to see.
 *
 * `smtpPassword` is never returned in any form, not even masked — a masked
 * value still tells you the length. `smtpConfigured` is the only thing the UI
 * actually needs in order to render correctly.
 */
async function readSettings(userId: string) {
  const config = await prisma.userConfig.findUnique({
    where: { userId },
    select: {
      smtpUser: true,
      smtpPassword: true,
      smtpFromName: true,
      emailSignature: true,
      resumeFileName: true,
    },
  });

  return {
    smtpUser: config?.smtpUser ?? null,
    smtpFromName: config?.smtpFromName ?? null,
    emailSignature: config?.emailSignature ?? null,
    resumeFileName: config?.resumeFileName ?? null,
    smtpConfigured: Boolean(config?.smtpUser && config?.smtpPassword),
  };
}

router.get('/settings/outreach', requireAuth, async (req, res, next) => {
  try {
    res
      .status(200)
      .json({ ok: true, settings: await readSettings(req.user!.id) });
  } catch (err) {
    next(err);
  }
});

router.put('/settings/outreach', requireAuth, async (req, res, next) => {
  try {
    const parsed = settingsSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError('Invalid outreach settings', {
        issues: parsed.error.errors,
      });
    }

    const userId = req.user!.id;
    const { smtpPassword, ...rest } = parsed.data;

    const data: Record<string, string | null> = { ...rest };

    // Distinguishes the three cases the UI can express: untouched (undefined),
    // cleared (null), and replaced (a string).
    if (smtpPassword !== undefined) {
      data.smtpPassword =
        smtpPassword === null ? null : encryptSecret(smtpPassword);
    }

    const existing = await prisma.userConfig.findUnique({
      where: { userId },
      select: { smtpUser: true },
    });

    await prisma.userConfig.upsert({
      where: { userId },
      update: data,
      create: { userId, ...data },
    });

    // A cached transport authenticated with the old credentials would keep
    // working until the process restarted, so a corrected password would
    // appear to have no effect.
    if (existing?.smtpUser) invalidateTransporter(existing.smtpUser);

    res.status(200).json({ ok: true, settings: await readSettings(userId) });
  } catch (err) {
    next(err);
  }
});

/**
 * Check the stored credentials against Gmail without sending anything.
 *
 * Exists so the settings screen can say "these work" at the moment they are
 * entered, rather than the user discovering otherwise when a campaign fails.
 */
router.post(
  '/settings/outreach/verify',
  requireAuth,
  async (req, res, next) => {
    try {
      const config = await prisma.userConfig.findUnique({
        where: { userId: req.user!.id },
        select: { smtpUser: true, smtpPassword: true },
      });

      if (!config?.smtpUser || !config.smtpPassword) {
        throw new ValidationError('Add a sending address and password first');
      }

      const result = await verifyCredentials({
        user: config.smtpUser,
        password: isEncrypted(config.smtpPassword)
          ? decryptSecret(config.smtpPassword)
          : config.smtpPassword,
      });

      // 200 either way: the request succeeded, and whether Gmail accepted the
      // credentials is a result the UI renders, not a transport failure.
      res
        .status(200)
        .json(
          result.ok
            ? { ok: true, verified: true }
            : { ok: true, verified: false, error: result.error },
        );
    } catch (err) {
      next(err);
    }
  },
);

router.post(
  '/settings/outreach/resume',
  requireAuth,
  upload.single('resume'),
  async (req, res, next) => {
    try {
      if (!req.file) throw new ValidationError('No file was uploaded');

      const userId = req.user!.id;
      const previous = await prisma.userConfig.findUnique({
        where: { userId },
        select: { resumeFilePath: true },
      });

      await prisma.userConfig.upsert({
        where: { userId },
        update: {
          resumeFileName: req.file.originalname,
          resumeFilePath: req.file.path,
        },
        create: {
          userId,
          resumeFileName: req.file.originalname,
          resumeFilePath: req.file.path,
        },
      });

      // Replacing the CV deletes the old file. The mailer never did this and
      // accumulated fifteen copies of the same PDF.
      if (
        previous?.resumeFilePath &&
        previous.resumeFilePath !== req.file.path
      ) {
        await unlink(previous.resumeFilePath).catch((err: unknown) => {
          logger.warn({ err }, '[settings] Could not delete previous résumé');
        });
      }

      res.status(200).json({ ok: true, settings: await readSettings(userId) });
    } catch (err) {
      next(err);
    }
  },
);

router.delete(
  '/settings/outreach/resume',
  requireAuth,
  async (req, res, next) => {
    try {
      const userId = req.user!.id;
      const config = await prisma.userConfig.findUnique({
        where: { userId },
        select: { resumeFilePath: true },
      });

      await prisma.userConfig.update({
        where: { userId },
        data: { resumeFileName: null, resumeFilePath: null },
      });

      if (config?.resumeFilePath) {
        await unlink(config.resumeFilePath).catch((err: unknown) => {
          logger.warn({ err }, '[settings] Could not delete résumé file');
        });
      }

      res.status(200).json({ ok: true, settings: await readSettings(userId) });
    } catch (err) {
      next(err);
    }
  },
);

export const outreachSettingsRouter = router;
export const RESUME_UPLOAD_DIR = join(UPLOAD_DIR);
