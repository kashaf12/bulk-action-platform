// Load environment variables
import dotenv from 'dotenv';
dotenv.config();

import { BaseWorkerServer, BaseWorkerServerConfig } from './shared/BaseWorkerServer';
import { Worker } from 'bullmq';
import { ProcessingJobData, ProcessingJobResult } from '../queues/types/ChunkingJob';
import { ProcessingQueue } from '../queues/ProcessingQueue';
import queueConfigManager from '../queues/config/queueConfig';
import {
  BulkContactOperation,
  BulkContactUpdateResult,
  ContactService,
} from '../services/ContactService';
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
  partitionId: number;
  batchSize: number;
  jobTimeout: number;
  maxMemoryLimit: number;
  maxRestartAttempts: number;
}

export interface ProcessingWorkerInfo {
  id: string;
  partitionId: number;
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
    actionType: 'bulk_update';
    entityType: 'contact';
  };
  memoryUsage: number;
  isHealthy: boolean;
  queueName: string;
}

export class ProcessingWorkerServer extends BaseWorkerServer {
  private processingQueue: ProcessingQueue | null = null;
  private worker: Worker<ProcessingJobData, ProcessingJobResult> | null = null;
  private workerInfo: ProcessingWorkerInfo;
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

    // Initialize worker info
    this.workerInfo = {
      id: this.config.workerId,
      partitionId: this.processingWorkerConfig.partitionId,
      status: 'idle',
      startTime: new Date().toISOString(),
      jobsProcessed: 0,
      jobsSuccessful: 0,
      jobsFailed: 0,
      memoryUsage: 0,
      isHealthy: true,
      queueName: '',
    };

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
        partitionId: this.processingWorkerConfig.partitionId,
      });

      // Initialize processing queue
      this.processingQueue = new ProcessingQueue();
      await this.processingQueue.initialize();

      const partitionCount = this.processingQueue.getPartitionCount();

      // Validate partition ID
      if (this.processingWorkerConfig.partitionId >= partitionCount) {
        throw new Error(
          `Invalid partition ID: ${this.processingWorkerConfig.partitionId}. Available partitions: 0-${partitionCount - 1}`
        );
      }

      logger.info('Processing queue initialized for single partition worker', {
        partitionId: this.processingWorkerConfig.partitionId,
        totalPartitions: partitionCount,
      });

      logger.info('Processing worker components initialized successfully');
    } catch (error) {
      logger.error('Failed to initialize processing worker components', {
        error: error instanceof Error ? error.message : String(error),
        workerId: this.config.workerId,
        partitionId: this.processingWorkerConfig.partitionId,
      });
      throw error;
    }
  }

  /**
   * Start single partition processing worker
   */
  protected async startWorkers(): Promise<void> {
    if (!this.processingQueue) {
      throw new Error('Processing queue not initialized');
    }

    try {
      const partitionId = this.processingWorkerConfig.partitionId;

      logger.info('Starting single partition processing worker', {
        workerId: this.config.workerId,
        partitionId,
      });

      // Get partition-specific queue
      const partitionQueue = this.processingQueue.getPartitionQueue(partitionId);
      const queueName = partitionQueue.name;

      // Update worker info
      this.workerInfo.queueName = queueName;

      logger.info('Creating worker for partition', {
        workerId: this.config.workerId,
        partitionId,
        queueName,
      });

      // Create single BullMQ worker bound to specific partition queue
      this.worker = new Worker<ProcessingJobData, ProcessingJobResult>(
        queueName,
        this.createJobProcessor(),
        {
          connection: queueConfigManager.getConnectionOptions(),
          maxStalledCount: 3,
          stalledInterval: 30000,
          removeOnComplete: { count: 10 },
          removeOnFail: { count: 5 },
        }
      );

      // Setup worker event listeners
      this.setupWorkerEventListeners();

      logger.info('Single partition processing worker started successfully', {
        workerId: this.config.workerId,
        partitionId,
        queueName,
      });
    } catch (error) {
      logger.error('Failed to start single partition processing worker', {
        error: error instanceof Error ? error.message : String(error),
        workerId: this.config.workerId,
        partitionId: this.processingWorkerConfig.partitionId,
      });
      throw error;
    }
  }

  /**
   * Create job processor function for this partition worker
   */
  private createJobProcessor() {
    return async (job: any): Promise<ProcessingJobResult> => {
      const startTime = Date.now();
      const partitionId = this.processingWorkerConfig.partitionId;

      // Update worker status
      this.workerInfo.status = 'processing';
      this.workerInfo.currentJob = {
        id: job.id || 'unknown',
        actionId: job.data.actionId,
        chunkId: job.data.chunkId,
        startTime: new Date().toISOString(),
        actionType: job.data.actionType,
        entityType: job.data.entityType,
      };

      const log = logger.withTrace(job.data.traceId);

      try {
        log.info('Starting processing job in partition worker', {
          jobId: job.id,
          actionId: job.data.actionId,
          chunkId: job.data.chunkId,
          chunkPath: job.data.chunkPath,
          recordCount: job.data.recordCount,
          workerId: this.config.workerId,
          partitionId,
          queueName: this.workerInfo.queueName,
          hashRangeStart: job.data.hashRangeStart,
          hashRangeEnd: job.data.hashRangeEnd,
        });

        // Process the chunk
        const result = await this.processChunk(job.data, job, job.data.traceId);

        // Update worker metrics
        this.workerInfo.jobsProcessed++;
        this.workerInfo.jobsSuccessful++;
        this.workerInfo.status = 'idle';
        this.workerInfo.currentJob = undefined;

        log.info('Processing job completed successfully in partition worker', {
          jobId: job.id,
          actionId: job.data.actionId,
          chunkId: job.data.chunkId,
          recordsProcessed: result.processing.recordsProcessed,
          recordsSuccessful: result.processing.recordsSuccessful,
          processingTime: result.timing.durationMs,
          workerId: this.config.workerId,
          partitionId,
        });

        this.emit('jobCompleted', {
          workerId: this.config.workerId,
          partitionId,
          jobId: job.id,
          result,
        });

        return result;
      } catch (error) {
        // Update worker metrics
        this.workerInfo.jobsFailed++;
        this.workerInfo.status = 'error';
        this.workerInfo.currentJob = undefined;

        const processingTime = Date.now() - startTime;

        log.error('Processing job failed in partition worker', {
          error: error instanceof Error ? error.message : String(error),
          jobId: job.id,
          actionId: job.data.actionId,
          chunkId: job.data.chunkId,
          processingTime,
          workerId: this.config.workerId,
          partitionId,
        });

        this.emit('jobFailed', {
          workerId: this.config.workerId,
          partitionId,
          jobId: job.id,
          error,
        });

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
          this.workerInfo.status = 'idle';
          this.workerInfo.currentJob = undefined;
        }, 1000);
      }
    };
  }

  /**
   * Process a single chunk by streaming and processing in batches
   */
  private async processChunk(
    jobData: ProcessingJobData,
    job: any,
    traceId: string
  ): Promise<ProcessingJobResult> {
    const log = logger.withTrace(traceId);
    const startTime = Date.now();

    let currentBatch: any[] = [];
    let recordsProcessedInChunk = 0;
    let totalSuccessfulInChunk = 0;
    let totalFailedInChunk = 0;
    let totalSkippedInChunk = 0;
    let totalInsertsInChunk = 0;
    let totalUpdatesInChunk = 0;
    let totalConflictsInChunk = 0;
    let totalDbErrorsInChunk = 0;
    let totalDbQueryTimeInChunk = 0;

    return new Promise<ProcessingJobResult>((resolve, reject) => {
      const csvReader = new CSVStreamReader({
        maxFileSize: 50 * 1024 * 1024, // 50MB max for chunks
        maxRowSize: 1024 * 1024, // 1MB max row size
        encoding: 'utf8',
      });

      csvReader
        .streamFromMinIO(
          jobData.chunkPath,
          async (row: any) => {
            recordsProcessedInChunk++;

            try {
              // Map CSV row to contact data
              const contactData = this.mapRowToContact(row.data);
              currentBatch.push(contactData);

              // Update job progress every 100 records
              if (recordsProcessedInChunk % 100 === 0) {
                const progress = Math.round((recordsProcessedInChunk / jobData.recordCount) * 100);
                await job.updateProgress({
                  stage: 'processing',
                  percentage: progress,
                  processedRecords: recordsProcessedInChunk,
                  totalRecords: jobData.recordCount,
                  message: `Processing records in partition ${this.processingWorkerConfig.partitionId}: ${recordsProcessedInChunk}/${jobData.recordCount}`,
                  timestamp: new Date().toISOString(),
                });
                log.debug('Progress updated', {
                  chunkId: jobData.chunkId,
                  partitionId: this.processingWorkerConfig.partitionId,
                  recordsProcessed: recordsProcessedInChunk,
                  totalRecords: jobData.recordCount,
                  progress,
                });
              }

              // Process batch when it reaches configured size
              if (currentBatch.length >= this.processingWorkerConfig.batchSize) {
                await this.processBatchAndPersist(jobData, currentBatch, log)
                  .then(batchResult => {
                    totalSuccessfulInChunk += batchResult.successful;
                    totalFailedInChunk += batchResult.failed;
                    totalSkippedInChunk += batchResult.skipped;
                    totalInsertsInChunk += batchResult.database.inserts;
                    totalUpdatesInChunk += batchResult.database.updates;
                    totalConflictsInChunk += batchResult.database.conflicts;
                    totalDbErrorsInChunk += batchResult.database.errors;
                    totalDbQueryTimeInChunk += batchResult.database.queryTime;
                  })
                  .catch(batchError => {
                    log.error(
                      `Error processing batch for chunk ${jobData.chunkId}: ${batchError.message}`
                    );
                    totalFailedInChunk += currentBatch.length;
                    totalDbErrorsInChunk++;
                  })
                  .finally(() => {
                    currentBatch = [];
                  });
              }
            } catch (error) {
              totalFailedInChunk++;
              log.warn('Failed to process row in partition', {
                rowNumber: row.rowNumber,
                partitionId: this.processingWorkerConfig.partitionId,
                error: error instanceof Error ? error.message : String(error),
              });
            }
          },
          undefined,
          jobData.traceId
        )
        .then(async () => {
          // Process remaining records in final batch
          if (currentBatch.length > 0) {
            await this.processBatchAndPersist(jobData, currentBatch, log)
              .then(batchResult => {
                totalSuccessfulInChunk += batchResult.successful;
                totalFailedInChunk += batchResult.failed;
                totalSkippedInChunk += batchResult.skipped;
                totalInsertsInChunk += batchResult.database.inserts;
                totalUpdatesInChunk += batchResult.database.updates;
                totalConflictsInChunk += batchResult.database.conflicts;
                totalDbErrorsInChunk += batchResult.database.errors;
                totalDbQueryTimeInChunk += batchResult.database.queryTime;
              })
              .catch(batchError => {
                log.error(
                  `Error processing final batch for chunk ${jobData.chunkId}: ${batchError.message}`
                );
                totalFailedInChunk += currentBatch.length;
                totalDbErrorsInChunk++;
              });
          }

          log.info('Chunk CSV streaming completed in partition', {
            chunkId: jobData.chunkId,
            partitionId: this.processingWorkerConfig.partitionId,
            recordsProcessed: recordsProcessedInChunk,
            totalSuccessfulInChunk,
            totalFailedInChunk,
            totalSkippedInChunk,
          });

          // Update bulk action statistics
          await this.bulkActionStatService.incrementCounters(
            jobData.actionId,
            {
              successful: totalSuccessfulInChunk,
              failed: totalFailedInChunk,
              skipped: totalSkippedInChunk,
            },
            jobData.traceId
          );

          // Check for overall bulk action completion
          try {
            const stats = await this.bulkActionStatService.getStatsByActionId(
              jobData.actionId,
              jobData.traceId
            );

            if (
              stats &&
              stats.successfulRecords + stats.failedRecords + stats.skippedRecords ===
                stats.totalRecords
            ) {
              await this.bulkActionService.updateBulkAction(
                jobData.actionId,
                {
                  status: 'completed',
                },
                jobData.traceId
              );
              log.info(`Bulk action ${jobData.actionId} processing completed.`);
            }
          } catch (completionCheckError) {
            const errorMessage =
              completionCheckError instanceof Error
                ? completionCheckError.message
                : 'Error checking bulk action completion';
            log.error(`${jobData.actionId}: ${errorMessage}`);
          }

          const durationMs = Date.now() - startTime;
          const processingRate =
            recordsProcessedInChunk > 0 ? recordsProcessedInChunk / (durationMs / 1000) : 0;

          resolve({
            success: totalFailedInChunk === 0,
            actionId: jobData.actionId,
            chunkId: jobData.chunkId,
            processing: {
              recordsProcessed: recordsProcessedInChunk,
              recordsSuccessful: totalSuccessfulInChunk,
              recordsFailed: totalFailedInChunk,
              recordsSkipped: totalSkippedInChunk,
            },
            database: {
              operations: {
                inserts: totalInsertsInChunk,
                updates: totalUpdatesInChunk,
                conflicts: totalConflictsInChunk,
                errors: totalDbErrorsInChunk,
              },
              timing: {
                connectionTime: 0,
                queryTime: totalDbQueryTimeInChunk,
                totalTime: totalDbQueryTimeInChunk,
              },
            },
            timing: {
              startedAt: new Date(startTime).toISOString(),
              completedAt: new Date().toISOString(),
              durationMs,
              processingRate,
            },
          });
        })
        .catch(error => {
          log.error('Chunk processing failed during stream or finalization', {
            error: error instanceof Error ? error.message : String(error),
            chunkId: jobData.chunkId,
            chunkPath: jobData.chunkPath,
            partitionId: this.processingWorkerConfig.partitionId,
          });
          reject(error);
        });
    });
  }

  /**
   * Process batch and persist to database
   */
  private async processBatchAndPersist(
    jobData: ProcessingJobData,
    batch: any[],
    log: any
  ): Promise<{
    successful: number;
    failed: number;
    skipped: number;
    database: {
      inserts: number;
      updates: number;
      conflicts: number;
      errors: number;
      queryTime: number;
    };
  }> {
    const dbStartTime = Date.now();
    let batchSuccessful = 0;
    let batchFailed = 0;
    let batchSkipped = 0;
    let dbInserts = 0;
    let dbUpdates = 0;
    let dbConflicts = 0;
    let dbErrors = 0;

    if (batch.length === 0) {
      return {
        successful: 0,
        failed: 0,
        skipped: 0,
        database: { inserts: 0, updates: 0, conflicts: 0, errors: 0, queryTime: 0 },
      };
    }

    try {
      let bulkResult: BulkContactUpdateResult | BulkContactOperation;
      if (jobData.actionType === 'bulk_update') {
        bulkResult = await this.contactService.bulkUpdateContacts(batch, jobData.traceId);
        batchSuccessful = bulkResult.updated.length;
        batchFailed = bulkResult.failed.length;
        dbUpdates = bulkResult.updated.length;
        dbErrors = bulkResult.failed.length;
      } else {
        bulkResult = await this.contactService.bulkCreateContacts(
          batch,
          jobData.configuration.onConflict || 'skip',
          jobData.traceId
        );
        batchSuccessful = bulkResult.created.length + bulkResult.updated.length;
        batchFailed = bulkResult.errors.length;
        batchSkipped = bulkResult.skipped.length;
        dbInserts = bulkResult.created.length;
        dbUpdates = bulkResult.updated.length;
        dbConflicts = bulkResult.skipped.length;
        dbErrors = bulkResult.errors.length;
      }

      const dbQueryTime = Date.now() - dbStartTime;

      log.debug('Batch processed and persisted', {
        actionId: jobData.actionId,
        partitionId: this.processingWorkerConfig.partitionId,
        batchSize: batch.length,
        batchSuccessful,
        batchFailed,
        batchSkipped,
        dbInserts,
        dbUpdates,
        dbConflicts,
        dbErrors,
        dbQueryTime,
      });

      return {
        successful: batchSuccessful,
        failed: batchFailed,
        skipped: batchSkipped,
        database: {
          inserts: dbInserts,
          updates: dbUpdates,
          conflicts: dbConflicts,
          errors: dbErrors,
          queryTime: dbQueryTime,
        },
      };
    } catch (error) {
      log.error('Error during batch processing and persistence', {
        actionId: jobData.actionId,
        partitionId: this.processingWorkerConfig.partitionId,
        batchSize: batch.length,
        error: error instanceof Error ? error.message : String(error),
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
   * Setup event listeners for the worker
   */
  private setupWorkerEventListeners(): void {
    if (!this.worker) return;

    this.worker.on('ready', () => {
      logger.info('Single partition processing worker ready', {
        workerId: this.config.workerId,
        partitionId: this.processingWorkerConfig.partitionId,
        queueName: this.workerInfo.queueName,
      });
      this.workerInfo.isHealthy = true;
    });

    this.worker.on('error', error => {
      logger.error('Single partition processing worker error', {
        workerId: this.config.workerId,
        partitionId: this.processingWorkerConfig.partitionId,
        queueName: this.workerInfo.queueName,
        error: error.message,
      });
      this.workerInfo.status = 'error';
      this.workerInfo.isHealthy = false;
      this.emit('workerError', {
        workerId: this.config.workerId,
        partitionId: this.processingWorkerConfig.partitionId,
        error,
      });
    });

    this.worker.on('stalled', jobId => {
      logger.warn('Processing job stalled in partition', {
        workerId: this.config.workerId,
        partitionId: this.processingWorkerConfig.partitionId,
        jobId,
        queueName: this.workerInfo.queueName,
      });
    });

    this.worker.on('failed', (job, err) => {
      logger.error('Processing job failed in partition', {
        workerId: this.config.workerId,
        partitionId: this.processingWorkerConfig.partitionId,
        jobId: job?.id,
        actionId: job?.data?.actionId,
        chunkId: job?.data?.chunkId,
        queueName: this.workerInfo.queueName,
        error: err.message,
      });
      this.workerInfo.jobsFailed++;
    });

    this.worker.on('completed', (job, result) => {
      logger.info('Processing job completed in partition', {
        workerId: this.config.workerId,
        partitionId: this.processingWorkerConfig.partitionId,
        jobId: job.id,
        actionId: job.data.actionId,
        chunkId: job.data.chunkId,
        queueName: this.workerInfo.queueName,
        success: result.success,
        recordsProcessed: result.processing?.recordsProcessed || 0,
      });
      this.workerInfo.jobsSuccessful++;
    });
  }

  /**
   * Stop the single processing worker
   */
  protected async stopWorkers(): Promise<void> {
    if (!this.worker) {
      return;
    }

    try {
      logger.info('Stopping single partition processing worker', {
        workerId: this.config.workerId,
        partitionId: this.processingWorkerConfig.partitionId,
        queueName: this.workerInfo.queueName,
      });

      await this.worker.close();
      this.worker = null;

      logger.info('Single partition processing worker stopped successfully', {
        workerId: this.config.workerId,
        partitionId: this.processingWorkerConfig.partitionId,
      });
    } catch (error) {
      logger.error('Error stopping single partition processing worker', {
        error: error instanceof Error ? error.message : String(error),
        workerId: this.config.workerId,
        partitionId: this.processingWorkerConfig.partitionId,
      });
      throw error;
    }
  }

  /**
   * Cleanup processing-specific components
   */
  protected async cleanupWorkerComponents(): Promise<void> {
    try {
      logger.info('Cleaning up single partition processing worker components', {
        workerId: this.config.workerId,
        partitionId: this.processingWorkerConfig.partitionId,
      });

      if (this.processingQueue) {
        await this.processingQueue.close();
        this.processingQueue = null;
        logger.info('Processing queue closed');
      }

      logger.info('Single partition processing worker components cleaned up successfully');
    } catch (error) {
      logger.error('Error cleaning up single partition processing worker components', {
        error: error instanceof Error ? error.message : String(error),
        workerId: this.config.workerId,
        partitionId: this.processingWorkerConfig.partitionId,
      });
    }
  }

  /**
   * Get processing worker metrics
   */
  public getMetrics() {
    const baseHealth = this.getHealthStatus();

    return {
      serverType: this.config.serverType,
      workerId: this.config.workerId,
      partitionId: this.processingWorkerConfig.partitionId,
      uptime: this.getUptime(),
      health: baseHealth,
      worker: this.workerInfo,
      configuration: {
        partitionId: this.processingWorkerConfig.partitionId,
        batchSize: this.processingWorkerConfig.batchSize,
        maxMemoryLimit: this.processingWorkerConfig.maxMemoryLimit,
        queueName: this.workerInfo.queueName,
      },
    };
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

    return true;
  }

  /**
   * Create default configuration for processing worker server
   */
  public static createDefaultConfig(): ProcessingWorkerServerConfig {
    const hostname = os.hostname();

    // Get partition ID from environment variable
    const partitionId = parseInt(process.env.PARTITION_ID || '0');
    const workerId = `processing-server-${hostname}-${process.pid}-p${partitionId}-${uuidv4().substring(0, 8)}`;

    return {
      serverType: 'processing',
      workerId,
      healthCheckPort: parseInt(process.env.HEALTH_CHECK_PORT || '0') || undefined,
      gracefulShutdownTimeout: 30000,
      dependencies: ['database', 'redis', 'minio'],

      // Single partition configuration
      partitionId,
      batchSize: parseInt(process.env.BATCH_SIZE || '1000'),
      jobTimeout: parseInt(process.env.JOB_TIMEOUT || '300000'),
      maxMemoryLimit: parseInt(process.env.MAX_MEMORY_PER_WORKER || '256'),
      maxRestartAttempts: parseInt(process.env.MAX_RESTART_ATTEMPTS || '3'),
    };
  }
}

/**
 * Start the single partition processing worker server
 */
async function startProcessingWorkerServer(): Promise<void> {
  try {
    const partitionId = parseInt(process.env.PARTITION_ID || '0');

    logger.info('Initializing single partition processing worker server', {
      environment: configManager.getAppConfig().nodeEnv,
      nodeVersion: process.version,
      processId: process.pid,
      partitionId,
    });

    const processingServer = new ProcessingWorkerServer();

    processingServer.on('started', () => {
      logger.info('Single partition processing worker server started successfully');
    });

    processingServer.on('stopped', () => {
      logger.info('Single partition processing worker server stopped successfully');
      process.exit(0);
    });

    processingServer.on('error', error => {
      logger.error('Single partition processing worker server error', {
        error: error instanceof Error ? error.message : String(error),
      });
      process.exit(1);
    });
    await processingServer.start();

    const metrics = processingServer.getMetrics();
    logger.info('Single partition processing worker server operational', {
      workerId: metrics.workerId,
      partitionId: metrics.partitionId,
      queueName: metrics.configuration.queueName,
      batchSize: metrics.configuration.batchSize,
      memoryLimit: `${metrics.configuration.maxMemoryLimit}MB`,
      workerStatus: metrics.worker.status,
      isHealthy: metrics.worker.isHealthy,
    });
  } catch (error) {
    logger.error('Failed to start single partition processing worker server', {
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
