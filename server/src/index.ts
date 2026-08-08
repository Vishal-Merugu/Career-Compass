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
import { NotFoundError } from './errors/AppError.js';
import { authRouter } from './auth/routes.js';
import { configRouter } from './api/config.router.js';
import { profilesRouter } from './api/profiles.router.js';
import { campaignsRouter } from './api/campaigns.router.js';
import { outreachSettingsRouter } from './api/outreachSettings.router.js';
import { jobsRouter } from './api/jobs.router.js';
import { syncRouter } from './api/sync.router.js';
import { emailLookupsRouter } from './api/emailLookups.router.js';
import { sessionRouter } from './api/session.router.js';
import { SchedulerService } from './services/scheduler.service.js';
import { telegramBotService } from './telegram/bot.js';
import { initRedis, redisClient } from './lib/redis.js';
import { initWsGateway } from './ws-gateway/index.js';
import {
  startTimeoutSweeper,
  stopTimeoutSweeper,
} from './orchestrator/timeoutSweeper.js';
import {
  startEmailLookupWorker,
  stopEmailLookupWorker,
} from './workers/emailLookupWorker.js';
import { startScrapeWorker, stopScrapeWorker } from './workers/scrapeWorker.js';

const app = express();

// The dashboard is served same-origin, so it needs no CORS allowance at all.
// The only legitimate cross-origin caller is the Chrome extension, and every
// one of its requests carries a `chrome-extension://` origin — it declares no
// content scripts, so nothing ever calls this API from a linkedin.com page.
//
// The default used to be `['*']`, which reflected whatever Origin was sent.
// That was survivable only because credentials are off (below); it was one
// line away from letting any website read a signed-in user's data.
const allowedOrigins =
  process.env.CORS_ORIGIN?.split(',')
    .map((o) => o.trim())
    .filter(Boolean) ?? [];

const corsOptions = {
  origin: (
    origin: string | undefined,
    callback: (err: Error | null, allow?: boolean) => void,
  ) => {
    // No Origin header: same-origin requests, curl, the Telegram bot.
    const allowed =
      !origin ||
      origin.startsWith('chrome-extension://') ||
      allowedOrigins.includes(origin);
    // `false` omits the CORS headers and lets the browser block it. Passing an
    // Error here instead would surface as an opaque 500 through errorHandler.
    callback(null, allowed);
  },
  // Never enable this. The dashboard session is a cookie, and allowing
  // credentialed cross-origin reads would turn any gap in the origin list above
  // into account takeover. The extension authenticates with a header, not a
  // cookie, so it does not need credentialed CORS.
  credentials: false,
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
// Mounted at /api, not /api/profiles: this router's own routes are already
// `/profiles` and `/companies`, so the deeper mount served them at
// /api/profiles/profiles and /api/profiles/companies. Nothing consumed either
// path — the extension does not call them — so the mount is the bug, not the
// routes.
app.use('/api', profilesRouter);
// Paths inside are already prefixed /campaigns — mounting at /api/campaigns
// would compose to /api/campaigns/campaigns.
app.use('/api', campaignsRouter);
app.use('/api', outreachSettingsRouter);
app.use('/api/sync', syncRouter);
app.use('/api/session', sessionRouter);
app.use('/api', jobsRouter);
// Paths inside are already prefixed /email-lookups.
app.use('/api', emailLookupsRouter);

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ ok: true, timestamp: new Date() });
});

// Unmatched /api/* must fail as JSON. Without this, Express's built-in 404
// replies with an HTML error page, and a client that mistypes a route gets a
// parse error instead of a status code it can act on.
app.use('/api', (_req, _res, next) => {
  next(new NotFoundError('API route not found'));
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

  // Reclaims abandoned lookup leases and finishes anything the extension never
  // claimed. See workers/emailLookupWorker.ts.
  startEmailLookupWorker();

  // Makes the LinkedIn calls the extension used to make. See
  // workers/scrapeWorker.ts and docs/adr/0007-server-side-linkedin-calls.md.
  startScrapeWorker();

  // Redis is required — see initRedis. This callback is async, so a throw here
  // would surface as an unhandled rejection and leave a listening socket on a
  // server that cannot dispatch campaigns. Exit deliberately instead.
  try {
    await initRedis();
  } catch {
    server.close();
    process.exit(1);
  }

  // Start scheduled cron tasks
  SchedulerService.start();

  // Sweep for orphaned scraped profiles to resume qualification
  const { QualificationWorker } =
    await import('./workers/qualificationWorker.js');
  await QualificationWorker.getInstance().sweepOrphanedProfiles();

  // Campaign send worker. Started after initRedis so a queue connection is
  // only opened once Redis is known to be reachable.
  const { startCampaignWorker } = await import('./queue/campaignQueue.js');
  const { processCampaignContact, resumeInterruptedCampaigns } =
    await import('./services/campaign.service.js');
  startCampaignWorker(processCampaignContact);
  await resumeInterruptedCampaigns().catch((err) => {
    logger.error(err, 'Failed to resume interrupted campaigns');
  });

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
  stopEmailLookupWorker();
  stopScrapeWorker();

  server.close(async () => {
    logger.info('HTTP server closed.');
    try {
      telegramBotService.stop();
      logger.info('Telegram bot polling stopped.');

      // Close the worker before Redis. It holds a blocking read; tearing the
      // connection out from under it logs a spurious error on every shutdown,
      // and an in-flight send would be abandoned mid-SMTP rather than
      // finishing and recording its result.
      try {
        const { closeCampaignQueue } = await import('./queue/campaignQueue.js');
        const { closeQueueConnection } = await import('./queue/connection.js');
        await closeCampaignQueue();
        await closeQueueConnection();
        logger.info('Campaign queue closed.');
      } catch (queueErr) {
        logger.error(queueErr, 'Error closing campaign queue');
      }

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
