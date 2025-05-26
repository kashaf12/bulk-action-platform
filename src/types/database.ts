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
  idleTimeoutMillis: number;
  connectionTimeoutMillis: number;
  statement_timeout: number;
  query_timeout: number;
}

export interface QueryResult<T = unknown> {
  rows: T[];
  rowCount: number;
}

export interface EntityMetadata {
  entityType: string;
  tableName: string;
  requiredFields: string[];
  uniqueFields: string[];
  columnMappings: Record<string, string>;
}
