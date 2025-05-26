import { EventEmitter } from 'events';
import { logger } from '../../utils/logger';
import configManager from '../../config/app';
import database from '../../config/database';
import redis from '../../config/redis';
import minioManager from '../../config/minio';

export interface BaseWorkerServerConfig {
  serverType: string;
  workerId: string;
  healthCheckPort?: number;
  gracefulShutdownTimeout: number;
  dependencies: string[];
}

export abstract class BaseWorkerServer extends EventEmitter {
  protected config: BaseWorkerServerConfig;
  protected isShuttingDown = false;
  protected startTime: Date;

  constructor(config: BaseWorkerServerConfig) {
    super();
    this.config = config;
    this.startTime = new Date();
  }

  /**
   * Start the worker server
   */
  public async start(): Promise<void> {
    try {
      logger.info(`Starting ${this.config.serverType} worker server`, {
        workerId: this.config.workerId,
        serverType: this.config.serverType,
        environment: configManager.getAppConfig().nodeEnv,
        nodeVersion: process.version,
        processId: process.pid,
      });

      // Initialize shared dependencies
      await this.initializeDependencies();

      // Initialize worker-specific components
      await this.initializeWorkerComponents();

      // Start workers
      await this.startWorkers();

      // Setup health monitoring
      this.setupHealthMonitoring();

      // Setup graceful shutdown
      this.setupGracefulShutdown();

      logger.info(`${this.config.serverType} worker server started successfully`, {
        workerId: this.config.workerId,
        serverType: this.config.serverType,
        uptime: this.getUptime(),
      });

      this.emit('started');
    } catch (error) {
      logger.error(`Failed to start ${this.config.serverType} worker server`, {
        error: error instanceof Error ? error.message : String(error),
        workerId: this.config.workerId,
        serverType: this.config.serverType,
      });

      this.emit('error', error);
      throw error;
    }
  }

  /**
   * Stop the worker server
   */
  public async stop(): Promise<void> {
    this.isShuttingDown = true;

    logger.info(`Stopping ${this.config.serverType} worker server`, {
      workerId: this.config.workerId,
      serverType: this.config.serverType,
    });

    try {
      // Stop workers first
      await this.stopWorkers();

      // Cleanup worker-specific components
      await this.cleanupWorkerComponents();

      // Close shared dependencies
      await this.closeDependencies();

      logger.info(`${this.config.serverType} worker server stopped successfully`, {
        workerId: this.config.workerId,
        serverType: this.config.serverType,
        uptime: this.getUptime(),
      });

      this.emit('stopped');
    } catch (error) {
      logger.error(`Error stopping ${this.config.serverType} worker server`, {
        error: error instanceof Error ? error.message : String(error),
        workerId: this.config.workerId,
        serverType: this.config.serverType,
      });

      this.emit('error', error);
      throw error;
    }
  }

  /**
   * Initialize shared dependencies (database, redis, minio)
   */
  private async initializeDependencies(): Promise<void> {
    const dependencies = this.config.dependencies;

    // Initialize database if required
    if (dependencies.includes('database')) {
      try {
        await database.connect();
        logger.info('Database connection established');
      } catch (error) {
        logger.error('Database connection failed', {
          error: error instanceof Error ? error.message : 'Unknown error',
        });
        throw error;
      }
    }

    // Initialize Redis if required
    if (dependencies.includes('redis')) {
      try {
        await redis.connect();
        logger.info('Redis connection established');
      } catch (error) {
        logger.error('Redis connection failed', {
          error: error instanceof Error ? error.message : 'Unknown error',
        });
        throw error;
      }
    }

    // Initialize MinIO if required
    if (dependencies.includes('minio')) {
      try {
        await minioManager.connect();
        logger.info('MinIO connection established');
      } catch (error) {
        logger.error('MinIO connection failed', {
          error: error instanceof Error ? error.message : 'Unknown error',
        });
        throw error;
      }
    }
  }

  /**
   * Close shared dependencies
   */
  private async closeDependencies(): Promise<void> {
    const dependencies = this.config.dependencies;

    // Close database connections
    if (dependencies.includes('database')) {
      try {
        await database.close();
        logger.info('Database connections closed');
      } catch (error) {
        logger.warn('Error closing database connections', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Close Redis connections
    if (dependencies.includes('redis')) {
      try {
        await redis.close();
        logger.info('Redis connections closed');
      } catch (error) {
        logger.warn('Error closing Redis connections', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Close MinIO connections
    if (dependencies.includes('minio')) {
      try {
        await minioManager.close();
        logger.info('MinIO connections closed');
      } catch (error) {
        logger.warn('Error closing MinIO connections', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  /**
   * Setup graceful shutdown handlers
   */
  private setupGracefulShutdown(): void {
    const gracefulShutdown = (signal: string) => {
      logger.info(`Received ${signal}, starting graceful shutdown`, {
        workerId: this.config.workerId,
        serverType: this.config.serverType,
      });

      this.stop().catch(error => {
        logger.error(`Error during graceful shutdown`, {
          error: error instanceof Error ? error.message : String(error),
          workerId: this.config.workerId,
          serverType: this.config.serverType,
        });
        process.exit(1);
      });
    };

    // Handle shutdown signals
    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
    process.on('SIGINT', () => gracefulShutdown('SIGINT'));

    // Handle uncaught exceptions
    process.on('uncaughtException', error => {
      logger.error(`Uncaught exception in ${this.config.serverType} worker`, {
        error: error.message,
        stack: error.stack,
        workerId: this.config.workerId,
        serverType: this.config.serverType,
      });

      this.stop().catch(() => {
        // Ignore cleanup errors in emergency exit
      });

      process.exit(1);
    });

    // Handle unhandled promise rejections
    process.on('unhandledRejection', (reason, promise) => {
      logger.error(`Unhandled promise rejection in ${this.config.serverType} worker`, {
        reason,
        promise,
        workerId: this.config.workerId,
        serverType: this.config.serverType,
      });

      this.stop().catch(() => {
        // Ignore cleanup errors in emergency exit
      });

      process.exit(1);
    });

    // Force shutdown timeout
    setTimeout(() => {
      if (this.isShuttingDown) {
        logger.error(`Forced shutdown due to timeout`, {
          workerId: this.config.workerId,
          serverType: this.config.serverType,
        });
        process.exit(1);
      }
    }, this.config.gracefulShutdownTimeout);
  }

  /**
   * Setup health monitoring
   */
  private setupHealthMonitoring(): void {
    // Health check endpoint via HTTP if port is specified
    if (this.config.healthCheckPort) {
      // TODO: Implement simple HTTP health endpoint
      logger.debug('Health check endpoint not implemented yet', {
        port: this.config.healthCheckPort,
      });
    }

    // Periodic health logging
    setInterval(() => {
      const health = this.getHealthStatus();
      if (health.healthy) {
        logger.debug(`${this.config.serverType} worker health check passed`, {
          workerId: this.config.workerId,
          uptime: this.getUptime(),
          memoryUsage: this.getMemoryUsage(),
        });
      } else {
        logger.warn(`${this.config.serverType} worker health check failed`, {
          workerId: this.config.workerId,
          health,
        });
      }
    }, 60000); // Every minute
  }

  /**
   * Get server uptime in milliseconds
   */
  protected getUptime(): number {
    return Date.now() - this.startTime.getTime();
  }

  /**
   * Get memory usage
   */
  protected getMemoryUsage(): NodeJS.MemoryUsage {
    return process.memoryUsage();
  }

  /**
   * Get health status
   */
  protected getHealthStatus(): { healthy: boolean; details?: any } {
    const memoryUsage = this.getMemoryUsage();
    const memoryLimitMB = 512; // Default memory limit
    const isMemoryHealthy = memoryUsage.heapUsed < memoryLimitMB * 1024 * 1024;

    return {
      healthy: isMemoryHealthy && !this.isShuttingDown,
      details: {
        memoryUsage: Math.round(memoryUsage.heapUsed / 1024 / 1024),
        memoryLimit: memoryLimitMB,
        uptime: this.getUptime(),
        isShuttingDown: this.isShuttingDown,
      },
    };
  }

  // Abstract methods to be implemented by specific worker servers
  protected abstract initializeWorkerComponents(): Promise<void>;
  protected abstract startWorkers(): Promise<void>;
  protected abstract stopWorkers(): Promise<void>;
  protected abstract cleanupWorkerComponents(): Promise<void>;
}
