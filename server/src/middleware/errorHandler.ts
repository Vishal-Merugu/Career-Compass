import { Request, Response, NextFunction } from 'express';
import { AppError, ErrorCode } from '../errors/AppError.js';
import { logger } from '../lib/logger.js';

export const errorHandler = (
  err: Error,
  req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  next: NextFunction,
) => {
  if (err instanceof AppError) {
    logger.warn(
      {
        err: {
          message: err.message,
          errorCode: err.errorCode,
          statusCode: err.statusCode,
          details: err.details,
        },
      },
      `AppError [${err.errorCode}]: ${err.message}`,
    );
    return res.status(err.statusCode).json({
      ok: false,
      error: {
        message: err.message,
        code: err.errorCode,
        details: err.details,
      },
    });
  }

  logger.error({ err }, `Unhandled server error: ${err.message}`);
  return res.status(500).json({
    ok: false,
    error: {
      message: 'An internal server error occurred',
      code: ErrorCode.INTERNAL_ERROR,
    },
  });
};
