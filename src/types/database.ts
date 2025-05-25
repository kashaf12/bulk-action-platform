/**
 * Database-related type definitions
 */

export interface DatabaseConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  min: number;
  max: number;
}

export interface QueryResult<T = unknown> {
  rows: T[];
  rowCount: number;
}

export interface EntityMetadata {
  entityType: string;
  tableName: string;
  requiredFields: string[];
  optionalFields: string[];
  uniqueFields: string[];
  fieldValidators: Record<string, (value: unknown) => boolean>;
  columnMappings: Record<string, string>;
}
