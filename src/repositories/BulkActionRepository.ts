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
          id, account_id, entity_type, action_type, status,
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
   * Update progress for multiple bulk actions atomically
   */
  public async updateProgress(
    updates: Array<{ id: string; processedEntities: number; status?: BulkActionStatus }>,
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

        for (const { id, processedEntities, status } of updates) {
          let query: string;
          let values: unknown[];

          if (status) {
            query = `
              UPDATE bulk_actions 
              SET processed_entities = $1, status = $2, updated_at = NOW()
              WHERE action_id = $3
            `;
            values = [processedEntities, status, id];
          } else {
            query = `
              UPDATE bulk_actions 
              SET processed_entities = $1, updated_at = NOW()
              WHERE action_id = $2
            `;
            values = [processedEntities, id];
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
