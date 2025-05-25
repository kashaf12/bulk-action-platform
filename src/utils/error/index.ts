export class DatabaseError extends Error {
  public code?: string;
  public originalError?: Error;

  constructor(message: string, code?: string, originalError?: Error) {
    super(message);
    this.name = 'DatabaseError';
    this.code = code;
    this.originalError = originalError;
    Error.captureStackTrace(this, DatabaseError);
  }
}

export class ServiceUnavailableError extends Error {
  public code: string;

  constructor(message: string, code = 'SERVICE_UNAVAILABLE') {
    super(message);
    this.name = 'ServiceUnavailableError';
    this.code = code;
    Error.captureStackTrace(this, ServiceUnavailableError);
  }
}

export class ValidationError extends Error {
  details?: unknown;
  constructor(message: string, details?: unknown) {
    super(message);
    this.name = 'ValidationError';
    this.details = details;
  }
}

export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
  }
}

export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConflictError';
  }
}

export class TooManyRequestsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TooManyRequestsError';
  }
}
