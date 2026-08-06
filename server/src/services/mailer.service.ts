import nodemailer, { type Transporter } from 'nodemailer';
import { existsSync } from 'node:fs';
import { logger } from '../lib/logger.js';
import { ValidationError } from '../errors/AppError.js';

export interface ISmtpCredentials {
  user: string;
  password: string;
}

export interface IOutgoingMail {
  to: string;
  subject: string;
  body: string;
  fromName?: string | null;
  attachmentPath?: string | null;
  attachmentName?: string | null;
}

/**
 * Transports are cached per SMTP user so a campaign reuses one authenticated
 * connection pool instead of handshaking with Gmail for every contact.
 *
 * Keyed by user only, never by password: a key containing the credential would
 * put it into any heap dump or debugger session that walks this map.
 */
const transporters = new Map<string, Transporter>();

export function getTransporter(creds: ISmtpCredentials): Transporter {
  const cached = transporters.get(creds.user);
  if (cached) return cached;

  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: creds.user, pass: creds.password },
    pool: true,
    // Gmail drops connections that send too aggressively. One at a time,
    // which also matches the campaign's own pacing.
    maxConnections: 1,
    maxMessages: 50,
  });

  transporters.set(creds.user, transporter);
  return transporter;
}

/**
 * Drop a cached transport, so credentials changed in settings take effect
 * without a restart.
 */
export function invalidateTransporter(user: string): void {
  const existing = transporters.get(user);
  if (!existing) return;
  existing.close();
  transporters.delete(user);
}

/**
 * Confirm the credentials actually authenticate.
 *
 * Worth doing before a campaign starts rather than discovering it on contact
 * one: a wrong app password otherwise marks every contact FAILED in sequence,
 * each with an opaque SMTP error, and the campaign has to be rebuilt.
 */
export async function verifyCredentials(
  creds: ISmtpCredentials,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await getTransporter(creds).verify();
    return { ok: true };
  } catch (err) {
    invalidateTransporter(creds.user);
    const error = err instanceof Error ? err.message : 'Unknown SMTP error';
    logger.warn({ err, user: creds.user }, '[mailer] Credential check failed');
    return { ok: false, error };
  }
}

export async function sendMail(
  creds: ISmtpCredentials,
  mail: IOutgoingMail,
): Promise<void> {
  if (!mail.to.includes('@')) {
    throw new ValidationError(`Not a sendable address: ${mail.to}`);
  }

  const attachments =
    mail.attachmentPath && existsSync(mail.attachmentPath)
      ? [
          {
            filename: mail.attachmentName ?? 'attachment.pdf',
            path: mail.attachmentPath,
          },
        ]
      : undefined;

  // A configured resume that has gone missing from disk is worth saying out
  // loud. Silently sending without the attachment looks like success and the
  // omission is only noticed by the recipient.
  if (mail.attachmentPath && !attachments) {
    logger.warn(
      { path: mail.attachmentPath },
      '[mailer] Attachment configured but not found on disk; sending without it',
    );
  }

  await getTransporter(creds).sendMail({
    from: mail.fromName ? `"${mail.fromName}" <${creds.user}>` : creds.user,
    to: mail.to,
    subject: mail.subject,
    text: mail.body,
    attachments,
  });
}
