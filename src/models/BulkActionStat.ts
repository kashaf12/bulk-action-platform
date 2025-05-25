/**
 * BulkActionStat entity for tracking detailed statistics of bulk operations
 * Manages counters and metrics for bulk processing results
 */

import { z } from 'zod';
import { BaseEntity } from '../core/BaseEntity';
import { IBulkActionStat, BulkActionStatSummary } from '../types/entities/bulk-action-stat';
import { bulkActionStatSchema } from '../schemas/entities/bulk-action-stat';
import { FieldValidators } from '../types';

export class BulkActionStat extends BaseEntity implements IBulkActionStat {
  public actionId: string;
  public totalRecords: number;
  public successfulRecords: number;
  public failedRecords: number;
  public skippedRecords: number;
  public duplicateRecords: number;

  constructor(data: IBulkActionStat) {
    super(data);
    this.actionId = data.actionId;
    this.totalRecords = data.totalRecords;
    this.successfulRecords = data.successfulRecords;
    this.failedRecords = data.failedRecords;
    this.skippedRecords = data.skippedRecords;
    this.duplicateRecords = data.duplicateRecords;
  }

  public static getEntityType(): string {
    return 'bulk_action_stat';
  }

  public static getSchema(): z.ZodSchema {
    return bulkActionStatSchema;
  }

  public static getRequiredFields(): string[] {
    return ['actionId'];
  }

  public static getOptionalFields(): string[] {
    return [
      ...super.getOptionalFields(),
      'totalRecords',
      'successfulRecords',
      'failedRecords',
      'skippedRecords',
      'duplicateRecords',
    ];
  }

  public static getFieldValidators(): FieldValidators {
    return {
      ...super.getFieldValidators(),
      totalRecords: (value: unknown): boolean => {
        return typeof value === 'number' && value >= 0 && Number.isInteger(value);
      },
      successfulRecords: (value: unknown): boolean => {
        return typeof value === 'number' && value >= 0 && Number.isInteger(value);
      },
      failedRecords: (value: unknown): boolean => {
        return typeof value === 'number' && value >= 0 && Number.isInteger(value);
      },
      skippedRecords: (value: unknown): boolean => {
        return typeof value === 'number' && value >= 0 && Number.isInteger(value);
      },
      duplicateRecords: (value: unknown): boolean => {
        return typeof value === 'number' && value >= 0 && Number.isInteger(value);
      },
    };
  }

  public static getTableName(): string {
    return 'bulk_action_stats';
  }

  public static getColumnMappings(): Record<string, string> {
    return {
      ...super.getColumnMappings(),
      actionId: 'action_id',
      totalRecords: 'total_records',
      successfulRecords: 'successful_records',
      failedRecords: 'failed_records',
      skippedRecords: 'skipped_records',
      duplicateRecords: 'duplicate_records',
    };
  }

  /**
   * Create BulkActionStat instance from database row
   * Type-safe factory method that replaces the generic fromDbRow
   */
  public static fromDbRow(row: Record<string, unknown>): BulkActionStat {
    const columnMappings = this.getColumnMappings();
    const entityData = this.mapDbRowToEntityData(row, columnMappings);

    // Validate required fields
    if (!entityData.actionId) {
      throw new Error('BulkActionStat requires actionId field');
    }

    // Set defaults for optional fields
    const bulkActionStatData: IBulkActionStat = {
      ...entityData,
      totalRecords: entityData.totalRecords || 0,
      successfulRecords: entityData.successfulRecords || 0,
      failedRecords: entityData.failedRecords || 0,
      skippedRecords: entityData.skippedRecords || 0,
      duplicateRecords: entityData.duplicateRecords || 0,
    } as IBulkActionStat;

    return new BulkActionStat(bulkActionStatData);
  }

  public toObject(): Record<string, unknown> {
    return {
      ...super.toObject(),
      action_id: this.actionId,
      total_records: this.totalRecords,
      successful_records: this.successfulRecords,
      failed_records: this.failedRecords,
      skipped_records: this.skippedRecords,
      duplicate_records: this.duplicateRecords,
    };
  }

  /**
   * Calculate success rate as percentage
   */
  public getSuccessRate(): number {
    if (this.totalRecords === 0) return 0;
    return Math.round((this.successfulRecords / this.totalRecords) * 100 * 100) / 100; // 2 decimal places
  }

  /**
   * Calculate failure rate as percentage
   */
  public getFailureRate(): number {
    if (this.totalRecords === 0) return 0;
    return Math.round((this.failedRecords / this.totalRecords) * 100 * 100) / 100;
  }

  /**
   * Calculate skip rate as percentage
   */
  public getSkipRate(): number {
    if (this.totalRecords === 0) return 0;
    return Math.round((this.skippedRecords / this.totalRecords) * 100 * 100) / 100;
  }

  /**
   * Calculate duplicate rate as percentage
   */
  public getDuplicateRate(): number {
    if (this.totalRecords === 0) return 0;
    return Math.round((this.duplicateRecords / this.totalRecords) * 100 * 100) / 100;
  }

  /**
   * Calculate completion rate (processed vs total)
   */
  public getCompletionRate(): number {
    if (this.totalRecords === 0) return 0;
    const processedRecords = this.successfulRecords + this.failedRecords + this.skippedRecords;
    return Math.round((processedRecords / this.totalRecords) * 100 * 100) / 100;
  }

  /**
   * Get total processed records
   */
  public getProcessedRecords(): number {
    return this.successfulRecords + this.failedRecords + this.skippedRecords;
  }

  /**
   * Check if statistics are consistent
   */
  public isConsistent(): boolean {
    const processedRecords = this.getProcessedRecords();
    return processedRecords <= this.totalRecords;
  }

  /**
   * Get validation errors for current stats
   */
  public getConsistencyErrors(): string[] {
    const errors: string[] = [];

    if (this.getProcessedRecords() > this.totalRecords) {
      errors.push('Processed records exceed total records');
    }

    if (this.totalRecords < 0) {
      errors.push('Total records cannot be negative');
    }

    if (this.successfulRecords < 0) {
      errors.push('Successful records cannot be negative');
    }

    if (this.failedRecords < 0) {
      errors.push('Failed records cannot be negative');
    }

    if (this.skippedRecords < 0) {
      errors.push('Skipped records cannot be negative');
    }

    if (this.duplicateRecords < 0) {
      errors.push('Duplicate records cannot be negative');
    }

    return errors;
  }

  /**
   * Update statistics with new values
   */
  public updateStats(updates: Partial<IBulkActionStat>): void {
    if (updates.totalRecords !== undefined) {
      this.totalRecords = updates.totalRecords;
    }
    if (updates.successfulRecords !== undefined) {
      this.successfulRecords = updates.successfulRecords;
    }
    if (updates.failedRecords !== undefined) {
      this.failedRecords = updates.failedRecords;
    }
    if (updates.skippedRecords !== undefined) {
      this.skippedRecords = updates.skippedRecords;
    }
    if (updates.duplicateRecords !== undefined) {
      this.duplicateRecords = updates.duplicateRecords;
    }

    this.updatedAt = new Date();
  }

  /**
   * Increment counters atomically
   */
  public incrementCounters(increments: {
    successful?: number;
    failed?: number;
    skipped?: number;
    duplicate?: number;
  }): void {
    if (increments.successful) {
      this.successfulRecords += increments.successful;
    }
    if (increments.failed) {
      this.failedRecords += increments.failed;
    }
    if (increments.skipped) {
      this.skippedRecords += increments.skipped;
    }
    if (increments.duplicate) {
      this.duplicateRecords += increments.duplicate;
    }

    this.updatedAt = new Date();
  }

  /**
   * Create bulk action stat instance from API data
   */
  public static fromApiData(data: Record<string, unknown>): BulkActionStat {
    const validation = this.safeParse(data);
    if (!validation.success) {
      throw new Error(`Invalid bulk action stat data: ${validation.errors?.join(', ')}`);
    }
    return new BulkActionStat(validation.data as IBulkActionStat);
  }

  /**
   * Get detailed summary with calculated metrics
   */
  public getSummary(): BulkActionStatSummary {
    return {
      actionId: this.actionId,
      totalRecords: this.totalRecords,
      successfulRecords: this.successfulRecords,
      failedRecords: this.failedRecords,
      skippedRecords: this.skippedRecords,
      duplicateRecords: this.duplicateRecords,
      successRate: this.getSuccessRate(),
      failureRate: this.getFailureRate(),
      skipRate: this.getSkipRate(),
      duplicateRate: this.getDuplicateRate(),
      completionRate: this.getCompletionRate(),
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    };
  }

  /**
   * Sanitize bulk action stat data for API response
   */
  public toApiResponse(): Record<string, unknown> {
    return {
      actionId: this.actionId,
      totalRecords: this.totalRecords,
      successfulRecords: this.successfulRecords,
      failedRecords: this.failedRecords,
      skippedRecords: this.skippedRecords,
      duplicateRecords: this.duplicateRecords,
      processedRecords: this.getProcessedRecords(),
      successRate: this.getSuccessRate(),
      failureRate: this.getFailureRate(),
      skipRate: this.getSkipRate(),
      duplicateRate: this.getDuplicateRate(),
      completionRate: this.getCompletionRate(),
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    };
  }

  /**
   * Get stat summary for logging
   */
  public getLogSummary(): Record<string, unknown> {
    return {
      actionId: this.actionId,
      totalRecords: this.totalRecords,
      processedRecords: this.getProcessedRecords(),
      successRate: `${this.getSuccessRate()}%`,
      completionRate: `${this.getCompletionRate()}%`,
    };
  }
}
