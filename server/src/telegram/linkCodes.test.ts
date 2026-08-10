import { afterEach, describe, expect, it, vi } from 'vitest';
import { consumeLinkCode, issueLinkCode } from './linkCodes.js';

/**
 * The properties that make a link code safer than what it replaced.
 *
 * Linking used to mean sending the account's long-lived API key to the bot as a
 * chat message — permanent, replayable, and valid from anywhere. A code is only
 * an improvement if it is genuinely single-use and genuinely expires.
 */

afterEach(() => {
  vi.useRealTimers();
});

describe('issueLinkCode', () => {
  it('avoids characters that are misread when typed on a phone', () => {
    for (let i = 0; i < 40; i++) {
      expect(issueLinkCode(`user-${i}`).code).not.toMatch(/[0O1IL]/);
    }
  });

  it('issues a different code each time', () => {
    const codes = new Set(
      Array.from({ length: 50 }, (_, i) => issueLinkCode(`user-${i}`).code),
    );
    expect(codes.size).toBe(50);
  });

  it('invalidates the account’s previous code', () => {
    // Otherwise a code left on a screen an hour ago still works.
    const first = issueLinkCode('user-replace').code;
    const second = issueLinkCode('user-replace').code;

    expect(consumeLinkCode(first)).toBeNull();
    expect(consumeLinkCode(second)).toBe('user-replace');
  });
});

describe('consumeLinkCode', () => {
  it('returns the account the code was issued for', () => {
    const { code } = issueLinkCode('user-1');
    expect(consumeLinkCode(code)).toBe('user-1');
  });

  it('works exactly once', () => {
    const { code } = issueLinkCode('user-2');

    expect(consumeLinkCode(code)).toBe('user-2');
    expect(consumeLinkCode(code)).toBeNull();
  });

  it('is case-insensitive and ignores stray whitespace', () => {
    // People retype these off a screen, and Telegram helpfully capitalises.
    const { code } = issueLinkCode('user-3');
    expect(consumeLinkCode(`  ${code.toLowerCase()} `)).toBe('user-3');
  });

  it('rejects a code that was never issued', () => {
    expect(consumeLinkCode('NOPENOPE')).toBeNull();
  });

  it('rejects a code once its ten minutes are up', () => {
    vi.useFakeTimers();
    const { code } = issueLinkCode('user-4');

    vi.advanceTimersByTime(10 * 60 * 1000 + 1);

    expect(consumeLinkCode(code)).toBeNull();
  });

  it('still accepts a code just inside the window', () => {
    vi.useFakeTimers();
    const { code } = issueLinkCode('user-5');

    vi.advanceTimersByTime(9 * 60 * 1000);

    expect(consumeLinkCode(code)).toBe('user-5');
  });
});
