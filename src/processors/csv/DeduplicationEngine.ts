/**
 * CSV Deduplication Engine
 * Handles email-based deduplication within CSV files with memory-efficient processing
 */

import { CSVRow } from './CSVStreamReader';
import { ValidationResult } from './CSVValidator';
import { logger } from '../../utils/logger';
import { ValidationError } from '../../utils/error';

export interface DeduplicationConfig {
  enabled: boolean;
  strategy: DeduplicationStrategy;
  keyField: string; // Field to use for deduplication (default: 'email')
  caseInsensitive: boolean; // Case-insensitive comparison
  trimWhitespace: boolean; // Trim whitespace before comparison
  normalizeKeys: boolean; // Normalize keys (lowercase, trim)
  maxDuplicatesTracked: number; // Maximum duplicates to track in memory
}

export enum DeduplicationStrategy {
  KEEP_FIRST = 'keep_first', // Keep first occurrence, skip rest
  KEEP_LAST = 'keep_last', // Keep last occurrence, skip previous
  MERGE_DATA = 'merge_data', // Merge non-empty fields (future enhancement)
  MARK_ALL = 'mark_all', // Mark all duplicates for review
}

export interface DeduplicationResult {
  action: DeduplicationAction;
  rowNumber: number;
  duplicateKey: string;
  firstOccurrence?: number; // Row number of first occurrence
  duplicateCount: number; // How many times this key appears
  mergedData?: Record<string, unknown>; // For merge strategy
}

export enum DeduplicationAction {
  KEEP = 'keep', // Keep this row
  SKIP = 'skip', // Skip this row (duplicate)
  REPLACE = 'replace', // Replace previous occurrence
  REVIEW = 'review', // Mark for manual review
}

export interface DeduplicationStats {
  totalRows: number;
  uniqueRows: number;
  duplicateRows: number;
  skippedRows: number;
  duplicateKeys: number; // Number of unique keys that have duplicates

  // Detailed breakdown
  duplicateBreakdown: {
    twoOccurrences: number; // Keys with exactly 2 occurrences
    threeToFive: number; // Keys with 3-5 occurrences
    moreThanFive: number; // Keys with 5+ occurrences
  };

  // Memory usage tracking
  memoryUsage: {
    keysTracked: number;
    approximateMemoryMB: number;
  };

  // Performance metrics
  performance: {
    processingTimeMs: number;
    avgTimePerRow: number;
    keyLookupTime: number;
  };
}

export interface DuplicateEntry {
  key: string;
  firstRowNumber: number;
  lastRowNumber: number;
  occurrences: number;
  firstRowData: Record<string, unknown>;
  lastRowData: Record<string, unknown>;
  allOccurrences: Array<{
    rowNumber: number;
    data: Record<string, unknown>;
  }>;
}

export class DeduplicationEngine {
  private config: DeduplicationConfig;
  private stats: DeduplicationStats;
  private duplicateTracker: Map<string, DuplicateEntry>;
  private processedKeys: Set<string>;
  private startTime: number = 0;

  constructor(config: DeduplicationConfig) {
    this.config = config;
    this.stats = this.initializeStats();
    this.duplicateTracker = new Map();
    this.processedKeys = new Set();
  }

  /**
   * Process a CSV row for deduplication
   */
  public processRow(
    row: CSVRow,
    validationResult: ValidationResult,
    traceId?: string
  ): DeduplicationResult {
    const log = traceId ? logger.withTrace(traceId) : logger;

    if (this.startTime === 0) {
      this.startTime = Date.now();
    }

    const startRowTime = Date.now();

    try {
      // Skip deduplication if disabled
      if (!this.config.enabled) {
        this.stats.totalRows++;
        this.stats.uniqueRows++;
        return {
          action: DeduplicationAction.KEEP,
          rowNumber: row.rowNumber,
          duplicateKey: '',
          duplicateCount: 1,
        };
      }

      // Extract deduplication key
      const key = this.extractDeduplicationKey(validationResult.transformedData, row.rowNumber);

      // Skip if key extraction failed
      if (!key) {
        this.stats.totalRows++;
        this.stats.uniqueRows++;
        return {
          action: DeduplicationAction.KEEP,
          rowNumber: row.rowNumber,
          duplicateKey: '',
          duplicateCount: 1,
        };
      }

      const normalizedKey = this.normalizeKey(key);

      // Check if this is a duplicate
      const existingEntry = this.duplicateTracker.get(normalizedKey);

      let result: DeduplicationResult;

      if (!existingEntry) {
        // First occurrence of this key
        result = this.handleFirstOccurrence(normalizedKey, row, validationResult);
      } else {
        // Duplicate found
        result = this.handleDuplicate(normalizedKey, row, validationResult, existingEntry);
      }

      // Update performance metrics
      const rowProcessingTime = Date.now() - startRowTime;
      this.updatePerformanceStats(rowProcessingTime);

      // Update memory usage if needed
      if (this.stats.totalRows % 1000 === 0) {
        this.updateMemoryUsage();
      }

      log.debug('Deduplication processed row', {
        rowNumber: row.rowNumber,
        key: normalizedKey,
        action: result.action,
        duplicateCount: result.duplicateCount,
      });

      return result;
    } catch (error) {
      log.error('Error processing row for deduplication', {
        error: error instanceof Error ? error.message : String(error),
        rowNumber: row.rowNumber,
      });

      // Default to keeping the row on error
      this.stats.totalRows++;
      this.stats.uniqueRows++;
      return {
        action: DeduplicationAction.KEEP,
        rowNumber: row.rowNumber,
        duplicateKey: '',
        duplicateCount: 1,
      };
    }
  }

  /**
   * Get deduplication statistics
   */
  public getStats(): DeduplicationStats {
    const currentTime = Date.now();
    this.stats.performance.processingTimeMs = currentTime - this.startTime;
    this.stats.performance.avgTimePerRow =
      this.stats.totalRows > 0 ? this.stats.performance.processingTimeMs / this.stats.totalRows : 0;

    return { ...this.stats };
  }

  /**
   * Get detailed duplicate information
   */
  public getDuplicateDetails(): DuplicateEntry[] {
    return Array.from(this.duplicateTracker.values())
      .filter(entry => entry.occurrences > 1)
      .sort((a, b) => b.occurrences - a.occurrences); // Sort by occurrence count descending
  }

  /**
   * Get sample duplicates for reporting
   */
  public getSampleDuplicates(maxSamples: number = 10): Array<{
    key: string;
    occurrences: number;
    rows: number[];
  }> {
    return this.getDuplicateDetails()
      .slice(0, maxSamples)
      .map(entry => ({
        key: entry.key,
        occurrences: entry.occurrences,
        rows: entry.allOccurrences.map(occ => occ.rowNumber),
      }));
  }

  /**
   * Reset the deduplication engine
   */
  public reset(): void {
    this.stats = this.initializeStats();
    this.duplicateTracker.clear();
    this.processedKeys.clear();
    this.startTime = 0;
  }

  /**
   * Check memory usage and cleanup if needed
   */
  public performMemoryCleanup(): number {
    const initialSize = this.duplicateTracker.size;

    // If we're tracking too many keys, remove single-occurrence entries
    if (this.duplicateTracker.size > this.config.maxDuplicatesTracked) {
      const entriesToRemove: string[] = [];

      for (const [key, entry] of this.duplicateTracker) {
        if (entry.occurrences === 1) {
          entriesToRemove.push(key);
        }

        // Stop when we've identified enough entries to remove
        if (
          entriesToRemove.length >=
          this.duplicateTracker.size - this.config.maxDuplicatesTracked
        ) {
          break;
        }
      }

      // Remove single-occurrence entries
      for (const key of entriesToRemove) {
        this.duplicateTracker.delete(key);
      }

      logger.info('Performed deduplication memory cleanup', {
        removedEntries: entriesToRemove.length,
        remainingEntries: this.duplicateTracker.size,
      });
    }

    return initialSize - this.duplicateTracker.size;
  }

  /**
   * Handle first occurrence of a key
   */
  private handleFirstOccurrence(
    key: string,
    row: CSVRow,
    validationResult: ValidationResult
  ): DeduplicationResult {
    // Track this key
    const entry: DuplicateEntry = {
      key,
      firstRowNumber: row.rowNumber,
      lastRowNumber: row.rowNumber,
      occurrences: 1,
      firstRowData: { ...validationResult.transformedData },
      lastRowData: { ...validationResult.transformedData },
      allOccurrences: [
        {
          rowNumber: row.rowNumber,
          data: { ...validationResult.transformedData },
        },
      ],
    };

    this.duplicateTracker.set(key, entry);
    this.processedKeys.add(key);

    // Update stats
    this.stats.totalRows++;
    this.stats.uniqueRows++;

    return {
      action: DeduplicationAction.KEEP,
      rowNumber: row.rowNumber,
      duplicateKey: key,
      duplicateCount: 1,
    };
  }

  /**
   * Handle duplicate occurrence of a key
   */
  private handleDuplicate(
    key: string,
    row: CSVRow,
    validationResult: ValidationResult,
    existingEntry: DuplicateEntry
  ): DeduplicationResult {
    // Update the existing entry
    existingEntry.occurrences++;
    existingEntry.lastRowNumber = row.rowNumber;
    existingEntry.lastRowData = { ...validationResult.transformedData };

    // Add to all occurrences (if we have space)
    if (existingEntry.allOccurrences.length < 100) {
      // Limit to prevent memory issues
      existingEntry.allOccurrences.push({
        rowNumber: row.rowNumber,
        data: { ...validationResult.transformedData },
      });
    }

    // Update stats
    this.stats.totalRows++;
    this.stats.duplicateRows++;

    // Apply deduplication strategy
    let action: DeduplicationAction;

    switch (this.config.strategy) {
      case DeduplicationStrategy.KEEP_FIRST:
        action = DeduplicationAction.SKIP;
        this.stats.skippedRows++;
        break;

      case DeduplicationStrategy.KEEP_LAST:
        action = DeduplicationAction.KEEP;
        // Note: We'd need to mark the previous occurrence for removal
        // This is complex with streaming, so we'll implement this differently
        break;

      case DeduplicationStrategy.MARK_ALL:
        action = DeduplicationAction.REVIEW;
        break;

      case DeduplicationStrategy.MERGE_DATA:
        action = DeduplicationAction.KEEP;
        // TODO: Implement data merging logic
        break;

      default:
        action = DeduplicationAction.SKIP;
        this.stats.skippedRows++;
    }

    // Update duplicate breakdown stats
    this.updateDuplicateBreakdown(existingEntry.occurrences);

    return {
      action,
      rowNumber: row.rowNumber,
      duplicateKey: key,
      firstOccurrence: existingEntry.firstRowNumber,
      duplicateCount: existingEntry.occurrences,
    };
  }

  /**
   * Extract deduplication key from row data
   */
  private extractDeduplicationKey(data: Record<string, unknown>, rowNumber: number): string | null {
    const value = data[this.config.keyField];

    if (value === undefined || value === null || value === '') {
      logger.debug('No deduplication key found', {
        rowNumber,
        keyField: this.config.keyField,
        availableFields: Object.keys(data),
      });
      return null;
    }

    return String(value);
  }

  /**
   * Normalize key for comparison
   */
  private normalizeKey(key: string): string {
    let normalized = key;

    if (this.config.trimWhitespace) {
      normalized = normalized.trim();
    }

    if (this.config.caseInsensitive) {
      normalized = normalized.toLowerCase();
    }

    if (this.config.normalizeKeys) {
      // Additional normalization (remove extra spaces, etc.)
      normalized = normalized.replace(/\s+/g, ' ').trim().toLowerCase();
    }

    return normalized;
  }

  /**
   * Update performance statistics
   */
  private updatePerformanceStats(rowProcessingTime: number): void {
    this.stats.performance.keyLookupTime += rowProcessingTime;
  }

  /**
   * Update memory usage statistics
   */
  private updateMemoryUsage(): void {
    this.stats.memoryUsage.keysTracked = this.duplicateTracker.size;

    // Rough estimation of memory usage
    // Each entry: ~200 bytes (key + metadata) + ~500 bytes per occurrence data
    const avgBytesPerEntry = 200;
    const avgBytesPerOccurrence = 500;

    let totalBytes = 0;
    for (const entry of this.duplicateTracker.values()) {
      totalBytes += avgBytesPerEntry + entry.allOccurrences.length * avgBytesPerOccurrence;
    }

    this.stats.memoryUsage.approximateMemoryMB = totalBytes / (1024 * 1024);

    // Trigger cleanup if memory usage is too high
    if (this.stats.memoryUsage.approximateMemoryMB > 256) {
      // 256MB threshold
      this.performMemoryCleanup();
    }
  }

  /**
   * Update duplicate breakdown statistics
   */
  private updateDuplicateBreakdown(occurrences: number): void {
    // Only count when we first detect it as duplicate (occurrences === 2)
    if (occurrences === 2) {
      this.stats.duplicateKeys++;
      this.stats.duplicateBreakdown.twoOccurrences++;
    } else if (occurrences === 3) {
      this.stats.duplicateBreakdown.twoOccurrences--;
      this.stats.duplicateBreakdown.threeToFive++;
    } else if (occurrences === 6) {
      this.stats.duplicateBreakdown.threeToFive--;
      this.stats.duplicateBreakdown.moreThanFive++;
    }
  }

  /**
   * Initialize deduplication statistics
   */
  private initializeStats(): DeduplicationStats {
    return {
      totalRows: 0,
      uniqueRows: 0,
      duplicateRows: 0,
      skippedRows: 0,
      duplicateKeys: 0,

      duplicateBreakdown: {
        twoOccurrences: 0,
        threeToFive: 0,
        moreThanFive: 0,
      },

      memoryUsage: {
        keysTracked: 0,
        approximateMemoryMB: 0,
      },

      performance: {
        processingTimeMs: 0,
        avgTimePerRow: 0,
        keyLookupTime: 0,
      },
    };
  }
}

// Export utility functions
export const DeduplicationUtils = {
  /**
   * Create default deduplication config
   */
  createDefaultConfig(enabled: boolean = true): DeduplicationConfig {
    return {
      enabled,
      strategy: DeduplicationStrategy.KEEP_FIRST,
      keyField: 'email',
      caseInsensitive: true,
      trimWhitespace: true,
      normalizeKeys: true,
      maxDuplicatesTracked: 50000, // 50k keys max in memory
    };
  },

  /**
   * Create config for different strategies
   */
  createConfigForStrategy(strategy: DeduplicationStrategy): DeduplicationConfig {
    const base = this.createDefaultConfig();
    base.strategy = strategy;

    // Adjust settings based on strategy
    switch (strategy) {
      case DeduplicationStrategy.KEEP_LAST:
      case DeduplicationStrategy.MERGE_DATA:
        base.maxDuplicatesTracked = 100000; // Need more memory for these strategies
        break;
      case DeduplicationStrategy.MARK_ALL:
        base.maxDuplicatesTracked = 200000; // Track all for review
        break;
    }

    return base;
  },

  /**
   * Estimate memory usage for given row count
   */
  estimateMemoryUsage(rowCount: number, duplicateRate: number = 0.1): number {
    const avgBytesPerEntry = 700; // Conservative estimate
    const estimatedDuplicateKeys = rowCount * duplicateRate;
    return (estimatedDuplicateKeys * avgBytesPerEntry) / (1024 * 1024); // MB
  },

  /**
   * Validate deduplication config
   */
  validateConfig(config: DeduplicationConfig): string[] {
    const errors: string[] = [];

    if (!config.keyField || config.keyField.trim() === '') {
      errors.push('Key field is required for deduplication');
    }

    if (config.maxDuplicatesTracked < 1000) {
      errors.push('maxDuplicatesTracked should be at least 1000 for reasonable performance');
    }

    if (config.maxDuplicatesTracked > 500000) {
      errors.push('maxDuplicatesTracked should not exceed 500000 to prevent memory issues');
    }

    return errors;
  },

  /**
   * Format deduplication stats for display
   */
  formatStats(stats: DeduplicationStats): Record<string, string> {
    const duplicateRate = stats.totalRows > 0 ? (stats.duplicateRows / stats.totalRows) * 100 : 0;
    const memoryMB = stats.memoryUsage.approximateMemoryMB;

    return {
      'Total Rows': stats.totalRows.toLocaleString(),
      'Unique Rows': stats.uniqueRows.toLocaleString(),
      'Duplicate Rows': stats.duplicateRows.toLocaleString(),
      'Skipped Rows': stats.skippedRows.toLocaleString(),
      'Duplicate Rate': `${duplicateRate.toFixed(2)}%`,
      'Duplicate Keys': stats.duplicateKeys.toLocaleString(),
      'Memory Usage': `${memoryMB.toFixed(2)} MB`,
      'Avg Time per Row': `${stats.performance.avgTimePerRow.toFixed(2)} ms`,
    };
  },
};

// Export common deduplication strategies
export const CommonStrategies = {
  /**
   * Keep first occurrence, skip duplicates (memory efficient)
   */
  KEEP_FIRST_EFFICIENT: DeduplicationUtils.createConfigForStrategy(
    DeduplicationStrategy.KEEP_FIRST
  ),

  /**
   * Keep last occurrence (requires more memory)
   */
  KEEP_LAST_COMPREHENSIVE: DeduplicationUtils.createConfigForStrategy(
    DeduplicationStrategy.KEEP_LAST
  ),

  /**
   * Mark all duplicates for review
   */
  REVIEW_ALL_DUPLICATES: DeduplicationUtils.createConfigForStrategy(DeduplicationStrategy.MARK_ALL),

  /**
   * Disabled deduplication
   */
  DISABLED: {
    ...DeduplicationUtils.createDefaultConfig(),
    enabled: false,
  },
};
