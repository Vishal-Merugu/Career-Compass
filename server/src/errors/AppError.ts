import type { JobErrorCode } from './jobErrors.js';

export enum ErrorCode {
  VALIDATION_ERROR = 'VALIDATION_ERROR',
  UNAUTHORIZED = 'UNAUTHORIZED',
  FORBIDDEN = 'FORBIDDEN',
  NOT_FOUND = 'NOT_FOUND',
  LINKEDIN_SESSION_EXPIRED = 'LINKEDIN_SESSION_EXPIRED',
  LLM_ERROR = 'LLM_ERROR',
  INTERNAL_ERROR = 'INTERNAL_ERROR',
  WORKFLOW_RUNNING = 'WORKFLOW_RUNNING',
}

export class AppError extends Error {
  public statusCode: number;
  public errorCode: ErrorCode;
  public details?: any;

  constructor(
    message: string,
    statusCode = 500,
    errorCode = ErrorCode.INTERNAL_ERROR,
    details?: any,
  ) {
    super(message);
    this.name = this.constructor.name;
    this.statusCode = statusCode;
    this.errorCode = errorCode;
    this.details = details;
    Error.captureStackTrace(this, this.constructor);
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: any) {
    super(message, 400, ErrorCode.VALIDATION_ERROR, details);
  }
}

export class AuthError extends AppError {
  constructor(
    message = 'Unauthorized access',
    errorCode = ErrorCode.UNAUTHORIZED,
  ) {
    super(message, 401, errorCode);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'Forbidden access', errorCode = ErrorCode.FORBIDDEN) {
    super(message, 403, errorCode);
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Resource not found') {
    super(message, 404, ErrorCode.NOT_FOUND);
  }
}

/**
 * The AI model could not produce an answer.
 *
 * Carries a `JobErrorCode` so every layer above can tell *which* failure it
 * was without re-parsing the message: unreachable, wrong model, bad key, rate
 * limited, out of credit, unparseable output. That distinction is the whole
 * point — `qualificationWorker` must count these as infrastructure failures and
 * never as "this candidate was rejected".
 *
 * 502 rather than 500: the failure is in an upstream service we called.
 */
export class LlmError extends AppError {
  public readonly code: JobErrorCode;
  /** The provider's own words, kept for the collapsed technical detail. */
  public readonly detail?: string;
  public readonly model?: string;
  public readonly provider?: string;
  public readonly retryAfterSeconds?: number;

  constructor(
    code: JobErrorCode,
    message: string,
    context: {
      detail?: string;
      model?: string;
      provider?: string;
      retryAfterSeconds?: number;
    } = {},
  ) {
    super(message, 502, ErrorCode.LLM_ERROR, context.detail);
    this.code = code;
    this.detail = context.detail;
    this.model = context.model;
    this.provider = context.provider;
    this.retryAfterSeconds = context.retryAfterSeconds;
  }
}

export class LinkedInSessionError extends AppError {
  constructor(
    message = 'LinkedIn session is expired or invalid. Please re-push cookies.',
  ) {
    super(message, 401, ErrorCode.LINKEDIN_SESSION_EXPIRED);
  }
}
