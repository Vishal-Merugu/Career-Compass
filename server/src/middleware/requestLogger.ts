import pinoHttpModule from 'pino-http';
import { logger } from '../lib/logger.js';

const pinoHttp = pinoHttpModule as any;

export const requestLogger = pinoHttp({
  logger,
  serializers: {
    req(req: any) {
      return {
        method: req.method,
        url: req.url,
      };
    },
    res(res: any) {
      return {
        statusCode: res.statusCode,
      };
    },
  },
  customSuccessMessage(req: any, res: any) {
    return `${req.method} ${req.url} completed with status ${res.statusCode}`;
  },
  customErrorMessage(req: any, res: any, err: any) {
    return `${req.method} ${req.url} failed: ${err.message}`;
  },
  autoLogging: {
    ignore(req: any) {
      // Ignore noisy polling endpoints
      if (
        req.url.includes('/api/sync/daily-stats') ||
        req.url.includes('/api/sync/activity-log') ||
        req.url.match(/\/api\/jobs\/.*\/status/)
      ) {
        return true;
      }
      return false;
    },
  },
});
