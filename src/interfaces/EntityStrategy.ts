import { BulkOperationResult } from './BulkOperationResult';
import { ConflictStrategy } from '../types/entities/bulk-action';

export interface EntityStrategy<T> {
  mapRowToEntity(rowData: Record<string, string>): T;
  getRepository(): GenericRepository<T>;
  getRequiredFields(): string[];
  getUniqueIdentifierField(): string; // e.g., 'email' for contacts
}

export interface GenericRepository<T> {
  bulkCreate(entities: T[], onConflict: ConflictStrategy): Promise<BulkOperationResult<T>>;
  bulkUpdate(entities: T[], onConflict: ConflictStrategy): Promise<BulkOperationResult<T>>;
  findByUniqueField(field: string, values: string[]): Promise<T[]>;
}
