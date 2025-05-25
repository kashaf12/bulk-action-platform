import { Response } from 'express';
import { AuthenticatedRequest } from '../middlewares/authenticationMiddleware';

import { logger } from '../../utils/logger';
import { sendError, sendPaginatedSuccess, sendSuccess } from '../../utils/response';

/**
 * Base controller with common response handling patterns
 * Follows DRY principle and provides consistent error handling
 */
export abstract class BaseController {
  /**
   * Handle successful responses with consistent formatting
   */
  protected success<T>(
    res: Response,
    data: T,
    message: string = 'Success',
    statusCode: number = 200,
    traceId?: string
  ): void {
    sendSuccess(res, data, message, statusCode, traceId);
  }

  /**
   * Handle paginated responses
   */
  protected paginated<T>(
    res: Response,
    data: T[],
    pagination: any,
    message: string = 'Success',
    traceId?: string
  ): void {
    sendPaginatedSuccess(res, data, pagination, message, traceId);
  }

  /**
   * Handle error responses (though most errors go through error middleware)
   */
  protected error(
    res: Response,
    message: string,
    statusCode: number = 500,
    details?: any,
    traceId?: string
  ): void {
    sendError(res, message, statusCode, details, traceId);
  }

  /**
   * Safely execute controller logic with error handling
   */
  protected async executeWithErrorHandling(
    req: AuthenticatedRequest,
    res: Response,
    operation: () => Promise<void>
  ): Promise<void> {
    try {
      await operation();
    } catch (error) {
      logger.error('Controller operation failed', {
        traceId: req.traceId,
        accountId: req.accountId,
        error: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : undefined,
      });

      // Re-throw to let error middleware handle it
      throw error;
    }
  }
}
