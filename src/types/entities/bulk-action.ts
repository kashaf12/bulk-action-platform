/**
 * Bulk Action entity type definitions
 */

import { IEntity } from '../base';

export type BulkActionStatus =
  | 'queued'
  | 'processing'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'validating';
export type BulkActionType = 'bulk_update';
export type EntityType = 'contact';

export type ConflictStrategy = 'skip' | 'error' | 'create';

export interface BulkActionConfiguration {
  deduplicate?: boolean;
  onConflict?: 'skip' | 'update' | 'error';
  fields?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface IBulkAction extends IEntity {
  accountId: string;
  entityType: EntityType;
  actionType: BulkActionType;
  status: BulkActionStatus;
  totalEntities: number;
  scheduledAt?: Date;
  startedAt?: Date;
  completedAt?: Date;
  configuration: BulkActionConfiguration;
  errorMessage?: string;
}

export interface BulkActionCreateData {
  id?: string;
  accountId: string;
  entityType: EntityType;
  actionType: BulkActionType;
  status?: BulkActionStatus;
  totalEntities?: number;
  processedEntities?: number;
  scheduledAt?: Date;
  configuration?: BulkActionConfiguration;
}

export interface BulkActionUpdateData {
  status?: BulkActionStatus;
  totalEntities?: number;
  startedAt?: Date;
  completedAt?: Date;
  errorMessage?: string;
}

export interface BulkActionRow {
  id?: string;
  action_id: string;
  account_id: string;
  entity_type: string;
  action_type: string;
  status: string;
  total_entities: number;
  scheduled_at?: Date;
  started_at?: Date;
  completed_at?: Date;
  configuration: string; // JSON string
  error_message?: string;
  created_at: Date;
  updated_at: Date;
}

export interface BulkActionQueryParams {
  page?: string;
  limit?: string;
  accountId?: string;
  status?: BulkActionStatus;
  entityType?: EntityType;
}

export interface BulkActionListParams {
  page: number;
  limit: number;
  accountId?: string;
  status?: BulkActionStatus;
  entityType?: EntityType;
}
