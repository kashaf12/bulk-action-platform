/**
 * Business logic service for bulk action statistics
 * Implements business rules and orchestrates repository operations
 * Follows Single Responsibility and Dependency Inversion principles
 */

import { BulkActionStatRepository } from '../repositories/BulkActionStatRepository';
import { BulkActionStat } from '../models/BulkActionStat';
import {
  IBulkActionStat,
  BulkActionStatCreateData,
  BulkActionStatUpdateData,
  BulkActionStatSummary,
} from '../types/entities/bulk-action-stat';
import { ValidationError, NotFoundError } from '../utils/error';
import { logger } from '../utils/logger';
import { IService } from '../types/services';

export interface BulkActionStatIncrements {
  successful?: number;
  failed?: number;
  skipped?: number;
  duplicate?: number;
}

export interface BatchStatsUpdate {
  actionId: string;
  increments: BulkActionStatIncrements;
}

export class BulkActionStatService implements IService {
  private bulkActionStatRepository: BulkActionStatRepository;

  constructor(bulkActionStatRepository: BulkActionStatRepository) {
    this.bulkActionStatRepository = bulkActionStatRepository || new BulkActionStatRepository();
  }

  /**
   * Get bulk action statistics by action ID
   */
  public async getStatsByActionId(actionId: string, traceId: string): Promise<IBulkActionStat> {
    if (!actionId) {
      throw new ValidationError('Action ID is required');
    }

    const log = logger.withTrace(traceId);

    log.info('Fetching bulk action statistics', { actionId });

    try {
      const stats = await this.bulkActionStatRepository.findByActionId(actionId, traceId);

      if (!stats) {
        throw new NotFoundError('Bulk action statistics not found');
      }

      log.info('Successfully fetched bulk action statistics', {
        actionId,
        totalRecords: stats.totalRecords,
        successfulRecords: stats.successfulRecords,
      });

      return stats;
    } catch (error) {
      if (error instanceof NotFoundError) {
        log.warn('Bulk action statistics not found', { actionId });
      } else {
        log.error('Failed to get bulk action statistics', {
          error: error instanceof Error ? error.message : String(error),
          actionId,
        });
      }
      throw error;
    }
  }

  /**
   * Get bulk action statistics summary with calculated metrics
   */
  public async getStatsSummary(actionId: string, traceId: string): Promise<BulkActionStatSummary> {
    if (!actionId) {
      throw new ValidationError('Action ID is required');
    }

    const log = logger.withTrace(traceId);

    try {
      const stats = await this.getStatsByActionId(actionId, traceId);
      const bulkActionStat = new BulkActionStat(stats);
      const summary = bulkActionStat.getSummary();

      log.info('Successfully generated bulk action statistics summary', {
        actionId,
      });

      return summary;
    } catch (error) {
      log.error('Failed to get bulk action statistics summary', {
        error: error instanceof Error ? error.message : String(error),
        actionId,
      });
      throw error;
    }
  }

  /**
   * Create or update bulk action statistics
   */
  public async createOrUpdateStats(
    data: BulkActionStatCreateData,
    traceId: string
  ): Promise<IBulkActionStat> {
    const log = logger.withTrace(traceId);

    // Validate request
    this.validateStatData(data);

    log.info('Creating or updating bulk action statistics', {
      actionId: data.actionId,
      totalRecords: data.totalRecords,
    });

    try {
      // Create BulkActionStat entity for validation
      const statEntity = new BulkActionStat(data as IBulkActionStat);

      // Validate entity consistency
      const consistencyErrors = statEntity.getConsistencyErrors();

      if (consistencyErrors.length > 0) {
        throw new ValidationError('Statistics data is inconsistent', consistencyErrors);
      }

      // Save to database
      const createdStats = await this.bulkActionStatRepository.createOrUpdate(data, traceId);

      log.info('Bulk action statistics created or updated successfully', {
        actionId: createdStats.actionId,
        totalRecords: createdStats.totalRecords,
        successfulRecords: createdStats.successfulRecords,
      });

      return createdStats;
    } catch (error) {
      log.error('Failed to create or update bulk action statistics', {
        error: error instanceof Error ? error.message : String(error),
        data,
      });
      throw error;
    }
  }

  /**
   * Update bulk action statistics
   */
  public async updateStats(
    actionId: string,
    updates: BulkActionStatUpdateData,
    traceId: string
  ): Promise<IBulkActionStat> {
    if (!actionId) {
      throw new ValidationError('Action ID is required');
    }

    const log = logger.withTrace(traceId);

    log.info('Updating bulk action statistics', {
      actionId,
      updates: Object.keys(updates),
    });

    try {
      // Get current stats for validation
      const currentStats = await this.bulkActionStatRepository.findByActionId(actionId, traceId);

      if (!currentStats) {
        throw new NotFoundError('Bulk action statistics not found');
      }

      // Validate updates
      this.validateStatUpdates(updates);

      // Create updated entity for consistency check
      const updatedData = { ...currentStats, ...updates };
      const updatedEntity = new BulkActionStat(updatedData);

      const consistencyErrors = updatedEntity.getConsistencyErrors();
      if (consistencyErrors.length > 0) {
        throw new ValidationError('Updated statistics would be inconsistent', consistencyErrors);
      }

      // Perform update
      const updatedStats = await this.bulkActionStatRepository.updateByActionId(
        actionId,
        updates,
        traceId
      );

      if (!updatedStats) {
        throw new NotFoundError('Bulk action statistics not found');
      }

      log.info('Bulk action statistics updated successfully', {
        actionId,
        updatedFields: Object.keys(updates),
      });

      return updatedStats;
    } catch (error) {
      log.error('Failed to update bulk action statistics', {
        error: error instanceof Error ? error.message : String(error),
        actionId,
        updates,
      });
      throw error;
    }
  }

  /**
   * Increment statistics counters atomically
   */
  public async incrementCounters(
    actionId: string,
    increments: BulkActionStatIncrements,
    traceId: string
  ): Promise<IBulkActionStat> {
    if (!actionId) {
      throw new ValidationError('Action ID is required');
    }

    const log = logger.withTrace(traceId);

    // Validate increments
    this.validateIncrements(increments);

    log.info('Incrementing bulk action statistics counters', {
      actionId,
      increments,
    });

    try {
      const updatedStats = await this.bulkActionStatRepository.incrementCounters(
        actionId,
        increments,
        traceId
      );

      if (!updatedStats) {
        throw new NotFoundError('Bulk action statistics not found');
      }

      log.info('Bulk action statistics counters incremented successfully', {
        actionId,
        increments,
        newTotals: {
          successful: updatedStats.successfulRecords,
          failed: updatedStats.failedRecords,
          skipped: updatedStats.skippedRecords,
          duplicate: updatedStats.duplicateRecords,
        },
      });

      return updatedStats;
    } catch (error) {
      log.error('Failed to increment bulk action statistics counters', {
        error: error instanceof Error ? error.message : String(error),
        actionId,
        increments,
      });
      throw error;
    }
  }

  /**
   * Initialize empty statistics for a bulk action
   */
  public async initializeStats(
    actionId: string,
    totalRecords: number,
    traceId: string
  ): Promise<IBulkActionStat> {
    if (!actionId) {
      throw new ValidationError('Action ID is required');
    }

    if (totalRecords < 0) {
      throw new ValidationError('Total records cannot be negative');
    }

    const log = logger.withTrace(traceId);

    log.info('Initializing bulk action statistics', {
      actionId,
      totalRecords,
    });

    try {
      const stats = await this.bulkActionStatRepository.initializeStats(
        actionId,
        totalRecords,
        traceId
      );

      log.info('Bulk action statistics initialized successfully', {
        actionId,
        totalRecords,
      });

      return stats;
    } catch (error) {
      log.error('Failed to initialize bulk action statistics', {
        error: error instanceof Error ? error.message : String(error),
        actionId,
        totalRecords,
      });
      throw error;
    }
  }

  /**
   * Batch update statistics for multiple actions (for workers)
   */
  public async batchUpdateProgress(updates: BatchStatsUpdate[], traceId: string): Promise<void> {
    const log = logger.withTrace(traceId);

    if (updates.length === 0) {
      return;
    }

    // Validate all updates first
    for (const update of updates) {
      this.validateIncrements(update.increments);
    }

    log.info('Starting batch statistics update', {
      updateCount: updates.length,
    });

    try {
      await this.bulkActionStatRepository.batchUpdateProgress(updates, traceId);

      log.info('Batch statistics update completed successfully', {
        updateCount: updates.length,
      });
    } catch (error) {
      log.error('Failed to batch update statistics', {
        error: error instanceof Error ? error.message : String(error),
        updateCount: updates.length,
      });
      throw error;
    }
  }

  /**
   * Get detailed statistics with all calculated metrics
   */
  public async getDetailedStats(actionId: string, traceId: string) {
    const log = logger.withTrace(traceId);

    try {
      const summary = await this.bulkActionStatRepository.getStatsSummary(actionId, traceId);

      if (!summary) {
        throw new NotFoundError('Bulk action statistics not found');
      }

      log.debug('Detailed statistics retrieved', {
        actionId,
        successRate: summary.successRate,
        completionRate: summary.completionRate,
      });

      return summary;
    } catch (error) {
      log.error('Failed to get detailed statistics', {
        error: error instanceof Error ? error.message : String(error),
        actionId,
      });
      throw error;
    }
  }

  /**
   * Validate statistics data
   */
  private validateStatData(data: BulkActionStatCreateData): void {
    if (!data.actionId) {
      throw new ValidationError('Action ID is required');
    }

    if (data.totalRecords !== undefined && data.totalRecords < 0) {
      throw new ValidationError('Total records cannot be negative');
    }

    if (data.successfulRecords !== undefined && data.successfulRecords < 0) {
      throw new ValidationError('Successful records cannot be negative');
    }

    if (data.failedRecords !== undefined && data.failedRecords < 0) {
      throw new ValidationError('Failed records cannot be negative');
    }

    if (data.skippedRecords !== undefined && data.skippedRecords < 0) {
      throw new ValidationError('Skipped records cannot be negative');
    }

    if (data.duplicateRecords !== undefined && data.duplicateRecords < 0) {
      throw new ValidationError('Duplicate records cannot be negative');
    }
  }

  /**
   * Validate statistics updates
   */
  private validateStatUpdates(updates: BulkActionStatUpdateData): void {
    if (updates.totalRecords !== undefined && updates.totalRecords < 0) {
      throw new ValidationError('Total records cannot be negative');
    }

    if (updates.successfulRecords !== undefined && updates.successfulRecords < 0) {
      throw new ValidationError('Successful records cannot be negative');
    }

    if (updates.failedRecords !== undefined && updates.failedRecords < 0) {
      throw new ValidationError('Failed records cannot be negative');
    }

    if (updates.skippedRecords !== undefined && updates.skippedRecords < 0) {
      throw new ValidationError('Skipped records cannot be negative');
    }

    if (updates.duplicateRecords !== undefined && updates.duplicateRecords < 0) {
      throw new ValidationError('Duplicate records cannot be negative');
    }
  }

  /**
   * Validate counter increments
   */
  private validateIncrements(increments: BulkActionStatIncrements): void {
    if (increments.successful !== undefined && increments.successful < 0) {
      throw new ValidationError('Successful increment cannot be negative');
    }

    if (increments.failed !== undefined && increments.failed < 0) {
      throw new ValidationError('Failed increment cannot be negative');
    }

    if (increments.skipped !== undefined && increments.skipped < 0) {
      throw new ValidationError('Skipped increment cannot be negative');
    }

    if (increments.duplicate !== undefined && increments.duplicate < 0) {
      throw new ValidationError('Duplicate increment cannot be negative');
    }

    // Check if at least one increment is provided
    const hasValidIncrement = Object.values(increments).some(
      value => value !== undefined && value > 0
    );

    if (!hasValidIncrement) {
      throw new ValidationError('At least one positive increment must be provided');
    }
  }
}
