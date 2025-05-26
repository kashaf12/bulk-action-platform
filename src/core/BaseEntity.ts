/**
 * Base entity abstraction for all CRM entities
 * Provides common interface and validation patterns
 * Follows Single Responsibility and Open/Closed principles
 */

import { z } from 'zod';
import { IEntity, ValidationResult } from '@/types';

export abstract class BaseEntity implements IEntity {
  public id: string;
  public createdAt?: Date;
  public updatedAt?: Date;

  constructor(data: IEntity) {
    this.id = data.id;
    this.createdAt = data.createdAt;
    this.updatedAt = data.updatedAt;
  }

  /**
   * Get entity type - to be implemented by concrete classes
   */
  public static getEntityType(): string {
    throw new Error('getEntityType must be implemented by concrete entity classes');
  }

  /**
   * Get Zod schema for validation - to be implemented by concrete classes
   */
  public static getSchema(): z.ZodSchema {
    throw new Error('getSchema must be implemented by concrete entity classes');
  }

  /**
   * Get required fields for this entity type
   */
  public static getRequiredFields(): string[] {
    return ['id'];
  }

  /**
   * Get unique constraint fields (for deduplication)
   */
  public static getUniqueFields(): string[] {
    return ['id'];
  }

  /**
   * Get database table name
   */
  public static getTableName(): string {
    throw new Error('getTableName must be implemented by concrete entity classes');
  }

  /**
   * Get database column mappings
   */
  public static getColumnMappings(): Record<string, string> {
    return {
      id: 'id',
      createdAt: 'created_at',
      updatedAt: 'updated_at',
    };
  }

  /**
   * Validate entity data using Zod schema
   */
  public static validate(data: unknown): ValidationResult {
    try {
      const schema = this.getSchema();
      schema.parse(data);
      return {
        isValid: true,
        errors: [],
      };
    } catch (error) {
      if (error instanceof z.ZodError) {
        return {
          isValid: false,
          errors: error.errors.map(err => `${err.path.join('.')}: ${err.message}`),
        };
      }
      return {
        isValid: false,
        errors: ['Unknown validation error'],
      };
    }
  }

  /**
   * Safe parse with detailed error information
   */
  public static safeParse(data: unknown): {
    success: boolean;
    data?: unknown;
    errors?: string[];
  } {
    try {
      const schema = this.getSchema();
      const result = schema.safeParse(data);

      if (result.success) {
        return {
          success: true,
          data: result.data,
        };
      } else {
        return {
          success: false,
          errors: result.error.errors.map(err => `${err.path.join('.')}: ${err.message}`),
        };
      }
    } catch (error) {
      return {
        success: false,
        errors: ['Schema validation failed'],
      };
    }
  }

  /**
   * Convert entity to plain object for database operations
   */
  public toObject(): Record<string, unknown> {
    return {
      id: this.id,
      created_at: this.createdAt,
      updated_at: this.updatedAt,
    };
  }

  /**
   * Convert entity to database columns using column mappings
   */
  public toDbObject(): Record<string, unknown> {
    const obj = this.toObject();
    const mappings = (this.constructor as typeof BaseEntity).getColumnMappings();
    const dbObj: Record<string, unknown> = {};

    for (const [entityField, dbColumn] of Object.entries(mappings)) {
      if (obj.hasOwnProperty(entityField)) {
        dbObj[dbColumn] = obj[entityField];
      }
    }

    return dbObj;
  }

  /**
   * Protected helper method for mapping database rows to entity data
   * To be used by concrete classes in their fromDbRow implementations
   */
  protected static mapDbRowToEntityData(
    row: Record<string, unknown>,
    columnMappings: Record<string, string>
  ): Record<string, unknown> {
    const entityData: Record<string, unknown> = {};

    // Reverse mapping from database columns to entity fields
    for (const [entityField, dbColumn] of Object.entries(columnMappings)) {
      if (Object.prototype.hasOwnProperty.call(row, dbColumn)) {
        let value = row[dbColumn];

        // Handle special cases for common database types
        if (value !== null && value !== undefined) {
          // Parse JSON strings back to objects (for configuration fields, etc.)
          if (typeof value === 'string' && entityField === 'configuration') {
            try {
              value = JSON.parse(value);
            } catch {
              // If parsing fails, keep as string
            }
          }

          // Convert database timestamps to Date objects
          if (
            (entityField === 'createdAt' ||
              entityField === 'updatedAt' ||
              entityField === 'scheduledAt' ||
              entityField === 'startedAt' ||
              entityField === 'completedAt') &&
            (value instanceof Date || typeof value === 'string')
          ) {
            value = new Date(value);
          }
        }

        entityData[entityField] = value;
      }
    }

    return entityData;
  }
}
