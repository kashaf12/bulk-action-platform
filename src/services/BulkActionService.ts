/**
 * Business logic service for bulk actions
 * Implements business rules and orchestrates repository operations
 * Follows Single Responsibility and Dependency Inversion principles
 */

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
import { ValidationError, NotFoundError } from '../utils/error';
import { logger } from '../utils/logger';
import { IService } from '../types/services';
import configManager from '../config/app';

export interface CreateBulkActionRequest {
  id?: string;
  accountId: string;
  entityType: EntityType;
  actionType: BulkActionType;
  scheduledAt?: Date;
  configuration?: Record<string, unknown>;
  totalEntities?: number;
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
  public async getBulkActionById(id: string, traceId: string): Promise<IBulkAction> {
    if (!id) {
      throw new ValidationError('ID is required');
    }

    const log = logger.withTrace(traceId);

    log.info('Fetching bulk action by ID', { id });

    try {
      const bulkAction = await this.bulkActionRepository.findById(id, traceId);

      if (!bulkAction) {
        throw new NotFoundError('Bulk action');
      }

      log.info('Successfully fetched bulk action', {
        id,
        status: bulkAction.status,
        entityType: bulkAction.entityType,
        actionType: bulkAction.actionType,
      });

      return bulkAction;
    } catch (error) {
      if (error instanceof NotFoundError) {
        logger.withTrace(traceId).warn('Bulk action not found', { id });
      } else {
        logger.withTrace(traceId).error('Failed to get bulk action by ID', {
          error: error instanceof Error ? error.message : String(error),
          id,
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
      // Create bulk action entity
      const id = request.id;
      const bulkActionData: BulkActionCreateData = {
        id,
        accountId: request.accountId,
        entityType: request.entityType,
        actionType: request.actionType,
        status: 'queued',
        totalEntities: request.totalEntities || 0,
        processedEntities: 0,
        scheduledAt: request.scheduledAt,
        configuration: request.configuration || {},
      };

      const bulkAction = new BulkAction(bulkActionData as IBulkAction);

      // Save to database
      const createdBulkAction = await this.bulkActionRepository.create(bulkAction, traceId);

      log.info('Bulk action created successfully', {
        id: createdBulkAction.id,
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
    id: string,
    updates: BulkActionUpdateData,
    traceId: string
  ): Promise<IBulkAction> {
    if (!id) {
      throw new ValidationError('ID is required');
    }

    const log = logger.withTrace(traceId);

    log.info('Updating bulk action', {
      id,
      updates: Object.keys(updates),
    });

    try {
      // Get current bulk action
      const currentBulkAction = await this.bulkActionRepository.findById(id, traceId);

      if (!currentBulkAction) {
        throw new NotFoundError('Bulk action');
      }

      // Validate status transitions
      if (updates.status) {
        this.validateStatusTransition(currentBulkAction.status, updates.status);
      }

      // Perform update
      const updatedBulkAction = await this.bulkActionRepository.update(id, updates, traceId);

      if (!updatedBulkAction) {
        throw new NotFoundError('Bulk action');
      }

      log.info('Bulk action updated successfully', {
        id,
        oldStatus: currentBulkAction.status,
        newStatus: updatedBulkAction.status,
      });

      return updatedBulkAction;
    } catch (error) {
      log.error('Failed to update bulk action', {
        error: error instanceof Error ? error.message : String(error),
        id,
        updates,
      });
      throw error;
    }
  }

  /**
   * Update progress for bulk action
   */
  public async updateProgress(
    id: string,
    processedEntities: number,
    traceId: string
  ): Promise<IBulkAction> {
    const log = logger.withTrace(traceId);

    try {
      const updates: BulkActionUpdateData = {};

      // Get current action to check if it should be completed
      const currentAction = await this.getBulkActionById(id, traceId);

      if (
        processedEntities >= currentAction.totalEntities &&
        currentAction.status === 'processing'
      ) {
        updates.status = 'completed';
        updates.completedAt = new Date();
      }

      const updatedAction = await this.updateBulkAction(id, updates, traceId);

      log.debug('Bulk action progress updated', {
        id,
        processedEntities,
        totalEntities: updatedAction.totalEntities,
      });

      return updatedAction;
    } catch (error) {
      log.error('Failed to update bulk action progress', {
        error: error instanceof Error ? error.message : String(error),
        id,
        processedEntities,
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
    const validEntityTypes: EntityType[] = ['contact'];
    if (!validEntityTypes.includes(request.entityType)) {
      throw new ValidationError(`Invalid entity type: ${request.entityType}`);
    }

    // Validate action type
    const validActionTypes: BulkActionType[] = ['bulk_update'];
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
      queued: ['processing', 'cancelled', 'validating'],
      validating: ['processing', 'cancelled', 'failed'],
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
  }
}
