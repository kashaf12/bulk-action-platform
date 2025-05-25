/**
 * Application configuration
 * Centralized configuration management with environment validation
 */

import { z } from 'zod';
import { logger } from '../utils/logger';

// Environment validation schema
const envSchema = z.object({
  // Application
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.enum(['error', 'warn', 'info', 'debug', 'verbose']).default('info'),

  // Database
  DB_HOST: z.string().default('localhost'),
  DB_PORT: z.coerce.number().int().min(1).max(65535).default(5432),
  DB_NAME: z.string().default('bulk_action_platform'),
  DB_USER: z.string().default('postgres'),
  DB_PASSWORD: z.string().default('password'),
  DB_POOL_MIN: z.coerce.number().int().min(0).default(2),
  DB_POOL_MAX: z.coerce.number().int().min(1).default(20),

  // Redis
  REDIS_HOST: z.string().default('localhost'),
  REDIS_PORT: z.coerce.number().int().min(1).max(65535).default(6379),
  REDIS_PASSWORD: z.string().optional(),
  REDIS_DATABASE: z.coerce.number().int().min(0).default(0),
  REDIS_CONNECT_TIMEOUT: z.coerce.number().int().min(0).default(2000),

  // Rate Limiting
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1000).default(60000), // 1 minute
  RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().min(1).default(10000),

  // Security
  CORS_ORIGIN: z.string().default('*'),
  TRUST_PROXY: z.coerce.boolean().default(false),

  // Monitoring
  LOKI_HOST: z.string().optional(),
  METRICS_ENABLED: z.coerce.boolean().default(true),

  // File Processing
  MAX_FILE_SIZE_MB: z.coerce.number().int().min(1).max(1000).default(10),
  MAX_CSV_ROWS: z.coerce.number().int().min(1).max(100000).default(10000),
  TEMP_DIR: z.string().default('./temp'),

  // Bulk Processing
  DEFAULT_BATCH_SIZE: z.coerce.number().int().min(10).max(10000).default(1000),
  MAX_CONCURRENT_JOBS: z.coerce.number().int().min(1).max(100).default(10),

  // Additional features
  ALLOWED_ORIGINS: z.string().optional().default('http://localhost:3000'),

  // Content Limits
  MAX_REQUEST_SIZE: z.string().default('10mb'),

  // Package details
  PACKAGE_VERSION: z.string().default('1.0.0'),
});

export type AppConfig = z.infer<typeof envSchema>;

class ConfigManager {
  private config: AppConfig;

  constructor() {
    this.config = this.loadAndValidateConfig();
  }

  /**
   * Load and validate environment configuration
   */
  private loadAndValidateConfig(): AppConfig {
    try {
      const result = envSchema.safeParse(process.env);

      if (!result.success) {
        const errors = result.error.errors.map(err => `${err.path.join('.')}: ${err.message}`);

        logger.error('Configuration validation failed', { errors });
        throw new Error(`Invalid configuration: ${errors.join(', ')}`);
      }

      logger.info('Configuration loaded successfully', {
        environment: result.data.NODE_ENV,
        port: result.data.PORT,
        logLevel: result.data.LOG_LEVEL,
      });

      return result.data;
    } catch (error) {
      logger.error('Failed to load configuration', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Get complete configuration
   */
  public getConfig(): AppConfig {
    return { ...this.config };
  }

  /**
   * Get application settings
   */
  public getAppConfig() {
    return {
      nodeEnv: this.config.NODE_ENV,
      port: this.config.PORT,
      logLevel: this.config.LOG_LEVEL,
      trustProxy: this.config.TRUST_PROXY,
      corsOrigin: this.config.CORS_ORIGIN,
    };
  }

  /**
   * Get database configuration
   */
  public getDatabaseConfig() {
    return {
      host: this.config.DB_HOST,
      port: this.config.DB_PORT,
      database: this.config.DB_NAME,
      user: this.config.DB_USER,
      password: this.config.DB_PASSWORD,
      min: this.config.DB_POOL_MIN,
      max: this.config.DB_POOL_MAX,
    };
  }

  /**
   * Get Redis configuration
   */
  public getRedisConfig() {
    return {
      host: this.config.REDIS_HOST,
      port: this.config.REDIS_PORT,
      password: this.config.REDIS_PASSWORD,
      database: this.config.REDIS_DATABASE,
      connectTimeout: this.config.REDIS_CONNECT_TIMEOUT,
    };
  }

  /**
   * Get rate limiting configuration
   */
  public getRateLimitConfig() {
    return {
      windowMs: this.config.RATE_LIMIT_WINDOW_MS,
      maxRequests: this.config.RATE_LIMIT_MAX_REQUESTS,
    };
  }

  /**
   * Get processing configuration
   */
  public getProcessingConfig() {
    return {
      maxFileSizeMB: this.config.MAX_FILE_SIZE_MB,
      maxCsvRows: this.config.MAX_CSV_ROWS,
      tempDir: this.config.TEMP_DIR,
      defaultBatchSize: this.config.DEFAULT_BATCH_SIZE,
      maxConcurrentJobs: this.config.MAX_CONCURRENT_JOBS,
    };
  }

  /**
   * Get monitoring configuration
   */
  public getMonitoringConfig() {
    return {
      lokiHost: this.config.LOKI_HOST,
      metricsEnabled: this.config.METRICS_ENABLED,
    };
  }

  /**
   * Get additional configuration
   */
  public getAdditionalFeatureConfig() {
    return {
      allowedOrigins: this.config.ALLOWED_ORIGINS,
    };
  }

  /**
   * Get content limit configuration
   */
  public getContentLimitConfig() {
    return {
      maxRequestSize: this.config.MAX_REQUEST_SIZE,
    };
  }

  /**
   * Get content limit configuration
   */
  public getPackageConfig() {
    return {
      npmPackageVersion: this.config.PACKAGE_VERSION,
    };
  }

  /**
   * Check if running in development mode
   */
  public isDevelopment(): boolean {
    return this.config.NODE_ENV === 'development';
  }

  /**
   * Check if running in production mode
   */
  public isProduction(): boolean {
    return this.config.NODE_ENV === 'production';
  }

  /**
   * Check if running in test mode
   */
  public isTest(): boolean {
    return this.config.NODE_ENV === 'test';
  }

  /**
   * Get environment name
   */
  public getEnvironment(): string {
    return this.config.NODE_ENV;
  }

  /**
   * Validate required environment variables for specific features
   */
  public validateFeatureRequirements(feature: string): void {
    switch (feature) {
      case 'loki':
        if (!this.config.LOKI_HOST) {
          throw new Error('LOKI_HOST is required for Loki logging');
        }
        break;
      case 'redis':
        if (!this.config.REDIS_HOST) {
          throw new Error('REDIS_HOST is required for Redis features');
        }
        break;
      default:
        logger.warn('Unknown feature validation requested', { feature });
    }
  }
}

// Export singleton instance
const configManager = new ConfigManager();
export default configManager;
export { ConfigManager };
