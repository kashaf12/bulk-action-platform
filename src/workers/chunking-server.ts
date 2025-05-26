// Load environment variables
import dotenv from 'dotenv';
dotenv.config();

import { BaseWorkerServer, BaseWorkerServerConfig } from './shared/BaseWorkerServer';
import { WorkerManager, WorkerManagerUtils, WorkerType } from './WorkerManager';
import chunkingQueue from '../queues/ChunkingQueue';
import { logger } from '../utils/logger';
import configManager from '../config/app';
import { v4 as uuidv4 } from 'uuid';
import os from 'os';

export interface ChunkingWorkerServerConfig extends BaseWorkerServerConfig {
  workerCount: number;
  maxMemoryPerWorker: number;
  totalMemoryLimit: number;
  autoRestart: boolean;
  maxRestartAttempts: number;
}

export class ChunkingWorkerServer extends BaseWorkerServer {
  private workerManager: WorkerManager | null = null;
  private chunkingWorkerConfig: ChunkingWorkerServerConfig;

  constructor(config?: Partial<ChunkingWorkerServerConfig>) {
    const defaultConfig = ChunkingWorkerServer.createDefaultConfig();
    const mergedConfig = { ...defaultConfig, ...config };

    super(mergedConfig);
    this.chunkingWorkerConfig = mergedConfig;
  }

  /**
   * Initialize chunking-specific components
   */
  protected async initializeWorkerComponents(): Promise<void> {
    try {
      logger.info('Initializing chunking worker components', {
        workerId: this.config.workerId,
        workerCount: this.chunkingWorkerConfig.workerCount,
      });

      // Initialize chunking queue
      await chunkingQueue.initialize();
      logger.info('Chunking queue initialized for worker processing');

      // Create worker manager configuration
      const workerManagerConfig = WorkerManagerUtils.createDefaultConfig();
      workerManagerConfig.chunkingWorkers = this.chunkingWorkerConfig.workerCount;
      workerManagerConfig.processingWorkers = 0; // Chunking server only handles chunking
      workerManagerConfig.maxMemoryPerWorker = this.chunkingWorkerConfig.maxMemoryPerWorker;
      workerManagerConfig.totalMemoryLimit = this.chunkingWorkerConfig.totalMemoryLimit;
      workerManagerConfig.autoScaling = false; // Keep it simple with fixed worker count
      workerManagerConfig.maxRestartAttempts = this.chunkingWorkerConfig.maxRestartAttempts;
      workerManagerConfig.healthCheckInterval = 30000; // 30 seconds

      logger.info('Creating worker manager', {
        config: {
          chunkingWorkers: workerManagerConfig.chunkingWorkers,
          maxMemoryPerWorker: workerManagerConfig.maxMemoryPerWorker,
          totalMemoryLimit: workerManagerConfig.totalMemoryLimit,
          autoScaling: workerManagerConfig.autoScaling,
        },
      });

      // Create worker manager
      this.workerManager = new WorkerManager(workerManagerConfig);

      // Setup worker manager event listeners
      this.setupWorkerManagerEventListeners();

      logger.info('Chunking worker components initialized successfully');
    } catch (error) {
      logger.error('Failed to initialize chunking worker components', {
        error: error instanceof Error ? error.message : String(error),
        workerId: this.config.workerId,
      });
      throw error;
    }
  }

  /**
   * Start chunking workers
   */
  protected async startWorkers(): Promise<void> {
    if (!this.workerManager) {
      throw new Error('Worker manager not initialized');
    }

    try {
      logger.info('Starting chunking workers', {
        workerId: this.config.workerId,
        workerCount: this.chunkingWorkerConfig.workerCount,
      });

      // Start the worker manager (this will spawn the workers)
      await this.workerManager.start();

      const metrics = this.workerManager.getMetrics();
      logger.info('Chunking workers started successfully', {
        workerId: this.config.workerId,
        totalWorkers: metrics.totalWorkers,
        healthyWorkers: metrics.healthyWorkers,
        chunkingWorkers: this.workerManager.getWorkersByType(WorkerType.CHUNKING).length,
      });
    } catch (error) {
      logger.error('Failed to start chunking workers', {
        error: error instanceof Error ? error.message : String(error),
        workerId: this.config.workerId,
      });
      throw error;
    }
  }

  /**
   * Stop chunking workers
   */
  protected async stopWorkers(): Promise<void> {
    if (!this.workerManager) {
      return;
    }

    try {
      logger.info('Stopping chunking workers', {
        workerId: this.config.workerId,
      });

      await this.workerManager.stop();

      logger.info('Chunking workers stopped successfully', {
        workerId: this.config.workerId,
      });
    } catch (error) {
      logger.error('Error stopping chunking workers', {
        error: error instanceof Error ? error.message : String(error),
        workerId: this.config.workerId,
      });
      throw error;
    }
  }

  /**
   * Cleanup chunking-specific components
   */
  protected async cleanupWorkerComponents(): Promise<void> {
    try {
      logger.info('Cleaning up chunking worker components', {
        workerId: this.config.workerId,
      });

      // Close chunking queue
      await chunkingQueue.close();
      logger.info('Chunking queue closed');

      // Reset worker manager reference
      this.workerManager = null;

      logger.info('Chunking worker components cleaned up successfully');
    } catch (error) {
      logger.error('Error cleaning up chunking worker components', {
        error: error instanceof Error ? error.message : String(error),
        workerId: this.config.workerId,
      });
      // Don't throw during cleanup
    }
  }

  /**
   * Setup event listeners for worker manager monitoring
   */
  private setupWorkerManagerEventListeners(): void {
    if (!this.workerManager) return;

    // Worker lifecycle events
    this.workerManager.on('started', () => {
      logger.info('Worker manager started', {
        serverType: this.config.serverType,
        workerId: this.config.workerId,
      });
      this.emit('workersStarted');
    });

    this.workerManager.on('stopped', () => {
      logger.info('Worker manager stopped', {
        serverType: this.config.serverType,
        workerId: this.config.workerId,
      });
      this.emit('workersStopped');
    });

    this.workerManager.on('workerStarted', ({ workerId, type }) => {
      logger.info('Chunking worker started', {
        workerId,
        type,
        serverWorkerId: this.config.workerId,
      });
      this.emit('workerStarted', { workerId, type });
    });

    this.workerManager.on('workerError', ({ workerId, error }) => {
      logger.error('Chunking worker error', {
        workerId,
        error: error instanceof Error ? error.message : String(error),
        serverWorkerId: this.config.workerId,
      });
      this.emit('workerError', { workerId, error });
    });

    this.workerManager.on('workerUnhealthy', ({ workerId, data }) => {
      logger.warn('Chunking worker became unhealthy', {
        workerId,
        data,
        serverWorkerId: this.config.workerId,
      });
      this.emit('workerUnhealthy', { workerId, data });
    });

    this.workerManager.on('workerRestarted', ({ workerId, type }) => {
      logger.info('Chunking worker restarted successfully', {
        workerId,
        type,
        serverWorkerId: this.config.workerId,
      });
      this.emit('workerRestarted', { workerId, type });
    });

    this.workerManager.on('workerRestartFailed', ({ workerId, error }) => {
      logger.error('Chunking worker restart failed', {
        workerId,
        error: error instanceof Error ? error.message : String(error),
        serverWorkerId: this.config.workerId,
      });
      this.emit('workerRestartFailed', { workerId, error });
    });

    // Health monitoring
    this.workerManager.on('healthCheck', ({ totalWorkers, healthyWorkers, unhealthyWorkers }) => {
      if (unhealthyWorkers > 0) {
        logger.warn('Chunking worker health check', {
          totalWorkers,
          healthyWorkers,
          unhealthyWorkers,
          serverWorkerId: this.config.workerId,
        });
      } else {
        logger.debug('Chunking worker health check passed', {
          totalWorkers,
          healthyWorkers,
          serverWorkerId: this.config.workerId,
        });
      }
      this.emit('healthCheck', { totalWorkers, healthyWorkers, unhealthyWorkers });
    });

    // Job processing events
    this.workerManager.on('jobProgress', ({ workerId, jobId, actionId, progress }) => {
      logger.debug('Chunking job progress update', {
        workerId,
        jobId,
        actionId,
        stage: progress.stage,
        percentage: progress.overallProgress,
        serverWorkerId: this.config.workerId,
      });
      this.emit('jobProgress', { workerId, jobId, actionId, progress });
    });

    // Error handling
    this.workerManager.on('error', error => {
      logger.error('Chunking worker manager error', {
        error: error instanceof Error ? error.message : String(error),
        serverWorkerId: this.config.workerId,
      });
      this.emit('error', error);
    });
  }

  /**
   * Get worker server metrics
   */
  public getMetrics() {
    const baseHealth = this.getHealthStatus();
    const workerMetrics = this.workerManager?.getMetrics();

    return {
      serverType: this.config.serverType,
      workerId: this.config.workerId,
      uptime: this.getUptime(),
      health: baseHealth,
      workers: workerMetrics || null,
      configuration: {
        workerCount: this.chunkingWorkerConfig.workerCount,
        maxMemoryPerWorker: this.chunkingWorkerConfig.maxMemoryPerWorker,
        totalMemoryLimit: this.chunkingWorkerConfig.totalMemoryLimit,
        autoRestart: this.chunkingWorkerConfig.autoRestart,
      },
    };
  }

  /**
   * Create default configuration for chunking worker server
   */
  public static createDefaultConfig(): ChunkingWorkerServerConfig {
    const hostname = os.hostname();
    const workerId = `chunking-server-${hostname}-${process.pid}-${uuidv4().substring(0, 8)}`;
    const workerConfig = configManager.getWorkerConfig();

    return {
      serverType: 'chunking',
      workerId,
      healthCheckPort: parseInt(process.env.HEALTH_CHECK_PORT || '0') || undefined,
      gracefulShutdownTimeout: 30000, // 30 seconds
      dependencies: ['database', 'redis', 'minio'], // Chunking workers need all dependencies

      // Chunking-specific config
      workerCount:
        parseInt(process.env.CHUNKING_WORKER_COUNT || '') || workerConfig.chunkingWorkers || 3,
      maxMemoryPerWorker: parseInt(process.env.MAX_MEMORY_PER_WORKER || '256'),
      totalMemoryLimit: parseInt(process.env.TOTAL_MEMORY_LIMIT || '1024'),
      autoRestart: process.env.AUTO_RESTART_WORKERS?.toLowerCase() === 'true',
      maxRestartAttempts: parseInt(process.env.MAX_RESTART_ATTEMPTS || '3'),
    };
  }
}

/**
 * Start the chunking worker server
 */
async function startChunkingWorkerServer(): Promise<void> {
  try {
    logger.info('Initializing chunking worker server', {
      environment: configManager.getAppConfig().nodeEnv,
      nodeVersion: process.version,
      processId: process.pid,
    });

    // Create and start chunking worker server
    const chunkingServer = new ChunkingWorkerServer();

    // Setup server event listeners
    chunkingServer.on('started', () => {
      logger.info('Chunking worker server started successfully');
    });

    chunkingServer.on('stopped', () => {
      logger.info('Chunking worker server stopped successfully');
      process.exit(0);
    });

    chunkingServer.on('error', error => {
      logger.error('Chunking worker server error', {
        error: error instanceof Error ? error.message : String(error),
      });
      process.exit(1);
    });

    // Start the server
    await chunkingServer.start();

    // Log final status
    const metrics = chunkingServer.getMetrics();
    logger.info('Chunking worker server operational', {
      workerId: metrics.workerId,
      workerCount: metrics.configuration.workerCount,
      healthyWorkers: metrics.workers?.healthyWorkers || 0,
      totalWorkers: metrics.workers?.totalWorkers || 0,
      memoryLimit: `${metrics.configuration.totalMemoryLimit}MB`,
    });
  } catch (error) {
    logger.error('Failed to start chunking worker server', {
      error: error instanceof Error ? error.message : String(error),
    });
    process.exit(1);
  }
}

// Start the chunking worker server if this file is run directly
if (require.main === module) {
  startChunkingWorkerServer();
}

export default ChunkingWorkerServer;
