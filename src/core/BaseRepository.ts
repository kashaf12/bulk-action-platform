/**
 * Base repository implementation with common CRUD operations
 * Provides generic database operations with proper typing
 * Follows Repository pattern and Dependency Inversion principle
 */

import { IRepository, IEntity, PaginationParams, PaginatedResult } from '../types';
import { BaseEntity } from './BaseEntity';
import { DatabaseError } from '../utils/error';
import { logger } from '../utils/logger';
import database from '../config/database';

export abstract class BaseRepository<T extends IEntity> implements IRepository<T> {
  protected readonly entityClass: typeof BaseEntity;
  protected readonly tableName: string;

  constructor(entityClass: typeof BaseEntity) {
    this.entityClass = entityClass;
    this.tableName = entityClass.getTableName();
  }

  /**
   * Abstract method to create entity instance from database row
   * Must be implemented by concrete repository classes
   */
  protected abstract createEntityFromRow(row: Record<string, unknown>): T;

  /**
   * Find all entities with pagination
   */
  public async findAll(
    params: PaginationParams & Record<string, unknown>,
    traceId: string
  ): Promise<PaginatedResult<T>> {
    const log = logger.withTrace(traceId);

    try {
      const { page, limit, ...filters } = params;
      const offset = (page - 1) * limit;

      // Build WHERE clause from filters
      const { whereClause, queryParams } = this.buildWhereClause(filters);

      // Count total records
      const countQuery = `SELECT COUNT(*) as total FROM ${this.tableName} ${whereClause}`;
      const countResult = await database.query(countQuery, queryParams, traceId);
      const total = parseInt(countResult.rows[0]?.total || '0');

      // Fetch paginated data
      const dataQuery = `
        SELECT * FROM ${this.tableName} 
        ${whereClause}
        ORDER BY created_at DESC
        LIMIT $${queryParams.length + 1} OFFSET $${queryParams.length + 2}
      `;

      const dataResult = await database.query(dataQuery, [...queryParams, limit, offset], traceId);

      // Convert rows to entity instances using concrete implementation
      const entities = dataResult.rows.map(row => this.createEntityFromRow(row));

      // Calculate pagination metadata
      const totalPages = Math.ceil(total / limit);
      const hasNext = page < totalPages;
      const hasPrev = page > 1;

      log.debug('Successfully fetched entities', {
        total,
        returned: entities.length,
        page,
        limit,
      });

      return {
        data: entities,
        pagination: {
          page,
          limit,
          total,
          totalPages,
          hasNext,
          hasPrev,
        },
      };
    } catch (error) {
      log.error('Failed to fetch entities', {
        error: error instanceof Error ? error.message : String(error),
        params,
      });
      throw new DatabaseError(`Failed to fetch entities: ${error}`);
    }
  }

  /**
   * Find entity by ID
   */
  public async findById(id: string, traceId: string): Promise<T | null> {
    const log = logger.withTrace(traceId);

    try {
      const query = `SELECT * FROM ${this.tableName} WHERE id = $1`;
      const result = await database.query(query, [id], traceId);

      if (result.rows.length === 0) {
        log.debug('Entity not found', { id });
        return null;
      }

      const row = result.rows[0];
      if (!row) {
        log.debug('Entity row is undefined', { id });
        return null;
      }
      const entity = this.createEntityFromRow(row);
      log.debug('Successfully fetched entity by ID', { id });

      return entity;
    } catch (error) {
      log.error('Failed to fetch entity by ID', {
        error: error instanceof Error ? error.message : String(error),
        id,
      });
      throw new DatabaseError(`Failed to fetch entity: ${error}`);
    }
  }

  /**
   * Create new entity
   */
  public async create(entity: T, traceId: string): Promise<T> {
    const log = logger.withTrace(traceId);

    try {
      const dbObject = (entity as unknown as BaseEntity).toDbObject();
      const columns = Object.keys(dbObject).filter(key => dbObject[key] !== undefined);
      const values = columns.map(key => dbObject[key]);
      const placeholders = columns.map((_, index) => `$${index + 1}`);

      const query = `
        INSERT INTO ${this.tableName} (${columns.join(', ')})
        VALUES (${placeholders.join(', ')})
        RETURNING *
      `;

      const result = await database.query(query, values, traceId);

      if (result.rows.length === 0) {
        throw new Error('Failed to create entity, no rows returned');
      }

      const row = result.rows[0];
      if (!row) {
        log.debug('Entity row is undefined');
        throw new Error('Failed to create entity, no rows returned');
      }
      const createdEntity = this.createEntityFromRow(row);

      log.info('Successfully created entity', {
        entityType: this.entityClass.getEntityType(),
        id: createdEntity.id,
      });

      return createdEntity;
    } catch (error) {
      log.error('Failed to create entity', {
        error: error instanceof Error ? error.message : String(error),
        entityType: this.entityClass.getEntityType(),
      });
      throw new DatabaseError(`Failed to create entity: ${error}`);
    }
  }

  /**
   * Update entity by ID
   */
  public async update(id: string, updates: Partial<T>, traceId: string): Promise<T | null> {
    const log = logger.withTrace(traceId);

    try {
      const mappings = this.entityClass.getColumnMappings();
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
      values.push(id);

      const query = `
        UPDATE ${this.tableName}
        SET ${setClauses.join(', ')}
        WHERE id = $${paramIndex}
        RETURNING *
      `;

      const result = await database.query(query, values, traceId);

      if (result.rows.length === 0) {
        log.warn('Entity not found for update', { id });
        return null;
      }

      const row = result.rows[0];
      if (!row) {
        log.debug('Entity not found for update', { id });
        return null;
      }

      const updatedEntity = this.createEntityFromRow(row);

      log.info('Successfully updated entity', {
        entityType: this.entityClass.getEntityType(),
        id,
        updatedFields: Object.keys(updates),
      });

      return updatedEntity;
    } catch (error) {
      log.error('Failed to update entity', {
        error: error instanceof Error ? error.message : String(error),
        id,
        updates,
      });
      throw new DatabaseError(`Failed to update entity: ${error}`);
    }
  }

  /**
   * Delete entity by ID
   */
  public async delete(id: string, traceId: string): Promise<boolean> {
    const log = logger.withTrace(traceId);

    try {
      const query = `DELETE FROM ${this.tableName} WHERE id = $1`;
      const result = await database.query(query, [id], traceId);

      const deleted = (result.rowCount ?? 0) > 0;

      if (deleted) {
        log.info('Successfully deleted entity', {
          entityType: this.entityClass.getEntityType(),
          id,
        });
      } else {
        log.warn('Entity not found for deletion', { id });
      }

      return deleted;
    } catch (error) {
      log.error('Failed to delete entity', {
        error: error instanceof Error ? error.message : String(error),
        id,
      });
      throw new DatabaseError(`Failed to delete entity: ${error}`);
    }
  }

  /**
   * Build WHERE clause from filter parameters
   */
  protected buildWhereClause(filters: Record<string, unknown>): {
    whereClause: string;
    queryParams: unknown[];
  } {
    const conditions: string[] = [];
    const queryParams: unknown[] = [];
    const mappings = this.entityClass.getColumnMappings();

    let paramIndex = 1;

    for (const [field, value] of Object.entries(filters)) {
      const column = mappings[field];
      if (column && value !== undefined && value !== null) {
        conditions.push(`${column} = $${paramIndex}`);
        queryParams.push(value);
        paramIndex++;
      }
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    return { whereClause, queryParams };
  }

  /**
   * Execute custom query with entity mapping
   */
  protected async executeQuery(query: string, params: unknown[], traceId: string): Promise<T[]> {
    try {
      const result = await database.query(query, params, traceId);
      return result.rows.map(row => this.createEntityFromRow(row));
    } catch (error) {
      throw new DatabaseError(`Query execution failed: ${error}`);
    }
  }

  /**
   * Begin database transaction
   */
  protected async beginTransaction(traceId: string) {
    const log = logger.withTrace(traceId);
    try {
      const client = await database.getClient();
      await client.query('BEGIN');
      log.debug('Transaction started');
      return client;
    } catch (error) {
      log.error('Failed to start transaction', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw new DatabaseError(`Transaction failed: ${error}`);
    }
  }

  /**
   * Commit database transaction
   */
  protected async commitTransaction(client: any, traceId: string): Promise<void> {
    const log = logger.withTrace(traceId);
    try {
      await client.query('COMMIT');
      client.release();
      log.debug('Transaction committed');
    } catch (error) {
      await client.query('ROLLBACK');
      client.release();
      log.error('Transaction commit failed, rolled back', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw new DatabaseError(`Transaction commit failed: ${error}`);
    }
  }

  /**
   * Rollback database transaction
   */
  protected async rollbackTransaction(client: any, traceId: string): Promise<void> {
    const log = logger.withTrace(traceId);
    try {
      await client.query('ROLLBACK');
      client.release();
      log.debug('Transaction rolled back');
    } catch (error) {
      client.release();
      log.error('Transaction rollback failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw new DatabaseError(`Transaction rollback failed: ${error}`);
    }
  }
}
