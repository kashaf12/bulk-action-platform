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

export class BulkAction extends BaseEntity implements IBulkAction {
  public accountId: string;
  public entityType: EntityType;
  public actionType: BulkActionType;
  public status: BulkActionStatus;
  public totalEntities: number;
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
   * Update status with validation and timestamps
   */
  public updateStatus(newStatus: BulkActionStatus, errorMessage?: string): void {
    const validTransitions: Record<BulkActionStatus, BulkActionStatus[]> = {
      queued: ['processing', 'cancelled'],
      processing: ['completed', 'failed', 'cancelled'],
      completed: [], // Final state
      failed: ['queued'], // Can retry
      validating: ['processing', 'cancelled', 'queued'],
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

    this.updatedAt = new Date();

    // Auto-complete if all entities processed
    if (processedCount === this.totalEntities && this.status === 'processing') {
      this.updateStatus('completed');
    }
  }
}
