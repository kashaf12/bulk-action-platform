/**
 * Controller for handling bulk action statistics operations
 * Implements API endpoints for bulk action statistics with proper validation and error handling
 */

import { Request, Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../middlewares/authenticationMiddleware';
import { BaseController } from './BaseController';
import { BulkActionStatService } from '../../services/BulkActionStatService';
import { BulkActionService } from '../../services/BulkActionService';
import { logger } from '../../utils/logger';
import { NotFoundError, ValidationError } from '../../utils/error';
import { actionIdParamSchema } from '../../schemas';

/**
 * Controller for bulk action statistics endpoints
 */
export class BulkActionStatController extends BaseController {
  constructor(
    private bulkActionStatService: BulkActionStatService,
    private bulkActionService: BulkActionService
  ) {
    super();
  }

  /**
   * GET /bulk-actions/{actionId}/stats
   * Get statistics for a specific bulk action
   */
  getBulkActionStats = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const authenticatedRequest = req as AuthenticatedRequest;
    await this.executeWithErrorHandling(authenticatedRequest, res, async () => {
      const { actionId } = actionIdParamSchema.parse(authenticatedRequest.params);

      logger.debug('Fetching bulk action statistics', {
        traceId: authenticatedRequest.traceId,
        accountId: authenticatedRequest.accountId,
        actionId,
      });

      // First verify that the bulk action exists and belongs to the account
      const bulkAction = await this.bulkActionService.getBulkActionById(
        actionId,
        authenticatedRequest.traceId
      );

      if (!bulkAction) {
        throw new NotFoundError('Bulk action not found');
      }

      // Get detailed statistics
      const stats = await this.bulkActionStatService.getDetailedStats(
        actionId,
        authenticatedRequest.traceId
      );

      logger.info('Bulk action statistics retrieved successfully', {
        traceId: authenticatedRequest.traceId,
        accountId: authenticatedRequest.accountId,
        actionId,
        totalRecords: stats.totalRecords,
        successRate: stats.successRate,
        completionRate: stats.completionRate,
      });

      this.success(
        res,
        {
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

          // Processing efficiency metrics
          processingEfficiency: this.calculateProcessingEfficiency(stats),
          dataQualityScore: this.calculateDataQualityScore(stats),

          // Timestamps
          createdAt: stats.createdAt,
          updatedAt: stats.updatedAt,

          // Additional context from bulk action
          bulkActionStatus: bulkAction.status,
          bulkActionEntityType: bulkAction.entityType,
          bulkActionType: bulkAction.actionType,
        },
        'Bulk action statistics retrieved successfully',
        200,
        authenticatedRequest.traceId
      );
    });
  };

  /**
   * POST /bulk-actions/{actionId}/stats/initialize
   * Initialize empty statistics for a bulk action (internal use)
   */
  initializeBulkActionStats = async (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    await this.executeWithErrorHandling(req, res, async () => {
      const { actionId } = actionIdParamSchema.parse(req.params);
      const { totalRecords } = req.body;

      if (typeof totalRecords !== 'number' || totalRecords < 0) {
        throw new ValidationError('Valid totalRecords is required');
      }

      logger.info('Initializing bulk action statistics', {
        traceId: req.traceId,
        accountId: req.accountId,
        actionId,
        totalRecords,
      });

      // Verify bulk action exists and belongs to account
      const bulkAction = await this.bulkActionService.getBulkActionById(actionId, req.traceId);

      if (!bulkAction || bulkAction.accountId !== req.accountId) {
        throw new NotFoundError('Bulk action not found');
      }

      // Initialize statistics
      const stats = await this.bulkActionStatService.initializeStats(
        actionId,
        totalRecords,
        req.traceId
      );

      logger.info('Bulk action statistics initialized successfully', {
        traceId: req.traceId,
        accountId: req.accountId,
        actionId,
        totalRecords: stats.totalRecords,
      });

      this.success(
        res,
        {
          actionId: stats.actionId,
          totalRecords: stats.totalRecords,
          successfulRecords: stats.successfulRecords,
          failedRecords: stats.failedRecords,
          skippedRecords: stats.skippedRecords,
          duplicateRecords: stats.duplicateRecords,
          createdAt: stats.createdAt,
          updatedAt: stats.updatedAt,
        },
        'Bulk action statistics initialized successfully',
        201,
        req.traceId
      );
    });
  };

  /**
   * PUT /bulk-actions/{actionId}/stats/increment
   * Increment statistics counters (for workers)
   */
  incrementBulkActionStats = async (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    await this.executeWithErrorHandling(req, res, async () => {
      const { actionId } = actionIdParamSchema.parse(req.params);
      const { successful, failed, skipped, duplicate } = req.body;

      logger.info('Incrementing bulk action statistics', {
        traceId: req.traceId,
        accountId: req.accountId,
        actionId,
        increments: { successful, failed, skipped, duplicate },
      });

      // Verify bulk action exists and belongs to account
      const bulkAction = await this.bulkActionService.getBulkActionById(actionId, req.traceId);

      if (!bulkAction || bulkAction.accountId !== req.accountId) {
        throw new NotFoundError('Bulk action not found');
      }

      // Increment statistics
      const updatedStats = await this.bulkActionStatService.incrementCounters(
        actionId,
        { successful, failed, skipped, duplicate },
        req.traceId
      );

      logger.info('Bulk action statistics incremented successfully', {
        traceId: req.traceId,
        accountId: req.accountId,
        actionId,
        newTotals: {
          successful: updatedStats.successfulRecords,
          failed: updatedStats.failedRecords,
          skipped: updatedStats.skippedRecords,
          duplicate: updatedStats.duplicateRecords,
        },
      });

      this.success(
        res,
        {
          actionId: updatedStats.actionId,
          totalRecords: updatedStats.totalRecords,
          successfulRecords: updatedStats.successfulRecords,
          failedRecords: updatedStats.failedRecords,
          skippedRecords: updatedStats.skippedRecords,
          duplicateRecords: updatedStats.duplicateRecords,
          updatedAt: updatedStats.updatedAt,
        },
        'Bulk action statistics updated successfully',
        200,
        req.traceId
      );
    });
  };

  /**
   * GET /bulk-actions/{actionId}/stats/validate
   * Validate statistics consistency
   */
  validateBulkActionStats = async (
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    const authenticatedRequest = req as AuthenticatedRequest;
    await this.executeWithErrorHandling(authenticatedRequest, res, async () => {
      const { actionId } = actionIdParamSchema.parse(authenticatedRequest.params);

      logger.debug('Validating bulk action statistics consistency', {
        traceId: authenticatedRequest.traceId,
        accountId: authenticatedRequest.accountId,
        actionId,
      });

      // Verify bulk action exists and belongs to account
      const bulkAction = await this.bulkActionService.getBulkActionById(
        actionId,
        authenticatedRequest.traceId
      );

      if (!bulkAction || bulkAction.accountId !== authenticatedRequest.accountId) {
        throw new NotFoundError('Bulk action not found');
      }

      // Validate statistics consistency
      const validation = await this.bulkActionStatService.validateStatsConsistency(
        actionId,
        authenticatedRequest.traceId
      );

      logger.info('Bulk action statistics validation completed', {
        traceId: authenticatedRequest.traceId,
        accountId: authenticatedRequest.accountId,
        actionId,
        isConsistent: validation.isConsistent,
        errorCount: validation.errors.length,
      });

      this.success(
        res,
        {
          actionId,
          isConsistent: validation.isConsistent,
          errors: validation.errors,
          validatedAt: new Date().toISOString(),
        },
        validation.isConsistent
          ? 'Statistics are consistent'
          : 'Statistics validation found issues',
        validation.isConsistent ? 200 : 422,
        authenticatedRequest.traceId
      );
    });
  };

  /**
   * DELETE /bulk-actions/{actionId}/stats
   * Delete statistics for a bulk action (cleanup)
   */
  deleteBulkActionStats = async (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    await this.executeWithErrorHandling(req, res, async () => {
      const { actionId } = actionIdParamSchema.parse(req.params);

      logger.info('Deleting bulk action statistics', {
        traceId: req.traceId,
        accountId: req.accountId,
        actionId,
      });

      // Verify bulk action exists and belongs to account
      const bulkAction = await this.bulkActionService.getBulkActionById(actionId, req.traceId);

      if (!bulkAction || bulkAction.accountId !== req.accountId) {
        throw new NotFoundError('Bulk action not found');
      }

      // Delete statistics
      await this.bulkActionStatService.deleteStats(actionId, req.traceId);

      logger.info('Bulk action statistics deleted successfully', {
        traceId: req.traceId,
        accountId: req.accountId,
        actionId,
      });

      this.success(
        res,
        { actionId, deletedAt: new Date().toISOString() },
        'Bulk action statistics deleted successfully',
        200,
        req.traceId
      );
    });
  };

  /**
   * GET /bulk-actions/{actionId}/stats/exists
   * Check if statistics exist for a bulk action
   */
  checkBulkActionStatsExist = async (
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    const authenticatedRequest = req as AuthenticatedRequest;
    await this.executeWithErrorHandling(authenticatedRequest, res, async () => {
      const { actionId } = actionIdParamSchema.parse(authenticatedRequest.params);

      logger.debug('Checking bulk action statistics existence', {
        traceId: authenticatedRequest.traceId,
        accountId: authenticatedRequest.accountId,
        actionId,
      });

      // Verify bulk action exists and belongs to account
      const bulkAction = await this.bulkActionService.getBulkActionById(
        actionId,
        authenticatedRequest.traceId
      );

      if (!bulkAction || bulkAction.accountId !== authenticatedRequest.accountId) {
        throw new NotFoundError('Bulk action not found');
      }

      // Check if statistics exist
      const exists = await this.bulkActionStatService.statsExist(
        actionId,
        authenticatedRequest.traceId
      );

      logger.debug('Bulk action statistics existence check completed', {
        traceId: authenticatedRequest.traceId,
        accountId: authenticatedRequest.accountId,
        actionId,
        exists,
      });

      this.success(
        res,
        {
          actionId,
          exists,
          checkedAt: new Date().toISOString(),
        },
        'Statistics existence check completed',
        200,
        authenticatedRequest.traceId
      );
    });
  };

  /**
   * Calculate processing efficiency score (0-100)
   * Based on ratio of successful + skipped vs failed records
   */
  private calculateProcessingEfficiency(stats: any): number {
    if (stats.totalRecords === 0) return 100;

    const effectiveRecords = stats.successfulRecords + stats.skippedRecords;
    const ineffectiveRecords = stats.failedRecords;
    const processedRecords = effectiveRecords + ineffectiveRecords;

    if (processedRecords === 0) return 100;

    return Math.round((effectiveRecords / processedRecords) * 100 * 100) / 100;
  }

  /**
   * Calculate data quality score (0-100)
   * Based on ratio of successful vs total processed records
   */
  private calculateDataQualityScore(stats: any): number {
    const processedRecords = stats.successfulRecords + stats.failedRecords + stats.skippedRecords;

    if (processedRecords === 0) return 100;

    // Successful records get full points, skipped get partial points, failed get no points
    const qualityScore = (stats.successfulRecords + stats.skippedRecords * 0.5) / processedRecords;

    return Math.round(qualityScore * 100 * 100) / 100;
  }
}
