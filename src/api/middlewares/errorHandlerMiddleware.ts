import { Request, Response, NextFunction } from 'express';
import { logger } from '../../utils/logger';
import {
  sendConflict,
  sendError,
  sendNotFound,
  sendRateLimit,
  sendValidationError,
} from '../../utils/response';
import {
  ConflictError,
  DatabaseError,
  NotFoundError,
  TooManyRequestsError,
  ValidationError,
} from '../../utils/error';

import config from '../../config/app';

/**
 * Centralized error handling middleware
 * Converts errors to standardized API responses
 */

export const errorHandlerMiddleware = (
  error: Error,
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  const traceId = (req as any).traceId || 'unknown';

  // Log error with context
  logger.error('Request error', {
    traceId,
    error: {
      name: error.name,
      message: error.message,
      stack: error.stack,
    },
    request: {
      method: req.method,
      url: req.url,
      accountId: (req as any).accountId,
      userAgent: req.get('User-Agent'),
      ip: req.ip,
    },
  });

  // Handle different error types using proper helpers
  if (error instanceof ValidationError) {
    sendValidationError(res, error.message, error.details || undefined, traceId);
    return;
  }

  if (error instanceof NotFoundError) {
    sendNotFound(res, error.message, traceId);
    return;
  }

  if (error instanceof ConflictError) {
    sendConflict(res, error.message, undefined, traceId);
    return;
  }

  if (error instanceof TooManyRequestsError) {
    sendRateLimit(res, error.message, traceId);
    return;
  }

  if (error instanceof DatabaseError) {
    sendError(
      res,
      'Database operation failed',
      500,
      config.isDevelopment() ? { originalError: error.message } : undefined,
      traceId
    );
    return;
  }

  // Handle Multer errors (file upload)
  if (error.name === 'MulterError') {
    const multerError = error as any;
    let message = 'File upload error';

    switch (multerError.code) {
      case 'LIMIT_FILE_SIZE':
        message = 'File size too large';
        break;
      case 'LIMIT_FILE_COUNT':
        message = 'Too many files uploaded';
        break;
      case 'LIMIT_UNEXPECTED_FILE':
        message = 'Unexpected file field';
        break;
    }

    sendValidationError(res, message, undefined, traceId);
  }

  // Handle unexpected errors
  logger.error('Unhandled error', {
    traceId,
    error: {
      name: error.name,
      message: error.message,
      stack: error.stack,
    },
  });

  sendError(
    res,
    'Internal server error',
    500,
    config.isDevelopment() ? { originalError: error.message, stack: error.stack } : undefined,
    traceId
  );
};

/**
 * 404 handler for unmatched routes
 */
export const notFoundHandler = (req: Request, res: Response): void => {
  const traceId = (req as any).traceId || 'unknown';

  logger.warn('Route not found', {
    traceId,
    method: req.method,
    url: req.url,
  });
  sendNotFound(res, `Route ${req.method} ${req.url} not found`, traceId);
};
