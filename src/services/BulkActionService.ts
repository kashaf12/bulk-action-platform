/**
 * Business logic service for bulk actions
 * Implements business rules and orchestrates repository operations
 * Follows Single Responsibility and Dependency Inversion principles
 */

import { v4 as uuidv4 } from 'uuid';
import { BulkActionRepository, BulkActionSearchParams } from '../repositories/BulkActionRepository';
import { BulkAction } from '../models/BulkAction';
import {
  IBulkAction,
  BulkActionCreateData,
  BulkActionUpdateData,
  BulkActionStatus,
  BulkActionType,
  EntityType,
} from '../types/entities/bulk-action';
import { PaginationParams, PaginatedResult } from '../types';
import { ValidationError, NotFoundError, ConflictError } from '../utils/error';
import { logger } from '../utils/logger';
import { IService } from '../types/services';
import redisManager from '../config/redis';
import configManager from '../config/app';

export interface CreateBulkActionRequest {
  accountId: string;
  entityType: EntityType;
  actionType: BulkActionType;
  scheduledAt?: Date;
  configuration?: Record<string, unknown>;
}

export interface BulkActionListOptions extends PaginationParams {
  accountId?: string;
  status?: BulkActionStatus;
  entityType?: EntityType;
  actionType?: BulkActionType;
  dateFrom?: Date;
  dateTo?: Date;
}

export class BulkActionService implements IService {
  private bulkActionRepository: BulkActionRepository;
  private maxConcurrentActions: number;
  private rateLimitConfig: { windowMs: number; maxRequests: number };

  constructor(bulkActionRepository: BulkActionRepository) {
    this.bulkActionRepository = bulkActionRepository || new BulkActionRepository();
    const processingConfig = configManager.getProcessingConfig();
    this.maxConcurrentActions = processingConfig.maxConcurrentJobs;
    this.rateLimitConfig = configManager.getRateLimitConfig();
  }

  /**
   * Get paginated list of bulk actions with filtering
   */
  public async getBulkActions(
    options: BulkActionListOptions,
    traceId: string
  ): Promise<PaginatedResult<IBulkAction>> {
    this.validatePaginationParams(options.page, options.limit);

    const log = logger.withTrace(traceId);

    log.info('Fetching bulk actions', {
      page: options.page,
      limit: options.limit,
      accountId: options.accountId,
    });

    try {
      const searchParams: BulkActionSearchParams = {
        page: options.page,
        limit: options.limit,
        accountId: options.accountId,
      };

      const result = await this.bulkActionRepository.findWithFilters(searchParams, traceId);

      log.info('Successfully fetched bulk actions', {
        total: result.pagination.total,
        returned: result.data.length,
        page: result.pagination.page,
      });

      return result;
    } catch (error) {
      log.error('Failed to get bulk actions', {
        error: error instanceof Error ? error.message : String(error),
        options,
      });
      throw error;
    }
  }

  /**
   * Get bulk action by action ID
   */
  public async getBulkActionById(actionId: string, traceId: string): Promise<IBulkAction> {
    if (!actionId) {
      throw new ValidationError('Action ID is required');
    }

    const log = logger.withTrace(traceId);

    log.info('Fetching bulk action by ID', { actionId });

    try {
      const bulkAction = await this.bulkActionRepository.findByActionId(actionId, traceId);

      if (!bulkAction) {
        throw new NotFoundError('Bulk action');
      }

      log.info('Successfully fetched bulk action', {
        actionId,
        status: bulkAction.status,
        entityType: bulkAction.entityType,
        actionType: bulkAction.actionType,
      });

      return bulkAction;
    } catch (error) {
      if (error instanceof NotFoundError) {
        logger.withTrace(traceId).warn('Bulk action not found', { actionId });
      } else {
        logger.withTrace(traceId).error('Failed to get bulk action by ID', {
          error: error instanceof Error ? error.message : String(error),
          actionId,
        });
      }
      throw error;
    }
  }

  /**
   * Create a new bulk action with validation and rate limiting
   */
  public async createBulkAction(
    request: CreateBulkActionRequest,
    traceId: string
  ): Promise<IBulkAction> {
    const log = logger.withTrace(traceId);

    // Validate request
    this.validateCreateRequest(request);

    log.info('Creating bulk action', {
      accountId: request.accountId,
      entityType: request.entityType,
      actionType: request.actionType,
      scheduled: !!request.scheduledAt,
    });

    try {
      // Check rate limits
      await this.checkRateLimits(request.accountId, traceId);

      // Check concurrent action limits
      await this.checkConcurrentLimits(request.accountId, traceId);

      // Create bulk action entity
      const actionId = uuidv4();
      const bulkActionData: BulkActionCreateData = {
        actionId,
        accountId: request.accountId,
        entityType: request.entityType,
        actionType: request.actionType,
        status: 'queued',
        totalEntities: 0,
        processedEntities: 0,
        scheduledAt: request.scheduledAt,
        configuration: request.configuration || {},
      };

      const bulkAction = new BulkAction(bulkActionData as IBulkAction);

      // Validate entity
      const validation = BulkAction.validate(bulkAction.toObject());
      if (!validation.isValid) {
        throw new ValidationError('Invalid bulk action data', validation.errors);
      }

      // Save to database
      const createdBulkAction = await this.bulkActionRepository.create(bulkAction, traceId);

      // Update rate limit counter
      await this.updateRateLimitCounter(request.accountId, traceId);

      log.info('Bulk action created successfully', {
        actionId: createdBulkAction.actionId,
        accountId: createdBulkAction.accountId,
        status: createdBulkAction.status,
      });

      return createdBulkAction;
    } catch (error) {
      log.error('Failed to create bulk action', {
        error: error instanceof Error ? error.message : String(error),
        request,
      });
      throw error;
    }
  }

  /**
   * Update bulk action status and progress
   */
  public async updateBulkAction(
    actionId: string,
    updates: BulkActionUpdateData,
    traceId: string
  ): Promise<IBulkAction> {
    if (!actionId) {
      throw new ValidationError('Action ID is required');
    }

    const log = logger.withTrace(traceId);

    log.info('Updating bulk action', {
      actionId,
      updates: Object.keys(updates),
    });

    try {
      // Get current bulk action
      const currentBulkAction = await this.bulkActionRepository.findByActionId(actionId, traceId);

      if (!currentBulkAction) {
        throw new NotFoundError('Bulk action');
      }

      // Validate status transitions
      if (updates.status) {
        this.validateStatusTransition(currentBulkAction.status, updates.status);
      }

      // Validate progress updates
      if (updates.processedEntities !== undefined) {
        this.validateProgressUpdate(currentBulkAction, updates.processedEntities);
      }

      // Perform update
      const updatedBulkAction = await this.bulkActionRepository.updateByActionId(
        actionId,
        updates,
        traceId
      );

      if (!updatedBulkAction) {
        throw new NotFoundError('Bulk action');
      }

      log.info('Bulk action updated successfully', {
        actionId,
        oldStatus: currentBulkAction.status,
        newStatus: updatedBulkAction.status,
        progress: `${updatedBulkAction.processedEntities}/${updatedBulkAction.totalEntities}`,
      });

      return updatedBulkAction;
    } catch (error) {
      log.error('Failed to update bulk action', {
        error: error instanceof Error ? error.message : String(error),
        actionId,
        updates,
      });
      throw error;
    }
  }

  /**
   * Cancel a bulk action
   */
  public async cancelBulkAction(actionId: string, traceId: string): Promise<IBulkAction> {
    const log = logger.withTrace(traceId);

    log.info('Cancelling bulk action', { actionId });

    try {
      const bulkAction = await this.getBulkActionById(actionId, traceId);

      if (bulkAction.isFinished()) {
        throw new ConflictError('Cannot cancel a finished bulk action');
      }

      const updatedBulkAction = await this.updateBulkAction(
        actionId,
        { status: 'cancelled' },
        traceId
      );

      log.info('Bulk action cancelled successfully', {
        actionId,
        previousStatus: bulkAction.status,
      });

      return updatedBulkAction;
    } catch (error) {
      log.error('Failed to cancel bulk action', {
        error: error instanceof Error ? error.message : String(error),
        actionId,
      });
      throw error;
    }
  }

  /**
   * Get bulk actions ready for processing
   */
  public async getReadyToProcess(limit = 10, traceId: string): Promise<IBulkAction[]> {
    const log = logger.withTrace(traceId);

    try {
      const bulkActions = await this.bulkActionRepository.findReadyToProcess(limit, traceId);

      log.debug('Found bulk actions ready to process', {
        count: bulkActions.length,
        limit,
      });

      return bulkActions;
    } catch (error) {
      log.error('Failed to get bulk actions ready to process', {
        error: error instanceof Error ? error.message : String(error),
        limit,
      });
      throw error;
    }
  }

  /**
   * Get bulk action statistics
   */
  public async getStatistics(accountId?: string, dateFrom?: Date, dateTo?: Date, traceId?: string) {
    const log = traceId ? logger.withTrace(traceId) : logger;

    try {
      const stats = await this.bulkActionRepository.getStatistics(
        accountId,
        dateFrom,
        dateTo,
        traceId
      );

      log.debug('Bulk action statistics retrieved', {
        accountId,
        dateRange: { from: dateFrom, to: dateTo },
        totalActions: stats.total,
      });

      return stats;
    } catch (error) {
      log.error('Failed to get bulk action statistics', {
        error: error instanceof Error ? error.message : String(error),
        accountId,
        dateRange: { from: dateFrom, to: dateTo },
      });
      throw error;
    }
  }

  /**
   * Get bulk actions for a specific account
   */
  public async getBulkActionsByAccount(
    accountId: string,
    params: PaginationParams,
    traceId: string
  ): Promise<PaginatedResult<IBulkAction>> {
    if (!accountId) {
      throw new ValidationError('Account ID is required');
    }

    this.validatePaginationParams(params.page, params.limit);

    const log = logger.withTrace(traceId);

    try {
      const result = await this.bulkActionRepository.findByAccount(accountId, params, traceId);

      log.debug('Bulk actions retrieved for account', {
        accountId,
        total: result.pagination.total,
        returned: result.data.length,
      });

      return result;
    } catch (error) {
      log.error('Failed to get bulk actions by account', {
        error: error instanceof Error ? error.message : String(error),
        accountId,
        params,
      });
      throw error;
    }
  }

  /**
   * Update progress for bulk action
   */
  public async updateProgress(
    actionId: string,
    processedEntities: number,
    traceId: string
  ): Promise<IBulkAction> {
    const log = logger.withTrace(traceId);

    try {
      const updates: BulkActionUpdateData = {
        processedEntities,
      };

      // Get current action to check if it should be completed
      const currentAction = await this.getBulkActionById(actionId, traceId);

      if (
        processedEntities >= currentAction.totalEntities &&
        currentAction.status === 'processing'
      ) {
        updates.status = 'completed';
        updates.completedAt = new Date();
      }

      const updatedAction = await this.updateBulkAction(actionId, updates, traceId);

      log.debug('Bulk action progress updated', {
        actionId,
        processedEntities,
        totalEntities: updatedAction.totalEntities,
        progressPercentage: updatedAction.getProgressPercentage(),
      });

      return updatedAction;
    } catch (error) {
      log.error('Failed to update bulk action progress', {
        error: error instanceof Error ? error.message : String(error),
        actionId,
        processedEntities,
      });
      throw error;
    }
  }

  /**
   * Start processing a bulk action
   */
  public async startProcessing(actionId: string, traceId: string): Promise<IBulkAction> {
    const log = logger.withTrace(traceId);

    try {
      const updates: BulkActionUpdateData = {
        status: 'processing',
        startedAt: new Date(),
      };

      const updatedAction = await this.updateBulkAction(actionId, updates, traceId);

      log.info('Bulk action processing started', {
        actionId,
        entityType: updatedAction.entityType,
        actionType: updatedAction.actionType,
        totalEntities: updatedAction.totalEntities,
      });

      return updatedAction;
    } catch (error) {
      log.error('Failed to start bulk action processing', {
        error: error instanceof Error ? error.message : String(error),
        actionId,
      });
      throw error;
    }
  }

  /**
   * Mark bulk action as failed
   */
  public async markAsFailed(
    actionId: string,
    errorMessage: string,
    traceId: string
  ): Promise<IBulkAction> {
    const log = logger.withTrace(traceId);

    try {
      const updates: BulkActionUpdateData = {
        status: 'failed',
        errorMessage,
        completedAt: new Date(),
      };

      const updatedAction = await this.updateBulkAction(actionId, updates, traceId);

      log.warn('Bulk action marked as failed', {
        actionId,
        errorMessage,
        processedEntities: updatedAction.processedEntities,
        totalEntities: updatedAction.totalEntities,
      });

      return updatedAction;
    } catch (error) {
      log.error('Failed to mark bulk action as failed', {
        error: error instanceof Error ? error.message : String(error),
        actionId,
        originalError: errorMessage,
      });
      throw error;
    }
  }

  /**
   * Validate pagination parameters
   */
  private validatePaginationParams(page: number, limit: number): void {
    if (page < 1) {
      throw new ValidationError('Page must be at least 1');
    }

    if (limit < 1 || limit > 100) {
      throw new ValidationError('Limit must be between 1 and 100');
    }
  }

  /**
   * Validate create request
   */
  private validateCreateRequest(request: CreateBulkActionRequest): void {
    if (!request.accountId) {
      throw new ValidationError('Account ID is required');
    }

    if (!request.entityType) {
      throw new ValidationError('Entity type is required');
    }

    if (!request.actionType) {
      throw new ValidationError('Action type is required');
    }

    // Validate scheduled time is in the future
    if (request.scheduledAt && request.scheduledAt <= new Date()) {
      throw new ValidationError('Scheduled time must be in the future');
    }

    // Validate entity type
    const validEntityTypes: EntityType[] = ['contact', 'company', 'lead', 'opportunity', 'task'];
    if (!validEntityTypes.includes(request.entityType)) {
      throw new ValidationError(`Invalid entity type: ${request.entityType}`);
    }

    // Validate action type
    const validActionTypes: BulkActionType[] = ['bulk_update', 'bulk_delete', 'bulk_create'];
    if (!validActionTypes.includes(request.actionType)) {
      throw new ValidationError(`Invalid action type: ${request.actionType}`);
    }
  }

  /**
   * Validate status transition
   */
  private validateStatusTransition(
    currentStatus: BulkActionStatus,
    newStatus: BulkActionStatus
  ): void {
    const validTransitions: Record<BulkActionStatus, BulkActionStatus[]> = {
      queued: ['processing', 'cancelled'],
      processing: ['completed', 'failed', 'cancelled'],
      completed: [], // Final state
      failed: ['queued'], // Can retry
      cancelled: ['queued'], // Can restart
    };

    if (!validTransitions[currentStatus]?.includes(newStatus)) {
      throw new ValidationError(`Invalid status transition from ${currentStatus} to ${newStatus}`);
    }
  }

  /**
   * Validate progress update
   */
  private validateProgressUpdate(bulkAction: IBulkAction, processedEntities: number): void {
    if (processedEntities < 0) {
      throw new ValidationError('Processed entities cannot be negative');
    }

    if (processedEntities > bulkAction.totalEntities) {
      throw new ValidationError('Processed entities cannot exceed total entities');
    }

    if (processedEntities < bulkAction.processedEntities) {
      throw new ValidationError('Processed entities cannot decrease');
    }
  }

  /**
   * Check rate limits for account
   */
  private async checkRateLimits(accountId: string, traceId: string): Promise<void> {
    const log = logger.withTrace(traceId);

    try {
      const rateLimitKey = `rate_limit:bulk_actions:${accountId}`;
      const windowSeconds = Math.floor(this.rateLimitConfig.windowMs / 1000);

      const rateLimitResult = await redisManager.rateLimit(
        rateLimitKey,
        windowSeconds,
        this.rateLimitConfig.maxRequests,
        traceId
      );

      if (!rateLimitResult.allowed) {
        log.warn('Rate limit exceeded for account', {
          accountId,
          current: rateLimitResult.current,
          limit: this.rateLimitConfig.maxRequests,
          resetTime: new Date(rateLimitResult.resetTime),
        });

        throw new ConflictError(
          `Rate limit exceeded. Current: ${rateLimitResult.current}/${this.rateLimitConfig.maxRequests}. ` +
            `Reset at: ${new Date(rateLimitResult.resetTime).toISOString()}`
        );
      }

      log.debug('Rate limit check passed', {
        accountId,
        current: rateLimitResult.current,
        remaining: rateLimitResult.remaining,
      });
    } catch (error) {
      if (error instanceof ConflictError) {
        throw error;
      }

      log.error('Failed to check rate limits', {
        error: error instanceof Error ? error.message : String(error),
        accountId,
      });

      // If Redis is unavailable, allow the request but log warning
      log.warn('Rate limiting unavailable, allowing request', { accountId });
    }
  }

  /**
   * Check concurrent action limits for account
   */
  private async checkConcurrentLimits(accountId: string, traceId: string): Promise<void> {
    const log = logger.withTrace(traceId);

    try {
      const runningCount = await this.bulkActionRepository.getRunningActionsCount(
        accountId,
        traceId
      );

      if (runningCount >= this.maxConcurrentActions) {
        log.warn('Concurrent action limit exceeded for account', {
          accountId,
          runningCount,
          maxConcurrent: this.maxConcurrentActions,
        });

        throw new ConflictError(
          `Concurrent action limit exceeded. Current: ${runningCount}/${this.maxConcurrentActions} running actions.`
        );
      }

      log.debug('Concurrent limit check passed', {
        accountId,
        runningCount,
        maxConcurrent: this.maxConcurrentActions,
      });
    } catch (error) {
      if (error instanceof ConflictError) {
        throw error;
      }

      log.error('Failed to check concurrent limits', {
        error: error instanceof Error ? error.message : String(error),
        accountId,
      });
      throw error;
    }
  }

  /**
   * Update rate limit counter
   */
  private async updateRateLimitCounter(accountId: string, traceId: string): Promise<void> {
    try {
      const rateLimitKey = `rate_limit:bulk_actions:${accountId}`;
      await redisManager.incr(rateLimitKey, traceId);
    } catch (error) {
      logger.withTrace(traceId).warn('Failed to update rate limit counter', {
        accountId,
        error: error instanceof Error ? error.message : String(error),
      });
      // Don't throw error as this is not critical
    }
  }

  /**
   * Cleanup old completed bulk actions
   */
  public async cleanupOldActions(
    olderThanDays = 30,
    batchSize = 100,
    traceId: string
  ): Promise<number> {
    const log = logger.withTrace(traceId);

    try {
      const deletedCount = await this.bulkActionRepository.cleanupOldActions(
        olderThanDays,
        batchSize,
        traceId
      );

      log.info('Old bulk actions cleanup completed', {
        deletedCount,
        olderThanDays,
        batchSize,
      });

      return deletedCount;
    } catch (error) {
      log.error('Failed to cleanup old bulk actions', {
        error: error instanceof Error ? error.message : String(error),
        olderThanDays,
        batchSize,
      });
      throw error;
    }
  }

  /**
   * Get account summary statistics
   */
  public async getAccountSummary(accountId: string, traceId: string) {
    const log = logger.withTrace(traceId);

    try {
      const [stats, runningCount] = await Promise.all([
        this.getStatistics(accountId, undefined, undefined, traceId),
        this.bulkActionRepository.getRunningActionsCount(accountId, traceId),
      ]);

      const summary = {
        totalActions: stats.total,
        runningActions: runningCount,
        completedActions: stats.byStatus.completed,
        failedActions: stats.byStatus.failed,
        successRate: stats.successRate,
        avgProcessingTime: stats.avgProcessingTime,
        statusBreakdown: stats.byStatus,
        entityTypeBreakdown: stats.byEntityType,
        actionTypeBreakdown: stats.byActionType,
      };

      log.debug('Account summary retrieved', {
        accountId,
        summary,
      });

      return summary;
    } catch (error) {
      log.error('Failed to get account summary', {
        error: error instanceof Error ? error.message : String(error),
        accountId,
      });
      throw error;
    }
  }
}
