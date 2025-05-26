/**
 * Chunking Worker Implementation
 * BullMQ worker that processes CSV chunking jobs with progress tracking and error handling
 */

import { Worker, Job } from 'bullmq';
import { ChunkingJobData, ChunkingJobResult, JobProgress } from '../../queues/types/ChunkingJob';
import {
  ChunkingService,
  ChunkingServiceConfig,
  ChunkingProgress,
  ChunkingServiceUtils,
} from '../../services/ChunkingService';
import { BulkActionService } from '../../services/BulkActionService';
import { BulkActionStatService } from '../../services/BulkActionStatService';
import { ProcessingQueue } from '../../queues/ProcessingQueue';
import { BulkActionRepository } from '../../repositories/BulkActionRepository';
import { BulkActionStatRepository } from '../../repositories/BulkActionStatRepository';
import queueConfigManager from '../../queues/config/queueConfig';
import { logger } from '../../utils/logger';
import { ValidationError, DatabaseError } from '../../utils/error';
import configManager from '../../config/app';
import { EventEmitter } from 'events';

export interface ChunkingWorkerConfig {
  workerId: string;
  concurrency: number;
  maxJobsPerWorker: number;
  jobTimeout: number; // Job timeout in milliseconds
  healthCheckInterval: number; // Health check interval in milliseconds
  memoryLimit: number; // Memory limit in MB
  enableMetrics: boolean;
  retryFailedJobs: boolean;
}

export interface WorkerMetrics {
  workerId: string;
  status: WorkerStatus;

  // Job processing metrics
  jobsProcessed: number;
  jobsSuccessful: number;
  jobsFailed: number;
  avgProcessingTime: number;

  // Performance metrics
  recordsProcessed: number;
  avgRecordsPerSecond: number;

  // Resource usage
  memoryUsage: number; // Current memory usage in MB
  cpuUsage: number; // CPU usage percentage

  // Timing
  startTime: string;
  lastJobTime?: string;
  uptime: number;

  // Current job info
  currentJob?: {
    id: string;
    actionId: string;
    accountId: string;
    startTime: string;
    progress: number;
  };
}

export enum WorkerStatus {
  STARTING = 'starting',
  IDLE = 'idle',
  PROCESSING = 'processing',
  PAUSED = 'paused',
  STOPPING = 'stopping',
  STOPPED = 'stopped',
  ERROR = 'error',
}

export class ChunkingWorker extends EventEmitter {
  private config: ChunkingWorkerConfig;
  private worker!: Worker<ChunkingJobData, ChunkingJobResult>;
  private chunkingService: ChunkingService;
  private processingQueue: ProcessingQueue;

  // Services
  private bulkActionService: BulkActionService;
  private bulkActionStatService: BulkActionStatService;

  // State tracking
  private status: WorkerStatus = WorkerStatus.STARTING;
  private metrics: WorkerMetrics;
  private currentJob: Job<ChunkingJobData, ChunkingJobResult> | null = null;
  private healthCheckTimer: NodeJS.Timeout | null = null;
  private isShuttingDown = false;

  constructor(config: ChunkingWorkerConfig) {
    super();

    this.config = config;
    this.metrics = this.initializeMetrics();

    // Initialize services
    const bulkActionRepository = new BulkActionRepository();
    const bulkActionStatRepository = new BulkActionStatRepository();
    this.bulkActionService = new BulkActionService(bulkActionRepository);
    this.bulkActionStatService = new BulkActionStatService(bulkActionStatRepository);
    this.chunkingService = new ChunkingService(this.bulkActionService, this.bulkActionStatService);
    this.processingQueue = new ProcessingQueue();

    // Initialize BullMQ worker
    this.initializeWorker();

    // Start health monitoring
    this.startHealthMonitoring();
  }

  /**
   * Start the worker
   */
  public async start(): Promise<void> {
    try {
      logger.info('Starting chunking worker', {
        workerId: this.config.workerId,
        concurrency: this.config.concurrency,
      });

      // Initialize processing queue
      await this.processingQueue.initialize();

      this.status = WorkerStatus.IDLE;
      this.metrics.startTime = new Date().toISOString();

      logger.info('Chunking worker started successfully', {
        workerId: this.config.workerId,
        status: this.status,
      });

      this.emit('started');
    } catch (error) {
      this.status = WorkerStatus.ERROR;

      logger.error('Failed to start chunking worker', {
        error: error instanceof Error ? error.message : String(error),
        workerId: this.config.workerId,
      });

      this.emit('error', error);
      throw error;
    }
  }

  /**
   * Stop the worker gracefully
   */
  public async stop(): Promise<void> {
    this.isShuttingDown = true;
    this.status = WorkerStatus.STOPPING;

    logger.info('Stopping chunking worker', {
      workerId: this.config.workerId,
    });

    try {
      // Stop health monitoring
      if (this.healthCheckTimer) {
        clearInterval(this.healthCheckTimer);
        this.healthCheckTimer = null;
      }

      // Abort current job if any
      if (this.currentJob) {
        logger.info('Aborting current job', {
          workerId: this.config.workerId,
          jobId: this.currentJob.id,
        });

        this.chunkingService.abort();
      }

      // Close BullMQ worker
      await this.worker.close();

      // Close processing queue
      await this.processingQueue.close();

      this.status = WorkerStatus.STOPPED;

      logger.info('Chunking worker stopped successfully', {
        workerId: this.config.workerId,
        jobsProcessed: this.metrics.jobsProcessed,
        uptime: this.getUptime(),
      });

      this.emit('stopped');
    } catch (error) {
      this.status = WorkerStatus.ERROR;

      logger.error('Error stopping chunking worker', {
        error: error instanceof Error ? error.message : String(error),
        workerId: this.config.workerId,
      });

      this.emit('error', error);
      throw error;
    }
  }

  /**
   * Pause the worker
   */
  public async pause(): Promise<void> {
    await this.worker.pause();
    this.status = WorkerStatus.PAUSED;

    logger.info('Chunking worker paused', {
      workerId: this.config.workerId,
    });

    this.emit('paused');
  }

  /**
   * Resume the worker
   */
  public async resume(): Promise<void> {
    await this.worker.resume();
    this.status = WorkerStatus.IDLE;

    logger.info('Chunking worker resumed', {
      workerId: this.config.workerId,
    });

    this.emit('resumed');
  }

  /**
   * Get current worker metrics
   */
  public getMetrics(): WorkerMetrics {
    return {
      ...this.metrics,
      uptime: this.getUptime(),
      memoryUsage: this.getCurrentMemoryUsage(),
      cpuUsage: this.getCurrentCpuUsage(),
    };
  }

  /**
   * Get worker status
   */
  public getStatus(): WorkerStatus {
    return this.status;
  }

  /**
   * Check if worker is healthy
   */
  public isHealthy(): boolean {
    const memoryOk = this.getCurrentMemoryUsage() < this.config.memoryLimit;
    const statusOk = [WorkerStatus.IDLE, WorkerStatus.PROCESSING].includes(this.status);
    const notShuttingDown = !this.isShuttingDown;

    return memoryOk && statusOk && notShuttingDown;
  }

  /**
   * Initialize BullMQ worker
   */
  private initializeWorker(): void {
    const queueConfig = queueConfigManager.getChunkingQueueConfig();

    this.worker = new Worker<ChunkingJobData, ChunkingJobResult>(
      queueConfig.name,
      this.processJob.bind(this),
      {
        connection: queueConfig.connection,
        concurrency: this.config.concurrency,
        maxStalledCount: 3,
        stalledInterval: 30000,
        removeOnComplete: { count: 10 },
        removeOnFail: { count: 5 },
      }
    );

    // Setup event listeners
    this.setupWorkerEventListeners();
  }

  /**
   * Setup worker event listeners
   */
  private setupWorkerEventListeners(): void {
    this.worker.on('ready', () => {
      logger.info('Chunking worker ready', {
        workerId: this.config.workerId,
      });
    });

    this.worker.on('error', error => {
      logger.error('Chunking worker error', {
        error: error.message,
        workerId: this.config.workerId,
      });

      this.status = WorkerStatus.ERROR;
      this.emit('error', error);
    });

    this.worker.on('stalled', jobId => {
      logger.warn('Chunking job stalled', {
        jobId,
        workerId: this.config.workerId,
      });
    });

    this.worker.on('failed', (job, err) => {
      logger.error('Chunking job failed', {
        jobId: job?.id,
        actionId: job?.data.actionId,
        error: err.message,
        workerId: this.config.workerId,
      });

      this.updateMetrics('failed');
    });

    this.worker.on('completed', (job, result) => {
      logger.info('Chunking job completed', {
        jobId: job.id,
        actionId: job.data.actionId,
        success: result.success,
        recordsProcessed: result.csvProcessing?.totalRecords || 0,
        chunksCreated: result.chunking?.totalChunks || 0,
        workerId: this.config.workerId,
      });

      this.updateMetrics('completed', result);
    });
  }

  /**
   * Process a chunking job
   */
  private async processJob(
    job: Job<ChunkingJobData, ChunkingJobResult>
  ): Promise<ChunkingJobResult> {
    const startTime = Date.now();
    this.currentJob = job;
    this.status = WorkerStatus.PROCESSING;

    // Update current job metrics
    this.metrics.currentJob = {
      id: job.id || 'unknown',
      actionId: job.data.actionId,
      accountId: job.data.accountId,
      startTime: new Date().toISOString(),
      progress: 0,
    };

    const log = logger.withTrace(job.data.traceId);

    try {
      log.info('Starting chunking job processing', {
        jobId: job.id,
        actionId: job.data.actionId,
        accountId: job.data.accountId,
        filePath: job.data.filePath,
        fileSize: job.data.fileSize,
        workerId: this.config.workerId,
      });

      // Validate job data
      this.validateJobData(job.data);

      // Check memory before processing
      const memoryUsage = this.getCurrentMemoryUsage();
      if (memoryUsage > this.config.memoryLimit * 0.9) {
        throw new Error(
          `Memory usage too high: ${memoryUsage}MB (limit: ${this.config.memoryLimit}MB)`
        );
      }

      // Create chunking service config
      const serviceConfig = this.createChunkingServiceConfig(job.data);

      // Setup progress tracking
      let lastProgressUpdate = 0;
      const onProgress = async (progress: ChunkingProgress) => {
        const now = Date.now();

        // Update job progress (limit to every 5 seconds to avoid spam)
        if (now - lastProgressUpdate > 5000) {
          await job.updateProgress(this.convertToJobProgress(progress));
          lastProgressUpdate = now;
        }

        // Update worker metrics
        if (this.metrics.currentJob) {
          this.metrics.currentJob.progress = progress.overallProgress;
        }

        // Emit progress event
        this.emit('jobProgress', {
          jobId: job.id,
          actionId: job.data.actionId,
          progress,
        });
      };

      // Process the CSV file
      const result = await this.chunkingService.processCSVFile(
        job.data.filePath,
        job.data.actionId,
        job.data.accountId,
        serviceConfig,
        onProgress,
        job.data.traceId
      );

      // If successful, enqueue processing jobs for each chunk
      if (result.success && result.chunkMetadata.length > 0) {
        await this.enqueueProcessingJobs(job.data, result, log);
      }

      // Create and return job result
      const jobResult = this.createJobResult(job.data, result, startTime);

      log.info('Chunking job completed successfully', {
        jobId: job.id,
        actionId: job.data.actionId,
        success: jobResult.success,
        totalRecords: jobResult.csvProcessing.totalRecords,
        chunksCreated: jobResult.chunking.totalChunks,
        processingTime: jobResult.timing.durationMs,
      });

      return jobResult;
    } catch (error) {
      const processingTime = Date.now() - startTime;

      log.error('Chunking job failed', {
        error: error instanceof Error ? error.message : String(error),
        jobId: job.id,
        actionId: job.data.actionId,
        processingTime,
        workerId: this.config.workerId,
      });

      // Create failure result
      const jobResult = this.createFailureResult(job.data, error, startTime);

      // Don't throw - return the error result instead
      return jobResult;
    } finally {
      this.currentJob = null;
      this.status = this.isShuttingDown ? WorkerStatus.STOPPING : WorkerStatus.IDLE;
      this.metrics.currentJob = undefined;
      this.metrics.lastJobTime = new Date().toISOString();
    }
  }

  /**
   * Enqueue processing jobs for each chunk with partition routing
   */
  private async enqueueProcessingJobs(
    jobData: ChunkingJobData,
    chunkingResult: any,
    log: any
  ): Promise<string[]> {
    const jobIds: string[] = [];

    try {
      // Get partition count from environment
      const partitionCount = parseInt(process.env.PROCESSING_WORKER_COUNT || '5');

      log.info('Enqueuing processing jobs with partition routing', {
        actionId: jobData.actionId,
        totalChunks: chunkingResult.chunkMetadata.length,
        partitionCount,
      });

      for (let i = 0; i < chunkingResult.chunkMetadata.length; i++) {
        const chunk = chunkingResult.chunkMetadata[i];

        // Calculate partition using consistent hashing on chunk hash range
        const partitionId = this.calculatePartitionForChunk(chunk, partitionCount);

        const processingJobData = {
          traceId: jobData.traceId,
          accountId: jobData.accountId,
          actionId: jobData.actionId,
          createdAt: new Date().toISOString(),

          // Chunk information
          chunkId: chunk.chunkId,
          chunkPath: chunk.chunkPath,
          chunkIndex: chunk.chunkIndex,
          totalChunks: chunkingResult.chunkMetadata.length,

          // Chunk metadata
          recordCount: chunk.recordCount,
          startRecord: chunk.startRecord,
          endRecord: chunk.endRecord,

          // Action configuration
          entityType: jobData.entityType,
          actionType: jobData.actionType,
          configuration: jobData.configuration,

          // Hash range (for consistent hashing)
          hashRangeStart: chunk.hashRangeStart,
          hashRangeEnd: chunk.hashRangeEnd,
        };

        // Enqueue job to specific partition
        const processingJob = await this.processingQueue.addProcessingJobToPartition(
          partitionId,
          processingJobData,
          {
            priority: 5, // Lower priority than chunking
            attempts: 5,
            backoff: { type: 'exponential' },
          },
          jobData.traceId
        );

        jobIds.push(processingJob.id || '');

        log.debug('Processing job enqueued to partition', {
          chunkId: chunk.chunkId,
          chunkIndex: chunk.chunkIndex,
          partitionId,
          jobId: processingJob.id,
          hashRange: `${chunk.hashRangeStart}-${chunk.hashRangeEnd}`,
        });
      }

      log.info('Processing jobs enqueued with partition routing', {
        actionId: jobData.actionId,
        totalJobs: jobIds.length,
        partitionDistribution: this.getPartitionDistribution(
          chunkingResult.chunkMetadata,
          partitionCount
        ),
      });

      return jobIds;
    } catch (error) {
      log.error('Failed to enqueue processing jobs with partitioning', {
        error: error instanceof Error ? error.message : String(error),
        actionId: jobData.actionId,
        enqueuedJobs: jobIds.length,
      });

      // Don't throw - partial success is still valuable
      return jobIds;
    }
  }

  /**
   * Calculate partition for a chunk using consistent hashing
   */
  private calculatePartitionForChunk(chunk: any, partitionCount: number): number {
    const hashValue = chunk.hashRangeStart;

    const hashNum = parseInt(hashValue.substring(0, 8), 16);
    const partitionId = hashNum % partitionCount;

    return partitionId;
  }

  /**
   * Get partition distribution for logging
   */
  private getPartitionDistribution(
    chunkMetadata: any[],
    partitionCount: number
  ): Record<number, number> {
    const distribution: Record<number, number> = {};

    // Initialize all partitions with 0
    for (let i = 0; i < partitionCount; i++) {
      distribution[i] = 0;
    }

    // Count chunks per partition
    for (const chunk of chunkMetadata) {
      const partitionId = this.calculatePartitionForChunk(chunk, partitionCount);
      distribution[partitionId] = (distribution[partitionId] ?? 0) + 1;
    }

    return distribution;
  }

  /**
   * Validate job data
   */
  private validateJobData(data: ChunkingJobData): void {
    if (!data.actionId) {
      throw new ValidationError('actionId is required');
    }

    if (!data.accountId) {
      throw new ValidationError('accountId is required');
    }

    if (!data.filePath) {
      throw new ValidationError('filePath is required');
    }

    if (!data.entityType) {
      throw new ValidationError('entityType is required');
    }

    if (!data.actionType) {
      throw new ValidationError('actionType is required');
    }

    if (data.fileSize <= 0) {
      throw new ValidationError('fileSize must be greater than 0');
    }

    if (data.estimatedEntityCount < 0) {
      throw new ValidationError('estimatedEntityCount cannot be negative');
    }
  }

  /**
   * Create chunking service configuration from job data
   */
  private createChunkingServiceConfig(jobData: ChunkingJobData): ChunkingServiceConfig {
    return ChunkingServiceUtils.createDefaultConfig(
      jobData.entityType,
      jobData.actionType,
      jobData.configuration,
      jobData.estimatedEntityCount
    );
  }

  /**
   * Convert chunking progress to job progress
   */
  private convertToJobProgress(progress: ChunkingProgress): JobProgress {
    return {
      stage: this.mapChunkingStageToJobStage(progress.stage),
      percentage: progress.overallProgress,
      processedRecords: progress.csvProgress?.processedRows || 0,
      totalRecords: progress.csvProgress?.estimatedTotalRows || 0,
      message: progress.message,
      timestamp: progress.timestamp,
    };
  }

  /**
   * Map chunking stage to job progress stage
   */
  private mapChunkingStageToJobStage(stage: string): JobProgress['stage'] {
    const stageMap: Record<string, JobProgress['stage']> = {
      initializing: 'starting',
      validating_structure: 'validating',
      processing_rows: 'processing',
      finalizing_chunks: 'chunking',
      uploading_chunks: 'chunking',
      updating_stats: 'completing',
      completed: 'completed',
      failed: 'failed',
    };

    return stageMap[stage] || 'processing';
  }

  /**
   * Create successful job result
   */
  private createJobResult(
    jobData: ChunkingJobData,
    serviceResult: any,
    startTime: number
  ): ChunkingJobResult {
    const durationMs = Date.now() - startTime;

    return {
      success: serviceResult.success,
      actionId: jobData.actionId,

      fileValidation: {
        isValid: true,
      },

      csvProcessing: {
        totalRecords: serviceResult.totalRecords,
        validRecords: serviceResult.validRecords,
        invalidRecords: serviceResult.invalidRecords,
        duplicateRecords: serviceResult.duplicateRecords,
        skippedRecords: serviceResult.skippedRecords,
      },

      chunking: {
        totalChunks: serviceResult.chunksCreated,
        chunkPaths: serviceResult.chunkMetadata.map((chunk: any) => chunk.chunkPath),
        chunkMetadata: serviceResult.chunkMetadata.map((chunk: any) => ({
          chunkId: chunk.chunkId,
          chunkPath: chunk.chunkPath,
          recordCount: chunk.recordCount,
          hashRangeStart: chunk.hashRangeStart,
          hashRangeEnd: chunk.hashRangeEnd,
        })),
      },

      processingJobs: {
        jobIds: [], // Would be populated by enqueueProcessingJobs
        totalJobs: serviceResult.chunksCreated,
      },

      timing: {
        startedAt: new Date(startTime).toISOString(),
        completedAt: new Date().toISOString(),
        durationMs,
        stages: {
          validation: Math.floor(durationMs * 0.2),
          chunking: Math.floor(durationMs * 0.6),
          storage: Math.floor(durationMs * 0.2),
        },
      },
    };
  }

  /**
   * Create failure job result
   */
  private createFailureResult(
    jobData: ChunkingJobData,
    error: unknown,
    startTime: number
  ): ChunkingJobResult {
    const durationMs = Date.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : String(error);

    return {
      success: false,
      actionId: jobData.actionId,

      fileValidation: {
        isValid: false,
        errorMessage,
      },

      csvProcessing: {
        totalRecords: 0,
        validRecords: 0,
        invalidRecords: 0,
        duplicateRecords: 0,
        skippedRecords: 0,
      },

      chunking: {
        totalChunks: 0,
        chunkPaths: [],
        chunkMetadata: [],
      },

      processingJobs: {
        jobIds: [],
        totalJobs: 0,
      },

      timing: {
        startedAt: new Date(startTime).toISOString(),
        completedAt: new Date().toISOString(),
        durationMs,
        stages: {
          validation: 0,
          chunking: 0,
          storage: 0,
        },
      },

      error: {
        stage: this.determineErrorStage(error),
        message: errorMessage,
        retryable: this.isRetryableError(error),
      },
    };
  }

  /**
   * Determine error stage based on error type
   */
  private determineErrorStage(error: unknown): string {
    if (error instanceof ValidationError) {
      return 'validation';
    } else if (error instanceof DatabaseError) {
      return 'storage';
    } else {
      return 'processing';
    }
  }

  /**
   * Check if error is retryable
   */
  private isRetryableError(error: unknown): boolean {
    if (error instanceof ValidationError) {
      return false; // Validation errors are not retryable
    }

    if (error instanceof Error) {
      const retryablePatterns = [
        /timeout/i,
        /connection/i,
        /network/i,
        /temporary/i,
        /rate limit/i,
      ];

      return retryablePatterns.some(pattern => pattern.test(error.message));
    }

    return true; // Unknown errors are retryable by default
  }

  /**
   * Update worker metrics
   */
  private updateMetrics(result: 'completed' | 'failed', jobResult?: ChunkingJobResult): void {
    this.metrics.jobsProcessed++;

    if (result === 'completed') {
      this.metrics.jobsSuccessful++;

      if (jobResult) {
        this.metrics.recordsProcessed += jobResult.csvProcessing.totalRecords;

        // Update average processing time
        const processingTime = jobResult.timing.durationMs;
        this.metrics.avgProcessingTime =
          (this.metrics.avgProcessingTime * (this.metrics.jobsSuccessful - 1) + processingTime) /
          this.metrics.jobsSuccessful;

        // Update average records per second
        const recordsPerSecond = jobResult.csvProcessing.totalRecords / (processingTime / 1000);
        this.metrics.avgRecordsPerSecond =
          (this.metrics.avgRecordsPerSecond * (this.metrics.jobsSuccessful - 1) +
            recordsPerSecond) /
          this.metrics.jobsSuccessful;
      }
    } else {
      this.metrics.jobsFailed++;
    }
  }

  /**
   * Start health monitoring
   */
  private startHealthMonitoring(): void {
    this.healthCheckTimer = setInterval(() => {
      this.performHealthCheck();
    }, this.config.healthCheckInterval);
  }

  /**
   * Perform health check
   */
  private performHealthCheck(): void {
    try {
      const memoryUsage = this.getCurrentMemoryUsage();
      const isHealthy = this.isHealthy();

      if (!isHealthy) {
        logger.warn('Chunking worker health check failed', {
          workerId: this.config.workerId,
          memoryUsage,
          memoryLimit: this.config.memoryLimit,
          status: this.status,
        });

        this.emit('unhealthy', {
          workerId: this.config.workerId,
          memoryUsage,
          status: this.status,
        });
      }

      // Force garbage collection if memory usage is high
      if (memoryUsage > this.config.memoryLimit * 0.8 && global.gc) {
        global.gc();
        logger.info('Forced garbage collection', {
          workerId: this.config.workerId,
          memoryBefore: memoryUsage,
          memoryAfter: this.getCurrentMemoryUsage(),
        });
      }
    } catch (error) {
      logger.error('Health check failed', {
        error: error instanceof Error ? error.message : String(error),
        workerId: this.config.workerId,
      });
    }
  }

  /**
   * Get current memory usage in MB
   */
  private getCurrentMemoryUsage(): number {
    const usage = process.memoryUsage();
    return Math.round(usage.heapUsed / 1024 / 1024);
  }

  /**
   * Get current CPU usage (placeholder - would need actual implementation)
   */
  private getCurrentCpuUsage(): number {
    // This is a placeholder - actual CPU monitoring would require additional libraries
    return 0;
  }

  /**
   * Get worker uptime in milliseconds
   */
  private getUptime(): number {
    return this.metrics.startTime ? Date.now() - new Date(this.metrics.startTime).getTime() : 0;
  }

  /**
   * Initialize worker metrics
   */
  private initializeMetrics(): WorkerMetrics {
    return {
      workerId: this.config.workerId,
      status: WorkerStatus.STARTING,
      jobsProcessed: 0,
      jobsSuccessful: 0,
      jobsFailed: 0,
      avgProcessingTime: 0,
      recordsProcessed: 0,
      avgRecordsPerSecond: 0,
      memoryUsage: 0,
      cpuUsage: 0,
      startTime: '',
      uptime: 0,
    };
  }
}

// Export utility functions for worker management
export const ChunkingWorkerUtils = {
  /**
   * Create default worker configuration
   */
  createDefaultConfig(workerId: string): ChunkingWorkerConfig {
    const workerConfig = configManager.getWorkerConfig();

    return {
      workerId,
      concurrency: Math.min(workerConfig.chunkingWorkers, 3), // Max 3 concurrent jobs per worker
      maxJobsPerWorker: 100,
      jobTimeout: 30 * 60 * 1000, // 30 minutes
      healthCheckInterval: 30000, // 30 seconds
      memoryLimit: 256, // 256MB as requested
      enableMetrics: true,
      retryFailedJobs: true,
    };
  },

  /**
   * Create worker ID
   */
  createWorkerId(hostname?: string): string {
    const host = hostname || require('os').hostname();
    const pid = process.pid;
    const timestamp = Date.now();
    return `chunking-worker-${host}-${pid}-${timestamp}`;
  },

  /**
   * Calculate optimal concurrency based on available memory
   */
  calculateOptimalConcurrency(availableMemoryMB: number, avgJobMemoryMB: number = 64): number {
    return Math.max(1, Math.floor(availableMemoryMB / avgJobMemoryMB));
  },

  /**
   * Validate worker configuration
   */
  validateConfig(config: ChunkingWorkerConfig): string[] {
    const errors: string[] = [];

    if (config.concurrency < 1) {
      errors.push('concurrency must be at least 1');
    }

    if (config.concurrency > 10) {
      errors.push('concurrency should not exceed 10 for optimal performance');
    }

    if (config.memoryLimit < 128) {
      errors.push('memoryLimit should be at least 128MB');
    }

    if (config.jobTimeout < 60000) {
      errors.push('jobTimeout should be at least 1 minute');
    }

    return errors;
  },
};
