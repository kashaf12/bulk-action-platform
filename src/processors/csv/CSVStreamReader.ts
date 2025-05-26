/**
 * CSV Stream Reader for MinIO
 * Memory-efficient streaming CSV reader with validation and progress tracking
 */

import { Readable, Transform } from 'stream';
import { pipeline } from 'stream/promises';
import csv from 'csv-parser';
import minioManager from '../../config/minio';
import { logger } from '../../utils/logger';
import { ValidationError } from '../../utils/error';
import { PathGenerator } from '../../storage/pathGenerator';

export interface CSVStreamOptions {
  maxFileSize?: number; // Maximum file size in bytes (default: 100MB)
  maxRowSize?: number; // Maximum row size in bytes (default: 1MB)
  encoding?: BufferEncoding; // File encoding (default: 'utf8')
  skipEmptyLines?: boolean; // Skip empty lines (default: true)
  delimiter?: string; // CSV delimiter (default: ',')
  quote?: string; // Quote character (default: '"')
  escape?: string; // Escape character (default: '"')
  maxRows?: number; // Maximum number of rows to process (default: unlimited)
}

export interface CSVRow {
  data: Record<string, string>;
  rowNumber: number;
  rawLine: string;
  byteOffset: number;
}

export interface CSVHeader {
  columns: string[];
  normalizedColumns: string[]; // Trimmed and lowercased
  columnMap: Map<string, number>; // Column name to index mapping
  isValid: boolean;
  errors: string[];
}

export interface CSVStreamStats {
  totalBytes: number;
  processedBytes: number;
  totalRows: number;
  processedRows: number;
  validRows: number;
  invalidRows: number;
  emptyRows: number;
  startTime: number;
  endTime?: number;
  processingRate: number; // Bytes per second
  rowRate: number; // Rows per second
}

export interface CSVStreamProgress {
  percentage: number; // 0-100
  processedBytes: number;
  totalBytes: number;
  processedRows: number;
  estimatedTotalRows: number;
  estimatedTimeRemaining: number; // milliseconds
  currentRate: number; // rows per second
}

export class CSVStreamReader {
  private options: Required<CSVStreamOptions>;
  private stats: CSVStreamStats;
  private header: CSVHeader | null = null;
  private isAborted = false;
  private abortController = new AbortController();

  constructor(options: CSVStreamOptions = {}) {
    this.options = {
      maxFileSize: options.maxFileSize || 100 * 1024 * 1024, // 100MB
      maxRowSize: options.maxRowSize || 1024 * 1024, // 1MB
      encoding: options.encoding || 'utf8',
      skipEmptyLines: options.skipEmptyLines ?? true,
      delimiter: options.delimiter || ',',
      quote: options.quote || '"',
      escape: options.escape || '"',
      maxRows: options.maxRows || Number.MAX_SAFE_INTEGER,
    };

    this.stats = this.initializeStats();
  }

  /**
   * Stream CSV file from MinIO and process rows
   */
  public async streamFromMinIO(
    filePath: string,
    onRow: (row: CSVRow) => Promise<void> | void,
    onProgress?: (progress: CSVStreamProgress) => void,
    traceId?: string
  ): Promise<CSVStreamStats> {
    const log = traceId ? logger.withTrace(traceId) : logger;

    try {
      log.info('Starting CSV stream from MinIO', {
        filePath,
        options: this.options,
      });

      // Validate file path
      if (!PathGenerator.isValidFilePath(filePath)) {
        throw new ValidationError(`Invalid file path format: ${filePath}`);
      }

      // Get file metadata
      const fileMetadata = await minioManager.getFileMetadata(filePath, traceId);
      this.stats.totalBytes = fileMetadata.size;

      // Validate file size
      if (fileMetadata.size > this.options.maxFileSize) {
        throw new ValidationError(
          `File size ${fileMetadata.size} exceeds maximum allowed size ${this.options.maxFileSize}`
        );
      }

      // Get file stream from MinIO
      const minioStream = await minioManager.getFileStream(filePath, traceId);

      // Start processing
      this.stats.startTime = Date.now();
      await this.processStream(minioStream, onRow, onProgress, traceId);

      this.stats.endTime = Date.now();
      this.updateProcessingRates();

      log.info('CSV stream processing completed', {
        filePath,
        stats: this.getStreamStats(),
      });

      return this.getStreamStats();
    } catch (error) {
      this.stats.endTime = Date.now();

      log.error('CSV stream processing failed', {
        error: error instanceof Error ? error.message : String(error),
        filePath,
        stats: this.getStreamStats(),
      });

      throw error;
    }
  }

  /**
   * Validate CSV file structure without full processing
   */
  public async validateStructure(
    filePath: string,
    requiredColumns: string[],
    traceId?: string
  ): Promise<{ isValid: boolean; header: CSVHeader; errors: string[] }> {
    const log = traceId ? logger.withTrace(traceId) : logger;

    try {
      log.info('Validating CSV structure', {
        filePath,
        requiredColumns,
      });

      // Get file stream
      const stream = await minioManager.getFileStream(filePath, traceId);

      // Read only the first few lines to validate structure
      let headerProcessed = false;
      let lineCount = 0;
      const maxLinesToCheck = 5;
      let buffer = '';
      const errors: string[] = [];

      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('CSV structure validation timeout'));
        }, 10000); // 10 second timeout

        stream.on('data', (chunk: Buffer) => {
          if (headerProcessed && lineCount >= maxLinesToCheck) {
            clearTimeout(timeout);
            return;
          }

          buffer += chunk.toString(this.options.encoding);
          const lines = buffer.split('\n');

          // Keep the last incomplete line in buffer
          buffer = lines.pop() || '';

          for (const line of lines) {
            if (lineCount >= maxLinesToCheck) break;

            if (!headerProcessed) {
              // Process header
              this.header = this.parseHeader(line.trim());
              headerProcessed = true;

              // Validate required columns
              const missingColumns = this.validateRequiredColumns(requiredColumns);
              if (missingColumns.length > 0) {
                errors.push(`Missing required columns: ${missingColumns.join(', ')}`);
              }

              // Check for duplicate columns
              const duplicates = this.findDuplicateColumns();
              if (duplicates.length > 0) {
                errors.push(`Duplicate columns found: ${duplicates.join(', ')}`);
              }
            } else if (line.trim()) {
              // Validate a few data rows
              try {
                this.validateRowStructure(line, lineCount + 1);
              } catch (error) {
                errors.push(
                  `Row ${lineCount + 1}: ${error instanceof Error ? error.message : String(error)}`
                );
              }
            }

            lineCount++;
          }

          if (headerProcessed && lineCount >= maxLinesToCheck) {
            clearTimeout(timeout);

            const result = {
              isValid: errors.length === 0 && this.header!.isValid,
              header: this.header!,
              errors: [...this.header!.errors, ...errors],
            };

            log.info('CSV structure validation completed', {
              filePath,
              isValid: result.isValid,
              errorCount: result.errors.length,
              columnCount: this.header?.columns.length || 0,
            });

            resolve(result);
          }
        });

        stream.on('error', error => {
          clearTimeout(timeout);
          reject(error);
        });

        stream.on('end', () => {
          clearTimeout(timeout);

          if (!this.header) {
            reject(new Error('No header found in CSV file'));
            return;
          }

          const result = {
            isValid: errors.length === 0 && this.header.isValid,
            header: this.header,
            errors: [...this.header.errors, ...errors],
          };

          resolve(result);
        });
      });
    } catch (error) {
      log.error('CSV structure validation failed', {
        error: error instanceof Error ? error.message : String(error),
        filePath,
      });
      throw error;
    }
  }

  /**
   * Abort the current streaming operation
   */
  public abort(): void {
    this.isAborted = true;
    this.abortController.abort();
    logger.info('CSV stream reader aborted');
  }

  /**
   * Get current streaming statistics
   */
  public getStreamStats(): CSVStreamStats {
    return { ...this.stats };
  }

  /**
   * Get CSV header information
   */
  public getHeader(): CSVHeader | null {
    return this.header ? { ...this.header } : null;
  }

  /**
   * Process the MinIO stream
   */
  private async processStream(
    stream: NodeJS.ReadableStream,
    onRow: (row: CSVRow) => Promise<void> | void,
    onProgress?: (progress: CSVStreamProgress) => void,
    traceId?: string
  ): Promise<void> {
    const log = traceId ? logger.withTrace(traceId) : logger;

    return new Promise((resolve, reject) => {
      let rowNumber = 0;
      let byteOffset = 0;
      let headerProcessed = false;
      let lastProgressUpdate = 0;
      const progressInterval = 1000; // Update progress every 1000 rows

      // Create transform stream for progress tracking
      const stats = this.stats;
      const isAborted = () => this.isAborted;

      const progressTracker = new Transform({
        transform(chunk, encoding, callback) {
          if (isAborted()) {
            callback(new Error('Stream aborted'));
            return;
          }

          byteOffset += chunk.length;
          stats.processedBytes = byteOffset;

          this.push(chunk);
          callback();
        },
      });

      // Create CSV parser
      const csvParser = csv({
        separator: this.options.delimiter,
        quote: this.options.quote,
        escape: this.options.escape,
        // skipEmptyLines: this.options.skipEmptyLines, // Not supported by csv-parser
        maxRowBytes: this.options.maxRowSize,
      });

      // Handle CSV parsing
      csvParser.on('headers', (headers: string[]) => {
        if (!headerProcessed) {
          this.header = this.parseHeader(headers.join(this.options.delimiter));
          headerProcessed = true;

          log.debug('CSV headers processed', {
            columns: this.header.columns,
            isValid: this.header.isValid,
          });

          if (!this.header.isValid) {
            csvParser.destroy(new Error(`Invalid CSV header: ${this.header.errors.join(', ')}`));
            return;
          }
        }
      });

      csvParser.on('data', async (data: Record<string, string>) => {
        if (this.isAborted) {
          return;
        }

        rowNumber++;
        this.stats.processedRows = rowNumber;
        this.stats.totalRows = rowNumber;

        // Check row limit
        if (rowNumber > this.options.maxRows) {
          log.warn('Maximum row limit reached', {
            maxRows: this.options.maxRows,
            processedRows: rowNumber,
          });
          csvParser.destroy();
          return;
        }

        try {
          // Create CSV row object
          const csvRow: CSVRow = {
            data,
            rowNumber,
            rawLine: Object.values(data).join(this.options.delimiter), // Approximate reconstruction
            byteOffset,
          };
          // Process row
          await onRow(csvRow);
          this.stats.validRows++;

          // Update progress
          if (
            onProgress &&
            (rowNumber % progressInterval === 0 || Date.now() - lastProgressUpdate > 5000)
          ) {
            const progress = this.calculateProgress();
            onProgress(progress);
            lastProgressUpdate = Date.now();
          }
        } catch (error) {
          this.stats.invalidRows++;

          log.warn('Error processing CSV row', {
            rowNumber,
            error: error instanceof Error ? error.message : String(error),
          });

          // Continue processing other rows unless it's a critical error
          if (error instanceof ValidationError && error.message.includes('critical')) {
            csvParser.destroy(error);
            return;
          }
        }
      });

      csvParser.on('error', error => {
        log.error('CSV parser error', {
          error: error.message,
          processedRows: this.stats.processedRows,
          processedBytes: this.stats.processedBytes,
        });
        reject(error);
      });

      csvParser.on('end', () => {
        log.info('CSV parsing completed', {
          totalRows: this.stats.processedRows,
          validRows: this.stats.validRows,
          invalidRows: this.stats.invalidRows,
          processedBytes: this.stats.processedBytes,
        });

        // Final progress update
        if (onProgress) {
          const finalProgress = this.calculateProgress();
          finalProgress.percentage = 100;
          onProgress(finalProgress);
        }

        resolve();
      });

      // Set up abort signal
      this.abortController.signal.addEventListener('abort', () => {
        progressTracker.destroy();
        csvParser.destroy();
        reject(new Error('Stream processing aborted'));
      });

      // Start streaming pipeline
      pipeline(stream as Readable, progressTracker, csvParser).catch(reject);
    });
  }

  /**
   * Parse CSV header line
   */
  private parseHeader(headerLine: string): CSVHeader {
    const errors: string[] = [];

    // Split header by delimiter
    const columns = headerLine.split(this.options.delimiter).map(
      col => col.trim().replace(/^["']|["']$/g, '') // Remove quotes and trim
    );

    // Normalize column names (lowercase, trimmed)
    const normalizedColumns = columns.map(col => col.toLowerCase().trim());

    // Create column mapping
    const columnMap = new Map<string, number>();
    normalizedColumns.forEach((col, index) => {
      columnMap.set(col, index);
    });

    // Validate header
    if (columns.length === 0) {
      errors.push('No columns found in header');
    }

    if (columns.some(col => !col || col.trim() === '')) {
      errors.push('Empty column names found in header');
    }

    // Check for suspicious content
    const suspiciousPatterns = [/^=/, /^@/, /^\+/, /^-/, /<script/i, /javascript:/i];
    for (const column of columns) {
      if (suspiciousPatterns.some(pattern => pattern.test(column))) {
        errors.push(`Potentially malicious content in column: ${column}`);
      }
    }

    return {
      columns,
      normalizedColumns,
      columnMap,
      isValid: errors.length === 0,
      errors,
    };
  }

  /**
   * Validate required columns are present
   */
  private validateRequiredColumns(requiredColumns: string[]): string[] {
    if (!this.header) {
      return requiredColumns;
    }

    const normalizedRequired = requiredColumns.map(col => col.toLowerCase().trim());
    const missing: string[] = [];

    for (const required of normalizedRequired) {
      if (!this.header.columnMap.has(required)) {
        missing.push(required);
      }
    }

    return missing;
  }

  /**
   * Find duplicate column names
   */
  private findDuplicateColumns(): string[] {
    if (!this.header) {
      return [];
    }

    const seen = new Set<string>();
    const duplicates: string[] = [];

    for (const col of this.header.normalizedColumns) {
      if (seen.has(col)) {
        duplicates.push(col);
      } else {
        seen.add(col);
      }
    }

    return duplicates;
  }

  /**
   * Validate individual row structure
   */
  private validateRowStructure(line: string, rowNumber: number): void {
    const cells = line.split(this.options.delimiter);

    if (!this.header) {
      throw new Error('Header not processed');
    }

    if (cells.length !== this.header.columns.length) {
      throw new Error(
        `Column count mismatch. Expected ${this.header.columns.length}, got ${cells.length}`
      );
    }

    // Check for oversized cells
    for (let i = 0; i < cells.length; i++) {
      if (
        cells &&
        Array.isArray(cells?.[i]) &&
        cells[i]!.length > this.options.maxRowSize / this.header.columns.length
      ) {
        throw new Error(`Cell ${i} exceeds maximum size`);
      }
    }
  }

  /**
   * Calculate current processing progress
   */
  private calculateProgress(): CSVStreamProgress {
    const now = Date.now();
    const elapsed = now - this.stats.startTime;
    const bytesPerMs = elapsed > 0 ? this.stats.processedBytes / elapsed : 0;
    const rowsPerMs = elapsed > 0 ? this.stats.processedRows / elapsed : 0;

    let percentage = 0;
    let estimatedTotalRows = this.stats.processedRows;
    let estimatedTimeRemaining = 0;

    if (this.stats.totalBytes > 0) {
      percentage = (this.stats.processedBytes / this.stats.totalBytes) * 100;

      if (this.stats.processedBytes > 0) {
        const avgBytesPerRow = this.stats.processedBytes / this.stats.processedRows;
        estimatedTotalRows = Math.ceil(this.stats.totalBytes / avgBytesPerRow);

        const remainingBytes = this.stats.totalBytes - this.stats.processedBytes;
        estimatedTimeRemaining = bytesPerMs > 0 ? remainingBytes / bytesPerMs : 0;
      }
    }

    return {
      percentage: Math.min(100, Math.max(0, percentage)),
      processedBytes: this.stats.processedBytes,
      totalBytes: this.stats.totalBytes,
      processedRows: this.stats.processedRows,
      estimatedTotalRows,
      estimatedTimeRemaining,
      currentRate: rowsPerMs * 1000, // rows per second
    };
  }

  /**
   * Update processing rate statistics
   */
  private updateProcessingRates(): void {
    if (!this.stats.endTime) {
      return;
    }

    const durationMs = this.stats.endTime - this.stats.startTime;

    if (durationMs > 0) {
      this.stats.processingRate = this.stats.processedBytes / (durationMs / 1000); // bytes per second
      this.stats.rowRate = this.stats.processedRows / (durationMs / 1000); // rows per second
    }
  }

  /**
   * Initialize streaming statistics
   */
  private initializeStats(): CSVStreamStats {
    return {
      totalBytes: 0,
      processedBytes: 0,
      totalRows: 0,
      processedRows: 0,
      validRows: 0,
      invalidRows: 0,
      emptyRows: 0,
      startTime: 0,
      endTime: undefined,
      processingRate: 0,
      rowRate: 0,
    };
  }
}

// Export utility functions
export const CSVStreamUtils = {
  /**
   * Estimate row count from file size
   */
  estimateRowCount(fileSize: number, avgRowSize: number = 150): number {
    return Math.ceil(fileSize / avgRowSize);
  },

  /**
   * Validate CSV file extension
   */
  isCSVFile(filename: string): boolean {
    const ext = filename.toLowerCase().split('.').pop();
    return ext === 'csv' || ext === 'txt';
  },

  /**
   * Sanitize column name for database use
   */
  sanitizeColumnName(columnName: string): string {
    return columnName
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9_]/g, '_')
      .replace(/_{2,}/g, '_')
      .replace(/^_|_$/g, '');
  },
};
