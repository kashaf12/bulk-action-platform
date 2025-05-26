/**
 * BulkAction entity for tracking bulk operations
 * Manages metadata and status of bulk processing jobs
 */

import { z } from 'zod';
import { BaseEntity } from '../core/BaseEntity';
import {
  IBulkAction,
  BulkActionStatus,
  BulkActionType,
  EntityType,
  BulkActionConfiguration,
} from '../types/entities/bulk-action';
import { bulkActionSchema } from '../schemas/entities/bulk-action';
import { FieldValidators } from '../types';

export class BulkAction extends BaseEntity implements IBulkAction {
  public accountId: string;
  public entityType: EntityType;
  public actionType: BulkActionType;
  public status: BulkActionStatus;
  public totalEntities: number;
  public processedEntities: number;
  public scheduledAt?: Date;
  public startedAt?: Date;
  public completedAt?: Date;
  public configuration: BulkActionConfiguration;
  public errorMessage?: string;

  constructor(data: IBulkAction) {
    super(data);
    this.id = data.id;
    this.accountId = data.accountId;
    this.entityType = data.entityType;
    this.actionType = data.actionType;
    this.status = data.status;
    this.totalEntities = data.totalEntities;
    this.processedEntities = data.processedEntities;
    this.scheduledAt = data.scheduledAt;
    this.startedAt = data.startedAt;
    this.completedAt = data.completedAt;
    this.configuration = data.configuration;
    this.errorMessage = data.errorMessage;
  }

  public static getEntityType(): string {
    return 'bulk_action';
  }

  public static getSchema(): z.ZodSchema {
    return bulkActionSchema;
  }

  public static getRequiredFields(): string[] {
    return ['accountId', 'entityType', 'actionType'];
  }

  public static getOptionalFields(): string[] {
    return [
      ...super.getOptionalFields(),
      'status',
      'totalEntities',
      'processedEntities',
      'scheduledAt',
      'startedAt',
      'completedAt',
      'configuration',
      'errorMessage',
    ];
  }

  public static getFieldValidators(): FieldValidators {
    return {
      ...super.getFieldValidators(),
      status: (value: unknown): boolean => {
        return ['queued', 'processing', 'completed', 'failed', 'cancelled'].includes(
          value as string
        );
      },
      actionType: (value: unknown): boolean => {
        return ['bulk_update'].includes(value as string);
      },
      entityType: (value: unknown): boolean => {
        return ['contact'].includes(value as string);
      },
      totalEntities: (value: unknown): boolean => {
        return typeof value === 'number' && value >= 0;
      },
      processedEntities: (value: unknown): boolean => {
        return typeof value === 'number' && value >= 0;
      },
    };
  }

  public static getTableName(): string {
    return 'bulk_actions';
  }

  public static getColumnMappings(): Record<string, string> {
    return {
      ...super.getColumnMappings(),
      accountId: 'account_id',
      entityType: 'entity_type',
      actionType: 'action_type',
      status: 'status',
      totalEntities: 'total_entities',
      processedEntities: 'processed_entities',
      scheduledAt: 'scheduled_at',
      startedAt: 'started_at',
      completedAt: 'completed_at',
      configuration: 'configuration',
      errorMessage: 'error_message',
    };
  }

  /**
   * Create BulkAction instance from database row
   * Type-safe factory method that replaces the generic fromDbRow
   */
  public static fromDbRow(row: Record<string, unknown>): BulkAction {
    const columnMappings = this.getColumnMappings();
    const entityData = this.mapDbRowToEntityData(row, columnMappings);

    // Validate required fields
    if (!entityData.accountId || !entityData.entityType || !entityData.actionType) {
      throw new Error('BulkAction requires accountId, entityType, and actionType fields');
    }

    // Set defaults for optional fields
    const bulkActionData: IBulkAction = {
      ...entityData,
      status: entityData.status || 'queued',
      totalEntities: entityData.totalEntities || 0,
      processedEntities: entityData.processedEntities || 0,
      configuration: entityData.configuration || {},
    } as IBulkAction;

    return new BulkAction(bulkActionData);
  }

  public toObject(): Record<string, unknown> {
    return {
      ...super.toObject(),
      accountId: this.accountId,
      entityType: this.entityType,
      actionType: this.actionType,
      status: this.status,
      totalEntities: this.totalEntities,
      processedEntities: this.processedEntities,
      scheduledAt: this.scheduledAt,
      startedAt: this.startedAt,
      completedAt: this.completedAt,
      configuration: JSON.stringify(this.configuration),
      errorMessage: this.errorMessage,
    };
  }

  public toDbObject(): Record<string, unknown> {
    const obj = this.toObject();
    const mappings = BulkAction.getColumnMappings();
    const dbObj: Record<string, unknown> = {};

    for (const [entityField, dbColumn] of Object.entries(mappings)) {
      if (obj.hasOwnProperty(entityField)) {
        dbObj[dbColumn] = obj[entityField];
      }
    }

    return dbObj;
  }

  /**
   * Check if bulk action is in a final state
   */
  public isFinished(): boolean {
    return ['completed', 'failed', 'cancelled'].includes(this.status);
  }

  /**
   * Check if bulk action is currently running
   */
  public isRunning(): boolean {
    return this.status === 'processing';
  }

  /**
   * Check if bulk action is waiting to start
   */
  public isPending(): boolean {
    return this.status === 'queued';
  }

  /**
   * Check if bulk action is scheduled for future execution
   */
  public isScheduled(): boolean {
    return this.scheduledAt !== undefined && this.scheduledAt > new Date();
  }

  /**
   * Calculate progress percentage
   */
  public getProgressPercentage(): number {
    if (this.totalEntities === 0) return 0;
    return Math.round((this.processedEntities / this.totalEntities) * 100);
  }

  /**
   * Get estimated completion time based on current progress
   */
  public getEstimatedCompletion(): Date | null {
    if (!this.startedAt || this.totalEntities === 0 || this.processedEntities === 0) {
      return null;
    }

    const elapsed = Date.now() - this.startedAt.getTime();
    const rate = this.processedEntities / elapsed; // entities per millisecond
    const remaining = this.totalEntities - this.processedEntities;
    const estimatedMs = remaining / rate;

    return new Date(Date.now() + estimatedMs);
  }

  /**
   * Get processing duration
   */
  public getProcessingDuration(): number | null {
    if (!this.startedAt) return null;
    const endTime = this.completedAt || new Date();
    return endTime.getTime() - this.startedAt.getTime();
  }

  /**
   * Update status with validation and timestamps
   */
  public updateStatus(newStatus: BulkActionStatus, errorMessage?: string): void {
    const validTransitions: Record<BulkActionStatus, BulkActionStatus[]> = {
      queued: ['processing', 'cancelled'],
      processing: ['completed', 'failed', 'cancelled'],
      completed: [], // Final state
      failed: ['queued'], // Can retry
      cancelled: ['queued'], // Can restart
    };

    if (!validTransitions[this.status]?.includes(newStatus)) {
      throw new Error(`Invalid status transition from ${this.status} to ${newStatus}`);
    }

    this.status = newStatus;
    this.updatedAt = new Date();

    // Set appropriate timestamps
    switch (newStatus) {
      case 'processing':
        this.startedAt = new Date();
        break;
      case 'completed':
      case 'failed':
      case 'cancelled':
        this.completedAt = new Date();
        break;
    }

    if (errorMessage) {
      this.errorMessage = errorMessage;
    }
  }

  /**
   * Update progress
   */
  public updateProgress(processedCount: number): void {
    if (processedCount < 0 || processedCount > this.totalEntities) {
      throw new Error('Invalid processed count');
    }

    this.processedEntities = processedCount;
    this.updatedAt = new Date();

    // Auto-complete if all entities processed
    if (processedCount === this.totalEntities && this.status === 'processing') {
      this.updateStatus('completed');
    }
  }

  /**
   * Create bulk action instance from API data
   */
  public static fromApiData(data: Record<string, unknown>): BulkAction {
    const validation = this.safeParse(data);
    if (!validation.success) {
      throw new Error(`Invalid bulk action data: ${validation.errors?.join(', ')}`);
    }
    return new BulkAction(validation.data as IBulkAction);
  }

  /**
   * Sanitize bulk action data for API response
   */
  public toApiResponse(): Record<string, unknown> {
    return {
      id: this.id,
      entityType: this.entityType,
      actionType: this.actionType,
      status: this.status,
      totalEntities: this.totalEntities,
      processedEntities: this.processedEntities,
      progressPercentage: this.getProgressPercentage(),
      scheduledAt: this.scheduledAt,
      startedAt: this.startedAt,
      completedAt: this.completedAt,
      estimatedCompletion: this.getEstimatedCompletion(),
      processingDuration: this.getProcessingDuration(),
      configuration: this.configuration,
      errorMessage: this.errorMessage,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    };
  }

  /**
   * Get action summary for logging
   */
  public getLogSummary(): Record<string, unknown> {
    return {
      id: this.id,
      accountId: this.accountId,
      entityType: this.entityType,
      actionType: this.actionType,
      status: this.status,
      progress: `${this.processedEntities}/${this.totalEntities}`,
      progressPercentage: this.getProgressPercentage(),
    };
  }
}
