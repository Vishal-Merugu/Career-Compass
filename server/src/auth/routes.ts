import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { signToken } from './jwt.js';
import {
  ValidationError,
  AuthError,
  ForbiddenError,
} from '../errors/AppError.js';
import { requireAuth } from './middleware.js';
import { setSessionCookie, clearSessionCookie } from './cookies.js';
import { rateLimiter } from '../middleware/rateLimiter.js';

const router = Router();

const authSchema = z.object({
  email: z.string().email('Invalid email address'),
  password: z.string().min(8, 'Password must be at least 8 characters'),
});

const registerSchema = authSchema.extend({
  registrationToken: z.string().optional(),
});

/** Constant-time compare that does not leak length via an early return. */
function tokensMatch(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) {
    // Still burn a comparison so the timing does not distinguish
    // "wrong length" from "wrong value".
    timingSafeEqual(a, a);
    return false;
  }
  return timingSafeEqual(a, b);
}

/**
 * Gate on who may create an account.
 *
 * Registration used to be open to anyone who could reach the server, with the
 * VPN as the only control. It is now closed once the instance has an owner:
 *
 * - **No users yet** → allowed, so a fresh deployment can bootstrap itself.
 * - **Users exist** → requires `REGISTRATION_TOKEN` to be set in the server
 *   environment AND matched by the caller, via the `x-registration-token`
 *   header or a `registrationToken` field in the body.
 *
 * An existing deployment that never sets the variable therefore ends up with
 * registration closed, which is the intended default.
 */
async function assertMayRegister(provided: string | undefined): Promise<void> {
  const existingUsers = await prisma.user.count();
  if (existingUsers === 0) {
    return;
  }

  const expected = process.env.REGISTRATION_TOKEN;
  if (!expected || !provided || !tokensMatch(provided, expected)) {
    throw new ForbiddenError('Registration is closed on this server');
  }
}

router.post(
  '/register',
  // 5 per 15 min: creating an account is a rare, deliberate act. The old budget
  // of 100 was a brute-force allowance shared with /login.
  rateLimiter(15 * 60 * 1000, 5, 'register'),
  async (req, res, next) => {
    try {
      const { email, password, registrationToken } = registerSchema.parse(
        req.body,
      );

      const headerToken = req.get('x-registration-token') ?? undefined;
      await assertMayRegister(registrationToken ?? headerToken);

      const existingUser = await prisma.user.findUnique({ where: { email } });
      if (existingUser) {
        throw new ValidationError('Email is already registered');
      }

      const passwordHash = await bcrypt.hash(password, 10);

      const user = await prisma.user.create({
        data: {
          email,
          passwordHash,
          config: {
            create: {
              isServerRun: true,
            },
          },
        },
        select: { id: true, email: true, apiKey: true },
      });

      const token = signToken({ userId: user.id, email: user.email });
      setSessionCookie(res, token);

      // `token` stays in the body for API clients; the dashboard ignores it and
      // relies on the httpOnly cookie set above.
      res.status(201).json({
        ok: true,
        token,
        apiKey: user.apiKey,
        user: { id: user.id, email: user.email },
      });
    } catch (err) {
      if (err instanceof z.ZodError) {
        return next(
          new ValidationError('Invalid registration input', err.errors),
        );
      }
      next(err);
    }
  },
);

router.post(
  '/login',
  // 10 per 15 min per IP. The previous 100 was a generous budget for guessing
  // an 8-character minimum password, and it was shared with /register.
  rateLimiter(15 * 60 * 1000, 10, 'login'),
  async (req, res, next) => {
    try {
      const { email, password } = authSchema.parse(req.body);

      const user = await prisma.user.findUnique({
        where: { email },
        select: { id: true, email: true, passwordHash: true, apiKey: true },
      });

      if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
        throw new AuthError('Invalid email or password');
      }

      const token = signToken({ userId: user.id, email: user.email });
      setSessionCookie(res, token);

      res.status(200).json({
        ok: true,
        token,
        apiKey: user.apiKey,
        user: { id: user.id, email: user.email },
      });
    } catch (err) {
      if (err instanceof z.ZodError) {
        return next(new ValidationError('Invalid login input', err.errors));
      }
      next(err);
    }
  },
);

/**
 * Who am I. Deliberately does NOT echo `req.user` wholesale: that object
 * carries `apiKey`, the extension's long-lived credential.
 *
 * The dashboard's session is an httpOnly cookie precisely so that script on the
 * page cannot steal it (ADR 0004). Returning the API key here would hand that
 * back — an XSS could not read the cookie, but it could call this endpoint and
 * walk away with a credential that works from anywhere, over `x-api-key`, and
 * never expires. The key is issued at register/login, where it is asked for.
 */
router.get('/me', requireAuth, (req, res) => {
  const { id, email, telegramId } = req.user!;
  res.status(200).json({
    ok: true,
    user: { id, email, telegramId },
  });
});

/**
 * Drop the browser session. The extension's API key is unaffected — it is a
 * separate credential and is not issued or revoked here.
 */
router.post('/logout', (_req, res) => {
  clearSessionCookie(res);
  res.status(200).json({ ok: true });
});

export const authRouter = router;
