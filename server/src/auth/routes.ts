import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { signToken } from './jwt.js';
import { ValidationError, AuthError } from '../errors/AppError.js';
import { requireAuth } from './middleware.js';
import { setSessionCookie, clearSessionCookie } from './cookies.js';
import { rateLimiter } from '../middleware/rateLimiter.js';

const router = Router();

const authSchema = z.object({
  email: z.string().email('Invalid email address'),
  password: z.string().min(8, 'Password must be at least 8 characters'),
});

router.post(
  '/register',
  rateLimiter(15 * 60 * 1000, 100),
  async (req, res, next) => {
    try {
      const { email, password } = authSchema.parse(req.body);

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
  rateLimiter(15 * 60 * 1000, 100),
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

router.get('/me', requireAuth, (req, res) => {
  res.status(200).json({
    ok: true,
    user: req.user,
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
