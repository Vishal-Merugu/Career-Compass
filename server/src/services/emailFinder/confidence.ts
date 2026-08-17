// ─── Email source confidence ─────────────────────────────────────
//
// `emailSource` doubles as the confidence record: outreach sends real mail from
// the user's own Gmail, so a generated guess must never be indistinguishable
// from an address a provider confirmed. Two writers need the same ranking —
// the qualification worker and the lookup queue — so it lives here rather
// than being re-expressed at each call site.

/**
 * Higher is stronger evidence that the address exists.
 *
 * 3 — a provider or the domain's own mail server confirmed it.
 * 2 — a provider returned it without confirming deliverability.
 * 1 — generated from a name and a domain. Plausible, unproven.
 * 0 — no address.
 */
const STRENGTH: Record<string, number> = {
  // A key-authenticated API that returns a real business address from a
  // LinkedIn URL. Ranks with the other confirmed-provider sources: it is not a
  // pattern guess, so pressing "Find emails" again must not re-spend a lookup
  // on a profile it already resolved.
  linkfinder: 3,
  anymailfinder: 3,
  // The same provider, reached through its free web tool in the extension
  // rather than the metered API — it verifies the mailbox live before
  // answering, so it earns the same rank as the paid path. Kept as a separate
  // source because which one produced an address decides whether it cost a
  // credit, and that is the first question asked when the bill arrives.
  anymailfinder_web: 3,
  smtp_verified: 3,
  // Still live, and still produced — by the *extension*, not by this server.
  // The server-side Mailmeteor layer was deleted (Turnstile refuses an
  // automated browser), but the extension's widget driver reports this source
  // through the lookup queue, so the ranking has to keep recognising it.
  mailmeteor: 2,
  unknown: 1,
  pattern_guess: 1,
  not_found: 0,
  disabled: 0,
};

export function sourceStrength(source: string | null | undefined): number {
  if (!source) return 0;
  return STRENGTH[source] ?? 1;
}

/**
 * Is this address good enough that looking again would waste a credit?
 *
 * `pattern_guess` deliberately fails this: upgrading a guess to something
 * verified is the entire reason the lookup queue exists.
 */
export function isVerifiedSource(source: string | null | undefined): boolean {
  return sourceStrength(source) >= 2;
}

/**
 * Should a new result replace what is already stored?
 *
 * Strictly an upgrade check. A profile whose address came from Anymail Finder
 * must not be overwritten by a `pattern_guess` produced later by the fallback
 * sweep — that would silently downgrade a known-good address to a guess, and
 * the bounce would land on the user's own mailbox.
 *
 * Equal strength keeps the existing address: re-running a lookup should be
 * idempotent, not a coin flip between two guesses.
 */
export function isEmailUpgrade(
  current: { email: string | null; emailSource: string | null },
  candidate: { email: string | null; source: string | null },
): boolean {
  if (!candidate.email) return false;
  if (!current.email) return true;
  if (current.email === candidate.email) {
    // Same address, better provenance — worth recording, since it promotes a
    // guess to a confirmation without changing what gets mailed.
    return (
      sourceStrength(candidate.source) > sourceStrength(current.emailSource)
    );
  }
  return sourceStrength(candidate.source) > sourceStrength(current.emailSource);
}
