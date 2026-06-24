import cron from 'node-cron';
import { logger } from '../lib/logger.js';

export class SchedulerService {
  /**
   * Start background cron schedule workers
   */
  public static start(): void {
    // 1. Midnight job (0 0 * * *)
    cron.schedule('0 0 * * *', () => {
      logger.info('Midnight daily reset cron worker executed.');
    });
  }
}
