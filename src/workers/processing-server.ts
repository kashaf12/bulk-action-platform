// Load environment variables
import dotenv from 'dotenv';
dotenv.config();

import { BaseWorkerServer, BaseWorkerServerConfig } from './shared/BaseWorkerServer';
import { Worker } from 'bullmq';
import { ProcessingJobData, ProcessingJobResult } from '../queues/types/ChunkingJob';
import { ProcessingQueue } from '../queues/ProcessingQueue';
import queueConfigManager from '../queues/config/queueConfig';
import { ContactService } from '../services/ContactService';
import { BulkActionService } from '../services/BulkActionService';
import { BulkActionStatService } from '../services/BulkActionStatService';
import { ContactRepository } from '../repositories/ContactRepository';
import { BulkActionRepository } from '../repositories/BulkActionRepository';
import { BulkActionStatRepository } from '../repositories/BulkActionStatRepository';
import { CSVStreamReader } from '../processors/csv/CSVStreamReader';
import { logger } from '../utils/logger';
import configManager from '../config/app';
import { v4 as uuidv4 } from 'uuid';
import os from 'os';

export interface ProcessingWorkerServerConfig extends BaseWorkerServerConfig {
  workerCount: number;
  maxMemoryPerWorker: number;
  totalMemoryLimit: number;
  concurrencyPerWorker: number;
  batchSize: number;
  jobTimeout: number;
  maxRestartAttempts: number;
}

export interface ProcessingWorkerInfo {
  id: string;
  status: 'idle' | 'processing' | 'error' | 'stopped';
  startTime: string;
  jobsProcessed: number;
  jobsSuccessful: number;
  jobsFailed: number;
  currentJob?: {
    id: string;
    actionId: string;
    chunkId: string;
    startTime: string;
  };
  memoryUsage: number;
  isHealthy: boolean;
}

export class ProcessingWorkerServer extends BaseWorkerServer {
  private processingQueue: ProcessingQueue | null = null;
  private workers: Map<string, { worker: Worker; info: ProcessingWorkerInfo }> = new Map();
  private processingWorkerConfig: ProcessingWorkerServerConfig;

  // Services
  private contactService!: ContactService;
  private bulkActionService!: BulkActionService;
  private bulkActionStatService!: BulkActionStatService;

  constructor(config?: Partial<ProcessingWorkerServerConfig>) {
    const defaultConfig = ProcessingWorkerServer.createDefaultConfig();
    const mergedConfig = { ...defaultConfig, ...config };

    super(mergedConfig);
    this.processingWorkerConfig = mergedConfig;

    // Initialize services
    this.initializeServices();
  }

  /**
   * Initialize processing-specific services
   */
  private initializeServices(): void {
    const contactRepository = new ContactRepository();
    const bulkActionRepository = new BulkActionRepository();
    const bulkActionStatRepository = new BulkActionStatRepository();

    this.contactService = new ContactService(contactRepository);
    this.bulkActionService = new BulkActionService(bulkActionRepository);
    this.bulkActionStatService = new BulkActionStatService(bulkActionStatRepository);
  }

  /**
   * Initialize processing-specific components
   */
  protected async initializeWorkerComponents(): Promise<void> {
    try {
      logger.info('Initializing processing worker components', {
        workerId: this.config.workerId,
        workerCount: this.processingWorkerConfig.workerCount,
        concurrencyPerWorker: this.processingWorkerConfig.concurrencyPerWorker,
      });

      // Initialize processing queue
      this.processingQueue = new ProcessingQueue();
      await this.processingQueue.initialize();
      logger.info('Processing queue initialized for worker processing');

      logger.info('Processing worker components initialized successfully');
    } catch (error) {
      logger.error('Failed to initialize processing worker components', {
        error: error instanceof Error ? error.message : String(error),
        workerId: this.config.workerId,
      });
      throw error;
    }
  }

  /**
   * Start processing workers
   */
  protected async startWorkers(): Promise<void> {
    if (!this.processingQueue) {
      throw new Error('Processing queue not initialized');
    }

    try {
      logger.info('Starting processing workers', {
        workerId: this.config.workerId,
        workerCount: this.processingWorkerConfig.workerCount,
        concurrencyPerWorker: this.processingWorkerConfig.concurrencyPerWorker,
      });

      // Start multiple processing workers
      const startPromises: Promise<void>[] = [];
      for (let i = 0; i < this.processingWorkerConfig.workerCount; i++) {
        startPromises.push(this.startSingleWorker(i));
      }

      await Promise.all(startPromises);

      logger.info('Processing workers started successfully', {
        workerId: this.config.workerId,
        totalWorkers: this.workers.size,
        healthyWorkers: this.getHealthyWorkerCount(),
      });
    } catch (error) {
      logger.error('Failed to start processing workers', {
        error: error instanceof Error ? error.message : String(error),
        workerId: this.config.workerId,
      });
      throw error;
    }
  }

  /**
   * Start a single processing worker
   */
  private async startSingleWorker(index: number): Promise<void> {
    const workerId = `${this.config.workerId}-worker-${index}`;
    const queueConfig = queueConfigManager.getProcessingQueueConfig();

    try {
      // Create worker info
      const workerInfo: ProcessingWorkerInfo = {
        id: workerId,
        status: 'idle',
        startTime: new Date().toISOString(),
        jobsProcessed: 0,
        jobsSuccessful: 0,
        jobsFailed: 0,
        memoryUsage: 0,
        isHealthy: true,
      };

      // Create BullMQ worker
      const worker = new Worker<ProcessingJobData, ProcessingJobResult>(
        queueConfig.name,
        this.createJobProcessor(workerId),
        {
          connection: queueConfig.connection,
          concurrency: this.processingWorkerConfig.concurrencyPerWorker,
          maxStalledCount: 3,
          stalledInterval: 30000,
          // removeOnComplete: 50,
          // removeOnFail: 25,
        }
      );

      // Setup worker event listeners
      this.setupWorkerEventListeners(workerId, worker, workerInfo);

      // Store worker
      this.workers.set(workerId, { worker, info: workerInfo });

      logger.info('Processing worker started', {
        workerId,
        index,
        concurrency: this.processingWorkerConfig.concurrencyPerWorker,
      });
    } catch (error) {
      logger.error('Failed to start processing worker', {
        error: error instanceof Error ? error.message : String(error),
        workerId,
        index,
      });
      throw error;
    }
  }

  /**
   * Create job processor function for a worker
   */
  private createJobProcessor(workerId: string) {
    return async (job: any): Promise<ProcessingJobResult> => {
      const startTime = Date.now();
      const workerEntry = this.workers.get(workerId);

      if (!workerEntry) {
        throw new Error(`Worker not found: ${workerId}`);
      }

      const { info: workerInfo } = workerEntry;

      // Update worker status
      workerInfo.status = 'processing';
      workerInfo.currentJob = {
        id: job.id || 'unknown',
        actionId: job.data.actionId,
        chunkId: job.data.chunkId,
        startTime: new Date().toISOString(),
      };

      const log = logger.withTrace(job.data.traceId);

      try {
        log.info('Starting processing job', {
          jobId: job.id,
          actionId: job.data.actionId,
          chunkId: job.data.chunkId,
          chunkPath: job.data.chunkPath,
          recordCount: job.data.recordCount,
          workerId,
        });

        // Process the chunk
        const result = await this.processChunk(job.data, job, log);

        // Update worker metrics
        workerInfo.jobsProcessed++;
        workerInfo.jobsSuccessful++;
        workerInfo.status = 'idle';
        workerInfo.currentJob = undefined;

        log.info('Processing job completed successfully', {
          jobId: job.id,
          actionId: job.data.actionId,
          chunkId: job.data.chunkId,
          recordsProcessed: result.processing.recordsProcessed,
          recordsSuccessful: result.processing.recordsSuccessful,
          processingTime: result.timing.durationMs,
          workerId,
        });

        this.emit('jobCompleted', { workerId, jobId: job.id, result });

        return result;
      } catch (error) {
        // Update worker metrics
        workerInfo.jobsFailed++;
        workerInfo.status = 'error';
        workerInfo.currentJob = undefined;

        const processingTime = Date.now() - startTime;

        log.error('Processing job failed', {
          error: error instanceof Error ? error.message : String(error),
          jobId: job.id,
          actionId: job.data.actionId,
          chunkId: job.data.chunkId,
          processingTime,
          workerId,
        });

        this.emit('jobFailed', { workerId, jobId: job.id, error });

        // Create failure result
        const failureResult: ProcessingJobResult = {
          success: false,
          actionId: job.data.actionId,
          chunkId: job.data.chunkId,
          processing: {
            recordsProcessed: 0,
            recordsSuccessful: 0,
            recordsFailed: 0,
            recordsSkipped: 0,
          },
          database: {
            operations: {
              inserts: 0,
              updates: 0,
              conflicts: 0,
              errors: 1,
            },
            timing: {
              connectionTime: 0,
              queryTime: 0,
              totalTime: processingTime,
            },
          },
          timing: {
            startedAt: new Date(startTime).toISOString(),
            completedAt: new Date().toISOString(),
            durationMs: processingTime,
            processingRate: 0,
          },
          error: {
            message: error instanceof Error ? error.message : String(error),
            retryable: this.isRetryableError(error),
          },
        };

        return failureResult;
      } finally {
        // Always reset worker status
        setTimeout(() => {
          workerInfo.status = 'idle';
          workerInfo.currentJob = undefined;
        }, 1000);
      }
    };
  }

  /**
   * Process a single chunk
   */
  private async processChunk(
    jobData: ProcessingJobData,
    job: any,
    log: any
  ): Promise<ProcessingJobResult> {
    const startTime = Date.now();

    try {
      // Read chunk CSV from MinIO
      const csvReader = new CSVStreamReader({
        maxFileSize: 50 * 1024 * 1024, // 50MB max for chunks
        maxRowSize: 1024 * 1024, // 1MB max row size
        encoding: 'utf8',
      });

      const contacts: any[] = [];
      let recordsProcessed = 0;
      let recordsFailed = 0;

      // Process CSV rows
      const onRow = async (row: any) => {
        recordsProcessed++;

        try {
          // Map CSV row to contact data
          const contactData = this.mapRowToContact(row.data);
          contacts.push(contactData);

          // Update job progress periodically
          if (recordsProcessed % 100 === 0) {
            const progress = Math.round((recordsProcessed / jobData.recordCount) * 100);
            await job.updateProgress({
              stage: 'processing',
              percentage: progress,
              processedRecords: recordsProcessed,
              totalRecords: jobData.recordCount,
              message: `Processing records: ${recordsProcessed}/${jobData.recordCount}`,
              timestamp: new Date().toISOString(),
            });
          }
        } catch (error) {
          recordsFailed++;
          log.warn('Failed to process row', {
            rowNumber: row.rowNumber,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      };

      // Stream and process the chunk
      await csvReader.streamFromMinIO(jobData.chunkPath, onRow, undefined, jobData.traceId);

      log.info('Chunk CSV processing completed', {
        chunkId: jobData.chunkId,
        recordsProcessed,
        recordsFailed,
        validRecords: contacts.length,
      });

      // Bulk upsert contacts to database
      const dbStartTime = Date.now();
      const bulkResult = await this.contactService.bulkCreateContacts(
        contacts,
        jobData.configuration.onConflict || 'skip',
        jobData.traceId
      );
      const dbTime = Date.now() - dbStartTime;

      // Update bulk action statistics
      await this.bulkActionStatService.incrementCounters(
        jobData.actionId,
        {
          successful: bulkResult.created.length + bulkResult.updated.length,
          failed: bulkResult.errors.length,
          skipped: bulkResult.skipped.length,
        },
        jobData.traceId
      );

      const durationMs = Date.now() - startTime;
      const processingRate = recordsProcessed > 0 ? recordsProcessed / (durationMs / 1000) : 0;

      // Create success result
      const result: ProcessingJobResult = {
        success: true,
        actionId: jobData.actionId,
        chunkId: jobData.chunkId,
        processing: {
          recordsProcessed,
          recordsSuccessful: bulkResult.created.length + bulkResult.updated.length,
          recordsFailed: bulkResult.errors.length,
          recordsSkipped: bulkResult.skipped.length,
        },
        database: {
          operations: {
            inserts: bulkResult.created.length,
            updates: bulkResult.updated.length,
            conflicts: bulkResult.skipped.length,
            errors: bulkResult.errors.length,
          },
          timing: {
            connectionTime: 0, // TODO: Track actual connection time
            queryTime: dbTime,
            totalTime: dbTime,
          },
        },
        timing: {
          startedAt: new Date(startTime).toISOString(),
          completedAt: new Date().toISOString(),
          durationMs,
          processingRate,
        },
      };

      return result;
    } catch (error) {
      log.error('Chunk processing failed', {
        error: error instanceof Error ? error.message : String(error),
        chunkId: jobData.chunkId,
        chunkPath: jobData.chunkPath,
      });
      throw error;
    }
  }

  /**
   * Map CSV row to contact data
   */
  private mapRowToContact(rowData: Record<string, string>): any {
    return {
      email: rowData.email?.trim()?.toLowerCase(),
      name: rowData.name?.trim(),
      age: rowData.age ? parseInt(rowData.age) : undefined,
      id: rowData.id?.trim(),
    };
  }

  /**
   * Setup event listeners for a worker
   */
  private setupWorkerEventListeners(
    workerId: string,
    worker: Worker,
    workerInfo: ProcessingWorkerInfo
  ): void {
    worker.on('ready', () => {
      logger.info('Processing worker ready', { workerId });
      workerInfo.isHealthy = true;
    });

    worker.on('error', error => {
      logger.error('Processing worker error', {
        workerId,
        error: error.message,
      });
      workerInfo.status = 'error';
      workerInfo.isHealthy = false;
      this.emit('workerError', { workerId, error });
    });

    worker.on('stalled', jobId => {
      logger.warn('Processing job stalled', { workerId, jobId });
    });

    worker.on('failed', (job, err) => {
      logger.error('Processing job failed', {
        workerId,
        jobId: job?.id,
        actionId: job?.data?.actionId,
        chunkId: job?.data?.chunkId,
        error: err.message,
      });
      workerInfo.jobsFailed++;
    });

    worker.on('completed', (job, result) => {
      logger.info('Processing job completed', {
        workerId,
        jobId: job.id,
        actionId: job.data.actionId,
        chunkId: job.data.chunkId,
        success: result.success,
        recordsProcessed: result.processing?.recordsProcessed || 0,
      });
      workerInfo.jobsSuccessful++;
    });
  }

  /**
   * Stop processing workers
   */
  protected async stopWorkers(): Promise<void> {
    if (this.workers.size === 0) {
      return;
    }

    try {
      logger.info('Stopping processing workers', {
        workerId: this.config.workerId,
        workerCount: this.workers.size,
      });

      // Stop all workers
      const stopPromises: Promise<void>[] = [];
      for (const [workerId, { worker }] of this.workers) {
        stopPromises.push(
          worker.close().catch(error => {
            logger.error('Error stopping processing worker', {
              workerId,
              error: error instanceof Error ? error.message : String(error),
            });
          })
        );
      }

      await Promise.allSettled(stopPromises);
      this.workers.clear();

      logger.info('Processing workers stopped successfully', {
        workerId: this.config.workerId,
      });
    } catch (error) {
      logger.error('Error stopping processing workers', {
        error: error instanceof Error ? error.message : String(error),
        workerId: this.config.workerId,
      });
      throw error;
    }
  }

  /**
   * Cleanup processing-specific components
   */
  protected async cleanupWorkerComponents(): Promise<void> {
    try {
      logger.info('Cleaning up processing worker components', {
        workerId: this.config.workerId,
      });

      // Close processing queue
      if (this.processingQueue) {
        await this.processingQueue.close();
        this.processingQueue = null;
        logger.info('Processing queue closed');
      }

      logger.info('Processing worker components cleaned up successfully');
    } catch (error) {
      logger.error('Error cleaning up processing worker components', {
        error: error instanceof Error ? error.message : String(error),
        workerId: this.config.workerId,
      });
      // Don't throw during cleanup
    }
  }

  /**
   * Get processing worker metrics
   */
  public getMetrics() {
    const baseHealth = this.getHealthStatus();
    const workers = Array.from(this.workers.values()).map(({ info }) => info);
    const healthyWorkers = workers.filter(w => w.isHealthy);
    const processingWorkers = workers.filter(w => w.status === 'processing');

    const totalJobsProcessed = workers.reduce((sum, w) => sum + w.jobsProcessed, 0);
    const totalJobsSuccessful = workers.reduce((sum, w) => sum + w.jobsSuccessful, 0);
    const totalJobsFailed = workers.reduce((sum, w) => sum + w.jobsFailed, 0);

    return {
      serverType: this.config.serverType,
      workerId: this.config.workerId,
      uptime: this.getUptime(),
      health: baseHealth,
      workers: {
        total: workers.length,
        healthy: healthyWorkers.length,
        processing: processingWorkers.length,
        idle: workers.filter(w => w.status === 'idle').length,
        error: workers.filter(w => w.status === 'error').length,
      },
      jobs: {
        totalProcessed: totalJobsProcessed,
        totalSuccessful: totalJobsSuccessful,
        totalFailed: totalJobsFailed,
        successRate: totalJobsProcessed > 0 ? (totalJobsSuccessful / totalJobsProcessed) * 100 : 0,
      },
      configuration: {
        workerCount: this.processingWorkerConfig.workerCount,
        concurrencyPerWorker: this.processingWorkerConfig.concurrencyPerWorker,
        batchSize: this.processingWorkerConfig.batchSize,
        maxMemoryPerWorker: this.processingWorkerConfig.maxMemoryPerWorker,
        totalMemoryLimit: this.processingWorkerConfig.totalMemoryLimit,
      },
    };
  }

  /**
   * Get healthy worker count
   */
  private getHealthyWorkerCount(): number {
    return Array.from(this.workers.values()).filter(({ info }) => info.isHealthy).length;
  }

  /**
   * Check if error is retryable
   */
  private isRetryableError(error: unknown): boolean {
    if (error instanceof Error) {
      const retryablePatterns = [
        /timeout/i,
        /connection/i,
        /network/i,
        /temporary/i,
        /rate limit/i,
        /deadlock/i,
        /lock/i,
      ];

      return retryablePatterns.some(pattern => pattern.test(error.message));
    }

    return true; // Unknown errors are retryable by default
  }

  /**
   * Create default configuration for processing worker server
   */
  public static createDefaultConfig(): ProcessingWorkerServerConfig {
    const hostname = os.hostname();
    const workerId = `processing-server-${hostname}-${process.pid}-${uuidv4().substring(0, 8)}`;
    const workerConfig = configManager.getWorkerConfig();

    return {
      serverType: 'processing',
      workerId,
      healthCheckPort: parseInt(process.env.HEALTH_CHECK_PORT || '0') || undefined,
      gracefulShutdownTimeout: 30000, // 30 seconds
      dependencies: ['database', 'redis', 'minio'], // Processing workers need all dependencies

      // Processing-specific config
      // workerCount:
      //   parseInt(process.env.PROCESSING_WORKER_COUNT || '') || workerConfig.ingestionWorkers || 5,
      workerCount: 1,
      maxMemoryPerWorker: parseInt(process.env.MAX_MEMORY_PER_WORKER || '256'),
      totalMemoryLimit: parseInt(process.env.TOTAL_MEMORY_LIMIT || '1280'), // 256 * 5 workers
      concurrencyPerWorker: parseInt(process.env.CONCURRENCY_PER_WORKER || '3'),
      batchSize: parseInt(process.env.BATCH_SIZE || '1000'),
      jobTimeout: parseInt(process.env.JOB_TIMEOUT || '300000'), // 5 minutes
      maxRestartAttempts: parseInt(process.env.MAX_RESTART_ATTEMPTS || '3'),
    };
  }
}

/**
 * Start the processing worker server
 */
async function startProcessingWorkerServer(): Promise<void> {
  try {
    logger.info('Initializing processing worker server', {
      environment: configManager.getAppConfig().nodeEnv,
      nodeVersion: process.version,
      processId: process.pid,
    });

    // Create and start processing worker server
    const processingServer = new ProcessingWorkerServer();

    // Setup server event listeners
    processingServer.on('started', () => {
      logger.info('Processing worker server started successfully');
    });

    processingServer.on('stopped', () => {
      logger.info('Processing worker server stopped successfully');
      process.exit(0);
    });

    processingServer.on('error', error => {
      logger.error('Processing worker server error', {
        error: error instanceof Error ? error.message : String(error),
      });
      process.exit(1);
    });

    // Start the server
    await processingServer.start();

    // Log final status
    const metrics = processingServer.getMetrics();
    logger.info('Processing worker server operational', {
      workerId: metrics.workerId,
      workerCount: metrics.configuration.workerCount,
      healthyWorkers: metrics.workers.healthy,
      totalWorkers: metrics.workers.total,
      concurrencyPerWorker: metrics.configuration.concurrencyPerWorker,
      memoryLimit: `${metrics.configuration.totalMemoryLimit}MB`,
    });
  } catch (error) {
    logger.error('Failed to start processing worker server', {
      error: error instanceof Error ? error.message : String(error),
    });
    process.exit(1);
  }
}

// Start the processing worker server if this file is run directly
if (require.main === module) {
  startProcessingWorkerServer();
}

export default ProcessingWorkerServer;
