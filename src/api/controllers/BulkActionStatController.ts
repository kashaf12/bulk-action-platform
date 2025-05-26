/**
 * Controller for handling bulk action statistics operations
 * Implements API endpoints for bulk action statistics with proper validation and error handling
 */

import { Request, Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../middlewares/authenticationMiddleware';
import { BaseController } from './BaseController';
import { BulkActionStatService } from '../../services/BulkActionStatService';
import { logger } from '../../utils/logger';
import { idParamSchema } from '../../schemas';

/**
 * Controller for bulk action statistics endpoints
 */
export class BulkActionStatController extends BaseController {
  constructor(private bulkActionStatService: BulkActionStatService) {
    super();
  }

  /**
   * GET /bulk-actions/{id}/stats
   * Get statistics for a specific bulk action
   */
  getBulkActionStats = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const authenticatedRequest = req as AuthenticatedRequest;
    await this.executeWithErrorHandling(authenticatedRequest, res, async () => {
      const { id } = idParamSchema.parse(authenticatedRequest.params);

      logger.debug('Fetching bulk action statistics', {
        traceId: authenticatedRequest.traceId,
        accountId: authenticatedRequest.accountId,
        id,
      });

      // Get detailed statistics
      const stats = await this.bulkActionStatService.getDetailedStats(
        id,
        authenticatedRequest.traceId
      );

      logger.info('Bulk action statistics retrieved successfully', {
        traceId: authenticatedRequest.traceId,
        accountId: authenticatedRequest.accountId,
        id,
        totalRecords: stats.totalRecords,
        successRate: stats.successRate,
        completionRate: stats.completionRate,
      });

      this.success(
        res,
        {
          id: stats.id,
          actionId: stats.actionId,
          totalRecords: stats.totalRecords,
          successfulRecords: stats.successfulRecords,
          failedRecords: stats.failedRecords,
          skippedRecords: stats.skippedRecords,
          duplicateRecords: stats.duplicateRecords,
          processedRecords: stats.processedRecords,

          // Calculated metrics
          successRate: stats.successRate,
          failureRate: stats.failureRate,
          skipRate: stats.skipRate,
          duplicateRate: stats.duplicateRate,
          completionRate: stats.completionRate,

          // Timestamps
          createdAt: stats.createdAt,
          updatedAt: stats.updatedAt,
        },
        'Bulk action statistics retrieved successfully',
        200,
        authenticatedRequest.traceId
      );
    });
  };
}
