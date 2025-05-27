/**
 * Consistent Hash Chunker for CSV Processing
 * Creates consistent hash-based chunks to prevent race conditions during parallel ingestion
 */

import { createHash } from 'crypto';
import { CSVRow } from './CSVStreamReader';
import { ValidationResult } from './CSVValidator';
import { DeduplicationResult, DeduplicationAction } from './DeduplicationEngine';
import { PathGenerator } from '../../storage/pathGenerator';
import minioManager from '../../config/minio';
import { logger } from '../../utils/logger';
import { ValidationError } from '../../utils/error';
import { Readable } from 'stream';

export interface ChunkingConfig {
  maxChunkSize: number; // Maximum records per chunk (default: 1000)
  totalChunks: number; // Total number of chunks to create
  hashAlgorithm: string; // Hash algorithm (default: 'sha256')
  hashField: string; // Field to hash for partitioning (default: 'email')
  chunkNaming: ChunkNamingStrategy;
  balanceChunks: boolean; // Try to balance chunk sizes
  minChunkSize: number; // Minimum records per chunk (for balancing)
}

export enum ChunkNamingStrategy {
  SEQUENTIAL = 'sequential', // chunk_001.csv, chunk_002.csv, ...
  HASH_RANGE = 'hash_range', // chunk_00000000-3fffffff.csv, ...
  HYBRID = 'hybrid', // chunk_001_00000000-3fffffff.csv
}

export interface ChunkMetadata {
  chunkId: string;
  chunkIndex: number;
  chunkPath: string;
  hashRangeStart: string;
  hashRangeEnd: string;
  recordCount: number;
  estimatedSize: number; // Estimated file size in bytes
  startRecord: number; // Global record number of first record
  endRecord: number; // Global record number of last record
  createdAt: string;
  status: ChunkStatus;
}

export enum ChunkStatus {
  CREATING = 'creating',
  COMPLETED = 'completed',
  FAILED = 'failed',
  PROCESSING = 'processing',
}

export interface ChunkingResult {
  success: boolean;
  totalRecords: number;
  chunksCreated: number;
  chunkMetadata: ChunkMetadata[];
  hashDistribution: HashDistribution;
  timing: {
    chunkingTime: number;
    uploadTime: number;
    totalTime: number;
  };
  error?: string;
}

export interface HashDistribution {
  totalHashes: number;
  averageRecordsPerChunk: number;
  minRecordsPerChunk: number;
  maxRecordsPerChunk: number;
  standardDeviation: number;
  hashRanges: Array<{
    start: string;
    end: string;
    count: number;
    percentage: number;
  }>;
}

export interface ChunkBuffer {
  chunkIndex: number;
  records: {
    row: CSVRow;
    validationResult: ValidationResult;
    deduplicationResult: DeduplicationResult;
  }[];
  hashRangeStart: string;
  hashRangeEnd: string;
  estimatedSize: number;
}

export class ConsistentHashChunker {
  private config: ChunkingConfig;
  private chunkBuffers: Map<number, ChunkBuffer>;
  private hashRing: HashRing;
  private recordCounter = 0;
  private totalEstimatedSize = 0;
  private startTime = 0;

  constructor(config: ChunkingConfig) {
    this.config = this.validateAndNormalizeConfig(config);
    this.chunkBuffers = new Map();
    this.hashRing = new HashRing(this.config.totalChunks, this.config.hashAlgorithm);
    this.initializeChunkBuffers();
  }

  /**
   * Add a validated and deduplicated row to appropriate chunk
   */
  public addRow(
    row: CSVRow,
    validationResult: ValidationResult,
    deduplicationResult: DeduplicationResult,
    traceId?: string
  ): void {
    const log = traceId ? logger.withTrace(traceId) : logger;

    if (this.startTime === 0) {
      this.startTime = Date.now();
    }

    try {
      // Skip rows that were marked for skipping during deduplication
      if (deduplicationResult.action === DeduplicationAction.SKIP) {
        log.debug('Skipping row due to deduplication', {
          rowNumber: row.rowNumber,
          duplicateKey: deduplicationResult.duplicateKey,
        });
        return;
      }

      // Extract hash key from the row
      const hashKey = this.extractHashKey(validationResult.transformedData, row.rowNumber);
      if (!hashKey) {
        throw new ValidationError(`Unable to extract hash key from row ${row.rowNumber}`);
      }

      // Determine which chunk this row belongs to
      const chunkIndex = this.hashRing.getChunkIndex(hashKey);
      const chunkBuffer = this.chunkBuffers.get(chunkIndex);

      if (!chunkBuffer) {
        throw new Error(`Chunk buffer not found for index ${chunkIndex}`);
      }

      // Check if chunk is at capacity
      if (chunkBuffer.records.length >= this.config.maxChunkSize) {
        log.warn('Chunk buffer at capacity, may cause uneven distribution', {
          chunkIndex,
          currentSize: chunkBuffer.records.length,
          maxSize: this.config.maxChunkSize,
          hashKey,
        });

        // In production, you might want to handle this differently
        // For now, we'll still add it but log a warning
      }

      // Add record to chunk buffer
      chunkBuffer.records.push({
        row,
        validationResult,
        deduplicationResult,
      });

      // Update estimated size (rough calculation)
      const estimatedRowSize = this.estimateRowSize(validationResult.transformedData);
      chunkBuffer.estimatedSize += estimatedRowSize;
      this.totalEstimatedSize += estimatedRowSize;

      this.recordCounter++;

      log.debug('Row added to chunk', {
        rowNumber: row.rowNumber,
        chunkIndex,
        hashKey: hashKey.substring(0, 10) + '...',
        chunkSize: chunkBuffer.records.length,
      });
    } catch (error) {
      log.error('Failed to add row to chunk', {
        error: error instanceof Error ? error.message : String(error),
        rowNumber: row.rowNumber,
      });
      throw error;
    }
  }

  /**
   * Finalize chunking and upload chunks to MinIO
   */
  public async finalizeChunks(
    accountId: string,
    actionId: string,
    traceId?: string
  ): Promise<ChunkingResult> {
    const log = traceId ? logger.withTrace(traceId) : logger;
    const chunkingStartTime = Date.now();

    try {
      log.info('Finalizing chunks', {
        totalRecords: this.recordCounter,
        totalChunks: this.chunkBuffers.size,
        estimatedTotalSize: this.totalEstimatedSize,
      });

      const chunkMetadata: ChunkMetadata[] = [];
      const uploadPromises: Promise<ChunkMetadata>[] = [];

      // Process each chunk buffer
      for (const [chunkIndex, chunkBuffer] of this.chunkBuffers) {
        if (chunkBuffer.records.length === 0) {
          log.debug('Skipping empty chunk', { chunkIndex });
          continue;
        }

        // Create chunk metadata
        const metadata = this.createChunkMetadata(chunkIndex, chunkBuffer, accountId, actionId);

        // Add upload promise
        uploadPromises.push(this.uploadChunkToMinio(chunkBuffer, metadata, traceId));
      }

      const chunkingTime = Date.now() - chunkingStartTime;
      const uploadStartTime = Date.now();

      // Upload all chunks concurrently
      log.info('Uploading chunks to MinIO', {
        chunksToUpload: uploadPromises.length,
      });

      const uploadResults = await Promise.allSettled(uploadPromises);

      const uploadTime = Date.now() - uploadStartTime;

      // Process upload results
      for (const result of uploadResults) {
        if (result.status === 'fulfilled') {
          chunkMetadata.push(result.value);
        } else {
          log.error('Chunk upload failed', {
            error: result.reason,
          });
          throw new Error(`Chunk upload failed: ${result.reason}`);
        }
      }

      // Calculate hash distribution
      const hashDistribution = this.calculateHashDistribution();

      const totalTime = Date.now() - this.startTime;

      const result: ChunkingResult = {
        success: true,
        totalRecords: this.recordCounter,
        chunksCreated: chunkMetadata.length,
        chunkMetadata: chunkMetadata.sort((a, b) => a.chunkIndex - b.chunkIndex),
        hashDistribution,
        timing: {
          chunkingTime,
          uploadTime,
          totalTime,
        },
      };

      log.info('Chunking completed successfully', {
        result: {
          totalRecords: result.totalRecords,
          chunksCreated: result.chunksCreated,
          avgRecordsPerChunk: hashDistribution.averageRecordsPerChunk,
          totalTime: result.timing.totalTime,
        },
      });

      return result;
    } catch (error) {
      log.error('Chunking finalization failed', {
        error: error instanceof Error ? error.message : String(error),
        recordsProcessed: this.recordCounter,
      });

      return {
        success: false,
        totalRecords: this.recordCounter,
        chunksCreated: 0,
        chunkMetadata: [],
        hashDistribution: this.calculateHashDistribution(),
        timing: {
          chunkingTime: Date.now() - chunkingStartTime,
          uploadTime: 0,
          totalTime: Date.now() - this.startTime,
        },
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Get current chunking progress
   */
  public getProgress(): {
    recordsProcessed: number;
    chunksInProgress: number;
    averageChunkSize: number;
    estimatedTotalSize: number;
  } {
    const nonEmptyChunks = Array.from(this.chunkBuffers.values()).filter(
      buffer => buffer.records.length > 0
    );

    const averageChunkSize =
      nonEmptyChunks.length > 0 ? this.recordCounter / nonEmptyChunks.length : 0;

    return {
      recordsProcessed: this.recordCounter,
      chunksInProgress: nonEmptyChunks.length,
      averageChunkSize,
      estimatedTotalSize: this.totalEstimatedSize,
    };
  }

  /**
   * Extract hash key from row data
   */
  private extractHashKey(data: Record<string, unknown>, rowNumber: number): string | null {
    const value = data[this.config.hashField];

    if (value === undefined || value === null || value === '') {
      logger.warn('Hash field not found or empty', {
        rowNumber,
        hashField: this.config.hashField,
        availableFields: Object.keys(data),
      });
      return null;
    }

    // Normalize the hash key (lowercase, trim)
    return String(value).toLowerCase().trim();
  }

  /**
   * Initialize chunk buffers for all expected chunks
   */
  private initializeChunkBuffers(): void {
    for (let i = 0; i < this.config.totalChunks; i++) {
      const hashRange = this.hashRing.getHashRange(i);

      this.chunkBuffers.set(i, {
        chunkIndex: i,
        records: [],
        hashRangeStart: hashRange.start,
        hashRangeEnd: hashRange.end,
        estimatedSize: 0,
      });
    }

    logger.info('Initialized chunk buffers', {
      totalChunks: this.config.totalChunks,
      maxChunkSize: this.config.maxChunkSize,
      hashAlgorithm: this.config.hashAlgorithm,
    });
  }

  /**
   * Create chunk metadata
   */
  private createChunkMetadata(
    chunkIndex: number,
    chunkBuffer: ChunkBuffer,
    accountId: string,
    actionId: string
  ): ChunkMetadata {
    const chunkId = this.generateChunkId(chunkIndex);
    const chunkPath = this.generateChunkPath(accountId, actionId, chunkIndex);
    let startRecord = 0;
    if (
      chunkBuffer.records.length > 0 &&
      chunkBuffer?.records?.[0]?.row !== undefined &&
      chunkBuffer?.records[0].row.rowNumber !== undefined
    ) {
      startRecord = chunkBuffer!.records[0].row.rowNumber;
    }
    const endRecord =
      chunkBuffer.records.length > 0 &&
      chunkBuffer?.records?.[chunkBuffer?.records?.length - 1]?.row !== undefined &&
      chunkBuffer?.records?.[chunkBuffer?.records?.length - 1]?.row.rowNumber !== undefined
        ? chunkBuffer?.records?.[chunkBuffer?.records?.length - 1]?.row.rowNumber
        : 0;

    return {
      chunkId,
      chunkIndex,
      chunkPath,
      hashRangeStart: chunkBuffer.hashRangeStart,
      hashRangeEnd: chunkBuffer.hashRangeEnd,
      recordCount: chunkBuffer.records.length,
      estimatedSize: chunkBuffer.estimatedSize,
      startRecord,
      endRecord: endRecord ?? 0,
      createdAt: new Date().toISOString(),
      status: ChunkStatus.CREATING,
    };
  }

  /**
   * Upload chunk to MinIO
   */
  private async uploadChunkToMinio(
    chunkBuffer: ChunkBuffer,
    metadata: ChunkMetadata,
    traceId?: string
  ): Promise<ChunkMetadata> {
    const log = traceId ? logger.withTrace(traceId) : logger;

    try {
      log.debug('Uploading chunk to MinIO', {
        chunkIndex: metadata.chunkIndex,
        recordCount: metadata.recordCount,
        chunkPath: metadata.chunkPath,
      });

      // Convert chunk records to CSV format
      const csvContent = this.convertChunkToCSV(chunkBuffer);

      // Create readable stream from CSV content
      const csvStream = Readable.from([Buffer.from(csvContent, 'utf8')]);

      // Upload to MinIO
      const uploadResult = await minioManager.uploadStream(
        metadata.chunkPath,
        csvStream,
        Buffer.byteLength(csvContent, 'utf8'),
        {
          'chunk-index': metadata.chunkIndex.toString(),
          'record-count': metadata.recordCount.toString(),
          'hash-range-start': metadata.hashRangeStart,
          'hash-range-end': metadata.hashRangeEnd,
          'chunk-id': metadata.chunkId,
          'content-type': 'text/csv',
        },
        traceId
      );

      // Update metadata with upload results
      const updatedMetadata = {
        ...metadata,
        estimatedSize: Buffer.byteLength(csvContent, 'utf8'),
        status: ChunkStatus.COMPLETED,
      };

      log.info('Chunk uploaded successfully', {
        chunkIndex: metadata.chunkIndex,
        chunkPath: metadata.chunkPath,
        recordCount: metadata.recordCount,
        actualSize: updatedMetadata.estimatedSize,
        etag: uploadResult.etag,
      });

      return updatedMetadata;
    } catch (error) {
      log.error('Failed to upload chunk', {
        error: error instanceof Error ? error.message : String(error),
        chunkIndex: metadata.chunkIndex,
        chunkPath: metadata.chunkPath,
      });

      return {
        ...metadata,
        status: ChunkStatus.FAILED,
      };
    }
  }

  /**
   * Convert chunk buffer to CSV string
   */
  private convertChunkToCSV(chunkBuffer: ChunkBuffer): string {
    if (chunkBuffer.records.length === 0) {
      return '';
    }

    // Get field names from first record
    const firstRecord = chunkBuffer.records[0]?.validationResult?.transformedData;
    const fieldNames = firstRecord ? Object.keys(firstRecord) : [];

    // Create CSV header
    const header = fieldNames.map(field => `"${field}"`).join(',');

    // Create CSV rows
    const rows = chunkBuffer.records.map(record => {
      const data = record.validationResult.transformedData;
      return fieldNames
        .map(field => {
          const value = data[field];
          const stringValue = value === null || value === undefined ? '' : String(value);
          // Escape quotes and wrap in quotes
          return `"${stringValue.replace(/"/g, '""')}"`;
        })
        .join(',');
    });

    return [header, ...rows].join('\n');
  }

  /**
   * Generate chunk ID
   */
  private generateChunkId(chunkIndex: number): string {
    const timestamp = Date.now();
    const hash = createHash('md5')
      .update(`${chunkIndex}-${timestamp}-${this.config.hashField}`)
      .digest('hex')
      .substring(0, 8);

    return `chunk-${chunkIndex.toString().padStart(3, '0')}-${hash}`;
  }

  /**
   * Generate chunk file path
   */
  private generateChunkPath(accountId: string, actionId: string, chunkIndex: number): string {
    const fileName = this.generateChunkFileName(chunkIndex);
    return PathGenerator.generateChunkFilePath(
      accountId,
      actionId,
      'processing',
      chunkIndex
    ).replace(`chunk${chunkIndex}.csv`, fileName);
  }

  /**
   * Generate chunk file name based on naming strategy
   */
  private generateChunkFileName(chunkIndex: number): string {
    const chunkBuffer = this.chunkBuffers.get(chunkIndex)!;

    switch (this.config.chunkNaming) {
      case ChunkNamingStrategy.SEQUENTIAL:
        return `chunk_${chunkIndex.toString().padStart(3, '0')}.csv`;

      case ChunkNamingStrategy.HASH_RANGE:
        return `chunk_${chunkBuffer.hashRangeStart}-${chunkBuffer.hashRangeEnd}.csv`;

      case ChunkNamingStrategy.HYBRID:
        return `chunk_${chunkIndex.toString().padStart(3, '0')}_${chunkBuffer.hashRangeStart}-${chunkBuffer.hashRangeEnd}.csv`;

      default:
        return `chunk_${chunkIndex.toString().padStart(3, '0')}.csv`;
    }
  }

  /**
   * Estimate row size in bytes
   */
  private estimateRowSize(data: Record<string, unknown>): number {
    let size = 0;

    for (const [key, value] of Object.entries(data)) {
      size += key.length; // Field name
      size += 1; // Comma or newline

      if (value !== null && value !== undefined) {
        size += String(value).length; // Field value
      }
    }

    return size + 10; // Extra overhead for quotes, escaping, etc.
  }

  /**
   * Calculate hash distribution statistics
   */
  private calculateHashDistribution(): HashDistribution {
    const chunkSizes = Array.from(this.chunkBuffers.values()).map(buffer => buffer.records.length);

    const nonEmptyChunks = chunkSizes.filter(size => size > 0);

    if (nonEmptyChunks.length === 0) {
      return {
        totalHashes: 0,
        averageRecordsPerChunk: 0,
        minRecordsPerChunk: 0,
        maxRecordsPerChunk: 0,
        standardDeviation: 0,
        hashRanges: [],
      };
    }

    const total = nonEmptyChunks.reduce((sum, size) => sum + size, 0);
    const average = total / nonEmptyChunks.length;
    const min = Math.min(...nonEmptyChunks);
    const max = Math.max(...nonEmptyChunks);

    // Calculate standard deviation
    const variance =
      nonEmptyChunks.reduce((sum, size) => {
        return sum + Math.pow(size - average, 2);
      }, 0) / nonEmptyChunks.length;

    const standardDeviation = Math.sqrt(variance);

    // Create hash ranges
    const hashRanges = Array.from(this.chunkBuffers.entries())
      .filter(([_, buffer]) => buffer.records.length > 0)
      .map(([index, buffer]) => ({
        start: buffer.hashRangeStart,
        end: buffer.hashRangeEnd,
        count: buffer.records.length,
        percentage: total > 0 ? (buffer.records.length / total) * 100 : 0,
      }));

    return {
      totalHashes: this.recordCounter,
      averageRecordsPerChunk: average,
      minRecordsPerChunk: min,
      maxRecordsPerChunk: max,
      standardDeviation,
      hashRanges,
    };
  }

  /**
   * Validate and normalize chunking configuration
   */
  private validateAndNormalizeConfig(config: ChunkingConfig): ChunkingConfig {
    const errors: string[] = [];

    if (config.maxChunkSize < 1) {
      errors.push('maxChunkSize must be at least 1');
    }

    if (config.totalChunks < 1) {
      errors.push('totalChunks must be at least 1');
    }

    if (config.maxChunkSize > 10000) {
      errors.push('maxChunkSize should not exceed 10000 for optimal performance');
    }

    if (config.totalChunks > 1000) {
      errors.push('totalChunks should not exceed 1000 for optimal performance');
    }

    if (!config.hashField || config.hashField.trim() === '') {
      errors.push('hashField is required');
    }

    if (errors.length > 0) {
      throw new ValidationError(`Invalid chunking configuration: ${errors.join(', ')}`);
    }

    return {
      maxChunkSize: Math.min(config.maxChunkSize, 1000), // Enforce max as requested
      totalChunks: config.totalChunks,
      hashAlgorithm: config.hashAlgorithm || 'sha256',
      hashField: config.hashField.trim(),
      chunkNaming: config.chunkNaming || ChunkNamingStrategy.SEQUENTIAL,
      balanceChunks: config.balanceChunks ?? true,
      minChunkSize: config.minChunkSize || Math.floor(config.maxChunkSize * 0.1),
    };
  }
}

/**
 * Hash Ring implementation for consistent hashing
 */
class HashRing {
  private totalChunks: number;
  private hashAlgorithm: string;
  private hashSpace: bigint;
  private chunkSize: bigint;

  constructor(totalChunks: number, hashAlgorithm: string = 'sha256') {
    this.totalChunks = totalChunks;
    this.hashAlgorithm = hashAlgorithm;

    // For SHA-256, we have 2^256 possible hash values
    // We'll use a smaller space for practical purposes
    this.hashSpace = BigInt('0xFFFFFFFFFFFFFFFF'); // 64-bit space
    this.chunkSize = this.hashSpace / BigInt(totalChunks);
  }

  /**
   * Get chunk index for a given key
   */
  public getChunkIndex(key: string): number {
    const hash = this.hashKey(key);
    const hashBigInt = BigInt('0x' + hash.substring(0, 16)); // Use first 64 bits
    const chunkIndex = Number(hashBigInt / this.chunkSize);

    // Ensure we don't exceed total chunks due to rounding
    return Math.min(chunkIndex, this.totalChunks - 1);
  }

  /**
   * Get hash range for a given chunk index
   */
  public getHashRange(chunkIndex: number): { start: string; end: string } {
    const startHash = BigInt(chunkIndex) * this.chunkSize;
    const endHash =
      chunkIndex === this.totalChunks - 1
        ? this.hashSpace
        : (BigInt(chunkIndex) + BigInt(1)) * this.chunkSize - BigInt(1);

    return {
      start: startHash.toString(16).padStart(16, '0'),
      end: endHash.toString(16).padStart(16, '0'),
    };
  }

  /**
   * Hash a key using the specified algorithm
   */
  private hashKey(key: string): string {
    return createHash(this.hashAlgorithm).update(key).digest('hex');
  }
}

// Export utility functions
export const ChunkingUtils = {
  /**
   * Create default chunking config
   */
  createDefaultConfig(totalRecords: number): ChunkingConfig {
    // Calculate optimal number of chunks based on record count
    const optimalChunks = Math.max(1, Math.min(100, Math.ceil(totalRecords / 1000)));

    return {
      maxChunkSize: 1000,
      totalChunks: optimalChunks,
      hashAlgorithm: 'sha256',
      hashField: 'id',
      chunkNaming: ChunkNamingStrategy.SEQUENTIAL,
      balanceChunks: true,
      minChunkSize: 100,
    };
  },

  /**
   * Calculate optimal chunk configuration
   */
  calculateOptimalConfig(
    totalRecords: number,
    targetChunkSize: number = 1000,
    maxChunks: number = 100
  ): ChunkingConfig {
    const optimalChunks = Math.max(
      1,
      Math.min(maxChunks, Math.ceil(totalRecords / targetChunkSize))
    );
    const adjustedChunkSize = Math.ceil(totalRecords / optimalChunks);

    return {
      maxChunkSize: Math.min(adjustedChunkSize, 1000),
      totalChunks: optimalChunks,
      hashAlgorithm: 'sha256',
      hashField: 'id',
      chunkNaming: ChunkNamingStrategy.SEQUENTIAL,
      balanceChunks: true,
      minChunkSize: Math.floor(adjustedChunkSize * 0.1),
    };
  },

  /**
   * Estimate memory usage for chunking
   */
  estimateMemoryUsage(config: ChunkingConfig, avgRowSize: number = 500): number {
    const maxMemoryPerChunk = config.maxChunkSize * avgRowSize;
    const totalMemory = config.totalChunks * maxMemoryPerChunk;
    return totalMemory / (1024 * 1024); // Convert to MB
  },

  /**
   * Validate hash distribution quality
   */
  validateHashDistribution(distribution: HashDistribution): {
    isBalanced: boolean;
    issues: string[];
    recommendations: string[];
  } {
    const issues: string[] = [];
    const recommendations: string[] = [];

    const coefficientOfVariation =
      distribution.standardDeviation / distribution.averageRecordsPerChunk;

    if (coefficientOfVariation > 0.3) {
      issues.push('High variation in chunk sizes');
      recommendations.push(
        'Consider increasing the number of chunks or using a different hash field'
      );
    }

    const emptyChunks = distribution.hashRanges.length;
    if (emptyChunks === 0) {
      issues.push('All chunks are empty');
      recommendations.push('Check hash field extraction and data validity');
    }

    const minMaxRatio = distribution.minRecordsPerChunk / distribution.maxRecordsPerChunk;
    if (minMaxRatio < 0.5) {
      issues.push('Significant imbalance between smallest and largest chunks');
      recommendations.push('Consider using more chunks or different hash distribution');
    }

    return {
      isBalanced: issues.length === 0,
      issues,
      recommendations,
    };
  },
};
