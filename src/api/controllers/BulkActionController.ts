import { Request, Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../middlewares/authenticationMiddleware';
import { BaseController } from './BaseController';
import { BulkActionService } from '../../services/BulkActionService';
import { ContactService } from '../../services/ContactService';
import { logger } from '../../utils/logger';
import { z } from 'zod';
import { NotFoundError, ValidationError } from '../../utils/error';
import {
  actionIdParamSchema,
  bulkActionCreateSchema,
  bulkActionQuerySchema,
  bulkActionStatusSchema,
  createBulkActionRequestSchema,
} from '../../schemas';

/**
 * Controller for handling bulk action operations
 * Implements all bulk action endpoints with proper validation and error handling
 */
export class BulkActionController extends BaseController {
  constructor(private bulkActionService: BulkActionService) {
    super();
  }

  /**
   * POST /bulk-actions
   * Create a new bulk action with CSV file upload
   */
  createBulkAction = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const authenticatedRequest = req as AuthenticatedRequest;
    await this.executeWithErrorHandling(authenticatedRequest, res, async () => {
      // Validate request body
      const validatedBody = createBulkActionRequestSchema.parse(authenticatedRequest.body);

      // Validate file upload
      if (!authenticatedRequest.file) {
        throw new ValidationError('CSV file is required');
      }

      logger.info('Creating bulk action', {
        traceId: authenticatedRequest.traceId,
        accountId: authenticatedRequest.accountId,
        entityType: validatedBody.entityType,
        actionType: validatedBody.actionType,
        fileSize: authenticatedRequest.file.size,
        fileName: authenticatedRequest.file.originalname,
        configuration: validatedBody.configuration,
      });

      // Parse CSV and validate headers
      const csvData = await this.parseCsvFile(authenticatedRequest.file, validatedBody.entityType);

      // Create bulk action
      const bulkAction = await this.bulkActionService.createBulkAction({
        accountId: authenticatedRequest.accountId,
        entityType: validatedBody.entityType,
        actionType: validatedBody.actionType,
        totalEntities: csvData.length,
        configuration: {
          ...validatedBody.configuration,
          fileName: authenticatedRequest.file.originalname,
          fileSize: authenticatedRequest.file.size,
        },
        scheduledAt: validatedBody.scheduledAt ? new Date(validatedBody.scheduledAt) : undefined,
      });

      // Enqueue processing job
      await this.enqueueProcessingJob(bulkAction.actionId, csvData, validatedBody.configuration);

      logger.info('Bulk action created successfully', {
        traceId: authenticatedRequest.traceId,
        accountId: authenticatedRequest.accountId,
        actionId: bulkAction.actionId,
        totalEntities: csvData.length,
        status: bulkAction.status,
      });

      this.success(
        res,
        {
          actionId: bulkAction.actionId,
          status: bulkAction.status,
          totalEntities: bulkAction.totalEntities,
          scheduledAt: bulkAction.scheduledAt,
          createdAt: bulkAction.createdAt,
        },
        'Bulk action created successfully',
        201,
        authenticatedRequest.traceId
      );
    });
  };

  /**
   * GET /bulk-actions
   * List bulk actions with pagination and filtering
   */
  getBulkActions = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const authenticatedRequest = req as AuthenticatedRequest;
    await this.executeWithErrorHandling(authenticatedRequest, res, async () => {
      const validatedQuery = bulkActionQuerySchema.parse(authenticatedRequest.query);

      logger.debug('Fetching bulk actions', {
        traceId: authenticatedRequest.traceId,
        accountId: authenticatedRequest.accountId,
        filters: validatedQuery,
      });

      const { data, pagination } = await this.bulkActionService.getBulkActions(
        {
          accountId: authenticatedRequest.accountId,
          page: validatedQuery.page,
          limit: validatedQuery.limit,
        },
        authenticatedRequest.traceId
      );

      this.paginated(
        res,
        data.map(action => ({
          actionId: action.actionId,
          entityType: action.entityType,
          actionType: action.actionType,
          status: action.status,
          totalEntities: action.totalEntities,
          processedEntities: action.processedEntities,
          scheduledAt: action.scheduledAt,
          startedAt: action.startedAt,
          completedAt: action.completedAt,
          createdAt: action.createdAt,
          updatedAt: action.updatedAt,
        })),
        pagination,
        'Bulk actions retrieved successfully',
        authenticatedRequest.traceId
      );
    });
  };

  /**
   * GET /bulk-actions/{actionId}
   * Get detailed information about a specific bulk action
   */
  getBulkActionById = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const authenticatedRequest = req as AuthenticatedRequest;
    await this.executeWithErrorHandling(authenticatedRequest, res, async () => {
      const { actionId } = actionIdParamSchema.parse(authenticatedRequest.params);

      logger.debug('Fetching bulk action details', {
        traceId: authenticatedRequest.traceId,
        accountId: authenticatedRequest.accountId,
        actionId,
      });

      const bulkAction = await this.bulkActionService.getBulkActionById(
        actionId,
        authenticatedRequest.accountId
      );

      if (!bulkAction) {
        throw new NotFoundError('Bulk action not found');
      }

      this.success(
        res,
        {
          actionId: bulkAction.actionId,
          entityType: bulkAction.entityType,
          actionType: bulkAction.actionType,
          status: bulkAction.status,
          totalEntities: bulkAction.totalEntities,
          processedEntities: bulkAction.processedEntities,
          progressPercentage:
            bulkAction.totalEntities > 0
              ? Math.round((bulkAction.processedEntities / bulkAction.totalEntities) * 100)
              : 0,
          configuration: bulkAction.configuration,
          scheduledAt: bulkAction.scheduledAt,
          startedAt: bulkAction.startedAt,
          completedAt: bulkAction.completedAt,
          errorMessage: bulkAction.errorMessage,
          createdAt: bulkAction.createdAt,
          updatedAt: bulkAction.updatedAt,
        },
        'Bulk action details retrieved successfully',
        200,
        authenticatedRequest.traceId
      );
    });
  };

  /**
   * GET /bulk-actions/{actionId}/stats
   * Get statistics for a specific bulk action
   */
  getBulkActionStats = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const authenticatedRequest = req as AuthenticatedRequest;
    await this.executeWithErrorHandling(authenticatedRequest, res, async () => {
      const { actionId } = actionIdParamSchema.parse(req.params);

      logger.debug('Fetching bulk action statistics', {
        traceId: authenticatedRequest.traceId,
        accountId: authenticatedRequest.accountId,
        actionId,
      });

      // Verify bulk action exists and belongs to account
      const bulkAction = await this.bulkActionService.getBulkActionById(
        actionId,
        authenticatedRequest.accountId
      );
      if (!bulkAction) {
        throw new NotFoundError('Bulk action not found');
      }

      // Get detailed statistics
      const stats = await this.bulkActionService.getBulkActionStatistics(actionId);

      this.success(
        res,
        {
          actionId,
          status: bulkAction.status,
          total: stats.total,
          successful: stats.successful,
          failed: stats.failed,
          skipped: stats.skipped,
          processingTime: stats.processingTime,
          errorBreakdown: stats.errorBreakdown,
          lastUpdated: stats.lastUpdated,
        },
        'Bulk action statistics retrieved successfully',
        200,
        authenticatedRequest.traceId
      );
    });
  };

  /**
   * PUT /bulk-actions/{actionId}/cancel
   * Cancel a pending or processing bulk action
   */
  cancelBulkAction = async (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    await this.executeWithErrorHandling(req, res, async () => {
      const { actionId } = actionIdParamSchema.parse(req.params);

      logger.info('Cancelling bulk action', {
        traceId: req.traceId,
        accountId: req.accountId,
        actionId,
      });

      const bulkAction = await this.bulkActionService.getBulkActionById(actionId, req.accountId);
      if (!bulkAction) {
        throw new NotFoundError('Bulk action not found');
      }

      // Check if action can be cancelled
      if (
        ![BulkActionStatus.QUEUED, BulkActionStatus.PROCESSING].includes(
          bulkAction.status as BulkActionStatus
        )
      ) {
        throw new ValidationError('Only queued or processing bulk actions can be cancelled');
      }

      // Cancel the bulk action
      const cancelledAction = await this.bulkActionService.cancelBulkAction(
        actionId,
        req.accountId
      );

      logger.info('Bulk action cancelled successfully', {
        traceId: req.traceId,
        accountId: req.accountId,
        actionId,
        previousStatus: bulkAction.status,
      });

      this.success(
        res,
        {
          actionId: cancelledAction.actionId,
          status: cancelledAction.status,
          cancelledAt: cancelledAction.updatedAt,
        },
        'Bulk action cancelled successfully',
        200,
        req.traceId
      );
    });
  };

  /**
   * Parse CSV file and validate structure based on entity type
   */
  private async parseCsvFile(file: Express.Multer.File, entityType: string): Promise<any[]> {
    const csvContent = file.buffer.toString('utf8');

    // Parse CSV (basic implementation - in production, use a proper CSV parser)
    const lines = csvContent.split('\n').filter(line => line.trim());
    if (lines.length < 2) {
      throw new ValidationError('CSV file must contain at least a header and one data row');
    }

    const headers = lines[0].split(',').map(h => h.trim().toLowerCase());
    const data: any[] = [];

    // Validate headers based on entity type
    const requiredHeaders = this.getRequiredHeaders(entityType);
    const missingHeaders = requiredHeaders.filter(req => !headers.includes(req.toLowerCase()));

    if (missingHeaders.length > 0) {
      throw new ValidationError(`Missing required headers: ${missingHeaders.join(', ')}`);
    }

    // Parse data rows
    for (let i = 1; i < lines.length; i++) {
      const values = lines[i].split(',').map(v => v.trim());
      if (values.length !== headers.length) {
        continue; // Skip malformed rows
      }

      const row: any = {};
      headers.forEach((header, index) => {
        row[header] = values[index] || '';
      });

      data.push(row);
    }

    logger.info('CSV parsed successfully', {
      totalRows: data.length,
      headers: headers.join(', '),
    });

    return data;
  }

  /**
   * Get required headers for different entity types
   */
  private getRequiredHeaders(entityType: string): string[] {
    switch (entityType) {
      case 'contact':
        return ['email']; // email is required for contacts
      default:
        return [];
    }
  }

  /**
   * Enqueue processing job for bulk action
   */
  private async enqueueProcessingJob(
    actionId: string,
    csvData: any[],
    configuration: any
  ): Promise<void> {
    // This will be implemented when we create the BullMQ queue system
    // For now, we'll just log that we would enqueue it
    logger.info('Enqueueing bulk action processing job', {
      actionId,
      dataSize: csvData.length,
      configuration,
    });

    // TODO: Implement actual queue enqueuing
    // await bulkActionQueue.add('process-csv', {
    //   actionId,
    //   csvData,
    //   configuration
    // });
  }
}
