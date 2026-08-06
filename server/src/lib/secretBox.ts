import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { env } from '../config/env.js';
import { AppError, ErrorCode } from '../errors/AppError.js';

/**
 * Authenticated encryption for secrets that must be stored and read back.
 *
 * The one caller today is `UserConfig.smtpPassword`, a Google app password.
 * It cannot be hashed like a login password: the send loop has to present the
 * original value to Gmail, so it needs to be recoverable, not merely
 * verifiable.
 *
 * AES-256-GCM rather than plain CBC/CTR so the ciphertext is tamper-evident —
 * a modified blob fails the auth tag instead of decrypting to garbage that
 * then gets handed to an SMTP server.
 */

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12; // 96 bits, the size GCM is specified for
const KEY_BYTES = 32;
const VERSION = 'v1';

/**
 * The key is derived from JWT_SECRET rather than read from its own variable,
 * so no existing deployment needs a new value set before it can start.
 *
 * HKDF with a distinct `info` string is what keeps this from being key reuse:
 * the derived key is cryptographically independent of the one signing
 * sessions, so a token forgery does not imply secret disclosure, or the
 * reverse.
 *
 * Consequence worth knowing: rotating JWT_SECRET makes every stored secret
 * undecryptable. That is why decryption failure is reported as a specific,
 * actionable error rather than a generic 500 — the fix is to re-enter the
 * password, not to debug the crypto.
 */
function derivedKey(): Buffer {
  return Buffer.from(
    hkdfSync(
      'sha256',
      env.JWT_SECRET,
      'careercompass-secretbox',
      VERSION,
      KEY_BYTES,
    ),
  );
}

/**
 * `v1:<iv>:<authTag>:<ciphertext>`, each part base64.
 *
 * Version-prefixed so a future algorithm change can be detected rather than
 * misparsed — an unversioned blob would decrypt to nonsense under new rules.
 */
export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, derivedKey(), iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return [
    VERSION,
    iv.toString('base64'),
    authTag.toString('base64'),
    ciphertext.toString('base64'),
  ].join(':');
}

export function decryptSecret(blob: string): string {
  const parts = blob.split(':');
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new AppError(
      'Stored secret is not in a recognised format',
      500,
      ErrorCode.INTERNAL_ERROR,
    );
  }

  const [, ivB64, tagB64, dataB64] = parts;

  try {
    const decipher = createDecipheriv(
      ALGORITHM,
      derivedKey(),
      Buffer.from(ivB64, 'base64'),
    );
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(dataB64, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    // Either the blob was tampered with or JWT_SECRET changed under it.
    // Both are unrecoverable here and both are fixed the same way.
    throw new AppError(
      'Stored secret could not be decrypted. Re-enter it in settings.',
      500,
      ErrorCode.INTERNAL_ERROR,
    );
  }
}

/**
 * True when `blob` looks like something `decryptSecret` can read.
 *
 * Lets callers migrate a column that may still hold plaintext from before
 * encryption existed, without attempting a decrypt that throws.
 */
export function isEncrypted(blob: string | null | undefined): boolean {
  if (!blob) return false;
  const parts = blob.split(':');
  return parts.length === 4 && parts[0] === VERSION;
}

/**
 * Constant-time string comparison.
 *
 * `===` on secrets leaks their contents through timing: it returns on the
 * first differing byte, so response time reveals the length of the matching
 * prefix and lets an attacker recover the value one character at a time.
 */
export function secretsMatch(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  // timingSafeEqual throws on length mismatch, which is itself a leak — but
  // length is far less useful than content, and hashing to equalise lengths
  // would be the alternative. Compare lengths first, explicitly.
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
