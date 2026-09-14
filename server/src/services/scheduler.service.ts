import cron from 'node-cron';
import { logger } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';
import { runEasyApplyDiscovery } from './jobFinder.service.js';

function localDateAndTime(timezone: string, now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const value = (type: string) =>
    parts.find((part) => part.type === type)?.value;
  return {
    date: `${value('year')}-${value('month')}-${value('day')}`,
    hour: value('hour'),
    minute: value('minute'),
  };
}

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

    // Check once per minute so every account can run at 09:00 in its own
    // IANA timezone. `lastRunOn` makes restarts and repeated ticks idempotent.
    cron.schedule('* * * * *', async () => {
      try {
        const schedules = await prisma.easyApplySchedule.findMany({
          where: { enabled: true },
          select: {
            id: true,
            userId: true,
            prompt: true,
            targetCount: true,
            timezone: true,
          },
        });

        for (const schedule of schedules) {
          let local;
          try {
            local = localDateAndTime(schedule.timezone);
          } catch {
            await prisma.easyApplySchedule.update({
              where: { id: schedule.id },
              data: {
                lastError:
                  'Invalid timezone. Choose a valid timezone in the Easy Apply schedule.',
              },
            });
            continue;
          }
          if (local.hour !== '09' || local.minute !== '00') continue;

          const claimed = await prisma.easyApplySchedule.updateMany({
            where: {
              id: schedule.id,
              OR: [{ lastRunOn: null }, { lastRunOn: { not: local.date } }],
            },
            data: {
              lastRunOn: local.date,
              lastRunAt: new Date(),
              lastError: null,
            },
          });
          if (claimed.count === 0) continue;

          logger.info(
            `[Scheduler] Starting daily Easy Apply discovery for user ${schedule.userId}`,
          );
          runEasyApplyDiscovery(
            schedule.prompt,
            schedule.userId,
            schedule.targetCount,
            true,
            undefined,
            false,
            'r86400',
          ).catch(async (err: Error) => {
            logger.error(err, '[Scheduler] Daily Easy Apply discovery failed');
            await prisma.easyApplySchedule.update({
              where: { id: schedule.id },
              data: { lastError: err.message },
            });
          });
        }
      } catch (err) {
        logger.error(err, '[Scheduler] Daily Easy Apply scheduler failed');
      }
    });
  }
}
