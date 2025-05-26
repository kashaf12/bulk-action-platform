/**
 * BullMQ Queue Configuration
 * Centralized configuration for all job queues with Redis connection
 */

import { ConnectionOptions, DefaultJobOptions, RedisConnection, RedisOptions } from 'bullmq';
import configManager from '../../config/app';
import { logger } from '../../utils/logger';
import { QueueConfig } from '../types/queue';

class QueueConfigManager {
  private config: QueueConfig;

  constructor() {
    this.config = this.loadConfig();
  }

  private loadConfig(): QueueConfig {
    const redisConfig = configManager.getRedisConfig();
    const workerConfig = configManager.getWorkerConfig();

    return {
      // Redis connection for BullMQ
      connection: {
        host: redisConfig.host,
        port: redisConfig.port,
        password: redisConfig.password,
        db: redisConfig.database,
        connectTimeout: redisConfig.connectTimeout,
        maxRetriesPerRequest: redisConfig.maxRetriesPerRequest,
        retryDelayOnFailover: redisConfig.retryDelayOnFailover,
        lazyConnect: redisConfig.lazyConnect,
        // Connection pool settings for workers
        family: redisConfig.family,
        keepAlive: redisConfig.keepAlive,
      },

      // Default job options for all queues
      defaultJobOptions: {
        removeOnComplete: 100, // Keep last 100 completed jobs
        removeOnFail: 50, // Keep last 50 failed jobs
        attempts: 3, // Retry failed jobs 3 times
        backoff: {
          type: 'exponential',
          delay: 2000, // Start with 2s delay
        },
        // Job TTL - remove jobs after 24 hours
        delay: 0, // No delay by default
        priority: 0, // Normal priority
      },

      // Chunking queue specific configuration
      chunkingQueue: {
        name: 'bulk-action-chunking',
        options: {
          attempts: 3,
          backoff: {
            type: 'exponential',
            delay: 3000, // Longer delay for chunking failures
          },
          removeOnComplete: 50,
          removeOnFail: 25,
          // Higher priority for chunking jobs
          priority: 10,
        },
      },

      // Processing queue specific configuration
      processingQueue: {
        name: 'bulk-action-processing',
        options: {
          attempts: 5, // More retries for database operations
          backoff: {
            type: 'exponential',
            delay: 1000, // Shorter delay for processing retries
          },
          removeOnComplete: 200, // Keep more processing job history
          removeOnFail: 100,
          priority: 5, // Lower priority than chunking
        },
      },
    };
  }

  /**
   * Get complete queue configuration
   */
  public getConfig(): QueueConfig {
    return { ...this.config };
  }

  /**
   * Get Redis connection options
   */
  public getConnectionOptions(): ConnectionOptions {
    return { ...this.config.connection } as ConnectionOptions;
  }

  /**
   * Get chunking queue configuration
   */
  public getChunkingQueueConfig() {
    return {
      name: this.config.chunkingQueue.name,
      connection: this.getConnectionOptions(),
      defaultJobOptions: {
        ...this.config.defaultJobOptions,
        ...this.config.chunkingQueue.options,
      },
    };
  }

  /**
   * Get processing queue configuration
   */
  public getProcessingQueueConfig() {
    return {
      name: this.config.processingQueue.name,
      connection: this.getConnectionOptions(),
      defaultJobOptions: {
        ...this.config.defaultJobOptions,
        ...this.config.processingQueue.options,
      },
    };
  }

  /**
   * Get worker configuration
   */
  public getWorkerConfig() {
    const workerConfig = configManager.getWorkerConfig();

    return {
      connection: this.getConnectionOptions(),
      concurrency: {
        chunking: Math.min(workerConfig.chunkingWorkers, 10), // Max 10 concurrent
        processing: Math.min(workerConfig.ingestionWorkers, 20), // Max 20 concurrent
      },
      // Worker-specific settings
      maxStalledCount: 3, // Max times a job can be stalled
      stalledInterval: 30000, // Check for stalled jobs every 30s
      maxmemoryPolicy: 'allkeys-lru', // Redis memory policy
    };
  }

  /**
   * Validate Redis connection
   */
  public async validateConnection(): Promise<boolean> {
    try {
      const { createClient } = await import('redis');
      const client = createClient({
        socket: {
          host: (this.config.connection as RedisOptions).host,
          port: (this.config.connection as RedisOptions).port,
          connectTimeout: (this.config.connection as RedisOptions).connectTimeout,
        },
        password: (this.config.connection as RedisOptions).password,
        database: (this.config.connection as RedisOptions).db,
      });

      await client.connect();
      await client.ping();
      await client.disconnect();

      logger.info('BullMQ Redis connection validated successfully', {
        host: (this.config.connection as RedisOptions).host,
        port: (this.config.connection as RedisOptions).port,
        database: (this.config.connection as RedisOptions).db,
      });

      return true;
    } catch (error) {
      logger.error('BullMQ Redis connection validation failed', {
        error: error instanceof Error ? error.message : String(error),
        host: (this.config.connection as RedisOptions).host,
        port: (this.config.connection as RedisOptions).port,
      });
      return false;
    }
  }

  /**
   * Get queue health check configuration
   */
  public getHealthCheckConfig() {
    return {
      checkInterval: 30000, // Check queue health every 30s
      maxJobAge: 3600000, // Alert if job is older than 1 hour
      maxQueueSize: 10000, // Alert if queue has more than 10k jobs
      criticalQueueSize: 50000, // Critical alert at 50k jobs
    };
  }
}

// Export singleton instance
const queueConfigManager = new QueueConfigManager();
export default queueConfigManager;
export { QueueConfigManager };
