import { EntityStrategy } from '../interfaces/EntityStrategy';
import { BulkOperationResult } from '../interfaces/BulkOperationResult';
import { BulkActionType } from '../types/entities/bulk-action';
import { logger } from '../utils/logger';

export class GenericEntityProcessor<T> {
  constructor(private strategy: EntityStrategy<T>) {}

  async processRows(
    rows: Array<{ data: Record<string, string>; rowNumber: number }>,
    actionType: BulkActionType,
    onConflict: string,
    traceId: string
  ): Promise<BulkOperationResult<T>> {
    const log = logger.withTrace(traceId);
    const entities: T[] = [];
    const mappingErrors: Array<{ entity: any; error: string }> = [];

    // Map rows to entities
    for (const row of rows) {
      try {
        const entity = this.strategy.mapRowToEntity(row.data);
        entities.push(entity);
      } catch (error) {
        log.warn('Failed to map row to entity', {
          rowNumber: row.rowNumber,
          error: error instanceof Error ? error.message : String(error),
        });

        mappingErrors.push({
          entity: row.data,
          error: error instanceof Error ? error.message : 'Mapping failed',
        });
      }
    }

    if (entities.length === 0) {
      return {
        created: [],
        updated: [],
        skipped: [],
        failed: mappingErrors,
        totalProcessed: rows.length,
        successCount: 0,
        failureCount: mappingErrors.length,
        skipCount: 0,
      };
    }

    // Execute bulk operation based on action type
    const repository = this.strategy.getRepository();
    let result: BulkOperationResult<T>;

    if (actionType === 'bulk_update') {
      result = await repository.bulkUpdate(entities, onConflict as any);
    } else {
      result = await repository.bulkCreate(entities, onConflict as any);
    }

    // Combine mapping errors with operation errors
    result.failed = [...result.failed, ...mappingErrors];
    result.totalProcessed = rows.length;
    result.failureCount = result.failed.length;

    return result;
  }
}
