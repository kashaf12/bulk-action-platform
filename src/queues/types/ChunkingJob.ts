/**
 * Job type definitions for BullMQ queues
 * Defines data structures for chunking and processing jobs
 */

import {
  EntityType,
  BulkActionType,
  BulkActionConfiguration,
} from '../../types/entities/bulk-action';

// Base job interface
export interface BaseJobData {
  traceId: string;
  accountId: string;
  actionId: string;
  createdAt: string;
  priority?: number;
}

// Chunking job data structure
export interface ChunkingJobData extends BaseJobData {
  // File information
  filePath: string; // MinIO path to raw CSV file
  fileName: string; // Original filename
  fileSize: number; // File size in bytes
  etag: string; // MinIO ETag for verification

  // Action configuration
  entityType: EntityType;
  actionType: BulkActionType;
  configuration: BulkActionConfiguration & {
    deduplicate?: boolean;
    onConflict?: 'skip' | 'update' | 'error';
    chunkSize?: number; // Max records per chunk (default: 1000)
  };

  // Processing context
  estimatedEntityCount: number;
  scheduledAt?: Date; // ISO timestamp
}

// Processing job data structure (for individual chunks)
export interface ProcessingJobData extends BaseJobData {
  // Chunk information
  chunkId: string; // Unique chunk identifier
  chunkPath: string; // MinIO path to chunk file
  chunkIndex: number; // Chunk sequence number (0, 1, 2, ...)
  totalChunks: number; // Total number of chunks for this action

  // Chunk metadata
  recordCount: number; // Number of records in this chunk
  startRecord: number; // Starting record number (for tracking)
  endRecord: number; // Ending record number (for tracking)

  // Action configuration (inherited from chunking)
  entityType: EntityType;
  actionType: BulkActionType;
  configuration: BulkActionConfiguration;

  // Hash range (for consistent hashing)
  hashRangeStart: string; // Starting hash value for this chunk
  hashRangeEnd: string; // Ending hash value for this chunk
}

// Job progress tracking
export interface JobProgress {
  stage:
    | 'starting'
    | 'validating'
    | 'processing'
    | 'chunking'
    | 'completing'
    | 'completed'
    | 'failed';
  percentage: number; // 0-100
  processedRecords: number;
  totalRecords: number;
  message: string;
  timestamp: string;

  // Stage-specific data
  validationResults?: ValidationProgress;
  chunkingResults?: ChunkingProgress;
  processingResults?: ProcessingProgress;
}

// Validation progress tracking
export interface ValidationProgress {
  structureValid: boolean;
  totalRows: number;
  validRows: number;
  invalidRows: number;
  duplicateRows: number; // Email duplicates within CSV
  skippedRows: number; // Rows to be skipped due to deduplication

  // Error breakdown
  validationErrors: {
    schemaErrors: number; // Invalid data types, missing required fields
    businessRuleErrors: number; // Invalid email format, business logic failures
    structureErrors: number; // Malformed CSV, missing headers
  };

  // Sample errors for debugging (max 10)
  sampleErrors: Array<{
    row: number;
    field: string;
    value: string;
    error: string;
  }>;
}

// Chunking progress tracking
export interface ChunkingProgress {
  totalChunks: number;
  chunksCreated: number;
  recordsChunked: number;
  avgChunkSize: number;

  // Chunk distribution info
  chunkSizes: number[]; // Array of chunk sizes for distribution analysis
  hashDistribution: {
    // Hash distribution statistics
    minHash: string;
    maxHash: string;
    ranges: Array<{
      start: string;
      end: string;
      count: number;
    }>;
  };
}

// Processing progress tracking (for individual chunks)
export interface ProcessingProgress {
  recordsProcessed: number;
  recordsSuccessful: number;
  recordsFailed: number;
  recordsSkipped: number;

  // Database operation stats
  dbOperations: {
    inserts: number;
    updates: number;
    conflicts: number;
    errors: number;
  };

  // Performance metrics
  processingRate: number; // Records per second
  estimatedTimeRemaining: number; // Milliseconds
}

// Job result interfaces
export interface ChunkingJobResult {
  success: boolean;
  actionId: string;

  // File processing results
  fileValidation: {
    isValid: boolean;
    errorMessage?: string;
    structureErrors?: string[];
  };

  // CSV processing results
  csvProcessing: {
    totalRecords: number;
    validRecords: number;
    invalidRecords: number;
    duplicateRecords: number;
    skippedRecords: number;
  };

  // Chunking results
  chunking: {
    totalChunks: number;
    chunkPaths: string[]; // Array of MinIO paths to chunk files
    chunkMetadata: Array<{
      chunkId: string;
      chunkPath: string;
      recordCount: number;
      hashRangeStart: string;
      hashRangeEnd: string;
    }>;
  };

  // Processing jobs enqueued
  processingJobs: {
    jobIds: string[]; // BullMQ job IDs for processing jobs
    totalJobs: number;
  };

  // Timing information
  timing: {
    startedAt: string;
    completedAt: string;
    durationMs: number;
    stages: {
      validation: number; // Time spent validating (ms)
      chunking: number; // Time spent chunking (ms)
      storage: number; // Time spent storing chunks (ms)
    };
  };

  // Error information (if failed)
  error?: {
    stage: string; // Which stage failed
    message: string;
    details?: unknown;
    retryable: boolean; // Whether this error can be retried
  };
}

export interface ProcessingJobResult {
  success: boolean;
  actionId: string;
  chunkId: string;

  // Processing results
  processing: {
    recordsProcessed: number;
    recordsSuccessful: number;
    recordsFailed: number;
    recordsSkipped: number;
  };

  // Database operation results
  database: {
    operations: {
      inserts: number;
      updates: number;
      conflicts: number;
      errors: number;
    };
    timing: {
      connectionTime: number;
      queryTime: number;
      totalTime: number;
    };
  };

  // Timing information
  timing: {
    startedAt: string;
    completedAt: string;
    durationMs: number;
    processingRate: number; // Records per second
  };

  // Error information (if failed)
  error?: {
    message: string;
    details?: unknown;
    retryable: boolean;
    failedRecords?: Array<{
      recordNumber: number;
      data: Record<string, unknown>;
      error: string;
    }>;
  };
}

// Job status enums
export enum JobStatus {
  WAITING = 'waiting',
  ACTIVE = 'active',
  COMPLETED = 'completed',
  FAILED = 'failed',
  DELAYED = 'delayed',
  STALLED = 'stalled',
  PAUSED = 'paused',
}

// Job event types for monitoring
export interface JobEvent {
  jobId: string;
  actionId: string;
  accountId: string;
  eventType: 'started' | 'progress' | 'completed' | 'failed' | 'stalled';
  timestamp: string;
  data: JobProgress | ChunkingJobResult | ProcessingJobResult;
  traceId: string;
}

// Queue health metrics
export interface QueueHealth {
  name: string;
  status: 'healthy' | 'degraded' | 'unhealthy';

  jobCounts: {
    waiting: number;
    active: number;
    completed: number;
    failed: number;
    delayed: number;
    stalled: number;
  };

  performance: {
    throughput: number; // Jobs per minute
    avgProcessingTime: number; // Average time to complete job (ms)
    failureRate: number; // Percentage of failed jobs
  };

  workers: {
    active: number;
    total: number;
    memoryUsage: number; // MB
  };

  lastUpdated: string;
}

// Export job options for BullMQ
export interface ChunkingJobOptions {
  attempts?: number;
  backoff?: 'exponential' | 'fixed';
  delay?: number;
  priority?: number;
  removeOnComplete?: number;
  removeOnFail?: number;
  jobId?: string;
}

export interface ProcessingJobOptions extends ChunkingJobOptions {
  // Additional options specific to processing jobs
  batchSize?: number; // For batch database operations
  timeout?: number; // Job timeout in milliseconds
}

// Error types for better error handling
export enum JobErrorType {
  VALIDATION_ERROR = 'validation_error',
  STORAGE_ERROR = 'storage_error',
  PROCESSING_ERROR = 'processing_error',
  TIMEOUT_ERROR = 'timeout_error',
  SYSTEM_ERROR = 'system_error',
  CONFIGURATION_ERROR = 'configuration_error',
}

export interface JobError {
  type: JobErrorType;
  message: string;
  details?: unknown;
  retryable: boolean;
  stage: string;
  timestamp: string;
}
