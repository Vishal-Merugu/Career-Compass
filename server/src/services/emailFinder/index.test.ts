import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SmtpVerdict } from './smtpVerify.js';

// The layers under test are all network I/O, so they are stubbed. What is
// being checked here is the orchestration: which verdict produces which
// claim, and — most importantly — when the finder refuses to answer.
//
// Two layers. The Mailmeteor layer was removed: it needed a headless browser
// and never returned an address, and that lookup now runs in the extension
// instead. LinkFinder is not a layer here either — its key is per user and it
// only ever sees rows this path has already been handed *after* it missed them,
// so calling it from here would spend a second credit for the same answer. See
// services/emailFinder/index.ts.

const anymailMock = vi.hoisted(() => vi.fn());
const smtpMock = vi.hoisted(() => vi.fn());
const domainMock = vi.hoisted(() => vi.fn());

vi.mock('./anymailfinder.js', () => ({
  findEmailViaAnymailFinder: anymailMock,
}));
vi.mock('./smtpVerify.js', () => ({ verifyEmailViaSmtp: smtpMock }));
vi.mock('./domain.js', () => ({ resolveCompanyDomain: domainMock }));

const { findEmail } = await import('./index.js');

const CONTACT = {
  linkedinUrl: 'https://www.linkedin.com/in/janedoe',
  firstName: 'Jane',
  lastName: 'Doe',
  companyName: 'Acme',
};

const verdict = (v: SmtpVerdict) => ({ verdict: v });

beforeEach(() => {
  vi.clearAllMocks();
  anymailMock.mockResolvedValue({ ok: false, reason: 'disabled' });
  domainMock.mockResolvedValue('acme.com');
});

describe('findEmail layering', () => {
  it('starts at Anymail Finder — LinkFinder is not one of its layers', async () => {
    // Guards a real double-charge. This path only ever runs on rows the
    // LinkFinder pass already claimed and missed, so a layer here would spend
    // a second credit of the user's money for an answer already known.
    anymailMock.mockResolvedValue({
      ok: true,
      email: 'jane@acme.com',
      validation: 'valid',
    });

    const result = await findEmail(CONTACT);

    expect(result).toMatchObject({
      ok: true,
      email: 'jane@acme.com',
      source: 'anymailfinder',
    });
  });

  it('uses Anymail Finder before patterns', async () => {
    anymailMock.mockResolvedValue({
      ok: true,
      email: 'jane@acme.com',
      validation: 'valid',
    });

    const result = await findEmail(CONTACT);

    expect(result).toMatchObject({
      ok: true,
      email: 'jane@acme.com',
      source: 'anymailfinder',
    });
    expect(smtpMock).not.toHaveBeenCalled();
  });

  it('reaches the pattern layer when no provider is configured', async () => {
    // The no-credentials path: no API key at all. Must still work.
    smtpMock.mockResolvedValue({ verdict: 'catch_all' });

    const result = await findEmail(CONTACT);

    expect(result).toMatchObject({ ok: true, source: 'pattern_guess' });
  });

  it('reports an SMTP-confirmed address as verified', async () => {
    smtpMock.mockResolvedValue(verdict('valid'));

    const result = await findEmail(CONTACT);

    expect(result).toMatchObject({
      ok: true,
      email: 'jane.doe@acme.com',
      source: 'smtp_verified',
      validation: 'valid',
    });
  });

  it('downgrades a catch-all domain to a guess and stops probing', async () => {
    smtpMock.mockResolvedValue(verdict('catch_all'));

    const result = await findEmail(CONTACT);

    expect(result).toMatchObject({
      ok: true,
      email: 'jane.doe@acme.com',
      source: 'pattern_guess',
      validation: 'catch_all',
    });
    // A catch-all answers identically for every candidate; probing on is waste.
    expect(smtpMock).toHaveBeenCalledTimes(1);
  });

  it('refuses to answer when the server rejected every candidate', async () => {
    smtpMock.mockResolvedValue(verdict('invalid'));

    const result = await findEmail(CONTACT);

    // Returning the top pattern here would hand outreach an address the
    // domain's own mail server said does not exist.
    expect(result.ok).toBe(false);
    expect(result.email).toBeUndefined();
  });

  it('still guesses when verification was inconclusive rather than negative', async () => {
    smtpMock.mockResolvedValue(verdict('unknown'));

    const result = await findEmail(CONTACT);

    expect(result).toMatchObject({
      ok: true,
      email: 'jane.doe@acme.com',
      source: 'pattern_guess',
      validation: 'guess',
    });
  });

  it('never returns an address the server explicitly rejected', async () => {
    // Mixed verdicts: the top-weighted pattern is rejected, a later one is
    // inconclusive. Returning `patterns[0]` here would hand outreach an address
    // the domain's own mail server said does not exist.
    smtpMock.mockImplementation((email: string) =>
      Promise.resolve(
        email === 'jane.doe@acme.com'
          ? { verdict: 'invalid' }
          : { verdict: 'unknown' },
      ),
    );

    const result = await findEmail(CONTACT);

    expect(result.ok).toBe(true);
    expect(result.source).toBe('pattern_guess');
    expect(result.email).not.toBe('jane.doe@acme.com');
  });

  it('gives up when no mail domain resolves', async () => {
    domainMock.mockResolvedValue(null);

    const result = await findEmail(CONTACT);

    expect(result.ok).toBe(false);
    expect(smtpMock).not.toHaveBeenCalled();
  });
});
