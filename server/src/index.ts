import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import bcrypt from 'bcryptjs';
import { resolve, join } from 'node:path';
import { existsSync } from 'node:fs';
import { env } from './config/env.js';
import { logger } from './lib/logger.js';
import { prisma } from './lib/prisma.js';
import { requestLogger } from './middleware/requestLogger.js';
import { errorHandler } from './middleware/errorHandler.js';
import { authRouter } from './auth/routes.js';
import { configRouter } from './api/config.router.js';
import { profilesRouter } from './api/profiles.router.js';
import { jobsRouter } from './api/jobs.router.js';
import { syncRouter } from './api/sync.router.js';
import { SchedulerService } from './services/scheduler.service.js';
import { telegramBotService } from './telegram/bot.js';
import { initRedis, redisClient } from './lib/redis.js';
import { initWsGateway } from './ws-gateway/index.js';
import {
  startTimeoutSweeper,
  stopTimeoutSweeper,
} from './orchestrator/timeoutSweeper.js';

const app = express();

const allowedOrigins = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(',')
  : ['*'];

const corsOptions = {
  origin: (
    origin: string | undefined,
    callback: (err: Error | null, allow?: boolean) => void,
  ) => {
    if (
      !origin ||
      allowedOrigins.includes('*') ||
      allowedOrigins.includes(origin) ||
      origin.startsWith('chrome-extension://')
    ) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
};

// `upgrade-insecure-requests` is in helmet's default CSP, and it tells the
// browser to rewrite every http:// subresource URL to https://. The VM serves
// the dashboard as plain HTTP on a private IP with nothing listening on 443, so
// leaving it on would upgrade the page's own /assets/*.js and render a blank
// page. Dropped unless HTTPS is actually terminated in front of us — the same
// condition that gates the `secure` cookie flag in auth/cookies.ts.
const isHttps = process.env.HTTPS === 'true';

app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: isHttps ? {} : { upgradeInsecureRequests: null },
    },
  }),
);
app.use(cors(corsOptions));
app.use(compression());
app.use(express.json());
// Reads the httpOnly session cookie the dashboard authenticates with.
app.use(cookieParser());
app.use(requestLogger);

// Mount API routers
app.use('/api/auth', authRouter);
app.use('/api/config', configRouter);
app.use('/api/profiles', profilesRouter);
app.use('/api/sync', syncRouter);
app.use('/api', jobsRouter);

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ ok: true, timestamp: new Date() });
});

// ─── Web dashboard ───────────────────────────────────────────────
// Built by `client/` (Vite) into `server/public`, served same-origin so the
// client calls /api/... as a relative path — no CORS, no mixed content.
// See docs/adr/0004-same-origin-web-dashboard.md.
//
// Registered AFTER the API routers so /api/* always wins, and the SPA fallback
// deliberately excludes /api and /health so a wrong URL there still 404s as JSON
// instead of silently returning the dashboard's index.html.
const webRoot = resolve(process.cwd(), 'public');

if (existsSync(webRoot)) {
  app.use(express.static(webRoot));
  app.get(/^(?!\/(api|health)(\/|$)).*/, (_req, res) => {
    res.sendFile(join(webRoot, 'index.html'));
  });
  logger.info(`🖥️  Serving web dashboard from ${webRoot}`);
} else {
  logger.warn(
    `No web build at ${webRoot} — API only. Run \`npm run build:client\` to generate it.`,
  );
}

// Mount error handler middleware
app.use(errorHandler);

// Start server
const server = app.listen(env.PORT, async () => {
  logger.info(
    `🚀 CareerCompass Backend Server started on port ${env.PORT} in ${env.NODE_ENV} mode`,
  );

  // Initialize Socket.io WebSocket Gateway
  initWsGateway(server);

  // Start Orchestrator timeout sweeper
  startTimeoutSweeper();

  // Initialize Redis client
  await initRedis();

  // Start scheduled cron tasks
  SchedulerService.start();

  // Sweep for orphaned scraped profiles to resume qualification
  const { QualificationWorker } =
    await import('./workers/qualificationWorker.js');
  await QualificationWorker.getInstance().sweepOrphanedProfiles();

  // Initialize Telegram Bot
  telegramBotService.initialize().catch((err) => {
    logger.error(err, 'Failed to initialize Telegram Bot');
  });
});

// Graceful shutdown handler
const gracefulShutdown = async () => {
  logger.info('Received shutdown signal. Stopping services...');

  // Stop Orchestrator sweeper
  stopTimeoutSweeper();

  server.close(async () => {
    logger.info('HTTP server closed.');
    try {
      telegramBotService.stop();
      logger.info('Telegram bot polling stopped.');

      try {
        await redisClient.disconnect();
        logger.info('Redis disconnected.');
      } catch (redisErr) {
        logger.error(redisErr, 'Error disconnecting Redis client');
      }
      await prisma.$disconnect();
      logger.info('Prisma disconnected.');

      process.exit(0);
    } catch (err) {
      logger.error(err, 'Error occurred while closing services:');
      process.exit(1);
    }
  });

  // Force shutdown if cleanup takes too long
  setTimeout(() => {
    logger.error('Forced shutdown due to timeout.');
    process.exit(1);
  }, 10000);
};

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);
