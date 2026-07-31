import cron from 'node-cron';
import { logger } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';

export class SchedulerService {
  /**
   * Start background cron schedule workers
   */
  public static start(): void {
    // 1. Midnight job — create fresh daily stats for all users (0 0 * * *)
    cron.schedule('0 0 * * *', async () => {
      logger.info('[Scheduler] Running midnight daily stats reset cron...');
      try {
        const today = new Date().toISOString().split('T')[0];
        const users = await prisma.user.findMany({ select: { id: true } });

        for (const user of users) {
          await prisma.dailyStats.upsert({
            where: {
              userId_date: { userId: user.id, date: today },
            },
            create: { userId: user.id, date: today },
            update: {}, // Don't overwrite if already exists
          });
        }

        logger.info(
          `[Scheduler] Created daily stats records for ${users.length} users (${today})`,
        );
      } catch (err) {
        logger.error(err, '[Scheduler] Midnight daily reset cron failed');
      }
    });

    // 2. Hourly cleanup — prune activity logs older than 30 days (0 * * * *)
    cron.schedule('0 * * * *', async () => {
      try {
        const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
        const result = await prisma.activityLog.deleteMany({
          where: { createdAt: { lt: cutoff } },
        });
        if (result.count > 0) {
          logger.info(
            `[Scheduler] Pruned ${result.count} activity logs older than 30 days`,
          );
        }
      } catch (err) {
        logger.error(err, '[Scheduler] Hourly log cleanup cron failed');
      }
    });
  }
}
