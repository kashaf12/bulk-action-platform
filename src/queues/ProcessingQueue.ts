/**
 * Processing Queue Implementation with Partition Support
 * Manages multiple BullMQ queues for processing jobs with partition-based routing
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
import configManager from '../config/app';

export class ProcessingQueue extends EventEmitter {
  private queues: Map<number, Queue<ProcessingJobData, ProcessingJobResult>> = new Map();
  private queueEvents: Map<number, QueueEvents> = new Map();
  private isInitialized = false;
  private healthMetrics: Partial<QueueHealth> = {};
  private partitionCount: number;

  constructor() {
    super();

    // Get partition count from environment
    this.partitionCount = parseInt(process.env.PROCESSING_WORKER_COUNT || '5');

    logger.info('Initializing ProcessingQueue with partitions', {
      partitionCount: this.partitionCount,
    });
  }

  /**
   * Initialize all partition queues and validate connections
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

      const config = queueConfigManager.getProcessingQueueConfig();

      // Initialize queue for each partition
      for (let partitionId = 0; partitionId < this.partitionCount; partitionId++) {
        const queueName = `bulk-action-processing-partition-${partitionId}`;

        // Create queue instance
        const queue = new Queue<ProcessingJobData, ProcessingJobResult>(queueName, {
          connection: config.connection,
          defaultJobOptions: config.defaultJobOptions,
        });

        // Create queue events instance
        const queueEvents = new QueueEvents(queueName, {
          connection: config.connection,
        });

        // Wait for queue to be ready
        await queue.waitUntilReady();
        await queueEvents.waitUntilReady();

        this.queues.set(partitionId, queue);
        this.queueEvents.set(partitionId, queueEvents);

        logger.debug('Partition queue initialized', {
          partitionId,
          queueName,
        });
      }

      this.isInitialized = true;

      logger.info('All processing partition queues initialized successfully', {
        partitionCount: this.partitionCount,
        queueNames: Array.from(this.queues.values()).map(q => q.name),
        redisHost: (queueConfigManager.getConnectionOptions() as RedisOptions).host,
      });

      // Emit initialization event
      this.emit('initialized');
    } catch (error) {
      logger.error('Failed to initialize processing queues', {
        error: error instanceof Error ? error.message : String(error),
        partitionCount: this.partitionCount,
      });
      throw error;
    }
  }

  /**
   * Add a processing job to specific partition queue
   */
  public async addProcessingJobToPartition(
    partitionId: number,
    jobData: ProcessingJobData,
    options: JobsOptions = {},
    traceId: string
  ): Promise<Job<ProcessingJobData, ProcessingJobResult>> {
    const log = logger.withTrace(traceId);

    if (!this.isInitialized) {
      await this.initialize();
    }

    if (partitionId < 0 || partitionId >= this.partitionCount) {
      throw new Error(
        `Invalid partition ID: ${partitionId}. Must be between 0 and ${this.partitionCount - 1}`
      );
    }

    const queue = this.queues.get(partitionId);
    if (!queue) {
      throw new Error(`Queue not found for partition: ${partitionId}`);
    }

    try {
      // Validate job data
      this.validateJobData(jobData);

      // Generate job ID for tracking
      const jobId = `processing-${jobData.actionId}-${jobData.chunkId}-p${partitionId}-${Date.now()}`;

      // Merge with default options
      const jobOptions: JobsOptions = {
        priority: 5, // Lower priority than chunking
        attempts: 5, // More retries for database operations
        backoff: { type: 'exponential' },
        removeOnComplete: 100,
        removeOnFail: 50,
        jobId,
        ...options,
      };

      log.info('Adding processing job to partition queue', {
        actionId: jobData.actionId,
        chunkId: jobData.chunkId,
        chunkPath: jobData.chunkPath,
        recordCount: jobData.recordCount,
        chunkIndex: jobData.chunkIndex,
        totalChunks: jobData.totalChunks,
        partitionId,
        queueName: queue.name,
        jobId,
      });

      // Add job to specific partition queue
      const job = await queue.add('process-chunk', jobData, jobOptions);

      log.info('Processing job added to partition successfully', {
        actionId: jobData.actionId,
        chunkId: jobData.chunkId,
        jobId: job.id,
        partitionId,
        queueName: queue.name,
        priority: jobOptions.priority,
        chunkIndex: jobData.chunkIndex,
      });

      // Emit job added event
      this.emitJobEvent('started', job, partitionId, traceId);

      return job;
    } catch (error) {
      log.error('Failed to add processing job to partition', {
        error: error instanceof Error ? error.message : String(error),
        actionId: jobData.actionId,
        chunkId: jobData.chunkId,
        partitionId,
      });
      throw error;
    }
  }

  /**
   * Add multiple processing jobs with automatic partition routing
   */
  public async addProcessingJobsWithPartitioning(
    jobsData: Array<{
      data: ProcessingJobData;
      partitionId: number;
      options?: JobsOptions;
    }>,
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
      log.info('Adding batch processing jobs with partitioning', {
        jobCount: jobsData.length,
        actionIds: [...new Set(jobsData.map(j => j.data.actionId))],
        partitions: [...new Set(jobsData.map(j => j.partitionId))],
      });

      // Group jobs by partition for efficient bulk operations
      const jobsByPartition = new Map<
        number,
        Array<{ data: ProcessingJobData; options?: JobsOptions }>
      >();

      for (const jobEntry of jobsData) {
        if (!jobsByPartition.has(jobEntry.partitionId)) {
          jobsByPartition.set(jobEntry.partitionId, []);
        }
        jobsByPartition.get(jobEntry.partitionId)!.push({
          data: jobEntry.data,
          options: jobEntry.options,
        });
      }

      // Add jobs to each partition in parallel
      const addPromises: Promise<Job<ProcessingJobData, ProcessingJobResult>[]>[] = [];

      for (const [partitionId, partitionJobs] of jobsByPartition) {
        const promise = this.addJobsToSinglePartition(partitionId, partitionJobs, traceId);
        addPromises.push(promise);
      }

      const results = await Promise.all(addPromises);
      const allJobs = results.flat();

      log.info('Batch processing jobs added with partitioning successfully', {
        totalJobs: allJobs.length,
        partitionsUsed: jobsByPartition.size,
        successfulJobs: allJobs.filter(j => j.id).length,
      });

      return allJobs;
    } catch (error) {
      log.error('Failed to add batch processing jobs with partitioning', {
        error: error instanceof Error ? error.message : String(error),
        jobCount: jobsData.length,
      });
      throw error;
    }
  }

  /**
   * Get queue instance for specific partition (for worker binding)
   */
  public getPartitionQueue(partitionId: number): Queue<ProcessingJobData, ProcessingJobResult> {
    if (partitionId < 0 || partitionId >= this.partitionCount) {
      throw new Error(
        `Invalid partition ID: ${partitionId}. Must be between 0 and ${this.partitionCount - 1}`
      );
    }

    const queue = this.queues.get(partitionId);
    if (!queue) {
      throw new Error(`Queue not found for partition: ${partitionId}`);
    }

    return queue;
  }

  /**
   * Get queue events instance for specific partition
   */
  public getPartitionQueueEvents(partitionId: number): QueueEvents {
    if (partitionId < 0 || partitionId >= this.partitionCount) {
      throw new Error(
        `Invalid partition ID: ${partitionId}. Must be between 0 and ${this.partitionCount - 1}`
      );
    }

    const queueEvents = this.queueEvents.get(partitionId);
    if (!queueEvents) {
      throw new Error(`Queue events not found for partition: ${partitionId}`);
    }

    return queueEvents;
  }

  /**
   * Get job by ID from specific partition
   */
  public async getJobFromPartition(
    partitionId: number,
    jobId: string,
    traceId: string
  ): Promise<Job<ProcessingJobData, ProcessingJobResult> | undefined> {
    try {
      const queue = this.getPartitionQueue(partitionId);
      const job = await queue.getJob(jobId);

      if (job) {
        logger.withTrace(traceId).debug('Retrieved processing job from partition', {
          jobId,
          partitionId,
          actionId: job.data.actionId,
          chunkId: job.data.chunkId,
          status: await job.getState(),
        });
      }

      return job;
    } catch (error) {
      logger.withTrace(traceId).error('Failed to get processing job from partition', {
        error: error instanceof Error ? error.message : String(error),
        jobId,
        partitionId,
      });
      throw error;
    }
  }

  /**
   * Get jobs by action ID across all partitions
   */
  public async getJobsByActionId(
    actionId: string,
    traceId: string
  ): Promise<Job<ProcessingJobData, ProcessingJobResult>[]> {
    const log = logger.withTrace(traceId);

    try {
      const allJobs: Job<ProcessingJobData, ProcessingJobResult>[] = [];

      // Search across all partitions
      for (let partitionId = 0; partitionId < this.partitionCount; partitionId++) {
        const queue = this.queues.get(partitionId)!;

        // Get jobs from different states
        const [waiting, active, completed, failed] = await Promise.all([
          queue.getWaiting(),
          queue.getActive(),
          queue.getCompleted(),
          queue.getFailed(),
        ]);

        // Filter jobs by action ID
        const partitionJobs = [...waiting, ...active, ...completed, ...failed];
        const actionJobs = partitionJobs.filter(job => job.data.actionId === actionId);

        allJobs.push(...(actionJobs as Job<ProcessingJobData, ProcessingJobResult>[]));
      }

      log.debug('Retrieved processing jobs by action ID across partitions', {
        actionId,
        totalJobs: allJobs.length,
        partitionsSearched: this.partitionCount,
      });

      return allJobs;
    } catch (error) {
      log.error('Failed to get processing jobs by action ID', {
        error: error instanceof Error ? error.message : String(error),
        actionId,
      });
      throw error;
    }
  }

  /**
   * Cancel all jobs for an action across all partitions
   */
  public async cancelJobsByActionId(actionId: string, traceId: string): Promise<number> {
    const log = logger.withTrace(traceId);

    try {
      let totalCancelled = 0;

      // Cancel jobs in each partition
      for (let partitionId = 0; partitionId < this.partitionCount; partitionId++) {
        const jobs = await this.getJobsByActionIdInPartition(actionId, partitionId, traceId);

        for (const job of jobs) {
          try {
            const state = await job.getState();
            if (['waiting', 'delayed'].includes(state)) {
              await job.remove();
              totalCancelled++;
            }
          } catch (error) {
            log.warn('Failed to cancel individual job', {
              jobId: job.id,
              partitionId,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      }

      log.info('Processing jobs cancelled by action ID across partitions', {
        actionId,
        cancelledJobs: totalCancelled,
        partitionsSearched: this.partitionCount,
      });

      return totalCancelled;
    } catch (error) {
      log.error('Failed to cancel processing jobs by action ID', {
        error: error instanceof Error ? error.message : String(error),
        actionId,
      });
      return 0;
    }
  }

  /**
   * Get aggregated health metrics across all partitions
   */
  public async getHealth(): Promise<QueueHealth> {
    try {
      let totalWaiting = 0,
        totalActive = 0,
        totalCompleted = 0,
        totalFailed = 0,
        totalDelayed = 0,
        totalStalled = 0;

      // Aggregate metrics from all partitions
      for (let partitionId = 0; partitionId < this.partitionCount; partitionId++) {
        const queue = this.queues.get(partitionId)!;

        const [waiting, active, completed, failed, delayed, stalled] = await Promise.all([
          queue.getWaiting(),
          queue.getActive(),
          queue.getCompleted(),
          queue.getFailed(),
          queue.getDelayed(),
          queue.getJobs(['paused']),
        ]);

        totalWaiting += waiting.length;
        totalActive += active.length;
        totalCompleted += completed.length;
        totalFailed += failed.length;
        totalDelayed += delayed.length;
        totalStalled += stalled.length;
      }

      const health: QueueHealth = {
        name: `processing-partitioned-${this.partitionCount}`,
        status: this.calculateHealthStatus(totalWaiting, totalActive, totalFailed),

        jobCounts: {
          waiting: totalWaiting,
          active: totalActive,
          completed: totalCompleted,
          failed: totalFailed,
          delayed: totalDelayed,
          stalled: totalStalled,
        },

        performance: {
          throughput: this.healthMetrics.performance?.throughput || 0,
          avgProcessingTime: this.healthMetrics.performance?.avgProcessingTime || 0,
          failureRate: totalFailed > 0 ? (totalFailed / (totalCompleted + totalFailed)) * 100 : 0,
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
        partitionCount: this.partitionCount,
      });

      return {
        name: `processing-partitioned-${this.partitionCount}`,
        status: 'unhealthy',
        jobCounts: { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0, stalled: 0 },
        performance: { throughput: 0, avgProcessingTime: 0, failureRate: 100 },
        workers: { active: 0, total: 0, memoryUsage: 0 },
        lastUpdated: new Date().toISOString(),
      };
    }
  }

  /**
   * Cleanup old completed and failed jobs across all partitions
   */
  public async cleanup(): Promise<void> {
    try {
      const now = Date.now();
      const oneHourAgo = now - 60 * 60 * 1000;
      const sixHoursAgo = now - 6 * 60 * 60 * 1000;

      // Clean jobs in all partitions
      for (let partitionId = 0; partitionId < this.partitionCount; partitionId++) {
        const queue = this.queues.get(partitionId)!;

        // Clean completed jobs older than 1 hour
        await queue.clean(oneHourAgo, 200, 'completed');

        // Clean failed jobs older than 6 hours
        await queue.clean(sixHoursAgo, 100, 'failed');
      }

      logger.debug('Processing queues cleanup completed', {
        partitionCount: this.partitionCount,
        oneHourAgo: new Date(oneHourAgo).toISOString(),
        sixHoursAgo: new Date(sixHoursAgo).toISOString(),
      });
    } catch (error) {
      logger.error('Processing queues cleanup failed', {
        error: error instanceof Error ? error.message : String(error),
        partitionCount: this.partitionCount,
      });
    }
  }

  /**
   * Pause all partition queues
   */
  public async pause(): Promise<void> {
    for (const queue of this.queues.values()) {
      await queue.pause();
    }
    logger.info('All processing partition queues paused', {
      partitionCount: this.partitionCount,
    });
  }

  /**
   * Resume all partition queues
   */
  public async resume(): Promise<void> {
    for (const queue of this.queues.values()) {
      await queue.resume();
    }
    logger.info('All processing partition queues resumed', {
      partitionCount: this.partitionCount,
    });
  }

  /**
   * Close all queues and cleanup connections
   */
  public async close(): Promise<void> {
    try {
      // Close all queues
      const closePromises: Promise<void>[] = [];

      for (const queue of this.queues.values()) {
        closePromises.push(queue.close());
      }

      for (const queueEvents of this.queueEvents.values()) {
        closePromises.push(queueEvents.close());
      }

      await Promise.all(closePromises);

      this.queues.clear();
      this.queueEvents.clear();
      this.isInitialized = false;

      logger.info('All processing partition queues closed successfully', {
        partitionCount: this.partitionCount,
      });
    } catch (error) {
      logger.error('Failed to close processing queues', {
        error: error instanceof Error ? error.message : String(error),
        partitionCount: this.partitionCount,
      });
      throw error;
    }
  }

  // Private helper methods...

  /**
   * Add jobs to a single partition using bulk operations
   */
  private async addJobsToSinglePartition(
    partitionId: number,
    jobsData: Array<{ data: ProcessingJobData; options?: JobsOptions }>,
    traceId: string
  ): Promise<Job<ProcessingJobData, ProcessingJobResult>[]> {
    const queue = this.getPartitionQueue(partitionId);
    const log = logger.withTrace(traceId);

    if (jobsData.length === 0) {
      return [];
    }

    try {
      // Prepare bulk job data
      const bulkJobs = jobsData.map(({ data, options = {} }, index) => {
        this.validateJobData(data);

        const jobId = `processing-${data.actionId}-${data.chunkId}-p${partitionId}-${Date.now()}-${index}`;
        const jobOptions: JobsOptions = {
          priority: 5,
          attempts: 5,
          backoff: { type: 'exponential' },
          removeOnComplete: 100,
          removeOnFail: 50,
          jobId,
          ...options,
        };

        return {
          name: 'process-chunk',
          data,
          opts: jobOptions,
        };
      });

      // Add jobs in bulk to this partition
      const jobs = await queue.addBulk(bulkJobs);

      log.info('Bulk processing jobs added to partition successfully', {
        partitionId,
        queueName: queue.name,
        jobCount: jobs.length,
        successfulJobs: jobs.filter(j => j.id).length,
        failedJobs: jobs.filter(j => !j.id).length,
      });

      // Emit events for successful jobs
      jobs.forEach(job => {
        if (job.id) {
          this.emitJobEvent('started', job as any, partitionId, traceId);
        }
      });

      return jobs as Job<ProcessingJobData, ProcessingJobResult>[];
    } catch (error) {
      log.error('Failed to add bulk processing jobs to partition', {
        error: error instanceof Error ? error.message : String(error),
        partitionId,
        jobCount: jobsData.length,
      });
      throw error;
    }
  }

  /**
   * Get jobs by action ID in specific partition
   */
  private async getJobsByActionIdInPartition(
    actionId: string,
    partitionId: number,
    traceId: string
  ): Promise<Job<ProcessingJobData, ProcessingJobResult>[]> {
    const queue = this.getPartitionQueue(partitionId);

    // Get jobs from different states
    const [waiting, active, completed, failed] = await Promise.all([
      queue.getWaiting(),
      queue.getActive(),
      queue.getCompleted(),
      queue.getFailed(),
    ]);

    // Filter jobs by action ID
    const allJobs = [...waiting, ...active, ...completed, ...failed];
    return allJobs.filter(job => job.data.actionId === actionId) as Job<
      ProcessingJobData,
      ProcessingJobResult
    >[];
  }

  /**
   * Validate job data before adding to queue
   */
  private validateJobData(data: ProcessingJobData): void {
    if (!data.actionId) {
      throw new Error('actionId is required');
    }

    if (!data.accountId) {
      throw new Error('accountId is required');
    }

    if (!data.chunkId) {
      throw new Error('chunkId is required');
    }

    if (!data.chunkPath) {
      throw new Error('chunkPath is required');
    }

    if (!data.entityType) {
      throw new Error('entityType is required');
    }

    if (!data.actionType) {
      throw new Error('actionType is required');
    }

    if (data.recordCount < 0) {
      throw new Error('recordCount cannot be negative');
    }

    if (data.chunkIndex < 0) {
      throw new Error('chunkIndex cannot be negative');
    }

    if (data.totalChunks < 1) {
      throw new Error('totalChunks must be at least 1');
    }
  }

  /**
   * Calculate queue health status
   */
  private calculateHealthStatus(
    waiting: number,
    active: number,
    failed: number
  ): 'healthy' | 'degraded' | 'unhealthy' {
    const totalJobs = waiting + active + failed;
    const failureRate = totalJobs > 0 ? (failed / totalJobs) * 100 : 0;
    const queueSize = waiting + active;

    if (failureRate > 50 || queueSize > 50000) {
      return 'unhealthy';
    } else if (failureRate > 20 || queueSize > 10000) {
      return 'degraded';
    } else {
      return 'healthy';
    }
  }

  /**
   * Emit job event for external monitoring
   */
  private emitJobEvent(
    eventType: 'started' | 'completed' | 'failed' | 'stalled',
    job: Job<ProcessingJobData>,
    partitionId: number,
    traceId?: string
  ): void {
    const event: JobEvent & { partitionId: number } = {
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
      partitionId,
    };

    this.emit('jobEvent', event);
  }

  /**
   * Get partition count
   */
  public getPartitionCount(): number {
    return this.partitionCount;
  }

  /**
   * Get all queue instances (for monitoring/debugging)
   */
  public getAllQueues(): Map<number, Queue<ProcessingJobData, ProcessingJobResult>> {
    return new Map(this.queues);
  }
}

// Export singleton instance
const processingQueue = new ProcessingQueue();
export default processingQueue;
