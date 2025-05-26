/**
 * Worker Manager
 * Manages multiple chunking and processing workers with lifecycle management, health monitoring, and scaling
 */

import { EventEmitter } from 'events';
import {
  ChunkingWorker,
  ChunkingWorkerConfig,
  ChunkingWorkerUtils,
  WorkerStatus,
} from './chunking/ChunkingWorker';
import { logger } from '../utils/logger';
import configManager from '../config/app';
import { v4 as uuidv4 } from 'uuid';
import os from 'os';

export interface WorkerManagerConfig {
  // Worker configuration
  chunkingWorkers: number; // Number of chunking workers to spawn
  processingWorkers: number; // Number of processing workers to spawn (future)

  // Resource management
  maxMemoryPerWorker: number; // Maximum memory per worker in MB
  totalMemoryLimit: number; // Total memory limit for all workers in MB

  // Scaling configuration
  autoScaling: boolean; // Enable automatic scaling
  minWorkers: number; // Minimum number of workers
  maxWorkers: number; // Maximum number of workers
  scaleUpThreshold: number; // Queue size threshold to scale up
  scaleDownThreshold: number; // Queue size threshold to scale down

  // Health monitoring
  healthCheckInterval: number; // Health check interval in milliseconds
  unhealthyWorkerTimeout: number; // Time before restarting unhealthy worker
  maxRestartAttempts: number; // Maximum restart attempts per worker

  // Shutdown configuration
  gracefulShutdownTimeout: number; // Time to wait for graceful shutdown
  forceShutdownDelay: number; // Delay before force shutdown
}

export interface WorkerInfo {
  id: string;
  type: WorkerType;
  status: WorkerStatus;
  pid?: number;
  startTime: string;
  lastHealthCheck?: string;
  restartCount: number;
  maxRestartAttempts: number;
  worker: ChunkingWorker; // Will be union type when ProcessingWorker is added
  metrics: any;
  memoryUsage: number;
  isHealthy: boolean;
}

export enum WorkerType {
  CHUNKING = 'chunking',
  PROCESSING = 'processing', // For future implementation
}

export interface WorkerManagerMetrics {
  totalWorkers: number;
  healthyWorkers: number;
  unhealthyWorkers: number;
  processingJobs: number;

  // Resource usage
  totalMemoryUsage: number;
  averageMemoryUsage: number;
  cpuUsage: number;

  // Performance metrics
  totalJobsProcessed: number;
  totalJobsSuccessful: number;
  totalJobsFailed: number;
  averageProcessingTime: number;
  throughput: number; // jobs per minute

  // By worker type
  byType: Record<
    WorkerType,
    {
      count: number;
      healthy: number;
      processing: number;
      avgMemory: number;
    }
  >;

  lastUpdated: string;
}

export enum WorkerManagerStatus {
  STOPPED = 'stopped',
  STARTING = 'starting',
  RUNNING = 'running',
  SCALING = 'scaling',
  SHUTTING_DOWN = 'shutting_down',
  ERROR = 'error',
}

export class WorkerManager extends EventEmitter {
  private config: WorkerManagerConfig;
  private workers: Map<string, WorkerInfo>;
  private status: WorkerManagerStatus;
  private healthCheckTimer: NodeJS.Timeout | null = null;
  private scalingTimer: NodeJS.Timeout | null = null;
  private startTime: Date;
  private isShuttingDown = false;

  constructor(config?: Partial<WorkerManagerConfig>) {
    super();

    this.config = this.createConfig(config);
    this.workers = new Map();
    this.status = WorkerManagerStatus.STOPPED;
    this.startTime = new Date();

    this.validateConfig();
    this.setupProcessHandlers();
  }

  /**
   * Start the worker manager and spawn initial workers
   */
  public async start(): Promise<void> {
    if (this.status !== WorkerManagerStatus.STOPPED) {
      throw new Error(`Cannot start worker manager from status: ${this.status}`);
    }

    this.status = WorkerManagerStatus.STARTING;

    logger.info('Starting worker manager', {
      config: {
        chunkingWorkers: this.config.chunkingWorkers,
        processingWorkers: this.config.processingWorkers,
        autoScaling: this.config.autoScaling,
        totalMemoryLimit: this.config.totalMemoryLimit,
      },
    });

    try {
      // Start chunking workers
      await this.spawnWorkers(WorkerType.CHUNKING, this.config.chunkingWorkers);

      // Start processing workers (placeholder for future implementation)
      // await this.spawnWorkers(WorkerType.PROCESSING, this.config.processingWorkers);

      // Start monitoring
      this.startHealthMonitoring();

      if (this.config.autoScaling) {
        this.startAutoScaling();
      }

      this.status = WorkerManagerStatus.RUNNING;

      logger.info('Worker manager started successfully', {
        totalWorkers: this.workers.size,
        chunkingWorkers: this.getWorkersByType(WorkerType.CHUNKING).length,
        status: this.status,
      });

      this.emit('started');
    } catch (error) {
      this.status = WorkerManagerStatus.ERROR;

      logger.error('Failed to start worker manager', {
        error: error instanceof Error ? error.message : String(error),
      });

      // Cleanup any partially started workers
      await this.stopAllWorkers();

      this.emit('error', error);
      throw error;
    }
  }

  /**
   * Stop all workers and shutdown gracefully
   */
  public async stop(): Promise<void> {
    if (this.isShuttingDown) {
      logger.warn('Worker manager is already shutting down');
      return;
    }

    this.isShuttingDown = true;
    this.status = WorkerManagerStatus.SHUTTING_DOWN;

    logger.info('Stopping worker manager', {
      totalWorkers: this.workers.size,
      gracefulTimeout: this.config.gracefulShutdownTimeout,
    });

    try {
      // Stop monitoring
      this.stopHealthMonitoring();
      this.stopAutoScaling();

      // Stop all workers gracefully
      await this.stopAllWorkers();

      this.status = WorkerManagerStatus.STOPPED;

      logger.info('Worker manager stopped successfully', {
        uptime: Date.now() - this.startTime.getTime(),
      });

      this.emit('stopped');
    } catch (error) {
      this.status = WorkerManagerStatus.ERROR;

      logger.error('Error during worker manager shutdown', {
        error: error instanceof Error ? error.message : String(error),
      });

      this.emit('error', error);
      throw error;
    }
  }

  /**
   * Scale workers up or down
   */
  public async scaleWorkers(type: WorkerType, targetCount: number): Promise<void> {
    if (this.status !== WorkerManagerStatus.RUNNING) {
      throw new Error(`Cannot scale workers from status: ${this.status}`);
    }

    const currentWorkers = this.getWorkersByType(type);
    const currentCount = currentWorkers.length;

    if (targetCount === currentCount) {
      logger.debug('No scaling needed', { type, currentCount, targetCount });
      return;
    }

    this.status = WorkerManagerStatus.SCALING;

    logger.info('Scaling workers', {
      type,
      currentCount,
      targetCount,
      direction: targetCount > currentCount ? 'up' : 'down',
    });

    try {
      if (targetCount > currentCount) {
        // Scale up
        const workersToAdd = targetCount - currentCount;
        await this.spawnWorkers(type, workersToAdd);
      } else {
        // Scale down
        const workersToRemove = currentCount - targetCount;
        await this.removeWorkers(type, workersToRemove);
      }

      this.status = WorkerManagerStatus.RUNNING;

      logger.info('Worker scaling completed', {
        type,
        newCount: this.getWorkersByType(type).length,
        targetCount,
      });

      this.emit('scaled', { type, oldCount: currentCount, newCount: targetCount });
    } catch (error) {
      this.status = WorkerManagerStatus.ERROR;

      logger.error('Worker scaling failed', {
        error: error instanceof Error ? error.message : String(error),
        type,
        currentCount,
        targetCount,
      });

      this.emit('error', error);
      throw error;
    }
  }

  /**
   * Restart an unhealthy worker
   */
  public async restartWorker(workerId: string): Promise<void> {
    const workerInfo = this.workers.get(workerId);
    if (!workerInfo) {
      throw new Error(`Worker not found: ${workerId}`);
    }

    if (workerInfo.restartCount >= workerInfo.maxRestartAttempts) {
      logger.error('Worker exceeded maximum restart attempts', {
        workerId,
        restartCount: workerInfo.restartCount,
        maxAttempts: workerInfo.maxRestartAttempts,
      });

      // Remove the worker permanently
      await this.removeWorker(workerId);
      return;
    }

    logger.info('Restarting unhealthy worker', {
      workerId,
      type: workerInfo.type,
      restartCount: workerInfo.restartCount + 1,
      maxAttempts: workerInfo.maxRestartAttempts,
    });

    try {
      // Stop the current worker
      await this.stopWorker(workerId);

      // Create a new worker of the same type
      await this.spawnWorkers(workerInfo.type, 1);

      logger.info('Worker restarted successfully', {
        workerId,
        type: workerInfo.type,
      });

      this.emit('workerRestarted', { workerId, type: workerInfo.type });
    } catch (error) {
      logger.error('Failed to restart worker', {
        error: error instanceof Error ? error.message : String(error),
        workerId,
      });

      this.emit('workerRestartFailed', { workerId, error });
      throw error;
    }
  }

  /**
   * Get current metrics for all workers
   */
  public getMetrics(): WorkerManagerMetrics {
    const workers = Array.from(this.workers.values());
    const healthyWorkers = workers.filter(w => w.isHealthy);
    const processingWorkers = workers.filter(w => w.status === WorkerStatus.PROCESSING);

    // Calculate memory usage
    const totalMemoryUsage = workers.reduce((sum, w) => sum + w.memoryUsage, 0);
    const averageMemoryUsage = workers.length > 0 ? totalMemoryUsage / workers.length : 0;

    // Calculate performance metrics
    const totalJobsProcessed = workers.reduce((sum, w) => sum + (w.metrics?.jobsProcessed || 0), 0);
    const totalJobsSuccessful = workers.reduce(
      (sum, w) => sum + (w.metrics?.jobsSuccessful || 0),
      0
    );
    const totalJobsFailed = workers.reduce((sum, w) => sum + (w.metrics?.jobsFailed || 0), 0);

    const avgProcessingTimes = workers
      .map(w => w.metrics?.avgProcessingTime)
      .filter(time => time && time > 0);
    const averageProcessingTime =
      avgProcessingTimes.length > 0
        ? avgProcessingTimes.reduce((sum, time) => sum + time, 0) / avgProcessingTimes.length
        : 0;

    // Calculate throughput (jobs per minute)
    const uptimeMinutes = (Date.now() - this.startTime.getTime()) / 60000;
    const throughput = uptimeMinutes > 0 ? totalJobsProcessed / uptimeMinutes : 0;

    // Calculate by type metrics
    const byType: Record<WorkerType, any> = {} as any;
    Object.values(WorkerType).forEach(type => {
      const typeWorkers = workers.filter(w => w.type === type);
      byType[type] = {
        count: typeWorkers.length,
        healthy: typeWorkers.filter(w => w.isHealthy).length,
        processing: typeWorkers.filter(w => w.status === WorkerStatus.PROCESSING).length,
        avgMemory:
          typeWorkers.length > 0
            ? typeWorkers.reduce((sum, w) => sum + w.memoryUsage, 0) / typeWorkers.length
            : 0,
      };
    });

    return {
      totalWorkers: workers.length,
      healthyWorkers: healthyWorkers.length,
      unhealthyWorkers: workers.length - healthyWorkers.length,
      processingJobs: processingWorkers.length,

      totalMemoryUsage,
      averageMemoryUsage,
      cpuUsage: this.getCurrentCpuUsage(),

      totalJobsProcessed,
      totalJobsSuccessful,
      totalJobsFailed,
      averageProcessingTime,
      throughput,

      byType,

      lastUpdated: new Date().toISOString(),
    };
  }

  /**
   * Get worker information
   */
  public getWorkerInfo(workerId?: string): WorkerInfo | WorkerInfo[] {
    if (workerId) {
      const worker = this.workers.get(workerId);
      if (!worker) {
        throw new Error(`Worker not found: ${workerId}`);
      }
      return worker;
    }

    return Array.from(this.workers.values());
  }

  /**
   * Get workers by type
   */
  public getWorkersByType(type: WorkerType): WorkerInfo[] {
    return Array.from(this.workers.values()).filter(worker => worker.type === type);
  }

  /**
   * Get worker manager status
   */
  public getStatus(): WorkerManagerStatus {
    return this.status;
  }

  /**
   * Check if worker manager is healthy
   */
  public isHealthy(): boolean {
    const workers = Array.from(this.workers.values());
    const healthyWorkers = workers.filter(w => w.isHealthy);
    const memoryUsage = workers.reduce((sum, w) => sum + w.memoryUsage, 0);

    return (
      this.status === WorkerManagerStatus.RUNNING &&
      healthyWorkers.length > 0 &&
      memoryUsage <= this.config.totalMemoryLimit
    );
  }

  /**
   * Spawn workers of specified type
   */
  private async spawnWorkers(type: WorkerType, count: number): Promise<void> {
    if (count <= 0) return;

    logger.info('Spawning workers', { type, count });

    const spawnPromises: Promise<void>[] = [];

    for (let i = 0; i < count; i++) {
      spawnPromises.push(this.spawnSingleWorker(type));
    }

    await Promise.all(spawnPromises);

    logger.info('Workers spawned successfully', {
      type,
      count,
      totalWorkers: this.workers.size,
    });
  }

  /**
   * Spawn a single worker
   */
  private async spawnSingleWorker(type: WorkerType): Promise<void> {
    const workerId = this.generateWorkerId(type);

    try {
      let worker: ChunkingWorker;

      switch (type) {
        case WorkerType.CHUNKING:
          const chunkingConfig = ChunkingWorkerUtils.createDefaultConfig(workerId);
          chunkingConfig.memoryLimit = this.config.maxMemoryPerWorker;
          worker = new ChunkingWorker(chunkingConfig);
          break;

        case WorkerType.PROCESSING:
          // TODO: Implement ProcessingWorker
          throw new Error('Processing workers not yet implemented');

        default:
          throw new Error(`Unknown worker type: ${type}`);
      }

      // Setup worker event listeners
      this.setupWorkerEventListeners(workerId, worker);

      // Start the worker
      await worker.start();

      // Register worker
      const workerInfo: WorkerInfo = {
        id: workerId,
        type,
        status: WorkerStatus.IDLE,
        pid: process.pid,
        startTime: new Date().toISOString(),
        restartCount: 0,
        maxRestartAttempts: this.config.maxRestartAttempts,
        worker,
        metrics: worker.getMetrics(),
        memoryUsage: 0,
        isHealthy: true,
      };

      this.workers.set(workerId, workerInfo);

      logger.info('Worker spawned successfully', {
        workerId,
        type,
        totalWorkers: this.workers.size,
      });

      this.emit('workerStarted', { workerId, type });
    } catch (error) {
      logger.error('Failed to spawn worker', {
        error: error instanceof Error ? error.message : String(error),
        workerId,
        type,
      });

      this.emit('workerStartFailed', { workerId, type, error });
      throw error;
    }
  }

  /**
   * Setup event listeners for a worker
   */
  private setupWorkerEventListeners(workerId: string, worker: ChunkingWorker): void {
    worker.on('error', error => {
      logger.error('Worker error', {
        workerId,
        error: error.message,
      });

      const workerInfo = this.workers.get(workerId);
      if (workerInfo) {
        workerInfo.isHealthy = false;
        workerInfo.status = WorkerStatus.ERROR;
      }

      this.emit('workerError', { workerId, error });
    });

    worker.on('unhealthy', data => {
      logger.warn('Worker became unhealthy', {
        workerId,
        data,
      });

      const workerInfo = this.workers.get(workerId);
      if (workerInfo) {
        workerInfo.isHealthy = false;
      }

      this.emit('workerUnhealthy', { workerId, data });

      // Schedule worker restart if auto-restart is enabled
      if (this.config.maxRestartAttempts > 0) {
        setTimeout(() => {
          this.restartWorker(workerId).catch(error => {
            logger.error('Auto-restart failed', { workerId, error: error.message });
          });
        }, this.config.unhealthyWorkerTimeout);
      }
    });

    worker.on('jobProgress', data => {
      this.emit('jobProgress', { workerId, ...data });
    });
  }

  /**
   * Remove workers of specified type
   */
  private async removeWorkers(type: WorkerType, count: number): Promise<void> {
    const workers = this.getWorkersByType(type);
    const workersToRemove = workers.slice(0, count);

    logger.info('Removing workers', {
      type,
      count,
      workersToRemove: workersToRemove.map(w => w.id),
    });

    const removePromises = workersToRemove.map(worker => this.removeWorker(worker.id));
    await Promise.all(removePromises);

    logger.info('Workers removed successfully', {
      type,
      count,
      remainingWorkers: this.getWorkersByType(type).length,
    });
  }

  /**
   * Remove a specific worker
   */
  private async removeWorker(workerId: string): Promise<void> {
    const workerInfo = this.workers.get(workerId);
    if (!workerInfo) {
      return;
    }

    try {
      await this.stopWorker(workerId);
      this.workers.delete(workerId);

      logger.info('Worker removed', {
        workerId,
        type: workerInfo.type,
      });

      this.emit('workerRemoved', { workerId, type: workerInfo.type });
    } catch (error) {
      logger.error('Failed to remove worker', {
        error: error instanceof Error ? error.message : String(error),
        workerId,
      });
      throw error;
    }
  }

  /**
   * Stop a specific worker
   */
  private async stopWorker(workerId: string): Promise<void> {
    const workerInfo = this.workers.get(workerId);
    if (!workerInfo) {
      return;
    }

    try {
      await Promise.race([
        workerInfo.worker.stop(),
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error('Worker stop timeout')),
            this.config.gracefulShutdownTimeout
          )
        ),
      ]);

      logger.debug('Worker stopped gracefully', { workerId });
    } catch (error) {
      logger.warn('Worker did not stop gracefully, forcing shutdown', {
        workerId,
        error: error instanceof Error ? error.message : String(error),
      });

      // Force stop if graceful shutdown failed
      // Note: In a real implementation, you might need to kill the process
    }
  }

  /**
   * Stop all workers
   */
  private async stopAllWorkers(): Promise<void> {
    const workers = Array.from(this.workers.values());

    if (workers.length === 0) {
      return;
    }

    logger.info('Stopping all workers', { count: workers.length });

    const stopPromises = workers.map(worker =>
      this.stopWorker(worker.id).catch(error => {
        logger.error('Failed to stop worker', {
          workerId: worker.id,
          error: error.message,
        });
      })
    );

    await Promise.allSettled(stopPromises);

    this.workers.clear();

    logger.info('All workers stopped');
  }

  /**
   * Start health monitoring
   */
  private startHealthMonitoring(): void {
    this.healthCheckTimer = setInterval(() => {
      this.performHealthCheck();
    }, this.config.healthCheckInterval);

    logger.debug('Health monitoring started', {
      interval: this.config.healthCheckInterval,
    });
  }

  /**
   * Stop health monitoring
   */
  private stopHealthMonitoring(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
  }

  /**
   * Perform health check on all workers
   */
  private performHealthCheck(): void {
    const workers = Array.from(this.workers.values());

    for (const workerInfo of workers) {
      try {
        const isHealthy = workerInfo.worker.isHealthy();
        const metrics = workerInfo.worker.getMetrics();

        // Update worker info
        workerInfo.isHealthy = isHealthy;
        workerInfo.status = workerInfo.worker.getStatus();
        workerInfo.metrics = metrics;
        workerInfo.memoryUsage = metrics.memoryUsage;
        workerInfo.lastHealthCheck = new Date().toISOString();
      } catch (error) {
        logger.error('Health check failed for worker', {
          workerId: workerInfo.id,
          error: error instanceof Error ? error.message : String(error),
        });

        workerInfo.isHealthy = false;
      }
    }

    // Emit overall health status
    const totalWorkers = workers.length;
    const healthyWorkers = workers.filter(w => w.isHealthy).length;

    this.emit('healthCheck', {
      totalWorkers,
      healthyWorkers,
      unhealthyWorkers: totalWorkers - healthyWorkers,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Start auto-scaling
   */
  private startAutoScaling(): void {
    this.scalingTimer = setInterval(() => {
      this.performAutoScaling();
    }, 60000); // Check every minute

    logger.debug('Auto-scaling started');
  }

  /**
   * Stop auto-scaling
   */
  private stopAutoScaling(): void {
    if (this.scalingTimer) {
      clearInterval(this.scalingTimer);
      this.scalingTimer = null;
    }
  }

  /**
   * Perform auto-scaling based on queue metrics
   */
  private performAutoScaling(): void {
    // TODO: Implement auto-scaling logic based on queue size and worker load
    // This would check queue depths and scale workers accordingly
    logger.debug('Auto-scaling check performed (implementation pending)');
  }

  /**
   * Create configuration with defaults
   */
  private createConfig(userConfig?: Partial<WorkerManagerConfig>): WorkerManagerConfig {
    const workerConfig = configManager.getWorkerConfig();

    const defaultConfig: WorkerManagerConfig = {
      chunkingWorkers: workerConfig.chunkingWorkers,
      processingWorkers: workerConfig.ingestionWorkers,
      maxMemoryPerWorker: 256, // 256MB as requested
      totalMemoryLimit: 2048, // 2GB total
      autoScaling: false,
      minWorkers: 1,
      maxWorkers: 10,
      scaleUpThreshold: 10,
      scaleDownThreshold: 2,
      healthCheckInterval: 30000,
      unhealthyWorkerTimeout: 60000,
      maxRestartAttempts: 3,
      gracefulShutdownTimeout: 30000,
      forceShutdownDelay: 5000,
    };

    return { ...defaultConfig, ...userConfig };
  }

  /**
   * Validate configuration
   */
  private validateConfig(): void {
    const errors: string[] = [];

    if (this.config.chunkingWorkers < 0) {
      errors.push('chunkingWorkers must be non-negative');
    }

    if (this.config.maxMemoryPerWorker < 64) {
      errors.push('maxMemoryPerWorker must be at least 64MB');
    }

    if (this.config.minWorkers < 1) {
      errors.push('minWorkers must be at least 1');
    }

    if (this.config.maxWorkers < this.config.minWorkers) {
      errors.push('maxWorkers must be greater than or equal to minWorkers');
    }

    if (errors.length > 0) {
      throw new Error(`Invalid worker manager configuration: ${errors.join(', ')}`);
    }
  }

  /**
   * Setup process signal handlers
   */
  private setupProcessHandlers(): void {
    const gracefulShutdown = (signal: string) => {
      logger.info(`Received ${signal}, initiating graceful shutdown`);

      this.stop().catch(error => {
        logger.error('Error during graceful shutdown', {
          error: error.message,
        });
        process.exit(1);
      });
    };

    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
    process.on('SIGINT', () => gracefulShutdown('SIGINT'));
  }

  /**
   * Generate unique worker ID
   */
  private generateWorkerId(type: WorkerType): string {
    const hostname = os.hostname();
    const timestamp = Date.now();
    const random = uuidv4().substring(0, 8);

    return `${type}-${hostname}-${timestamp}-${random}`;
  }

  /**
   * Get current CPU usage (placeholder)
   */
  private getCurrentCpuUsage(): number {
    // This is a placeholder - actual CPU monitoring would require additional libraries
    return 0;
  }
}

// Export utility functions
export const WorkerManagerUtils = {
  /**
   * Create default worker manager configuration
   */
  createDefaultConfig(): WorkerManagerConfig {
    const workerConfig = configManager.getWorkerConfig();

    return {
      chunkingWorkers: workerConfig.chunkingWorkers,
      processingWorkers: workerConfig.ingestionWorkers,
      maxMemoryPerWorker: 256,
      totalMemoryLimit: 2048,
      autoScaling: false,
      minWorkers: 1,
      maxWorkers: 10,
      scaleUpThreshold: 10,
      scaleDownThreshold: 2,
      healthCheckInterval: 30000,
      unhealthyWorkerTimeout: 60000,
      maxRestartAttempts: 3,
      gracefulShutdownTimeout: 30000,
      forceShutdownDelay: 5000,
    };
  },

  /**
   * Calculate optimal worker count based on available resources
   */
  calculateOptimalWorkerCount(
    availableMemoryMB: number,
    avgMemoryPerWorkerMB: number = 256,
    cpuCores: number = os.cpus().length
  ): number {
    const memoryBasedCount = Math.floor(availableMemoryMB / avgMemoryPerWorkerMB);
    const cpuBasedCount = cpuCores * 2; // 2x CPU cores as a heuristic

    return Math.min(memoryBasedCount, cpuBasedCount, 10); // Cap at 10 workers
  },

  /**
   * Estimate memory requirements
   */
  estimateMemoryRequirements(
    chunkingWorkers: number,
    processingWorkers: number,
    memoryPerWorker: number = 256
  ): {
    totalMemoryMB: number;
    recommendedSystemMemoryMB: number;
  } {
    const totalMemoryMB = (chunkingWorkers + processingWorkers) * memoryPerWorker;
    const recommendedSystemMemoryMB = totalMemoryMB * 1.5; // 50% overhead for system

    return {
      totalMemoryMB,
      recommendedSystemMemoryMB,
    };
  },
};
