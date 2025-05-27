/**
 * Chunking Service
 * Orchestrates the complete CSV chunking workflow including validation, deduplication, and chunking
 */

import {
  CSVStreamReader,
  CSVStreamOptions,
  CSVStreamProgress,
} from '../processors/csv/CSVStreamReader';
import { CSVValidator, ValidationConfig, ValidationUtils } from '../processors/csv/CSVValidator';
import {
  DeduplicationEngine,
  DeduplicationConfig,
  DeduplicationUtils,
} from '../processors/csv/DeduplicationEngine';
import {
  ConsistentHashChunker,
  ChunkingConfig,
  ChunkingResult,
  ChunkingUtils,
} from '../processors/csv/ConsistentHashChunker';
import { BulkActionService } from './BulkActionService';
import { BulkActionStatService } from './BulkActionStatService';
import { EntityType, BulkActionType, BulkActionConfiguration } from '../types/entities/bulk-action';
import { logger } from '../utils/logger';

export interface ChunkingServiceConfig {
  // File processing
  maxFileSize: number; // Maximum file size in bytes
  maxRowSize: number; // Maximum row size in bytes
  encoding: BufferEncoding; // File encoding

  // Entity configuration
  entityType: EntityType;
  actionType: BulkActionType;
  configuration: BulkActionConfiguration;

  // Processing options
  strictValidation: boolean; // Fail fast on validation errors
  enableDeduplication: boolean;
  estimatedRecordCount: number;

  // Performance tuning
  progressUpdateInterval: number; // How often to report progress (milliseconds)
  memoryLimit: number; // Memory limit in MB
}

export interface ChunkingProgress {
  stage: ChunkingStage;
  stageProgress: number; // 0-100 for current stage
  overallProgress: number; // 0-100 overall

  // Stage-specific progress
  csvProgress?: CSVStreamProgress;
  validationProgress?: {
    validatedRows: number;
    totalErrors: number;
    errorRate: number;
  };
  deduplicationProgress?: {
    processedRows: number;
    duplicatesFound: number;
    skippedRows: number;
  };
  chunkingProgress?: {
    recordsChunked: number;
    chunksCreated: number;
    avgChunkSize: number;
  };

  // Timing and performance
  elapsedTime: number;
  estimatedTimeRemaining: number;
  currentRate: number; // rows per second

  // Current status
  message: string;
  timestamp: string;
}

export enum ChunkingStage {
  INITIALIZING = 'initializing',
  VALIDATING_STRUCTURE = 'validating_structure',
  PROCESSING_ROWS = 'processing_rows',
  FINALIZING_CHUNKS = 'finalizing_chunks',
  UPLOADING_CHUNKS = 'uploading_chunks',
  UPDATING_STATS = 'updating_stats',
  COMPLETED = 'completed',
  FAILED = 'failed',
}

export interface ChunkingServiceResult {
  success: boolean;
  actionId: string;

  // Processing results
  totalRecords: number;
  validRecords: number;
  invalidRecords: number;
  skippedRecords: number;

  // Chunking results
  chunksCreated: number;
  chunkMetadata: Array<{
    chunkId: string;
    chunkPath: string;
    recordCount: number;
    hashRangeStart: string;
    hashRangeEnd: string;
  }>;

  // Performance metrics
  processingTime: number;
  processingRate: number; // records per second

  // Error information
  error?: string;
  validationErrors?: Array<{
    rowNumber: number;
    field: string;
    message: string;
  }>;

  // Final statistics
  finalStats: {
    csvStats: any;
    validationStats: any;
    deduplicationStats: any;
    chunkingStats: any;
  };
}

export class ChunkingService {
  private bulkActionService: BulkActionService;
  private bulkActionStatService: BulkActionStatService;

  // Processing components
  private csvReader!: CSVStreamReader;
  private validator!: CSVValidator;
  private deduplicationEngine!: DeduplicationEngine;
  private chunker!: ConsistentHashChunker;

  // State tracking
  private isProcessing = false;
  private shouldAbort = false;
  private currentProgress: ChunkingProgress;
  private startTime = 0;

  constructor(bulkActionService: BulkActionService, bulkActionStatService: BulkActionStatService) {
    this.bulkActionService = bulkActionService;
    this.bulkActionStatService = bulkActionStatService;
    this.currentProgress = this.initializeProgress();
  }

  /**
   * Process CSV file through complete chunking workflow
   */
  public async processCSVFile(
    filePath: string,
    actionId: string,
    accountId: string,
    config: ChunkingServiceConfig,
    onProgress?: (progress: ChunkingProgress) => void,
    traceId?: string
  ): Promise<ChunkingServiceResult> {
    const log = traceId ? logger.withTrace(traceId) : logger;
    this.startTime = Date.now();
    this.isProcessing = true;
    this.shouldAbort = false;

    try {
      log.info('Starting CSV chunking process', {
        actionId,
        accountId,
        filePath,
        entityType: config.entityType,
        estimatedRecords: config.estimatedRecordCount,
      });

      // Initialize processing components
      await this.initializeProcessors(config, actionId, traceId);

      // Update bulk action status to 'validating'
      await this.updateBulkActionStatus(actionId, 'validating', undefined, traceId);

      // Stage 1: Validate CSV structure
      const structureValidation = await this.validateCSVStructure(
        filePath,
        config,
        onProgress,
        traceId
      );

      if (!structureValidation.isValid) {
        return await this.handleStructureValidationFailure(
          actionId,
          structureValidation.errors,
          traceId
        );
      }

      // Stage 2: Process CSV rows (validation + deduplication + chunking)
      await this.processCSVRows(filePath, config, onProgress, traceId);

      // Stage 3: Finalize chunks and upload to MinIO
      const chunkingResult = await this.finalizeChunks(accountId, actionId, onProgress, traceId);

      // Stage 4: Update bulk action statistics
      await this.updateBulkActionStatistics(actionId, traceId);

      const csvStats = this.csvReader.getStreamStats();

      // Update bulk action status to 'processing' (ready for ingestion workers)
      await this.updateBulkActionStatus(actionId, 'processing', undefined, traceId, {
        totalEntities: csvStats.totalRows,
      });

      const result = this.createSuccessResult(actionId, chunkingResult);

      log.info('CSV chunking completed successfully', {
        actionId,
        totalRecords: result.totalRecords,
        chunksCreated: result.chunksCreated,
        processingTime: result.processingTime,
        processingRate: result.processingRate,
      });

      return result;
    } catch (error) {
      log.error('CSV chunking failed', {
        error: error instanceof Error ? error.message : String(error),
        actionId,
        accountId,
        filePath,
      });

      // Update bulk action status to 'failed'
      await this.updateBulkActionStatus(
        actionId,
        'failed',
        error instanceof Error ? error.message : String(error),
        traceId
      );

      return this.createFailureResult(actionId, error);
    } finally {
      this.isProcessing = false;
      this.cleanupProcessors();
    }
  }

  /**
   * Abort current processing
   */
  public abort(): void {
    if (this.isProcessing) {
      this.shouldAbort = true;
      this.csvReader?.abort();

      logger.info('CSV chunking process aborted');
    }
  }

  /**
   * Initialize processing components
   */
  private async initializeProcessors(
    config: ChunkingServiceConfig,
    actionId: string,
    traceId?: string
  ): Promise<void> {
    const log = traceId ? logger.withTrace(traceId) : logger;

    this.updateProgress(ChunkingStage.INITIALIZING, 0, 'Initializing processors...', traceId);

    // Initialize CSV reader
    const csvOptions: CSVStreamOptions = {
      maxFileSize: config.maxFileSize,
      maxRowSize: config.maxRowSize,
      encoding: config.encoding,
      skipEmptyLines: true,
    };
    this.csvReader = new CSVStreamReader(csvOptions);

    // Initialize validator
    const validationConfig: ValidationConfig = ValidationUtils.createValidationConfig(
      config.entityType,
      config.strictValidation
    );
    this.validator = new CSVValidator(validationConfig);
    // Initialize deduplication engine
    const deduplicationConfig: DeduplicationConfig = DeduplicationUtils.createDefaultConfig(
      config.enableDeduplication
    );

    this.deduplicationEngine = new DeduplicationEngine(deduplicationConfig);

    // Initialize chunker
    const chunkingConfig: ChunkingConfig = ChunkingUtils.calculateOptimalConfig(
      config.estimatedRecordCount || 0, // this is always zero
      1000, // Target chunk size as requested
      100 // Max chunks
    );

    this.chunker = new ConsistentHashChunker(chunkingConfig);

    this.updateProgress(ChunkingStage.INITIALIZING, 100, 'Processors initialized', traceId);

    log.info('Processing components initialized', {
      actionId,
      csvOptions,
      validationConfig: {
        entityType: validationConfig.entityType,
        strictMode: validationConfig.strictMode,
      },
      deduplicationConfig: {
        enabled: deduplicationConfig.enabled,
        strategy: deduplicationConfig.strategy,
      },
      chunkingConfig,
    });
  }

  /**
   * Validate CSV structure
   */
  private async validateCSVStructure(
    filePath: string,
    config: ChunkingServiceConfig,
    onProgress?: (progress: ChunkingProgress) => void,
    traceId?: string
  ): Promise<{ isValid: boolean; errors: string[] }> {
    const log = traceId ? logger.withTrace(traceId) : logger;

    this.updateProgress(
      ChunkingStage.VALIDATING_STRUCTURE,
      0,
      'Validating CSV structure...',
      traceId
    );
    onProgress?.(this.currentProgress);

    try {
      const requiredColumns = this.getRequiredColumns(config.entityType);
      const validation = await this.csvReader.validateStructure(filePath, requiredColumns, traceId);

      this.updateProgress(
        ChunkingStage.VALIDATING_STRUCTURE,
        100,
        validation.isValid ? 'CSV structure valid' : 'CSV structure validation failed',
        traceId
      );
      onProgress?.(this.currentProgress);

      log.info('CSV structure validation completed', {
        isValid: validation.isValid,
        columnCount: validation.header.columns.length,
        errorCount: validation.errors.length,
      });

      return validation;
    } catch (error) {
      log.error('CSV structure validation failed', {
        error: error instanceof Error ? error.message : String(error),
        filePath,
      });

      return {
        isValid: false,
        errors: [error instanceof Error ? error.message : 'Unknown validation error'],
      };
    }
  }

  /**
   * Process CSV rows through validation, deduplication, and chunking
   */
  private async processCSVRows(
    filePath: string,
    config: ChunkingServiceConfig,
    onProgress?: (progress: ChunkingProgress) => void,
    traceId?: string
  ): Promise<void> {
    const log = traceId ? logger.withTrace(traceId) : logger;

    this.updateProgress(ChunkingStage.PROCESSING_ROWS, 0, 'Processing CSV rows...', traceId);

    let processedRows = 0;
    let validRows = 0;
    let invalidRows = 0;
    let duplicateRows = 0;
    let skippedRows = 0;

    const onRowProgress = (csvProgress: CSVStreamProgress) => {
      // Update our progress with CSV reader progress
      this.currentProgress.csvProgress = csvProgress;
      this.currentProgress.stageProgress = csvProgress.percentage;
      this.currentProgress.overallProgress = 20 + csvProgress.percentage * 0.6; // 20-80% overall

      onProgress?.(this.currentProgress);
    };

    const onRowProcessed = async (row: any) => {
      if (this.shouldAbort) {
        throw new Error('Processing aborted by user');
      }

      try {
        processedRows++;

        // Get CSV header
        const header = this.csvReader.getHeader();
        if (!header) {
          throw new Error('CSV header not available');
        }

        // Validate row
        const validationResult = this.validator.validateRow(row, header);

        // Handle validation result
        if (validationResult.isValid) {
          validRows++;

          // Process deduplication
          const deduplicationResult = this.deduplicationEngine.processRow(
            row,
            validationResult,
            traceId
          );

          // Track deduplication results
          if (deduplicationResult.duplicateCount > 1) {
            duplicateRows++;
          }

          // Add to chunker (chunker will handle skipped rows)
          this.chunker.addRow(row, validationResult, deduplicationResult, traceId);

          // Track if row was skipped
          if (deduplicationResult.action === 'skip') {
            skippedRows++;
          }
        } else {
          invalidRows++;

          log.debug('Row validation failed', {
            rowNumber: row.rowNumber,
            errors: validationResult.errors.map(e => e.message),
          });
        }

        // Update progress periodically
        if (processedRows % 1000 === 0) {
          this.updateRowProcessingProgress(
            processedRows,
            validRows,
            invalidRows,
            duplicateRows,
            skippedRows
          );
          onProgress?.(this.currentProgress);
        }
      } catch (error) {
        log.error('Error processing row', {
          error: error instanceof Error ? error.message : String(error),
          rowNumber: row.rowNumber,
        });

        invalidRows++;
      }
    };

    try {
      // Stream and process CSV file
      await this.csvReader.streamFromMinIO(filePath, onRowProcessed, onRowProgress, traceId);

      // Final progress update
      this.updateRowProcessingProgress(
        processedRows,
        validRows,
        invalidRows,
        duplicateRows,
        skippedRows
      );
      this.updateProgress(ChunkingStage.PROCESSING_ROWS, 100, 'Row processing completed', traceId);
      onProgress?.(this.currentProgress);

      log.info('CSV row processing completed', {
        processedRows,
        validRows,
        invalidRows,
        duplicateRows,
        skippedRows,
      });
    } catch (error) {
      log.error('CSV row processing failed', {
        error: error instanceof Error ? error.message : String(error),
        processedRows,
        validRows,
        invalidRows,
      });
      throw error;
    }
  }

  /**
   * Finalize chunks and upload to MinIO
   */
  private async finalizeChunks(
    accountId: string,
    actionId: string,
    onProgress?: (progress: ChunkingProgress) => void,
    traceId?: string
  ): Promise<ChunkingResult> {
    const log = traceId ? logger.withTrace(traceId) : logger;

    this.updateProgress(ChunkingStage.FINALIZING_CHUNKS, 0, 'Finalizing chunks...', traceId);
    onProgress?.(this.currentProgress);

    try {
      const chunkingResult = await this.chunker.finalizeChunks(accountId, actionId, traceId);

      this.updateProgress(
        ChunkingStage.FINALIZING_CHUNKS,
        100,
        `Created ${chunkingResult.chunksCreated} chunks`,
        traceId
      );
      onProgress?.(this.currentProgress);

      log.info('Chunk finalization completed', {
        success: chunkingResult.success,
        chunksCreated: chunkingResult.chunksCreated,
        totalRecords: chunkingResult.totalRecords,
      });

      return chunkingResult;
    } catch (error) {
      log.error('Chunk finalization failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Update bulk action statistics
   */
  private async updateBulkActionStatistics(actionId: string, traceId?: string): Promise<void> {
    const log = traceId ? logger.withTrace(traceId) : logger;

    this.updateProgress(ChunkingStage.UPDATING_STATS, 0, 'Updating statistics...', traceId);

    try {
      const csvStats = this.csvReader.getStreamStats();
      const validationStats = this.validator.getStats();
      const deduplicationStats = this.deduplicationEngine.getStats();

      // Update bulk action stats
      await this.bulkActionStatService.createOrUpdateStats(
        {
          actionId,
          totalRecords: csvStats.totalRows,
          successfulRecords: 0, // setting it to 0 as we don't track successful records in this context we'll be doing it in processing worker
          failedRecords: validationStats.invalidRows,
          skippedRecords: deduplicationStats.skippedRows,
        },
        traceId || ''
      );

      this.updateProgress(ChunkingStage.UPDATING_STATS, 100, 'Statistics updated', traceId);

      log.info('Bulk action statistics updated', {
        actionId,
        totalRecords: csvStats.totalRows,
        validRecords: validationStats.validRows,
        invalidRecords: validationStats.invalidRows,
        skippedRecords: deduplicationStats.skippedRows,
      });
    } catch (error) {
      log.error('Failed to update bulk action statistics', {
        error: error instanceof Error ? error.message : String(error),
        actionId,
      });
      // Don't throw - statistics update failure shouldn't fail the entire process
    }
  }

  /**
   * Update bulk action status
   */
  private async updateBulkActionStatus(
    actionId: string,
    status: string,
    errorMessage?: string,
    traceId?: string,
    opts: any = {}
  ): Promise<void> {
    try {
      const updates: any = { ...opts, status };
      if (errorMessage) {
        updates.errorMessage = errorMessage;
      }

      await this.bulkActionService.updateBulkAction(actionId, updates, traceId || '');
    } catch (error) {
      logger.error('Failed to update bulk action status', {
        error: error instanceof Error ? error.message : String(error),
        actionId,
        status,
      });
      // Don't throw - status update failure shouldn't fail the entire process
    }
  }

  /**
   * Handle structure validation failure
   */
  private async handleStructureValidationFailure(
    actionId: string,
    errors: string[],
    traceId?: string
  ): Promise<ChunkingServiceResult> {
    const log = traceId ? logger.withTrace(traceId) : logger;

    const errorMessage = `CSV structure validation failed: ${errors.join(', ')}`;

    log.warn('CSV structure validation failed', {
      actionId,
      errors,
    });

    // Update bulk action status
    await this.updateBulkActionStatus(actionId, 'failed', errorMessage, traceId);

    // Update statistics with failure
    await this.bulkActionStatService.createOrUpdateStats(
      {
        actionId,
        totalRecords: 0,
        successfulRecords: 0,
        failedRecords: 1, // Mark as one failed record for structure failure
        skippedRecords: 0,
      },
      traceId || ''
    );

    return {
      success: false,
      actionId,
      totalRecords: 0,
      validRecords: 0,
      invalidRecords: 0,
      skippedRecords: 0,
      chunksCreated: 0,
      chunkMetadata: [],
      processingTime: Date.now() - this.startTime,
      processingRate: 0,
      error: errorMessage,
      finalStats: {
        csvStats: null,
        validationStats: null,
        deduplicationStats: null,
        chunkingStats: null,
      },
    };
  }

  /**
   * Create success result
   */
  private createSuccessResult(
    actionId: string,
    chunkingResult: ChunkingResult
  ): ChunkingServiceResult {
    const csvStats = this.csvReader.getStreamStats();
    const validationStats = this.validator.getStats();
    const deduplicationStats = this.deduplicationEngine.getStats();

    const processingTime = Date.now() - this.startTime;
    const processingRate =
      csvStats.totalRows > 0 ? csvStats.totalRows / (processingTime / 1000) : 0;

    return {
      success: true,
      actionId,
      totalRecords: csvStats.totalRows,
      validRecords: validationStats.validRows,
      invalidRecords: validationStats.invalidRows,
      skippedRecords: deduplicationStats.skippedRows,
      chunksCreated: chunkingResult.chunksCreated,
      chunkMetadata: chunkingResult.chunkMetadata.map(chunk => ({
        chunkId: chunk.chunkId,
        chunkPath: chunk.chunkPath,
        recordCount: chunk.recordCount,
        hashRangeStart: chunk.hashRangeStart,
        hashRangeEnd: chunk.hashRangeEnd,
      })),
      processingTime,
      processingRate,
      finalStats: {
        csvStats,
        validationStats,
        deduplicationStats,
        chunkingStats: chunkingResult,
      },
    };
  }

  /**
   * Create failure result
   */
  private createFailureResult(actionId: string, error: unknown): ChunkingServiceResult {
    const processingTime = Date.now() - this.startTime;

    return {
      success: false,
      actionId,
      totalRecords: 0,
      validRecords: 0,
      invalidRecords: 0,
      skippedRecords: 0,
      chunksCreated: 0,
      chunkMetadata: [],
      processingTime,
      processingRate: 0,
      error: error instanceof Error ? error.message : String(error),
      finalStats: {
        csvStats: this.csvReader?.getStreamStats() || null,
        validationStats: this.validator?.getStats() || null,
        deduplicationStats: this.deduplicationEngine?.getStats() || null,
        chunkingStats: null,
      },
    };
  }

  /**
   * Update progress with current stage and details
   */
  private updateProgress(
    stage: ChunkingStage,
    stageProgress: number,
    message: string,
    traceId?: string
  ): void {
    const elapsedTime = Date.now() - this.startTime;

    // Calculate overall progress based on stage
    let overallProgress = 0;
    switch (stage) {
      case ChunkingStage.INITIALIZING:
        overallProgress = stageProgress * 0.05; // 0-5%
        break;
      case ChunkingStage.VALIDATING_STRUCTURE:
        overallProgress = 5 + stageProgress * 0.15; // 5-20%
        break;
      case ChunkingStage.PROCESSING_ROWS:
        overallProgress = 20 + stageProgress * 0.6; // 20-80%
        break;
      case ChunkingStage.FINALIZING_CHUNKS:
        overallProgress = 80 + stageProgress * 0.15; // 80-95%
        break;
      case ChunkingStage.UPDATING_STATS:
        overallProgress = 95 + stageProgress * 0.05; // 95-100%
        break;
      case ChunkingStage.COMPLETED:
        overallProgress = 100;
        break;
    }

    this.currentProgress = {
      ...this.currentProgress,
      stage,
      stageProgress,
      overallProgress,
      elapsedTime,
      message,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Update row processing progress
   */
  private updateRowProcessingProgress(
    processedRows: number,
    validRows: number,
    invalidRows: number,
    duplicateRows: number,
    skippedRows: number
  ): void {
    this.currentProgress.validationProgress = {
      validatedRows: processedRows,
      totalErrors: invalidRows,
      errorRate: processedRows > 0 ? (invalidRows / processedRows) * 100 : 0,
    };

    this.currentProgress.deduplicationProgress = {
      processedRows,
      duplicatesFound: duplicateRows,
      skippedRows,
    };

    const chunkingProgress = this.chunker.getProgress();
    this.currentProgress.chunkingProgress = {
      recordsChunked: chunkingProgress.recordsProcessed,
      chunksCreated: chunkingProgress.chunksInProgress,
      avgChunkSize: chunkingProgress.averageChunkSize,
    };

    // Calculate processing rate
    const elapsedSeconds = (Date.now() - this.startTime) / 1000;
    this.currentProgress.currentRate = elapsedSeconds > 0 ? processedRows / elapsedSeconds : 0;
  }

  /**
   * Get required columns for entity type
   */
  private getRequiredColumns(entityType: EntityType): string[] {
    switch (entityType) {
      case 'contact':
        return ['id'];
      default:
        return [];
    }
  }

  /**
   * Initialize progress object
   */
  private initializeProgress(): ChunkingProgress {
    return {
      stage: ChunkingStage.INITIALIZING,
      stageProgress: 0,
      overallProgress: 0,
      elapsedTime: 0,
      estimatedTimeRemaining: 0,
      currentRate: 0,
      message: 'Initializing...',
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Cleanup processing components
   */
  private cleanupProcessors(): void {
    try {
      this.validator?.resetStats();
      this.deduplicationEngine?.reset();
      // Note: chunker and csvReader don't have cleanup methods, they'll be garbage collected
    } catch (error) {
      logger.warn('Error during processor cleanup', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

// Export utility functions
export const ChunkingServiceUtils = {
  /**
   * Create default chunking service config
   */
  createDefaultConfig(
    entityType: EntityType,
    actionType: BulkActionType,
    configuration: BulkActionConfiguration,
    estimatedRecordCount: number
  ): ChunkingServiceConfig {
    return {
      maxFileSize: 100 * 1024 * 1024, // 100MB
      maxRowSize: 1024 * 1024, // 1MB
      encoding: 'utf8',
      entityType,
      actionType,
      configuration,
      strictValidation: false,
      enableDeduplication: configuration.deduplicate ?? false,
      estimatedRecordCount,
      progressUpdateInterval: 5000, // 5 seconds
      memoryLimit: 256, // 256MB
    };
  },

  /**
   * Estimate processing time based on record count
   */
  estimateProcessingTime(recordCount: number, avgProcessingRate: number = 1000): number {
    // Returns estimated time in milliseconds
    return (recordCount / avgProcessingRate) * 1000;
  },

  /**
   * Validate chunking service config
   */
  validateConfig(config: ChunkingServiceConfig): string[] {
    const errors: string[] = [];

    if (config.maxFileSize < 1024 * 1024) {
      errors.push('maxFileSize should be at least 1MB');
    }

    if (config.maxRowSize < 1024) {
      errors.push('maxRowSize should be at least 1KB');
    }

    if (config.estimatedRecordCount < 0) {
      errors.push('estimatedRecordCount cannot be negative');
    }

    if (config.memoryLimit < 64) {
      errors.push('memoryLimit should be at least 64MB');
    }

    return errors;
  },
};
