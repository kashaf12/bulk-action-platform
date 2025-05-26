/**
 * Processing Queue Implementation
 * Manages the BullMQ queue for processing jobs (individual chunk processing)
 */

import { Queue, QueueEvents, Job, JobsOptions, RedisOptions } from 'bullmq';
import {
  ProcessingJobData,
  ProcessingJobResult,
  ProcessingJobOptions,
  JobEvent,
  QueueHealth,
} from './types/ChunkingJob';
import queueConfigManager from './config/queueConfig';
import { logger } from '../utils/logger';
import { EventEmitter } from 'events';

export class ProcessingQueue extends EventEmitter {
  private queue: Queue<ProcessingJobData, ProcessingJobResult>;
  private queueEvents: QueueEvents;
  private isInitialized = false;
  private healthMetrics: Partial<QueueHealth> = {};

  constructor() {
    super();

    const config = queueConfigManager.getProcessingQueueConfig();

    // Initialize BullMQ queue
    this.queue = new Queue<ProcessingJobData, ProcessingJobResult>(config.name, {
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

      logger.info('Processing queue initialized successfully', {
        queueName: this.queue.name,
        redisHost: (queueConfigManager.getConnectionOptions() as RedisOptions).host,
      });

      // Emit initialization event
      this.emit('initialized');
    } catch (error) {
      logger.error('Failed to initialize processing queue', {
        error: error instanceof Error ? error.message : String(error),
        queueName: this.queue.name,
      });
      throw error;
    }
  }

  /**
   * Add a processing job to the queue
   */
  public async addProcessingJob(
    jobData: ProcessingJobData,
    options: JobsOptions = {},
    traceId: string
  ): Promise<Job<ProcessingJobData, ProcessingJobResult>> {
    const log = logger.withTrace(traceId);

    if (!this.isInitialized) {
      await this.initialize();
    }

    try {
      // Validate job data
      this.validateJobData(jobData);

      // Generate job ID for tracking
      const jobId = `processing-${jobData.actionId}-${jobData.chunkId}-${Date.now()}`;

      // Merge with default options
      const jobOptions: JobsOptions = {
        priority: 5, // Lower priority than chunking
        attempts: 5, // More retries for database operations
        backoff: { type: 'exponential' },
        removeOnComplete: 100,
        removeOnFail: 50,
        // timeout: 300000, // 5 minutes timeout
        jobId,
        ...options,
      };

      log.info('Adding processing job to queue', {
        actionId: jobData.actionId,
        chunkId: jobData.chunkId,
        chunkPath: jobData.chunkPath,
        recordCount: jobData.recordCount,
        chunkIndex: jobData.chunkIndex,
        totalChunks: jobData.totalChunks,
        jobId,
      });

      // Add job to queue
      const job = await this.queue.add('process-chunk', jobData, jobOptions);

      log.info('Processing job added successfully', {
        actionId: jobData.actionId,
        chunkId: jobData.chunkId,
        jobId: job.id,
        priority: jobOptions.priority,
        chunkIndex: jobData.chunkIndex,
      });

      // Emit job added event
      this.emitJobEvent('started', job, traceId);

      return job;
    } catch (error) {
      log.error('Failed to add processing job', {
        error: error instanceof Error ? error.message : String(error),
        actionId: jobData.actionId,
        chunkId: jobData.chunkId,
      });
      throw error;
    }
  }

  /**
   * Add multiple processing jobs (batch)
   */
  public async addProcessingJobs(
    jobsData: Array<{ data: ProcessingJobData; options?: JobsOptions }>,
    traceId: string
  ): Promise<Job<ProcessingJobData, ProcessingJobResult>[]> {
    const log = logger.withTrace(traceId);

    if (!this.isInitialized) {
      await this.initialize();
    }

    if (jobsData.length === 0) {
      return [];
    }

    try {
      log.info('Adding batch processing jobs to queue', {
        jobCount: jobsData.length,
        actionIds: [...new Set(jobsData.map(j => j.data.actionId))],
      });

      // Prepare bulk job data
      const bulkJobs = jobsData.map(({ data, options = {} }, index) => {
        this.validateJobData(data);

        const jobId = `processing-${data.actionId}-${data.chunkId}-${Date.now()}-${index}`;
        const jobOptions: JobsOptions = {
          priority: 5,
          attempts: 5,
          backoff: { type: 'exponential' },
          removeOnComplete: 100,
          removeOnFail: 50,
          // timeout: 300000,

          jobId,
          ...options,
        };

        return {
          name: 'process-chunk',
          data,
          opts: jobOptions,
        };
      });

      // Add jobs in bulk
      const jobs = await this.queue.addBulk(bulkJobs);

      log.info('Batch processing jobs added successfully', {
        jobCount: jobs.length,
        successfulJobs: jobs.filter(j => j.id).length,
        failedJobs: jobs.filter(j => !j.id).length,
      });

      // Emit events for successful jobs
      jobs.forEach(job => {
        if (job.id) {
          this.emitJobEvent('started', job as any, traceId);
        }
      });

      return jobs as Job<ProcessingJobData, ProcessingJobResult>[];
    } catch (error) {
      log.error('Failed to add batch processing jobs', {
        error: error instanceof Error ? error.message : String(error),
        jobCount: jobsData.length,
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
  ): Promise<Job<ProcessingJobData, ProcessingJobResult> | undefined> {
    try {
      const job = await this.queue.getJob(jobId);

      if (job) {
        logger.withTrace(traceId).debug('Retrieved processing job', {
          jobId,
          actionId: job.data.actionId,
          chunkId: job.data.chunkId,
          status: await job.getState(),
        });
      }

      return job;
    } catch (error) {
      logger.withTrace(traceId).error('Failed to get processing job', {
        error: error instanceof Error ? error.message : String(error),
        jobId,
      });
      throw error;
    }
  }

  /**
   * Get jobs by action ID
   */
  public async getJobsByActionId(
    actionId: string,
    traceId: string
  ): Promise<Job<ProcessingJobData, ProcessingJobResult>[]> {
    const log = logger.withTrace(traceId);

    try {
      // Get jobs from different states
      const [waiting, active, completed, failed] = await Promise.all([
        this.queue.getWaiting(),
        this.queue.getActive(),
        this.queue.getCompleted(),
        this.queue.getFailed(),
      ]);

      // Filter jobs by action ID
      const allJobs = [...waiting, ...active, ...completed, ...failed];
      const actionJobs = allJobs.filter(job => job.data.actionId === actionId);

      log.debug('Retrieved processing jobs by action ID', {
        actionId,
        totalJobs: actionJobs.length,
        waiting: actionJobs.filter(j => waiting.includes(j)).length,
        active: actionJobs.filter(j => active.includes(j)).length,
        completed: actionJobs.filter(j => completed.includes(j)).length,
        failed: actionJobs.filter(j => failed.includes(j)).length,
      });

      return actionJobs as Job<ProcessingJobData, ProcessingJobResult>[];
    } catch (error) {
      log.error('Failed to get processing jobs by action ID', {
        error: error instanceof Error ? error.message : String(error),
        actionId,
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

      log.info('Processing job cancelled successfully', {
        jobId,
        actionId: job.data.actionId,
        chunkId: job.data.chunkId,
      });

      return true;
    } catch (error) {
      log.error('Failed to cancel processing job', {
        error: error instanceof Error ? error.message : String(error),
        jobId,
      });
      return false;
    }
  }

  /**
   * Cancel all jobs for an action
   */
  public async cancelJobsByActionId(actionId: string, traceId: string): Promise<number> {
    const log = logger.withTrace(traceId);

    try {
      const jobs = await this.getJobsByActionId(actionId, traceId);
      let cancelledCount = 0;

      for (const job of jobs) {
        try {
          const state = await job.getState();
          if (['waiting', 'delayed'].includes(state)) {
            await job.remove();
            cancelledCount++;
          }
        } catch (error) {
          log.warn('Failed to cancel individual job', {
            jobId: job.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      log.info('Processing jobs cancelled by action ID', {
        actionId,
        totalJobs: jobs.length,
        cancelledJobs: cancelledCount,
      });

      return cancelledCount;
    } catch (error) {
      log.error('Failed to cancel processing jobs by action ID', {
        error: error instanceof Error ? error.message : String(error),
        actionId,
      });
      return 0;
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
          throughput: this.healthMetrics.performance?.throughput || 0,
          avgProcessingTime: this.healthMetrics.performance?.avgProcessingTime || 0,
          failureRate:
            failed.length > 0 ? (failed.length / (completed.length + failed.length)) * 100 : 0,
        },

        workers: {
          active: this.healthMetrics.workers?.active || 0,
          total: this.healthMetrics.workers?.total || 0,
          memoryUsage: this.healthMetrics.workers?.memoryUsage || 0,
        },

        lastUpdated: new Date().toISOString(),
      };

      return health;
    } catch (error) {
      logger.error('Failed to get processing queue health', {
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
      const sixHoursAgo = now - 6 * 60 * 60 * 1000;

      // Clean completed jobs older than 1 hour
      await this.queue.clean(oneHourAgo, 200, 'completed');

      // Clean failed jobs older than 6 hours
      await this.queue.clean(sixHoursAgo, 100, 'failed');

      logger.debug('Processing queue cleanup completed', {
        queueName: this.queue.name,
        oneHourAgo: new Date(oneHourAgo).toISOString(),
        sixHoursAgo: new Date(sixHoursAgo).toISOString(),
      });
    } catch (error) {
      logger.error('Processing queue cleanup failed', {
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
    logger.info('Processing queue paused', { queueName: this.queue.name });
  }

  /**
   * Resume the queue
   */
  public async resume(): Promise<void> {
    await this.queue.resume();
    logger.info('Processing queue resumed', { queueName: this.queue.name });
  }

  /**
   * Close the queue and cleanup connections
   */
  public async close(): Promise<void> {
    try {
      await this.queue.close();
      await this.queueEvents.close();

      this.isInitialized = false;

      logger.info('Processing queue closed successfully', {
        queueName: this.queue.name,
      });
    } catch (error) {
      logger.error('Failed to close processing queue', {
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
  //     logger.debug('Processing job progress update', {
  //       jobId: job.jobId,
  //       progress,
  //       queueName: this.queue.name,
  //     });

  //     this.emit('jobProgress', job.jobId, progress);
  //   });

  //   // Job completion events
  //   this.queueEvents.on('completed', (job, result) => {
  //     logger.info('Processing job completed successfully', {
  //       jobId: job.jobId,
  //       actionId: job.returnvalue?.actionId,
  //       chunkId: job.returnvalue?.chunkId,
  //       success: job?.returnvalue?.success,
  //       queueName: this.queue.name,
  //     });

  //     this.emitJobEvent('completed', job as any, job.returnvalue?.traceId);
  //     this.updateThroughputMetrics();
  //   });

  //   // Job failure events
  //   this.queueEvents.on('failed', (job, err) => {
  //     logger.error('Processing job failed', {
  //       jobId: job.jobId,
  //       actionId: job.data?.actionId,
  //       chunkId: job.data?.chunkId,
  //       error: err.message,
  //       queueName: this.queue.name,
  //     });

  //     this.emitJobEvent('failed', job as any, job.data?.traceId);
  //   });

  //   // Job stalled events
  //   this.queueEvents.on('stalled', job => {
  //     logger.warn('Processing job stalled', {
  //       jobId: job.id,
  //       actionId: job.data?.actionId,
  //       chunkId: job.data?.chunkId,
  //       queueName: this.queue.name,
  //     });

  //     this.emitJobEvent('stalled', job as any, job.data?.traceId);
  //   });

  //   // Connection events
  //   this.queueEvents.on('error', err => {
  //     logger.error('Processing queue events error', {
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
        logger.error('Failed to update processing queue health metrics', {
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
  private validateJobData(jobData: ProcessingJobData): void {
    if (!jobData.actionId) {
      throw new Error('actionId is required');
    }

    if (!jobData.accountId) {
      throw new Error('accountId is required');
    }

    if (!jobData.chunkId) {
      throw new Error('chunkId is required');
    }

    if (!jobData.chunkPath) {
      throw new Error('chunkPath is required');
    }

    if (!jobData.entityType) {
      throw new Error('entityType is required');
    }

    if (!jobData.actionType) {
      throw new Error('actionType is required');
    }

    if (jobData.recordCount < 0) {
      throw new Error('recordCount cannot be negative');
    }

    if (jobData.chunkIndex < 0) {
      throw new Error('chunkIndex cannot be negative');
    }

    if (jobData.totalChunks < 1) {
      throw new Error('totalChunks must be at least 1');
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

    if (failureRate > 50 || queueSize > 50000) {
      return 'unhealthy';
    } else if (failureRate > 20 || queueSize > 10000) {
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
        active: 0, // Would be tracked from worker registrations
        total: 0, // Would be tracked from worker registrations
        memoryUsage: 0, // Would be collected from worker health reports
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
    job: Job<ProcessingJobData>,
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
  public getQueue(): Queue<ProcessingJobData, ProcessingJobResult> {
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
const processingQueue = new ProcessingQueue();
export default processingQueue;
