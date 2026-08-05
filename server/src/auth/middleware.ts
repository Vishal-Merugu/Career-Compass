import { Request, Response, NextFunction } from 'express';
import { prisma } from '../lib/prisma.js';
import { verifyToken } from './jwt.js';
import { AuthError } from '../errors/AppError.js';
import { SESSION_COOKIE } from './cookies.js';

/**
 * Extract the session JWT from either transport.
 *
 * `Authorization: Bearer` is the original path and still works for scripts and
 * API clients. The httpOnly cookie is what the web dashboard uses — the browser
 * attaches it automatically, so no token ever reaches JavaScript.
 * See docs/adr/0004-same-origin-web-dashboard.md.
 */
export function extractSessionToken(req: Request): string | null {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.slice('Bearer '.length) || null;
  }
  return req.cookies?.[SESSION_COOKIE] ?? null;
}

// Declaration merging to add user to Express Request
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: {
        id: string;
        email: string;
        apiKey: string;
        telegramId?: string | null;
      };
    }
  }
}

/**
 * Middleware enforcing JWT verification (for UI requests)
 */
export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const token = extractSessionToken(req);
    if (!token) {
      throw new AuthError('Missing session cookie or authorization header');
    }

    const decoded = verifyToken(token);

    const user = await prisma.user.findUnique({
      where: { id: decoded.userId },
      select: { id: true, email: true, apiKey: true, telegramId: true },
    });

    if (!user) {
      throw new AuthError('User associated with token does not exist');
    }

    req.user = user;
    next();
  } catch (err) {
    next(
      err instanceof AuthError
        ? err
        : new AuthError('Invalid or expired authorization token'),
    );
  }
}

/**
 * Middleware enforcing API Key verification (for chrome extension)
 */
export async function requireApiKey(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const apiKey = req.headers['x-api-key'];
    if (!apiKey || typeof apiKey !== 'string') {
      throw new AuthError('Missing or invalid X-API-Key header');
    }

    const user = await prisma.user.findUnique({
      where: { apiKey },
      select: { id: true, email: true, apiKey: true, telegramId: true },
    });

    if (!user) {
      throw new AuthError('Invalid API key provided');
    }

    req.user = user;
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * Combined authentication middleware allowing either JWT or API Key
 */
export async function requireAuthOrApiKey(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  const apiKey = req.headers['x-api-key'];

  // Session token first (dashboard + scripts), API key second (extension).
  if (extractSessionToken(req)) {
    return requireAuth(req, res, next);
  } else if (apiKey) {
    return requireApiKey(req, res, next);
  } else {
    next(
      new AuthError(
        'Authentication credentials required (session cookie, JWT Bearer token, or X-API-Key)',
      ),
    );
  }
}
