import { Request, Response, NextFunction } from 'express';

const rateLimitMap = new Map<string, { count: number; resetTime: number }>();

// Prune expired entries every 60 seconds to prevent unbounded memory growth
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of rateLimitMap) {
    if (now > entry.resetTime) {
      rateLimitMap.delete(key);
    }
  }
}, 60_000).unref(); // .unref() ensures this doesn't keep the process alive on shutdown

/**
 * Standard, lightweight in-memory rate limiter middleware.
 *
 * `scope` is not optional decoration. The map is module-level and was keyed on
 * the client IP alone, so every route sharing an IP shared one counter *and*
 * one window — whichever route the client hit first decided the `windowMs` and
 * `maxRequests` that then applied to all of them. Login and register have
 * different budgets on purpose; without a scope they silently pooled.
 *
 * Note on `req.ip`: `trust proxy` is deliberately NOT set on the app. Nothing
 * sits in front of this server, and enabling it would let any client spoof its
 * address with an `X-Forwarded-For` header and walk straight past this limiter.
 * If a reverse proxy is ever added, set `trust proxy` to that hop count — never
 * to `true`.
 *
 * In-memory means per-process and reset on deploy. Fine for one container;
 * move to Redis if this is ever scaled out.
 */
export function rateLimiter(
  windowMs: number,
  maxRequests: number,
  scope: string,
) {
  return (req: Request, res: Response, next: NextFunction) => {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const key = `${scope}:${ip}`;
    const now = Date.now();
    const clientLimit = rateLimitMap.get(key);

    if (!clientLimit || now > clientLimit.resetTime) {
      rateLimitMap.set(key, { count: 1, resetTime: now + windowMs });
      return next();
    }

    clientLimit.count++;
    if (clientLimit.count > maxRequests) {
      res.setHeader(
        'Retry-After',
        Math.max(1, Math.ceil((clientLimit.resetTime - now) / 1000)),
      );
      return res.status(429).json({
        ok: false,
        error: 'Too many requests. Please try again later.',
      });
    }

    next();
  };
}
