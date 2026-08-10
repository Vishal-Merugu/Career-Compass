// ─── Short-lived codes for linking a Telegram account ────────────
//
// Linking used to be `/link <your_api_key>`, with the bot's welcome message
// telling people to "retrieve your API key from your browser extension
// configuration settings page". That page no longer exists — configuration
// moved to the dashboard (ADR 0008) — so the instruction pointed at nothing.
//
// It was also the wrong credential to use. The API key is long-lived, works
// from anywhere, and never expires; sending it as a chat message writes it
// permanently into Telegram's message history and onto their servers. A code
// that is good for one link and ten minutes cannot be replayed later.
//
// In memory on purpose. A code outliving a restart has no value — the user is
// standing at the screen that issued it — and this avoids a table and a
// migration for state whose whole point is being short-lived.

import { randomInt } from 'node:crypto';

/** Long enough that guessing is hopeless within the window, short enough to retype. */
const CODE_LENGTH = 8;
const TTL_MS = 10 * 60 * 1000;

/** No 0/O/1/I/L — these get read aloud and typed on a phone. */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

interface Pending {
  userId: string;
  expiresAt: number;
}

const codes = new Map<string, Pending>();

function sweep(): void {
  const now = Date.now();
  for (const [code, pending] of codes) {
    if (pending.expiresAt <= now) codes.delete(code);
  }
}

export interface IssuedCode {
  code: string;
  expiresInSeconds: number;
}

/**
 * Issue a code for one account, replacing any code it already has.
 *
 * One live code per user: asking for a new one should invalidate the old,
 * otherwise a code read off a screen an hour ago still works.
 */
export function issueLinkCode(userId: string): IssuedCode {
  sweep();

  for (const [code, pending] of codes) {
    if (pending.userId === userId) codes.delete(code);
  }

  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += ALPHABET[randomInt(ALPHABET.length)];
  }

  codes.set(code, { userId, expiresAt: Date.now() + TTL_MS });

  return { code, expiresInSeconds: Math.floor(TTL_MS / 1000) };
}

/**
 * Redeem a code, returning the user it belongs to.
 *
 * Single use — deleted whether or not it had expired, so a leaked code cannot
 * be retried.
 */
export function consumeLinkCode(input: string): string | null {
  sweep();

  const code = input.trim().toUpperCase();
  const pending = codes.get(code);
  if (!pending) return null;

  codes.delete(code);
  return pending.expiresAt > Date.now() ? pending.userId : null;
}
