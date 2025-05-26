/**
 * Bulk Action Statistics entity type definitions
 */

import { IEntity } from '../base';

export interface IBulkActionStat extends IEntity {
  actionId: string;
  totalRecords: number;
  successfulRecords: number;
  failedRecords: number;
  skippedRecords: number;
  duplicateRecords: number;
}

export interface BulkActionStatCreateData {
  actionId: string;
  totalRecords?: number;
  successfulRecords?: number;
  failedRecords?: number;
  skippedRecords?: number;
  duplicateRecords?: number;
}

export interface BulkActionStatUpdateData {
  totalRecords?: number;
  successfulRecords?: number;
  failedRecords?: number;
  skippedRecords?: number;
  duplicateRecords?: number;
}

export interface BulkActionStatRow {
  id?: string;
  action_id: string;
  total_records: number;
  successful_records: number;
  failed_records: number;
  skipped_records: number;
  duplicate_records: number;
  created_at: Date;
  updated_at: Date;
}

export interface BulkActionStatSummary {
  actionId: string;
  totalRecords: number;
  successfulRecords: number;
  failedRecords: number;
  skippedRecords: number;
  duplicateRecords: number;
  createdAt?: Date;
  updatedAt?: Date;
}
