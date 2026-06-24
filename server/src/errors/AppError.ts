export enum ErrorCode {
  VALIDATION_ERROR = 'VALIDATION_ERROR',
  UNAUTHORIZED = 'UNAUTHORIZED',
  FORBIDDEN = 'FORBIDDEN',
  NOT_FOUND = 'NOT_FOUND',
  LINKEDIN_SESSION_EXPIRED = 'LINKEDIN_SESSION_EXPIRED',
  INTERNAL_ERROR = 'INTERNAL_ERROR',
  WORKFLOW_RUNNING = 'WORKFLOW_RUNNING',
  SERVER_RUN_DISABLED = 'SERVER_RUN_DISABLED',
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

export class LinkedInSessionError extends AppError {
  constructor(
    message = 'LinkedIn session is expired or invalid. Please re-push cookies.',
  ) {
    super(message, 401, ErrorCode.LINKEDIN_SESSION_EXPIRED);
  }
}
