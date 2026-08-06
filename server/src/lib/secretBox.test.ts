import { describe, expect, it } from 'vitest';
import {
  decryptSecret,
  encryptSecret,
  isEncrypted,
  secretsMatch,
} from './secretBox.js';
import { AppError } from '../errors/AppError.js';

describe('secretBox', () => {
  it('round-trips a secret', () => {
    const secret = 'abcd efgh ijkl mnop'; // shape of a Google app password
    expect(decryptSecret(encryptSecret(secret))).toBe(secret);
  });

  it('round-trips unicode and empty input', () => {
    expect(decryptSecret(encryptSecret(''))).toBe('');
    expect(decryptSecret(encryptSecret('pässwörd 🔑'))).toBe('pässwörd 🔑');
  });

  it('produces a different ciphertext each time', () => {
    // A fresh IV per call. Deterministic output would let anyone with read
    // access to the table tell which users share a password.
    const a = encryptSecret('same');
    const b = encryptSecret('same');
    expect(a).not.toBe(b);
    expect(decryptSecret(a)).toBe(decryptSecret(b));
  });

  it('rejects a tampered ciphertext rather than returning garbage', () => {
    const blob = encryptSecret('original');
    const [version, iv, tag, data] = blob.split(':');
    const flipped = Buffer.from(data, 'base64');
    flipped[0] ^= 0xff;
    const tampered = [version, iv, tag, flipped.toString('base64')].join(':');

    expect(() => decryptSecret(tampered)).toThrow(AppError);
  });

  it('rejects a tampered auth tag', () => {
    const blob = encryptSecret('original');
    const [version, iv, , data] = blob.split(':');
    const wrongTag = Buffer.alloc(16, 7).toString('base64');

    expect(() =>
      decryptSecret([version, iv, wrongTag, data].join(':')),
    ).toThrow(AppError);
  });

  it('rejects malformed and unversioned blobs', () => {
    expect(() => decryptSecret('not-a-blob')).toThrow(AppError);
    expect(() => decryptSecret('v2:a:b:c')).toThrow(AppError);
    expect(() => decryptSecret('')).toThrow(AppError);
  });

  it('identifies encrypted blobs without decrypting them', () => {
    expect(isEncrypted(encryptSecret('x'))).toBe(true);
    expect(isEncrypted('plaintext-from-before-encryption')).toBe(false);
    expect(isEncrypted(null)).toBe(false);
    expect(isEncrypted(undefined)).toBe(false);
    expect(isEncrypted('')).toBe(false);
  });

  describe('secretsMatch', () => {
    it('matches identical strings', () => {
      expect(secretsMatch('token', 'token')).toBe(true);
    });

    it('rejects different strings of equal length', () => {
      expect(secretsMatch('token', 'tokan')).toBe(false);
    });

    it('rejects different lengths without throwing', () => {
      // timingSafeEqual throws on a length mismatch; the guard must catch it.
      expect(secretsMatch('short', 'much longer value')).toBe(false);
      expect(secretsMatch('', 'x')).toBe(false);
    });
  });
});
