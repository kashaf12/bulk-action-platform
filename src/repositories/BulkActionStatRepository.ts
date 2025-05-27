/**
 * Repository for bulk action statistics data access
 * Implements data access layer for bulk action stats with proper abstraction
 * Follows Repository pattern and Dependency Inversion principle
 */

import { BaseRepository } from '../core/BaseRepository';
import { BulkActionStat } from '../models/BulkActionStat';
import {
  IBulkActionStat,
  BulkActionStatCreateData,
  BulkActionStatUpdateData,
} from '../types/entities/bulk-action-stat';
import { logger } from '../utils/logger';
import { DatabaseError } from '../utils/error';
import database from '../config/database';

export class BulkActionStatRepository extends BaseRepository<IBulkActionStat> {
  constructor() {
    super(BulkActionStat);
  }

  /**
   * Implementation of abstract method from BaseRepository
   * Creates BulkActionStat instance from database row using type-safe factory method
   */
  protected createEntityFromRow(row: Record<string, unknown>): IBulkActionStat {
    return BulkActionStat.fromDbRow(row);
  }

  /**
   * Find bulk action statistics by action ID
   */
  public async findByActionId(actionId: string, traceId: string): Promise<IBulkActionStat | null> {
    const log = logger.withTrace(traceId);

    try {
      const query = `
        SELECT 
          id, action_id, total_records, successful_records, failed_records,
          skipped_records, created_at, updated_at
        FROM bulk_action_stats 
        WHERE action_id = $1
      `;

      const result = await database.query(query, [actionId], traceId);

      if (result.rows.length === 0) {
        log.debug('Bulk action stats not found by action ID', { actionId });
        return null;
      }

      const row = result.rows[0];
      if (!row) {
        log.warn('No rows returned for bulk action stats by action ID', { actionId });
        return null;
      }

      const bulkActionStat = BulkActionStat.fromDbRow(row);

      log.debug('Bulk action stats found by action ID', {
        actionId,
        totalRecords: bulkActionStat.totalRecords,
        successfulRecords: bulkActionStat.successfulRecords,
      });

      return bulkActionStat;
    } catch (error) {
      log.error('Find bulk action stats by action ID failed', {
        error: error instanceof Error ? error.message : String(error),
        actionId,
      });
      throw new DatabaseError(`Find bulk action stats by action ID failed: ${error}`);
    }
  }

  /**
   * Create or update bulk action statistics (upsert)
   */
  public async createOrUpdate(
    data: BulkActionStatCreateData,
    traceId: string
  ): Promise<IBulkActionStat> {
    const log = logger.withTrace(traceId);

    try {
      const query = `
        INSERT INTO bulk_action_stats (
          action_id, total_records, successful_records, failed_records,
          skipped_records
        )
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (action_id) DO UPDATE SET
          total_records = EXCLUDED.total_records,
          successful_records = EXCLUDED.successful_records,
          failed_records = EXCLUDED.failed_records,
          skipped_records = EXCLUDED.skipped_records,
          updated_at = NOW()
        RETURNING 
          id, action_id, total_records, successful_records, failed_records,
          skipped_records, created_at, updated_at
      `;

      const values = [
        data.actionId,
        data.totalRecords || 0,
        data.successfulRecords || 0,
        data.failedRecords || 0,
        data.skippedRecords || 0,
      ];

      const result = await database.query(query, values, traceId);

      if (result.rows.length === 0) {
        throw new Error('Failed to create or update bulk action stats, no rows returned');
      }

      const row = result.rows[0];
      if (!row) {
        throw new Error('Failed to create or update bulk action stats, no rows returned');
      }

      const bulkActionStat = BulkActionStat.fromDbRow(row);

      log.info('Bulk action stats created or updated successfully', {
        actionId: data.actionId,
        totalRecords: bulkActionStat.totalRecords,
        successfulRecords: bulkActionStat.successfulRecords,
        isUpdate: row.created_at !== row.updated_at,
      });

      return bulkActionStat;
    } catch (error) {
      log.error('Failed to create or update bulk action stats', {
        error: error instanceof Error ? error.message : String(error),
        actionId: data.actionId,
        data,
      });
      throw new DatabaseError(`Failed to create or update bulk action stats: ${error}`);
    }
  }

  /**
   * Update bulk action statistics by action ID
   */
  public async updateByActionId(
    actionId: string,
    updates: BulkActionStatUpdateData,
    traceId: string
  ): Promise<IBulkActionStat | null> {
    const log = logger.withTrace(traceId);

    try {
      const mappings = BulkActionStat.getColumnMappings();
      const setClauses: string[] = [];
      const values: unknown[] = [];
      let paramIndex = 1;

      // Build SET clause from updates
      for (const [field, value] of Object.entries(updates)) {
        const column = mappings[field];
        if (column && value !== undefined) {
          setClauses.push(`${column} = $${paramIndex}`);
          values.push(value);
          paramIndex++;
        }
      }

      if (setClauses.length === 0) {
        throw new Error('No valid fields to update');
      }

      // Add updated_at timestamp
      setClauses.push(`updated_at = NOW()`);
      values.push(actionId);

      const query = `
        UPDATE bulk_action_stats
        SET ${setClauses.join(', ')}
        WHERE action_id = $${paramIndex}
        RETURNING 
          id, action_id, total_records, successful_records, failed_records,
          skipped_records, created_at, updated_at
      `;

      const result = await database.query(query, values, traceId);

      if (result.rows.length === 0) {
        log.warn('Bulk action stats not found for update', { actionId });
        return null;
      }

      const row = result.rows[0];
      if (!row) {
        log.warn('No rows returned for bulk action stats update', { actionId });
        return null;
      }

      const updatedBulkActionStat = BulkActionStat.fromDbRow(row);

      log.info('Bulk action stats updated successfully', {
        actionId,
        updatedFields: Object.keys(updates),
        totalRecords: updatedBulkActionStat.totalRecords,
        successfulRecords: updatedBulkActionStat.successfulRecords,
      });

      return updatedBulkActionStat;
    } catch (error) {
      log.error('Update bulk action stats by action ID failed', {
        error: error instanceof Error ? error.message : String(error),
        actionId,
        updates,
      });
      throw new DatabaseError(`Update bulk action stats failed: ${error}`);
    }
  }

  /**
   * Increment counters atomically
   */
  public async incrementCounters(
    actionId: string,
    increments: {
      successful?: number;
      failed?: number;
      skipped?: number;
    },
    traceId: string
  ): Promise<IBulkActionStat | null> {
    const log = logger.withTrace(traceId);

    try {
      const setClauses: string[] = [];
      const validIncrements: Record<string, number> = {};

      // Build increment clauses
      if (increments.successful && increments.successful > 0) {
        setClauses.push(`successful_records = successful_records + $${setClauses.length + 1}`);
        validIncrements.successful = increments.successful;
      }

      if (increments.failed && increments.failed > 0) {
        setClauses.push(`failed_records = failed_records + $${setClauses.length + 1}`);
        validIncrements.failed = increments.failed;
      }

      if (increments.skipped && increments.skipped > 0) {
        setClauses.push(`skipped_records = skipped_records + $${setClauses.length + 1}`);
        validIncrements.skipped = increments.skipped;
      }

      if (setClauses.length === 0) {
        log.debug('No valid increments provided', { actionId, increments });
        return await this.findByActionId(actionId, traceId);
      }

      const values: (string | number)[] = Object.values(validIncrements);
      values.push(actionId); // Add actionId as last parameter

      const query = `
        UPDATE bulk_action_stats
        SET ${setClauses.join(', ')}, updated_at = NOW()
        WHERE action_id = $${values.length}
        RETURNING 
          id, action_id, total_records, successful_records, failed_records,
          skipped_records, created_at, updated_at
      `;

      const result = await database.query(query, values, traceId);

      if (result.rows.length === 0) {
        log.warn('Bulk action stats not found for increment', { actionId });
        return null;
      }

      const row = result.rows[0];
      if (!row) {
        log.warn('No rows returned for bulk action stats increment', { actionId });
        return null;
      }

      const updatedBulkActionStat = BulkActionStat.fromDbRow(row);

      log.info('Bulk action stats counters incremented successfully', {
        actionId,
        increments: validIncrements,
        newTotals: {
          successful: updatedBulkActionStat.successfulRecords,
          failed: updatedBulkActionStat.failedRecords,
          skipped: updatedBulkActionStat.skippedRecords,
        },
      });

      return updatedBulkActionStat;
    } catch (error) {
      log.error('Failed to increment bulk action stats counters', {
        error: error instanceof Error ? error.message : String(error),
        actionId,
        increments,
      });
      throw new DatabaseError(`Failed to increment bulk action stats counters: ${error}`);
    }
  }

  /**
   * Delete bulk action statistics by action ID
   */
  public async deleteByActionId(actionId: string, traceId: string): Promise<boolean> {
    const log = logger.withTrace(traceId);

    try {
      const query = `DELETE FROM bulk_action_stats WHERE action_id = $1`;
      const result = await database.query(query, [actionId], traceId);

      const deleted = (result.rowCount ?? 0) > 0;

      if (deleted) {
        log.info('Bulk action stats deleted successfully', { actionId });
      } else {
        log.warn('Bulk action stats not found for deletion', { actionId });
      }

      return deleted;
    } catch (error) {
      log.error('Failed to delete bulk action stats', {
        error: error instanceof Error ? error.message : String(error),
        actionId,
      });
      throw new DatabaseError(`Failed to delete bulk action stats: ${error}`);
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
    const log = logger.withTrace(traceId);

    try {
      const data: BulkActionStatCreateData = {
        actionId,
        totalRecords,
        successfulRecords: 0,
        failedRecords: 0,
        skippedRecords: 0,
      };

      const stats = await this.createOrUpdate(data, traceId);

      log.info('Bulk action stats initialized', {
        actionId,
        totalRecords,
      });

      return stats;
    } catch (error) {
      log.error('Failed to initialize bulk action stats', {
        error: error instanceof Error ? error.message : String(error),
        actionId,
        totalRecords,
      });
      throw error;
    }
  }

  /**
   * Check if statistics exist for action
   */
  public async existsByActionId(actionId: string, traceId: string): Promise<boolean> {
    const log = logger.withTrace(traceId);

    try {
      const query = `SELECT 1 FROM bulk_action_stats WHERE action_id = $1 LIMIT 1`;
      const result = await database.query(query, [actionId], traceId);

      const exists = result.rows.length > 0;

      log.debug('Bulk action stats existence check', {
        actionId,
        exists,
      });

      return exists;
    } catch (error) {
      log.error('Failed to check bulk action stats existence', {
        error: error instanceof Error ? error.message : String(error),
        actionId,
      });
      throw new DatabaseError(`Failed to check bulk action stats existence: ${error}`);
    }
  }

  /**
   * Batch update progress for multiple actions
   */
  public async batchUpdateProgress(
    updates: Array<{
      actionId: string;
      increments: {
        successful?: number;
        failed?: number;
        skipped?: number;
        duplicate?: number;
      };
    }>,
    traceId: string
  ): Promise<void> {
    const log = logger.withTrace(traceId);

    if (updates.length === 0) {
      return;
    }

    try {
      const client = await database.getClient();

      try {
        await client.query('BEGIN');

        for (const { actionId, increments } of updates) {
          await this.incrementCounters(actionId, increments, traceId);
        }

        await client.query('COMMIT');

        log.debug('Batch progress update completed', {
          updateCount: updates.length,
        });
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    } catch (error) {
      log.error('Failed to batch update bulk action stats progress', {
        error: error instanceof Error ? error.message : String(error),
        updateCount: updates.length,
      });
      throw new DatabaseError(`Failed to batch update bulk action stats progress: ${error}`);
    }
  }

  /**
   * Get statistics summary with calculated metrics
   */
  public async getStatsSummary(
    actionId: string,
    traceId: string
  ): Promise<{
    id?: string;
    actionId: string;
    totalRecords: number;
    successfulRecords: number;
    failedRecords: number;
    skippedRecords: number;
    processedRecords: number;
    successRate: number;
    failureRate: number;
    skipRate: number;
    completionRate: number;
    createdAt?: Date;
    updatedAt?: Date;
  } | null> {
    const log = logger.withTrace(traceId);

    try {
      const stats = await this.findByActionId(actionId, traceId);

      if (!stats) {
        return null;
      }

      const summary = {
        id: stats.id,
        actionId: stats.actionId,
        totalRecords: stats.totalRecords,
        successfulRecords: stats.successfulRecords,
        failedRecords: stats.failedRecords,
        skippedRecords: stats.skippedRecords,
        processedRecords: stats.successfulRecords + stats.failedRecords + stats.skippedRecords,
        successRate:
          stats.totalRecords > 0
            ? Math.round((stats.successfulRecords / stats.totalRecords) * 100 * 100) / 100
            : 0,
        failureRate:
          stats.totalRecords > 0
            ? Math.round((stats.failedRecords / stats.totalRecords) * 100 * 100) / 100
            : 0,
        skipRate:
          stats.totalRecords > 0
            ? Math.round((stats.skippedRecords / stats.totalRecords) * 100 * 100) / 100
            : 0,
        completionRate:
          stats.totalRecords > 0
            ? Math.round(
                ((stats.successfulRecords + stats.failedRecords + stats.skippedRecords) /
                  stats.totalRecords) *
                  100 *
                  100
              ) / 100
            : 0,
        createdAt: stats.createdAt,
        updatedAt: stats.updatedAt,
      };

      log.debug('Bulk action stats summary calculated', {
        actionId,
        summary,
      });

      return summary;
    } catch (error) {
      log.error('Failed to get bulk action stats summary', {
        error: error instanceof Error ? error.message : String(error),
        actionId,
      });
      throw new DatabaseError(`Failed to get bulk action stats summary: ${error}`);
    }
  }
}
