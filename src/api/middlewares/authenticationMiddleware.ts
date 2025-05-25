import { Request, Response, NextFunction } from 'express';
import { RequestWithTracing } from './tracingMiddleware';
import { logger } from '../../utils/logger';
import { ValidationError } from '../../utils/error';

export interface AuthenticatedRequest extends RequestWithTracing {
  accountId: string;
}

/**
 * Simple header-based authentication middleware
 * Validates account ID from request headers
 */
export const authenticationMiddleware = (req: Request, res: Response, next: NextFunction): void => {
  try {
    const accountId = (req as AuthenticatedRequest).headers['account-id'] as string;

    if (!accountId || typeof accountId !== 'string' || accountId.trim() === '') {
      logger.warn('Authentication failed: Missing account ID', {
        traceId: (req as AuthenticatedRequest).traceId,
        headers: req.headers,
      });

      throw new ValidationError('Account ID is required in account-id header');
    }

    // Basic validation - account ID should be alphanumeric with hyphens/underscores
    const accountIdRegex = /^[a-zA-Z0-9_-]+$/;
    if (!accountIdRegex.test(accountId)) {
      logger.warn('Authentication failed: Invalid account ID format', {
        traceId: (req as AuthenticatedRequest).traceId,
        accountId,
      });

      throw new ValidationError('Invalid account ID format');
    }

    // Attach account ID to request for downstream use
    (req as AuthenticatedRequest).accountId = accountId.trim();

    logger.debug('Authentication successful', {
      traceId: (req as AuthenticatedRequest).traceId,
      accountId: (req as AuthenticatedRequest).accountId,
    });

    next();
  } catch (error) {
    next(error);
  }
};
