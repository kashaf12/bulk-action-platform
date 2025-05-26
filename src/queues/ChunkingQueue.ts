/**
 * Chunking Queue Implementation
 * Manages the BullMQ queue for CSV chunking jobs with monitoring and health checks
 */

import { Queue, QueueEvents, Job, JobsOptions, RedisOptions } from 'bullmq';
import { ChunkingJobData, ChunkingJobResult, JobEvent, QueueHealth } from './types/ChunkingJob';
import queueConfigManager from './config/queueConfig';
import { logger } from '../utils/logger';
import { EventEmitter } from 'events';

export class ChunkingQueue extends EventEmitter {
  private queue: Queue<ChunkingJobData, ChunkingJobResult>;
  private queueEvents: QueueEvents;
  private isInitialized = false;
  private healthMetrics: Partial<QueueHealth> = {};

  constructor() {
    super();

    const config = queueConfigManager.getChunkingQueueConfig();

    // Initialize BullMQ queue
    this.queue = new Queue<ChunkingJobData, ChunkingJobResult>(config.name, {
      connection: config.connection,
      defaultJobOptions: config.defaultJobOptions,
    });

    // Initialize queue events for monitoring
    this.queueEvents = new QueueEvents(config.name, {
      connection: config.connection,
    });

    // this.setupEventListeners();
    this.startHealthMonitoring();
  }

  /**
   * Initialize the queue and validate connections
   */
  public async initialize(): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    try {
      // Validate Redis connection
      const isConnected = await queueConfigManager.validateConnection();
      if (!isConnected) {
        throw new Error('Redis connection validation failed');
      }

      // Wait for queue to be ready
      await this.queue.waitUntilReady();
      await this.queueEvents.waitUntilReady();

      this.isInitialized = true;

      logger.info('Chunking queue initialized successfully', {
        queueName: this.queue.name,
        redisHost: (queueConfigManager.getConnectionOptions() as RedisOptions).host,
      });

      // Emit initialization event
      this.emit('initialized');
    } catch (error) {
      logger.error('Failed to initialize chunking queue', {
        error: error instanceof Error ? error.message : String(error),
        queueName: this.queue.name,
      });
      throw error;
    }
  }

  /**
   * Add a chunking job to the queue
   */
  public async addChunkingJob(
    jobData: ChunkingJobData,
    options: JobsOptions = {},
    traceId: string
  ): Promise<Job<ChunkingJobData, ChunkingJobResult>> {
    const log = logger.withTrace(traceId);

    if (!this.isInitialized) {
      await this.initialize();
    }

    try {
      // Validate job data
      this.validateJobData(jobData);

      // Generate job ID for tracking
      const jobId = `chunking-${jobData.actionId}-${Date.now()}`;

      // Merge with default options
      const jobOptions: JobsOptions = {
        priority: 10, // High priority for chunking
        attempts: 3,
        backoff: { type: 'exponential' },
        removeOnComplete: 50,
        removeOnFail: 25,
        jobId,
        ...options,
      };

      log.info('Adding chunking job to queue', {
        actionId: jobData.actionId,
        accountId: jobData.accountId,
        filePath: jobData.filePath,
        fileSize: jobData.fileSize,
        entityType: jobData.entityType,
        estimatedEntityCount: jobData.estimatedEntityCount,
        jobId,
      });

      // Add job to queue
      const job = await this.queue.add('process-chunking', jobData, jobOptions);

      log.info('Chunking job added successfully', {
        actionId: jobData.actionId,
        jobId: job.id,
        priority: jobOptions.priority,
      });

      // Emit job added event
      this.emitJobEvent('started', job, traceId);

      return job;
    } catch (error) {
      log.error('Failed to add chunking job', {
        error: error instanceof Error ? error.message : String(error),
        actionId: jobData.actionId,
        accountId: jobData.accountId,
      });
      throw error;
    }
  }

  /**
   * Get job by ID
   */
  public async getJob(
    jobId: string,
    traceId: string
  ): Promise<Job<ChunkingJobData, ChunkingJobResult> | undefined> {
    try {
      const job = await this.queue.getJob(jobId);

      if (job) {
        logger.withTrace(traceId).debug('Retrieved chunking job', {
          jobId,
          actionId: job.data.actionId,
          status: await job.getState(),
        });
      }

      return job;
    } catch (error) {
      logger.withTrace(traceId).error('Failed to get chunking job', {
        error: error instanceof Error ? error.message : String(error),
        jobId,
      });
      throw error;
    }
  }

  /**
   * Cancel a job
   */
  public async cancelJob(jobId: string, traceId: string): Promise<boolean> {
    const log = logger.withTrace(traceId);

    try {
      const job = await this.queue.getJob(jobId);

      if (!job) {
        log.warn('Job not found for cancellation', { jobId });
        return false;
      }

      // Remove the job
      await job.remove();

      log.info('Chunking job cancelled successfully', {
        jobId,
        actionId: job.data.actionId,
      });

      return true;
    } catch (error) {
      log.error('Failed to cancel chunking job', {
        error: error instanceof Error ? error.message : String(error),
        jobId,
      });
      return false;
    }
  }

  /**
   * Get queue health metrics
   */
  public async getHealth(): Promise<QueueHealth> {
    try {
      const [waiting, active, completed, failed, delayed, stalled] = await Promise.all([
        this.queue.getWaiting(),
        this.queue.getActive(),
        this.queue.getCompleted(),
        this.queue.getFailed(),
        this.queue.getDelayed(),
        this.queue.getJobs(['paused']),
      ]);

      const health: QueueHealth = {
        name: this.queue.name,
        status: this.calculateHealthStatus(waiting, active, failed),

        jobCounts: {
          waiting: waiting.length,
          active: active.length,
          completed: completed.length,
          failed: failed.length,
          delayed: delayed.length,
          stalled: stalled.length,
        },

        performance: {
          throughput: this.healthMetrics?.performance?.throughput || 0,
          avgProcessingTime: this.healthMetrics?.performance?.avgProcessingTime || 0,
          failureRate:
            failed.length > 0 ? (failed.length / (completed.length + failed.length)) * 100 : 0,
        },

        workers: {
          active: this.healthMetrics?.workers?.active || 0,
          total: this.healthMetrics?.workers?.total || 0,
          memoryUsage: this.healthMetrics?.workers?.memoryUsage || 0,
        },

        lastUpdated: new Date().toISOString(),
      };

      return health;
    } catch (error) {
      logger.error('Failed to get queue health', {
        error: error instanceof Error ? error.message : String(error),
        queueName: this.queue.name,
      });

      return {
        name: this.queue.name,
        status: 'unhealthy',
        jobCounts: { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0, stalled: 0 },
        performance: { throughput: 0, avgProcessingTime: 0, failureRate: 100 },
        workers: { active: 0, total: 0, memoryUsage: 0 },
        lastUpdated: new Date().toISOString(),
      };
    }
  }

  /**
   * Cleanup old completed and failed jobs
   */
  public async cleanup(): Promise<void> {
    try {
      const now = Date.now();
      const oneHourAgo = now - 60 * 60 * 1000;
      const oneDayAgo = now - 24 * 60 * 60 * 1000;

      // Clean completed jobs older than 1 hour
      await this.queue.clean(oneHourAgo, 100, 'completed');

      // Clean failed jobs older than 1 day
      await this.queue.clean(oneDayAgo, 50, 'failed');

      logger.debug('Queue cleanup completed', {
        queueName: this.queue.name,
        oneHourAgo: new Date(oneHourAgo).toISOString(),
        oneDayAgo: new Date(oneDayAgo).toISOString(),
      });
    } catch (error) {
      logger.error('Queue cleanup failed', {
        error: error instanceof Error ? error.message : String(error),
        queueName: this.queue.name,
      });
    }
  }

  /**
   * Pause the queue
   */
  public async pause(): Promise<void> {
    await this.queue.pause();
    logger.info('Chunking queue paused', { queueName: this.queue.name });
  }

  /**
   * Resume the queue
   */
  public async resume(): Promise<void> {
    await this.queue.resume();
    logger.info('Chunking queue resumed', { queueName: this.queue.name });
  }

  /**
   * Close the queue and cleanup connections
   */
  public async close(): Promise<void> {
    try {
      await this.queue.close();
      await this.queueEvents.close();

      this.isInitialized = false;

      logger.info('Chunking queue closed successfully', {
        queueName: this.queue.name,
      });
    } catch (error) {
      logger.error('Failed to close chunking queue', {
        error: error instanceof Error ? error.message : String(error),
        queueName: this.queue.name,
      });
      throw error;
    }
  }

  /**
   * Setup event listeners for monitoring
   */
  // private setupEventListeners(): void {
  //   // Job progress events
  //   this.queueEvents.on('progress', (job, progress) => {
  //     logger.debug('Job progress update', {
  //       jobId: job.jobId,
  //       progress,
  //       queueName: this.queue.name,
  //     });

  //     this.emit('jobProgress', job.jobId, progress);
  //   });

  //   // Job completion events
  //   this.queueEvents.on('completed', (job, result) => {
  //     console.log('Job completed', job);
  //     const actiondId = (job.returnvalue as unknown as { actionId: string })?.actionId;
  //     logger.info('Job completed successfully', {
  //       jobId: job.jobId,
  //       actionId: actiondId,
  //       queueName: this.queue.name,
  //     });

  //     this.emitJobEvent(
  //       'completed',
  //       {
  //         ...job,
  //         id: job.jobId,
  //         actionId: actiondId,
  //         data: {
  //           actionId: actiondId,
  //           accountId: job.data.accountId,
  //         },
  //       },
  //       actiondId
  //     );
  //     this.updateThroughputMetrics();
  //   });

  //   // Job failure events
  //   this.queueEvents.on('failed', (job, err) => {
  //     const actiondId = (job.failedReason as unknown as { actionId: string })?.actionId;
  //     logger.error('Job failed', {
  //       jobId: job.jobId,
  //       actionId: actiondId,
  //       error: err,
  //       queueName: this.queue.name,
  //     });

  //     this.emitJobEvent('failed', job as any, (job as any).data?.traceId);
  //   });

  //   // Job stalled events
  //   this.queueEvents.on('stalled', job => {
  //     logger.warn('Job stalled', {
  //       jobId: job.jobId,
  //       actionId: (job as any)?.actionId,
  //       queueName: this.queue.name,
  //     });

  //     this.emitJobEvent('stalled', job as any, (job as any).data?.traceId);
  //   });

  //   // Connection events
  //   this.queueEvents.on('error', err => {
  //     logger.error('Queue events error', {
  //       error: err.message,
  //       queueName: this.queue.name,
  //     });
  //   });
  // }

  /**
   * Start health monitoring
   */
  private startHealthMonitoring(): void {
    // Update health metrics every 30 seconds
    setInterval(async () => {
      try {
        await this.updateHealthMetrics();
      } catch (error) {
        logger.error('Failed to update health metrics', {
          error: error instanceof Error ? error.message : String(error),
          queueName: this.queue.name,
        });
      }
    }, 30000);

    // Cleanup old jobs every hour
    setInterval(
      async () => {
        await this.cleanup();
      },
      60 * 60 * 1000
    );
  }

  /**
   * Validate job data before adding to queue
   */
  private validateJobData(jobData: ChunkingJobData): void {
    if (!jobData.actionId) {
      throw new Error('actionId is required');
    }

    if (!jobData.accountId) {
      throw new Error('accountId is required');
    }

    if (!jobData.filePath) {
      throw new Error('filePath is required');
    }

    if (!jobData.entityType) {
      throw new Error('entityType is required');
    }

    if (!jobData.actionType) {
      throw new Error('actionType is required');
    }

    if (jobData.fileSize <= 0) {
      throw new Error('fileSize must be greater than 0');
    }

    if (jobData.estimatedEntityCount < 0) {
      throw new Error('estimatedEntityCount cannot be negative');
    }
  }

  /**
   * Calculate queue health status
   */
  private calculateHealthStatus(
    waiting: any[],
    active: any[],
    failed: any[]
  ): 'healthy' | 'degraded' | 'unhealthy' {
    const totalJobs = waiting.length + active.length + failed.length;
    const failureRate = totalJobs > 0 ? (failed.length / totalJobs) * 100 : 0;
    const queueSize = waiting.length + active.length;

    if (failureRate > 50 || queueSize > 10000) {
      return 'unhealthy';
    } else if (failureRate > 20 || queueSize > 5000) {
      return 'degraded';
    } else {
      return 'healthy';
    }
  }

  /**
   * Update health metrics
   */
  private async updateHealthMetrics(): Promise<void> {
    // This would be implemented with actual metrics collection
    // For now, we'll use placeholder values
    this.healthMetrics = {
      performance: {
        throughput: 0, // Jobs per minute - would be calculated from job completion events
        avgProcessingTime: 0, // Average processing time - would be calculated from job timing
        failureRate: 0,
      },
      workers: {
        total: 0, // Would be tracked from worker registrations
        active: 0,
        memoryUsage: 0, // Memory usage in MB - would be tracked from worker stats
      },
    };
  }

  /**
   * Update throughput metrics
   */
  private updateThroughputMetrics(): void {
    // Implementation would track job completion rates
    // This is a placeholder for the actual metrics collection
  }

  /**
   * Emit job event for external monitoring
   */
  private emitJobEvent(
    eventType: 'started' | 'completed' | 'failed' | 'stalled',
    job: Job<ChunkingJobData>,
    traceId?: string
  ): void {
    const event: JobEvent = {
      jobId: job.id || 'unknown',
      actionId: job.data.actionId,
      accountId: job.data.accountId,
      eventType,
      timestamp: new Date().toISOString(),
      data: job.returnvalue || {
        stage: 'starting',
        percentage: 0,
        processedRecords: 0,
        totalRecords: 0,
        message: eventType,
        timestamp: new Date().toISOString(),
      },
      traceId: traceId || job.data.traceId,
    };

    this.emit('jobEvent', event);
  }

  /**
   * Get the underlying BullMQ queue instance
   */
  public getQueue(): Queue<ChunkingJobData, ChunkingJobResult> {
    return this.queue;
  }

  /**
   * Get queue events instance
   */
  public getQueueEvents(): QueueEvents {
    return this.queueEvents;
  }
}

// Export singleton instance
const chunkingQueue = new ChunkingQueue();
export default chunkingQueue;
