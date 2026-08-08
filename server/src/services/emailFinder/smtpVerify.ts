// ─── SMTP Recipient Verification ─────────────────────────────────
// Ask the company's own mail server whether an address exists, using the
// same RCPT TO probe every commercial verifier uses. Free, no API key, no
// captcha — which is the whole reason this layer exists.
//
// Two things to understand before trusting a result:
//
//   1. Most companies run Google Workspace or Microsoft 365, and both accept
//      every recipient at the edge. That yields `catch_all`, not `valid`.
//      A `catch_all` verdict means "cannot be disproved", nothing stronger.
//   2. Outbound port 25 is blocked by most hosting providers. If it is
//      blocked on the VM this whole layer degrades to `unknown` and the
//      caller falls back to a weighted guess. Probe before relying on it.

import net from 'node:net';
import { promises as dns } from 'node:dns';
import { logger } from '../../lib/logger.js';

export type SmtpVerdict =
  'valid' | 'invalid' | 'catch_all' | 'unknown' | 'blocked';

export interface SmtpVerifyResult {
  verdict: SmtpVerdict;
  /** Raw final SMTP reply, kept for diagnosis. */
  detail?: string;
}

/** Identity used in the SMTP conversation. Never actually sends mail. */
const PROBE_HELO_HOST = process.env.SMTP_PROBE_HELO || 'localhost';
const PROBE_MAIL_FROM = process.env.SMTP_PROBE_FROM || 'verify@localhost';

const CONNECT_TIMEOUT_MS = 10_000;
const COMMAND_TIMEOUT_MS = 8_000;

interface SmtpSession {
  send(command: string): Promise<string>;
  close(): void;
}

/**
 * Open an SMTP session and expose a request/response interface.
 * Each reply is read to its final line — SMTP multi-line replies use
 * `250-` for continuations and `250 ` for the last one, so reading a single
 * chunk and calling it a reply desynchronises the whole conversation.
 */
function openSession(host: string, port = 25): Promise<SmtpSession> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    socket.setEncoding('ascii');

    let buffer = '';
    let pending: {
      resolve: (reply: string) => void;
      reject: (err: Error) => void;
      timer: NodeJS.Timeout;
    } | null = null;

    const isComplete = (text: string): boolean =>
      /^\d{3} [^\n]*\r?\n$|\n\d{3} [^\n]*\r?\n$/.test(text);

    const settlePending = (): void => {
      if (!pending || !isComplete(buffer)) return;
      const reply = buffer;
      buffer = '';
      clearTimeout(pending.timer);
      const { resolve: done } = pending;
      pending = null;
      done(reply);
    };

    socket.on('data', (chunk: string) => {
      buffer += chunk;
      settlePending();
    });

    socket.on('error', (err) => {
      if (pending) {
        clearTimeout(pending.timer);
        pending.reject(err);
        pending = null;
      }
      reject(err);
    });

    const connectTimer = setTimeout(() => {
      socket.destroy();
      reject(new Error('SMTP connect timeout'));
    }, CONNECT_TIMEOUT_MS);

    const session: SmtpSession = {
      send(command: string) {
        return new Promise<string>((sendResolve, sendReject) => {
          if (pending) {
            sendReject(new Error('SMTP command already in flight'));
            return;
          }
          const timer = setTimeout(() => {
            pending = null;
            sendReject(new Error(`SMTP timeout after: ${command.trim()}`));
          }, COMMAND_TIMEOUT_MS);

          pending = { resolve: sendResolve, reject: sendReject, timer };
          socket.write(command);
          // A reply may already be buffered from a previous read.
          settlePending();
        });
      },
      close() {
        socket.destroy();
      },
    };

    // The server speaks first with its 220 greeting.
    const greetingTimer = setTimeout(() => {
      socket.destroy();
      reject(new Error('SMTP greeting timeout'));
    }, CONNECT_TIMEOUT_MS);

    socket.once('connect', () => {
      clearTimeout(connectTimer);
      pending = {
        resolve: (greeting: string) => {
          clearTimeout(greetingTimer);
          if (!greeting.startsWith('220')) {
            socket.destroy();
            reject(new Error(`Unexpected SMTP greeting: ${greeting.trim()}`));
            return;
          }
          resolve(session);
        },
        reject,
        timer: greetingTimer,
      };
      settlePending();
    });
  });
}

const replyCode = (reply: string): number =>
  Number.parseInt(reply.trim().slice(0, 3), 10);

/**
 * Verify a single address against its domain's mail exchanger.
 *
 * Catch-all detection costs one extra RCPT for a random local part on the
 * same connection. Without it, a Google Workspace domain reports every
 * guess as `valid` and the whole pattern layer becomes noise.
 */
export async function verifyEmailViaSmtp(
  email: string,
): Promise<SmtpVerifyResult> {
  const domain = email.split('@')[1];
  if (!domain) return { verdict: 'unknown', detail: 'malformed address' };

  let exchanger: string;
  try {
    const records = await dns.resolveMx(domain);
    if (records.length === 0) return { verdict: 'invalid', detail: 'no MX' };
    exchanger = records.sort((a, b) => a.priority - b.priority)[0].exchange;
  } catch (err) {
    // `unknown`, not `invalid`. A transient resolver failure is not evidence
    // that the domain rejects mail, and `invalid` counts toward the
    // "every candidate was rejected" tally that makes the finder report a hard
    // miss — so a DNS blip would turn into "this person has no email".
    const detail = err instanceof Error ? err.message : 'MX lookup failed';
    return { verdict: 'unknown', detail: `MX lookup failed: ${detail}` };
  }

  let session: SmtpSession | null = null;
  try {
    session = await openSession(exchanger);

    const ehlo = await session.send(`EHLO ${PROBE_HELO_HOST}\r\n`);
    if (replyCode(ehlo) >= 400) {
      return { verdict: 'unknown', detail: `EHLO rejected: ${ehlo.trim()}` };
    }

    const mailFrom = await session.send(`MAIL FROM:<${PROBE_MAIL_FROM}>\r\n`);
    if (replyCode(mailFrom) >= 400) {
      return {
        verdict: 'unknown',
        detail: `MAIL FROM rejected: ${mailFrom.trim()}`,
      };
    }

    const rcpt = await session.send(`RCPT TO:<${email}>\r\n`);
    const code = replyCode(rcpt);

    // 4xx is greylisting or throttling — the address is not disproved.
    if (code >= 400 && code < 500) {
      return { verdict: 'unknown', detail: rcpt.trim() };
    }
    if (code >= 500) {
      return { verdict: 'invalid', detail: rcpt.trim() };
    }

    // Accepted. Now find out whether this server accepts anything at all.
    const decoy = `${randomLocalPart()}@${domain}`;
    const decoyReply = await session.send(`RCPT TO:<${decoy}>\r\n`);
    if (replyCode(decoyReply) < 400) {
      return { verdict: 'catch_all', detail: 'server accepts any recipient' };
    }

    return { verdict: 'valid', detail: rcpt.trim() };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    // ECONNREFUSED / ETIMEDOUT *on connect* is almost always the host's own
    // egress firewall, not the remote server. Distinguish it so the caller can
    // stop retrying a layer that structurally cannot work here.
    //
    // Deliberately narrow. `blocked` latches SMTP verification off for the whole
    // process, and a bare /timeout/ match also catches a per-command timeout
    // from one tarpitting MX — so a single slow mail server used to disable
    // verification for every domain until restart.
    const connectFailed =
      /ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|ECONNRESET/i.test(message) ||
      /connect timeout/i.test(message);

    if (connectFailed) {
      logger.debug(`[EmailFinder] SMTP egress unreachable (${message})`);
      return { verdict: 'blocked', detail: message };
    }

    if (/timeout/i.test(message)) {
      // The remote server went quiet mid-conversation. Its problem, not ours.
      logger.debug(`[EmailFinder] SMTP command timed out (${message})`);
      return { verdict: 'unknown', detail: message };
    }

    return { verdict: 'unknown', detail: message };
  } finally {
    try {
      await session?.send('QUIT\r\n');
    } catch {
      // The server frequently drops the connection on QUIT. Not a failure.
    }
    session?.close();
  }
}

function randomLocalPart(): string {
  return `cc-probe-${Math.random().toString(36).slice(2, 12)}`;
}
