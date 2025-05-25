/**
 * Database configuration and connection management
 * Implements connection pooling and error handling with TypeScript support
 */

import { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import { DatabaseConfig } from '../types/database';
import { logger } from '../utils/logger';
import { DatabaseError } from '../utils/error';

import configManager from '../config/app';

class Database {
  private pool: Pool | null = null;
  private isConnected = false;
  private config: DatabaseConfig;

  constructor() {
    this.config = this.loadConfig();
  }

  /**
   * Load database configuration from environment variables
   */
  private loadConfig(): DatabaseConfig {
    const envConfig = configManager.getDatabaseConfig();

    return {
      host: envConfig.host || 'localhost',
      port: envConfig.port || 5432,
      database: envConfig.database || 'bulk_action_platform',
      user: envConfig.user || 'postgres',
      password: envConfig.password || 'password',
      min: envConfig.min || 2,
      max: envConfig.max || 20,
    };
  }

  /**
   * Initialize database connection pool
   */
  public async connect(): Promise<void> {
    try {
      this.pool = new Pool({
        ...this.config,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 2000,
        statement_timeout: 30000,
        query_timeout: 30000,
      });

      // Handle pool errors
      this.pool.on('error', (err: Error) => {
        logger.error('Unexpected database pool error', { error: err.message });
      });

      // Test connection
      const client = await this.pool.connect();
      const result = await client.query('SELECT NOW() as connected_at, version()');
      client.release();

      this.isConnected = true;
      logger.info('Database connected successfully', {
        host: this.config.host,
        database: this.config.database,
        connectedAt: result.rows[0].connected_at,
        version: result.rows[0].version.split(' ')[0], // Just get PostgreSQL version
      });
    } catch (error) {
      this.isConnected = false;
      logger.error('Database connection failed', {
        error: error instanceof Error ? error.message : String(error),
        config: {
          host: this.config.host,
          port: this.config.port,
          database: this.config.database,
          user: this.config.user,
        },
      });
      throw new DatabaseError(`Database connection failed: ${error}`);
    }
  }

  /**
   * Execute a query with error handling and logging
   */
  public async query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    params: unknown[] = [],
    traceId?: string
  ): Promise<QueryResult<T>> {
    if (!this.pool || !this.isConnected) {
      throw new DatabaseError('Database not connected');
    }

    const start = Date.now();
    const log = traceId ? logger.withTrace(traceId) : logger;

    try {
      const result = await this.pool.query<T>(text, params);
      const duration = Date.now() - start;

      log.debug('Database query executed successfully', {
        duration,
        rowCount: result.rowCount,
        query: this.sanitizeQuery(text),
        paramCount: params.length,
      });

      return result;
    } catch (error) {
      const duration = Date.now() - start;

      log.error('Database query failed', {
        duration,
        error: error instanceof Error ? error.message : String(error),
        query: this.sanitizeQuery(text),
        paramCount: params.length,
      });

      throw new DatabaseError(`Query execution failed: ${error}`);
    }
  }

  /**
   * Get a client from the pool for transactions
   */
  public async getClient(): Promise<PoolClient> {
    if (!this.pool || !this.isConnected) {
      throw new DatabaseError('Database not connected');
    }

    try {
      return await this.pool.connect();
    } catch (error) {
      logger.error('Failed to get database client', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw new DatabaseError(`Failed to get database client: ${error}`);
    }
  }

  /**
   * Execute a transaction with automatic rollback on error
   */
  public async transaction<T>(
    callback: (client: PoolClient) => Promise<T>,
    traceId?: string
  ): Promise<T> {
    const log = traceId ? logger.withTrace(traceId) : logger;
    const client = await this.getClient();

    try {
      await client.query('BEGIN');
      log.debug('Transaction started');

      const result = await callback(client);

      await client.query('COMMIT');
      log.debug('Transaction committed successfully');

      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      log.error('Transaction rolled back due to error', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Check database health
   */
  public async healthCheck(): Promise<{
    connected: boolean;
    latency?: number;
    activeConnections?: number;
    error?: string;
  }> {
    if (!this.pool || !this.isConnected) {
      return {
        connected: false,
        error: 'Database not connected',
      };
    }

    const start = Date.now();

    try {
      const result = await this.pool.query(`
        SELECT 
          NOW() as current_time,
          (SELECT count(*) FROM pg_stat_activity WHERE datname = current_database()) as active_connections
      `);

      const latency = Date.now() - start;

      return {
        connected: true,
        latency,
        activeConnections: parseInt(result.rows[0].active_connections),
      };
    } catch (error) {
      return {
        connected: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Close database connection pool
   */
  public async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
      this.isConnected = false;
      logger.info('Database connection closed');
    }
  }

  /**
   * Check if database is connected and healthy
   */
  public isHealthy(): boolean {
    return this.isConnected && this.pool !== null;
  }

  /**
   * Get current pool statistics
   */
  public getPoolStats(): {
    totalCount: number;
    idleCount: number;
    waitingCount: number;
  } | null {
    if (!this.pool) return null;

    return {
      totalCount: this.pool.totalCount,
      idleCount: this.pool.idleCount,
      waitingCount: this.pool.waitingCount,
    };
  }

  /**
   * Sanitize query for logging (remove sensitive data)
   */
  private sanitizeQuery(query: string): string {
    // Remove potential sensitive data and limit length
    return (
      query
        .replace(/password\s*=\s*'[^']*'/gi, "password='***'")
        .replace(/token\s*=\s*'[^']*'/gi, "token='***'")
        .substring(0, 200) + (query.length > 200 ? '...' : '')
    );
  }
}

// Export singleton instance
const database = new Database();
export default database;
