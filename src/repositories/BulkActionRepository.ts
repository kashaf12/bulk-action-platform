/**
 * Repository for bulk action data access
 * Implements data access layer with proper abstraction
 * Follows Repository pattern and Dependency Inversion principle
 */

import { BaseRepository } from '../core/BaseRepository';
import { BulkAction } from '../models/BulkAction';
import {
  IBulkAction,
  BulkActionStatus,
  BulkActionType,
  EntityType,
} from '../types/entities/bulk-action';
import { PaginationParams, PaginatedResult } from '../types';
import { logger } from '../utils/logger';
import { DatabaseError } from '../utils/error';
import database from '../config/database';

export interface BulkActionSearchParams extends PaginationParams {
  accountId?: string;
}

export interface BulkActionStats {
  total: number;
  byStatus: Record<BulkActionStatus, number>;
  byEntityType: Record<EntityType, number>;
  byActionType: Record<BulkActionType, number>;
  avgProcessingTime?: number;
  successRate?: number;
}

export class BulkActionRepository extends BaseRepository<IBulkAction> {
  constructor() {
    super(BulkAction);
  }

  /**
   * Implementation of abstract method from BaseRepository
   * Creates BulkAction instance from database row using type-safe factory method
   */
  protected createEntityFromRow(row: Record<string, unknown>): IBulkAction {
    return BulkAction.fromDbRow(row);
  }

  /**
   * Find bulk actions with advanced filtering
   */
  public async findWithFilters(
    params: BulkActionSearchParams,
    traceId: string
  ): Promise<PaginatedResult<IBulkAction>> {
    const log = logger.withTrace(traceId);

    try {
      const { page, limit, accountId, ...otherFilters } = params;
      const offset = (page - 1) * limit;

      // Build dynamic WHERE conditions
      const conditions: string[] = [];
      const queryParams: unknown[] = [];
      let paramIndex = 1;

      // Add filters
      if (accountId) {
        conditions.push(`account_id = $${paramIndex}`);
        queryParams.push(accountId);
        paramIndex++;
      }

      // Add other filters from base method
      for (const [field, value] of Object.entries(otherFilters)) {
        const columnMappings = BulkAction.getColumnMappings();
        const column = columnMappings[field];
        if (column && value !== undefined && value !== null) {
          conditions.push(`${column} = $${paramIndex}`);
          queryParams.push(value);
          paramIndex++;
        }
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

      // Count total records
      const countQuery = `SELECT COUNT(*) as total FROM bulk_actions ${whereClause}`;
      const countResult = await database.query(countQuery, queryParams, traceId);
      const total = parseInt(countResult.rows[0]?.total || '0');

      // Fetch paginated data with proper ordering
      const dataQuery = `
        SELECT 
          id, action_id, account_id, entity_type, action_type, status,
          total_entities, processed_entities, scheduled_at, started_at, 
          completed_at, configuration, error_message, created_at, updated_at
        FROM bulk_actions 
        ${whereClause}
        ORDER BY 
          CASE 
            WHEN status = 'processing' THEN 1
            WHEN status = 'queued' THEN 2
            WHEN status = 'failed' THEN 3
            ELSE 4
          END,
          created_at DESC
        LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
      `;

      const dataResult = await database.query(dataQuery, [...queryParams, limit, offset], traceId);

      // Convert to BulkAction instances using type-safe factory method
      const bulkActions = dataResult.rows.map(row => BulkAction.fromDbRow(row));

      const totalPages = Math.ceil(total / limit);

      log.debug('Bulk actions search completed', {
        total,
        returned: bulkActions.length,
        filters: { accountId },
      });

      return {
        data: bulkActions,
        pagination: {
          page,
          limit,
          total,
          totalPages,
          hasNext: page < totalPages,
          hasPrev: page > 1,
        },
      };
    } catch (error) {
      log.error('Bulk actions search failed', {
        error: error instanceof Error ? error.message : String(error),
        params,
      });
      throw new DatabaseError(`Bulk actions search failed: ${error}`);
    }
  }

  /**
   * Find bulk action by action ID
   */
  public async findByActionId(actionId: string, traceId: string): Promise<IBulkAction | null> {
    const log = logger.withTrace(traceId);

    try {
      const query = `
        SELECT 
          id, action_id, account_id, entity_type, action_type, status,
          total_entities, processed_entities, scheduled_at, started_at, 
          completed_at, configuration, error_message, created_at, updated_at
        FROM bulk_actions 
        WHERE action_id = $1
      `;

      const result = await database.query(query, [actionId], traceId);

      if (result.rows.length === 0) {
        log.debug('Bulk action not found by action ID', { actionId });
        return null;
      }

      const row = result.rows[0];
      if (!row) {
        log.warn('No rows returned for bulk action by action ID', { actionId });
        return null;
      }

      const bulkAction = BulkAction.fromDbRow(row);

      log.debug('Bulk action found by action ID', {
        actionId,
        status: bulkAction.status,
      });

      return bulkAction;
    } catch (error) {
      log.error('Find bulk action by action ID failed', {
        error: error instanceof Error ? error.message : String(error),
        actionId,
      });
      throw new DatabaseError(`Find bulk action by action ID failed: ${error}`);
    }
  }

  /**
   * Update bulk action by action ID
   */
  public async updateByActionId(
    actionId: string,
    updates: Partial<IBulkAction>,
    traceId: string
  ): Promise<IBulkAction | null> {
    const log = logger.withTrace(traceId);

    try {
      const mappings = BulkAction.getColumnMappings();
      const setClauses: string[] = [];
      const values: unknown[] = [];
      let paramIndex = 1;

      // Build SET clause from updates
      for (const [field, value] of Object.entries(updates)) {
        const column = mappings[field];
        if (column && value !== undefined) {
          if (field === 'configuration') {
            // Handle JSON serialization for configuration
            setClauses.push(`${column} = $${paramIndex}`);
            values.push(JSON.stringify(value));
          } else {
            setClauses.push(`${column} = $${paramIndex}`);
            values.push(value);
          }
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
        UPDATE bulk_actions
        SET ${setClauses.join(', ')}
        WHERE action_id = $${paramIndex}
        RETURNING 
          id, action_id, account_id, entity_type, action_type, status,
          total_entities, processed_entities, scheduled_at, started_at, 
          completed_at, configuration, error_message, created_at, updated_at
      `;

      const result = await database.query(query, values, traceId);

      if (result.rows.length === 0) {
        log.warn('Bulk action not found for update', { actionId });
        return null;
      }

      const row = result.rows[0];
      if (!row) {
        log.warn('No rows returned for bulk action update', { actionId });
        return null;
      }

      const updatedBulkAction = BulkAction.fromDbRow(row);

      log.info('Bulk action updated successfully', {
        actionId,
        updatedFields: Object.keys(updates),
        newStatus: updatedBulkAction.status,
      });

      return updatedBulkAction;
    } catch (error) {
      log.error('Update bulk action by action ID failed', {
        error: error instanceof Error ? error.message : String(error),
        actionId,
        updates,
      });
      throw new DatabaseError(`Update bulk action failed: ${error}`);
    }
  }

  /**
   * Get bulk actions that are ready to process (scheduled time has passed)
   */
  public async findReadyToProcess(limit = 10, traceId: string): Promise<IBulkAction[]> {
    const log = logger.withTrace(traceId);

    try {
      const query = `
        SELECT 
          id, action_id, account_id, entity_type, action_type, status,
          total_entities, processed_entities, scheduled_at, started_at, 
          completed_at, configuration, error_message, created_at, updated_at
        FROM bulk_actions 
        WHERE status = 'queued' 
          AND (scheduled_at IS NULL OR scheduled_at <= NOW())
        ORDER BY 
          CASE WHEN scheduled_at IS NULL THEN 1 ELSE 2 END,
          created_at ASC
        LIMIT $1
      `;

      const result = await database.query(query, [limit], traceId);
      const bulkActions = result.rows.map(row => BulkAction.fromDbRow(row));

      log.debug('Found bulk actions ready to process', {
        count: bulkActions.length,
        limit,
      });

      return bulkActions;
    } catch (error) {
      log.error('Failed to find bulk actions ready to process', {
        error: error instanceof Error ? error.message : String(error),
        limit,
      });
      throw new DatabaseError(`Failed to find ready bulk actions: ${error}`);
    }
  }

  // ... (rest of the methods remain the same but using BulkAction.fromDbRow() instead)
  // The rest of the methods follow the same pattern - I'll include a few key ones:

  /**
   * Get bulk actions by account with pagination
   */
  public async findByAccount(
    accountId: string,
    params: PaginationParams,
    traceId: string
  ): Promise<PaginatedResult<IBulkAction>> {
    const log = logger.withTrace(traceId);

    try {
      return await this.findWithFilters({ ...params, accountId }, traceId);
    } catch (error) {
      log.error('Failed to find bulk actions by account', {
        error: error instanceof Error ? error.message : String(error),
        accountId,
        params,
      });
      throw error;
    }
  }

  /**
   * Get running bulk actions for an account (for rate limiting)
   */
  public async getRunningActionsCount(accountId: string, traceId: string): Promise<number> {
    const log = logger.withTrace(traceId);

    try {
      const query = `
        SELECT COUNT(*) as count
        FROM bulk_actions 
        WHERE account_id = $1 AND status IN ('queued', 'processing')
      `;

      const result = await database.query(query, [accountId], traceId);
      const count = parseInt(result.rows[0]?.count || '0');

      log.debug('Running bulk actions count retrieved', {
        accountId,
        count,
      });

      return count;
    } catch (error) {
      log.error('Failed to get running bulk actions count', {
        error: error instanceof Error ? error.message : String(error),
        accountId,
      });
      throw new DatabaseError(`Failed to get running actions count: ${error}`);
    }
  }

  /**
   * Get bulk action statistics
   */
  public async getStatistics(
    accountId?: string,
    dateFrom?: Date,
    dateTo?: Date,
    traceId?: string
  ): Promise<BulkActionStats> {
    const log = traceId ? logger.withTrace(traceId) : logger;

    try {
      const conditions: string[] = [];
      const queryParams: unknown[] = [];
      let paramIndex = 1;

      if (accountId) {
        conditions.push(`account_id = $${paramIndex}`);
        queryParams.push(accountId);
        paramIndex++;
      }

      if (dateFrom) {
        conditions.push(`created_at >= $${paramIndex}`);
        queryParams.push(dateFrom);
        paramIndex++;
      }

      if (dateTo) {
        conditions.push(`created_at <= $${paramIndex}`);
        queryParams.push(dateTo);
        paramIndex++;
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

      // Get overall statistics
      const statsQuery = `
        SELECT 
          COUNT(*) as total,
          COUNT(CASE WHEN status = 'queued' THEN 1 END) as queued,
          COUNT(CASE WHEN status = 'processing' THEN 1 END) as processing,
          COUNT(CASE WHEN status = 'completed' THEN 1 END) as completed,
          COUNT(CASE WHEN status = 'failed' THEN 1 END) as failed,
          COUNT(CASE WHEN status = 'cancelled' THEN 1 END) as cancelled,
          
          COUNT(CASE WHEN entity_type = 'contact' THEN 1 END) as contact_count,
          COUNT(CASE WHEN entity_type = 'company' THEN 1 END) as company_count,
          COUNT(CASE WHEN entity_type = 'lead' THEN 1 END) as lead_count,
          COUNT(CASE WHEN entity_type = 'opportunity' THEN 1 END) as opportunity_count,
          COUNT(CASE WHEN entity_type = 'task' THEN 1 END) as task_count,
          
          COUNT(CASE WHEN action_type = 'bulk_update' THEN 1 END) as bulk_update_count,
          COUNT(CASE WHEN action_type = 'bulk_delete' THEN 1 END) as bulk_delete_count,
          COUNT(CASE WHEN action_type = 'bulk_create' THEN 1 END) as bulk_create_count,
          
          AVG(
            CASE 
              WHEN started_at IS NOT NULL AND completed_at IS NOT NULL 
              THEN EXTRACT(EPOCH FROM (completed_at - started_at)) * 1000
            END
          ) as avg_processing_time_ms
          
        FROM bulk_actions 
        ${whereClause}
      `;

      const result = await database.query(statsQuery, queryParams, traceId);
      const row = result.rows[0];

      if (!row) {
        log.warn('No bulk action statistics found', {
          accountId,
          dateRange: { from: dateFrom, to: dateTo },
        });
        return {
          total: 0,
          byStatus: {
            queued: 0,
            processing: 0,
            completed: 0,
            failed: 0,
            cancelled: 0,
          },
          byEntityType: {
            contact: 0,
            company: 0,
            lead: 0,
            opportunity: 0,
            task: 0,
          },
          byActionType: {
            bulk_update: 0,
            bulk_delete: 0,
            bulk_create: 0,
          },
        };
      }

      const stats: BulkActionStats = {
        total: parseInt(row.total),
        byStatus: {
          queued: parseInt(row.queued),
          processing: parseInt(row.processing),
          completed: parseInt(row.completed),
          failed: parseInt(row.failed),
          cancelled: parseInt(row.cancelled),
        },
        byEntityType: {
          contact: parseInt(row.contact_count),
          company: parseInt(row.company_count),
          lead: parseInt(row.lead_count),
          opportunity: parseInt(row.opportunity_count),
          task: parseInt(row.task_count),
        },
        byActionType: {
          bulk_update: parseInt(row.bulk_update_count),
          bulk_delete: parseInt(row.bulk_delete_count),
          bulk_create: parseInt(row.bulk_create_count),
        },
        avgProcessingTime: row.avg_processing_time_ms
          ? parseFloat(row.avg_processing_time_ms)
          : undefined,
        successRate:
          parseInt(row.total) > 0
            ? (parseInt(row.completed) / parseInt(row.total)) * 100
            : undefined,
      };

      log.debug('Bulk action statistics retrieved', {
        accountId,
        dateRange: { from: dateFrom, to: dateTo },
        stats,
      });

      return stats;
    } catch (error) {
      log.error('Failed to get bulk action statistics', {
        error: error instanceof Error ? error.message : String(error),
        accountId,
        dateRange: { from: dateFrom, to: dateTo },
      });
      throw new DatabaseError(`Failed to get bulk action statistics: ${error}`);
    }
  }

  /**
   * Clean up old completed bulk actions
   */
  public async cleanupOldActions(
    olderThanDays: number,
    batchSize = 100,
    traceId: string
  ): Promise<number> {
    const log = logger.withTrace(traceId);

    try {
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - olderThanDays);

      const query = `
        DELETE FROM bulk_actions 
        WHERE status IN ('completed', 'failed', 'cancelled')
          AND completed_at < $1
          AND id IN (
            SELECT id FROM bulk_actions 
            WHERE status IN ('completed', 'failed', 'cancelled')
              AND completed_at < $1
            ORDER BY completed_at ASC
            LIMIT $2
          )
      `;

      const result = await database.query(query, [cutoffDate, batchSize], traceId);
      const deletedCount = result.rowCount || 0;

      log.info('Old bulk actions cleaned up', {
        deletedCount,
        cutoffDate,
        batchSize,
      });

      return deletedCount;
    } catch (error) {
      log.error('Failed to cleanup old bulk actions', {
        error: error instanceof Error ? error.message : String(error),
        olderThanDays,
        batchSize,
      });
      throw new DatabaseError(`Failed to cleanup old bulk actions: ${error}`);
    }
  }

  /**
   * Update progress for multiple bulk actions atomically
   */
  public async updateProgress(
    updates: Array<{ actionId: string; processedEntities: number; status?: BulkActionStatus }>,
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

        for (const { actionId, processedEntities, status } of updates) {
          let query: string;
          let values: unknown[];

          if (status) {
            query = `
              UPDATE bulk_actions 
              SET processed_entities = $1, status = $2, updated_at = NOW()
              WHERE action_id = $3
            `;
            values = [processedEntities, status, actionId];
          } else {
            query = `
              UPDATE bulk_actions 
              SET processed_entities = $1, updated_at = NOW()
              WHERE action_id = $2
            `;
            values = [processedEntities, actionId];
          }

          await client.query(query, values);
        }

        await client.query('COMMIT');

        log.debug('Bulk progress update completed', {
          updateCount: updates.length,
        });
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    } catch (error) {
      log.error('Failed to update bulk action progress', {
        error: error instanceof Error ? error.message : String(error),
        updateCount: updates.length,
      });
      throw new DatabaseError(`Failed to update bulk action progress: ${error}`);
    }
  }
}
