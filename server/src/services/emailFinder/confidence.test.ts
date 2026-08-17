import { describe, expect, it } from 'vitest';
import {
  isEmailUpgrade,
  isVerifiedSource,
  sourceStrength,
} from './confidence.js';

/**
 * The rules that stop a verified address being replaced by a guess.
 *
 * Worth testing directly rather than through the queue: outreach sends real
 * mail from the user's own Gmail, so a downgrade here is a bounce — or worse, a
 * stranger's inbox — and it would be invisible until someone read the logs.
 */

describe('sourceStrength', () => {
  it('ranks confirmed sources above provider hits above guesses', () => {
    expect(sourceStrength('smtp_verified')).toBeGreaterThan(
      sourceStrength('mailmeteor'),
    );
    expect(sourceStrength('mailmeteor')).toBeGreaterThan(
      sourceStrength('pattern_guess'),
    );
    expect(sourceStrength('pattern_guess')).toBeGreaterThan(
      sourceStrength('not_found'),
    );
  });

  // The second provider in the extension's waterfall. It verifies the mailbox
  // live before answering, so it ranks with the paid API rather than with
  // Mailmeteor — and an address it found must not be replaced by a later
  // Mailmeteor hit for the same person.
  it('ranks the free Anymail Finder tool with the paid one', () => {
    expect(sourceStrength('anymailfinder_web')).toBe(
      sourceStrength('anymailfinder'),
    );
    expect(sourceStrength('anymailfinder_web')).toBeGreaterThan(
      sourceStrength('mailmeteor'),
    );
  });

  it('treats a missing source as no evidence at all', () => {
    expect(sourceStrength(null)).toBe(0);
    expect(sourceStrength(undefined)).toBe(0);
  });

  it('gives an unrecognised source the benefit of the doubt, but only just', () => {
    // A source string added later should not outrank a verified address just
    // because this table has not been updated yet.
    expect(sourceStrength('something_new')).toBe(
      sourceStrength('pattern_guess'),
    );
    expect(sourceStrength('something_new')).toBeLessThan(
      sourceStrength('smtp_verified'),
    );
  });
});

describe('isVerifiedSource', () => {
  it('accepts provider and SMTP results', () => {
    expect(isVerifiedSource('anymailfinder')).toBe(true);
    expect(isVerifiedSource('smtp_verified')).toBe(true);
    expect(isVerifiedSource('mailmeteor')).toBe(true);
  });

  it('rejects a pattern guess — upgrading those is the point of the queue', () => {
    expect(isVerifiedSource('pattern_guess')).toBe(false);
    expect(isVerifiedSource('not_found')).toBe(false);
    expect(isVerifiedSource(null)).toBe(false);
  });
});

describe('isEmailUpgrade', () => {
  const guess = { email: 'a.b@acme.com', emailSource: 'pattern_guess' };
  const verified = { email: 'ab@acme.com', emailSource: 'smtp_verified' };

  it('fills an empty address with anything', () => {
    expect(
      isEmailUpgrade(
        { email: null, emailSource: null },
        { email: 'x@acme.com', source: 'pattern_guess' },
      ),
    ).toBe(true);
  });

  it('replaces a guess with a verified address', () => {
    expect(
      isEmailUpgrade(guess, { email: 'ab@acme.com', source: 'smtp_verified' }),
    ).toBe(true);
  });

  it('refuses to replace a verified address with a guess', () => {
    expect(
      isEmailUpgrade(verified, {
        email: 'a.b@acme.com',
        source: 'pattern_guess',
      }),
    ).toBe(false);
  });

  it('refuses an empty result', () => {
    expect(isEmailUpgrade(guess, { email: null, source: 'not_found' })).toBe(
      false,
    );
  });

  it('is idempotent at equal strength, so a re-run does not flip the address', () => {
    expect(
      isEmailUpgrade(guess, { email: 'ab@acme.com', source: 'pattern_guess' }),
    ).toBe(false);
  });

  it('promotes the same address to a stronger source', () => {
    // Same string, better provenance. Worth recording: it changes nothing that
    // gets mailed but it stops the row being re-queued as an unproven guess.
    expect(
      isEmailUpgrade(
        { email: 'ab@acme.com', emailSource: 'pattern_guess' },
        { email: 'ab@acme.com', source: 'smtp_verified' },
      ),
    ).toBe(true);
  });
});
